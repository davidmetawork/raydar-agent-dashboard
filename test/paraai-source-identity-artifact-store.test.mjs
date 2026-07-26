import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_IDENTITY_ALIAS_PAGE_SIZE,
  SOURCE_IDENTITY_POINT_READ_PROCEDURE,
  SOURCE_IDENTITY_PRIVATE_WORK_TTL_MS,
  SOURCE_IDENTITY_READ_CLAIM_LEASE_MS,
  SOURCE_IDENTITY_TWO_READ_MAX_INTERVAL_MS,
  SOURCE_IDENTITY_UNRESOLVED_REASONS,
  SourceIdentityArtifactStoreError,
  checkpointIdentityObservationRead,
  claimIdentityObservationRead,
  createIdentityObservationWork,
  ensureIdentityObservationRun,
  finalizeIdentityObservationWorkSet,
  identityArtifactAggregateStatus,
  prepareIdentityAliasArtifact,
  readIdentityAliasArtifactHead,
  readIdentityAliasArtifactPage,
  recordIdentityObservationUnresolved,
  sourceIdentityArtifactStoreConfigured,
} from "../api/paraai/_lib/source-identity-artifact-store.mjs";
import {
  createSourceIdentityAliasAdapter,
} from "../api/paraai/_lib/source-identity-alias-adapter.mjs";

const START_MS = Date.parse("2026-07-26T04:00:00.000Z");
const digest = (character) => character.repeat(64);

process.env.PARAAI_SOURCE_IDENTITY_KV_REST_API_URL =
  "https://identity-artifact-kv.test.invalid";
process.env.PARAAI_SOURCE_IDENTITY_KV_REST_API_TOKEN =
  "identity-artifact-test-token";

function redisParts(nowMs) {
  return [
    String(Math.floor(nowMs / 1_000)),
    String((nowMs % 1_000) * 1_000),
  ];
}

function response(result) {
  return {
    ok: true,
    text: async () => JSON.stringify({ result }),
  };
}

