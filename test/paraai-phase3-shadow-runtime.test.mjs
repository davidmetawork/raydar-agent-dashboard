import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

import {
  PHASE3_MATCH_READ_PROC,
  normalizePhase3RankedMatchResponse,
  refreshMatches,
} from "../api/paraai/_lib/pipeline.mjs";
import {
  continuousPhase3ShadowTransition,
  processAutoJob,
} from "../api/paraai/_lib/auto.mjs";

const ANCHOR = "2026-07-26T00:00:00.000Z";
const MINUTE_MS = 60_000;
const atMinutes = (minutes) =>
  new Date(Date.parse(ANCHOR) + (minutes * MINUTE_MS)).toISOString();

const SHADOW_CONFIG = Object.freeze({
  matchReadPinned: true,
  matchReadProc: PHASE3_MATCH_READ_PROC,
  matchStageEnabled: true,
  matchShadow: true,
  curateEnabled: false,
  enrollApproved: false,
});

function shadowJob(overrides = {}) {
  return {
    id: "bot_shadow_123",
    revision: 4,
    state: "awaiting_matches",
    matchLegStartedAt: ANCHOR,
    callEndedAt: "2026-07-25T23:00:00.000Z",
    humanCall: false,
    identity: {
      candidateId: "candidate-primary-secret",
      candidateUserId: "candidate-user-secret",
    },
    candidate: {
      fullName: "Candidate Secret",
      email: "candidate-secret@example.test",
    },
    ...overrides,
  };
}

function durableCallProof(
  job,
  {
    observedAt = atMinutes(5),
    calls = null,
  } = {},
) {
  const normalizedCalls = calls || [{
    endedAt: job.callTypeAt || job.callEndedAt,
    successful: true,
    humanCall: job.humanCall === true,
    provenanceVerified: true,
  }];
  return {
    version: 1,
    source: "candidate_success_index_v1",
    authoritative: true,
    complete: true,
    bootstrapComplete: true,
    proofVersion: 1,
    proofUpdatedAt: ANCHOR,
    proofSemanticDigest: "b".repeat(40),
    bootstrapGenerationDigest: "c".repeat(40),
    conflict: normalizedCalls.length > 1,
    storeObservedAt: observedAt,
    calls: normalizedCalls,
  };
}

async function runRefresh(
  response,
  {
    minutes = 5,
    job = shadowJob(),
    config = SHADOW_CONFIG,
    callSnapshot = null,
  } = {},
) {
  const reads = [];
  const saves = [];
  const persist = async (next, expectedRevision, proofBinding = null) => {
    saves.push({ next, expectedRevision, proofBinding });
    return {
      ...next,
      revision: Number(expectedRevision) + 1,
    };
  };
  const saved = await refreshMatches(job, {
    config,
    now: Date.parse(ANCHOR) + (minutes * MINUTE_MS),
    callSnapshot: callSnapshot || durableCallProof(job, {
      observedAt: atMinutes(minutes),
    }),
    trpcGetImpl: async (procedure, input) => {
      reads.push({ procedure, input });
      return response;
    },
    saveJobImpl: persist,
    saveDecisionImpl: persist,
  });
  return { saved, reads, saves };
}

test("captured ranked roles normalize only by mutually-exclusive tier flags", () => {
  const normalized = normalizePhase3RankedMatchResponse({
    status: "ranked",
    roles: [
      {
        roleId: "role-endorsed-secret",
        score: 0.810,
        rank: 0,
        endorsed: true,
        suggested: false,
        roleName: "Secret role name",
        companyName: "Secret company",
      },
      {
        roleId: "role-suggested-secret",
        score: 0.811,
        rank: 1,
        endorsed: false,
        suggested: true,
        roleName: "Another secret role",
      },
    ],
  });

  assert.equal(normalized.settled, true);
  assert.equal(normalized.statusKind, "settled");
  assert.equal(normalized.count, 2);
  assert.deepEqual(normalized.roles, [
    { roleId: "role-endorsed-secret", tier: "endorsed" },
    { roleId: "role-suggested-secret", tier: "suggested" },
  ]);
  assert.deepEqual(normalized.endorsedRoleIds, ["role-endorsed-secret"]);
  assert.deepEqual(normalized.suggestedRoleIds, ["role-suggested-secret"]);
  assert.equal(JSON.stringify(normalized).includes("Secret role name"), false);
  assert.equal(JSON.stringify(normalized).includes("Secret company"), false);
  assert.equal(JSON.stringify(normalized).includes("0.811"), false);
});

