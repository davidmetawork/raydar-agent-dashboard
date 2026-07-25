import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  commitPhase2FirstTenCanary,
  enqueueBackfill,
  phase2CanaryManifestDigest,
  phase2CanaryJobVerification,
  phase2FirstTenCanaryStatus,
  phase2LiveAttachProof,
  planPhase2FirstTenCanary,
  selectPhase2FirstTenCanary,
} from "../api/paraai/_lib/auto.mjs";
import {
  buildPreferenceRouting,
  buildPreferenceRoutingInput,
  buildSubmissionPayload,
} from "../api/paraai/_lib/pipeline.mjs";
import {
  claimPhase2FirstTenCanaryCommit,
  completePhase2FirstTenCanary,
  createPhase2FirstTenCanaryPlan,
  getCompletePhase2CanarySnapshot,
  hashSubmissionPayload,
} from "../api/paraai/_lib/store.mjs";
import { runnerAuthorized } from "../api/paraai/worker.mjs";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const SNAPSHOT_FINGERPRINT = "a".repeat(40);
const CANARY_CONFIG = {
  phase1DeployedAtMs: Date.parse("2026-07-15T00:00:00.000Z"),
  organicExceptionBotIds: new Set(),
};

function eligibleJob(id, {
  createdAt = "2026-07-01T00:00:00.000Z",
  revision = 2,
  candidateUserId = `candidate-user-${id}`,
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
      email: "private-candidate@example.test",
      linkedinUrl: "https://www.linkedin.com/in/private-candidate",
      resumeUri: "s3://private-resumes/candidate.pdf",
      screeningCallLink: "https://calls.example.test/private",
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
  };
  return {
    ...base,
    ...overrides,
    identity: { ...base.identity, ...(overrides.identity || {}) },
    submission: { ...base.submission, ...(overrides.submission || {}) },
    automation: { ...base.automation, ...(overrides.automation || {}) },
  };
}

function tenEligibleJobs(prefix = "bot_canary") {
  return Array.from({ length: 10 }, (_, index) => eligibleJob(
    `${prefix}_${String(index).padStart(4, "0")}`,
    {
      createdAt: new Date(
        Date.parse("2026-07-01T00:00:00.000Z") + index * 60_000,
      ).toISOString(),
    },
  ));
}

function canaryRecord(ids, {
  status = "planned",
  digest = phase2CanaryManifestDigest(ids),
  result = null,
  leaseUntil = null,
  extra = {},
} = {}) {
  return {
    version: 1,
    status,
    manifestDigest: digest,
    count: ids.length,
    botIds: [...ids],
    revisions: ids.map(() => 2),
    snapshotComplete: true,
    snapshotTotal: ids.length,
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    eligibleCount: ids.length,
    authorizedBackfillCountAtPlan: 0,
    attachProof: true,
    plannedAt: new Date(NOW).toISOString(),
    ...(leaseUntil == null ? {} : { leaseUntil }),
    result,
    ...extra,
  };
}

function attachProofJob(id = "bot_attach_proof") {
  const checkedAt = "2026-07-25T11:45:00.000Z";
  return {
    id,
    revision: 9,
    state: "awaiting_matches",
    automation: {
      mode: "organic",
      resumeWait: {
        lastCheckedAt: checkedAt,
        lastTrigger: `resume_attached:${"a".repeat(64)}`,
      },
    },
    submitAttemptStartedAt: "2026-07-25T11:46:00.000Z",
    submitAcceptedAt: "2026-07-25T11:47:00.000Z",
    submissionApprovalCheckedAt: "2026-07-25T11:48:00.000Z",
    matchLegStartedAt: "2026-07-25T11:48:00.000Z",
    submitReadbackVerified: true,
    journal: [
      {
        at: checkedAt,
        detail: "resume check 1/8 (attach trigger): resume on file",
      },
      {
        at: "2026-07-25T11:48:00.000Z",
        detail: "Paraform submission verified",
      },
    ],
  };
}

