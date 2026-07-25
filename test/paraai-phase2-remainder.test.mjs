import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  armPhase2RemainderRelease,
  enqueueBackfill,
  phase2RemainderReleaseStatus,
  runPhase2RemainderTick,
  selectPhase2RemainderJobs,
} from "../api/paraai/_lib/auto.mjs";
import {
  authorizeAndEnqueuePhase2RemainderJob,
  claimPhase2RemainderBatch,
  completePhase2RemainderBatch,
  createPhase2RemainderPlan,
  enqueuePhase2RemainderAutoJob,
  getPhase2RemainderRelease,
  phase2CanaryManifestDigest,
  phase2RemainderAttestationDigest,
  phase2RemainderManifestDigest,
} from "../api/paraai/_lib/store.mjs";
import { runAutomationCycle } from "../api/paraai/worker.mjs";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const COMMON_ANCHOR = "2026-07-25T11:00:00.000Z";
const SNAPSHOT_FINGERPRINT = "a".repeat(40);
const CANARY_IDS = Array.from(
  { length: 10 },
  (_, index) => `bot_canary_${String(index).padStart(4, "0")}`,
);
const CANARY_DIGEST = phase2CanaryManifestDigest(CANARY_IDS);
const REMAINDER_CONFIG = {
  enabled: true,
  detectEnabled: true,
  prepareEnabled: true,
  autoSubmitApproved: true,
  dryRun: false,
  notBeforeMs: Date.parse("2026-07-15T00:00:00.000Z"),
  phase1DeployedAtMs: Date.parse("2026-07-15T00:00:00.000Z"),
  organicExceptionBotIds: new Set(),
  resumeWaitEnabled: true,
  resumeSignalConfigured: true,
  resumeWaitMinutes: 60,
  resumeRetryDays: 7,
  resumeTerminalAckHours: 24,
  resumeBackfillTerminalAckDays: 21,
  workerBatch: 99,
};

function frozenJob(id, {
  candidateUserId = `candidate-${id}`,
  resumeReady = true,
  createdAt = "2026-07-01T00:00:00.000Z",
  revision = 2,
  ...overrides
} = {}) {
  const base = {
    id,
    revision,
    createdAt,
    state: "needs_review",
    extracted: { roleTypes: ["sales"] },
    identity: {
      candidateUserId,
      name: "Private Candidate",
    },
    submission: {
      name: "Private Candidate",
      email: "private@example.test",
      linkedinUrl: "https://www.linkedin.com/in/private-candidate",
      resumeUri: resumeReady ? "s3://private/resume.pdf" : "",
      resumeStatus: resumeReady ? "attached" : "missing",
    },
    automation: {
      mode: "backfill_only",
      freezeReason: "job predates the Phase 1 deployment",
    },
    reviewReason: "no_resume_phase1",
    reviewReasons: [{
      code: "no_resume_phase1",
      message: "no resume on profile (resume-wait ships Phase 2)",
      soft: false,
    }],
    journal: [],
  };
  return {
    ...base,
    ...overrides,
    identity: { ...base.identity, ...(overrides.identity || {}) },
    submission: { ...base.submission, ...(overrides.submission || {}) },
    automation: { ...base.automation, ...(overrides.automation || {}) },
  };
}

function verifiedCanaryStatus(overrides = {}) {
  return {
    ok: true,
    verified: true,
    selected: 10,
    authorized: 10,
    preferencesRouted: 10,
    payloadHashVerified: 10,
    submitAttemptStarted: 10,
    submitAccepted: 10,
    talentNetworkVisible: 10,
    preexistingVisible: 0,
    waitingForResume: 0,
    needsReview: 0,
    errors: 0,
    missing: 0,
    authorizedDelta: 10,
    releaseFenceIntact: true,
    ...overrides,
  };
}

function immutableVerification(overrides = {}) {
  return {
    canaryManifestDigest: CANARY_DIGEST,
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    commonAnchorAt: COMMON_ANCHOR,
    verified: true,
    selected: 10,
    authorized: 10,
    preferencesRouted: 10,
    payloadHashVerified: 10,
    submitAttemptStarted: 10,
    submitAccepted: 10,
    talentNetworkVisible: 10,
    preexistingVisible: 0,
    waitingForResume: 0,
    needsReview: 0,
    errors: 0,
    missing: 0,
    authorizedDelta: 10,
    releaseFenceIntact: true,
    ...overrides,
  };
}

function releaseRecord(
  rows,
  {
    status = "armed",
    lease = null,
    snapshotTotal = rows.length + 10,
    excludedReviewCount = 0,
    verification = immutableVerification(),
    extra = {},
  } = {},
) {
  const entries = rows.map((row) => ({
    id: String(row.id),
    revision: Number(row.revision ?? 2),
    resumeReady: row.resumeReady !== false,
    status: String(row.status || "pending"),
    attempts: Number(row.attempts ?? 0),
    ...(row.lastError ? { lastError: row.lastError } : {}),
  }));
  const manifestDigest = phase2RemainderManifestDigest({
    canaryManifestDigest: CANARY_DIGEST,
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    commonAnchorAt: COMMON_ANCHOR,
    entries,
  });
  return {
    version: 1,
    status,
    canaryManifestDigest: CANARY_DIGEST,
    canaryVerification: verification,
    canaryVerificationDigest:
      phase2RemainderAttestationDigest(verification),
    manifestDigest,
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    snapshotTotal,
    commonAnchorAt: COMMON_ANCHOR,
    count: entries.length,
    entries,
    resumeReadyCount:
      entries.filter((entry) => entry.resumeReady).length,
    resumeMissingCount:
      entries.filter((entry) => !entry.resumeReady).length,
    excludedReviewCount,
    batchOrdinal: 0,
    lease,
    armedAt: new Date(NOW).toISOString(),
    ...extra,
  };
}