test("unknown statuses and malformed tiers fail safe without becoming zero matches", () => {
  const unknown = normalizePhase3RankedMatchResponse({
    status: "ranking",
    roles: [],
  });
  assert.deepEqual({
    status: unknown.status,
    statusKind: unknown.statusKind,
    settled: unknown.settled,
    count: unknown.count,
    errorCode: unknown.errorCode,
  }, {
    status: "ranking",
    statusKind: "unknown",
    settled: false,
    count: null,
    errorCode: "status_unrecognized",
  });

  const normalizedVariant = normalizePhase3RankedMatchResponse({
    status: "PROCESSING",
    roles: [],
  });
  assert.equal(normalizedVariant.status, "PROCESSING");
  assert.equal(normalizedVariant.statusKind, "unknown");
  assert.equal(normalizedVariant.settled, false);

  const pending = normalizePhase3RankedMatchResponse({
    status: "processing",
    roles: [],
  });
  assert.equal(pending.status, "processing");
  assert.equal(pending.statusKind, "pending");
  assert.equal(pending.settled, false);
  assert.equal(pending.count, null);

  for (const [status, diagnostic] of [
    [["ranked"], "unrecognized"],
    [1, "unrecognized"],
    [{ value: "ranked" }, "unrecognized"],
    ["RANKED", "RANKED"],
    [" ranked ", "whitespace:ranked"],
  ]) {
    const malformedStatus = normalizePhase3RankedMatchResponse({
      status,
      roles: [],
    });
    assert.equal(malformedStatus.status, diagnostic);
    assert.equal(malformedStatus.statusKind, "unknown");
    assert.equal(malformedStatus.settled, false);
    assert.equal(malformedStatus.count, null);
  }

  for (const roles of [
    [{ roleId: "role-a", endorsed: true, suggested: true }],
    [{ roleId: "role-a", endorsed: false, suggested: false }],
    [{ roleId: "role-a", endorsed: true, suggested: false }, {
      roleId: "role-a",
      endorsed: false,
      suggested: true,
    }],
    [{ roleId: "", endorsed: true, suggested: false }],
  ]) {
    const malformed = normalizePhase3RankedMatchResponse({
      status: "ranked",
      roles,
    });
    assert.equal(malformed.statusKind, "malformed");
    assert.equal(malformed.settled, false);
    assert.equal(malformed.count, null);
    assert.deepEqual(malformed.roles, []);
  }
});

test("refreshMatches calls the exact captured read and persists only aggregate shadow intent", async () => {
  const { saved, reads, saves } = await runRefresh({
    status: "ranked",
    roles: [
      {
        roleId: "role-endorsed-secret",
        score: 0.810,
        endorsed: true,
        suggested: false,
        roleName: "Secret role",
      },
      {
        roleId: "role-suggested-secret",
        score: 0.811,
        endorsed: false,
        suggested: true,
        companyName: "Secret company",
      },
    ],
  });

  assert.deepEqual(reads, [{
    procedure: PHASE3_MATCH_READ_PROC,
    input: {
      candidate_id: "candidate-primary-secret",
      recruiter_user_id: "clskvclu80066l60fhutn6kks",
    },
  }]);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].expectedRevision, 4);
  assert.deepEqual(saves[0].proofBinding, {
    candidateUserId: "candidate-user-secret",
    candidateId: "candidate-primary-secret",
    expectedProofVersion: 1,
    expectedProofSemanticDigest: "b".repeat(40),
    expectedBootstrapGenerationDigest: "c".repeat(40),
  });
  assert.equal(saved.state, "awaiting_matches");
  assert.equal(saved.matchCount, 2);
  assert.equal(saved.phase3Shadow.settlementDecision, "matches_settled");
  assert.equal(saved.phase3Shadow.complete, true);
  assert.equal(saved.phase3Shadow.nextPollAt, null);
  assert.equal(saved.phase3Shadow.endorsedCount, 1);
  assert.equal(saved.phase3Shadow.suggestedCount, 1);
  assert.equal(saved.phase3Shadow.policyMismatch, false);
  assert.equal(saved.phase3Shadow.candidateFacingWrites, 0);
  assert.equal(saved.phase3Shadow.curationWrites, 0);
  assert.equal(saved.phase3Shadow.enrollments, 0);
  assert.equal(saved.phase3Shadow.audit.aggregateOnly, true);
  assert.equal(saved.phase3Shadow.audit.curation.postAddMatchCountSource, "projected");
  assert.equal(saved.phase3Shadow.audit.gates.allowShadowAudit, true);
  assert.equal(saved.phase3Shadow.audit.gates.allowCuratedWrite, false);
  assert.equal(saved.phase3Shadow.audit.gates.allowEnrollment, false);
  assert.equal(saved.phase3Shadow.audit.gates.candidateFacingWritesAllowed, false);
  assert.equal(
    saved.phase3Shadow.intendedRouting.targetSequenceId,
    "vw168sypaoagu5j5g209cps3",
  );

  const persisted = JSON.stringify(saved.phase3Shadow);
  for (const secret of [
    "candidate-primary-secret",
    "candidate-user-secret",
    "Candidate Secret",
    "candidate-secret@example.test",
    "role-endorsed-secret",
    "role-suggested-secret",
    "Secret role",
    "Secret company",
  ]) {
    assert.equal(persisted.includes(secret), false);
  }
  assert.doesNotMatch(persisted, /[a-f0-9]{64}/u);
  assert.equal(Object.hasOwn(saved, "targetSequenceName"), false);
});

