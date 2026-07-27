import assert from "node:assert/strict";
import {
  createHash,
} from "node:crypto";
import test from "node:test";

import {
  SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_STORE_VERSION,
  SourceRecallPointObservationManifestStoreError,
  consumeRecallPointObservationManifestReadCapability,
  createSourceRecallPointObservationManifestStore,
} from "../api/paraai/_lib/source-recall-point-observation-manifest-store.mjs";
import * as manifestStoreModule from "../api/paraai/_lib/source-recall-point-observation-manifest-store.mjs";
import {
  createSourceRecallPointObservationManifestPointInterface,
  createSourceRecallPointObservationStore,
} from "../api/paraai/_lib/source-recall-point-observation-store.mjs";

const HOUR = 60 * 60 * 1_000;
const BOUNDARY_MS = Date.parse("2026-07-26T01:00:00.000Z");
const START_MS = BOUNDARY_MS + HOUR;

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function digestValue(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function sha256(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function sha1(raw) {
  return createHash("sha1").update(raw).digest("hex");
}

function digest(character) {
  return character.repeat(64);
}

function sha1Digest(character) {
  return character.repeat(40);
}

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

function reference(index) {
  return {
    id: `manifest-test-bot-${index}`,
    joinAt: new Date(
      BOUNDARY_MS - (index + 1) * 1_000,
    ).toISOString(),
    metadataSource: "paraform-auto",
    candidate: {
      fullName: `Private Candidate ${index}`,
      email: `private-${index}@example.invalid`,
      linkedin: `https://example.invalid/private-${index}`,
      paraformEventId: `private-event-${index}`,
    },
  };
}

function referenceCommitment(value) {
  return {
    referenceIdDigest: digestValue(
      "phase4-recall-reference-id-v1",
      value.id,
    ),
    referenceDigest: digestValue(
      "phase4-recall-private-reference-v1",
      value,
    ),
  };
}

function pageFixture({
  expiresAtMs,
  pageNumber,
  references,
}) {
  const pageRecordDigest = digestValue(
    "manifest-test-page-record",
    pageNumber,
  );
  const pageSemanticDigest = digestValue(
    "manifest-test-page-semantic",
    pageNumber,
  );
  const nativeDigest = sha1Digest(
    String(pageNumber % 10),
  );
  const cursorDigest = digestValue(
    "manifest-test-cursor",
    pageNumber === 1 ? null : `cursor-${pageNumber}`,
  );
  const nextCursorDigest = digestValue(
    "manifest-test-cursor",
    pageNumber === 2 ? null : `cursor-${pageNumber + 1}`,
  );
  return {
    manifest: {
      cursorDigest,
      nextCursorDigest,
      pageExpiresAtMs: expiresAtMs,
      pageNativeByteProofDigest: nativeDigest,
      pageNumber,
      pageRecordDigest,
      pageSemanticDigest,
      referenceCount: references.length,
      scannedCount: references.length,
    },
    verifiedPage: deepFreeze({
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
        pageNumber,
        cursor: pageNumber === 1
          ? null
          : `cursor-${pageNumber}`,
        nextCursor: pageNumber === 2
          ? null
          : `cursor-${pageNumber + 1}`,
        pageExpiresAtMs: expiresAtMs,
        pageSemanticDigest,
        scannedCount: references.length,
        referenceCount: references.length,
        references,
      },
      pageKeyDigest: digestValue(
        "manifest-test-page-key",
        pageNumber,
      ),
      pageRecordDigest,
      pageNativeByteProofDigest: nativeDigest,
      recallReferenceHeadEpochDigest: digest("8"),
      recallReferenceHeadRevisionDigest: digest("9"),
      recallReferenceHeadRecordDigest: null,
      redisNowMs: START_MS,
      remainingTtlMs: expiresAtMs - START_MS,
    }),
  };
}

function fixtures(referencePages = [
  [reference(1), reference(2)],
  [reference(3)],
], pageExpiryHours = null) {
  const pages = referencePages.map(
    (references, index) => pageFixture({
      expiresAtMs: START_MS
        + (pageExpiryHours?.[index] ?? 20) * HOUR,
      pageNumber: index + 1,
      references,
    }),
  );
  const commitments = referencePages
    .flat()
    .map(referenceCommitment)
    .sort((left, right) => (
      left.referenceIdDigest.localeCompare(
        right.referenceIdDigest,
      )
      || left.referenceDigest.localeCompare(
        right.referenceDigest,
      )
    ));
  const headRecord = {
    version: 1,
    policyVersion: "recall-reference-head-dark-v1",
    kind: "recall_reference_artifact_head_dark",
    source: "recall",
    clientVersion: "recall-private-page-client-v1",
    workKeyDigest: digest("1"),
    runNonceDigest: digest("2"),
    decisionBoundaryAtMs: BOUNDARY_MS,
    contractPinsDigest: digest("3"),
    passCount: 2,
    pageCount: pages.length,
    scannedCount: referencePages.flat().length,
    referenceCount: referencePages.flat().length,
    referenceManifestDigest: digestValue(
      "phase4-recall-reference-manifest-v1",
      commitments,
    ),
    stablePassSemanticDigest: digest("4"),
    pageManifests: pages.map(({ manifest }) => manifest),
    recallReferenceHeadEpochDigest: digest("8"),
    recallReferenceHeadRevisionDigest: digest("9"),
    sealedAtMs: START_MS,
    pointReadAvailable: false,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
  };
  const raw = canonicalJson(headRecord);
  const headRecordDigest = sha256(raw);
  for (const page of pages) {
    page.verifiedPage = deepFreeze({
      ...page.verifiedPage,
      recallReferenceHeadRecordDigest: headRecordDigest,
    });
  }
  return {
    head: deepFreeze({
      raw,
      record: headRecord,
      recallReferenceHeadEpochDigest: digest("8"),
      recallReferenceHeadRevisionDigest: digest("9"),
      recallReferenceHeadRecordDigest: headRecordDigest,
      redisNowMs: START_MS,
      pointReadAvailable: false,
      sourceFactsAvailable: false,
      pinnable: false,
      authorityAvailable: false,
    }),
    pages,
  };
}

function withHeadRecordChanges(source, changes) {
  const record = {
    ...structuredClone(source.head.record),
    ...changes,
  };
  const raw = canonicalJson(record);
  const recallReferenceHeadRecordDigest = sha256(raw);
  const head = deepFreeze({
    ...source.head,
    raw,
    record,
    recallReferenceHeadEpochDigest:
      record.recallReferenceHeadEpochDigest,
    recallReferenceHeadRevisionDigest:
      record.recallReferenceHeadRevisionDigest,
    recallReferenceHeadRecordDigest,
  });
  return {
    head,
    pages: source.pages.map((page) => ({
      ...page,
      verifiedPage: deepFreeze({
        ...page.verifiedPage,
        recallReferenceHeadEpochDigest:
          record.recallReferenceHeadEpochDigest,
        recallReferenceHeadRevisionDigest:
          record.recallReferenceHeadRevisionDigest,
        recallReferenceHeadRecordDigest,
      }),
    })),
  };
}

function fakePersistence(startMs = START_MS) {
  let nowMs = startMs;
  let casMode = "normal";
  let casBarrier = null;
  let casConflictCount = 0;
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
      if (casBarrier !== null) {
        const barrier = casBarrier;
        barrier.arrivals += 1;
        if (barrier.arrivals === barrier.participants) {
          casBarrier = null;
          barrier.release();
        } else {
          await barrier.promise;
        }
      }
      const current = values.get(input.key);
      const expiry = expiries.get(input.key);
      if (current !== input.expectedRaw) {
        casConflictCount += 1;
        return {
          status: "conflict",
          raw: current ?? null,
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
        casConflictCount += 1;
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
    expiries,
    persistence,
    values,
    advance(ms) {
      nowMs += ms;
    },
    setCasMode(value) {
      casMode = value;
    },
    barrierNextCompareAndSets(participants = 2) {
      assert.equal(casBarrier, null);
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      casBarrier = {
        arrivals: 0,
        participants,
        promise,
        release,
      };
    },
    get casConflictCount() {
      return casConflictCount;
    },
    get nowMs() {
      return nowMs;
    },
  };
}

function pointInterface(pointStore, fake, outcomes) {
  const capabilities = [];
  const readCapabilities = [];
  const terminalSnapshots = new Map();
  const pointObservation = Object.freeze({
    manifestEntries: pointStore.manifestEntries,
    async prepareManifestSelection(capability) {
      capabilities.push(capability);
      return pointStore.prepareManifestSelection(capability);
    },
    async readManifestSelection(capability) {
      readCapabilities.push(capability);
      const selection =
        consumeRecallPointObservationManifestReadCapability(
          capability,
        );
      const terminal =
        terminalSnapshots.get(selection.workKeyDigest);
      if (terminal === undefined) {
        throw new Error("registered terminal snapshot unavailable");
      }
      return terminal;
    },
  });
  return {
    capabilities,
    pointObservation,
    pointStore,
    readCapabilities,
    terminal(page, work, outcome = "stable") {
      const indexed = pointStore.manifestEntries(page);
      const ordinal = indexed.entries.findIndex(
        (entry) => entry.workKeyDigest === work.workKeyDigest,
      );
      assert.notEqual(ordinal, -1);
      outcomes.push(outcome);
      const record = {
        status: outcome,
        workKeyDigest: work.workKeyDigest,
        workItemDigest:
          indexed.entries[ordinal].workItemDigest,
        referencePageNumber: page.record.pageNumber,
        referenceOrdinal: ordinal,
        referenceHeadEpochDigest:
          page.recallReferenceHeadEpochDigest,
        referenceHeadRevisionDigest:
          page.recallReferenceHeadRevisionDigest,
        referenceHeadRecordDigest:
          page.recallReferenceHeadRecordDigest,
        resolutionDigest: digestValue(
          "manifest-test-resolution",
          [work.workKeyDigest, outcome],
        ),
        readOne: outcome === "unresolved" ? null : {},
        readTwo: ["stable", "conflict"].includes(outcome)
          ? {}
          : null,
        operational: false,
        globalReferenceSetCoverageAvailable: false,
        sourceFactsAvailable: false,
        successClassificationAvailable: false,
        candidateIdentityResolutionAvailable: false,
        pinnable: false,
        authorityAvailable: false,
        updatedAtMs: fake.nowMs,
      };
      const raw = canonicalJson(record);
      const snapshot = deepFreeze({
        raw,
        rawSha1: sha1(raw),
        record,
        redisNowMs: fake.nowMs,
      });
      terminalSnapshots.set(work.workKeyDigest, snapshot);
      return snapshot;
    },
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(
      error
        instanceof SourceRecallPointObservationManifestStoreError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

async function indexedSourceHarness(source) {
  const fake = fakePersistence();
  const pointStore =
    createSourceRecallPointObservationManifestPointInterface({
      persistence: fake.persistence,
    });
  const outcomes = [];
  const points = pointInterface(pointStore, fake, outcomes);
  const store =
    createSourceRecallPointObservationManifestStore({
      persistence: fake.persistence,
      pointObservation: points.pointObservation,
    });
  const ensured =
    await store.ensureRecallPointObservationManifest(
      source.head,
    );
  const work = deepFreeze({
    manifestKeyDigest: ensured.record.manifestKeyDigest,
  });
  for (const page of source.pages) {
    const claim =
      await store.claimRecallPointObservationManifestStep(
        work,
      );
    assert.equal(claim.status, "page_required");
    assert.equal(claim.pageNumber, page.manifest.pageNumber);
    await store.checkpointRecallPointObservationManifestPage(
      claim,
      page.verifiedPage,
    );
  }
  return {
    fake,
    outcomes,
    points,
    source,
    store,
    work,
  };
}

async function indexedHarness(referencePages) {
  return indexedSourceHarness(fixtures(referencePages));
}

function manifestPageReadCount(fake) {
  return fake.calls.filter(
    ({ method, input }) => (
      method === "read"
      && input.key.includes(
        ":recall-point-observation-manifest:v1:page:",
      )
    ),
  ).length;
}

test("all pages seal before one server-selected observation advances per step", async () => {
  const harness = await indexedHarness();
  assert.deepEqual(
    Object.keys(harness.store).sort(),
    [
      "checkpointRecallPointObservationManifestPage",
      "checkpointRecallPointObservationManifestWork",
      "claimRecallPointObservationManifestStep",
      "ensureRecallPointObservationManifest",
      "prepareRecallPointObservationManifestSelection",
      "readRecallPointObservationManifest",
    ],
  );
  assert.deepEqual(
    Object.keys(harness.points.pointStore).sort(),
    [
      "manifestEntries",
      "prepareManifestSelection",
      "readManifestSelection",
    ],
  );
  assert.equal(
    Object.hasOwn(
      manifestStoreModule,
      "recallPointObservationManifestAggregateStatus",
    ),
    false,
  );
  assert.equal(
    SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_STORE_VERSION,
    "recall-point-observation-manifest-store-dark-v1",
  );
  assert.equal(
    [...harness.fake.values.keys()].some(
      (key) => key.includes(
        ":recall-point-observation:v2:work:",
      ),
    ),
    false,
  );
  let finalCheckpoint = null;
  for (let index = 0; index < 3; index += 1) {
    const claim =
      await harness.store
        .claimRecallPointObservationManifestStep(
          harness.work,
        );
    assert.equal(claim.status, "observation_required");
    const page =
      harness.source.pages[claim.pageNumber - 1].verifiedPage;
    const pointWork =
      await harness.store
        .prepareRecallPointObservationManifestSelection(
          claim,
          page,
        );
    const capability =
      harness.points.capabilities.at(-1);
    assert.equal(Object.isFrozen(capability), true);
    assert.deepEqual(Object.keys(capability), []);
    await assert.rejects(
      harness.points.pointStore
        .prepareManifestSelection(capability),
      (error) => {
        assert.equal(
          error.code,
          "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CAPABILITY_INVALID",
        );
        return true;
      },
    );
    harness.points.terminal(
      page,
      pointWork,
      "stable",
    );
    const result =
      await harness.store
        .checkpointRecallPointObservationManifestWork(
          claim,
        );
    const readCapability =
      harness.points.readCapabilities.at(-1);
    assert.equal(Object.isFrozen(readCapability), true);
    assert.deepEqual(Object.keys(readCapability), []);
    await assert.rejects(
      harness.points.pointObservation
        .readManifestSelection(readCapability),
      expectCode(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CAPABILITY_INVALID",
      ),
    );
    assert.equal(result.referencesSettled, index + 1);
    finalCheckpoint = result;
  }
  assert.equal(finalCheckpoint.status, "verifying_complete");
  assert.equal(
    finalCheckpoint.referenceManifestCoverageComplete,
    false,
  );
  assert.equal(
    finalCheckpoint.globalReferenceSetCoverageAvailable,
    false,
  );
  const complete =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  assert.equal(complete.status, "complete");
  assert.deepEqual(complete.aggregate, {
    status: "observed_complete_dark",
    pageCount: 2,
    pagesIndexed: 2,
    referenceCount: 3,
    referencesIndexed: 3,
    referencesSettled: 3,
    referencesStable: 3,
    referencesConflict: 0,
    referencesUnresolved: 0,
    settledReadsCompleted: 6,
    inProgress: false,
    referenceManifestCoverageComplete: true,
    operational: false,
    globalReferenceSetCoverageAvailable: true,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
  });
  assert.doesNotMatch(
    JSON.stringify(complete.aggregate),
    /Private Candidate|example\.invalid|manifest-test-bot/u,
  );
});

test("checkpoint ignores a fabricated caller snapshot and requires a registered durable read", async () => {
  const harness = await indexedHarness([[reference(31)]]);
  const claim =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  const page = harness.source.pages[0].verifiedPage;
  await harness.store
    .prepareRecallPointObservationManifestSelection(
      claim,
      page,
    );
  const fabricated = deepFreeze({
    raw: "{}",
    rawSha1: "0".repeat(40),
    record: {
      status: "stable",
    },
    redisNowMs: harness.fake.nowMs,
  });
  await assert.rejects(
    harness.store
      .checkpointRecallPointObservationManifestWork(
        claim,
        fabricated,
      ),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_POINT_READ_FAILED",
    ),
  );
  assert.equal(harness.points.readCapabilities.length, 1);
  assert.equal(
    Object.isFrozen(harness.points.readCapabilities[0]),
    true,
  );
  assert.deepEqual(
    Object.keys(harness.points.readCapabilities[0]),
    [],
  );
  const retained =
    await harness.store
      .readRecallPointObservationManifest(
        harness.work,
      );
  assert.equal(retained.record.referencesSettled, 0);
  assert.equal(
    retained.record.referenceManifestCoverageComplete,
    false,
  );
  assert.equal(
    retained.record.globalReferenceSetCoverageAvailable,
    false,
  );
});

test("claim-only checkpoint reads an actual durably settled unresolved point work", async () => {
  const source = fixtures([[reference(32)]]);
  const fake = fakePersistence();
  const manifestPoint =
    createSourceRecallPointObservationManifestPointInterface({
      persistence: fake.persistence,
    });
  const pointStore = createSourceRecallPointObservationStore({
    persistence: fake.persistence,
  });
  const store =
    createSourceRecallPointObservationManifestStore({
      persistence: fake.persistence,
      pointObservation: manifestPoint,
    });
  const ensured =
    await store.ensureRecallPointObservationManifest(
      source.head,
    );
  const work = deepFreeze({
    manifestKeyDigest: ensured.record.manifestKeyDigest,
  });
  const pageClaim =
    await store.claimRecallPointObservationManifestStep(
      work,
    );
  await store.checkpointRecallPointObservationManifestPage(
    pageClaim,
    source.pages[0].verifiedPage,
  );
  const observationClaim =
    await store.claimRecallPointObservationManifestStep(
      work,
    );
  const prepared =
    await store.prepareRecallPointObservationManifestSelection(
      observationClaim,
      source.pages[0].verifiedPage,
    );
  const pointWork = deepFreeze({
    workKeyDigest: prepared.workKeyDigest,
  });
  const pointClaim =
    await pointStore.claimRecallPointObservationRead(
      pointWork,
    );
  const terminal =
    await pointStore.recordRecallPointObservationUnresolved(
      pointClaim,
      "point_read_failed",
    );
  assert.equal(terminal.record.status, "unresolved");

  const aggregate =
    await store.checkpointRecallPointObservationManifestWork(
      observationClaim,
    );
  assert.equal(aggregate.status, "verifying_complete");
  assert.equal(aggregate.referencesSettled, 1);
  assert.equal(aggregate.referencesUnresolved, 1);
  assert.equal(aggregate.settledReadsCompleted, 0);
  assert.equal(
    aggregate.referenceManifestCoverageComplete,
    false,
  );
  assert.equal(
    aggregate.globalReferenceSetCoverageAvailable,
    false,
  );
});

test("terminal conflict completes exact coverage but keeps global coverage false", async () => {
  const harness = await indexedHarness([[reference(1)]]);
  const claim =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  const page = harness.source.pages[0].verifiedPage;
  const pointWork =
    await harness.store
      .prepareRecallPointObservationManifestSelection(
        claim,
        page,
      );
  harness.points.terminal(
    page,
    pointWork,
    "conflict",
  );
  const aggregate =
    await harness.store
      .checkpointRecallPointObservationManifestWork(
        claim,
      );
  assert.equal(
    aggregate.referenceManifestCoverageComplete,
    false,
  );
  assert.equal(
    aggregate.globalReferenceSetCoverageAvailable,
    false,
  );
  assert.equal(aggregate.referencesConflict, 1);
  assert.equal(aggregate.status, "verifying_complete");
  const complete =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  assert.equal(complete.status, "complete");
  assert.equal(
    complete.aggregate.referenceManifestCoverageComplete,
    true,
  );
  assert.equal(
    complete.aggregate.globalReferenceSetCoverageAvailable,
    false,
  );
  assert.equal(complete.aggregate.referencesConflict, 1);
});

test("terminal unresolved completes manifest coverage but keeps global coverage false", async () => {
  const harness = await indexedHarness([[reference(11)]]);
  const claim =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  const page = harness.source.pages[0].verifiedPage;
  const pointWork =
    await harness.store
      .prepareRecallPointObservationManifestSelection(
        claim,
        page,
      );
  harness.points.terminal(
    page,
    pointWork,
    "unresolved",
  );
  const finalCheckpoint =
    await harness.store
      .checkpointRecallPointObservationManifestWork(
        claim,
      );
  assert.equal(finalCheckpoint.status, "verifying_complete");
  assert.equal(finalCheckpoint.referencesUnresolved, 1);
  assert.equal(
    finalCheckpoint.referenceManifestCoverageComplete,
    false,
  );
  assert.equal(
    finalCheckpoint.globalReferenceSetCoverageAvailable,
    false,
  );

  const complete =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  assert.equal(complete.status, "complete");
  assert.equal(complete.aggregate.referencesUnresolved, 1);
  assert.equal(
    complete.aggregate.referenceManifestCoverageComplete,
    true,
  );
  assert.equal(
    complete.aggregate.globalReferenceSetCoverageAvailable,
    false,
  );
});

test("a lost manifest checkpoint can reopen exact terminal point work inside the creation margin", async () => {
  const harness = await indexedHarness([[reference(1)]]);
  const pointStore = createSourceRecallPointObservationStore({
    persistence: harness.fake.persistence,
  });
  const claim =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  const page = harness.source.pages[0].verifiedPage;
  const prepared =
    await harness.store
      .prepareRecallPointObservationManifestSelection(
        claim,
        page,
      );
  const work = deepFreeze({
    workKeyDigest: prepared.workKeyDigest,
  });
  const pointClaim =
    await pointStore.claimRecallPointObservationRead(work);
  const terminal =
    await pointStore.recordRecallPointObservationUnresolved(
      pointClaim,
      "point_read_failed",
    );
  assert.equal(terminal.record.status, "unresolved");

  harness.fake.advance(20 * HOUR - 1);
  const restarted =
    createSourceRecallPointObservationManifestStore({
      persistence: harness.fake.persistence,
      pointObservation: harness.points.pointObservation,
    });
  const reclaimed =
    await restarted.claimRecallPointObservationManifestStep(
      harness.work,
    );
  assert.equal(reclaimed.status, "observation_required");
  assert.equal(reclaimed.workKeyDigest, work.workKeyDigest);
  const ensureCallsBefore = harness.fake.calls.filter(
    ({ method }) => method === "ensure",
  ).length;
  const freshlyReadPage = deepFreeze({
    ...page,
    redisNowMs: harness.fake.nowMs,
    remainingTtlMs:
      page.record.pageExpiresAtMs - harness.fake.nowMs,
  });
  const replayed =
    await restarted
      .prepareRecallPointObservationManifestSelection(
        reclaimed,
        freshlyReadPage,
      );
  const replayedSnapshot =
    await pointStore.readRecallPointObservationWork(replayed);
  assert.equal(replayedSnapshot.record.status, "unresolved");
  assert.equal(
    harness.fake.calls.filter(
      ({ method }) => method === "ensure",
    ).length,
    ensureCallsBefore,
  );

  const missingHarness =
    await indexedHarness([[reference(2)]]);
  missingHarness.fake.advance(20 * HOUR - 1);
  const missingStore =
    createSourceRecallPointObservationManifestStore({
      persistence: missingHarness.fake.persistence,
      pointObservation:
        missingHarness.points.pointObservation,
    });
  const missingClaim =
    await missingStore.claimRecallPointObservationManifestStep(
      missingHarness.work,
    );
  assert.equal(missingClaim.status, "observation_required");
  const missingPage =
    missingHarness.source.pages[0].verifiedPage;
  const freshlyReadMissingPage = deepFreeze({
    ...missingPage,
    redisNowMs: missingHarness.fake.nowMs,
    remainingTtlMs:
      missingPage.record.pageExpiresAtMs
        - missingHarness.fake.nowMs,
  });
  await assert.rejects(
    missingStore.prepareRecallPointObservationManifestSelection(
      missingClaim,
      freshlyReadMissingPage,
    ),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_POINT_PREPARE_FAILED",
    ),
  );
});

test("a sealed zero-reference manifest completes without point preparation", async () => {
  const harness = await indexedHarness([[]]);
  const claim =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  assert.equal(claim.status, "complete");
  assert.equal(claim.aggregate.referenceCount, 0);
  assert.equal(
    claim.aggregate.globalReferenceSetCoverageAvailable,
    true,
  );
  assert.deepEqual(harness.outcomes, []);
});

test("caller selectors and changed head bindings fail closed", async () => {
  const source = fixtures([[reference(1)]]);
  const fake = fakePersistence();
  const pointStore =
    createSourceRecallPointObservationManifestPointInterface({
      persistence: fake.persistence,
    });
  const store =
    createSourceRecallPointObservationManifestStore({
      persistence: fake.persistence,
      pointObservation: pointInterface(
        pointStore,
        fake,
        [],
      ).pointObservation,
    });
  await assert.rejects(
    store.ensureRecallPointObservationManifest({
      ...source.head,
      pageNumber: 1,
    }),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_VERIFIED_HEAD_INVALID",
    ),
  );
  const ensured =
    await store.ensureRecallPointObservationManifest(
      source.head,
    );
  await assert.rejects(
    store.claimRecallPointObservationManifestStep(
      deepFreeze({
        manifestKeyDigest:
          ensured.record.manifestKeyDigest,
        force: true,
      }),
    ),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_WORK_INVALID",
    ),
  );

  const changedHead = withHeadRecordChanges(source, {
    recallReferenceHeadRevisionDigest: digest("a"),
  }).head;
  assert.notEqual(
    changedHead.recallReferenceHeadRecordDigest,
    source.head.recallReferenceHeadRecordDigest,
  );
  await assert.rejects(
    store.ensureRecallPointObservationManifest(changedHead),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_BINDING_MISMATCH",
    ),
  );
});