function canarySnapshot(extraJobs = []) {
  const canaryJobs = CANARY_IDS.map((id, index) => ({
    id,
    revision: 10 + index,
    identity: { candidateUserId: `canary-candidate-${index}` },
    automation: {
      mode: "authorized_backfill",
      canaryManifestDigest: CANARY_DIGEST,
      backfillBatchEntryAt: COMMON_ANCHOR,
      resumeWait: {
        source: "authorized_backfill",
        enteredAt: COMMON_ANCHOR,
      },
    },
  }));
  const jobs = [...canaryJobs, ...extraJobs];
  return {
    complete: true,
    total: jobs.length,
    fingerprint: SNAPSHOT_FINGERPRINT,
    jobs,
  };
}

test("Q7 remainder selection keeps every eligible call job, including repeated candidates", () => {
  const sameCandidate = "candidate-returning-001";
  const ready = frozenJob("bot_q7_ready_01", {
    candidateUserId: sameCandidate,
  });
  const missing = frozenJob("bot_q7_missing1", {
    candidateUserId: sameCandidate,
    resumeReady: false,
    createdAt: "2026-07-01T00:01:00.000Z",
  });
  const sameAsCanaryCandidate = frozenJob("bot_q7_return01", {
    candidateUserId: "canary-candidate-0",
    createdAt: "2026-07-01T00:02:00.000Z",
  });
  const review = frozenJob("bot_q7_review01", {
    reviewReason: "sponsorship",
    reviewReasons: [{
      code: "sponsorship",
      message: "Sponsorship requires review",
      soft: false,
    }],
  });
  const selected = selectPhase2RemainderJobs(
    [
      frozenJob(CANARY_IDS[0], { candidateUserId: sameCandidate }),
      ready,
      missing,
      sameAsCanaryCandidate,
      review,
    ],
    {
      config: REMAINDER_CONFIG,
      canaryJobIds: new Set(CANARY_IDS),
    },
  );

  assert.deepEqual(
    new Set(selected.map((job) => job.id)),
    new Set([ready.id, missing.id, sameAsCanaryCandidate.id]),
  );
  assert.equal(
    selected.filter(
      (job) => job.identity.candidateUserId === sameCandidate,
    ).length,
    2,
  );
  assert.equal(
    selected.some((job) => job.id === review.id),
    false,
  );
  assert.equal(
    selected.some((job) => job.id === CANARY_IDS[0]),
    false,
  );
});

test("arm requires verified first-ten evidence and persists its immutable attestation", async () => {
  const sameCandidate = "candidate-returning-002";
  const remainder = [
    frozenJob("bot_arm_ready01", { candidateUserId: sameCandidate }),
    frozenJob("bot_arm_missing1", {
      candidateUserId: sameCandidate,
      resumeReady: false,
    }),
    frozenJob("bot_arm_return01", {
      candidateUserId: "canary-candidate-0",
    }),
    frozenJob("bot_arm_review01", {
      reviewReason: "sponsorship",
      reviewReasons: [{
        code: "sponsorship",
        message: "Sponsorship requires review",
        soft: false,
      }],
    }),
  ];
  const snapshot = canarySnapshot(remainder);
  const canary = {
    status: "complete",
    manifestDigest: CANARY_DIGEST,
    botIds: CANARY_IDS,
  };
  let createCalls = 0;
  await assert.rejects(
    armPhase2RemainderRelease({
      canaryManifestDigest: CANARY_DIGEST,
      now: NOW,
      config: REMAINDER_CONFIG,
      getReleaseImpl: async () => null,
      getCanaryImpl: async () => canary,
      snapshotImpl: async () => snapshot,
      canaryStatusImpl: async () => verifiedCanaryStatus({
        talentNetworkVisible: 9,
        verified: false,
        ok: false,
      }),
      createPlanImpl: async () => {
        createCalls += 1;
      },
    }),
    (error) => error.code === "PHASE2_REMAINDER_CANARY_NOT_VERIFIED",
  );
  assert.equal(createCalls, 0);

  let captured = null;
  const armed = await armPhase2RemainderRelease({
    canaryManifestDigest: CANARY_DIGEST,
    now: NOW,
    config: REMAINDER_CONFIG,
    getReleaseImpl: async () => null,
    getCanaryImpl: async () => canary,
    snapshotImpl: async () => snapshot,
    canaryStatusImpl: async () => verifiedCanaryStatus(),
    createPlanImpl: async (options) => {
      createCalls += 1;
      captured = options;
      return {
        created: true,
        existing: false,
        record: releaseRecord(options.entries, {
          snapshotTotal: options.snapshotTotal,
          excludedReviewCount: options.excludedReviewCount,
          verification: options.canaryVerification,
        }),
      };
    },
  });

  assert.equal(createCalls, 1);
  assert.deepEqual(
    new Set(captured.entries.map((entry) => entry.id)),
    new Set(remainder.slice(0, 3).map((job) => job.id)),
  );
  assert.equal(
    captured.entries.find(
      (entry) => entry.id === remainder[1].id,
    ).resumeReady,
    false,
  );
  assert.equal(captured.excludedReviewCount, 1);
  assert.equal(captured.commonAnchorAt, COMMON_ANCHOR);
  assert.equal(
    captured.canaryVerificationDigest,
    phase2RemainderAttestationDigest(captured.canaryVerification),
  );
  assert.equal(captured.canaryVerification.releaseFenceIntact, true);
  assert.equal(captured.canaryVerification.authorizedDelta, 10);
  assert.equal(armed.status, "armed");
  assert.equal(armed.selected, 3);
  assert.equal(armed.resumeReady, 2);
  assert.equal(armed.resumeMissing, 1);
  assert.equal(armed.excludedReview, 1);
  assert.equal("entries" in armed, false);
  for (const job of remainder) {
    assert.equal(JSON.stringify(armed).includes(job.id), false);
    assert.equal(
      JSON.stringify(armed).includes(job.identity.candidateUserId),
      false,
    );
  }

  await assert.rejects(
    armPhase2RemainderRelease({
      canaryManifestDigest: CANARY_DIGEST,
      now: NOW,
      getReleaseImpl: async () => null,
      getCanaryImpl: async () => canary,
      snapshotImpl: async () => {
        const error = new Error("private snapshot detail");
        error.code = "PHASE2_CANARY_INDEX_LIMIT";
        throw error;
      },
    }),
    (error) => error.code === "PHASE2_REMAINDER_INDEX_LIMIT",
  );
});

