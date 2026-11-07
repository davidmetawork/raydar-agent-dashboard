import test from "node:test";
import assert from "node:assert/strict";

import {
  claimDueAutoJobs,
  claimSubmissionIntent,
  completeAutoJob,
  createJob,
  enqueueAutoJob,
  finishSubmissionAttempt,
  getAutoQueueStats,
  getSubmissionIntent,
  hashSubmissionPayload,
  hashedCandidateClaimKey,
  rescheduleAutoJob,
  stableStringify,
  startSubmissionAttempt,
  submissionOutcomeTransition,
} from "../api/paraai/_lib/store.mjs";

const candidateUserId = "candidate-user-private-123";
const jobId = "bot_12345678";
const attemptId = "attempt-123";
const payloadHash = "a".repeat(64);
const baseIntent = {
  version: 1,
  jobId,
  payloadHash,
  attemptId,
  claimedAt: "2026-07-16T20:00:00.000Z",
};

test("candidate claim keys are deterministic hashes and never expose identifiers", () => {
  const key = hashedCandidateClaimKey(candidateUserId);
  assert.equal(key, hashedCandidateClaimKey(candidateUserId));
  assert.match(key, /^paraai:submit-claim:[a-f0-9]{64}$/);
  assert.equal(key.includes(candidateUserId), false);
  assert.notEqual(key, hashedCandidateClaimKey(`${candidateUserId}-other`));
});

test("submission payload hashes are stable across object key order", () => {
  const left = { name: "Example", preferences: { salaryMin: 200000, locations: ["new_york"] } };
  const right = { preferences: { locations: ["new_york"], salaryMin: 200000 }, name: "Example" };
  assert.equal(stableStringify(left), stableStringify(right));
  assert.equal(hashSubmissionPayload(left), hashSubmissionPayload(right));
  assert.match(hashSubmissionPayload(left), /^[a-f0-9]{64}$/);
});

