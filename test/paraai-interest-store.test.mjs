import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireLock,
  claimSubmission,
  claimSubmissionAttempt,
  getSubmissionClaim,
  listInterestHandoffRecords,
  listPendingJobs,
  projectInterestHandoff,
  recordInterestHandoff,
  recordSubmissionOutcome,
  recordSubmissionPrepared,
  releaseSubmissionClaim,
  releaseLock,
  resolveInterestHandoff,
  saveJob,
  startSubmissionAttempt,
} from "../api/paraai/_lib/interest-store.mjs";

function inMemoryClaimKv() {
  const values = new Map();
  return async (args) => {
    if (args[0] === "GET") return values.get(args[1]) ?? null;
    assert.equal(args[0], "EVAL");
    const script = args[1];
    const key = args[3];
    const argv = args.slice(4);
    const raw = values.get(key) ?? null;

    if (script.includes("if raw then return {0, raw}")) {
      if (raw) return [0, raw];
      values.set(key, argv[0]);
      return [1, argv[0]];
    }

    if (script.includes("if claim.lane ~= ARGV[2]")) {
      if (!raw) return [0, ""];
      const claim = JSON.parse(raw);
      if (claim.attemptId !== argv[0]) return [-1, raw];
      if (claim.lane !== argv[1]) return [-2, raw];
      if (["accepted", "verified"].includes(claim.outcome)) return [-3, raw];
      values.delete(key);
      return [1, raw];
    }

    if (!raw) return [-1, ""];
    const claim = JSON.parse(raw);
    if (claim.attemptId !== argv[0]) return [-2, raw];

    if (script.includes("claim.candidateToApprovedRoleId = ARGV[2]")) {
      if (!claim.attemptStartedAt) return [-3, raw];
      if (claim.candidateToApprovedRoleId) {
        return claim.candidateToApprovedRoleId === argv[1] ? [2, raw] : [-4, raw];
      }
      if (claim.outcome) return [-4, raw];
      claim.candidateToApprovedRoleId = argv[1];
      claim.preparedAt = argv[2];
      claim.state = "prepared";
      const next = JSON.stringify(claim);
      values.set(key, next);
      return [1, next];
    }

    if (script.includes("local current = claim.outcome")) {
      if (!claim.attemptStartedAt) return [-3, raw];
      const current = claim.outcome;
      const nextOutcome = argv[1];
      if (current === nextOutcome) return [2, raw];
      const advanced = nextOutcome === "verified"
        && ["accepted", "submission_unknown"].includes(current);
      if (current && !advanced) return [-4, raw];
      claim.outcome = nextOutcome;
      claim.outcomeAt = argv[2];
      claim.state = nextOutcome;
      if (argv[3]) claim.detail = argv[3];
      const next = JSON.stringify(claim);
      values.set(key, next);
      return [advanced ? 3 : 1, next];
    }

    if (script.includes("claim.attemptStartedAt = ARGV[2]")) {
      if (claim.attemptStartedAt) return [2, raw];
      claim.attemptStartedAt = argv[1];
      claim.state = "attempt_started";
      const next = JSON.stringify(claim);
      values.set(key, next);
      return [1, next];
    }

    throw new Error("unexpected claim script");
  };
}

test("submission claim is permanent and returns the original fencing token", async () => {
  const kvImpl = inMemoryClaimKv();
  const first = await claimSubmission("candidate-1", "role-1", { roleId: "role-1" }, { kvImpl });
  const second = await claimSubmission("candidate-1", "role-1", { roleId: "role-1" }, { kvImpl });
  assert.equal(first.status, "claimed");
  assert.equal(second.status, "existing");
  assert.equal(second.claim.attemptId, first.claim.attemptId);
  assert.equal(second.claim.state, "claimed");
});

test("the production claim atomically starts its sole mutation attempt", async () => {
  const kvImpl = inMemoryClaimKv();
  const first = await claimSubmissionAttempt(
    "candidate-1",
    "role-1",
    { roleId: "role-1" },
    { kvImpl },
  );
  const second = await claimSubmissionAttempt(
    "candidate-1",
    "role-1",
    { roleId: "role-1" },
    { kvImpl },
  );
  assert.equal(first.status, "started");
  assert.equal(first.claim.state, "attempt_started");
  assert.ok(first.claim.attemptStartedAt);
  assert.equal(second.status, "existing");
  assert.equal(second.claim.attemptId, first.claim.attemptId);
  const prepared = await recordSubmissionPrepared(
    "candidate-1",
    "role-1",
    first.claim.attemptId,
    "candidate-role-1",
    { kvImpl },
  );
  assert.equal(prepared.status, "prepared");
});

