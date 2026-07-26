import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  armPhase3ShadowRelease,
  phase3ShadowExecutionEnabled,
  phase3ShadowReleaseStatus,
  processAutoJob,
  runPhase3ShadowReleaseTick,
  selectPhase3ShadowBootstrapJobs,
} from "../api/paraai/_lib/auto.mjs";
import {
  claimPhase3ShadowReleaseBatch,
  completePhase3ShadowReleaseBatch,
  createPhase3ShadowRelease,
  phase3ShadowReleaseManifestDigest,
  reanchorAndEnqueuePhase3ShadowJob,
  recordPhase3ShadowAggregateAuditResult,
  saveAndEnqueuePhase3ShadowJob,
} from "../api/paraai/_lib/store.mjs";
import {
  phase3AwaitingMatchesSaveBoundary,
} from "../api/paraai/run.mjs";
import {
  phase3AggregateAuditFailure,
  phase3AggregateSafetyDigest,
  phase3ShadowStatusWithEscalation,
} from "../api/paraai/worker.mjs";
import {
  LATE_MATCH_REVIEW_NOTE_CODE,
} from "../api/paraai/_lib/phase3-shadow-policy.mjs";

const POLICY_VERSION = "phase3-shadow-policy-v1";
const ANCHOR = "2026-07-26T01:00:00.000Z";
const ANCHOR_MS = Date.parse(ANCHOR);
const FINGERPRINT = "a".repeat(40);
const MATCH_READ_PROC =
  "candidateMatching.getRankedRolesForCandidate";

function completeCallProofBootstrap(snapshotTotal) {
  return {
    version: 1,
    status: "complete",
    policyVersion: POLICY_VERSION,
    snapshotComplete: true,
    snapshotFingerprint: FINGERPRINT,
    snapshotTotal,
    candidateCount: snapshotTotal,
    conflicts: 0,
    completedAt: ANCHOR,
  };
}

function awaitingJob(
  id,
  {
    revision = 2,
    submittedAt = "2026-07-25T00:00:00.000Z",
    ...overrides
  } = {},
) {
  return {
    id,
    revision,
    state: "awaiting_matches",
    submittedAt,
    submitReadbackVerified: true,
    matchLegStartedAt: "2026-07-25T00:01:00.000Z",
    automation: {
      stepFailures: {
        resume_read: {
          count: 2,
          code: "TEMPORARY",
          message: "private failure",
        },
      },
    },
    journal: [],
    ...overrides,
  };
}

function manifestEntries(jobs) {
  return jobs.map((job) => ({
    id: job.id,
    revision: Number(job.revision),
  }));
}

function releaseRecord(
  jobs,
  {
    status = "armed",
    entryStatus = "pending",
    attempts = entryStatus === "pending" ? 0 : 1,
    lease = null,
  } = {},
) {
  const entries = manifestEntries(jobs).map((entry) => ({
    ...entry,
    status: entryStatus,
    attempts,
  }));
  const manifestDigest = phase3ShadowReleaseManifestDigest({
    policyVersion: POLICY_VERSION,
    snapshotFingerprint: FINGERPRINT,
    commonAnchorAt: ANCHOR,
    entries,
  });
  return {
    version: 1,
    status,
    policyVersion: POLICY_VERSION,
    manifestDigest,
    snapshotComplete: true,
    snapshotFingerprint: FINGERPRINT,
    snapshotTotal: jobs.length,
    commonAnchorAt: ANCHOR,
    count: jobs.length,
    entries,
    batchOrdinal: lease ? 1 : status === "armed" ? 0 : 1,
    armedAt: ANCHOR,
    ...(lease ? { lease } : {}),
    ...(status === "released" ? { releasedAt: ANCHOR } : {}),
  };
}

function completePhase3ShadowSnapshot(jobs, overrides = {}) {
  return {
    version: 1,
    source: "phase3_shadow_job_index_v1",
    snapshotComplete: true,
    snapshotFingerprint: FINGERPRINT,
    total: jobs.length,
    missing: 0,
    invalid: 0,
    observedAt: ANCHOR,
    jobs,
    ...overrides,
  };
}

const shadowConfig = {
  matchStageEnabled: true,
  matchShadow: true,
  curateEnabled: false,
  enrollApproved: false,
  matchStageEnabledAtMs: ANCHOR_MS,
  matchReadProc: MATCH_READ_PROC,
  matchReadPinned: true,
  workerBatch: 5,
};

function validShadowEvidence({
  observedAt,
  matchCount,
  endorsedCount,
  suggestedCount,
} = {}) {
  const settlementDecision = matchCount === 0
    ? "zero_settled"
    : "matches_settled";
  const targetSequenceId = matchCount === 0
    ? "cmqpje4lh00040cki15nuuqc8"
    : matchCount === 1
      ? "cmqk75h7x00030bj8f5s6oaw8"
      : "vw168sypaoagu5j5g209cps3";
  const audit = {
    policyVersion: POLICY_VERSION,
    observedAt,
    aggregateOnly: true,
    match: {
      decision: settlementDecision,
      matchCount,
      settled: true,
      timedOut: false,
    },
    curation: {
      recommendedCount: endorsedCount,
      possibleCount: suggestedCount,
      targetCount: matchCount,
      intendedAddCount: matchCount,
      postAddMatchCount: matchCount,
      postAddMatchCountSource: "projected",
    },
    gates: {
      allowMatchRead: true,
      allowCuratedRead: true,
      allowShadowAudit: true,
      allowCuratedWrite: false,
      allowEnrollment: false,
      candidateFacingWritesAllowed: false,
      curationPlanHealthy: true,
      settlementCurationBound: true,
      proofScopeBound: true,
      settlementDecision,
      settlementMatchCount: matchCount,
      settlementAllowsEnrollment: true,
      lateMatchProofHealthy: true,
      lateMatchCurationBound: true,
    },
    lateMatch: {
      detected: false,
      allowSecondEnrollment: false,
      reviewNoteCode: null,
      shouldAddReviewNote: false,
    },
    targetSequenceId,
  };
  return {
    statusKind: "settled",
    audit,
    intendedRouting: {
      targetSequenceId,
      matchCount,
      endorsedCount,
      suggestedCount,
      intendedCuratedAddCount: matchCount,
      postAddMatchCountSource: "projected",
    },
  };
}

test("bootstrap selection is server-derived, complete, and never captures future or previously-read jobs", () => {
  const eligible = Array.from({ length: 17 }, (_, index) => awaitingJob(
    `bot_phase3_${String(index).padStart(3, "0")}`,
  ));
  const selected = selectPhase3ShadowBootstrapJobs([
    ...eligible,
    awaitingJob("bot_future_001", {
      submittedAt: "2026-07-26T01:01:00.000Z",
      matchLegStartedAt: "2026-07-26T01:01:00.000Z",
    }),
    awaitingJob("bot_read_0001", {
      matchCheckedAt: "2026-07-25T00:05:00.000Z",
    }),
    awaitingJob("bot_unverified", {
      submitReadbackVerified: false,
    }),
    awaitingJob("bot_wrongstate", {
      state: "ready_to_submit",
    }),
  ], {
    stageEnabledAt: ANCHOR,
  });
  assert.equal(selected.length, 17);
  assert.deepEqual(
    selected.map((job) => job.id),
    [...eligible].map((job) => job.id).sort(),
  );
});