test("store arm is digest-bound, snapshot-CAS fenced, and SET-NX idempotent", async () => {
  const entries = [
    { id: "bot_store_arm01", revision: 4, resumeReady: true },
    { id: "bot_store_arm02", revision: 7, resumeReady: false },
  ];
  const verification = immutableVerification();
  const manifestDigest = phase2RemainderManifestDigest({
    canaryManifestDigest: CANARY_DIGEST,
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    commonAnchorAt: COMMON_ANCHOR,
    entries,
  });
  const options = {
    entries,
    manifestDigest,
    canaryManifestDigest: CANARY_DIGEST,
    canaryVerification: verification,
    canaryVerificationDigest:
      phase2RemainderAttestationDigest(verification),
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    snapshotTotal: 12,
    commonAnchorAt: COMMON_ANCHOR,
    excludedReviewCount: 3,
    now: NOW,
  };
  let command = null;
  const created = await createPhase2RemainderPlan(options, {
    kvImpl: async (value) => {
      command = value;
      return [1, value.at(-1)];
    },
  });

  assert.equal(created.created, true);
  assert.equal(created.record.manifestDigest, manifestDigest);
  assert.equal(
    Object.prototype.hasOwnProperty.call(created.record, "lease"),
    false,
    "a fresh record must omit JSON null because Lua treats cjson.null as truthy",
  );
  assert.equal(command[0], "EVAL");
  assert.equal(command[2], 3);
  assert.deepEqual(command.slice(3, 6), [
    "paraai:phase2:remainder-release:v1",
    "paraai:phase2:first-ten-canary:v1",
    "paraai:index",
  ]);
  assert.match(command[1], /redis\.sha1hex/);
  assert.match(command[1], /canaryIds\[expectedId\]/);
  assert.match(command[1], /remainderManifestDigest/);
  assert.match(command[1], /redis\.call\('SET', KEYS\[1\], proposed, 'NX'\)/);
  assert.equal(command.at(-2), String(entries[1].revision));

  let kvCalls = 0;
  await assert.rejects(
    createPhase2RemainderPlan({
      ...options,
      manifestDigest: "f".repeat(64),
    }, {
      kvImpl: async () => {
        kvCalls += 1;
      },
    }),
    (error) => error.code === "PHASE2_REMAINDER_DIGEST_MISMATCH",
  );
  assert.equal(kvCalls, 0);
  await assert.rejects(
    createPhase2RemainderPlan({
      ...options,
      canaryVerificationDigest: "e".repeat(64),
    }, {
      kvImpl: async () => {
        kvCalls += 1;
      },
    }),
    (error) => error.code === "PHASE2_REMAINDER_DIGEST_MISMATCH",
  );
  assert.equal(kvCalls, 0);
  await assert.rejects(
    createPhase2RemainderPlan({
      ...options,
      commonAnchorAt: "not-a-date",
    }, {
      kvImpl: async () => {
        kvCalls += 1;
      },
    }),
    (error) => error.code === "PHASE2_REMAINDER_ANCHOR_INVALID",
  );
  assert.equal(kvCalls, 0);
  await assert.rejects(
    createPhase2RemainderPlan(options, {
      kvImpl: async () => [-3, "1"],
    }),
    (error) => error.code === "PHASE2_REMAINDER_SNAPSHOT_CHANGED",
  );
  const conflicting = releaseRecord([
    { id: "bot_other_arm01", revision: 9, resumeReady: true },
  ], {
    snapshotTotal: 12,
  });
  await assert.rejects(
    createPhase2RemainderPlan(options, {
      kvImpl: async () => [2, JSON.stringify(conflicting)],
    }),
    (error) => error.code === "PHASE2_REMAINDER_MANIFEST_CONFLICT",
  );
});