test("only the claim owner can start, prepare, and record an outcome", async () => {
  const kvImpl = inMemoryClaimKv();
  const won = await claimSubmission("candidate-1", "role-1", {}, { kvImpl });
  const attemptId = won.claim.attemptId;
  await assert.rejects(
    startSubmissionAttempt("candidate-1", "role-1", "stale-worker", { kvImpl }),
    (error) => error.code === "SUBMISSION_CLAIM_CONFLICT",
  );
  const started = await startSubmissionAttempt("candidate-1", "role-1", attemptId, { kvImpl });
  assert.equal(started.status, "started");
  const prepared = await recordSubmissionPrepared(
    "candidate-1",
    "role-1",
    attemptId,
    "candidate-role-1",
    { kvImpl },
  );
  assert.equal(prepared.status, "prepared");
  const accepted = await recordSubmissionOutcome(
    "candidate-1",
    "role-1",
    "accepted",
    { attemptId, kvImpl },
  );
  assert.equal(accepted.status, "recorded");
  const verified = await recordSubmissionOutcome(
    "candidate-1",
    "role-1",
    "verified",
    { attemptId, kvImpl },
  );
  assert.equal(verified.status, "advanced");
  const stored = await getSubmissionClaim("candidate-1", "role-1", { kvImpl });
  assert.equal(stored.outcome, "verified");
  assert.equal(stored.candidateToApprovedRoleId, "candidate-role-1");
});

test("unknown can reconcile to verified but cannot be rewritten as accepted", async () => {
  const kvImpl = inMemoryClaimKv();
  const won = await claimSubmission("candidate-1", "role-1", {}, { kvImpl });
  const attemptId = won.claim.attemptId;
  await startSubmissionAttempt("candidate-1", "role-1", attemptId, { kvImpl });
  await recordSubmissionOutcome(
    "candidate-1",
    "role-1",
    "submission_unknown",
    { attemptId, kvImpl },
  );
  await assert.rejects(
    recordSubmissionOutcome(
      "candidate-1",
      "role-1",
      "accepted",
      { attemptId, kvImpl },
    ),
    (error) => error.code === "SUBMISSION_OUTCOME_CONFLICT",
  );
  const reconciled = await recordSubmissionOutcome(
    "candidate-1",
    "role-1",
    "verified",
    { attemptId, kvImpl },
  );
  assert.equal(reconciled.status, "advanced");
});

test("human recovery releases only its exact non-terminal Path B fencing token", async () => {
  const kvImpl = inMemoryClaimKv();
  const won = await claimSubmissionAttempt(
    "candidate-1",
    "role-1",
    { lane: "submissions" },
    { kvImpl },
  );
  await assert.rejects(
    releaseSubmissionClaim("candidate-1", "role-1", "stale", { lane: "submissions", kvImpl }),
    (error) => error.code === "SUBMISSION_CLAIM_CONFLICT",
  );
  await assert.rejects(
    releaseSubmissionClaim("candidate-1", "role-1", won.claim.attemptId, { lane: "worker", kvImpl }),
    (error) => error.code === "SUBMISSION_CLAIM_LANE_CONFLICT",
  );
  const released = await releaseSubmissionClaim(
    "candidate-1",
    "role-1",
    won.claim.attemptId,
    { lane: "submissions", kvImpl },
  );
  assert.equal(released.released, true);
  assert.equal(await getSubmissionClaim("candidate-1", "role-1", { kvImpl }), null);
});

function inMemoryQueueKv() {
  const values = new Map();
  const sets = new Map();
  const kvImpl = async (args) => {
    const [command, key, ...rest] = args;
    if (command === "GET") return values.get(key) ?? null;
    if (command === "SET") {
      if (rest.includes("NX") && values.has(key)) return null;
      values.set(key, rest[0]);
      return "OK";
    }
    if (command === "SADD") {
      const set = sets.get(key) || new Set();
      set.add(rest[0]);
      sets.set(key, set);
      return 1;
    }
    if (command === "SREM") {
      return sets.get(key)?.delete(rest[0]) ? 1 : 0;
    }
    if (command === "SMEMBERS") return [...(sets.get(key) || [])];
    if (command === "DEL") return values.delete(key) ? 1 : 0;
    if (command === "EVAL") {
      const lockKey = args[3];
      const token = args[4];
      if (values.get(lockKey) !== token) return 0;
      values.delete(lockKey);
      return 1;
    }
    throw new Error(`unexpected queue command ${command}`);
  };
  kvImpl.values = values;
  kvImpl.sets = sets;
  return kvImpl;
}

test("pending jobs survive the sweep boundary and leave the queue at either terminal stage", async () => {
  const kvImpl = inMemoryQueueKv();
  const pending = await saveJob({
    candidateUserId: "candidate-1",
    candidateId: "candidate-record-1",
    batchId: "batch-1",
    stage: "detected",
    roles: ["role-1"],
  }, { kvImpl });
  assert.equal(pending.stage, "detected");
  assert.deepEqual(
    (await listPendingJobs(10, { kvImpl })).map((job) => job.batchId),
    ["batch-1"],
  );
  await saveJob({ ...pending, stage: "done" }, { kvImpl });
  assert.deepEqual(await listPendingJobs(10, { kvImpl }), []);
  await saveJob({ ...pending, stage: "awaiting_human_submission" }, { kvImpl });
  assert.deepEqual(await listPendingJobs(10, { kvImpl }), []);
});

