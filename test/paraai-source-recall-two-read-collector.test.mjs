import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readdir,
  readFile,
} from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_RECALL_POINT_OBSERVATION_MAX_INTERVAL_MS,
  SOURCE_RECALL_POINT_OBSERVATION_STORE_VERSION,
  SourceRecallPointObservationStoreError,
  createSourceRecallPointObservationManifestPointInterface,
  createSourceRecallPointObservationPersistenceAdapter,
  createSourceRecallPointObservationStore,
} from "../api/paraai/_lib/source-recall-point-observation-store.mjs";
import {
  SOURCE_RECALL_TWO_READ_COLLECTOR_VERSION,
  SourceRecallTwoReadCollectorError,
  collectRecallSourcePointTwoRead,
} from "../api/paraai/_lib/source-recall-two-read-collector.mjs";
import {
  SOURCE_RECALL_POINT_REQUEST_VERSION,
  SOURCE_RECALL_POINT_TRANSPORT_RECEIPT_VERSION,
} from "../api/paraai/_lib/source-recall-point-client.mjs";
import {
  recallSourcePointEvidence,
} from "../api/paraai/_lib/source-recall-point-collector.mjs";

const HOUR = 60 * 60 * 1_000;
const BOUNDARY = "2026-07-26T01:00:00.000Z";
const BOUNDARY_MS = Date.parse(BOUNDARY);
const REFERENCE = {
  id: "recall-two-read-bot",
  joinAt: "2026-07-26T00:30:00.000Z",
  metadataSource: "paraform-auto",
  candidate: {
    fullName: "Private Candidate",
    email: "private@example.invalid",
    linkedin: "https://example.invalid/private",
    paraformEventId: "private-event",
  },
};