test("global lease caps batches at five, waits for queue capacity, and recovers exact rows", async () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({
    id: `bot_lease_${String(index).padStart(4, "0")}`,
    revision: index + 2,
    resumeReady: index % 2 === 0,
  }));
  const armed = releaseRecord(rows);
  let capacityCommand = null;
  const saturated = await claimPhase2RemainderBatch({
    now: NOW,
    batchSize: 99,
    ownerToken: "capacity-owner",
  }, {
    kvImpl: async (command) => {
      capacityCommand = command;
      return [5, JSON.stringify(armed), "200", "10", "5"];
    },
  });
  assert.equal(saturated.claimed, false);
  assert.equal(saturated.saturated, true);
  assert.equal(saturated.status, "waiting_for_capacity");
  assert.deepEqual(saturated.entries, []);
  assert.equal(capacityCommand[7], "5");
  assert.deepEqual(capacityCommand.slice(-3), ["200", "10", "5"]);
  assert.match(capacityCommand[1], /ZREMRANGEBYSCORE/);
  assert.match(capacityCommand[1], /math\.min/);
  assert.match(
    capacityCommand[1],
    /record\.lease and record\.lease ~= cjson\.null/,
  );
  assert.match(capacityCommand[1], /record\.lease\['until'\]/);
  assert.doesNotMatch(capacityCommand[1], /record\.lease\.until|\buntil\s*=/u);

  const claimedRows = rows.map((row, index) => ({
    ...row,
    status: index < 5 ? "claimed" : "pending",
    attempts: index < 5 ? 1 : 0,
  }));
  const claimedRecord = releaseRecord(claimedRows, {
    status: "running",
    lease: {
      token: "lease-owner",
      until: NOW + 150_000,
      indexes: [1, 2, 3, 4, 5],
      batchOrdinal: 1,
      claimedAt: new Date(NOW).toISOString(),
    },
    extra: { batchOrdinal: 1 },
  });
  const claimed = await claimPhase2RemainderBatch({
    now: NOW,
    batchSize: 99,
    ownerToken: "lease-owner",
  }, {
    kvImpl: async () => [
      1,
      JSON.stringify(claimedRecord),
      "0",
      "0",
      "0",
    ],
  });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.entries.length, 5);
  assert.deepEqual(
    claimed.entries.map((entry) => entry.id),
    rows.slice(0, 5).map((row) => row.id),
  );

  const recoveredRecord = {
    ...claimedRecord,
    entries: claimedRecord.entries.map((entry) => ({
      ...entry,
      attempts: entry.status === "claimed"
        ? entry.attempts + 1
        : entry.attempts,
    })),
    lease: {
      ...claimedRecord.lease,
      token: "recovery-owner",
      until: NOW + 300_000,
    },
  };
  const recovered = await claimPhase2RemainderBatch({
    now: NOW + 200_000,
    batchSize: 1,
    ownerToken: "recovery-owner",
  }, {
    kvImpl: async () => [
      4,
      JSON.stringify(recoveredRecord),
      "0",
      "0",
      "0",
    ],
  });
  assert.equal(recovered.recovered, true);
  assert.deepEqual(
    recovered.entries.map((entry) => entry.id),
    rows.slice(0, 5).map((row) => row.id),
    "lease recovery must retry the immutable batch, not substitute rows",
  );
  assert.equal(recovered.record.entries[0].attempts, 2);
  assert.match(capacityCommand[1], /available < #indexes/);
  assert.match(capacityCommand[1], /entry\.attempts = tonumber/);
  assert.match(capacityCommand[1], /recoveryCeiling/);
  assert.match(capacityCommand[1], /record\.status = 'paused'/);

  const pausedRecovery = releaseRecord(rows.map((row, index) => ({
    ...row,
    status: "pending",
    attempts: index < 5 ? 3 : 0,
    ...(index < 5 ? { lastError: "release_retry_ceiling" } : {}),
  })), {
    status: "paused",
    extra: {
      batchOrdinal: 1,
      pauseReason: "release_retry_ceiling",
      pausedAt: new Date(NOW).toISOString(),
    },
  });
  const ceiling = await claimPhase2RemainderBatch({
    now: NOW + 400_000,
    ownerToken: "fourth-owner",
  }, {
    kvImpl: async () => [
      7,
      JSON.stringify(pausedRecovery),
      "0",
      "0",
      "0",
    ],
  });
  assert.equal(ceiling.paused, true);
  assert.equal(ceiling.status, "paused");
  assert.equal(ceiling.record.lease, null);

  let enqueues = 0;
  const busy = await runPhase2RemainderTick({
    config: REMAINDER_CONFIG,
    now: NOW,
    claimImpl: async () => ({
      claimed: false,
      busy: true,
      status: "busy",
      record: claimedRecord,
      entries: [],
      queue: { queued: 0, due: 0, leased: 1 },
    }),
    enqueueImpl: async () => {
      enqueues += 1;
    },
  });
  assert.equal(enqueues, 0);
  assert.equal(busy.status, "busy");
  assert.equal("entries" in busy, false);
});