function fakeRedis(nowMs = START_MS) {
  const state = new Map();
  const commands = [];
  const clock = { nowMs };

  async function fetchImpl(_url, options) {
    const command = JSON.parse(options.body);
    commands.push(command);
    assert.equal(command[0], "EVAL");
    const script = command[1];
    const keyCount = Number(command[2]);
    const keys = command.slice(3, 3 + keyCount);
    const args = command.slice(3 + keyCount);
    const time = redisParts(clock.nowMs);

    if (script.includes("proposed.createdAtMs = nowMs")) {
      const current = state.get(keys[0]);
      if (current) return response([0, current, ...time]);
      const proposed = JSON.parse(args[0]);
      proposed.createdAtMs = clock.nowMs;
      proposed.updatedAtMs = clock.nowMs;
      const raw = JSON.stringify(proposed);
      state.set(keys[0], raw);
      return response([1, raw, ...time]);
    }

    if (script.includes("table.insert(run.workKeyDigests")) {
      const runRaw = state.get(keys[0]);
      if (runRaw !== args[0]) {
        return response([-3, runRaw || "", "", ...time]);
      }
      const existing = state.get(keys[1]);
      const run = JSON.parse(runRaw);
      const indexed = run.workKeyDigests.includes(args[2]);
      if (indexed && !existing) {
        return response([-5, runRaw, "", ...time]);
      }
      if (existing && !indexed) {
        return response([-8, runRaw, existing, ...time]);
      }
      if (existing) {
        return response([0, runRaw, existing, ...time]);
      }
      const work = JSON.parse(args[1]);
      assert.equal(
        Number(args[3]),
        SOURCE_IDENTITY_PRIVATE_WORK_TTL_MS,
      );
      work.createdAtMs = clock.nowMs;
      work.updatedAtMs = clock.nowMs;
      const workRaw = JSON.stringify(work);
      state.set(keys[1], workRaw);
      run.workKeyDigests.push(args[2]);
      run.workKeyDigests.sort();
      run.updatedAtMs = clock.nowMs;
      run.revision += 1;
      const nextRunRaw = JSON.stringify(run);
      state.set(keys[0], nextRunRaw);
      return response([1, nextRunRaw, workRaw, ...time]);
    }

    if (script.includes("current.activeClaim = {")) {
      const currentRaw = state.get(keys[0]);
      if (currentRaw !== args[0]) {
        return response([-3, currentRaw || "", ...time]);
      }
      const current = JSON.parse(currentRaw);
      const readNumber = Number(args[2]);
      const expected = readNumber === 1
        ? "awaiting_read_1"
        : "awaiting_read_2";
      if (current.status !== expected) {
        return response([-7, currentRaw, ...time]);
      }
      current.status = `claimed_read_${readNumber}`;
      current.activeClaim = {
        readNumber,
        claimNonceDigest: args[1],
        claimedAtMs: clock.nowMs,
        validUntilMs:
          clock.nowMs + Number(args[3]),
      };
      current.updatedAtMs = clock.nowMs;
      current.revision += 1;
      const nextRaw = JSON.stringify(current);
      state.set(keys[0], nextRaw);
      return response([1, nextRaw, ...time]);
    }

    if (script.includes("current.status = 'work_set_complete'")) {
      const currentRaw = state.get(keys[0]);
      if (currentRaw !== args[0]) {
        return response([-3, currentRaw || "", ...time]);
      }
      const current = JSON.parse(currentRaw);
      if (
        current.status !== "collecting"
        || current.workKeyDigests.length !== Number(args[2])
        || keys.length - 1 !== current.workKeyDigests.length
      ) {
        return response([-7, currentRaw, ...time]);
      }
      for (let index = 1; index < keys.length; index += 1) {
        const workRaw = state.get(keys[index]);
        if (!workRaw) {
          return response([-5, currentRaw, ...time]);
        }
        const work = JSON.parse(workRaw);
        if (
          work.workKeyDigest
            !== current.workKeyDigests[index - 1]
          || work.runKeyDigest !== current.runKeyDigest
        ) {
          return response([-8, currentRaw, ...time]);
        }
      }
      current.status = "work_set_complete";
      current.workManifestDigest = args[1];
      current.workManifestCount = Number(args[2]);
      current.updatedAtMs = clock.nowMs;
      current.revision += 1;
      const nextRaw = JSON.stringify(current);
      state.set(keys[0], nextRaw);
      return response([1, nextRaw, ...time]);
    }

    if (script.includes("evidence.claimNonceDigest = ARGV[3]")) {
      const currentRaw = state.get(keys[0]);
      if (currentRaw !== args[0]) {
        return response([-3, currentRaw || "", ...time]);
      }
      const current = JSON.parse(currentRaw);
      const evidence = JSON.parse(args[1]);
      const readNumber = Number(args[3]);
      if (
        current.status !== `claimed_read_${readNumber}`
        || current.activeClaim.claimNonceDigest !== args[2]
        || clock.nowMs > current.activeClaim.validUntilMs
      ) {
        return response([-7, currentRaw, ...time]);
      }
      evidence.claimNonceDigest = args[2];
      evidence.persistedAtMs = clock.nowMs;
      if (readNumber === 1) {
        current.readOne = evidence;
        current.status = "awaiting_read_2";
        current.activeClaim = null;
      } else {
        current.readTwo = evidence;
        current.activeClaim = null;
        const fields = [
          "identityPointReadProcedure",
          "identityNormalizedInputDigest",
          "candidateUserAliasDigest",
          "canonicalCandidateDigest",
          "identityPointRecordDigest",
          "identityPointRecordRevisionDigest",
          "evidenceDigest",
        ];
        const same = fields.every(
          (field) => current.readOne[field] === evidence[field],
        );
        if (
          clock.nowMs - current.readOne.persistedAtMs
          > Number(args[4])
        ) {
          current.status = "conflict";
          current.terminalReason =
            "two_read_interval_exceeded";
        } else if (!same) {
          current.status = "conflict";
          current.terminalReason =
            "two_read_evidence_mismatch";
        } else {
          current.status = "resolved";
          current.resolutionDigest = args[5];
        }
      }
      current.updatedAtMs = clock.nowMs;
      current.revision += 1;
      const nextRaw = JSON.stringify(current);
      state.set(keys[0], nextRaw);
      return response([1, nextRaw, ...time]);
    }

    if (script.includes("current.status = 'unresolved'")) {
      const currentRaw = state.get(keys[0]);
      if (currentRaw !== args[0]) {
        return response([-3, currentRaw || "", ...time]);
      }
      const current = JSON.parse(currentRaw);
      current.status = "unresolved";
      current.activeClaim = null;
      current.terminalReason = args[1];
      current.updatedAtMs = clock.nowMs;
      current.revision += 1;
      const nextRaw = JSON.stringify(current);
      state.set(keys[0], nextRaw);
      return response([1, nextRaw, ...time]);
    }

    if (script.includes("local result = {1, redisTime[1]")) {
      if (state.get(keys[0]) !== args[0]) {
        return response([-3, ...time]);
      }
      const raws = keys.slice(1).map((key) => state.get(key));
      if (raws.some((raw) => !raw)) {
        return response([-4, ...time]);
      }
      return response([1, ...time, ...raws]);
    }

    if (script.includes("local immutableCount = tonumber(ARGV[4])")) {
      const runRaw = state.get(keys[0]);
      if (runRaw !== args[0]) {
        return response([-3, runRaw || "", "", ...time]);
      }
      const workCount = Number(args[5]);
      const proposedRaws = args.slice(6);
      assert.equal(proposedRaws.length, keys.length - 1);
      for (let index = 1; index <= workCount; index += 1) {
        if (state.get(keys[index]) !== proposedRaws[index - 1]) {
          return response([
            -10,
            runRaw,
            state.get(keys[index]) || "",
            ...time,
          ]);
        }
      }
      for (
        let index = workCount + 1;
        index < keys.length;
        index += 1
      ) {
        const existing = state.get(keys[index]);
        if (
          existing
          && existing !== proposedRaws[index - 1]
        ) {
          return response([
            -6,
            runRaw,
            existing,
            ...time,
          ]);
        }
      }
      for (
        let index = workCount + 1;
        index < keys.length;
        index += 1
      ) {
        state.set(keys[index], proposedRaws[index - 1]);
        assert.equal(
          state.get(keys[index]),
          proposedRaws[index - 1],
        );
      }
      const run = JSON.parse(runRaw);
      run.status = "sealed";
      run.sealedArtifactDigest = args[2];
      run.sealedHeadRecordDigest = args[4];
      run.updatedAtMs = clock.nowMs;
      run.revision += 1;
      const nextRunRaw = JSON.stringify(run);
      state.set(keys[0], nextRunRaw);
      return response([1, nextRunRaw, args[1], ...time]);
    }

    if (script.includes("redis.call('GET', KEYS[1]) or ''")) {
      return response([state.get(keys[0]) || "", ...time]);
    }

    throw new Error("unrecognized Redis script");
  }

  return {
    state,
    commands,
    clock,
    fetch: fetchImpl,
  };
}