function verifiedCanaryJob(job, digest, index = 0) {
  const batchAt = "2026-07-25T12:00:00.000Z";
  const routingInput = buildPreferenceRoutingInput(null, {
    country: "United States",
  });
  const routing = buildPreferenceRouting(
    job.extracted,
    routingInput.native,
    routingInput.context,
  );
  const prepared = {
    ...job,
    state: "awaiting_matches",
    submission: {
      ...job.submission,
      name: `Private Candidate ${index}`,
      email: `private.candidate.${index}@example.test`,
      linkedinUrl: `https://www.linkedin.com/in/private-candidate-${index}`,
      resumeUri: `s3://private-resumes/candidate-${index}.pdf`,
    },
    reviewPreferences: routing.preferences,
    reviewPolicy: {
      ...routing.policy,
      preferenceRoutingInput: routingInput,
    },
    automation: {
      ...job.automation,
      mode: "authorized_backfill",
      canaryManifestDigest: digest,
      backfillBatchEntryAt: batchAt,
      preferenceRerouteRequired: false,
      preferenceRoutedAt: "2026-07-25T12:01:00.000Z",
      resumeWait: {
        source: "authorized_backfill",
        enteredAt: batchAt,
      },
      stepFailures: {},
    },
    submitAttemptStartedAt: "2026-07-25T12:02:00.000Z",
    submitAcceptedAt: "2026-07-25T12:03:00.000Z",
    submissionApprovalCheckedAt: "2026-07-25T12:04:00.000Z",
    matchLegStartedAt: "2026-07-25T12:04:00.000Z",
    submitReadbackVerified: true,
    error: null,
    journal: [{
      at: "2026-07-25T12:04:00.000Z",
      detail: "Paraform submission verified",
    }],
  };
  return {
    ...prepared,
    submitPayloadHash: hashSubmissionPayload(
      buildSubmissionPayload(prepared),
    ),
  };
}

test("atomic snapshot rejects saturation, missing rows, malformed rows, and index mismatches", async () => {
  const jobs = [
    eligibleJob("bot_canary_0001"),
    eligibleJob("bot_canary_0002"),
  ];
  let command = null;
  const snapshot = await getCompletePhase2CanarySnapshot({}, {
    kvImpl: async (value) => {
      command = value;
      return [
        1,
        "2",
        SNAPSHOT_FINGERPRINT,
        jobs[0].id,
        JSON.stringify(jobs[0]),
        jobs[1].id,
        JSON.stringify(jobs[1]),
      ];
    },
  });

  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.fingerprint, SNAPSHOT_FINGERPRINT);
  assert.deepEqual(snapshot.jobs.map((job) => job.id), jobs.map((job) => job.id));
  assert.equal(command[0], "EVAL");
  assert.equal(command[2], 1);
  assert.equal(command[3], "paraai:index");
  assert.equal(command[4], "500");
  assert.match(command[1], /ZCARD/);
  assert.match(command[1], /ZRANGE/);
  assert.match(command[1], /redis\.call\('GET'/);
  assert.match(command[1], /redis\.sha1hex/);

  await assert.rejects(
    getCompletePhase2CanarySnapshot({}, {
      kvImpl: async () => [0, "500"],
    }),
    (error) => error.code === "PHASE2_CANARY_INDEX_LIMIT",
  );
  await assert.rejects(
    getCompletePhase2CanarySnapshot({}, {
      kvImpl: async () => [
        1,
        "2",
        SNAPSHOT_FINGERPRINT,
        jobs[0].id,
        JSON.stringify(jobs[0]),
      ],
    }),
    (error) => error.code === "PHASE2_CANARY_SNAPSHOT_INCOMPLETE",
  );
  await assert.rejects(
    getCompletePhase2CanarySnapshot({}, {
      kvImpl: async () => [
        1,
        "1",
        SNAPSHOT_FINGERPRINT,
        jobs[0].id,
        JSON.stringify({ ...jobs[0], id: "bot_mismatched_1" }),
      ],
    }),
    (error) => error.code === "PHASE2_CANARY_SNAPSHOT_INCOMPLETE",
  );
});