test("arm accepts no cohort input and returns only aggregate release evidence", async () => {
  const jobs = Array.from({ length: 17 }, (_, index) => awaitingJob(
    `bot_arm_${String(index).padStart(4, "0")}`,
  ));
  let captured = null;
  const result = await armPhase3ShadowRelease({
    now: ANCHOR_MS,
    config: shadowConfig,
    getReleaseImpl: async () => null,
    getCallProofBootstrapImpl: async () => (
      completeCallProofBootstrap(jobs.length)
    ),
    snapshotImpl: async () => ({
      complete: true,
      total: jobs.length,
      fingerprint: FINGERPRINT,
      jobs,
    }),
    createReleaseImpl: async (options) => {
      captured = options;
      return {
        created: true,
        existing: false,
        record: releaseRecord(jobs),
      };
    },
  });
  assert.equal(captured.entries.length, 17);
  assert.equal(captured.commonAnchorAt, ANCHOR);
  assert.equal(result.selected, 17);
  assert.equal(result.snapshotComplete, true);
  assert.match(result.manifestDigest, /^[a-f0-9]{64}$/u);
  const serialized = JSON.stringify(result);
  for (const job of jobs) assert.equal(serialized.includes(job.id), false);
});

test("Phase 3 requires the exact captured read and a canonical non-future enable anchor", async () => {
  assert.equal(phase3ShadowExecutionEnabled(shadowConfig, {
    now: ANCHOR_MS,
  }), true);
  for (const config of [
    { ...shadowConfig, matchReadPinned: false },
    { ...shadowConfig, matchReadProc: "candidateMatching.other" },
    { ...shadowConfig, matchStageEnabledAtMs: null },
    {
      ...shadowConfig,
      matchStageEnabledAtMs: ANCHOR_MS + 1,
    },
  ]) {
    assert.equal(phase3ShadowExecutionEnabled(config, {
      now: ANCHOR_MS,
    }), false);
    await assert.rejects(
      armPhase3ShadowRelease({
        now: ANCHOR_MS,
        config,
        getReleaseImpl: async () => null,
        snapshotImpl: async () => {
          throw new Error("snapshot must not run");
        },
      }),
      { code: "PHASE3_SHADOW_RELEASE_GATES_CLOSED" },
    );
  }
  const existing = releaseRecord([]);
  await assert.rejects(
    armPhase3ShadowRelease({
      now: ANCHOR_MS + 1,
      config: {
        ...shadowConfig,
        matchStageEnabledAtMs: ANCHOR_MS + 1,
      },
      getReleaseImpl: async () => existing,
    }),
    { code: "PHASE3_SHADOW_RELEASE_ANCHOR_CONFLICT" },
  );
});

test("awaiting matches polls under Phase 3 even when every Phase 1 and Phase 2 execution gate is closed", async () => {
  const nextPollAt = "2026-07-26T01:05:00.000Z";
  const job = awaitingJob("bot_phase3_independent", {
    matchLegStartedAt: ANCHOR,
    identity: { candidateUserId: "candidate-independent" },
    phase3Shadow: {
      policyVersion: POLICY_VERSION,
      stageEnabledAt: ANCHOR,
      bootstrap: false,
      nextPollAt,
      complete: false,
      candidateFacingWrites: 0,
      curationWrites: 0,
      enrollments: 0,
    },
  });
  let reads = 0;
  const result = await processAutoJob(job.id, {
    config: {
      ...shadowConfig,
      enabled: false,
      detectEnabled: false,
      prepareEnabled: false,
      autoSubmitApproved: false,
      dryRun: true,
      notBeforeMs: null,
      phase1DeployedAtMs: null,
      resumeWaitEnabled: false,
      resumeSignalConfigured: false,
    },
    now: () => ANCHOR_MS + 10 * 60_000,
    getJobImpl: async () => job,
    refreshMatchesImpl: async (current) => {
      reads++;
      return {
        ...current,
        phase3Shadow: {
          ...current.phase3Shadow,
          complete: true,
          nextPollAt: null,
        },
      };
    },
  });
  assert.equal(reads, 1);
  assert.equal(result.action, "complete");
  assert.equal(result.state, "awaiting_matches");
});

test("release creation is immutable SET-NX against one unchanged complete snapshot", async () => {
  const jobs = [
    awaitingJob("bot_store_phase3_01", { revision: 4 }),
    awaitingJob("bot_store_phase3_02", { revision: 7 }),
  ];
  const entries = manifestEntries(jobs);
  const manifestDigest = phase3ShadowReleaseManifestDigest({
    policyVersion: POLICY_VERSION,
    snapshotFingerprint: FINGERPRINT,
    commonAnchorAt: ANCHOR,
    entries,
  });
  const expected = releaseRecord(jobs);
  let command = null;
  const result = await createPhase3ShadowRelease({
    entries,
    manifestDigest,
    snapshotFingerprint: FINGERPRINT,
    snapshotTotal: jobs.length,
    commonAnchorAt: ANCHOR,
    now: ANCHOR_MS,
  }, {
    kvImpl: async (value) => {
      command = value;
      return [1, JSON.stringify(expected)];
    },
  });
  assert.equal(result.created, true);
  assert.equal(result.record.manifestDigest, manifestDigest);
  assert.equal(command[0], "EVAL");
  assert.match(command[1], /ZCARD/);
  assert.match(command[1], /redis\.sha1hex/);
  assert.match(command[1], /job\.revision/);
  assert.match(command[1], /'SET', KEYS\[1\], proposed, 'NX'/);
  assert.equal(command.includes("paraai:phase3:shadow-release:v1"), true);
});