async function withRedis(redis, operation) {
  const saved = globalThis.fetch;
  globalThis.fetch = redis.fetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = saved;
  }
}

function workInput({
  run = "a",
  work = "b",
  privateWorkReference = "candidate-user-private",
} = {}) {
  return {
    runNonceDigest: digest(run),
    decisionBoundaryAtMs: START_MS - 1_000,
    contractPinsDigest: digest("c"),
    workItemDigest: digest(work),
    privateWorkReference,
  };
}

function evidence({
  input = "d",
  alias = "e",
  canonical = "f",
  record = "1",
  revision = "2",
} = {}) {
  return {
    identityPointReadProcedure:
      SOURCE_IDENTITY_POINT_READ_PROCEDURE,
    identityNormalizedInputDigest: digest(input),
    candidateUserAliasDigest: digest(alias),
    canonicalCandidateDigest: digest(canonical),
    identityPointRecordDigest: digest(record),
    identityPointRecordRevisionDigest: digest(revision),
  };
}

async function createWork(redis, input = workInput()) {
  return withRedis(
    redis,
    () => createIdentityObservationWork(input),
  );
}

async function resolveWork(redis, input, evidenceValue) {
  const work = await createWork(redis, input);
  const firstClaim = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  await withRedis(
    redis,
    () => checkpointIdentityObservationRead(
      firstClaim,
      evidenceValue,
    ),
  );
  const secondClaim = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  const resolved = await withRedis(
    redis,
    () => checkpointIdentityObservationRead(
      secondClaim,
      evidenceValue,
    ),
  );
  return resolved;
}