test("selector recomputes the freeze, preserves exact review policy, dedupes candidates, and hard-caps ten", () => {
  const eligible = Array.from({ length: 13 }, (_, index) => (
    eligibleJob(`bot_canary_${String(index).padStart(4, "0")}`, {
      createdAt: new Date(
        Date.parse("2026-07-01T00:00:00.000Z") + index * 60_000,
      ).toISOString(),
    })
  ));
  const duplicateCandidate = eligibleJob("bot_canary_duplicate", {
    createdAt: "2026-07-01T00:00:30.000Z",
    candidateUserId: eligible[0].identity.candidateUserId,
  });
  const sameTimeEarlierId = eligibleJob("bot_canary_aaaa", {
    createdAt: eligible[0].createdAt,
  });
  const sameTimeLaterId = eligibleJob("bot_canary_zzzz", {
    createdAt: eligible[0].createdAt,
  });
  const excluded = [
    eligibleJob("bot_authorized_1", {
      automation: { mode: "authorized_backfill" },
    }),
    eligibleJob("bot_authorized_2", {
      automation: {
        mode: "backfill_only",
        resumeWait: { source: "authorized_backfill" },
      },
    }),
    eligibleJob("bot_authorized_3", {
      automation: {
        mode: "backfill_only",
        backfillBatchEntryAt: "2026-07-20T00:00:00.000Z",
      },
    }),
    eligibleJob("bot_organic_new_1", {
      createdAt: "2026-07-20T00:00:00.000Z",
    }),
    eligibleJob("bot_identity_bad", {
      identity: { ambiguous: true },
    }),
    eligibleJob("bot_state_error", {
      state: "error",
    }),
    eligibleJob("bot_resume_missing", {
      submission: { resumeUri: "" },
    }),
  ];
  const selected = selectPhase2FirstTenCanary([
    ...excluded,
    ...eligible.slice().reverse(),
    duplicateCandidate,
    sameTimeLaterId,
    sameTimeEarlierId,
  ], {
    config: CANARY_CONFIG,
  });

  assert.equal(selected.length, 10);
  assert.deepEqual(
    selected.slice(0, 4).map((job) => job.id),
    [
      "bot_canary_0000",
      "bot_canary_aaaa",
      "bot_canary_zzzz",
      "bot_canary_0001",
    ],
  );
  assert.equal(selected.some((job) => job.id === duplicateCandidate.id), false);
  assert.equal(
    new Set(selected.map((job) => job.identity.candidateUserId)).size,
    10,
  );
  assert.equal(
    selected.some((job) => excluded.some((row) => row.id === job.id)),
    false,
  );
  assert.match(
    phase2CanaryManifestDigest(selected.map((job) => job.id)),
    /^[a-f0-9]{64}$/,
  );
});