test("first remainder admission atomically CAS-writes authorization and queue work", async () => {
  const digest = "e".repeat(64);
  const current = frozenJob("bot_atomic_auth1", {
    revision: 6,
    resumeReady: false,
  });
  const next = {
    ...current,
    state: "ready_to_submit",
    automation: {
      ...current.automation,
      mode: "authorized_backfill",
      remainderManifestDigest: digest,
      backfillBatchEntryAt: COMMON_ANCHOR,
      resumeWait: {
        source: "authorized_backfill",
        enteredAt: COMMON_ANCHOR,
        firstCheckAt: "2026-07-25T12:00:00.000Z",
      },
    },
    reviewReason: null,
    reviewReasons: [],
  };
  let command = null;
  const admitted = await authorizeAndEnqueuePhase2RemainderJob(
    next,
    current.revision,
    {
      eventId: "remainder-atomic-admission",
      dueAt: NOW,
      now: NOW,
      manifestDigest: digest,
      ownerToken: "atomic-owner",
      entryIndex: 2,
      commonAnchorAt: COMMON_ANCHOR,
    },
    {
      kvImpl: async (value) => {
        command = value;
        return [1, value[14], String(NOW)];
      },
    },
  );
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.job.revision, current.revision + 1);
  assert.equal(admitted.queue.enqueued, true);
  assert.equal(command[2], 10);
  assert.deepEqual(command.slice(3, 13), [
    "paraai:job:bot_atomic_auth1",
    "paraai:index",
    "paraai:resume-waiting",
    "paraai:auto:due",
    command[7],
    "paraai:auto:meta:bot_atomic_auth1",
    "paraai:phase2:remainder-release:v1",
    "paraai:auto:leases",
    "paraai:auto:lease:bot_atomic_auth1",
    "paraai:lock:bot_atomic_auth1",
  ]);
  assert.match(command[1], /currentAutomation\.mode/);
  assert.match(command[1], /nextAutomation\.remainderManifestDigest/);
  assert.match(command[1], /release\.commonAnchorAt/);
  assert.match(command[1], /entry\.revision/);
  assert.match(command[1], /lease\['until'\]/);
  assert.doesNotMatch(command[1], /lease\.until|\buntil\s*=/u);
  assert.match(command[1], /queued \+ queuedDelta/);
  assert.ok(
    command[1].indexOf("if queued + queuedDelta")
      < command[1].indexOf("redis.call('SET', KEYS[1], ARGV[2]"),
    "capacity rejection must happen before the authorization write",
  );

  const saturated = await authorizeAndEnqueuePhase2RemainderJob(
    next,
    current.revision,
    {
      eventId: "remainder-atomic-admission",
      dueAt: NOW,
      now: NOW,
      manifestDigest: digest,
      ownerToken: "atomic-owner",
      entryIndex: 2,
      commonAnchorAt: COMMON_ANCHOR,
    },
    {
      kvImpl: async () => [-2, "", ""],
    },
  );
  assert.equal(saturated.admitted, false);
  assert.equal(saturated.job, null);
  assert.equal(saturated.queue.error, "queue_capacity");
});

test("each remainder enqueue atomically rechecks lease authority and queue capacity", async () => {
  const digest = "e".repeat(64);
  let command = null;
  const saturated = await enqueuePhase2RemainderAutoJob(
    "bot_queue_fence1",
    {
      source: "authorized_backfill",
      eventId: "remainder-capacity-event",
      dueAt: NOW,
      now: NOW,
      manifestDigest: digest,
      ownerToken: "queue-owner",
      entryIndex: 3,
      expectedJobRevision: 9,
      commonAnchorAt: COMMON_ANCHOR,
    },
    {
      kvImpl: async (value) => {
        command = value;
        return [-2, ""];
      },
    },
  );
  assert.equal(saturated.enqueued, false);
  assert.equal(saturated.duplicate, false);
  assert.equal(saturated.error, "queue_capacity");
  assert.equal(command[0], "EVAL");
  assert.equal(command[2], 6);
  assert.deepEqual(command.slice(3, 9), [
    "paraai:auto:due",
    command[4],
    "paraai:auto:meta:bot_queue_fence1",
    "paraai:phase2:remainder-release:v1",
    "paraai:auto:leases",
    "paraai:job:bot_queue_fence1",
  ]);
  assert.match(command[1], /release\.manifestDigest/);
  assert.match(command[1], /lease\.token/);
  assert.match(command[1], /entry\.status or ''\) ~= 'claimed'/);
  assert.match(command[1], /lease\['until'\]/);
  assert.doesNotMatch(command[1], /lease\.until|\buntil\s*=/u);
  assert.match(command[1], /queued \+ queuedDelta/);
  assert.match(command[1], /dueCount \+ dueDelta/);
  assert.deepEqual(command.slice(-5, -2), ["200", "10", "5"]);
  assert.equal(command[18], "4", "the manifest index is persisted as one-based");

  const enqueued = await enqueuePhase2RemainderAutoJob(
    "bot_queue_fence1",
    {
      eventId: "remainder-capacity-event",
      dueAt: NOW,
      now: NOW,
      manifestDigest: digest,
      ownerToken: "queue-owner",
      entryIndex: 3,
      expectedJobRevision: 9,
      commonAnchorAt: COMMON_ANCHOR,
    },
    {
      kvImpl: async () => [1, String(NOW)],
    },
  );
  assert.equal(enqueued.enqueued, true);
  assert.equal(enqueued.duplicate, false);
});