test("work creation is store-keyed, Redis-timed, and idempotent", async () => {
  const redis = fakeRedis();
  const input = workInput({
    privateWorkReference: "private-candidate-user",
  });
  const first = await createWork(redis, input);
  const second = await createWork(redis, input);

  assert.equal(first.record.status, "awaiting_read_1");
  assert.equal(first.record.createdAtMs, START_MS);
  assert.equal(first.record.workKeyDigest.length, 64);
  assert.equal(
    second.record.workKeyDigest,
    first.record.workKeyDigest,
  );
  assert.equal(
    [...redis.state.keys()].some(
      (key) => key.includes(input.privateWorkReference),
    ),
    false,
  );
  assert.match(
    redis.commands
      .map((command) => command[1])
      .join("\n"),
    /runRaw ~= ARGV\[1\]/u,
  );
  assert.equal(
    SOURCE_IDENTITY_PRIVATE_WORK_TTL_MS,
    24 * 60 * 60 * 1_000,
  );
  await assert.rejects(
    createWork(redis, {
      ...input,
      privateWorkReference: "different-private-reference",
    }),
    (error) => (
      error instanceof SourceIdentityArtifactStoreError
      && error.code
        === "SOURCE_IDENTITY_WORK_IDEMPOTENCY_CONFLICT"
    ),
  );
  await assert.rejects(
    createWork(redis, {
      ...input,
      workItemDigest: digest("9"),
      privateWorkReference: "x".repeat(513),
    }),
    TypeError,
  );
});

test("expired indexed work is never recreated or duplicated", async () => {
  const redis = fakeRedis();
  const input = workInput({ work: "7" });
  const work = await createWork(redis, input);
  const workKey = [...redis.state.keys()].find(
    (key) => key.endsWith(work.record.workKeyDigest),
  );
  redis.state.delete(workKey);
  await assert.rejects(
    createWork(redis, input),
    (error) => (
      error instanceof SourceIdentityArtifactStoreError
      && error.code
        === "SOURCE_IDENTITY_PRIVATE_WORK_STATE_LOST"
    ),
  );
  const run = [...redis.state.values()]
    .map((raw) => JSON.parse(raw))
    .find(
      (record) => record.kind
        === "identity_observation_run_dark",
    );
  assert.deepEqual(run.workKeyDigests, [
    work.record.workKeyDigest,
  ]);
  await assert.rejects(
    withRedis(
      redis,
      () => finalizeIdentityObservationWorkSet({
        runNonceDigest: input.runNonceDigest,
        decisionBoundaryAtMs: input.decisionBoundaryAtMs,
        contractPinsDigest: input.contractPinsDigest,
      }),
    ),
    (error) => (
      error.code
        === "SOURCE_IDENTITY_PRIVATE_WORK_STATE_LOST"
    ),
  );
});

test("claim ordinal is durably server-selected and read one is persisted", async () => {
  const redis = fakeRedis();
  const work = await createWork(redis);
  const claim = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  assert.equal(claim.status, "read_required");
  assert.equal(claim.readNumber, 1);
  assert.equal(claim.firstEvidence, null);
  assert.equal(Object.isFrozen(claim), true);

  const durable = [...redis.state.values()]
    .map((raw) => JSON.parse(raw))
    .find((record) => record.kind
      === "identity_observation_work_dark");
  assert.equal(durable.status, "claimed_read_1");
  assert.equal(
    durable.activeClaim.claimNonceDigest,
    claim.claimNonceDigest,
  );
  assert.equal(
    durable.activeClaim.validUntilMs
      - durable.activeClaim.claimedAtMs,
    SOURCE_IDENTITY_READ_CLAIM_LEASE_MS,
  );

  const after = await withRedis(
    redis,
    () => checkpointIdentityObservationRead(
      claim,
      evidence(),
    ),
  );
  assert.equal(after.record.status, "awaiting_read_2");
  assert.deepEqual(
    Object.keys(after.record.readOne).sort(),
    [
      "candidateUserAliasDigest",
      "canonicalCandidateDigest",
      "claimNonceDigest",
      "evidenceDigest",
      "identityNormalizedInputDigest",
      "identityPointReadProcedure",
      "identityPointRecordDigest",
      "identityPointRecordRevisionDigest",
      "persistedAtMs",
    ].sort(),
  );
  await assert.rejects(
    withRedis(
      redis,
      () => checkpointIdentityObservationRead(
        claim,
        evidence(),
      ),
    ),
    (error) => error.code === "SOURCE_IDENTITY_CLAIM_INVALID",
  );
});