test("zero settles from matchLegStartedAt at 30 minutes and keeps late reads in shadow", async () => {
  const before = await runRefresh(
    { status: "ranked", roles: [] },
    { minutes: 29 },
  );
  assert.equal(before.saved.state, "awaiting_matches");
  assert.equal(before.saved.phase3Shadow.settlementDecision, "pending_zero");
  assert.equal(before.saved.phase3Shadow.audit, null);
  assert.equal(before.saved.phase3Shadow.nextPollAt, atMinutes(30));
  assert.equal(before.saved.phase3Shadow.complete, false);

  const settled = await runRefresh(
    { status: "ranked", roles: [] },
    { minutes: 30 },
  );
  assert.equal(settled.saved.state, "awaiting_matches");
  assert.equal(settled.saved.phase3Shadow.settlementDecision, "zero_settled");
  assert.equal(settled.saved.phase3Shadow.lateMatchMode, true);
  assert.equal(settled.saved.phase3Shadow.nextPollAt, atMinutes(4 * 60));
  assert.equal(settled.saved.phase3Shadow.complete, false);
  assert.equal(settled.saved.phase3Shadow.audit.match.matchCount, 0);
  assert.equal(
    settled.saved.phase3Shadow.intendedRouting.targetSequenceId,
    "cmqpje4lh00040cki15nuuqc8",
  );
  assert.equal(settled.saved.state === "ready_to_enroll", false);
});

test("intended call routing uses the durable candidate index's latest success", async () => {
  const { saved } = await runRefresh(
    {
      status: "ranked",
      roles: [{
        roleId: "role-one",
        endorsed: true,
        suggested: false,
      }],
    },
    {
      callSnapshot: {
        ...durableCallProof(shadowJob(), {
          calls: [{
            endedAt: "2026-07-25T23:30:00.000Z",
            successful: true,
            humanCall: true,
            provenanceVerified: true,
          }],
        }),
      },
    },
  );

  assert.equal(
    saved.phase3Shadow.intendedRouting.targetSequenceId,
    "u5zsfwujwasmmcufdmzem08f",
  );

  let reads = 0;
  await assert.rejects(
    refreshMatches(shadowJob(), {
      config: SHADOW_CONFIG,
      now: Date.parse(atMinutes(5)),
      trpcGetImpl: async () => {
        reads += 1;
        return { status: "ranked", roles: [] };
      },
      saveJobImpl: async (value) => value,
    }),
    (error) => error?.code === "PHASE3_CALL_SNAPSHOT_REQUIRED",
  );
  assert.equal(reads, 0);
});

test("call proof is preflighted, refreshed after ranked, and owns the audit timestamp", async () => {
  const events = [];
  const proofObservedAt = atMinutes(7);
  let proofReads = 0;
  const saved = await refreshMatches(shadowJob(), {
    config: SHADOW_CONFIG,
    now: Date.parse(atMinutes(5)),
    trpcGetImpl: async () => {
      events.push("match");
      return {
        status: "ranked",
        roles: [{
          roleId: "role-proof-time",
          endorsed: true,
          suggested: false,
        }],
      };
    },
    callSnapshotImpl: async () => {
      proofReads += 1;
      events.push(`call-proof-${proofReads}`);
      return durableCallProof(shadowJob(), {
        observedAt: proofReads === 1 ? atMinutes(5) : proofObservedAt,
      });
    },
    saveJobImpl: async (value) => value,
    saveDecisionImpl: async (value) => value,
  });

  assert.deepEqual(events, ["call-proof-1", "match", "call-proof-2"]);
  assert.equal(saved.matchCheckedAt, proofObservedAt);
  assert.equal(saved.phase3Shadow.observedAt, proofObservedAt);
  assert.equal(saved.phase3Shadow.audit.observedAt, proofObservedAt);
});