test("cross-page duplicates and an omitted head commitment fail at index seal", async (t) => {
  await t.test("duplicate reference and work commitments", async () => {
    const duplicated = reference(51);
    const harness = await indexedHarness([
      [duplicated],
      [structuredClone(duplicated)],
    ]);
    await assert.rejects(
      harness.store.claimRecallPointObservationManifestStep(
        harness.work,
      ),
      expectCode(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_INDEX_INVALID",
      ),
    );
  });

  await t.test("head manifest omits one indexed commitment", async () => {
    const source = fixtures([[
      reference(61),
      reference(62),
    ]]);
    const omittedCommitmentHead =
      withHeadRecordChanges(source, {
        referenceManifestDigest: digestValue(
          "phase4-recall-reference-manifest-v1",
          [referenceCommitment(
            source.pages[0].verifiedPage.record.references[0],
          )],
        ),
      });
    const harness =
      await indexedSourceHarness(omittedCommitmentHead);
    await assert.rejects(
      harness.store.claimRecallPointObservationManifestStep(
        harness.work,
      ),
      expectCode(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_INDEX_INVALID",
      ),
    );
  });
});

test("durable manifest raws retain commitments without private fixture values", async () => {
  const harness = await indexedHarness([
    [reference(71), reference(72)],
    [reference(73)],
  ]);
  const manifestRaws = [...harness.fake.values.entries()]
    .filter(([key]) => key.includes(
      ":recall-point-observation-manifest:v1:",
    ))
    .map(([, raw]) => raw);
  assert.equal(
    manifestRaws.length,
    harness.source.pages.length + 1,
  );
  const durableManifestText = manifestRaws.join("\n");
  for (const privateNeedle of [
    "manifest-test-bot-71",
    "manifest-test-bot-72",
    "manifest-test-bot-73",
    "Private Candidate 71",
    "Private Candidate 72",
    "Private Candidate 73",
    "private-71@example.invalid",
    "private-72@example.invalid",
    "private-73@example.invalid",
    "https://example.invalid/private-71",
    "https://example.invalid/private-72",
    "https://example.invalid/private-73",
    "private-event-71",
    "private-event-72",
    "private-event-73",
    "paraform-auto",
    "cursor-2",
  ]) {
    assert.equal(
      durableManifestText.includes(privateNeedle),
      false,
      privateNeedle,
    );
  }
});