test("concurrent claim cannot issue the same provider read twice", async () => {
  const redis = fakeRedis();
  const work = await createWork(redis);
  const [first, second] = await withRedis(
    redis,
    () => Promise.all([
      claimIdentityObservationRead({
        workKeyDigest: work.record.workKeyDigest,
      }),
      claimIdentityObservationRead({
        workKeyDigest: work.record.workKeyDigest,
      }),
    ]),
  );
  assert.deepEqual(
    [first.status, second.status].sort(),
    ["in_progress", "read_required"],
  );
  const claimMutations = redis.commands.filter(
    (command) => command[1].includes(
      "current.activeClaim = {",
    ),
  );
  assert.equal(claimMutations.length >= 2, true);
  assert.equal(
    [...redis.state.values()].filter(
      (raw) => raw.includes('"status":"claimed_read_1"'),
    ).length,
    1,
  );
});

test("abandoned durable claim terminalizes and is never reissued", async () => {
  const redis = fakeRedis();
  const work = await createWork(redis);
  const first = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  assert.equal(first.status, "read_required");
  redis.clock.nowMs +=
    SOURCE_IDENTITY_READ_CLAIM_LEASE_MS + 1;
  const afterCrash = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  assert.deepEqual(afterCrash, {
    status: "complete",
    workKeyDigest: work.record.workKeyDigest,
    outcome: "unresolved",
  });
  const later = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  assert.equal(later.status, "complete");
  assert.equal(later.outcome, "unresolved");
});

test("restart after durable read one resumes at read two and stops after resolution", async () => {
  const redis = fakeRedis();
  const work = await createWork(redis);
  const first = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  await withRedis(
    redis,
    () => checkpointIdentityObservationRead(
      first,
      evidence(),
    ),
  );

  const resumed = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  assert.equal(resumed.readNumber, 2);
  assert.deepEqual(resumed.firstEvidence, evidence());
  assert.equal(Object.isFrozen(resumed.firstEvidence), true);
  const resolved = await withRedis(
    redis,
    () => checkpointIdentityObservationRead(
      resumed,
      evidence(),
    ),
  );
  assert.equal(resolved.record.status, "resolved");

  const noThirdRead = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  assert.deepEqual(noThirdRead, {
    status: "complete",
    workKeyDigest: work.record.workKeyDigest,
    outcome: "resolved",
  });
});

test("second-read drift records candidate-local conflict", async () => {
  const redis = fakeRedis();
  const work = await createWork(redis);
  const first = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  await withRedis(
    redis,
    () => checkpointIdentityObservationRead(
      first,
      evidence(),
    ),
  );
  const second = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  const conflict = await withRedis(
    redis,
    () => checkpointIdentityObservationRead(
      second,
      evidence({ revision: "3" }),
    ),
  );
  assert.equal(conflict.record.status, "conflict");
  assert.equal(
    conflict.record.terminalReason,
    "two_read_evidence_mismatch",
  );
});

test("expired two-read interval terminalizes without another provider read", async () => {
  const redis = fakeRedis();
  const work = await createWork(redis);
  const first = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  await withRedis(
    redis,
    () => checkpointIdentityObservationRead(
      first,
      evidence(),
    ),
  );
  redis.clock.nowMs +=
    SOURCE_IDENTITY_TWO_READ_MAX_INTERVAL_MS + 1;
  const expired = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  assert.equal(expired.status, "complete");
  assert.equal(expired.outcome, "unresolved");
});