test("a changed candidate proof rejects the settled audit without generic-save fallback", async () => {
  let genericSaves = 0;
  let binding = null;
  await assert.rejects(
    refreshMatches(shadowJob(), {
      config: SHADOW_CONFIG,
      now: Date.parse(atMinutes(5)),
      callSnapshot: durableCallProof(shadowJob()),
      trpcGetImpl: async () => ({
        status: "ranked",
        roles: [{
          roleId: "role-proof-cas",
          endorsed: true,
          suggested: false,
        }],
      }),
      saveJobImpl: async (value) => {
        genericSaves += 1;
        return value;
      },
      saveDecisionImpl: async (_next, _revision, proofBinding) => {
        binding = proofBinding;
        const error = new Error("proof changed");
        error.code = "PHASE3_CALL_PROOF_CHANGED";
        throw error;
      },
    }),
    (error) => error?.code === "PHASE3_CALL_PROOF_CHANGED",
  );

  assert.equal(genericSaves, 0);
  assert.deepEqual(binding, {
    candidateUserId: "candidate-user-secret",
    candidateId: "candidate-primary-secret",
    expectedProofVersion: 1,
    expectedProofSemanticDigest: "b".repeat(40),
    expectedBootstrapGenerationDigest: "c".repeat(40),
  });
});

test("pending or unknown evidence persists after one preflight proof read", async () => {
  const events = [];
  const saved = await refreshMatches(shadowJob(), {
    config: SHADOW_CONFIG,
    now: Date.parse(atMinutes(5)),
    trpcGetImpl: async () => {
      events.push("match");
      return { status: "ranking", roles: [] };
    },
    callSnapshotImpl: async () => {
      events.push("call-proof");
      return durableCallProof(shadowJob());
    },
    saveJobImpl: async (value) => value,
  });

  assert.deepEqual(events, ["call-proof", "match"]);
  assert.equal(saved.phase3Shadow.observedStatus, "ranking");
  assert.equal(saved.phase3Shadow.statusKind, "unknown");
  assert.equal(saved.phase3Shadow.complete, false);
});

test("incomplete global proof bootstrap fails before the vendor read", async () => {
  let reads = 0;
  await assert.rejects(
    refreshMatches(shadowJob(), {
      config: SHADOW_CONFIG,
      now: Date.parse(atMinutes(5)),
      callSnapshot: {
        ...durableCallProof(shadowJob()),
        bootstrapComplete: false,
      },
      trpcGetImpl: async () => {
        reads += 1;
        return { status: "ranked", roles: [] };
      },
      saveJobImpl: async (value) => value,
    }),
    (error) => error?.code === "PHASE3_CALL_SNAPSHOT_REQUIRED",
  );
  assert.equal(reads, 0);
});

test("an equal-time call-type conflict enters aggregate-only review before vendor read", async () => {
  let reads = 0;
  const job = shadowJob();
  const saved = await refreshMatches(job, {
    config: SHADOW_CONFIG,
    now: Date.parse(atMinutes(5)),
    callSnapshot: durableCallProof(job, {
      calls: [
        {
          endedAt: "2026-07-25T23:00:00.000Z",
          successful: true,
          humanCall: false,
          provenanceVerified: true,
        },
        {
          endedAt: "2026-07-25T23:00:00.000Z",
          successful: true,
          humanCall: true,
          provenanceVerified: true,
        },
      ],
    }),
    trpcGetImpl: async () => {
      reads += 1;
      return { status: "ranked", roles: [] };
    },
    saveJobImpl: async (next) => next,
  });

  assert.equal(reads, 0);
  assert.equal(saved.state, "needs_review");
  assert.equal(saved.reviewReason, "phase3_call_proof_conflict");
  assert.equal(saved.error.code, "PHASE3_CALL_PROOF_CONFLICT");
  assert.equal(saved.phase3Shadow.callProofConflict, true);
  assert.equal(saved.phase3Shadow.technicalFailure, true);
  assert.equal(saved.phase3Shadow.policyMismatch, false);
  assert.equal(saved.phase3Shadow.candidateFacingWrites, 0);
  assert.equal(saved.phase3Shadow.curationWrites, 0);
  assert.equal(saved.phase3Shadow.enrollments, 0);
});