test("plan is one atomic immutable SET-NX against the unchanged complete snapshot", async () => {
  const jobs = tenEligibleJobs("bot_plan");
  const digest = phase2CanaryManifestDigest(jobs.map((job) => job.id));
  let command = null;
  const planned = await createPhase2FirstTenCanaryPlan({
    entries: jobs.map((job) => ({ id: job.id, revision: job.revision })),
    manifestDigest: digest,
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    snapshotTotal: 20,
    eligibleCount: 12,
    authorizedBackfillCount: 0,
    attachProof: true,
    now: NOW,
  }, {
    kvImpl: async (value) => {
      command = value;
      return [1, value.at(-1)];
    },
  });

  assert.equal(planned.created, true);
  assert.equal(planned.record.status, "planned");
  assert.equal(planned.record.manifestDigest, digest);
  assert.deepEqual(planned.record.botIds, jobs.map((job) => job.id));
  assert.equal(command[0], "EVAL");
  assert.equal(command[2], 2);
  assert.deepEqual(
    command.slice(3, 5),
    ["paraai:phase2:first-ten-canary:v1", "paraai:index"],
  );
  assert.match(command[1], /ZCARD/);
  assert.match(command[1], /ZRANGE/);
  assert.match(command[1], /redis\.sha1hex/);
  assert.match(command[1], /job\.revision/);
  assert.match(command[1], /backfill_only/);
  assert.match(command[1], /authorized_backfill/);
  assert.match(command[1], /seenCandidates/);
  assert.match(command[1], /'NX'/);

  await assert.rejects(
    createPhase2FirstTenCanaryPlan({
      entries: jobs.slice(0, 9).map((job) => ({
        id: job.id,
        revision: job.revision,
      })),
      manifestDigest: digest,
      snapshotFingerprint: SNAPSHOT_FINGERPRINT,
      snapshotTotal: 20,
      eligibleCount: 12,
      authorizedBackfillCount: 0,
      attachProof: true,
    }),
    /exactly ten jobs/,
  );
});

test("planning requires a live attach proof and exactly ten distinct resume-ready candidates", async () => {
  const nine = tenEligibleJobs("bot_short").slice(0, 9);
  assert.equal(phase2LiveAttachProof(attachProofJob()), true);
  assert.equal(phase2LiveAttachProof({
    ...attachProofJob(),
    submitAttemptStartedAt: null,
  }), false);
  assert.equal(phase2LiveAttachProof(attachProofJob(), {
    now: Date.parse("2026-07-26T12:00:01.000Z"),
  }), false);
  const noProof = await planPhase2FirstTenCanary({
    now: NOW,
    config: CANARY_CONFIG,
    getCanaryImpl: async () => null,
    snapshotImpl: async () => ({
      complete: true,
      total: nine.length,
      fingerprint: SNAPSHOT_FINGERPRINT,
      jobs: nine,
    }),
  });
  assert.equal(noProof.status, "awaiting_attach_proof");
  assert.equal(noProof.attachProof, false);

  let createCalls = 0;
  const insufficient = await planPhase2FirstTenCanary({
    now: NOW,
    config: CANARY_CONFIG,
    getCanaryImpl: async () => null,
    snapshotImpl: async () => ({
      complete: true,
      total: nine.length + 1,
      fingerprint: SNAPSHOT_FINGERPRINT,
      jobs: [attachProofJob(), ...nine],
    }),
    createPlanImpl: async () => {
      createCalls += 1;
    },
  });

  assert.equal(insufficient.status, "insufficient");
  assert.equal(insufficient.eligible, 9);
  assert.equal(insufficient.selected, 0);
  assert.equal(insufficient.manifestDigest, null);
  assert.equal(createCalls, 0);

  const ten = tenEligibleJobs("bot_exact");
  const planned = await planPhase2FirstTenCanary({
    now: NOW,
    config: CANARY_CONFIG,
    getCanaryImpl: async () => null,
    snapshotImpl: async () => ({
      complete: true,
      total: ten.length + 1,
      fingerprint: SNAPSHOT_FINGERPRINT,
      jobs: [attachProofJob(), ...ten],
    }),
    createPlanImpl: async ({
      entries,
      manifestDigest,
      snapshotTotal,
      eligibleCount,
      authorizedBackfillCount,
      attachProof,
    }) => ({
      created: true,
      existing: false,
      record: {
        ...canaryRecord(entries.map((entry) => entry.id), {
          digest: manifestDigest,
        }),
        snapshotTotal,
        eligibleCount,
        authorizedBackfillCountAtPlan: authorizedBackfillCount,
        attachProof,
      },
    }),
  });
  assert.equal(planned.status, "planned");
  assert.equal(planned.selected, 10);
  assert.equal(planned.attachProof, true);
  assert.match(planned.manifestDigest, /^[a-f0-9]{64}$/);
});