test("manifest head and page shards retain one exact earliest absolute expiry", async () => {
  const source = fixtures(
    [
      [reference(1), reference(2)],
      [reference(3)],
    ],
    [20, 18],
  );
  const fake = fakePersistence();
  const pointStore =
    createSourceRecallPointObservationManifestPointInterface({
      persistence: fake.persistence,
    });
  const points = pointInterface(pointStore, fake, []);
  const store =
    createSourceRecallPointObservationManifestStore({
      persistence: fake.persistence,
      pointObservation: points.pointObservation,
    });
  const ensured =
    await store.ensureRecallPointObservationManifest(
      source.head,
    );
  const work = deepFreeze({
    manifestKeyDigest: ensured.record.manifestKeyDigest,
  });
  for (const page of source.pages) {
    const claim =
      await store.claimRecallPointObservationManifestStep(work);
    await store.checkpointRecallPointObservationManifestPage(
      claim,
      page.verifiedPage,
    );
  }
  const expiries = new Set(
    fake.expiries.values(),
  );
  assert.equal(expiries.size, 1);
  assert.equal(
    [...expiries][0],
    START_MS + 18 * HOUR,
  );
  fake.advance(1_000);
  await store.ensureRecallPointObservationManifest(
    source.head,
  );
  assert.equal(
    new Set(fake.expiries.values()).size,
    1,
  );
});