test("recovered controller ticks authorize only the claimed manifest rows", async () => {
  const rows = [
    {
      id: "bot_tick_exact1",
      revision: 3,
      resumeReady: true,
      status: "claimed",
      attempts: 1,
    },
    {
      id: "bot_tick_exact2",
      revision: 8,
      resumeReady: false,
      status: "claimed",
      attempts: 1,
    },
  ];
  const claimedRecord = releaseRecord(rows, {
    status: "running",
    lease: {
      token: "tick-owner",
      until: NOW + 150_000,
      indexes: [1, 2],
      batchOrdinal: 1,
      claimedAt: new Date(NOW).toISOString(),
    },
    extra: { batchOrdinal: 1 },
  });
  let requestedBatch = null;
  let enqueueIds = null;
  let completion = null;
  const completedRecord = releaseRecord(rows.map((row) => ({
    ...row,
    status: "authorized",
  })), {
    status: "complete",
    extra: { completedAt: new Date(NOW).toISOString() },
  });
  const result = await runPhase2RemainderTick({
    config: REMAINDER_CONFIG,
    now: NOW,
    claimImpl: async (options) => {
      requestedBatch = options.batchSize;
      return {
        claimed: true,
        recovered: true,
        ownerToken: "tick-owner",
        record: claimedRecord,
        entries: rows.map((row, index) => ({
          index,
          id: row.id,
          revision: row.revision,
          resumeReady: row.resumeReady,
        })),
        queue: { queued: 0, due: 0, leased: 0 },
      };
    },
    enqueueImpl: async (ids, options) => {
      enqueueIds = ids;
      assert.equal(
        options.remainderManifestDigest,
        claimedRecord.manifestDigest,
      );
      assert.equal(options.expectedBackfillAnchorAt, COMMON_ANCHOR);
      assert.deepEqual(
        [...options.remainderExpectedRevisions.entries()],
        rows.map((row) => [row.id, row.revision]),
      );
      return [
        { botId: rows[0].id, enqueued: true, duplicate: false },
        { botId: rows[1].id, enqueued: false, duplicate: true },
      ];
    },
    completeImpl: async (options) => {
      completion = options;
      return completedRecord;
    },
  });

  assert.equal(requestedBatch, 5);
  assert.deepEqual(enqueueIds, rows.map((row) => row.id));
  assert.deepEqual(completion.outcomes, [
    { index: 0, status: "authorized", error: "" },
    { index: 1, status: "authorized", error: "" },
  ]);
  assert.equal(completion.ownerToken, "tick-owner");
  assert.equal(
    completion.manifestDigest,
    claimedRecord.manifestDigest,
  );
  assert.equal(result.status, "complete");
  assert.equal(result.authorized, 2);
  assert.equal(result.replayed, true);
  assert.equal("entries" in result, false);
  assert.equal(JSON.stringify(result).includes(rows[0].id), false);
});

test("batch exceptions durably retry the exact lease and cannot wedge recovery", async () => {
  const row = {
    id: "bot_batch_error1",
    revision: 5,
    resumeReady: true,
    status: "claimed",
    attempts: 1,
  };
  const claimed = releaseRecord([row], {
    status: "running",
    lease: {
      token: "batch-error-owner",
      until: NOW + 150_000,
      indexes: [1],
      batchOrdinal: 1,
      claimedAt: new Date(NOW).toISOString(),
    },
    extra: { batchOrdinal: 1 },
  });
  const retried = releaseRecord([{
    ...row,
    status: "pending",
    lastError: "phase2_remainder_anchor_conflict",
  }], {
    status: "running",
    extra: { batchOrdinal: 1 },
  });
  let completion = null;
  const result = await runPhase2RemainderTick({
    config: REMAINDER_CONFIG,
    now: NOW,
    claimImpl: async () => ({
      claimed: true,
      recovered: false,
      ownerToken: claimed.lease.token,
      record: claimed,
      entries: [{
        index: 0,
        id: row.id,
        revision: row.revision,
        resumeReady: true,
      }],
      queue: { queued: 0, due: 0, leased: 0 },
    }),
    enqueueImpl: async () => {
      const error = new Error(
        "private anchor for private.candidate@example.test",
      );
      error.code = "PHASE2_REMAINDER_ANCHOR_CONFLICT";
      throw error;
    },
    completeImpl: async (options) => {
      completion = options;
      return retried;
    },
  });
  assert.deepEqual(completion.outcomes, [{
    index: 0,
    status: "retry",
    error: "phase2_remainder_anchor_conflict",
  }]);
  assert.equal(completion.ownerToken, claimed.lease.token);
  assert.equal(result.status, "running");
  assert.equal(result.pending, 1);
  assert.equal(
    JSON.stringify(result).includes("private.candidate@example.test"),
    false,
  );
});