test("commit is digest-bound, leased, retries the immutable manifest, and stamps provenance", async () => {
  const jobs = tenEligibleJobs("bot_commit");
  const ids = jobs.map((job) => job.id);
  const candidateEleven = "bot_commit_0010";
  const digest = phase2CanaryManifestDigest(ids);
  const planned = canaryRecord(ids, { digest });
  let command = null;
  const claimed = await claimPhase2FirstTenCanaryCommit({
    manifestDigest: digest,
    now: NOW,
    ownerToken: "owner-token",
  }, {
    kvImpl: async (value) => {
      command = value;
      return [1, JSON.stringify({
        ...planned,
        status: "committing",
        ownerToken: "owner-token",
        leaseUntil: NOW + 150_000,
      })];
    },
  });
  assert.equal(claimed.acquired, true);
  assert.equal(command[0], "EVAL");
  assert.equal(command[2], 2);
  assert.deepEqual(command.slice(3, 5), [
    "paraai:phase2:first-ten-canary:v1",
    "paraai:index",
  ]);
  assert.match(command[1], /record\.manifestDigest/);
  assert.match(command[1], /record\.status == 'committing'/);
  assert.match(command[1], /record\.status = 'committing'/);
  assert.match(command[1], /record\.revisions/);
  assert.match(command[1], /sameManifest/);
  assert.match(command[1], /ZCARD/);
  assert.match(command[1], /ZSCORE/);
  assert.deepEqual(command.slice(-2), ["paraai:job:", "500"]);

  let enqueuedIds = null;
  let enqueueOptions = null;
  const committed = await commitPhase2FirstTenCanary({
    manifestDigest: digest,
    now: NOW,
    claimImpl: async () => claimed,
    enqueueImpl: async (values, options) => {
      enqueuedIds = [...values];
      enqueueOptions = options;
      return values.map((botId) => ({
        botId,
        enqueued: true,
        duplicate: false,
      }));
    },
    completeImpl: async ({ result }) => ({
      ...planned,
      status: "complete",
      result,
    }),
  });
  assert.deepEqual(enqueuedIds, ids);
  assert.equal(enqueuedIds.includes(candidateEleven), false);
  assert.equal(enqueueOptions.canaryManifestDigest, digest);
  assert.equal(committed.status, "completed");
  assert.equal(committed.enqueued, 10);

  await assert.rejects(
    commitPhase2FirstTenCanary({
      manifestDigest: "b".repeat(64),
      claimImpl: async () => {
        const error = new Error("phase 2 canary digest does not match");
        error.code = "PHASE2_CANARY_DIGEST_MISMATCH";
        throw error;
      },
    }),
    (error) => error.code === "PHASE2_CANARY_DIGEST_MISMATCH",
  );
  await assert.rejects(
    claimPhase2FirstTenCanaryCommit({
      manifestDigest: digest,
      now: NOW,
    }, {
      kvImpl: async () => [-4, JSON.stringify(planned)],
    }),
    (error) => error.code === "PHASE2_CANARY_SNAPSHOT_CHANGED",
  );

  const completed = await completePhase2FirstTenCanary({
    ownerToken: "owner-token",
    manifestDigest: digest,
    result: { attempted: 10, enqueued: 10, duplicate: 0, failed: 0 },
    now: NOW,
  }, {
    kvImpl: async (value) => {
      assert.match(value[1], /record\.status ~= 'committing'/);
      return [1, JSON.stringify({
        ...planned,
        status: "complete",
        result: JSON.parse(value.at(-1)),
      })];
    },
  });
  assert.equal(completed.status, "complete");
});