test("the 200-page and 20,000-reference ceiling stays paged below the adapter cap", async () => {
  const referencePages = Array.from(
    { length: 200 },
    (unused, pageIndex) => Array.from(
      { length: 100 },
      (unusedReference, referenceIndex) => reference(
        pageIndex * 100 + referenceIndex + 1,
      ),
    ),
  );
  const source = fixtures(referencePages);
  const fake = fakePersistence();
  const pointStore =
    createSourceRecallPointObservationManifestPointInterface({
      persistence: fake.persistence,
    });
  const points = pointInterface(pointStore, fake, []);
  const store =
    createSourceRecallPointObservationManifestStore({
      persistence: fake.persistence,
      pointObservation: points.pointObservation,
    });
  const ensured =
    await store.ensureRecallPointObservationManifest(
      source.head,
    );
  assert.equal(ensured.record.pageCount, 200);
  assert.equal(ensured.record.referenceCount, 20_000);
  assert.equal(
    Buffer.byteLength(ensured.raw, "utf8") < 256 * 1_024,
    true,
  );
  const work = deepFreeze({
    manifestKeyDigest: ensured.record.manifestKeyDigest,
  });
  const claim =
    await store.claimRecallPointObservationManifestStep(work);
  await store.checkpointRecallPointObservationManifestPage(
    claim,
    source.pages[0].verifiedPage,
  );
  const pageRaw = [...fake.values.entries()].find(
    ([key]) => key.includes(
      ":recall-point-observation-manifest:v1:page:",
    ),
  )[1];
  assert.equal(
    Buffer.byteLength(pageRaw, "utf8") < 256 * 1_024,
    true,
  );
  assert.equal(JSON.parse(pageRaw).entries.length, 100);
  assert.equal(
    [...fake.values.keys()].some(
      (key) => key.includes(
        ":recall-point-observation:v2:work:",
      ),
    ),
    false,
  );
});