function deepFreeze(value) {
  if (
    value
    && typeof value === "object"
    && !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function digest(character) {
  return character.repeat(64);
}

function sha1(character) {
  return character.repeat(40);
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function verifiedPage(nowMs) {
  return deepFreeze({
    record: {
      version: 1,
      policyVersion: "recall-reference-head-dark-v1",
      kind: "recall_private_reference_page_dark",
      source: "recall",
      clientVersion: "recall-private-page-client-v1",
      workKeyDigest: digest("1"),
      runNonceDigest: digest("2"),
      decisionBoundaryAtMs: BOUNDARY_MS,
      contractPinsDigest: digest("3"),
      passNumber: 2,
      pageNumber: 1,
      cursor: null,
      nextCursor: null,
      pageExpiresAtMs: nowMs + 20 * HOUR,
      pageSemanticDigest: digest("4"),
      scannedCount: 1,
      referenceCount: 1,
      references: [REFERENCE],
    },
    pageKeyDigest: digest("5"),
    pageRecordDigest: digest("6"),
    pageNativeByteProofDigest: sha1("7"),
    recallReferenceHeadEpochDigest: digest("8"),
    recallReferenceHeadRevisionDigest: digest("9"),
    recallReferenceHeadRecordDigest: digest("a"),
    redisNowMs: nowMs,
    remainingTtlMs: 20 * HOUR,
  });
}

function pointRaw(overrides = {}) {
  return deepFreeze({
    id: REFERENCE.id,
    bot_name: "Raydar Screener",
    join_at: "2026-07-26T00:30:00.000000000Z",
    metadata: {
      source: REFERENCE.metadataSource,
      candidate_full_name: REFERENCE.candidate.fullName,
      candidate_email: REFERENCE.candidate.email,
      candidate_linkedin: REFERENCE.candidate.linkedin,
      paraform_event_id: REFERENCE.candidate.paraformEventId,
    },
    status_changes: [
      {
        code: "done",
        created_at: "2026-07-26T00:59:00.000000000Z",
      },
    ],
    recordings: [],
    ...overrides,
  });
}

function fakePersistence(startMs) {
  let nowMs = startMs;
  let casMode = "normal";
  const values = new Map();
  const expiries = new Map();
  const calls = [];
  const persistence = {
    async time() {
      calls.push({ method: "time" });
      return { redisNowMs: nowMs };
    },
    async ensure(input) {
      calls.push({ method: "ensure", input });
      if (nowMs >= input.expiresAtMs) {
        return {
          status: "expired",
          raw: null,
          redisNowMs: nowMs,
          expiresAtMs: -2,
        };
      }
      if (values.has(input.key)) {
        return {
          status: "existing",
          raw: values.get(input.key),
          redisNowMs: nowMs,
          expiresAtMs: expiries.get(input.key),
        };
      }
      values.set(input.key, input.proposedRaw);
      expiries.set(input.key, input.expiresAtMs);
      return {
        status: "created",
        raw: input.proposedRaw,
        redisNowMs: nowMs,
        expiresAtMs: input.expiresAtMs,
      };
    },
    async read(input) {
      calls.push({ method: "read", input });
      if (
        !values.has(input.key)
        || nowMs >= expiries.get(input.key)
      ) {
        values.delete(input.key);
        expiries.delete(input.key);
        return {
          raw: null,
          redisNowMs: nowMs,
          expiresAtMs: -2,
        };
      }
      return {
        raw: values.get(input.key),
        redisNowMs: nowMs,
        expiresAtMs: expiries.get(input.key),
      };
    },
    async compareAndSet(input) {
      calls.push({ method: "compareAndSet", input });
      const current = values.get(input.key);
      const expiry = expiries.get(input.key);
      if (current !== input.expectedRaw) {
        return {
          status: "conflict",
          raw: current || null,
          redisNowMs: nowMs,
          expiresAtMs: expiry ?? -2,
        };
      }
      if (
        nowMs >= input.notAfterMs
        || nowMs >= input.expiresAtMs
        || expiry !== input.expiresAtMs
      ) {
        return {
          status: "expired",
          raw: current,
          redisNowMs: nowMs,
          expiresAtMs: expiry ?? -2,
        };
      }
      if (casMode === "conflict_once") {
        casMode = "normal";
        return {
          status: "conflict",
          raw: current,
          redisNowMs: nowMs,
          expiresAtMs: expiry,
        };
      }
      values.set(input.key, input.nextRaw);
      if (casMode === "throw_after_store_once") {
        casMode = "normal";
        throw new Error("private lost persistence response");
      }
      return {
        status: "stored",
        raw: input.nextRaw,
        redisNowMs: nowMs,
        expiresAtMs: expiry,
      };
    },
  };
  return {
    calls,
    persistence,
    setNow(value) {
      nowMs = value;
    },
    advance(value) {
      nowMs += value;
    },
    setCasMode(value) {
      casMode = value;
    },
    expiries,
    values,
  };
}

async function observationForClaim(claim, raw = pointRaw()) {
  const request = Object.freeze({
    version: SOURCE_RECALL_POINT_REQUEST_VERSION,
    reservationId: claim.reservationId,
    contextDigest: claim.contextDigest,
    readNumber: claim.readNumber,
    botId: claim.expectedReference.id,
  });
  const result = await clientFor([raw, raw], [])(request);
  const evidence = recallSourcePointEvidence(
    result.point,
    Object.freeze({
      decisionBoundaryAt: BOUNDARY,
      expectedReference: claim.expectedReference,
    }),
  );
  return deepFreeze({
    evidence,
    transportReceipt: result.transportReceipt,
  });
}

async function preparedHarness() {
  const startedAt = BOUNDARY_MS + HOUR;
  const fake = fakePersistence(startedAt);
  const store = createSourceRecallPointObservationStore({
    persistence: fake.persistence,
  });
  const snapshot =
    await store.prepareRecallPointObservationWork(
      verifiedPage(startedAt),
    );
  const work = Object.freeze({
    workKeyDigest: snapshot.record.workKeyDigest,
  });
  return { fake, snapshot, store, work };
}

function clientFor(rawByRead, calls) {
  return async (request) => {
    calls.push(request);
    const point = typeof rawByRead === "function"
      ? await rawByRead(request)
      : rawByRead[request.readNumber - 1];
    const requestDigest = createHash("sha256")
      .update(
        "paraai-recall-source-point-request-bytes-v1",
        "utf8",
      )
      .update("\0", "utf8")
      .update(JSON.stringify({
        version: SOURCE_RECALL_POINT_REQUEST_VERSION,
        reservationId: request.reservationId,
        contextDigest: request.contextDigest,
        readNumber: request.readNumber,
        botId: request.botId,
      }), "utf8")
      .digest("hex");
    return deepFreeze({
      point,
      transportReceipt: {
        version:
          SOURCE_RECALL_POINT_TRANSPORT_RECEIPT_VERSION,
        reservationId: request.reservationId,
        contextDigest: request.contextDigest,
        readNumber: request.readNumber,
        requestDigest,
      },
    });
  };
}

function collectorDependencies(store, client) {
  return Object.freeze({
    checkpointRecallPointObservationReadImpl:
      store.checkpointRecallPointObservationRead,
    claimRecallPointObservationReadImpl:
      store.claimRecallPointObservationRead,
    readPrivateRecallSourcePointImpl: client,
    recordRecallPointObservationUnresolvedImpl:
      store.recordRecallPointObservationUnresolved,
  });
}

function expectCollectorCode(code) {
  return (error) => {
    assert.equal(
      error instanceof SourceRecallTwoReadCollectorError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

function expectStoreCode(code) {
  return (error) => {
    assert.equal(
      error instanceof SourceRecallPointObservationStoreError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

function replacePersistedRecord(fake, mutate) {
  const [key] = fake.values.keys();
  assert.equal(typeof key, "string");
  const record = JSON.parse(fake.values.get(key));
  mutate(record);
  fake.values.set(key, canonicalJson(record));
}

async function stableHarness() {
  const harness = await preparedHarness();
  const first =
    await harness.store.claimRecallPointObservationRead(
      harness.work,
    );
  harness.fake.advance(1_000);
  await harness.store.checkpointRecallPointObservationRead(
    first,
    await observationForClaim(first),
  );
  const second =
    await harness.store.claimRecallPointObservationRead(
      harness.work,
    );
  harness.fake.advance(1_000);
  await harness.store.checkpointRecallPointObservationRead(
    second,
    await observationForClaim(second),
  );
  return harness;
}

test("one verified private reference becomes one opaque hard-dark work", async () => {
  const { fake, snapshot, store, work } =
    await preparedHarness();
  assert.equal(
    SOURCE_RECALL_POINT_OBSERVATION_STORE_VERSION,
    "recall-point-observation-store-dark-v2",
  );
  assert.equal(snapshot.record.status, "awaiting_read_1");
  assert.equal(snapshot.record.expectedReference.id, REFERENCE.id);
  assert.match(work.workKeyDigest, /^[a-f0-9]{64}$/u);
  assert.equal(
    snapshot.record.globalReferenceSetCoverageAvailable,
    false,
  );
  assert.deepEqual(
    store.recallPointObservationAggregateStatus(snapshot),
    {
      status: "awaiting_read_1",
      prepared: true,
      stable: 0,
      unresolved: 0,
      conflict: 0,
      readsCompleted: 0,
      inProgress: false,
      operational: false,
      globalReferenceSetCoverageAvailable: false,
      sourceFactsAvailable: false,
      successClassificationAvailable: false,
      candidateIdentityResolutionAvailable: false,
      pinnable: false,
      authorityAvailable: false,
    },
  );
  assert.equal(
    fake.calls.filter(({ method }) => method === "ensure")
      .length,
    1,
  );
});

test("the public point store exposes no manifest selector and opaque caller tokens cannot select work", async () => {
  const startedAt = BOUNDARY_MS + HOUR;
  const secondReference = {
    id: "recall-manifest-second-bot",
    joinAt: "2026-07-26T00:20:00.000Z",
    metadataSource: "paraform-auto",
    candidate: {
      fullName: "Second Private Candidate",
      email: "second-private@example.invalid",
      linkedin: "https://example.invalid/second-private",
      paraformEventId: "second-private-event",
    },
  };
  const baseline = verifiedPage(startedAt);
  const page = deepFreeze({
    ...baseline,
    record: {
      ...baseline.record,
      pageNumber: 2,
      cursor: "server-private-cursor",
      referenceCount: 2,
      scannedCount: 2,
      references: [REFERENCE, secondReference],
    },
  });
  const fake = fakePersistence(startedAt);
  const store = createSourceRecallPointObservationStore({
    persistence: fake.persistence,
  });
  assert.deepEqual(Object.keys(store).sort(), [
    "checkpointRecallPointObservationRead",
    "claimRecallPointObservationRead",
    "prepareRecallPointObservationWork",
    "readRecallPointObservationWork",
    "recallPointObservationAggregateStatus",
    "recordRecallPointObservationUnresolved",
  ]);
  const manifestPoint =
    createSourceRecallPointObservationManifestPointInterface({
      persistence: fake.persistence,
    });
  assert.deepEqual(Object.keys(manifestPoint).sort(), [
    "manifestEntries",
    "prepareManifestSelection",
    "readManifestSelection",
  ]);
  const indexed = manifestPoint.manifestEntries(page);
  assert.equal(indexed.pageNumber, 2);
  assert.equal(indexed.entries.length, 2);
  assert.notEqual(
    indexed.entries[0].workKeyDigest,
    indexed.entries[1].workKeyDigest,
  );
  await assert.rejects(
    manifestPoint.prepareManifestSelection(
      Object.freeze({}),
    ),
    expectStoreCode(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CAPABILITY_INVALID",
    ),
  );
  assert.equal(fake.calls.length, 0);
});

test("two exact reads use distinct durable reservations and settle stable", async () => {
  const { store, work } = await preparedHarness();
  const calls = [];
  const result = await collectRecallSourcePointTwoRead(
    work,
    collectorDependencies(
      store,
      clientFor([pointRaw(), pointRaw()], calls),
    ),
  );
  assert.equal(result, undefined);
  assert.equal(
    SOURCE_RECALL_TWO_READ_COLLECTOR_VERSION,
    "recall-source-point-two-read-v1",
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(({ readNumber }) => readNumber),
    [1, 2],
  );
  assert.notEqual(
    calls[0].reservationId,
    calls[1].reservationId,
  );
  assert.equal(calls[0].contextDigest, calls[1].contextDigest);
  assert.equal(calls[0].botId, REFERENCE.id);
  const settled =
    await store.readRecallPointObservationWork(work);
  assert.equal(settled.record.status, "stable");
  assert.equal(settled.record.readOne !== null, true);
  assert.equal(settled.record.readTwo !== null, true);
  assert.equal(
    JSON.stringify(settled.record).includes(
      "successClassificationAvailable\":true",
    ),
    false,
  );

  await collectRecallSourcePointTwoRead(
    work,
    collectorDependencies(
      store,
      clientFor([pointRaw(), pointRaw()], calls),
    ),
  );
  assert.equal(calls.length, 2);
});

test("read one is durable before read two can be claimed", async () => {
  const { store, work } = await preparedHarness();
  const first = await store.claimRecallPointObservationRead(work);
  assert.equal(first.readNumber, 1);
  const concurrent =
    await store.claimRecallPointObservationRead(work);
  assert.deepEqual(concurrent, {
    status: "in_progress",
    workKeyDigest: work.workKeyDigest,
  });
});

test("an abandoned claim terminalizes without a replacement read", async () => {
  const { fake, store, work } = await preparedHarness();
  const first = await store.claimRecallPointObservationRead(work);
  assert.equal(first.readNumber, 1);
  fake.advance(151_000);
  const terminal =
    await store.claimRecallPointObservationRead(work);
  assert.deepEqual(terminal, {
    status: "complete",
    outcome: "unresolved",
    workKeyDigest: work.workKeyDigest,
  });
  const replay =
    await store.claimRecallPointObservationRead(work);
  assert.equal(replay.outcome, "unresolved");
});

test("a fresh store instance resumes at read two after durable read one", async () => {
  const { fake, store, work } = await preparedHarness();
  const first = await store.claimRecallPointObservationRead(work);
  await store.checkpointRecallPointObservationRead(
    first,
    await observationForClaim(first),
  );

  const restarted = createSourceRecallPointObservationStore({
    persistence: fake.persistence,
  });
  const calls = [];
  await collectRecallSourcePointTwoRead(
    work,
    collectorDependencies(
      restarted,
      clientFor([pointRaw(), pointRaw()], calls),
    ),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].readNumber, 2);
  assert.equal(
    (await restarted.readRecallPointObservationWork(work))
      .record.status,
    "stable",
  );
});

test("a lost read-one checkpoint response resumes at read two without rereading one", async () => {
  const { fake, store, work } = await preparedHarness();
  const calls = [];
  const baseDependencies = collectorDependencies(
    store,
    clientFor([pointRaw(), pointRaw()], calls),
  );
  let firstCheckpoint = true;
  const dependencies = Object.freeze({
    ...baseDependencies,
    async checkpointRecallPointObservationReadImpl(
      claim,
      checkpoint,
    ) {
      if (firstCheckpoint) {
        firstCheckpoint = false;
        fake.setCasMode("throw_after_store_once");
      }
      return store.checkpointRecallPointObservationRead(
        claim,
        checkpoint,
      );
    },
  });
  await assert.rejects(
    collectRecallSourcePointTwoRead(
      work,
      dependencies,
    ),
    expectCollectorCode(
      "SOURCE_RECALL_TWO_READ_FIRST_CHECKPOINT_FAILED",
    ),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].readNumber, 1);

  const restarted = createSourceRecallPointObservationStore({
    persistence: fake.persistence,
  });
  await collectRecallSourcePointTwoRead(
    work,
    collectorDependencies(
      restarted,
      clientFor([pointRaw(), pointRaw()], calls),
    ),
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(({ readNumber }) => readNumber),
    [1, 2],
  );
});

test("a lost read-two checkpoint response replays as complete without a third read", async () => {
  const { fake, store, work } = await preparedHarness();
  const calls = [];
  const baseDependencies = collectorDependencies(
    store,
    clientFor([pointRaw(), pointRaw()], calls),
  );
  const dependencies = Object.freeze({
    ...baseDependencies,
    async checkpointRecallPointObservationReadImpl(
      claim,
      checkpoint,
    ) {
      if (claim.readNumber === 2) {
        fake.setCasMode("throw_after_store_once");
      }
      return store.checkpointRecallPointObservationRead(
        claim,
        checkpoint,
      );
    },
  });
  await assert.rejects(
    collectRecallSourcePointTwoRead(work, dependencies),
    expectCollectorCode(
      "SOURCE_RECALL_TWO_READ_SECOND_CHECKPOINT_FAILED",
    ),
  );
  assert.deepEqual(
    calls.map(({ readNumber }) => readNumber),
    [1, 2],
  );

  const restarted = createSourceRecallPointObservationStore({
    persistence: fake.persistence,
  });
  await collectRecallSourcePointTwoRead(
    work,
    collectorDependencies(
      restarted,
      clientFor([pointRaw(), pointRaw()], calls),
    ),
  );
  assert.equal(calls.length, 2);
  assert.equal(
    (await restarted.readRecallPointObservationWork(work))
      .record.status,
    "stable",
  );
});

test("two store instances share one durable claim lattice without duplicate ordinals", async () => {
  const { fake, store: firstStore, work } =
    await preparedHarness();
  const secondStore = createSourceRecallPointObservationStore({
    persistence: fake.persistence,
  });
  const calls = [];
  const client = clientFor(
    () => pointRaw(),
    calls,
  );
  await Promise.all([
    collectRecallSourcePointTwoRead(
      work,
      collectorDependencies(firstStore, client),
    ),
    collectRecallSourcePointTwoRead(
      work,
      collectorDependencies(secondStore, client),
    ),
  ]);
  assert.deepEqual(
    calls.map(({ readNumber }) => readNumber).sort(),
    [1, 2],
  );
  assert.equal(
    new Set(
      calls.map(({ reservationId }) => reservationId),
    ).size,
    2,
  );
  assert.equal(
    (await firstStore.readRecallPointObservationWork(work))
      .record.status,
    "stable",
  );
});

test("a checkpoint CAS conflict consumes the claim and cannot reread or advance", async () => {
  const { fake, store, work } = await preparedHarness();
  const calls = [];
  const baseDependencies = collectorDependencies(
    store,
    clientFor([pointRaw(), pointRaw()], calls),
  );
  const dependencies = Object.freeze({
    ...baseDependencies,
    async checkpointRecallPointObservationReadImpl(
      claim,
      checkpoint,
    ) {
      fake.setCasMode("conflict_once");
      return store.checkpointRecallPointObservationRead(
        claim,
        checkpoint,
      );
    },
  });
  await assert.rejects(
    collectRecallSourcePointTwoRead(
      work,
      dependencies,
    ),
    expectCollectorCode(
      "SOURCE_RECALL_TWO_READ_FIRST_CHECKPOINT_FAILED",
    ),
  );
  assert.equal(calls.length, 1);
  const inProgress =
    await store.claimRecallPointObservationRead(work);
  assert.equal(inProgress.status, "in_progress");
  fake.advance(151_000);
  const terminal =
    await store.claimRecallPointObservationRead(work);
  assert.equal(terminal.outcome, "unresolved");
  assert.equal(calls.length, 1);
});

test("the bounded interval expires after read one without issuing read two", async () => {
  const { fake, store, work } = await preparedHarness();
  const first = await store.claimRecallPointObservationRead(work);
  await store.checkpointRecallPointObservationRead(
    first,
    await observationForClaim(first),
  );
  fake.advance(10 * 60 * 1_000);
  const terminal =
    await store.claimRecallPointObservationRead(work);
  assert.equal(terminal.outcome, "unresolved");
  assert.equal(
    (await store.readRecallPointObservationWork(work))
      .record.readTwo,
    null,
  );
});

test("preparation is idempotent and every transition preserves one absolute expiry", async () => {
  const startedAt = BOUNDARY_MS + HOUR;
  const fake = fakePersistence(startedAt);
  const store = createSourceRecallPointObservationStore({
    persistence: fake.persistence,
  });
  const page = verifiedPage(startedAt);
  const first =
    await store.prepareRecallPointObservationWork(page);
  fake.advance(1_000);
  const second =
    await store.prepareRecallPointObservationWork(page);
  assert.equal(second.raw, first.raw);
  assert.equal(
    second.record.expiresAtMs,
    first.record.expiresAtMs,
  );
  const work = Object.freeze({
    workKeyDigest: first.record.workKeyDigest,
  });
  const claim = await store.claimRecallPointObservationRead(work);
  await store.checkpointRecallPointObservationRead(
    claim,
    await observationForClaim(claim),
  );
  const expiryValues = fake.calls.flatMap(({ input }) => (
    Number.isSafeInteger(input?.expiresAtMs)
      ? [input.expiresAtMs]
      : []
  ));
  assert.equal(
    expiryValues.every(
      (value) => value === first.record.expiresAtMs,
    ),
    true,
  );
});

test("an existing work cannot outlive its exact verified source page", async () => {
  const startedAt = BOUNDARY_MS + HOUR;
  const fake = fakePersistence(startedAt);
  const store = createSourceRecallPointObservationStore({
    persistence: fake.persistence,
  });
  await store.prepareRecallPointObservationWork(
    verifiedPage(startedAt),
  );
  const [key] = fake.values.keys();
  replacePersistedRecord(fake, (record) => {
    record.expiresAtMs += HOUR;
  });
  fake.expiries.set(key, fake.expiries.get(key) + HOUR);
  await assert.rejects(
    store.prepareRecallPointObservationWork(
      verifiedPage(startedAt),
    ),
    expectStoreCode(
      "SOURCE_RECALL_POINT_OBSERVATION_WORK_BINDING_MISMATCH",
    ),
  );
});

test("provider failure settles unresolved and replay makes no third read", async () => {
  const { store, work } = await preparedHarness();
  let reads = 0;
  const dependencies = collectorDependencies(
    store,
    async () => {
      reads += 1;
      throw new Error("private provider detail");
    },
  );
  await assert.rejects(
    collectRecallSourcePointTwoRead(work, dependencies),
    expectCollectorCode(
      "SOURCE_RECALL_TWO_READ_FIRST_READ_FAILED",
    ),
  );
  assert.equal(reads, 1);
  await collectRecallSourcePointTwoRead(work, dependencies);
  assert.equal(reads, 1);
  const settled =
    await store.readRecallPointObservationWork(work);
  assert.equal(settled.record.status, "unresolved");
});

test("semantic drift settles conflict and is reported without a third read", async () => {
  const { store, work } = await preparedHarness();
  const calls = [];
  const changed = pointRaw({
    status_changes: [
      {
        code: "fatal",
        created_at: "2026-07-26T00:59:00.000000000Z",
      },
    ],
  });
  const dependencies = collectorDependencies(
    store,
    clientFor([pointRaw(), changed], calls),
  );
  await assert.rejects(
    collectRecallSourcePointTwoRead(work, dependencies),
    expectCollectorCode("SOURCE_RECALL_TWO_READ_UNSTABLE"),
  );
  assert.equal(calls.length, 2);
  const settled =
    await store.readRecallPointObservationWork(work);
  assert.equal(settled.record.status, "conflict");
  await collectRecallSourcePointTwoRead(work, dependencies);
  assert.equal(calls.length, 2);
});

test("rotating fields, recordings, and post-boundary drift remain stable", async () => {
  const { store, work } = await preparedHarness();
  const first = pointRaw({ updated_at: "private-first" });
  const second = pointRaw({
    updated_at: "private-second",
    recordings: [{ private: "rotated" }],
    status_changes: [
      {
        code: "done",
        created_at: "2026-07-26T00:59:00.000000000Z",
      },
      {
        code: "later",
        created_at: "2026-07-26T01:01:00.000000000Z",
      },
    ],
  });
  await collectRecallSourcePointTwoRead(
    work,
    collectorDependencies(
      store,
      clientFor([first, second], []),
    ),
  );
  assert.equal(
    (await store.readRecallPointObservationWork(work))
      .record.status,
    "stable",
  );
});

test("future boundaries fail before persistence", async () => {
  const startedAt = BOUNDARY_MS + HOUR;
  const fake = fakePersistence(startedAt);
  const store = createSourceRecallPointObservationStore({
    persistence: fake.persistence,
  });
  const baseline = verifiedPage(startedAt);
  const future = deepFreeze({
    ...baseline,
    record: {
      ...baseline.record,
      decisionBoundaryAtMs: startedAt + HOUR,
    },
  });
  await assert.rejects(
    store.prepareRecallPointObservationWork(future),
    expectStoreCode(
      "SOURCE_RECALL_POINT_OBSERVATION_VERIFIED_PAGE_INVALID",
    ),
  );
  assert.equal(fake.calls.length, 0);
});

test("an exact empty verified page reports reference unavailable before persistence", async () => {
  const startedAt = BOUNDARY_MS + HOUR;
  const baseline = verifiedPage(startedAt);
  const empty = deepFreeze({
    ...baseline,
    record: {
      ...baseline.record,
      referenceCount: 0,
      references: [],
      scannedCount: 0,
    },
  });
  const fake = fakePersistence(startedAt);
  const store = createSourceRecallPointObservationStore({
    persistence: fake.persistence,
  });
  await assert.rejects(
    store.prepareRecallPointObservationWork(empty),
    expectStoreCode(
      "SOURCE_RECALL_POINT_OBSERVATION_REFERENCE_UNAVAILABLE",
    ),
  );
  assert.equal(fake.calls.length, 0);
});

test("out-of-range dates and mutable nested provenance fail with stable codes", async () => {
  const startedAt = BOUNDARY_MS + HOUR;
  for (const page of [
    (() => {
      const baseline = verifiedPage(startedAt);
      return deepFreeze({
        ...baseline,
        record: {
          ...baseline.record,
          decisionBoundaryAtMs: Number.MAX_SAFE_INTEGER,
        },
      });
    })(),
    (() => {
      const baseline = verifiedPage(startedAt);
      const mutableCandidate = {
        ...REFERENCE.candidate,
      };
      const shallowReference = Object.freeze({
        ...REFERENCE,
        candidate: mutableCandidate,
      });
      return Object.freeze({
        ...baseline,
        record: Object.freeze({
          ...baseline.record,
          references: Object.freeze([shallowReference]),
        }),
      });
    })(),
  ]) {
    const fake = fakePersistence(startedAt);
    const store = createSourceRecallPointObservationStore({
      persistence: fake.persistence,
    });
    await assert.rejects(
      store.prepareRecallPointObservationWork(page),
      expectStoreCode(
        "SOURCE_RECALL_POINT_OBSERVATION_VERIFIED_PAGE_INVALID",
      ),
    );
    assert.equal(fake.calls.length, 0);
  }
});

test("durable raw must remain one exact canonical encoding", async () => {
  const { fake, store, work } = await preparedHarness();
  const [key] = fake.values.keys();
  fake.values.set(key, ` ${fake.values.get(key)}`);
  await assert.rejects(
    store.readRecallPointObservationWork(work),
    expectStoreCode(
      "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
    ),
  );
});

test("hostile durable timelines and detached terminal evidence fail closed", async (t) => {
  await t.test("claim issuance is the exact last transition", async () => {
    const harness = await preparedHarness();
    harness.fake.advance(1_000);
    await harness.store.claimRecallPointObservationRead(
      harness.work,
    );
    replacePersistedRecord(harness.fake, (record) => {
      record.activeClaim.issuedAtMs -= 1;
    });
    await assert.rejects(
      harness.store.readRecallPointObservationWork(
        harness.work,
      ),
      expectStoreCode(
        "SOURCE_RECALL_POINT_OBSERVATION_DURABLE_STATE_INVALID",
      ),
    );
  });

  await t.test("read two cannot predate read one", async () => {
    const harness = await stableHarness();
    replacePersistedRecord(harness.fake, (record) => {
      record.readTwo.completedAtMs =
        record.readOne.completedAtMs - 1;
    });
    await assert.rejects(
      harness.store.readRecallPointObservationWork(
        harness.work,
      ),
      expectStoreCode(
        "SOURCE_RECALL_POINT_OBSERVATION_DURABLE_STATE_INVALID",
      ),
    );
  });

  await t.test("terminal reads stay inside the ten-minute interval", async () => {
    const harness = await stableHarness();
    let late;
    replacePersistedRecord(harness.fake, (record) => {
      late =
        record.createdAtMs
        + SOURCE_RECALL_POINT_OBSERVATION_MAX_INTERVAL_MS;
      record.readTwo.completedAtMs = late;
      record.updatedAtMs = late;
    });
    harness.fake.setNow(late);
    await assert.rejects(
      harness.store.readRecallPointObservationWork(
        harness.work,
      ),
      expectStoreCode(
        "SOURCE_RECALL_POINT_OBSERVATION_DURABLE_STATE_INVALID",
      ),
    );
  });

  await t.test("terminal history cannot be newer than Redis TIME", async () => {
    const harness = await stableHarness();
    replacePersistedRecord(harness.fake, (record) => {
      record.readTwo.completedAtMs += 1_000;
      record.updatedAtMs += 1_000;
    });
    await assert.rejects(
      harness.store.readRecallPointObservationWork(
        harness.work,
      ),
      expectStoreCode(
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
      ),
    );
  });

  await t.test("first evidence remains the exact read-one evidence", async () => {
    const harness = await stableHarness();
    replacePersistedRecord(harness.fake, (record) => {
      record.firstEvidence.sourceRecordDigest =
        digest("f");
      record.resolutionDigest = semanticDigest(
        "phase4-recall-point-observation-resolution-v1",
        {
          workKeyDigest: record.workKeyDigest,
          status: record.status,
          firstEvidence: record.firstEvidence,
          firstTransportReceipt:
            record.firstTransportReceipt,
          secondEvidence: record.readTwo.evidence,
          secondTransportReceipt:
            record.readTwo.transportReceipt,
        },
      );
    });
    await assert.rejects(
      harness.store.readRecallPointObservationWork(
        harness.work,
      ),
      expectStoreCode(
        "SOURCE_RECALL_POINT_OBSERVATION_DURABLE_STATE_INVALID",
      ),
    );
  });

  await t.test("unresolved cannot retain an orphan read two", async () => {
    const harness = await stableHarness();
    replacePersistedRecord(harness.fake, (record) => {
      record.status = "unresolved";
      record.terminalReason = "point_response_invalid";
      record.readOne = null;
      record.firstEvidence = null;
      record.firstTransportReceipt = null;
      record.resolutionDigest = semanticDigest(
        "phase4-recall-point-observation-resolution-v1",
        {
          workKeyDigest: record.workKeyDigest,
          status: "unresolved",
          reason: record.terminalReason,
          firstEvidence: null,
          firstTransportReceipt: null,
        },
      );
    });
    await assert.rejects(
      harness.store.readRecallPointObservationWork(
        harness.work,
      ),
      expectStoreCode(
        "SOURCE_RECALL_POINT_OBSERVATION_DURABLE_STATE_INVALID",
      ),
    );
  });
});

test("caller selectors and malformed private pages fail before persistence", async () => {
  const startedAt = BOUNDARY_MS + HOUR;
  const fake = fakePersistence(startedAt);
  const store = createSourceRecallPointObservationStore({
    persistence: fake.persistence,
  });
  await assert.rejects(
    store.prepareRecallPointObservationWork({
      ...verifiedPage(startedAt),
      referenceIndex: 0,
    }),
    (error) => {
      assert.equal(
        error instanceof SourceRecallPointObservationStoreError,
        true,
      );
      assert.equal(
        error.code,
        "SOURCE_RECALL_POINT_OBSERVATION_VERIFIED_PAGE_INVALID",
      );
      return true;
    },
  );
  assert.equal(fake.calls.length, 0);

  const { work } = await preparedHarness();
  await assert.rejects(
    collectRecallSourcePointTwoRead(
      Object.freeze({
        workKeyDigest: work.workKeyDigest,
        botId: REFERENCE.id,
      }),
      Object.freeze({
        checkpointRecallPointObservationReadImpl:
          async () => {},
        claimRecallPointObservationReadImpl:
          async () => {},
        readPrivateRecallSourcePointImpl: async () => {},
        recordRecallPointObservationUnresolvedImpl:
          async () => {},
      }),
    ),
    expectCollectorCode(
      "SOURCE_RECALL_TWO_READ_WORK_INVALID",
    ),
  );
});

test("dedicated configuration rejects partial values and exposes no fallback", () => {
  assert.throws(
    () => createSourceRecallPointObservationPersistenceAdapter({
      url: "https://example.invalid",
    }),
    (error) => {
      assert.equal(
        error instanceof SourceRecallPointObservationStoreError,
        true,
      );
      assert.equal(
        error.code,
        "SOURCE_RECALL_POINT_OBSERVATION_CONFIGURATION_INVALID",
      );
      return true;
    },
  );
});

test("the slice remains private and absent from every production importer", async () => {
  const [storeSource, collectorSource, worker, coordinator, health] =
    await Promise.all([
      readFile(
        new URL(
          "../api/paraai/_lib/source-recall-point-observation-store.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../api/paraai/_lib/source-recall-two-read-collector.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../api/paraai/worker.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../api/paraai/_lib/source-capture-coordinator.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../api/paraai/health.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
  for (const source of [storeSource, collectorSource]) {
    assert.doesNotMatch(source, /\bconsole\./u);
    assert.doesNotMatch(source, /from ["'][^"']*coordinator/u);
    assert.doesNotMatch(source, /from ["'][^"']*curation/u);
    assert.doesNotMatch(source, /from ["'][^"']*enrollment/u);
    assert.doesNotMatch(source, /source-authority-store/u);
  }
  for (const importer of [worker, coordinator, health]) {
    assert.doesNotMatch(
      importer,
      /source-recall-(?:point-observation|two-read)/u,
    );
  }

  async function productionFiles(directory) {
    const entries = await readdir(directory, {
      withFileTypes: true,
    });
    const files = [];
    for (const entry of entries) {
      const selected = new URL(entry.name, directory);
      if (entry.isDirectory()) {
        files.push(...await productionFiles(new URL(
          `${entry.name}/`,
          directory,
        )));
      } else if (entry.name.endsWith(".mjs")) {
        files.push(selected);
      }
    }
    return files;
  }

  const files = await productionFiles(
    new URL("../api/paraai/", import.meta.url),
  );
  const expectedImporters = new Map([
    [
      "source-recall-point-observation-manifest-runtime.mjs",
      [],
    ],
    [
      "source-recall-point-observation-manifest-store.mjs",
      [
        "source-recall-point-observation-manifest-runtime.mjs",
        "source-recall-point-observation-store.mjs",
      ],
    ],
    [
      "source-recall-point-observation-runtime.mjs",
      [],
    ],
    [
      "source-recall-two-read-collector.mjs",
      [
        "source-recall-point-observation-manifest-runtime.mjs",
        "source-recall-point-observation-runtime.mjs",
      ],
    ],
    [
      "source-recall-point-observation-store.mjs",
      [
        "source-recall-classifier-capsule-capability.mjs",
        "source-recall-point-observation-manifest-store.mjs",
        "source-recall-point-observation-runtime.mjs",
        "source-recall-two-read-collector.mjs",
      ],
    ],
    [
      "source-recall-classifier-capsule-capability.mjs",
      [
        "source-recall-classifier-capsule-runtime.mjs",
      ],
    ],
    [
      "source-recall-classifier-capsule-runtime.mjs",
      [
        "source-recall-success-evidence-projector.mjs",
      ],
    ],
    [
      "source-recall-success-evidence-projector.mjs",
      [],
    ],
  ]);
  for (const [target, expected] of expectedImporters) {
    const importers = [];
    for (const file of files) {
      if (file.pathname.endsWith(`/${target}`)) continue;
      const source = await readFile(file, "utf8");
      if (source.includes(target)) {
        importers.push(
          file.pathname.slice(
            file.pathname.lastIndexOf("/") + 1,
          ),
        );
      }
    }
    assert.deepEqual(importers.sort(), expected.sort());
  }
});