test("a partial canary commit releases its lease for an idempotent retry of the same manifest", async () => {
  const ids = tenEligibleJobs("bot_partial").map((job) => job.id);
  const digest = phase2CanaryManifestDigest(ids);
  const planned = canaryRecord(ids, { digest });
  let completionScript = "";
  const retryable = await completePhase2FirstTenCanary({
    ownerToken: "owner-token",
    manifestDigest: digest,
    result: { attempted: 10, enqueued: 9, duplicate: 0, failed: 1 },
    now: NOW,
  }, {
    kvImpl: async (value) => {
      completionScript = value[1];
      return [3, JSON.stringify({
        ...planned,
        status: "planned",
        result: { attempted: 10, enqueued: 9, duplicate: 0, failed: 1 },
      })];
    },
  });
  assert.equal(retryable.status, "planned");
  assert.match(completionScript, /retryable and 'planned' or 'complete'/);
  assert.match(completionScript, /record\.ownerToken = nil/);
  assert.match(completionScript, /record\.leaseUntil = nil/);

  const response = await commitPhase2FirstTenCanary({
    manifestDigest: digest,
    now: NOW,
    claimImpl: async () => ({
      acquired: true,
      recovered: true,
      ownerToken: "owner-token-2",
      record: planned,
    }),
    enqueueImpl: async (values) => values.map((botId, index) => ({
      botId,
      enqueued: index !== 9,
      duplicate: false,
      ...(index === 9 ? { error: "retryable_enqueue_failure" } : {}),
    })),
    completeImpl: async ({ result }) => ({
      ...planned,
      status: "planned",
      result,
    }),
  });
  assert.equal(response.status, "retryable");
  assert.equal(response.ok, false);
  assert.equal(response.failed, 1);
  assert.equal(response.selected, 10);
});

test("existing backfill transition durably stamps the canary manifest provenance", async () => {
  const job = eligibleJob("bot_provenance_1");
  const digest = phase2CanaryManifestDigest([job.id]);
  let saved = null;
  let enqueueCalls = 0;
  const result = await enqueueBackfill([job.id], {
    config: {
      resumeWaitMinutes: 60,
      resumeRetryDays: 7,
      resumeTerminalAckHours: 24,
      resumeBackfillTerminalAckDays: 21,
    },
    now: NOW,
    canaryManifestDigest: digest,
    canaryExpectedRevisions: new Map([[job.id, job.revision]]),
    getJobImpl: async () => job,
    getBackfillAnchorImpl: async () => ({
      version: 1,
      anchorAt: new Date(NOW).toISOString(),
    }),
    saveJobImpl: async (next, revision) => {
      saved = { ...next, revision: revision + 1 };
      return saved;
    },
    enqueueImpl: async (botId) => {
      enqueueCalls += 1;
      return { botId, enqueued: true, duplicate: false };
    },
  });

  assert.equal(result[0].enqueued, true);
  assert.equal(enqueueCalls, 1);
  assert.equal(saved.automation.mode, "authorized_backfill");
  assert.equal(saved.automation.canaryManifestDigest, digest);

  let conflictedEnqueue = false;
  const conflict = await enqueueBackfill([job.id], {
    canaryManifestDigest: digest,
    getJobImpl: async () => ({
      ...job,
      automation: {
        ...job.automation,
        canaryManifestDigest: "b".repeat(64),
      },
    }),
    getBackfillAnchorImpl: async () => ({
      version: 1,
      anchorAt: new Date(NOW).toISOString(),
    }),
    enqueueImpl: async () => {
      conflictedEnqueue = true;
    },
  });
  assert.equal(conflict[0].error, "canary_manifest_conflict");
  assert.equal(conflictedEnqueue, false);
});