test("a lost page-index checkpoint response resumes from the one stored advance", async () => {
  const source = fixtures([[reference(1)]]);
  const fake = fakePersistence();
  const pointStore =
    createSourceRecallPointObservationManifestPointInterface({
      persistence: fake.persistence,
    });
  const points = pointInterface(pointStore, fake, []);
  const store =
    createSourceRecallPointObservationManifestStore({
      persistence: fake.persistence,
      pointObservation: points.pointObservation,
    });
  const ensured =
    await store.ensureRecallPointObservationManifest(
      source.head,
    );
  const work = deepFreeze({
    manifestKeyDigest: ensured.record.manifestKeyDigest,
  });
  const pageClaim =
    await store.claimRecallPointObservationManifestStep(work);
  fake.setCasMode("throw_after_store_once");
  await assert.rejects(
    store.checkpointRecallPointObservationManifestPage(
      pageClaim,
      source.pages[0].verifiedPage,
    ),
  );
  const next =
    await store.claimRecallPointObservationManifestStep(work);
  assert.equal(next.status, "observation_required");
  const snapshot =
    await store.readRecallPointObservationManifest(work);
  assert.equal(snapshot.record.pagesIndexed, 1);
  assert.equal(snapshot.record.referencesIndexed, 1);
});

test("a lost terminal page response reconciles after restart without another settlement", async () => {
  const harness = await indexedHarness([[reference(1)]]);
  const claim =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  const page = harness.source.pages[0].verifiedPage;
  const pointWork =
    await harness.store
      .prepareRecallPointObservationManifestSelection(
        claim,
        page,
      );
  harness.fake.setCasMode("throw_after_store_once");
  harness.points.terminal(
    page,
    pointWork,
    "stable",
  );
  await assert.rejects(
    harness.store
      .checkpointRecallPointObservationManifestWork(
        claim,
      ),
  );
  const inProgress =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  assert.equal(inProgress.status, "in_progress");
  harness.fake.advance(150_001);
  const restarted =
    createSourceRecallPointObservationManifestStore({
      persistence: harness.fake.persistence,
      pointObservation:
        harness.points.pointObservation,
    });
  const complete =
    await restarted
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  assert.equal(complete.status, "complete");
  assert.equal(complete.aggregate.referencesSettled, 1);
  assert.equal(complete.aggregate.referencesStable, 1);
  assert.equal(harness.outcomes.length, 1);
});