test("Phase 3 transitions preserve malformed write counters for the aggregate fence", async () => {
  const phase3Shadow = {
    policyVersion: "phase3-shadow-policy-v1",
    bootstrap: false,
    nextPollAt: null,
    complete: false,
    candidateFacingWrites: "0",
    curationWrites: -1,
    enrollments: 2,
  };
  const scheduled = continuousPhase3ShadowTransition(
    shadowJob({ phase3Shadow }),
    {
      ...SHADOW_CONFIG,
      matchStageEnabledAtMs: Date.parse(ANCHOR),
    },
    { now: Date.parse(atMinutes(5)) },
  );
  assert.equal(scheduled.phase3Shadow.candidateFacingWrites, "0");
  assert.equal(scheduled.phase3Shadow.curationWrites, -1);
  assert.equal(scheduled.phase3Shadow.enrollments, 2);

  const reviewed = await refreshMatches(
    shadowJob({ phase3Shadow }),
    {
      config: SHADOW_CONFIG,
      now: Date.parse(atMinutes(5)),
      callSnapshot: durableCallProof(shadowJob(), {
        calls: [
          {
            endedAt: "2026-07-25T23:00:00.000Z",
            successful: true,
            humanCall: false,
            provenanceVerified: true,
          },
          {
            endedAt: "2026-07-25T23:00:00.000Z",
            successful: true,
            humanCall: true,
            provenanceVerified: true,
          },
        ],
      }),
      trpcGetImpl: async () => {
        throw new Error("match read must not run");
      },
      saveJobImpl: async (next) => next,
    },
  );
  assert.equal(reviewed.phase3Shadow.candidateFacingWrites, "0");
  assert.equal(reviewed.phase3Shadow.curationWrites, -1);
  assert.equal(reviewed.phase3Shadow.enrollments, 2);
});

test("a call-type conflict introduced after ranked is persisted as review", async () => {
  const job = shadowJob();
  let reads = 0;
  let proofReads = 0;
  const tiedCalls = [
    {
      endedAt: "2026-07-25T23:00:00.000Z",
      successful: true,
      humanCall: false,
      provenanceVerified: true,
    },
    {
      endedAt: "2026-07-25T23:00:00.000Z",
      successful: true,
      humanCall: true,
      provenanceVerified: true,
    },
  ];
  const saved = await refreshMatches(job, {
    config: SHADOW_CONFIG,
    now: Date.parse(atMinutes(5)),
    callSnapshotImpl: async () => {
      proofReads += 1;
      return durableCallProof(job, {
        observedAt: proofReads === 1 ? atMinutes(5) : atMinutes(6),
        calls: proofReads === 1 ? null : tiedCalls,
      });
    },
    trpcGetImpl: async () => {
      reads += 1;
      return { status: "ranked", roles: [] };
    },
    saveJobImpl: async (next) => next,
  });

  assert.equal(proofReads, 2);
  assert.equal(reads, 1);
  assert.equal(saved.state, "needs_review");
  assert.equal(saved.reviewReason, "phase3_call_proof_conflict");
  assert.equal(saved.phase3Shadow.observedStatus, "ranked");
  assert.deepEqual(saved.phase3Shadow.observedStatusKinds, ["settled"]);
  assert.equal(saved.phase3Shadow.readCount, 1);
  assert.equal(saved.phase3Shadow.callProofConflict, true);
});

test("the worker scopes durable proof reads to the current candidate", async () => {
  const now = Date.parse(atMinutes(5));
  const job = shadowJob({
    phase3Shadow: {
      policyVersion: "phase3-shadow-policy-v1",
      nextPollAt: atMinutes(5),
      complete: false,
    },
  });
  const proofInputs = [];
  const result = await processAutoJob(job.id, {
    config: {
      ...SHADOW_CONFIG,
      matchStageEnabledAtMs: Date.parse(ANCHOR),
    },
    now: () => now,
    getJobImpl: async () => job,
    getPhase3ReleaseImpl: async () => null,
    phase3CallProofImpl: async (input) => {
      proofInputs.push(input);
      return durableCallProof(job);
    },
    refreshMatchesImpl: async (current, { callSnapshotImpl }) => {
      await callSnapshotImpl();
      return {
        ...current,
        phase3Shadow: {
          ...current.phase3Shadow,
          readCount: 1,
          complete: true,
        },
      };
    },
  });

  assert.equal(result.action, "complete");
  assert.deepEqual(proofInputs, [{
    candidateUserId: "candidate-user-secret",
    candidateId: "candidate-primary-secret",
  }]);
});