test("batch claims are capped at five and completion releases retries without substituting rows", async () => {
  const jobs = Array.from({ length: 6 }, (_, index) => awaitingJob(
    `bot_claim_${String(index).padStart(4, "0")}`,
  ));
  const claimed = releaseRecord(jobs, {
    status: "running",
    entryStatus: "pending",
    attempts: 0,
    lease: {
      token: "owner-token",
      until: ANCHOR_MS + 150_000,
      indexes: [1, 2, 3, 4, 5],
    },
  });
  claimed.entries.slice(0, 5).forEach((entry) => {
    entry.status = "claimed";
    entry.attempts = 1;
  });
  let claimCommand = null;
  const claim = await claimPhase3ShadowReleaseBatch({
    now: ANCHOR_MS,
    batchSize: 25,
    ownerToken: "owner-token",
    expectedCommonAnchorAt: ANCHOR,
    expectedPolicyVersion: POLICY_VERSION,
  }, {
    kvImpl: async (command) => {
      claimCommand = command;
      return [1, JSON.stringify(claimed), "3", "0", "0"];
    },
  });
  assert.equal(claim.entries.length, 5);
  assert.equal(claimCommand[4], "paraai:auto:due");
  assert.match(
    claimCommand[1],
    /record\.commonAnchorAt or ''\) ~= ARGV\[7\]/,
  );
  assert.match(claimCommand[1], /lease\['until'\]/);
  assert.doesNotMatch(claimCommand[1], /lease\.until|\buntil\s*=/u);
  assert.match(claimCommand[1], /canonicalRedisTime\(\)/);
  assert.match(
    claimCommand[1],
    /\['until'\] = serverNow \+ tonumber\(ARGV\[6\]\)/,
  );
  assert.equal(claimCommand[11], "150000");

  const completed = {
    ...claimed,
    status: "running",
    lease: undefined,
    entries: claimed.entries.map((entry, index) => ({
      ...entry,
      status: index < 4
        ? "scheduled"
        : index === 4
          ? "pending"
          : entry.status,
    })),
  };
  delete completed.lease;
  let completionCommand = null;
  const result = await completePhase3ShadowReleaseBatch({
    ownerToken: "owner-token",
    manifestDigest: claimed.manifestDigest,
    outcomes: claim.entries.map((entry, index) => ({
      index: entry.index,
      status: index === 4 ? "retry" : "scheduled",
      error: index === 4 ? "job_busy" : "",
    })),
    now: ANCHOR_MS,
  }, {
    kvImpl: async (command) => {
      completionCommand = command;
      return [1, JSON.stringify(completed)];
    },
  });
  assert.equal(result.entries.filter((entry) => entry.status === "scheduled").length, 4);
  assert.equal(result.entries.filter((entry) => entry.status === "pending").length, 2);
  assert.match(completionCommand[1], /entry\.retryAfter/);
  assert.match(completionCommand[1], /canonicalRedisTime\(\)/);
  assert.match(completionCommand[1], /entry\.scheduledAt = serverIso/);
  assert.match(completionCommand[1], /record\.releasedAt = serverIso/);
  assert.doesNotMatch(
    completionCommand[1],
    /entry\.attempts or 0\) >= 3/,
  );
});