test("two store instances share one durable manifest selection", async () => {
  const source = fixtures([[reference(1)]]);
  const fake = fakePersistence();
  const pointStore =
    createSourceRecallPointObservationManifestPointInterface({
      persistence: fake.persistence,
    });
  const points = pointInterface(pointStore, fake, []);
  const first =
    createSourceRecallPointObservationManifestStore({
      persistence: fake.persistence,
      pointObservation: points.pointObservation,
    });
  const second =
    createSourceRecallPointObservationManifestStore({
      persistence: fake.persistence,
      pointObservation: points.pointObservation,
    });
  const ensured =
    await first.ensureRecallPointObservationManifest(
      source.head,
    );
  const work = deepFreeze({
    manifestKeyDigest: ensured.record.manifestKeyDigest,
  });
  const claim =
    await first.claimRecallPointObservationManifestStep(work);
  const competing =
    await second.claimRecallPointObservationManifestStep(work);
  assert.equal(claim.status, "page_required");
  assert.equal(competing.status, "in_progress");
  await first.checkpointRecallPointObservationManifestPage(
    claim,
    source.pages[0].verifiedPage,
  );
  const next =
    await second.claimRecallPointObservationManifestStep(work);
  assert.equal(next.status, "observation_required");
});

test("two stores converge through a barriered index seal", async () => {
  const harness = await indexedHarness([[reference(91)]]);
  const second =
    createSourceRecallPointObservationManifestStore({
      persistence: harness.fake.persistence,
      pointObservation: harness.points.pointObservation,
    });
  harness.fake.barrierNextCompareAndSets(2);
  const conflictsBefore = harness.fake.casConflictCount;
  const results = await Promise.all([
    harness.store.claimRecallPointObservationManifestStep(
      harness.work,
    ),
    second.claimRecallPointObservationManifestStep(
      harness.work,
    ),
  ]);
  assert.deepEqual(
    results.map(({ status }) => status).sort(),
    ["in_progress", "observation_required"],
  );
  assert.equal(
    harness.fake.casConflictCount > conflictsBefore,
    true,
  );
});