test("the worker preserves a durable conflict review as an aggregate-only alert", async () => {
  const now = Date.parse(atMinutes(5));
  const job = shadowJob({
    phase3Shadow: {
      policyVersion: "phase3-shadow-policy-v1",
      nextPollAt: atMinutes(5),
      complete: false,
    },
  });
  const result = await processAutoJob(job.id, {
    config: {
      ...SHADOW_CONFIG,
      matchStageEnabledAtMs: Date.parse(ANCHOR),
    },
    now: () => now,
    getJobImpl: async () => job,
    getPhase3ReleaseImpl: async () => null,
    refreshMatchesImpl: async (current) => ({
      ...current,
      state: "needs_review",
      reviewReason: "phase3_call_proof_conflict",
      error: {
        code: "PHASE3_CALL_PROOF_CONFLICT",
        detail: "equal-time successful call types require review",
      },
      phase3Shadow: {
        ...current.phase3Shadow,
        complete: true,
        nextPollAt: null,
        callProofConflict: true,
        technicalFailure: true,
      },
    }),
  });

  assert.equal(result.action, "complete");
  assert.equal(result.state, "needs_review");
  assert.equal(result.detail, "equal-time successful call types require review");
  assert.deepEqual(result.alert, {
    code: "PHASE3_CALL_PROOF_CONFLICT",
    detail: "equal-time successful call types require review",
    aggregateOnly: true,
  });
});

test("an exhausted organic schedule forces one explicit boundary read", () => {
  const now = Date.parse(atMinutes((24 * 60) + 5));
  const next = continuousPhase3ShadowTransition(
    shadowJob({
      matchCheckedAt: atMinutes(24 * 60),
      phase3Shadow: null,
    }),
    {
      ...SHADOW_CONFIG,
      matchStageEnabledAtMs: Date.parse(ANCHOR),
    },
    { now },
  );

  assert.equal(next.state, "awaiting_matches");
  assert.equal(next.phase3Shadow.nextPollAt, new Date(now).toISOString());
  assert.equal(next.phase3Shadow.complete, false);
});

test("an invalid bootstrap schedule cannot downgrade into organic polling", () => {
  assert.throws(
    () => continuousPhase3ShadowTransition(
      shadowJob({
        phase3Shadow: {
          policyVersion: "phase3-shadow-policy-v1",
          bootstrap: true,
          nextPollAt: null,
          complete: false,
        },
      }),
      {
        ...SHADOW_CONFIG,
        matchStageEnabledAtMs: Date.parse(ANCHOR),
      },
      { now: Date.parse(atMinutes(5)) },
    ),
    (error) => error?.code === "PHASE3_BOOTSTRAP_SCHEDULE_INVALID",
  );
});

test("a legacy job outside the immutable bootstrap completes in review", async () => {
  const stageEnabledAtMs = Date.parse(atMinutes(60));
  const now = Date.parse(atMinutes(65));
  let refreshes = 0;
  const job = shadowJob();
  const result = await processAutoJob(job.id, {
    config: {
      ...SHADOW_CONFIG,
      matchStageEnabledAtMs: stageEnabledAtMs,
    },
    now: () => now,
    getJobImpl: async () => job,
    getPhase3ReleaseImpl: async () => ({
      entries: [],
    }),
    saveJobImpl: async (next, expectedRevision) => ({
      ...next,
      revision: Number(expectedRevision) + 1,
    }),
    refreshMatchesImpl: async () => {
      refreshes += 1;
      return job;
    },
  });

  assert.equal(refreshes, 0);
  assert.equal(result.action, "complete");
  assert.equal(result.job.state, "needs_review");
  assert.equal(result.job.error.code, "PHASE3_BOOTSTRAP_OUT_OF_SCOPE");
  assert.equal(result.job.phase3Shadow.complete, true);
});

test("unknown evidence remains observable across a later exact ranked settlement", async () => {
  const first = await runRefresh(
    { status: "ranking", roles: [] },
    { minutes: 5 },
  );
  assert.equal(first.saved.phase3Shadow.policyMismatch, false);
  assert.equal(first.saved.phase3Shadow.unknownStatusObserved, true);

  const second = await runRefresh(
    {
      status: "ranked",
      roles: [{
        roleId: "role-later",
        endorsed: false,
        suggested: true,
      }],
    },
    {
      minutes: 10,
      job: first.saved,
    },
  );
  assert.equal(second.saved.phase3Shadow.settlementDecision, "matches_settled");
  assert.equal(second.saved.phase3Shadow.complete, true);
  assert.equal(second.saved.phase3Shadow.policyMismatch, false);
  assert.deepEqual(
    second.saved.phase3Shadow.observedStatuses,
    ["ranking", "ranked"],
  );
  assert.deepEqual(
    second.saved.phase3Shadow.observedStatusKinds,
    ["unknown", "settled"],
  );
  assert.deepEqual(
    second.saved.phase3Shadow.observedResponseErrors,
    ["status_unrecognized"],
  );
});