test("concurrent and repeated commits enqueue one manifest at most once", async () => {
  const ids = tenEligibleJobs("bot_race").map((job) => job.id);
  const digest = phase2CanaryManifestDigest(ids);
  let stored = canaryRecord(ids, { digest });
  let enqueueCalls = 0;
  const claimImpl = async () => {
    if (stored.status === "complete") {
      return {
        acquired: false,
        complete: true,
        ownerToken: null,
        record: stored,
      };
    }
    if (stored.status === "committing") {
      return {
        acquired: false,
        busy: true,
        ownerToken: null,
        record: stored,
      };
    }
    stored = {
      ...stored,
      status: "committing",
      ownerToken: "owner-token",
      leaseUntil: NOW + 150_000,
    };
    return {
      acquired: true,
      recovered: false,
      ownerToken: "owner-token",
      record: stored,
    };
  };
  const enqueueImpl = async (values) => {
    enqueueCalls += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return values.map((botId) => ({
      botId,
      enqueued: true,
      duplicate: false,
    }));
  };
  const completeImpl = async ({ result }) => {
    stored = { ...stored, status: "complete", result };
    return stored;
  };
  const options = {
    manifestDigest: digest,
    now: NOW,
    claimImpl,
    enqueueImpl,
    completeImpl,
  };

  const concurrent = await Promise.all([
    commitPhase2FirstTenCanary(options),
    commitPhase2FirstTenCanary(options),
  ]);
  const repeated = await commitPhase2FirstTenCanary(options);

  assert.equal(enqueueCalls, 1);
  assert.equal(concurrent.some((row) => row.status === "completed"), true);
  assert.equal(concurrent.some((row) => row.status === "in_progress"), true);
  assert.equal(repeated.status, "completed");
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.enqueued, 10);
});

test("plan, status, and commit responses expose only aggregates and manifest digest", async () => {
  const jobs = tenEligibleJobs("bot_private").map((job, index) => (
    eligibleJob(job.id, {
      createdAt: job.createdAt,
      candidateUserId: `candidate-secret-${index}`,
      identity: { name: `Secret Person ${index}` },
      submission: {
        email: `secret.person.${index}@example.test`,
        linkedinUrl: `https://www.linkedin.com/in/secret-person-${index}`,
      },
    })
  ));
  const ids = jobs.map((job) => job.id);
  const digest = phase2CanaryManifestDigest(ids);
  const privateRecord = canaryRecord(ids, {
    status: "complete",
    digest,
    result: { attempted: 10, enqueued: 10, duplicate: 0, failed: 0 },
    extra: {
      candidateUserId: "candidate-secret-identifier",
      email: "secret.person@example.test",
    },
  });
  const verifiedJobs = jobs.map((job, index) => (
    verifiedCanaryJob(job, digest, index)
  ));
  const byId = new Map(verifiedJobs.map((job) => [job.id, job]));
  const response = await phase2FirstTenCanaryStatus({
    getCanaryImpl: async () => privateRecord,
    getJobImpl: async (id) => byId.get(id) || null,
    snapshotImpl: async () => ({
      complete: true,
      total: verifiedJobs.length,
      fingerprint: SNAPSHOT_FINGERPRINT,
      jobs: verifiedJobs,
    }),
  });
  const serialized = JSON.stringify(response);

  assert.equal(response.verified, true);
  assert.equal(response.ok, true);
  assert.equal(response.manifestDigest, digest);
  assert.equal(response.enqueued, 10);
  assert.equal(response.talentNetworkVisible, 10);
  assert.equal(response.preferencesRouted, 10);
  assert.equal(response.payloadHashVerified, 10);
  assert.equal(response.preexistingVisible, 0);
  assert.equal(response.errors, 0);
  assert.equal(response.releaseFenceIntact, true);
  for (const job of jobs) {
    assert.equal(serialized.includes(job.id), false);
    assert.equal(serialized.includes(job.identity.candidateUserId), false);
    assert.equal(serialized.includes(job.identity.name), false);
    assert.equal(serialized.includes(job.submission.email), false);
    assert.equal(serialized.includes(job.submission.linkedinUrl), false);
  }
});