test("only exact collector failure reasons can consume a claim", async () => {
  assert.deepEqual(SOURCE_IDENTITY_UNRESOLVED_REASONS, [
    "identity_point_read_failed",
    "identity_point_response_invalid",
    "identity_point_unstable",
  ]);
  const redis = fakeRedis();
  const work = await createWork(redis);
  const claim = await withRedis(
    redis,
    () => claimIdentityObservationRead({
      workKeyDigest: work.record.workKeyDigest,
    }),
  );
  await assert.rejects(
    withRedis(
      redis,
      () => recordIdentityObservationUnresolved(
        claim,
        "caller_selected_reason",
      ),
    ),
    (error) => (
      error.code
        === "SOURCE_IDENTITY_UNRESOLVED_REASON_INVALID"
    ),
  );
  const unresolved = await withRedis(
    redis,
    () => recordIdentityObservationUnresolved(
      claim,
      "identity_point_response_invalid",
    ),
  );
  assert.equal(unresolved.record.status, "unresolved");
  assert.equal(
    unresolved.record.terminalReason,
    "identity_point_response_invalid",
  );
});

test("sealing produces immutable exact digest-only head and pages", async () => {
  const redis = fakeRedis();
  const input = workInput({
    privateWorkReference:
      "candidate-user-raw-private-do-not-seal",
  });
  await resolveWork(redis, input, evidence());
  const runInput = {
    runNonceDigest: input.runNonceDigest,
    decisionBoundaryAtMs: input.decisionBoundaryAtMs,
    contractPinsDigest: input.contractPinsDigest,
  };
  await assert.rejects(
    withRedis(
      redis,
      () => prepareIdentityAliasArtifact(runInput),
    ),
    (error) => (
      error.code
        === "SOURCE_IDENTITY_WORK_MANIFEST_NOT_FINALIZED"
    ),
  );
  const finalized = await withRedis(
    redis,
    () => finalizeIdentityObservationWorkSet(runInput),
  );
  assert.equal(finalized.record.status, "work_set_complete");
  assert.equal(finalized.record.workManifestCount, 1);
  assert.match(
    finalized.record.workManifestDigest,
    /^[a-f0-9]{64}$/u,
  );
  const prepared = await withRedis(
    redis,
    () => prepareIdentityAliasArtifact(runInput),
  );
  assert.equal(prepared.pageCount, 1);
  assert.equal(prepared.resolvedEntryCount, 1);
  assert.equal(prepared.operational, false);

  const head = await withRedis(
    redis,
    () => readIdentityAliasArtifactHead({
      sealedArtifactDigest: prepared.sealedArtifactDigest,
      ...runInput,
    }),
  );
  assert.equal(
    createHash("sha256").update(head.raw).digest("hex"),
    head.headRecordDigest,
  );
  assert.equal(JSON.stringify(head.record), head.raw);
  assert.equal(
    head.record.sealedArtifactDigest,
    prepared.sealedArtifactDigest,
  );
  assert.equal(
    head.record.workManifestDigest,
    finalized.record.workManifestDigest,
  );
  assert.equal(head.record.workManifestCount, 1);
  assert.match(
    head.record.terminalWorkSetDigest,
    /^[a-f0-9]{64}$/u,
  );

  const page = await withRedis(
    redis,
    () => readIdentityAliasArtifactPage({
      sealedArtifactDigest: prepared.sealedArtifactDigest,
      ...runInput,
      cursorToken: null,
    }),
  );
  assert.equal(page.recordCount, 1);
  assert.equal(page.nextCursorToken, null);
  assert.equal(JSON.stringify(page.record), page.raw);
  const headKey = [...redis.state.keys()].find(
    (key) => key.includes(":head:v1:"),
  );
  const pageKey = [...redis.state.keys()].find(
    (key) => key.includes(":page:v1:"),
  );
  assert.equal(redis.state.get(headKey), head.raw);
  assert.equal(redis.state.get(pageKey), page.raw);
  for (const raw of [head.raw, page.raw]) {
    assert.equal(
      raw.includes(input.privateWorkReference),
      false,
    );
    assert.doesNotMatch(
      raw,
      /(candidate-user-raw-private|@|https?:\/\/)/u,
    );
  }

  const aliasAdapter = createSourceIdentityAliasAdapter({
    artifactStore: {
      prepareIdentityAliasArtifact,
      readIdentityAliasArtifactHead,
      readIdentityAliasArtifactPage,
    },
  });
  const captureRecord = {
    ...runInput,
    status: "capturing",
    activeStep: {
      source: "aliases",
      passNumber: 1,
      pageNumber: 1,
      cursorToken: null,
    },
  };
  const integratedPage = await withRedis(
    redis,
    () => aliasAdapter.readPage({
      claimNonceDigest: digest("9"),
      raw: JSON.stringify(captureRecord),
      record: captureRecord,
    }),
  );
  assert.equal(
    integratedPage.checkpointEvent.pageSemanticDigest,
    page.pageSemanticDigest,
  );
  assert.equal(
    integratedPage.checkpointEvent.sourceHeadRecordDigest,
    head.headRecordDigest,
  );
  assert.equal(
    integratedPage.checkpointEvent.recordCount,
    page.recordCount,
  );

  const idempotent = await withRedis(
    redis,
    () => prepareIdentityAliasArtifact(runInput),
  );
  assert.equal(
    idempotent.sealedArtifactDigest,
    prepared.sealedArtifactDigest,
  );
  assert.equal(
    idempotent.headRecordDigest,
    prepared.headRecordDigest,
  );

  for (const key of [...redis.state.keys()]) {
    if (key.includes(":work:v1:")) redis.state.delete(key);
  }
  const afterPrivateExpiry = await withRedis(
    redis,
    () => prepareIdentityAliasArtifact(runInput),
  );
  assert.equal(
    afterPrivateExpiry.sealedArtifactDigest,
    prepared.sealedArtifactDigest,
  );
  assert.equal(
    afterPrivateExpiry.headRecordDigest,
    prepared.headRecordDigest,
  );
});