test("safe case and whitespace status variants remain distinct diagnostics", async () => {
  const upper = await runRefresh(
    { status: "RANKED", roles: [] },
    { minutes: 5 },
  );
  const whitespace = await runRefresh(
    { status: " ranking ", roles: [] },
    { minutes: 10, job: upper.saved },
  );
  const lower = await runRefresh(
    { status: "ranking", roles: [] },
    { minutes: 15, job: whitespace.saved },
  );
  const exact = await runRefresh(
    { status: "ranked", roles: [] },
    { minutes: 30, job: lower.saved },
  );

  assert.deepEqual(exact.saved.phase3Shadow.observedStatuses, [
    "RANKED",
    "whitespace:ranking",
    "ranking",
    "ranked",
  ]);
  assert.deepEqual(exact.saved.phase3Shadow.observedStatusKinds, [
    "unknown",
    "settled",
  ]);
  assert.equal(exact.saved.phase3Shadow.unknownStatusObserved, true);
  assert.equal(exact.saved.phase3Shadow.policyMismatch, false);
  assert.equal(exact.saved.phase3Shadow.settlementDecision, "zero_settled");
});

test("malformed contract evidence remains a sticky policy mismatch after ranked recovery", async () => {
  const first = await runRefresh(
    {
      status: "ranked",
      roles: [{
        roleId: "role-invalid",
        endorsed: true,
        suggested: true,
      }],
    },
    { minutes: 5 },
  );
  assert.equal(first.saved.phase3Shadow.policyMismatch, true);
  assert.equal(first.saved.phase3Shadow.malformedStatusObserved, true);

  const second = await runRefresh(
    {
      status: "ranked",
      roles: [{
        roleId: "role-valid",
        endorsed: true,
        suggested: false,
      }],
    },
    {
      minutes: 10,
      job: first.saved,
    },
  );
  assert.equal(second.saved.phase3Shadow.settlementDecision, "matches_settled");
  assert.equal(second.saved.phase3Shadow.policyMismatch, true);
  assert.deepEqual(
    second.saved.phase3Shadow.observedStatusKinds,
    ["malformed", "settled"],
  );
  assert.deepEqual(
    second.saved.phase3Shadow.observedResponseErrors,
    ["tier_invalid"],
  );
});

test("settled-zero baseline survives late unsettled reads and later matches become review-only", async () => {
  const baseline = await runRefresh(
    { status: "ranked", roles: [] },
    { minutes: 30 },
  );
  const baselineAudit = baseline.saved.phase3Shadow.audit;
  const baselineRouting = baseline.saved.phase3Shadow.intendedRouting;

  const unknown = await runRefresh(
    { status: "ranking", roles: [] },
    {
      minutes: 4 * 60,
      job: baseline.saved,
    },
  );
  assert.equal(unknown.saved.state, "awaiting_matches");
  assert.equal(unknown.saved.matchCount, 0);
  assert.equal(unknown.saved.phase3Shadow.settlementDecision, "zero_settled");
  assert.equal(unknown.saved.phase3Shadow.lateMatchMode, true);
  assert.equal(unknown.saved.phase3Shadow.nextPollAt, atMinutes(8 * 60));
  assert.deepEqual(unknown.saved.phase3Shadow.audit, baselineAudit);
  assert.deepEqual(
    unknown.saved.phase3Shadow.intendedRouting,
    baselineRouting,
  );

  const boundary = await runRefresh(
    { status: "processing", roles: [] },
    {
      minutes: 24 * 60,
      job: unknown.saved,
    },
  );
  assert.equal(boundary.saved.state, "awaiting_matches");
  assert.equal(boundary.saved.reviewReason, null);
  assert.equal(boundary.saved.error, null);
  assert.equal(boundary.saved.phase3Shadow.settlementDecision, "zero_settled");
  assert.equal(boundary.saved.phase3Shadow.complete, true);
  assert.equal(boundary.saved.phase3Shadow.nextPollAt, null);
  assert.deepEqual(boundary.saved.phase3Shadow.audit, baselineAudit);

  const late = await runRefresh(
    {
      status: "ranked",
      roles: [{
        roleId: "role-late",
        endorsed: true,
        suggested: false,
      }],
    },
    {
      minutes: 4 * 60,
      job: baseline.saved,
    },
  );
  assert.equal(late.saved.matchCount, 1);
  assert.equal(late.saved.phase3Shadow.lateMatchDetected, true);
  assert.equal(late.saved.phase3Shadow.audit.lateMatch.detected, true);
  assert.equal(
    late.saved.phase3Shadow.audit.lateMatch.allowSecondEnrollment,
    false,
  );
  assert.equal(late.saved.phase3Shadow.audit.gates.allowEnrollment, false);
  assert.equal(
    late.saved.phase3Shadow.intendedRouting.targetSequenceId,
    late.saved.phase3Shadow.audit.targetSequenceId,
  );
  assert.notEqual(
    late.saved.phase3Shadow.intendedRouting.targetSequenceId,
    baselineRouting.targetSequenceId,
  );
  assert.equal(late.saved.phase3Shadow.intendedRouting.matchCount, 1);
  assert.equal(late.saved.phase3Shadow.intendedRouting.endorsedCount, 1);
  assert.equal(late.saved.phase3Shadow.intendedRouting.suggestedCount, 0);
  assert.equal(
    late.saved.phase3Shadow.intendedRouting.intendedCuratedAddCount,
    1,
  );
  assert.equal(
    late.saved.phase3Shadow.intendedRouting.postAddMatchCountSource,
    "projected",
  );
  assert.equal(
    late.saved.phase3Shadow.intendedRouting.enrollmentAction,
    "none",
  );
  assert.equal(
    late.saved.phase3Shadow.intendedRouting.lateMatchReview,
    true,
  );
  assert.equal(
    late.saved.phase3Shadow.intendedRouting.allowSecondEnrollment,
    false,
  );
});