test("completion is lease-and-manifest fenced with exact batch outcomes", async () => {
  const rows = [
    {
      id: "bot_done_exact1",
      revision: 2,
      resumeReady: true,
      status: "claimed",
      attempts: 1,
    },
    {
      id: "bot_done_exact2",
      revision: 2,
      resumeReady: false,
      status: "claimed",
      attempts: 1,
    },
  ];
  const claimed = releaseRecord(rows, {
    status: "running",
    lease: {
      token: "complete-owner",
      until: NOW + 150_000,
      indexes: [1, 2],
      batchOrdinal: 1,
      claimedAt: new Date(NOW).toISOString(),
    },
  });
  const done = releaseRecord([
    { ...rows[0], status: "authorized" },
    { ...rows[1], status: "review", lastError: "identity_review" },
  ], {
    status: "complete",
    extra: { completedAt: new Date(NOW).toISOString() },
  });
  let command = null;
  const completed = await completePhase2RemainderBatch({
    ownerToken: claimed.lease.token,
    manifestDigest: claimed.manifestDigest,
    outcomes: [
      { index: 0, status: "authorized", error: "" },
      { index: 1, status: "review", error: "identity_review" },
    ],
    now: NOW,
  }, {
    kvImpl: async (value) => {
      command = value;
      return [1, JSON.stringify(done)];
    },
  });
  assert.equal(completed.status, "complete");
  assert.match(command[1], /record\.lease\.token/);
  assert.match(command[1], /record\.manifestDigest/);
  assert.match(command[1], /#outcomes ~= #\(record\.lease\.indexes/);
  assert.equal(command[4], claimed.manifestDigest);
  assert.equal(command[5], claimed.lease.token);
  assert.deepEqual(
    JSON.parse(command.at(-1)).map((row) => row.index),
    [1, 2],
  );
  await assert.rejects(
    completePhase2RemainderBatch({
      ownerToken: "stale-owner",
      manifestDigest: claimed.manifestDigest,
      outcomes: [
        { index: 0, status: "authorized", error: "" },
        { index: 1, status: "authorized", error: "" },
      ],
      now: NOW,
    }, {
      kvImpl: async () => [-1, JSON.stringify(claimed)],
    }),
    (error) => error.code === "PHASE2_REMAINDER_COMPLETION_CONFLICT",
  );
});

test("release reads reject impossible status, entry, attempt, and lease combinations", async () => {
  const pendingComplete = releaseRecord([{
    id: "bot_invalid_state",
    revision: 2,
    resumeReady: true,
  }], {
    status: "complete",
  });
  await assert.rejects(
    getPhase2RemainderRelease({
      kvImpl: async () => JSON.stringify(pendingComplete),
    }),
    (error) => error.code === "PHASE2_REMAINDER_RECORD_INVALID",
  );

  const terminalWithoutAttempt = releaseRecord([{
    id: "bot_invalid_attempt",
    revision: 2,
    resumeReady: true,
    status: "authorized",
    attempts: 0,
  }], {
    status: "complete",
  });
  await assert.rejects(
    getPhase2RemainderRelease({
      kvImpl: async () => JSON.stringify(terminalWithoutAttempt),
    }),
    (error) => error.code === "PHASE2_REMAINDER_RECORD_INVALID",
  );
});

test("remainder enqueue stamps provenance, accepts resume-missing rows, and forbids substitution", async () => {
  const job = frozenJob("bot_provenance2", { resumeReady: false });
  const digest = "d".repeat(64);
  let saved = null;
  let enqueueCalls = 0;
  const results = await enqueueBackfill([job.id], {
    config: REMAINDER_CONFIG,
    now: NOW,
    remainderManifestDigest: digest,
    remainderExpectedRevisions: new Map([[job.id, job.revision]]),
    expectedBackfillAnchorAt: COMMON_ANCHOR,
    getJobImpl: async () => job,
    getBackfillAnchorImpl: async () => ({
      version: 1,
      anchorAt: COMMON_ANCHOR,
    }),
    saveJobImpl: async () => {
      assert.fail("remainder provenance must not use split save");
    },
    authorizeEnqueueImpl: async (next, revision, options) => {
      saved = { ...next, revision: revision + 1 };
      enqueueCalls += 1;
      assert.equal(options.source, "authorized_backfill");
      return {
        admitted: true,
        job: saved,
        queue: {
          botId: next.id,
          enqueued: true,
          duplicate: false,
        },
      };
    },
    enqueueImpl: async () => {
      assert.fail("atomic first admission already inserted the queue event");
    },
  });
  assert.equal(results[0].enqueued, true);
  assert.equal(enqueueCalls, 1);
  assert.equal(saved.automation.mode, "authorized_backfill");
  assert.equal(saved.automation.remainderManifestDigest, digest);
  assert.equal(saved.automation.canaryManifestDigest, undefined);
  assert.equal(
    saved.automation.resumeWait.enteredAt,
    COMMON_ANCHOR,
  );

  let replayOptions = null;
  const replay = await enqueueBackfill([job.id], {
    config: REMAINDER_CONFIG,
    now: NOW + 1_000,
    remainderManifestDigest: digest,
    remainderExpectedRevisions: new Map([[job.id, job.revision]]),
    expectedBackfillAnchorAt: COMMON_ANCHOR,
    getJobImpl: async () => saved,
    getBackfillAnchorImpl: async () => ({ anchorAt: COMMON_ANCHOR }),
    saveJobImpl: async () => {
      assert.fail("an atomically admitted row must not save again");
    },
    authorizeEnqueueImpl: async () => {
      assert.fail("lease recovery must use the provenance replay path");
    },
    enqueueImpl: async (id, options) => {
      replayOptions = options;
      return { botId: id, enqueued: false, duplicate: true };
    },
  });
  assert.equal(replay[0].duplicate, true);
  assert.equal(replayOptions.expectedJobRevision, saved.revision);
  assert.equal(replayOptions.commonAnchorAt, COMMON_ANCHOR);

  const changed = await enqueueBackfill([job.id], {
    config: REMAINDER_CONFIG,
    now: NOW,
    remainderManifestDigest: digest,
    remainderExpectedRevisions: new Map([[job.id, job.revision + 1]]),
    expectedBackfillAnchorAt: COMMON_ANCHOR,
    getJobImpl: async () => job,
    getBackfillAnchorImpl: async () => ({ anchorAt: COMMON_ANCHOR }),
    saveJobImpl: async () => assert.fail("changed rows must not mutate"),
    enqueueImpl: async () => assert.fail("changed rows must not enqueue"),
  });
  assert.equal(changed[0].error, "remainder_job_changed");
  await assert.rejects(
    enqueueBackfill([job.id], {
      remainderManifestDigest: digest,
      remainderExpectedRevisions: new Map([[job.id, job.revision]]),
      expectedBackfillAnchorAt: "2026-07-25T10:00:00.000Z",
      getJobImpl: async () => job,
      getBackfillAnchorImpl: async () => ({ anchorAt: COMMON_ANCHOR }),
    }),
    (error) => error.code === "PHASE2_REMAINDER_ANCHOR_CONFLICT",
  );
});

test("status and autonomous cycles expose aggregates only and sanitize remainder failures", async () => {
  const secretId = "bot_private_001";
  const privateRecord = releaseRecord([{
    id: secretId,
    revision: 2,
    resumeReady: false,
    lastError: "candidate_private_error",
  }], {
    status: "running",
    excludedReviewCount: 4,
    extra: {
      operatorEmail: "private.operator@example.test",
    },
  });
  const status = await phase2RemainderReleaseStatus({
    getReleaseImpl: async () => privateRecord,
    queueStatsImpl: async () => ({ queued: 2, due: 1, leased: 0 }),
  });
  const serialized = JSON.stringify(status);
  assert.equal(status.selected, 1);
  assert.equal(status.resumeMissing, 1);
  assert.equal(status.excludedReview, 4);
  assert.equal(serialized.includes(secretId), false);
  assert.equal(serialized.includes("private.operator@example.test"), false);
  assert.equal(serialized.includes("candidate_private_error"), false);

  const reviewedRecord = releaseRecord([{
    id: "bot_reviewed_001",
    revision: 3,
    resumeReady: true,
    status: "review",
    attempts: 1,
    lastError: "identity_review",
  }], {
    status: "complete",
  });
  const reviewed = await phase2RemainderReleaseStatus({
    getReleaseImpl: async () => reviewedRecord,
    queueStatsImpl: async () => ({ queued: 0, due: 0, leased: 0 }),
  });
  assert.equal(reviewed.ok, false);
  assert.equal(reviewed.status, "complete_with_review");
  assert.equal(reviewed.review, 1);

  let disabledClaims = 0;
  const disabled = await runPhase2RemainderTick({
    config: { ...REMAINDER_CONFIG, enabled: false },
    claimImpl: async () => {
      disabledClaims += 1;
    },
  });
  assert.equal(disabled.status, "execution_disabled");
  assert.equal(disabledClaims, 0);

  const order = [];
  const cycle = await runAutomationCycle({
    mode: "tick",
    config: REMAINDER_CONFIG,
    tickImpl: async () => {
      order.push("tick");
      return { processed: 0 };
    },
    remainderImpl: async () => {
      order.push("remainder");
      return status;
    },
  });
  assert.deepEqual(order, ["tick", "remainder"]);
  assert.deepEqual(cycle.remainder, status);
  assert.equal(cycle.remainderError, null);

  const failed = await runAutomationCycle({
    mode: "recover",
    config: REMAINDER_CONFIG,
    sweepImpl: async () => ({ swept: 0 }),
    tickImpl: async () => ({ processed: 0 }),
    remainderImpl: async () => {
      const error = new Error(
        `private candidate ${secretId} private.operator@example.test`,
      );
      error.code = "PHASE2_REMAINDER_QUEUE_FAILURE";
      throw error;
    },
  });
  assert.deepEqual(failed.remainderError, {
    error: "phase2_remainder_queue_failure",
  });
  assert.equal(
    JSON.stringify(failed).includes("private.operator@example.test"),
    false,
  );
  assert.equal(JSON.stringify(failed).includes(secretId), false);
});

test("worker exposes runner-only aggregate remainder controls without caller selection", async () => {
  const source = await readFile(
    new URL("../api/paraai/worker.mjs", import.meta.url),
    "utf8",
  );
  for (const mode of [
    "phase2-remainder-arm",
    "phase2-remainder-tick",
    "phase2-remainder-status",
  ]) {
    assert.match(source, new RegExp(mode));
  }
  for (const field of [
    "botIds",
    "jobIds",
    "limit",
    "batch",
    "batchSize",
    "cursor",
    "force",
  ]) {
    assert.match(
      source,
      new RegExp(`hasOwnProperty\\.call\\(body, "${field}"\\)`),
    );
  }
  assert.match(
    source,
    /\["phase2-remainder-arm", "phase2-remainder-tick"\]\.includes\(mode\)/,
  );
  assert.match(source, /remainder_mutation_POST_only/);
  assert.match(source, /runnerAuthorized\(req\)/);
  assert.match(source, /caller_parameters_forbidden/);
  assert.match(source, /Object\.keys\(body\)/);
  assert.match(source, /remainder\?\.ok === false/);
  assert.match(source, /phase2-remainder-controller-degraded/);
  assert.doesNotMatch(
    source,
    /phase2-remainder-arm[\s\S]{0,500}body\.botIds/u,
  );
});