test("expired private work fails a finalized pre-seal run closed", async () => {
  const redis = fakeRedis();
  const input = workInput({ work: "8" });
  await resolveWork(redis, input, evidence());
  const runInput = {
    runNonceDigest: input.runNonceDigest,
    decisionBoundaryAtMs: input.decisionBoundaryAtMs,
    contractPinsDigest: input.contractPinsDigest,
  };
  await withRedis(
    redis,
    () => finalizeIdentityObservationWorkSet(runInput),
  );
  for (const key of [...redis.state.keys()]) {
    if (key.includes(":work:v1:")) redis.state.delete(key);
  }
  await assert.rejects(
    withRedis(
      redis,
      () => prepareIdentityAliasArtifact(runInput),
    ),
    (error) => (
      error.code === "SOURCE_IDENTITY_WORK_SET_CONFLICT"
    ),
  );
});

test("duplicate resolved alias edges are excluded as conflicts", async () => {
  const redis = fakeRedis();
  const firstInput = workInput({
    work: "6",
    privateWorkReference: "private-edge-one",
  });
  const secondInput = workInput({
    work: "7",
    privateWorkReference: "private-edge-two",
  });
  await resolveWork(redis, firstInput, evidence());
  await resolveWork(redis, secondInput, evidence());
  const runInput = {
    runNonceDigest: firstInput.runNonceDigest,
    decisionBoundaryAtMs: firstInput.decisionBoundaryAtMs,
    contractPinsDigest: firstInput.contractPinsDigest,
  };
  await withRedis(
    redis,
    () => finalizeIdentityObservationWorkSet(runInput),
  );
  const prepared = await withRedis(
    redis,
    () => prepareIdentityAliasArtifact(runInput),
  );
  assert.equal(prepared.resolvedEntryCount, 0);
  assert.equal(prepared.conflictWorkCount, 2);
  const page = await withRedis(
    redis,
    () => readIdentityAliasArtifactPage({
      sealedArtifactDigest: prepared.sealedArtifactDigest,
      ...runInput,
      cursorToken: null,
    }),
  );
  assert.equal(page.recordCount, 0);
  assert.deepEqual(page.record.entries, []);
});