test("an unrecognized status is logged and rescheduled, never settled as empty roles", async () => {
  const { saved } = await runRefresh(
    { status: "ranking", roles: [] },
    { minutes: 30 },
  );
  assert.equal(saved.state, "awaiting_matches");
  assert.equal(saved.matchCount, null);
  assert.equal(saved.phase3Shadow.observedStatus, "ranking");
  assert.deepEqual(saved.phase3Shadow.observedStatuses, ["ranking"]);
  assert.equal(saved.phase3Shadow.statusKind, "unknown");
  assert.equal(saved.phase3Shadow.settlementDecision, "pending");
  assert.equal(saved.phase3Shadow.audit, null);
  assert.equal(saved.phase3Shadow.intendedRouting, null);
  assert.equal(saved.phase3Shadow.nextPollAt, atMinutes(60));
});

test("a genuinely unresolved 24-hour read becomes technical review without a write path", async () => {
  const { saved } = await runRefresh(
    { status: "ranking", roles: [] },
    { minutes: 24 * 60 },
  );
  assert.equal(saved.state, "needs_review");
  assert.equal(saved.reviewReason, "matches_pending_timeout");
  assert.equal(saved.error.code, "MATCHES_PENDING_TIMEOUT");
  assert.equal(saved.phase3Shadow.settlementDecision, "timeout");
  assert.equal(saved.phase3Shadow.complete, true);
  assert.equal(saved.phase3Shadow.nextPollAt, null);
  assert.equal(saved.phase3Shadow.audit, null);
  assert.equal(saved.state === "ready_to_enroll", false);
});

test("shadow reads fail closed before the vendor call if either write gate is open", async () => {
  for (const override of [
    { matchStageEnabled: false },
    { matchShadow: false },
    { curateEnabled: true },
    { enrollApproved: true },
    { matchReadProc: "unrecognized.procedure" },
  ]) {
    let reads = 0;
    await assert.rejects(
      refreshMatches(shadowJob(), {
        config: { ...SHADOW_CONFIG, ...override },
        now: Date.parse(atMinutes(5)),
        callSnapshot: durableCallProof(shadowJob()),
        trpcGetImpl: async () => {
          reads += 1;
          return { status: "ranked", roles: [] };
        },
        saveJobImpl: async (value) => value,
      }),
      (error) => /^PHASE3_/u.test(String(error?.code || "")),
    );
    assert.equal(reads, 0);
  }
});

test("the Phase 3 refresh implementation contains no curation, enrollment, or POST call", async () => {
  const source = await readFile(
    new URL("../api/paraai/_lib/pipeline.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function phase3ScopeDigest");
  const end = source.indexOf("async function verifyCandidateEmail", start);
  assert.ok(start >= 0 && end > start);
  const shadowRuntime = source.slice(start, end);
  assert.doesNotMatch(
    shadowRuntime,
    /trpcPost|ready_to_enroll|curatedRoleList|enrollJob/u,
  );
});