test("terminal handoffs are minimal, batch-addressed, and independently resolvable", async () => {
  const kvImpl = inMemoryQueueKv();
  const shared = {
    candidateUserId: "candidate-1",
    candidateId: "candidate-record-1",
    stage: "email_complete",
    stopped: { paused: 1, alreadyPaused: 2, vendorPayload: "do-not-copy" },
    emailed: {
      sent: true,
      messageId: "private-provider-id",
      recipient: "private@example.com",
    },
    rolloutPhase: "human_handoff",
    transcript: "private transcript",
    generatedDraft: "private candidate prose",
  };
  await recordInterestHandoff("candidate-1", {
    ...shared,
    batchId: "batch-1",
    roles: ["role-1"],
    submissions: [{
      roleId: "role-1",
      stage: "would_submit",
      blockers: ["preferences_incomplete", "AUTH_EXPIRED", "private@example.com"],
      draft: "do-not-copy",
    }],
  }, ["human_submission_required", "private prose"], { kvImpl });
  await recordInterestHandoff("candidate-1", {
    ...shared,
    batchId: "batch-2",
    roles: ["role-2"],
    submissions: [{
      roleId: "role-2",
      stage: "would_submit",
      blockers: [],
    }],
  }, ["human_submission_required"], { kvImpl });

  const records = await listInterestHandoffRecords(10, { kvImpl });
  assert.deepEqual(
    records.map((record) => record.batchId).sort(),
    ["batch-1", "batch-2"],
  );
  const first = records.find((record) => record.batchId === "batch-1");
  assert.deepEqual(
    first.submissions[0].blockers,
    ["preferences_incomplete", "auth_expired"],
  );
  assert.deepEqual(first.reasons, ["human_submission_required"]);
  const durableJson = [...kvImpl.values.values()].join("\n");
  assert.doesNotMatch(durableJson, /private@example\.com|private transcript|candidate prose|provider-id|do-not-copy/);
  const handoffMembers = [...(kvImpl.sets.get("paraai:interest:handoff:index") || [])];
  assert.equal(handoffMembers.length, 2);
  assert.ok(handoffMembers.every((member) => /^[a-f0-9]{64}:[a-f0-9]{64}$/u.test(member)));

  const immutable = await recordInterestHandoff("candidate-1", {
    ...shared,
    batchId: "batch-1",
    roles: ["role-should-not-overwrite"],
    submissions: [],
  }, ["shadow_would_submit"], { kvImpl });
  assert.deepEqual(immutable.roles, ["role-1"]);
  assert.deepEqual(immutable.reasons, ["human_submission_required"]);

  assert.equal(
    await resolveInterestHandoff("candidate-1", "batch-1", { kvImpl }),
    true,
  );
  assert.equal(
    await resolveInterestHandoff("candidate-1", "batch-1", { kvImpl }),
    false,
  );
  assert.deepEqual(
    (await listInterestHandoffRecords(10, { kvImpl }))
      .map((record) => record.batchId),
    ["batch-2"],
  );
  const afterResolve = await recordInterestHandoff("candidate-1", {
    ...shared,
    batchId: "batch-1",
    roles: ["role-should-not-resurrect"],
    submissions: [],
  }, ["human_submission_required"], { kvImpl });
  assert.equal(afterResolve.state, "resolved");
  assert.deepEqual(
    (await listInterestHandoffRecords(10, { kvImpl }))
      .map((record) => record.batchId),
    ["batch-2"],
  );
});

test("handoff projection rejects missing batches and strips free-form reason text", () => {
  assert.throws(
    () => projectInterestHandoff("candidate-1", {}, []),
    /batchId required/,
  );
  const projected = projectInterestHandoff("candidate-1", {
    batchId: "batch-1",
    roles: ["role-1"],
  }, ["shadow_would_submit", "contains private prose"]);
  assert.deepEqual(projected.reasons, ["shadow_would_submit"]);
  assert.equal(projected.mode, "shadow_observation");

  const blocked = projectInterestHandoff("candidate-1", {
    batchId: "batch-2",
    roles: ["role-2"],
    submissions: [{
      roleId: "role-2",
      stage: "blocked",
      blockers: ["credits_exhausted"],
    }],
  }, ["credits_exhausted", "no_bankable_role"]);
  assert.equal(blocked.mode, "manual_review");
  assert.deepEqual(
    blocked.reasons,
    ["credits_exhausted", "no_bankable_role"],
  );
});

test("lock release is an atomic token check", async () => {
  const kvImpl = inMemoryQueueKv();
  const token = await acquireLock("candidate-1", { kvImpl });
  assert.ok(token);
  assert.equal(await releaseLock("candidate-1", "stale-token", { kvImpl }), false);
  assert.equal(await releaseLock("candidate-1", token, { kvImpl }), true);
});