test("a lost index-seal response recovers from the stored sealed state", async () => {
  const harness = await indexedHarness([[reference(92)]]);
  harness.fake.setCasMode("throw_after_store_once");
  const resumed =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  assert.equal(resumed.status, "observation_required");
  const repeated =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  assert.equal(repeated.status, "in_progress");
});

test("two stores converge through a barriered complete-proof seal", async () => {
  const harness = await indexedHarness([[reference(93)]]);
  const claim =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  const page = harness.source.pages[0].verifiedPage;
  const pointWork =
    await harness.store
      .prepareRecallPointObservationManifestSelection(
        claim,
        page,
      );
  harness.points.terminal(
    page,
    pointWork,
    "stable",
  );
  const verifying =
    await harness.store
      .checkpointRecallPointObservationManifestWork(
        claim,
      );
  assert.equal(verifying.status, "verifying_complete");
  const second =
    createSourceRecallPointObservationManifestStore({
      persistence: harness.fake.persistence,
      pointObservation: harness.points.pointObservation,
    });
  harness.fake.barrierNextCompareAndSets(2);
  const conflictsBefore = harness.fake.casConflictCount;
  const results = await Promise.all([
    harness.store.claimRecallPointObservationManifestStep(
      harness.work,
    ),
    second.claimRecallPointObservationManifestStep(
      harness.work,
    ),
  ]);
  assert.deepEqual(
    results.map(({ status }) => status),
    ["complete", "complete"],
  );
  assert.equal(
    harness.fake.casConflictCount - conflictsBefore,
    1,
  );
  for (const result of results) {
    assert.equal(
      result.aggregate.referenceManifestCoverageComplete,
      true,
    );
    assert.equal(
      result.aggregate.globalReferenceSetCoverageAvailable,
      true,
    );
  }
});