test("job creation writes the job and index in one atomic Lua operation", async () => {
  const calls = [];
  const job = { id: jobId, state: "detected", createdAt: "2026-07-16T20:00:00.000Z" };
  const result = await createJob(job, {
    kvImpl: async (command) => {
      calls.push(command);
      return [1, command[5]];
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "EVAL");
  assert.match(calls[0][1], /redis\.call\('SET'/);
  assert.match(calls[0][1], /redis\.call\('ZADD'/);
  assert.equal(calls[0][2], 2);
  assert.equal(calls[0][3], `paraai:job:${jobId}`);
  assert.equal(calls[0][4], "paraai:index");
  assert.equal(result.id, jobId);
  assert.equal(result.revision, 0);
});

test("auto enqueue deduplicates hashed webhook events and preserves the effective due time", async () => {
  const commands = [];
  const first = await enqueueAutoJob(jobId, {
    source: "recall.transcript.done",
    eventId: "webhook-private-event",
    dueAt: 1_000,
    now: 900,
  }, {
    kvImpl: async (command) => {
      commands.push(command);
      return [1, "1000"];
    },
  });
  const duplicate = await enqueueAutoJob(jobId, {
    eventId: "webhook-private-event",
    dueAt: 2_000,
    now: 1_000,
  }, { kvImpl: async () => [0, "1000"] });
  assert.deepEqual(first, { enqueued: true, duplicate: false, botId: jobId, dueAt: 1_000 });
  assert.deepEqual(duplicate, { enqueued: false, duplicate: true, botId: jobId, dueAt: 1_000 });
  assert.deepEqual(
    await enqueueAutoJob(jobId, { eventId: "duplicate-without-queue-row", dueAt: 3_000 }, {
      kvImpl: async () => [0, ""],
    }),
    { enqueued: false, duplicate: true, botId: jobId, dueAt: 3_000 },
  );
  assert.equal(commands[0][0], "EVAL");
  assert.match(commands[0][4], /^paraai:auto:event:[a-f0-9]{64}$/);
  assert.equal(commands[0][4].includes("webhook-private-event"), false);
  assert.equal(commands[0][5], `paraai:auto:meta:${jobId}`);
  assert.match(JSON.parse(commands[0][10]).generation, /^[a-f0-9-]{36}$/);
  assert.equal(Number(commands[0][12]), 180 * 24 * 60 * 60);
  assert.match(commands[0][1], /due < tonumber\(current\)/);
  assert.match(commands[0][1], /old\.source == 'authorized_backfill'/);
});

test("due jobs receive fenced leases and remain scheduled at lease expiry", async () => {
  const commands = [];
  const claimed = await claimDueAutoJobs(2, {
    now: 5_000,
    leaseMs: 30_000,
    workerId: "worker-a",
  }, {
    kvImpl: async (command) => {
      commands.push(command);
      return [
        jobId, "worker-a:token:1:generation-a", "35000", "recall:transcript.done", "generation-a", "2",
        "bot_87654321", "worker-a:token:2:generation-b", "35000", "authorized_backfill", "generation-b", "0",
      ];
    },
  });
  assert.deepEqual(claimed, [
    {
      botId: jobId,
      leaseToken: "worker-a:token:1:generation-a",
      leaseUntil: 35_000,
      source: "recall:transcript.done",
      generation: "generation-a",
      attempts: 2,
    },
    {
      botId: "bot_87654321",
      leaseToken: "worker-a:token:2:generation-b",
      leaseUntil: 35_000,
      source: "authorized_backfill",
      generation: "generation-b",
      attempts: 0,
    },
  ]);
  assert.match(commands[0][1], /redis\.call\('SET', leaseKey, token, 'PX'/);
  assert.match(commands[0][1], /redis\.call\('ZADD', KEYS\[1\], ARGV\[7\], jobId\)/);
  assert.match(commands[0][1], /meta\.generation/);
});

test("only the current lease owner can complete or reschedule an auto job", async () => {
  assert.equal(await completeAutoJob(jobId), false);
  assert.equal(await completeAutoJob(jobId, {
    leaseToken: "lease-a",
    generation: "generation-a",
  }, { kvImpl: async () => 1 }), true);
  assert.equal(await completeAutoJob(jobId, { leaseToken: "stale" }, { kvImpl: async () => 0 }), false);
  assert.equal(await completeAutoJob(jobId, {
    leaseToken: "lease-a",
    generation: "generation-a",
  }, { kvImpl: async () => 2 }), false);

  const result = await rescheduleAutoJob(jobId, {
    leaseToken: "lease-a",
    generation: "generation-a",
    delayMs: 60_000,
    error: "temporary read failure",
    now: 1_000,
  }, { kvImpl: async () => 1 });
  assert.deepEqual(result, { rescheduled: true, superseded: false, dueAt: 61_000 });
  const sourcePreserving = [];
  await rescheduleAutoJob(jobId, {
    leaseToken: "lease-a",
    generation: "generation-a",
    delayMs: 60_000,
    now: 1_000,
  }, {
    kvImpl: async (command) => {
      sourcePreserving.push(command);
      return 1;
    },
  });
  assert.match(sourcePreserving[0][1], /next\.source = old\.source/);
  assert.match(sourcePreserving[0][1], /next\.generation = old\.generation/);
  assert.match(sourcePreserving[0][1], /currentGeneration ~= ARGV\[6\]/);
  assert.deepEqual(
    await rescheduleAutoJob(jobId, {
      leaseToken: "lease-a",
      generation: "generation-a",
      delayMs: 1_000,
    }, { kvImpl: async () => 2 }),
    { rescheduled: false, superseded: true, dueAt: null },
  );
  assert.deepEqual(
    await rescheduleAutoJob(jobId, { delayMs: 1_000 }, { kvImpl: async () => 1 }),
    { rescheduled: false, dueAt: null },
  );
});

test("queue stats clean expired leases and report due, leased, and next work", async () => {
  const kvCalls = [];
  const pipelineCalls = [];
  const stats = await getAutoQueueStats({ now: 5_000 }, {
    kvImpl: async (command) => kvCalls.push(command),
    pipelineImpl: async (commands) => {
      pipelineCalls.push(commands);
      return [7, 3, 2, [jobId, "9000"]];
    },
  });
  assert.deepEqual(stats, { queued: 7, due: 3, leased: 2, nextDueAt: 9_000 });
  assert.deepEqual(kvCalls[0], ["ZREMRANGEBYSCORE", "paraai:auto:leases", "-inf", 5_000]);
  assert.equal(pipelineCalls[0].length, 4);
});

test("candidate submission claim is idempotent only for the same job and payload", async () => {
  const commands = [];
  const claimed = await claimSubmissionIntent({
    candidateUserId,
    jobId,
    payloadHash,
    claimedAt: baseIntent.claimedAt,
    attemptId,
  }, {
    kvImpl: async (command) => {
      commands.push(command);
      return [1, JSON.stringify(baseIntent)];
    },
  });
  assert.equal(claimed.status, "claimed");
  assert.deepEqual(claimed.intent, baseIntent);
  assert.equal(commands[0][3].includes(candidateUserId), false);
  assert.match(commands[0][3], /^paraai:submit-claim:[a-f0-9]{64}$/);

  const existing = await claimSubmissionIntent({
    candidateUserId,
    jobId,
    payloadHash,
  }, { kvImpl: async () => [2, JSON.stringify(baseIntent)] });
  assert.equal(existing.status, "existing");
  assert.equal(existing.intent.attemptId, attemptId);

  await assert.rejects(
    claimSubmissionIntent(
      { candidateUserId, jobId: "bot_99999999", payloadHash },
      { kvImpl: async () => [-1, JSON.stringify(baseIntent)] },
    ),
    (error) => error?.code === "SUBMISSION_ALREADY_CLAIMED" && error.intent.jobId === jobId,
  );
});

test("attempt start is a one-way durable marker with fenced ownership", async () => {
  const startedIntent = { ...baseIntent, attemptStartedAt: "2026-07-16T20:00:01.000Z" };
  const started = await startSubmissionAttempt({
    candidateUserId,
    jobId,
    attemptId,
    startedAt: startedIntent.attemptStartedAt,
  }, { kvImpl: async () => [1, JSON.stringify(startedIntent)] });
  assert.equal(started.status, "started");
  assert.equal(started.intent.attemptStartedAt, startedIntent.attemptStartedAt);

  const again = await startSubmissionAttempt(
    { candidateUserId, jobId, attemptId },
    { kvImpl: async () => [2, JSON.stringify(startedIntent)] },
  );
  assert.equal(again.status, "already_started");

  await assert.rejects(
    startSubmissionAttempt(
      { candidateUserId, jobId, attemptId: "wrong-attempt" },
      { kvImpl: async () => [-2, JSON.stringify(startedIntent)] },
    ),
    (error) => error?.code === "SUBMISSION_INTENT_CONFLICT",
  );
});

test("submission outcomes only move forward and support idempotent reconciliation", async () => {
  assert.equal(submissionOutcomeTransition(null, "accepted"), "finished");
  assert.equal(submissionOutcomeTransition("accepted", "accepted"), "existing");
  assert.equal(submissionOutcomeTransition("accepted", "confirmed"), "advanced");
  assert.equal(submissionOutcomeTransition("unknown", "confirmed"), "advanced");
  assert.equal(submissionOutcomeTransition("rejected", "confirmed"), "conflict");
  assert.equal(submissionOutcomeTransition("confirmed", "unknown"), "conflict");
  assert.equal(submissionOutcomeTransition(null, "maybe"), "invalid");

  const accepted = {
    ...baseIntent,
    attemptStartedAt: "2026-07-16T20:00:01.000Z",
    outcome: "accepted",
    finishedAt: "2026-07-16T20:00:02.000Z",
  };
  const result = await finishSubmissionAttempt({
    candidateUserId,
    jobId,
    attemptId,
    outcome: "accepted",
    finishedAt: accepted.finishedAt,
  }, { kvImpl: async () => [1, JSON.stringify(accepted)] });
  assert.equal(result.status, "finished");

  const confirmed = { ...accepted, outcome: "confirmed", finishedAt: "2026-07-16T20:00:30.000Z" };
  const advanced = await finishSubmissionAttempt({
    candidateUserId,
    jobId,
    attemptId,
    outcome: "confirmed",
  }, { kvImpl: async () => [3, JSON.stringify(confirmed)] });
  assert.equal(advanced.status, "advanced");

  await assert.rejects(
    finishSubmissionAttempt(
      { candidateUserId, jobId, attemptId, outcome: "unknown" },
      { kvImpl: async () => [-4, JSON.stringify(confirmed)] },
    ),
    (error) => error?.code === "SUBMISSION_OUTCOME_CONFLICT",
  );
});

test("submission intents can be read without exposing candidate identifiers in commands", async () => {
  const commands = [];
  const result = await getSubmissionIntent(candidateUserId, {
    kvImpl: async (command) => {
      commands.push(command);
      return JSON.stringify(baseIntent);
    },
  });
  assert.deepEqual(result, baseIntent);
  assert.equal(commands[0][1].includes(candidateUserId), false);
});