test("fixed pages use deterministic opaque cursors with no caller limit", async () => {
  const source = await readFile(
    new URL(
      "../api/paraai/_lib/source-identity-artifact-store.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(SOURCE_IDENTITY_ALIAS_PAGE_SIZE, 100);
  assert.match(
    source,
    /offset \+= SOURCE_IDENTITY_ALIAS_PAGE_SIZE/u,
  );
  assert.match(
    source,
    /phase4-source-identity-alias-page-cursor-v1/u,
  );
  assert.doesNotMatch(
    readIdentityAliasArtifactPage.toString(),
    /\blimit\b|\boffset\b/u,
  );
  assert.match(
    source,
    /existing and existing ~= proposedRaw/u,
  );
  assert.match(
    source,
    /readback ~= proposedRaw/u,
  );
  assert.match(
    source,
    /encodedWork, 'PX', ARGV\[4\]/u,
  );
  assert.equal(
    (source.match(/encoded, 'KEEPTTL'/gu) || []).length,
    3,
  );
});

test("aggregate status is hard-dark and contains no private material", async () => {
  const redis = fakeRedis();
  const input = workInput({
    privateWorkReference:
      "candidate-user-private-aggregate",
  });
  const resolved = await resolveWork(
    redis,
    input,
    evidence(),
  );
  const run = await withRedis(
    redis,
    () => finalizeIdentityObservationWorkSet({
      runNonceDigest: input.runNonceDigest,
      decisionBoundaryAtMs: input.decisionBoundaryAtMs,
      contractPinsDigest: input.contractPinsDigest,
    }),
  );
  const status = identityArtifactAggregateStatus({
    run: run.record,
    works: [resolved.record],
  });
  assert.equal(status.operational, false);
  assert.equal(status.pinnable, false);
  assert.equal(status.upstreamExhaustivenessProven, false);
  assert.equal(status.activationAvailable, false);
  assert.equal(status.writeAuthorityAvailable, false);
  assert.equal(status.curationAvailable, false);
  assert.equal(status.enrollmentAvailable, false);
  assert.equal(status.resolvedCount, 1);
  const serialized = JSON.stringify(status);
  assert.equal(
    serialized.includes(input.privateWorkReference),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(Object.keys(status)),
    /(candidate|email|name|link|cursor|digest|runNonce)/iu,
  );
  assert.throws(
    () => identityArtifactAggregateStatus({
      run: run.record,
      works: [],
    }),
    (error) => (
      error.code === "SOURCE_IDENTITY_AGGREGATE_INPUT_INVALID"
    ),
  );
  assert.throws(
    () => identityArtifactAggregateStatus({
      works: [resolved.record],
    }),
    (error) => (
      error.code === "SOURCE_IDENTITY_AGGREGATE_INPUT_INVALID"
    ),
  );
});

test("module has no authority signer, coordinator, curation, or enrollment import", async () => {
  const source = await readFile(
    new URL(
      "../api/paraai/_lib/source-identity-artifact-store.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /source-authority-store|source-capture-coordinator|createHmac|receiptMac/u,
  );
  assert.doesNotMatch(
    source
      .split("\n")
      .filter((line) => /^import/u.test(line))
      .join("\n"),
    /curat|enroll|outreach|paraform/iu,
  );
  assert.match(source, /currentRaw ~= ARGV\[1\]/u);
  assert.match(source, /redis\.call\('TIME'\)/u);
});

test("private Redis credentials are a dedicated atomic pair", async () => {
  assert.equal(sourceIdentityArtifactStoreConfigured(), true);
  const saved =
    process.env.PARAAI_SOURCE_IDENTITY_KV_REST_API_TOKEN;
  delete process.env.PARAAI_SOURCE_IDENTITY_KV_REST_API_TOKEN;
  try {
    assert.equal(sourceIdentityArtifactStoreConfigured(), false);
    await assert.rejects(
      ensureIdentityObservationRun({
        runNonceDigest: digest("4"),
        decisionBoundaryAtMs: START_MS,
        contractPinsDigest: digest("5"),
      }),
      (error) => (
        error.code
          === "SOURCE_IDENTITY_ARTIFACT_STORE_CONFIGURATION_INVALID"
      ),
    );
  } finally {
    process.env.PARAAI_SOURCE_IDENTITY_KV_REST_API_TOKEN =
      saved;
  }
});