test("a lost complete-proof seal response recovers from the stored terminal state", async () => {
  const harness = await indexedHarness([[reference(94)]]);
  const claim =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  const page = harness.source.pages[0].verifiedPage;
  const pointWork =
    await harness.store
      .prepareRecallPointObservationManifestSelection(
        claim,
        page,
      );
  harness.points.terminal(
    page,
    pointWork,
    "stable",
  );
  const verifying =
    await harness.store
      .checkpointRecallPointObservationManifestWork(
        claim,
      );
  assert.equal(verifying.status, "verifying_complete");
  harness.fake.setCasMode("throw_after_store_once");
  const complete =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  assert.equal(complete.status, "complete");
  assert.equal(
    complete.aggregate.referenceManifestCoverageComplete,
    true,
  );
});

test("observation reconciliation and the first complete proof stay page-bounded", async () => {
  const harness = await indexedHarness([
    [reference(81), reference(82)],
    [reference(83), reference(84)],
    [reference(85), reference(86)],
  ]);
  let reconciliationPageReads = 0;
  let finalCheckpoint = null;
  for (let index = 0; index < 6; index += 1) {
    const claim =
      await harness.store
        .claimRecallPointObservationManifestStep(
          harness.work,
        );
    assert.equal(claim.status, "observation_required");
    const page =
      harness.source.pages[claim.pageNumber - 1].verifiedPage;
    const pointWork =
      await harness.store
        .prepareRecallPointObservationManifestSelection(
          claim,
          page,
        );
    const readsBefore = manifestPageReadCount(harness.fake);
    harness.points.terminal(
      page,
      pointWork,
      "stable",
    );
    finalCheckpoint =
      await harness.store
        .checkpointRecallPointObservationManifestWork(
          claim,
        );
    const pageReads =
      manifestPageReadCount(harness.fake) - readsBefore;
    reconciliationPageReads += pageReads;
    const endsNonterminalPage =
      claim.referenceOrdinal === 1
      && claim.pageNumber < harness.source.pages.length;
    assert.equal(pageReads, endsNonterminalPage ? 2 : 1);
  }
  assert.equal(reconciliationPageReads, 8);
  assert.equal(finalCheckpoint.status, "verifying_complete");
  assert.equal(
    finalCheckpoint.referenceManifestCoverageComplete,
    false,
  );
  assert.equal(
    finalCheckpoint.globalReferenceSetCoverageAvailable,
    false,
  );

  const proofReadsBefore = manifestPageReadCount(harness.fake);
  const complete =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  const proofPageReads =
    manifestPageReadCount(harness.fake) - proofReadsBefore;
  assert.equal(complete.status, "complete");
  assert.equal(
    proofPageReads,
    harness.source.pages.length,
  );
});

test("complete coverage is re-proved from every retained page shard", async () => {
  const harness = await indexedHarness([[reference(1)]]);
  const claim =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  const page = harness.source.pages[0].verifiedPage;
  const pointWork =
    await harness.store
      .prepareRecallPointObservationManifestSelection(
        claim,
        page,
      );
  harness.points.terminal(
    page,
    pointWork,
    "stable",
  );
  await harness.store
    .checkpointRecallPointObservationManifestWork(
      claim,
    );
  const complete =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  assert.equal(complete.status, "complete");
  const pageKey = [...harness.fake.values.keys()].find(
    (key) => key.includes(
      ":recall-point-observation-manifest:v1:page:",
    ),
  );
  harness.fake.values.delete(pageKey);
  harness.fake.expiries.delete(pageKey);
  await assert.rejects(
    harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      ),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PAGE_NOT_FOUND",
    ),
  );
});

test("ensure re-proves a complete manifest before returning retained coverage", async () => {
  const harness = await indexedHarness([[reference(101)]]);
  const claim =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  const page = harness.source.pages[0].verifiedPage;
  const pointWork =
    await harness.store
      .prepareRecallPointObservationManifestSelection(
        claim,
        page,
      );
  harness.points.terminal(
    page,
    pointWork,
    "stable",
  );
  await harness.store
    .checkpointRecallPointObservationManifestWork(
      claim,
    );
  const complete =
    await harness.store
      .claimRecallPointObservationManifestStep(
        harness.work,
      );
  assert.equal(complete.status, "complete");

  const pageKey = [...harness.fake.values.keys()].find(
    (key) => key.includes(
      ":recall-point-observation-manifest:v1:page:",
    ),
  );
  harness.fake.values.delete(pageKey);
  harness.fake.expiries.delete(pageKey);
  await assert.rejects(
    harness.store.ensureRecallPointObservationManifest(
      harness.source.head,
    ),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PAGE_NOT_FOUND",
    ),
  );
});