test("mechanical status rejects pre-existing visibility, routing drift, and an out-of-manifest release", async () => {
  const source = tenEligibleJobs("bot_verify");
  const ids = source.map((job) => job.id);
  const digest = phase2CanaryManifestDigest(ids);
  const verified = source.map((job, index) => (
    verifiedCanaryJob(job, digest, index)
  ));
  const drifted = {
    ...verified[0],
    submitAttemptStartedAt: null,
    reviewPreferences: {
      ...verified[0].reviewPreferences,
      locations: ["new_york"],
    },
    reviewPolicy: {
      ...verified[0].reviewPolicy,
      preferenceRouting: {
        ...verified[0].reviewPolicy.preferenceRouting,
        locations: {
          ...verified[0].reviewPolicy.preferenceRouting.locations,
          routed: ["new_york"],
          rule: "select_all_unknown",
        },
      },
    },
    journal: [
      {
        detail:
          "Talent Network membership already visible; submission write skipped",
      },
      { detail: "Paraform submission verified" },
    ],
  };
  const check = phase2CanaryJobVerification(drifted, digest);
  assert.equal(check.preexistingVisible, true);
  assert.equal(check.preferencesRouted, false);
  assert.equal(check.submitAttemptStarted, false);

  const staleTimeline = {
    ...verified[1],
    submitAttemptStartedAt: "2026-07-25T11:52:00.000Z",
    submitAcceptedAt: "2026-07-25T11:53:00.000Z",
    submissionApprovalCheckedAt: "2026-07-25T11:54:00.000Z",
    matchLegStartedAt: "2026-07-25T11:54:00.000Z",
  };
  const staleCheck = phase2CanaryJobVerification(staleTimeline, digest);
  assert.equal(staleCheck.submitAttemptStarted, false);
  assert.equal(staleCheck.submitAccepted, false);
  assert.equal(staleCheck.talentNetworkVisible, false);

  const current = [drifted, ...verified.slice(1), {
    ...verifiedCanaryJob(
      eligibleJob("bot_outside_manifest"),
      "b".repeat(64),
      11,
    ),
  }];
  const byId = new Map(current.map((job) => [job.id, job]));
  const status = await phase2FirstTenCanaryStatus({
    getCanaryImpl: async () => canaryRecord(ids, {
      status: "complete",
      digest,
      result: { attempted: 10, enqueued: 10, duplicate: 0, failed: 0 },
    }),
    getJobImpl: async (id) => byId.get(id) || null,
    snapshotImpl: async () => ({
      complete: true,
      total: current.length,
      fingerprint: SNAPSHOT_FINGERPRINT,
      jobs: current,
    }),
  });
  assert.equal(status.verified, false);
  assert.equal(status.preexistingVisible, 1);
  assert.equal(status.preferencesRouted, 9);
  assert.equal(status.authorizedDelta, 11);
  assert.equal(status.releaseFenceIntact, false);
  assert.equal(status.ok, false);
});

test("canary mutation is runner-key-only and raw-ID enqueue is break-glass guarded", async () => {
  const previousRunner = process.env.PARAAI_AUTOMATION_RUNNER_KEY;
  const previousCron = process.env.CRON_SECRET;
  process.env.PARAAI_AUTOMATION_RUNNER_KEY = "runner-test-secret";
  process.env.CRON_SECRET = "cron-test-secret";
  try {
    assert.equal(runnerAuthorized({
      headers: { authorization: "Bearer cron-test-secret" },
    }), false);
    assert.equal(runnerAuthorized({
      headers: { authorization: "Bearer runner-test-secret" },
    }), true);
  } finally {
    if (previousRunner == null) {
      delete process.env.PARAAI_AUTOMATION_RUNNER_KEY;
    } else {
      process.env.PARAAI_AUTOMATION_RUNNER_KEY = previousRunner;
    }
    if (previousCron == null) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = previousCron;
    }
  }

  const source = await readFile(
    new URL("../api/paraai/worker.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /phase2-first-ten-plan/);
  assert.match(source, /phase2-first-ten-commit/);
  assert.match(source, /phase2-first-ten-status/);
  assert.match(source, /canary_mutation_POST_only/);
  assert.match(source, /caller_selection_forbidden/);
  assert.match(source, /PARAAI_BACKFILL_RAW_ENQUEUE_BREAK_GLASS/);
  assert.doesNotMatch(source, /mode === "phase2-first-ten"/);
});