test("first admission atomically CAS-writes the anchor and queue while preserving failure metadata", async () => {
  const current = awaitingJob("bot_atomic_phase3", { revision: 6 });
  const release = releaseRecord([current], {
    status: "running",
    entryStatus: "claimed",
    attempts: 1,
    lease: {
      token: "lease-owner",
      until: ANCHOR_MS + 150_000,
      indexes: [1],
    },
  });
  const next = {
    ...current,
    matchLegStartedAt: ANCHOR,
    phase3Shadow: {
      policyVersion: POLICY_VERSION,
      releaseDigest: release.manifestDigest,
      stageEnabledAt: ANCHOR,
      bootstrap: true,
      nextPollAt: "2026-07-26T01:05:00.000Z",
      complete: false,
      candidateFacingWrites: 0,
      curationWrites: 0,
      enrollments: 0,
    },
  };
  let command = null;
  const result = await reanchorAndEnqueuePhase3ShadowJob(
    next,
    current.revision,
    {
      manifestDigest: release.manifestDigest,
      ownerToken: "lease-owner",
      entryIndex: 0,
      commonAnchorAt: ANCHOR,
      dueAt: ANCHOR_MS + 5 * 60_000,
      now: ANCHOR_MS,
    },
    {
      kvImpl: async (value) => {
        command = value;
        return [
          1,
          JSON.stringify({ ...next, revision: 7 }),
          String(ANCHOR_MS + 5 * 60_000),
        ];
      },
    },
  );
  assert.equal(result.admitted, true);
  assert.equal(result.queue.enqueued, true);
  assert.equal(result.job.revision, 7);
  assert.equal(command[0], "EVAL");
  assert.equal(command.includes("paraai:auto:leases"), true);
  assert.equal(command.includes("paraai:auto:lease:bot_atomic_phase3"), true);
  assert.equal(command.includes("paraai:lock:bot_atomic_phase3"), true);
  assert.equal(
    command.includes("paraai:phase3:shadow-jobs:v1"),
    true,
  );
  assert.equal(command[2], 11);
  assert.match(command[1], /current\.submitReadbackVerified ~= true/);
  assert.match(command[1], /redis\.call\('TIME'\)/);
  assert.match(command[1], /lease\['until'\] or 0\) <= serverNow/);
  assert.match(command[1], /currentShadow\.readCount/);
  assert.match(command[1], /old\.attempts/);
  assert.match(command[1], /old\.lastFailure/);
  assert.match(command[1], /redis\.call\('ZADD', KEYS\[4\], ARGV\[7\]/);
  assert.match(command[1], /redis\.call\('ZADD', KEYS\[11\]/);
});

test("admission replay accepts the exact durable marker after the job evolves", async () => {
  const original = awaitingJob("bot_phase3_evolved_replay", {
    revision: 6,
  });
  const release = releaseRecord([original], {
    status: "running",
    entryStatus: "claimed",
    attempts: 2,
    lease: {
      token: "lease-owner",
      until: ANCHOR_MS + 150_000,
      indexes: [1],
    },
  });
  const evolved = {
    ...original,
    revision: 9,
    state: "needs_review",
    matchLegStartedAt: ANCHOR,
    matchCheckedAt: "2026-07-26T01:30:00.000Z",
    phase3Shadow: {
      policyVersion: POLICY_VERSION,
      releaseDigest: release.manifestDigest,
      stageEnabledAt: ANCHOR,
      bootstrap: true,
      observedAt: "2026-07-26T01:30:00.000Z",
      readCount: 6,
      complete: true,
      candidateFacingWrites: 0,
      curationWrites: 0,
      enrollments: 0,
    },
  };
  let command = null;
  const result = await reanchorAndEnqueuePhase3ShadowJob(
    evolved,
    original.revision,
    {
      manifestDigest: release.manifestDigest,
      ownerToken: "lease-owner",
      entryIndex: 0,
      commonAnchorAt: ANCHOR,
      dueAt: ANCHOR_MS + 5 * 60_000,
      now: ANCHOR_MS,
    },
    {
      kvImpl: async (value) => {
        command = value;
        return [2, JSON.stringify(evolved), ""];
      },
    },
  );
  assert.equal(command[0], "EVAL");
  assert.match(command[1], /redis\.call\('ZADD', KEYS\[11\]/);
  assert.equal(result.admitted, true);
  assert.equal(result.replayed, true);
  assert.equal(result.job.state, "needs_review");
  assert.equal(result.job.revision, 9);
});

test("future continuous entries atomically stamp policy state and queue the exact poll", async () => {
  const current = awaitingJob("bot_continuous_atomic", {
    revision: 9,
    matchLegStartedAt: "2026-07-26T02:00:00.000Z",
  });
  const dueAt = "2026-07-26T02:05:00.000Z";
  const next = {
    ...current,
    phase3Shadow: {
      policyVersion: POLICY_VERSION,
      stageEnabledAt: ANCHOR,
      bootstrap: false,
      nextPollAt: dueAt,
      complete: false,
      candidateFacingWrites: 0,
      curationWrites: 0,
      enrollments: 0,
    },
  };
  let command = null;
  const result = await saveAndEnqueuePhase3ShadowJob(
    next,
    current.revision,
    {
      dueAt,
      now: Date.parse("2026-07-26T02:00:01.000Z"),
    },
    {
      kvImpl: async (value) => {
        command = value;
        return [
          1,
          JSON.stringify({ ...next, revision: 10 }),
          String(Date.parse(dueAt)),
        ];
      },
    },
  );
  assert.equal(result.job.revision, 10);
  assert.equal(result.queue.dueAt, Date.parse(dueAt));
  assert.equal(command[0], "EVAL");
  assert.equal(command[2], 7);
  assert.equal(
    command.includes("paraai:phase3:shadow-jobs:v1"),
    true,
  );
  assert.match(command[1], /current\.revision/);
  assert.match(command[1], /shadow\.bootstrap ~= false/);
  assert.match(command[1], /old\.lastFailure/);
  assert.match(command[1], /redis\.call\('ZADD', KEYS\[4\]/);
  assert.match(command[1], /redis\.call\('ZADD', KEYS\[7\]/);
});

test("continuous admission requires all three persisted write fences as exact numeric zero", async () => {
  const current = awaitingJob("bot_continuous_fences", {
    revision: 9,
    matchLegStartedAt: "2026-07-26T02:00:00.000Z",
  });
  const dueAt = "2026-07-26T02:05:00.000Z";
  const base = {
    ...current,
    phase3Shadow: {
      policyVersion: POLICY_VERSION,
      stageEnabledAt: ANCHOR,
      bootstrap: false,
      nextPollAt: dueAt,
      complete: false,
      candidateFacingWrites: 0,
      curationWrites: 0,
      enrollments: 0,
    },
  };
  for (const [field, value] of [
    ["candidateFacingWrites", undefined],
    ["candidateFacingWrites", "0"],
    ["curationWrites", -1],
    ["enrollments", null],
  ]) {
    let called = false;
    await assert.rejects(
      saveAndEnqueuePhase3ShadowJob({
        ...base,
        phase3Shadow: {
          ...base.phase3Shadow,
          [field]: value,
        },
      }, current.revision, { dueAt }, {
        kvImpl: async () => {
          called = true;
          return null;
        },
      }),
      /continuous schedule is invalid/u,
    );
    assert.equal(called, false);
  }
});

test("manual submit and reconciliation transitions use the atomic Phase 3 save boundary", async () => {
  const job = awaitingJob("bot_manual_phase3", {
    revision: 11,
    matchLegStartedAt: "2026-07-26T02:00:00.000Z",
    phase3Shadow: undefined,
  });
  let captured = null;
  const boundary = phase3AwaitingMatchesSaveBoundary({
    config: shadowConfig,
    now: () => Date.parse("2026-07-26T02:00:01.000Z"),
    saveAndEnqueueImpl: async (
      stamped,
      expectedRevision,
      options,
    ) => {
      captured = { stamped, expectedRevision, options };
      return {
        job: { ...stamped, revision: expectedRevision + 1 },
      };
    },
  });
  assert.equal(typeof boundary, "function");
  const stored = await boundary(job, job.revision);
  assert.equal(captured.expectedRevision, 11);
  assert.equal(
    captured.stamped.phase3Shadow.policyVersion,
    POLICY_VERSION,
  );
  assert.equal(captured.stamped.phase3Shadow.bootstrap, false);
  assert.equal(
    captured.options.dueAt,
    "2026-07-26T02:05:00.000Z",
  );
  assert.equal(stored.revision, 12);
});

test("release tick reanchors the exact leased rows and schedules the common +5 minute slot", async () => {
  const jobs = [
    awaitingJob("bot_tick_phase3_01", { revision: 3 }),
    awaitingJob("bot_tick_phase3_02", { revision: 8 }),
  ];
  const claimed = releaseRecord(jobs, {
    status: "running",
    entryStatus: "claimed",
    attempts: 1,
    lease: {
      token: "tick-owner",
      until: ANCHOR_MS + 150_000,
      indexes: [1, 2],
    },
  });
  const admitted = [];
  let outcomes = null;
  const released = releaseRecord(jobs, {
    status: "released",
    entryStatus: "scheduled",
    attempts: 1,
  });
  const result = await runPhase3ShadowReleaseTick({
    config: shadowConfig,
    now: ANCHOR_MS,
    getReleaseImpl: async () => claimed,
    claimImpl: async () => ({
      claimed: true,
      ownerToken: "tick-owner",
      record: claimed,
      entries: claimed.entries.map((entry, index) => ({
        index,
        id: entry.id,
        revision: entry.revision,
      })),
      queue: { queued: 0, due: 0, leased: 0 },
    }),
    getJobImpl: async (id) => jobs.find((job) => job.id === id),
    admitImpl: async (job, revision, options) => {
      admitted.push({ job, revision, options });
      return {
        admitted: true,
        queue: { enqueued: true, duplicate: false },
      };
    },
    completeImpl: async (options) => {
      outcomes = options.outcomes;
      return released;
    },
  });
  assert.equal(admitted.length, 2);
  assert.equal(
    admitted.every((row) => row.job.matchLegStartedAt === ANCHOR),
    true,
  );
  assert.equal(
    admitted.every(
      (row) => row.options.dueAt === ANCHOR_MS + 5 * 60_000,
    ),
    true,
  );
  assert.equal(
    admitted.every(
      (row) => row.job.phase3Shadow.releaseDigest
        === claimed.manifestDigest,
    ),
    true,
  );
  assert.equal(outcomes.every((row) => row.status === "scheduled"), true);
  assert.equal(result.selected, 2);
  assert.equal(JSON.stringify(result).includes(jobs[0].id), false);
});

test("aggregate status uses latest shadow records and cannot leak candidate or role data", async () => {
  const jobs = Array.from({ length: 10 }, (_, index) => {
    const matchCount = index === 0 ? 1 : index === 1 ? 2 : 0;
    const observedAt = new Date(
      ANCHOR_MS + (matchCount === 0 ? 40 : 5) * 60_000,
    ).toISOString();
    const endorsedCount = matchCount > 0 ? 1 : 0;
    const suggestedCount = Math.max(0, matchCount - endorsedCount);
    return awaitingJob(`bot_private_${String(index).padStart(3, "0")}`, {
      candidate: {
        name: `Private Candidate ${index}`,
        email: `private-${index}@example.test`,
      },
      identity: {
        candidateUserId: `candidate-private-${index}`,
      },
      matchLegStartedAt: index < 2
        ? ANCHOR
        : new Date(ANCHOR_MS + index * 60_000).toISOString(),
      phase3Shadow: {
        policyVersion: POLICY_VERSION,
        ...(index < 2 ? {
          releaseDigest: "placeholder",
          stageEnabledAt: ANCHOR,
          bootstrap: true,
        } : {
          stageEnabledAt: ANCHOR,
          bootstrap: false,
        }),
        observedAt,
        observedStatus: "ranked",
        observedStatuses: index === 9
          ? ["vendor-private-token", "RANKED", "PROCESSING", "ranked"]
          : ["ranked"],
        observedStatusKinds: index === 9
          ? ["unknown", "settled"]
          : ["settled"],
        readCount: 1,
        endorsedCount,
        suggestedCount,
        matchCount,
        settlementDecision: matchCount === 0
          ? "zero_settled"
          : "matches_settled",
        complete: true,
        policyMismatch: false,
        nextPollAt: null,
        candidateFacingWrites: 0,
        curationWrites: 0,
        enrollments: 0,
        privateRoleId: `role-private-${index}`,
        ...validShadowEvidence({
          observedAt,
          matchCount,
          endorsedCount,
          suggestedCount,
        }),
        ...(index === 2 ? {
          observedAt: new Date(
            ANCHOR_MS + 24 * 60 * 60_000,
          ).toISOString(),
          zeroBaselineObservedAt: observedAt,
          lateMatchMode: true,
          complete: false,
          nextPollAt: new Date(
            ANCHOR_MS + (24 * 60 + 2) * 60_000,
          ).toISOString(),
        } : {}),
      },
    });
  });
  jobs.push(awaitingJob("bot_private_timeout", {
    candidate: {
      name: "Private Timeout Candidate",
      email: "private-timeout@example.test",
    },
    identity: {
      candidateUserId: "candidate-private-timeout",
    },
    matchLegStartedAt: new Date(ANCHOR_MS + 10 * 60_000).toISOString(),
    state: "needs_review",
    phase3Shadow: {
      policyVersion: POLICY_VERSION,
      stageEnabledAt: ANCHOR,
      bootstrap: false,
      observedAt: new Date(
        ANCHOR_MS + 24 * 60 * 60_000,
      ).toISOString(),
      observedStatus: "ranking",
      observedStatuses: ["ranking"],
      observedStatusKinds: ["unknown"],
      statusKind: "unknown",
      readCount: 4,
      endorsedCount: 0,
      suggestedCount: 0,
      matchCount: null,
      settlementDecision: "timeout",
      complete: true,
      policyMismatch: false,
      nextPollAt: null,
      candidateFacingWrites: 0,
      curationWrites: 0,
      enrollments: 0,
    },
  }));
  jobs.push(awaitingJob("bot_private_call_conflict", {
    candidate: {
      name: "Private Conflict Candidate",
      email: "private-conflict@example.test",
    },
    identity: {
      candidateUserId: "candidate-private-conflict",
    },
    matchLegStartedAt: new Date(ANCHOR_MS + 11 * 60_000).toISOString(),
    state: "needs_review",
    phase3Shadow: {
      policyVersion: POLICY_VERSION,
      stageEnabledAt: ANCHOR,
      bootstrap: false,
      complete: true,
      nextPollAt: null,
      policyMismatch: false,
      callProofConflict: true,
      technicalFailure: true,
      technicalFailureCode: "PHASE3_CALL_PROOF_CONFLICT",
      candidateFacingWrites: 0,
      curationWrites: 0,
      enrollments: 0,
    },
  }));
  const release = releaseRecord(jobs.slice(0, 2), {
    status: "released",
    entryStatus: "scheduled",
    attempts: 1,
  });
  for (const job of jobs.slice(0, 2)) {
    job.phase3Shadow.releaseDigest = release.manifestDigest;
  }
  const result = await phase3ShadowReleaseStatus({
    config: shadowConfig,
    getReleaseImpl: async () => release,
    getCallProofBootstrapImpl: async () => (
      completeCallProofBootstrap(jobs.length)
    ),
    snapshotImpl: async () => completePhase3ShadowSnapshot(jobs),
    queueStatsImpl: async () => ({ queued: 0, due: 0, leased: 0 }),
    now: ANCHOR_MS + 54 * 60 * 60_000,
  });
  assert.equal(result.reanchored, 2);
  assert.equal(result.decisions, 10);
  assert.equal(result.uniqueCandidates, 10);
  assert.equal(result.bootstrapDecisions, 2);
  assert.equal(result.organicDecisions, 8);
  assert.equal(result.matchReads, 14);
  assert.equal(result.queued, 1);
  assert.equal(result.observedStatuses.ranked, 10);
  assert.equal(result.observedStatuses.unknown, 2);
  assert.equal(result.timedOut, 1);
  assert.equal(result.technicalFailures, 2);
  assert.equal(result.hardTechnicalFailures, 0);
  assert.equal(result.policyMismatches, 0);
  assert.equal(result.candidateFacingWrites, 0);
  assert.equal(result.curationWrites, 0);
  assert.equal(result.enrollments, 0);
  assert.equal(result.releaseFenceIntact, true);
  assert.equal(result.shadowFenceIntact, true);
  assert.equal(result.verificationReady, true);
  assert.equal(result.ok, true);
  assert.equal(result.callProofScope, "durable_pipeline_jobs");
  assert.equal(result.sourceWatermarkComplete, false);
  assert.equal(result.phase4Q37Ready, false);
  assert.equal(
    result.firstAuditAt,
    new Date(ANCHOR_MS + 5 * 60_000).toISOString(),
  );
  assert.equal(
    result.lastAuditAt,
    new Date(ANCHOR_MS + 40 * 60_000).toISOString(),
  );
  assert.equal(result.curationEvidence, "projected");
  const serialized = JSON.stringify(result);
  for (const job of jobs) {
    assert.equal(serialized.includes(job.id), false);
    assert.equal(serialized.includes(job.candidate.email), false);
    assert.equal(
      serialized.includes(job.phase3Shadow.privateRoleId),
      false,
    );
  }
  assert.equal(serialized.includes("vendor-private-token"), false);
});

test("aggregate rejects pre-anchor, early-zero, and post-timeout audits", async () => {
  const cases = [
    {
      observedAt: new Date(ANCHOR_MS - 1).toISOString(),
      matchCount: 1,
    },
    {
      observedAt: new Date(ANCHOR_MS + 29 * 60_000).toISOString(),
      matchCount: 0,
    },
    {
      observedAt: new Date(
        ANCHOR_MS + 24 * 60 * 60_000 + 1,
      ).toISOString(),
      matchCount: 1,
    },
  ];
  const jobs = cases.map((fixture, index) => {
    const endorsedCount = fixture.matchCount > 0 ? 1 : 0;
    return awaitingJob(`bot_bad_audit_${index}`, {
      identity: {
        candidateUserId: `candidate-bad-audit-${index}`,
      },
      matchLegStartedAt: ANCHOR,
      phase3Shadow: {
        policyVersion: POLICY_VERSION,
        stageEnabledAt: ANCHOR,
        bootstrap: true,
        observedAt: fixture.observedAt,
        observedStatus: "ranked",
        observedStatusKinds: ["settled"],
        readCount: 1,
        endorsedCount,
        suggestedCount: 0,
        matchCount: fixture.matchCount,
        settlementDecision: fixture.matchCount === 0
          ? "zero_settled"
          : "matches_settled",
        complete: true,
        policyMismatch: false,
        candidateFacingWrites: 0,
        curationWrites: 0,
        enrollments: 0,
        ...validShadowEvidence({
          observedAt: fixture.observedAt,
          matchCount: fixture.matchCount,
          endorsedCount,
          suggestedCount: 0,
        }),
      },
    });
  });
  const release = releaseRecord(jobs, {
    status: "released",
    entryStatus: "scheduled",
    attempts: 1,
  });
  for (const job of jobs) {
    job.phase3Shadow.releaseDigest = release.manifestDigest;
  }

  const result = await phase3ShadowReleaseStatus({
    config: shadowConfig,
    getReleaseImpl: async () => release,
    getCallProofBootstrapImpl: async () => (
      completeCallProofBootstrap(jobs.length)
    ),
    snapshotImpl: async () => completePhase3ShadowSnapshot(jobs),
    queueStatsImpl: async () => ({ queued: 0, due: 0, leased: 0 }),
    now: ANCHOR_MS + 54 * 60 * 60_000,
  });

  assert.equal(result.decisions, 0);
  assert.equal(result.invalidAudits, 3);
  assert.equal(result.policyMismatches, 3);
  assert.equal(result.verificationReady, false);
});

test("aggregate rejects every absent, malformed, or nonzero persisted write counter", async () => {
  const observedAt = new Date(
    ANCHOR_MS + 40 * 60_000,
  ).toISOString();
  const fields = [
    "candidateFacingWrites",
    "curationWrites",
    "enrollments",
  ];
  const variants = [
    { name: "absent", value: undefined },
    { name: "negative", value: -1 },
    { name: "string", value: "0" },
    { name: "nonzero", value: 1 },
  ];
  const jobs = fields.flatMap((field, fieldIndex) => (
    variants.map((variant, variantIndex) => {
      const job = awaitingJob(
        `bot_counter_${fieldIndex}_${variantIndex}`,
        {
          identity: {
            candidateId:
              `candidate-counter-${fieldIndex}-${variantIndex}`,
          },
          matchLegStartedAt: ANCHOR,
          phase3Shadow: {
            policyVersion: POLICY_VERSION,
            stageEnabledAt: ANCHOR,
            bootstrap: true,
            observedAt,
            observedStatus: "ranked",
            observedStatusKinds: ["settled"],
            readCount: 1,
            endorsedCount: 0,
            suggestedCount: 0,
            matchCount: 0,
            settlementDecision: "zero_settled",
            complete: true,
            policyMismatch: false,
            candidateFacingWrites: 0,
            curationWrites: 0,
            enrollments: 0,
            ...validShadowEvidence({
              observedAt,
              matchCount: 0,
              endorsedCount: 0,
              suggestedCount: 0,
            }),
          },
        },
      );
      if (variant.name === "absent") {
        delete job.phase3Shadow[field];
      } else {
        job.phase3Shadow[field] = variant.value;
      }
      return job;
    })
  ));
  const release = releaseRecord(jobs, {
    status: "released",
    entryStatus: "scheduled",
    attempts: 1,
  });
  for (const job of jobs) {
    job.phase3Shadow.releaseDigest = release.manifestDigest;
  }

  const result = await phase3ShadowReleaseStatus({
    config: shadowConfig,
    getReleaseImpl: async () => release,
    getCallProofBootstrapImpl: async () => (
      completeCallProofBootstrap(jobs.length)
    ),
    snapshotImpl: async () => completePhase3ShadowSnapshot(jobs),
    queueStatsImpl: async () => ({ queued: 0, due: 0, leased: 0 }),
    now: ANCHOR_MS + 54 * 60 * 60_000,
  });

  assert.equal(result.decisions, 0);
  assert.equal(result.invalidAudits, jobs.length);
  assert.equal(result.policyMismatches, jobs.length);
  assert.equal(result.candidateFacingWrites, variants.length);
  assert.equal(result.curationWrites, variants.length);
  assert.equal(result.enrollments, variants.length);
  assert.equal(result.shadowFenceIntact, false);
  assert.equal(result.verificationReady, false);
  assert.equal(result.ok, false);
});

test("late-match audit rejects stale zero-route counts even with review fences", async () => {
  const observedAt = new Date(
    ANCHOR_MS + 4 * 60 * 60_000,
  ).toISOString();
  const evidence = validShadowEvidence({
    observedAt,
    matchCount: 1,
    endorsedCount: 1,
    suggestedCount: 0,
  });
  evidence.audit.lateMatch = {
    detected: true,
    allowSecondEnrollment: false,
    reviewNoteCode: LATE_MATCH_REVIEW_NOTE_CODE,
    shouldAddReviewNote: true,
  };
  evidence.intendedRouting = {
    targetSequenceId: "cmqpje4lh00040cki15nuuqc8",
    matchCount: 0,
    endorsedCount: 0,
    suggestedCount: 0,
    intendedCuratedAddCount: 0,
    postAddMatchCountSource: "projected",
    enrollmentAction: "none",
    lateMatchReview: true,
    reviewNoteCode: LATE_MATCH_REVIEW_NOTE_CODE,
    allowSecondEnrollment: false,
  };
  const job = awaitingJob("bot_late_stale_route", {
    identity: {
      candidateUserId: "candidate-late-stale-route",
    },
    matchLegStartedAt: ANCHOR,
    phase3Shadow: {
      policyVersion: POLICY_VERSION,
      stageEnabledAt: ANCHOR,
      bootstrap: true,
      observedAt,
      observedStatus: "ranked",
      observedStatusKinds: ["settled"],
      statusKind: "settled",
      readCount: 2,
      endorsedCount: 1,
      suggestedCount: 0,
      matchCount: 1,
      settlementDecision: "matches_settled",
      complete: true,
      policyMismatch: false,
      lateMatchDetected: true,
      candidateFacingWrites: 0,
      curationWrites: 0,
      enrollments: 0,
      ...evidence,
    },
  });
  const release = releaseRecord([job], {
    status: "released",
    entryStatus: "scheduled",
    attempts: 1,
  });
  job.phase3Shadow.releaseDigest = release.manifestDigest;

  const result = await phase3ShadowReleaseStatus({
    config: shadowConfig,
    getReleaseImpl: async () => release,
    getCallProofBootstrapImpl: async () => (
      completeCallProofBootstrap(1)
    ),
    snapshotImpl: async () => completePhase3ShadowSnapshot([job]),
    queueStatsImpl: async () => ({ queued: 0, due: 0, leased: 0 }),
    now: ANCHOR_MS + 54 * 60 * 60_000,
  });

  assert.equal(result.decisions, 0);
  assert.equal(result.invalidAudits, 1);
  assert.equal(result.policyMismatches, 1);
});

test("dedicated status ignores 600 unrelated global jobs and repeated candidates cannot satisfy verification", async () => {
  const repeated = Array.from({ length: 10 }, (_, index) => awaitingJob(
    `bot_repeat_${String(index).padStart(3, "0")}`,
    {
      identity: {
        candidateId: "candidate-primary-shared",
        candidateUserId: `candidate-user-${index}`,
      },
      matchLegStartedAt: index === 0
        ? ANCHOR
        : new Date(ANCHOR_MS + index * 60_000).toISOString(),
      phase3Shadow: {
        policyVersion: POLICY_VERSION,
        stageEnabledAt: ANCHOR,
        bootstrap: index === 0,
        observedAt: new Date(
          ANCHOR_MS + 40 * 60_000,
        ).toISOString(),
        observedStatus: "ranked",
        readCount: 1,
        endorsedCount: 0,
        suggestedCount: 0,
        matchCount: 0,
        settlementDecision: "zero_settled",
        complete: true,
        policyMismatch: false,
        candidateFacingWrites: 0,
        curationWrites: 0,
        enrollments: 0,
        ...validShadowEvidence({
          observedAt: new Date(
            ANCHOR_MS + 40 * 60_000,
          ).toISOString(),
          matchCount: 0,
          endorsedCount: 0,
          suggestedCount: 0,
        }),
      },
    },
  ));
  const release = releaseRecord(repeated.slice(0, 1), {
    status: "released",
    entryStatus: "scheduled",
    attempts: 1,
  });
  repeated[0].phase3Shadow.releaseDigest = release.manifestDigest;
  const unrelatedGlobalJobs = Array.from(
    { length: 600 },
    (_, index) => `global-job-${index}`,
  );
  const result = await phase3ShadowReleaseStatus({
    config: shadowConfig,
    getReleaseImpl: async () => release,
    getCallProofBootstrapImpl: async () => (
      completeCallProofBootstrap(repeated.length)
    ),
    snapshotImpl: async () => {
      assert.equal(unrelatedGlobalJobs.length >= 500, true);
      return completePhase3ShadowSnapshot(repeated);
    },
    queueStatsImpl: async () => ({ queued: 0, due: 0, leased: 0 }),
    now: ANCHOR_MS + 60 * 60 * 60_000,
  });
  const auto = readFileSync(
    new URL("../api/paraai/_lib/auto.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    auto,
    /snapshotImpl = getCompletePhase3ShadowSnapshot/,
  );
  assert.equal(result.decisions, 10);
  assert.equal(result.uniqueCandidates, 1);
  assert.equal(result.matchReads, 10);
  assert.equal(result.candidateFacingWrites, 0);
  assert.equal(result.releaseFenceIntact, true);
  assert.equal(result.verificationReady, false);
});

test("dedicated status fails closed when an obsolete policy row remains indexed", async () => {
  const current = awaitingJob("bot_current_indexed", {
    phase3Shadow: {
      policyVersion: POLICY_VERSION,
    },
  });
  const release = releaseRecord([current], {
    status: "released",
    entryStatus: "scheduled",
    attempts: 1,
  });
  const result = await phase3ShadowReleaseStatus({
    config: shadowConfig,
    getReleaseImpl: async () => release,
    getCallProofBootstrapImpl: async () => (
      completeCallProofBootstrap(2)
    ),
    snapshotImpl: async () => completePhase3ShadowSnapshot([current], {
      snapshotComplete: false,
      total: 2,
      invalid: 1,
    }),
    queueStatsImpl: async () => ({ queued: 0, due: 0, leased: 0 }),
    now: ANCHOR_MS + 60 * 60 * 60_000,
  });

  assert.equal(result.status, "snapshot_incomplete");
  assert.equal(result.decisions, 0);
  assert.equal(result.hardTechnicalFailures >= 1, true);
  assert.equal(result.releaseFenceIntact, false);
  assert.equal(result.verificationReady, false);
});

test("worker exposes runner-only mode-only Phase 3 routes and forwards exact dueAt", () => {
  const worker = readFileSync(
    new URL("../api/paraai/worker.mjs", import.meta.url),
    "utf8",
  );
  const auto = readFileSync(
    new URL("../api/paraai/_lib/auto.mjs", import.meta.url),
    "utf8",
  );
  assert.match(worker, /"phase3-shadow-arm"/);
  assert.match(worker, /"phase3-shadow-status"/);
  assert.match(
    worker,
    /\["phase3-shadow-arm", new Set\(\["mode"\]\)\]/,
  );
  assert.match(
    worker,
    /\["phase3-shadow-status", new Set\(\["mode"\]\)\]/,
  );
  assert.match(worker, /phase3Modes\.has\(mode\)/);
  assert.match(worker, /runner_key_required/);
  assert.match(auto, /dueAt: result\.dueAt/);
  assert.match(
    auto,
    /job\?\.state === "awaiting_matches"[\s\S]*processPhase3ShadowAutoJob/,
  );
});

test("worker escalation ignores benign timeout/conflict counts but catches hard failures", () => {
  const status = {
    status: "shadow_verified",
    timedOut: 3,
    technicalFailures: 4,
    hardTechnicalFailures: 0,
    candidateFacingWrites: 0,
    curationWrites: 0,
    enrollments: 0,
    policyMismatches: 0,
    invalidAudits: 0,
    releaseReview: 0,
    missing: 0,
    shadowFenceIntact: true,
  };
  const benign = phase3AggregateAuditFailure(status);
  assert.deepEqual(benign, {
    checked: true,
    reason: null,
  });

  assert.deepEqual(phase3AggregateAuditFailure({
    ...status,
    status: "shadow_running",
    hardTechnicalFailures: 1,
  }), {
    checked: true,
    reason: "hard_technical_failure",
  });
});

test("a 17-row multi-batch release cannot escalate before cohort admission completes", async () => {
  const batches = [
    { status: "armed", pendingRelease: 17, claimed: 0, released: 0 },
    {
      status: "snapshot_incomplete",
      pendingRelease: 12,
      claimed: 5,
      released: 0,
    },
    {
      status: "snapshot_incomplete",
      pendingRelease: 12,
      claimed: 0,
      released: 5,
    },
    {
      status: "snapshot_incomplete",
      pendingRelease: 7,
      claimed: 5,
      released: 5,
    },
    {
      status: "snapshot_incomplete",
      pendingRelease: 2,
      claimed: 5,
      released: 10,
    },
    {
      status: "snapshot_incomplete",
      pendingRelease: 0,
      claimed: 2,
      released: 15,
    },
  ].map((releaseState) => ({
    ...releaseState,
    selected: 17,
    missing: releaseState.pendingRelease + releaseState.claimed,
    policyMismatches: 0,
    invalidAudits: 0,
    hardTechnicalFailures: 0,
    candidateFacingWrites: 0,
    curationWrites: 0,
    enrollments: 0,
    releaseReview: 0,
    shadowFenceIntact: true,
  }));
  let recorded = 0;
  for (const status of batches) {
    assert.deepEqual(phase3AggregateAuditFailure(status), {
      checked: false,
      reason: null,
    });
    const result = await phase3ShadowStatusWithEscalation({
      statusImpl: async () => status,
      recordImpl: async () => {
        recorded += 1;
        throw new Error("pre-release audit must not be recorded");
      },
    });
    assert.equal(result.auditHealthRecorded, undefined);
  }
  assert.equal(recorded, 0);

  assert.deepEqual(phase3AggregateAuditFailure({
    ...batches.at(-1),
    status: "snapshot_incomplete",
    pendingRelease: 0,
    claimed: 0,
    released: 17,
    missing: 1,
  }), {
    checked: true,
    reason: "missing_release_job",
  });
});

test("aggregate failure streak deduplicates same-bucket queue drift", async () => {
  const commands = [];
  const kvImpl = async (command) => {
    commands.push(command);
    return [1, JSON.stringify({
      version: 1,
      failing: true,
      failureStreak: 1,
      lastReason: "policy_mismatch",
      lastCheckedAtMs: ANCHOR_MS,
    })];
  };
  const safetyStatus = {
    status: "shadow_running",
    policyMismatches: 1,
    invalidAudits: 0,
    hardTechnicalFailures: 0,
    candidateFacingWrites: 0,
    curationWrites: 0,
    enrollments: 0,
    releaseReview: 0,
    missing: 0,
    shadowFenceIntact: true,
    queue: { queued: 1, due: 0, leased: 0 },
    pending: 4,
  };
  const stableSafetyDigest = phase3AggregateSafetyDigest(
    safetyStatus,
  );
  const queueDriftSafetyDigest = phase3AggregateSafetyDigest({
    ...safetyStatus,
    queue: { queued: 9, due: 7, leased: 2 },
    pending: 3,
  });
  assert.equal(queueDriftSafetyDigest, stableSafetyDigest);
  assert.notEqual(
    phase3AggregateSafetyDigest({
      ...safetyStatus,
      policyMismatches: 2,
    }),
    stableSafetyDigest,
  );
  const input = {
    failed: true,
    reason: "policy_mismatch",
    manifestDigest: "b".repeat(64),
    evidenceAt: new Date(ANCHOR_MS + 5 * 60_000).toISOString(),
    readCount: 10,
    decisions: 10,
    safetyDigest: stableSafetyDigest,
  };

  await recordPhase3ShadowAggregateAuditResult(input, { kvImpl });
  await recordPhase3ShadowAggregateAuditResult({
    ...input,
    safetyDigest: queueDriftSafetyDigest,
  }, { kvImpl });
  await recordPhase3ShadowAggregateAuditResult({
    ...input,
    readCount: 11,
  }, { kvImpl });

  assert.equal(commands.length, 3);
  assert.match(commands[0][10], /^[a-f0-9]{64}$/u);
  assert.equal(commands[0][10], commands[1][10]);
  assert.notEqual(commands[1][10], commands[2][10]);
  assert.match(
    commands[0][1],
    /readCount == priorReads[\s\S]*decisions < priorDecisions/,
  );
  assert.match(commands[0][1], /math\.floor\(checkedAtMs \/ 300000\)/);
  assert.match(
    commands[0][1],
    /record\.lastAppliedCheckToken == appliedToken/,
  );
  assert.equal(
    JSON.stringify(commands).includes("candidate-private"),
    false,
  );
});

test("aggregate streak applies one check per bucket and clean evidence reapplies after an exception", async () => {
  let redisNow = ANCHOR_MS;
  let durable = {
    version: 1,
    failureStreak: 0,
    failing: false,
    lastNormalEvidenceAtMs: -1,
    lastNormalReadCount: -1,
    lastNormalDecisions: -1,
    lastCheckedAtMs: redisNow,
  };
  const kvImpl = async (command) => {
    const failed = command[4] === "1";
    const reason = command[5];
    const manifestDigest = command[6];
    const evidenceAtMs = Number(command[7]);
    const readCount = Number(command[8]);
    const decisions = Number(command[9]);
    const evidenceToken = command[10];
    const exception = command[11] === "1";
    const bucket = Math.floor(redisNow / 300_000);
    const appliedToken = exception
      ? `exception:${reason}:${bucket}`
      : `normal:${evidenceToken}:${bucket}`;
    if (durable.lastAppliedCheckToken === appliedToken) {
      return [0, JSON.stringify(durable)];
    }
    if (!exception) {
      if (durable.manifestDigest === manifestDigest) {
        const stale = (
          evidenceAtMs < durable.lastNormalEvidenceAtMs
          || (
            evidenceAtMs === durable.lastNormalEvidenceAtMs
            && readCount < durable.lastNormalReadCount
          )
          || (
            evidenceAtMs === durable.lastNormalEvidenceAtMs
            && readCount === durable.lastNormalReadCount
            && decisions < durable.lastNormalDecisions
          )
        );
        if (stale) return [0, JSON.stringify(durable)];
      } else {
        durable.failureStreak = 0;
        durable.failing = false;
      }
      durable.manifestDigest = manifestDigest;
      durable.lastNormalEvidenceAtMs = evidenceAtMs;
      durable.lastNormalReadCount = readCount;
      durable.lastNormalDecisions = decisions;
    }
    durable.lastAppliedCheckToken = appliedToken;
    durable.lastAppliedCheckKind = exception ? "exception" : "normal";
    if (failed) {
      durable.failureStreak = durable.failing
        ? durable.failureStreak + 1
        : 1;
      durable.failing = true;
      durable.lastReason = reason;
    } else {
      durable.failureStreak = 0;
      durable.failing = false;
      delete durable.lastReason;
    }
    durable.lastCheckedAtMs = redisNow;
    return [1, JSON.stringify(durable)];
  };
  const base = {
    manifestDigest: "d".repeat(64),
    evidenceAt: new Date(ANCHOR_MS).toISOString(),
    readCount: 4,
    decisions: 4,
  };
  const failedInput = {
    ...base,
    failed: true,
    reason: "policy_mismatch",
    safetyDigest: "e".repeat(64),
  };
  const first = await recordPhase3ShadowAggregateAuditResult(
    failedInput,
    { kvImpl },
  );
  const duplicate = await recordPhase3ShadowAggregateAuditResult(
    failedInput,
    { kvImpl },
  );
  assert.equal(first.failureStreak, 1);
  assert.equal(duplicate.updated, false);

  redisNow += 5 * 60_000;
  const consecutive = await recordPhase3ShadowAggregateAuditResult(
    failedInput,
    { kvImpl },
  );
  assert.equal(consecutive.failureStreak, 2);
  assert.equal(consecutive.shouldAlert, true);

  const cleanInput = {
    ...base,
    failed: false,
    reason: "clean",
    safetyDigest: "f".repeat(64),
  };
  const clean = await recordPhase3ShadowAggregateAuditResult(
    cleanInput,
    { kvImpl },
  );
  assert.equal(clean.failureStreak, 0);
  assert.equal(clean.failing, false);

  const exception = await recordPhase3ShadowAggregateAuditResult({
    failed: true,
    reason: "status_check_failed",
    exception: true,
  }, { kvImpl });
  assert.equal(exception.failureStreak, 1);
  const cleanAgain = await recordPhase3ShadowAggregateAuditResult(
    cleanInput,
    { kvImpl },
  );
  assert.equal(cleanAgain.updated, true);
  assert.equal(cleanAgain.failureStreak, 0);
  const duplicateClean = await recordPhase3ShadowAggregateAuditResult(
    cleanInput,
    { kvImpl },
  );
  assert.equal(duplicateClean.updated, false);

  const changedFailure = await recordPhase3ShadowAggregateAuditResult({
    ...failedInput,
    reason: "invalid_audit",
    safetyDigest: "1".repeat(64),
  }, { kvImpl });
  assert.equal(changedFailure.updated, true);
  assert.equal(changedFailure.failureStreak, 1);
});
