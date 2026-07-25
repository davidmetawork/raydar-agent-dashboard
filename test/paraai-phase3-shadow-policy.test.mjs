import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_OUTCOME_SEQUENCE_IDS,
  CURATED_ADD_ATTEMPT_LIMIT_MAX,
  LATE_MATCH_REVIEW_NOTE_CODE,
  LIVE_OUTCOME_SEQUENCES_BY_ID,
  MATCH_INITIAL_POLL_MS,
  MATCH_LATE_POLL_MS,
  MATCH_STEADY_POLL_MS,
  PHASE3_SHADOW_POLICY_VERSION,
  RETIRED_OUTCOME_SEQUENCE_IDS,
  buildAggregateShadowAudit as rawBuildAggregateShadowAudit,
  curatedPostAddMatchCount as rawCuratedPostAddMatchCount,
  curatedWriteReconciliationDecision,
  lateMatchDecision as rawLateMatchDecision,
  matchSettlementDecision as rawMatchSettlementDecision,
  mostRecentSuccessfulCallDecision as rawMostRecentSuccessfulCallDecision,
  nextMatchPollDecision,
  outcomeMembershipDecision,
  outcomeSequenceHealthDecision,
  phase3GateDecision as rawPhase3GateDecision,
  planCuratedAdds as rawPlanCuratedAdds,
  stageEnableReanchorDecision,
  targetOutcomeSequence as rawTargetOutcomeSequence,
} from "../api/paraai/_lib/phase3-shadow-policy.mjs";
import {
  OUTCOME_SEQUENCE_RULES,
} from "../api/roster/_lib/outcome-sequences.mjs";

const ANCHOR = "2026-07-25T00:00:00.000Z";
const SCOPE_DIGEST = "a".repeat(64);
const OTHER_SCOPE_DIGEST = "b".repeat(64);
const roleIdsForCount = (matchCount) => Array.from(
  { length: matchCount },
  (_, index) => `post-add-role-${index + 1}`,
);
const roleIdsForPlanCount = (plan, matchCount) => {
  const targets = Array.isArray(plan?.targetRoleIds)
    ? [...plan.targetRoleIds]
    : [];
  if (matchCount <= targets.length) return targets.slice(0, matchCount);
  return [
    ...targets,
    ...Array.from(
      { length: matchCount - targets.length },
      (_, index) => `prior-post-add-role-${index + 1}`,
    ),
  ];
};
const selectedCallProof = ({
  scopeDigest = SCOPE_DIGEST,
  humanCall = false,
  snapshotObservedAt = ANCHOR,
} = {}) => rawMostRecentSuccessfulCallDecision({
  scopeDigest,
  snapshotObservedAt,
  authoritative: true,
  complete: true,
  calls: [{ endedAt: ANCHOR, successful: true, humanCall }],
});
const postAddReadbackProof = ({
  scopeDigest = SCOPE_DIGEST,
  matchCount = 0,
  source = "projected",
  roleIds = roleIdsForCount(matchCount),
} = {}) => rawCuratedPostAddMatchCount({
  scopeDigest,
  source,
  curatedRecommendedRoleIds: roleIds,
});
const matchSettlementDecision = (input = {}) =>
  rawMatchSettlementDecision({
    scopeDigest: SCOPE_DIGEST,
    ...input,
  });
const planCuratedAdds = (input = {}) =>
  rawPlanCuratedAdds({
    scopeDigest: SCOPE_DIGEST,
    ...input,
  });
const lateMatchDecision = (input = {}) =>
  rawLateMatchDecision({
    scopeDigest: SCOPE_DIGEST,
    ...input,
  });
const mostRecentSuccessfulCallDecision = (calls = []) =>
  rawMostRecentSuccessfulCallDecision({
    scopeDigest: SCOPE_DIGEST,
    snapshotObservedAt: "2026-07-26T00:00:00.000Z",
    authoritative: true,
    complete: true,
    calls,
  });
const curatedPostAddMatchCount = (input = {}) =>
  rawCuratedPostAddMatchCount({
    scopeDigest: SCOPE_DIGEST,
    ...input,
  });
const targetOutcomeSequence = ({
  humanCall,
  matchCount,
  settlementDecision,
} = {}) => rawTargetOutcomeSequence({
  callDecision: selectedCallProof({ humanCall }),
  postAddReadback: postAddReadbackProof({ matchCount }),
  settlement: matchSettlementDecision({
    matchLegStartedAt: ANCHOR,
    observedAt: settlementDecision === "zero_settled"
      ? new Date(Date.parse(ANCHOR) + (30 * 60_000)).toISOString()
      : new Date(Date.parse(ANCHOR) + (5 * 60_000)).toISOString(),
    matchCount: settlementDecision === "zero_settled"
      ? 0
      : matchCount,
  }),
});
const phase3GateDecision = (input = {}) => {
  const decisionObservedAt =
    input.decisionObservedAt || "2026-07-26T00:00:00.000Z";
  const callDecision = Object.hasOwn(input, "callDecision")
    ? input.callDecision
    : selectedCallProof({ snapshotObservedAt: decisionObservedAt });
  const postAddReadback = Object.hasOwn(input, "postAddReadback")
    ? input.postAddReadback
    : postAddReadbackProof({
      matchCount: Number.isInteger(input.curationPlan?.targetCount)
        ? input.curationPlan.targetCount
        : 0,
      roleIds: roleIdsForPlanCount(
        input.curationPlan,
        Number.isInteger(input.curationPlan?.targetCount)
          ? input.curationPlan.targetCount
          : 0,
      ),
      source: input.curationReadbackVerified === true
        ? "authoritative"
        : "projected",
    });
  return rawPhase3GateDecision({
    scopeDigest: SCOPE_DIGEST,
    ...input,
    decisionObservedAt,
    callDecision,
    postAddReadback,
  });
};
const buildAggregateShadowAudit = (input = {}) => {
  const {
    humanCall = false,
    postAddMatchCount = 0,
    postAddMatchCountSource = "projected",
    gates: _ignoredGates,
    targetSequence: _ignoredTargetSequence,
    ...rest
  } = input;
  return rawBuildAggregateShadowAudit({
    scopeDigest: SCOPE_DIGEST,
    ...rest,
    callDecision: Object.hasOwn(input, "callDecision")
      ? input.callDecision
      : selectedCallProof({
        humanCall,
        snapshotObservedAt: input.observedAt,
      }),
    postAddReadback: Object.hasOwn(input, "postAddReadback")
      ? input.postAddReadback
      : postAddReadbackProof({
        matchCount: postAddMatchCount,
        source: postAddMatchCountSource,
        roleIds: roleIdsForPlanCount(
          input.curationPlan,
          postAddMatchCount,
        ),
      }),
  });
};
const atMinutes = (minutes) =>
  new Date(Date.parse(ANCHOR) + (minutes * 60_000)).toISOString();
const atHours = (hours) =>
  new Date(Date.parse(ANCHOR) + (hours * 60 * 60_000)).toISOString();
const membershipSnapshot = (memberships = [], overrides = {}) => ({
  scopeDigest: SCOPE_DIGEST,
  authoritative: true,
  complete: true,
  expectedTargetSequenceCount: ALL_OUTCOME_SEQUENCE_IDS.length,
  scannedTargetSequenceCount: ALL_OUTCOME_SEQUENCE_IDS.length,
  scannedTargetSequenceIds: [...ALL_OUTCOME_SEQUENCE_IDS],
  memberships,
  ...overrides,
});
const sequenceSnapshot = (overrides = {}) => ({
  authoritative: true,
  complete: true,
  sequences: Object.values(LIVE_OUTCOME_SEQUENCES_BY_ID).map((sequence) => ({
    id: sequence.id,
    name: sequence.expectedName,
    enabled: true,
  })),
  ...overrides,
});

test("match polling is anchored at five minutes through 30, then every 30 minutes", () => {
  assert.deepEqual(
    nextMatchPollDecision({
      matchLegStartedAt: ANCHOR,
      afterAt: ANCHOR,
    }),
    {
      phase: "initial",
      dueAt: atMinutes(5),
      cadenceMs: MATCH_INITIAL_POLL_MS,
      timeoutAt: atHours(24),
      complete: false,
    },
  );
  assert.equal(
    nextMatchPollDecision({
      matchLegStartedAt: ANCHOR,
      afterAt: atMinutes(25),
    }).dueAt,
    atMinutes(30),
  );
  assert.deepEqual(
    nextMatchPollDecision({
      matchLegStartedAt: ANCHOR,
      afterAt: atMinutes(30),
    }),
    {
      phase: "steady",
      dueAt: atMinutes(60),
      cadenceMs: MATCH_STEADY_POLL_MS,
      timeoutAt: atHours(24),
      complete: false,
    },
  );
  assert.equal(
    nextMatchPollDecision({
      matchLegStartedAt: ANCHOR,
      afterAt: atHours(23.5),
    }).dueAt,
    atHours(24),
  );
  assert.equal(
    nextMatchPollDecision({
      matchLegStartedAt: ANCHOR,
      afterAt: atHours(24),
    }).dueAt,
    null,
  );
});

test("late-match polling is a four-hour anchor grid through 24 hours", () => {
  assert.deepEqual(
    nextMatchPollDecision({
      matchLegStartedAt: ANCHOR,
      afterAt: atMinutes(30),
      lateMatchMode: true,
    }),
    {
      phase: "late",
      dueAt: atHours(4),
      cadenceMs: MATCH_LATE_POLL_MS,
      timeoutAt: atHours(24),
      complete: false,
    },
  );
  assert.equal(
    nextMatchPollDecision({
      matchLegStartedAt: ANCHOR,
      afterAt: atHours(20),
      lateMatchMode: true,
    }).dueAt,
    atHours(24),
  );
  assert.equal(
    nextMatchPollDecision({
      matchLegStartedAt: ANCHOR,
      afterAt: atHours(24),
      lateMatchMode: true,
    }).complete,
    true,
  );
});

test("zero settles only at or after 30 minutes and unresolved generation times out at 24 hours", () => {
  assert.equal(
    matchSettlementDecision({
      matchLegStartedAt: ANCHOR,
      observedAt: atMinutes(29),
      matchCount: 0,
    }).decision,
    "pending_zero",
  );
  const zero = matchSettlementDecision({
    matchLegStartedAt: ANCHOR,
    observedAt: atMinutes(30),
    matchCount: 0,
  });
  assert.equal(zero.decision, "zero_settled");
  assert.equal(zero.useLateMatchCadence, true);

  assert.equal(
    matchSettlementDecision({
      matchLegStartedAt: ANCHOR,
      observedAt: atHours(24),
      matchCount: null,
    }).decision,
    "timeout",
  );
  assert.equal(
    matchSettlementDecision({
      matchLegStartedAt: ANCHOR,
      observedAt: atHours(24),
      matchCount: 2,
    }).decision,
    "matches_settled",
  );
  for (const matchCount of [null, 0, 2]) {
    assert.equal(
      matchSettlementDecision({
        matchLegStartedAt: ANCHOR,
        observedAt: atHours(25),
        matchCount,
      }).decision,
      "timeout",
    );
  }
  const forgedLateSettlement = {
    ...matchSettlementDecision({
      matchLegStartedAt: ANCHOR,
      observedAt: atHours(24),
      matchCount: 1,
    }),
    elapsedMs: 25 * 60 * 60_000,
  };
  assert.throws(
    () => rawTargetOutcomeSequence({
      callDecision: selectedCallProof(),
      postAddReadback: postAddReadbackProof({ matchCount: 1 }),
      settlement: forgedLateSettlement,
    }),
    /settled match proof/,
  );
});

test("stage enable reanchors placeholders but preserves genuine run anchors", () => {
  const base = {
    stageEnabledAt: "2026-07-25T12:00:00.000Z",
    submittedAt: "2026-07-24T12:00:00.000Z",
    state: "awaiting_matches",
    submitReadbackVerified: true,
    matchLegPreviouslyRun: false,
  };
  assert.deepEqual(stageEnableReanchorDecision(base), {
    action: "reanchor",
    state: "awaiting_matches",
    matchLegStartedAt: base.stageEnabledAt,
  });
  assert.equal(
    stageEnableReanchorDecision({
      ...base,
      matchLegStartedAt: "2026-07-24T12:01:00.000Z",
    }).action,
    "reanchor",
  );
  assert.deepEqual(
    stageEnableReanchorDecision({
      ...base,
      matchLegStartedAt: "2026-07-24T12:01:00.000Z",
      matchLegPreviouslyRun: true,
    }),
    {
      action: "keep_existing_anchor",
      state: "awaiting_matches",
      matchLegStartedAt: "2026-07-24T12:01:00.000Z",
    },
  );
  assert.equal(
    stageEnableReanchorDecision({
      ...base,
      submitReadbackVerified: false,
    }).action,
    "wait_for_submit_readback",
  );
  assert.equal(
    stageEnableReanchorDecision({
      ...base,
      submittedAt: "2026-07-25T12:01:00.000Z",
    }).action,
    "skip_post_enable_submission",
  );
  assert.equal(
    stageEnableReanchorDecision({
      ...base,
      state: "enrolled",
      submittedAt: "not-a-time",
      matchLegStartedAt: "2026-07-24T12:01:00.000Z",
    }).action,
    "skip_terminal",
  );
  assert.equal(
    stageEnableReanchorDecision({
      ...base,
      state: "enrolled",
      submittedAt: "not-a-time",
      matchLegStartedAt: "2026-07-24T12:01:00.000Z",
    }).matchLegStartedAt,
    "2026-07-24T12:01:00.000Z",
  );
  assert.equal(
    stageEnableReanchorDecision({
      ...base,
      matchLegPreviouslyRun: true,
    }).action,
    "skip_previously_run",
  );
  assert.equal(
    stageEnableReanchorDecision({
      ...base,
      submittedAt: null,
      returningCandidate: true,
    }).action,
    "reanchor",
  );
  assert.equal(
    stageEnableReanchorDecision({
      ...base,
      submittedAt: null,
    }).action,
    "wait_for_submitted_timestamp",
  );
  for (const state of [
    "ready_to_submit",
    "awaiting_approval",
    "needs_review",
  ]) {
    assert.equal(
      stageEnableReanchorDecision({
        ...base,
        state,
        submittedAt: null,
        submitReadbackVerified: false,
        matchLegStartedAt: "2026-07-25T12:01:00.000Z",
      }).action,
      "skip_unrecognized_state",
    );
  }
  assert.equal(
    stageEnableReanchorDecision({
      ...base,
      submitReadbackVerified: false,
      matchLegStartedAt: "2026-07-25T12:01:00.000Z",
    }).action,
    "wait_for_submit_readback",
  );
  assert.equal(
    stageEnableReanchorDecision({
      ...base,
      submittedAt: null,
      matchLegStartedAt: "2026-07-25T12:01:00.000Z",
    }).action,
    "wait_for_submitted_timestamp",
  );
  for (const state of [
    "awaiting_approval",
    "ready_to_enroll",
    "needs_review",
  ]) {
    assert.equal(
      stageEnableReanchorDecision({
        ...base,
        state,
      }).action,
      "skip_unrecognized_state",
    );
  }
  assert.throws(
    () => stageEnableReanchorDecision({
      ...base,
      matchLegPreviouslyRun: undefined,
    }),
    /matchLegPreviouslyRun must be a boolean/,
  );
});

test("sequence health requires all five enabled IDs and treats names as warnings", () => {
  const healthy = outcomeSequenceHealthDecision(sequenceSnapshot());
  assert.equal(healthy.healthy, true);
  assert.equal(healthy.expectedCount, 5);
  assert.equal(healthy.enabledCount, 5);

  const rows = sequenceSnapshot().sequences;
  const missing = outcomeSequenceHealthDecision(sequenceSnapshot({
    sequences: rows.slice(1),
  }));
  assert.equal(missing.healthy, false);
  assert.equal(missing.missingCount, 1);

  const disabled = outcomeSequenceHealthDecision(sequenceSnapshot({
    sequences: rows.map((row, index) => (
      index === 0 ? { ...row, enabled: false } : row
    )),
  }));
  assert.equal(disabled.healthy, false);
  assert.equal(disabled.disabledCount, 1);

  const renamed = outcomeSequenceHealthDecision(sequenceSnapshot({
    sequences: rows.map((row, index) => (
      index === 0 ? { ...row, name: "Operator-edited display name" } : row
    )),
  }));
  assert.equal(renamed.healthy, true);
  assert.equal(renamed.nameDriftCount, 1);
  assert.deepEqual(renamed.nameDriftIds, [rows[0].id]);
});

test("shadow and sequence health jointly constrain the complete gate lattice", () => {
  const sequenceHealth = outcomeSequenceHealthDecision(sequenceSnapshot());
  const settlement = matchSettlementDecision({
    matchLegStartedAt: ANCHOR,
    observedAt: atMinutes(5),
    matchCount: 1,
  });
  const curationPlan = planCuratedAdds({
    recommendedRoleIds: ["gate-role"],
    curatedRoleIds: ["gate-role"],
  });
  const membership = outcomeMembershipDecision(membershipSnapshot());
  const normalLateMatch = lateMatchDecision({
    noMatchesEnrollmentRecorded: false,
    recommendedRoleIds: ["gate-role"],
    curatedRoleIds: ["gate-role"],
  });
  const completeProofs = {
    sequenceHealth,
    settlement,
    curationPlan,
    membership,
    reconciliation: null,
    lateMatch: normalLateMatch,
  };
  for (const matchStageEnabled of [false, true]) {
    for (const matchShadow of [false, true]) {
      for (const curateEnabled of [false, true]) {
        for (const enrollApproved of [false, true]) {
          for (const curationReadbackVerified of [false, true]) {
            const decision = phase3GateDecision({
              matchStageEnabled,
              matchShadow,
              curateEnabled,
              enrollApproved,
              curationReadbackVerified,
              ...completeProofs,
            });
            const curateExpected =
              matchStageEnabled && !matchShadow && curateEnabled;
            const enrollExpected =
              curateExpected && enrollApproved && curationReadbackVerified;
            assert.equal(decision.allowCuratedWrite, curateExpected);
            assert.equal(decision.allowEnrollment, enrollExpected);
            if (matchShadow) {
              assert.equal(decision.candidateFacingWritesAllowed, false);
            }
          }
        }
      }
    }
  }

  const blocked = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    ...completeProofs,
    sequenceHealth: outcomeSequenceHealthDecision(sequenceSnapshot({
      sequences: sequenceSnapshot().sequences.slice(1),
    })),
  });
  assert.equal(blocked.allowCuratedWrite, true);
  assert.equal(blocked.allowEnrollment, false);
  assert.equal(blocked.sequenceHealthHealthy, false);
  assert.equal(
    blocked.ignoredWriteFlags.includes("enroll_without_healthy_sequences"),
    true,
  );

  const forgedHealthBlocked = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    ...completeProofs,
    sequenceHealth: { healthy: true },
  });
  assert.equal(forgedHealthBlocked.sequenceHealthHealthy, false);
  assert.equal(forgedHealthBlocked.allowEnrollment, false);

  const renamedRows = sequenceSnapshot().sequences.map((row, index) => (
    index === 0 ? { ...row, name: "Renamed but ID-stable" } : row
  ));
  const nameDriftAllowed = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    ...completeProofs,
    sequenceHealth: outcomeSequenceHealthDecision(sequenceSnapshot({
      sequences: renamedRows,
    })),
  });
  assert.equal(nameDriftAllowed.sequenceHealthHealthy, true);
  assert.equal(nameDriftAllowed.allowEnrollment, true);

  const activeMembership = outcomeMembershipDecision(membershipSnapshot([
    {
      sequenceId: ALL_OUTCOME_SEQUENCE_IDS[0],
      lifecycle: "active",
      hasReplied: false,
    },
  ]));
  const membershipBlocked = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    ...completeProofs,
    membership: activeMembership,
  });
  assert.equal(membershipBlocked.allowEnrollment, false);
  assert.equal(membershipBlocked.membershipAllowsEnrollment, false);
  assert.equal(
    membershipBlocked.ignoredWriteFlags.includes(
      "enroll_without_safe_membership",
    ),
    true,
  );

  const missingPlan = planCuratedAdds({
    recommendedRoleIds: ["missing-role"],
  });
  const missingPlanLateMatch = lateMatchDecision({
    noMatchesEnrollmentRecorded: false,
    recommendedRoleIds: ["missing-role"],
  });
  const unsettledReconciliation = curatedWriteReconciliationDecision({
    plan: missingPlan,
    mutationOutcome: "unknown",
    readbackState: "unsettled",
    curatedRoleIds: [],
    attemptCount: 1,
    maxAttempts: 3,
  });
  const reconciliationBlocked = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    ...completeProofs,
    curationPlan: missingPlan,
    reconciliation: unsettledReconciliation,
    lateMatch: missingPlanLateMatch,
  });
  assert.equal(reconciliationBlocked.reconciliationRequired, true);
  assert.equal(reconciliationBlocked.reconciliationAllowsEnrollment, false);
  assert.equal(reconciliationBlocked.allowEnrollment, false);

  const verifiedReconciliation = curatedWriteReconciliationDecision({
    plan: missingPlan,
    mutationOutcome: "accepted",
    readbackState: "authoritative",
    curatedRoleIds: ["missing-role"],
    attemptCount: 1,
    maxAttempts: 3,
  });
  const reconciliationAllowed = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    ...completeProofs,
    curationPlan: missingPlan,
    reconciliation: verifiedReconciliation,
    lateMatch: missingPlanLateMatch,
  });
  assert.equal(reconciliationAllowed.reconciliationRequired, true);
  assert.equal(reconciliationAllowed.reconciliationAllowsEnrollment, true);
  assert.equal(reconciliationAllowed.allowEnrollment, true);

  const lateMatchBlocked = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    ...completeProofs,
    curationPlan: missingPlan,
    reconciliation: verifiedReconciliation,
    lateMatch: lateMatchDecision({
      noMatchesEnrollmentRecorded: true,
      recommendedRoleIds: ["missing-role"],
    }),
  });
  assert.equal(lateMatchBlocked.allowCuratedWrite, true);
  assert.equal(lateMatchBlocked.lateMatchDetected, true);
  assert.equal(lateMatchBlocked.lateMatchAllowsEnrollment, false);
  assert.equal(lateMatchBlocked.allowEnrollment, false);

  const emptyPlan = planCuratedAdds();
  const settlementPlanMismatch = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    ...completeProofs,
    curationPlan: emptyPlan,
    lateMatch: lateMatchDecision({
      noMatchesEnrollmentRecorded: false,
    }),
  });
  assert.equal(settlementPlanMismatch.settlementCurationBound, false);
  assert.equal(settlementPlanMismatch.allowEnrollment, false);

  const zeroSettlementPlanMismatch = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    ...completeProofs,
    settlement: matchSettlementDecision({
      matchLegStartedAt: ANCHOR,
      observedAt: atMinutes(30),
      matchCount: 0,
    }),
  });
  assert.equal(zeroSettlementPlanMismatch.settlementCurationBound, false);
  assert.equal(zeroSettlementPlanMismatch.allowEnrollment, false);

  const alreadyPresentPlan = planCuratedAdds({
    recommendedRoleIds: ["missing-role"],
    curatedRoleIds: ["missing-role"],
  });
  const staleSameTargetReconciliation = curatedWriteReconciliationDecision({
    plan: alreadyPresentPlan,
    mutationOutcome: "accepted",
    readbackState: "authoritative",
    curatedRoleIds: ["missing-role"],
    attemptCount: 1,
    maxAttempts: 3,
  });
  const staleReconciliationBlocked = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    ...completeProofs,
    curationPlan: missingPlan,
    reconciliation: staleSameTargetReconciliation,
    lateMatch: missingPlanLateMatch,
  });
  assert.equal(staleReconciliationBlocked.reconciliationRequired, true);
  assert.equal(
    staleReconciliationBlocked.reconciliationAllowsEnrollment,
    false,
  );
  assert.equal(staleReconciliationBlocked.allowEnrollment, false);

  const forgedTierPlan = {
    ...emptyPlan,
    recommendedRoleIds: ["silently-omitted-role"],
    recommendedCount: 1,
  };
  const forgedTierPlanBlocked = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    ...completeProofs,
    curationPlan: forgedTierPlan,
  });
  assert.equal(forgedTierPlanBlocked.curationPlanHealthy, false);
  assert.equal(forgedTierPlanBlocked.allowEnrollment, false);

  const otherScopeMembership = outcomeMembershipDecision(
    membershipSnapshot([], { scopeDigest: OTHER_SCOPE_DIGEST }),
  );
  const crossScopeMembershipBlocked = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    ...completeProofs,
    membership: otherScopeMembership,
  });
  assert.equal(crossScopeMembershipBlocked.proofScopeBound, false);
  assert.equal(crossScopeMembershipBlocked.allowEnrollment, false);

  const otherScopePlan = rawPlanCuratedAdds({
    scopeDigest: OTHER_SCOPE_DIGEST,
    recommendedRoleIds: ["other-run-role"],
  });
  const otherScopeLateMatch = rawLateMatchDecision({
    scopeDigest: OTHER_SCOPE_DIGEST,
    noMatchesEnrollmentRecorded: false,
    recommendedRoleIds: ["other-run-role"],
  });
  const otherScopeReconciliation = curatedWriteReconciliationDecision({
    plan: otherScopePlan,
    mutationOutcome: "accepted",
    readbackState: "authoritative",
    curatedRoleIds: ["other-run-role"],
    attemptCount: 1,
    maxAttempts: 3,
  });
  const crossScopeBundleBlocked = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    ...completeProofs,
    curationPlan: otherScopePlan,
    lateMatch: otherScopeLateMatch,
    reconciliation: otherScopeReconciliation,
  });
  assert.equal(crossScopeBundleBlocked.proofScopeBound, false);
  assert.equal(crossScopeBundleBlocked.allowCuratedWrite, false);
  assert.equal(crossScopeBundleBlocked.allowEnrollment, false);
});

test("partial-add planning deduplicates tiers and sends only missing roles", () => {
  const plan = planCuratedAdds({
    recommendedRoleIds: ["rec-1", "rec-2", "rec-1"],
    possibleRoleIds: ["possible-1", "rec-2"],
    curatedRoleIds: ["rec-1", "unrelated"],
  });
  assert.deepEqual(plan.targetRoleIds, ["rec-1", "rec-2", "possible-1"]);
  assert.deepEqual(plan.presentTargetRoleIds, ["rec-1"]);
  assert.deepEqual(plan.missingRoleIds, ["rec-2", "possible-1"]);
  assert.deepEqual(plan.tierOverlapRoleIds, ["rec-2"]);
  assert.equal(plan.targetCount, 3);
  assert.equal(plan.expectedTargetReadbackCount, 3);
  assert.equal(Object.hasOwn(plan, "expectedReadbackCount"), false);
});

test("returning candidate sequence count includes prior-call curated roles with zero new adds", () => {
  const plan = planCuratedAdds({
    recommendedRoleIds: ["prior-rec"],
    possibleRoleIds: ["prior-possible"],
    curatedRoleIds: ["prior-rec", "prior-possible"],
  });
  assert.equal(plan.missingCount, 0);

  const postAddReadback = curatedPostAddMatchCount({
    source: "authoritative",
    curatedRecommendedRoleIds: ["prior-rec"],
    curatedPossibleRoleIds: ["prior-possible", "prior-rec"],
  });
  assert.equal(postAddReadback.matchCount, 2);
  assert.equal(postAddReadback.authoritative, true);
  assert.equal(
    targetOutcomeSequence({
      humanCall: false,
      matchCount: postAddReadback.matchCount,
      settlementDecision: "matches_settled",
    }).id,
    "vw168sypaoagu5j5g209cps3",
  );
});

test("unknown and accepted write responses are readback-only until authoritative reconciliation", () => {
  const plan = planCuratedAdds({
    recommendedRoleIds: ["rec-1"],
    possibleRoleIds: ["possible-1"],
    curatedRoleIds: [],
  });
  const unknown = curatedWriteReconciliationDecision({
    plan,
    mutationOutcome: "unknown",
    readbackState: "unsettled",
    curatedRoleIds: ["rec-1"],
    attemptCount: 1,
    maxAttempts: 3,
  });
  assert.equal(unknown.action, "readback_only");
  assert.equal(unknown.retryOriginalSetAllowed, false);
  assert.equal(unknown.externalWriteMayHaveLanded, true);

  const partial = curatedWriteReconciliationDecision({
    plan,
    mutationOutcome: "unknown",
    readbackState: "authoritative",
    curatedRoleIds: ["rec-1"],
    attemptCount: 1,
    maxAttempts: 3,
  });
  assert.equal(partial.action, "plan_missing_only");
  assert.equal(partial.missingOnlyPlanAllowed, true);
  assert.deepEqual(partial.missingRoleIds, ["possible-1"]);
  assert.equal(partial.retryOriginalSetAllowed, false);

  const verified = curatedWriteReconciliationDecision({
    plan,
    mutationOutcome: "accepted",
    readbackState: "authoritative",
    curatedRoleIds: ["rec-1", "possible-1"],
    attemptCount: 1,
    maxAttempts: 3,
  });
  assert.equal(verified.action, "verified");
  assert.equal(verified.missingCount, 0);
  assert.equal(verified.enrollmentBlocked, false);
});

test("repeated partial curated writes stop at the retry ceiling and block enrollment", () => {
  const plan = planCuratedAdds({
    recommendedRoleIds: ["rec-1"],
    possibleRoleIds: ["possible-1"],
  });
  const firstPartial = curatedWriteReconciliationDecision({
    plan,
    mutationOutcome: "accepted",
    readbackState: "authoritative",
    curatedRoleIds: ["rec-1"],
    attemptCount: 1,
    maxAttempts: 2,
  });
  assert.equal(firstPartial.action, "plan_missing_only");
  assert.equal(firstPartial.attemptsRemaining, 1);
  assert.equal(firstPartial.enrollmentBlocked, true);

  const exhausted = curatedWriteReconciliationDecision({
    plan,
    mutationOutcome: "accepted",
    readbackState: "authoritative",
    curatedRoleIds: ["rec-1"],
    attemptCount: 2,
    maxAttempts: 2,
  });
  assert.equal(exhausted.action, "review_exhausted");
  assert.equal(exhausted.missingOnlyPlanAllowed, false);
  assert.equal(exhausted.attemptsRemaining, 0);
  assert.equal(exhausted.enrollmentBlocked, true);

  const verifiedAtCeiling = curatedWriteReconciliationDecision({
    plan,
    mutationOutcome: "accepted",
    readbackState: "authoritative",
    curatedRoleIds: ["rec-1", "possible-1"],
    attemptCount: 2,
    maxAttempts: 2,
  });
  assert.equal(verifiedAtCeiling.action, "verified");
  assert.equal(verifiedAtCeiling.enrollmentBlocked, false);
});

test("late matches after No-Matches permit curation but never a second enrollment", () => {
  const decision = lateMatchDecision({
    noMatchesEnrollmentRecorded: true,
    recommendedRoleIds: ["late-1"],
    possibleRoleIds: ["late-2"],
    curatedRoleIds: ["late-1"],
  });
  assert.equal(decision.detected, true);
  assert.deepEqual(decision.curationPlan.missingRoleIds, ["late-2"]);
  assert.equal(decision.allowSecondEnrollment, false);
  assert.equal(decision.enrollmentAction, "none");
  assert.equal(
    decision.reviewNoteCode,
    LATE_MATCH_REVIEW_NOTE_CODE,
  );
  assert.equal(decision.shouldAddReviewNote, true);

  const deduped = lateMatchDecision({
    noMatchesEnrollmentRecorded: true,
    recommendedRoleIds: ["late-1"],
    existingReviewNoteCodes: [LATE_MATCH_REVIEW_NOTE_CODE],
  });
  assert.equal(deduped.detected, true);
  assert.equal(deduped.shouldAddReviewNote, false);
});

test("the sequence contract is ID-first with five live and seven dedup IDs", () => {
  assert.equal(Object.keys(LIVE_OUTCOME_SEQUENCES_BY_ID).length, 5);
  assert.equal(RETIRED_OUTCOME_SEQUENCE_IDS.length, 2);
  assert.equal(new Set(ALL_OUTCOME_SEQUENCE_IDS).size, 7);

  assert.equal(
    targetOutcomeSequence({
      humanCall: false,
      matchCount: 1,
      settlementDecision: "matches_settled",
    }).id,
    "cmqk75h7x00030bj8f5s6oaw8",
  );
  assert.equal(
    targetOutcomeSequence({
      humanCall: false,
      matchCount: 2,
      settlementDecision: "matches_settled",
    }).id,
    "vw168sypaoagu5j5g209cps3",
  );
  assert.equal(
    targetOutcomeSequence({
      humanCall: true,
      matchCount: 1,
      settlementDecision: "matches_settled",
    }).id,
    "u5zsfwujwasmmcufdmzem08f",
  );
  assert.equal(
    targetOutcomeSequence({
      humanCall: true,
      matchCount: 8,
      settlementDecision: "matches_settled",
    }).id,
    "v0ua934p012p3lwpg7610wcz",
  );
  assert.equal(
    targetOutcomeSequence({
      humanCall: true,
      matchCount: 8,
      settlementDecision: "zero_settled",
    }).id,
    "cmqpje4lh00040cki15nuuqc8",
  );
});

test("the shadow sequence ID/name contract does not drift from runtime rules", () => {
  const comparable = (rows) => rows
    .map(({ id, expectedName }) => ({ id, expectedName }))
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(
    comparable(Object.values(LIVE_OUTCOME_SEQUENCES_BY_ID)),
    comparable(OUTCOME_SEQUENCE_RULES),
  );
});

test("most recent successful call ignores newer failures and reviews conflicting ties", () => {
  assert.deepEqual(
    mostRecentSuccessfulCallDecision([
      {
        endedAt: atMinutes(5),
        successful: true,
        humanCall: false,
        candidateId: "must-not-escape",
      },
      {
        endedAt: "failed-call-time-is-irrelevant",
        successful: false,
        humanCall: false,
      },
      {
        endedAt: atMinutes(10),
        successful: true,
        humanCall: true,
      },
    ]),
    {
      scopeDigest: SCOPE_DIGEST,
      snapshotObservedAt: "2026-07-26T00:00:00.000Z",
      snapshotAuthoritative: true,
      snapshotComplete: true,
      scannedCallCount: 3,
      decision: "selected",
      endedAt: atMinutes(10),
      humanCall: true,
      callType: "human",
    },
  );
  assert.deepEqual(
    mostRecentSuccessfulCallDecision([
      { endedAt: atMinutes(10), successful: true, humanCall: false },
      { endedAt: atMinutes(10), successful: true, humanCall: true },
    ]),
    {
      scopeDigest: SCOPE_DIGEST,
      snapshotObservedAt: "2026-07-26T00:00:00.000Z",
      snapshotAuthoritative: true,
      snapshotComplete: true,
      scannedCallCount: 2,
      decision: "review_ambiguous_tie",
      endedAt: atMinutes(10),
      humanCall: null,
      callType: null,
    },
  );
  const incomplete = rawMostRecentSuccessfulCallDecision({
    scopeDigest: SCOPE_DIGEST,
    snapshotObservedAt: atMinutes(15),
    authoritative: true,
    complete: false,
    calls: [
      { endedAt: atMinutes(5), successful: true, humanCall: true },
    ],
  });
  assert.equal(incomplete.decision, "review_incomplete_snapshot");
  assert.equal(incomplete.humanCall, null);
  const complete = rawMostRecentSuccessfulCallDecision({
    scopeDigest: SCOPE_DIGEST,
    snapshotObservedAt: atMinutes(15),
    authoritative: true,
    complete: true,
    calls: [
      { endedAt: atMinutes(5), successful: true, humanCall: true },
      { endedAt: atMinutes(10), successful: true, humanCall: false },
    ],
  });
  assert.equal(complete.decision, "selected");
  assert.equal(complete.callType, "agent");
  assert.throws(
    () => rawTargetOutcomeSequence({
      callDecision: incomplete,
      postAddReadback: postAddReadbackProof({ matchCount: 1 }),
      settlement: matchSettlementDecision({
        matchLegStartedAt: ANCHOR,
        observedAt: atMinutes(5),
        matchCount: 1,
      }),
    }),
    /selected successful-call proof/,
  );
});

test("call and post-add proofs cannot be relabeled across run scopes", () => {
  const settlement = matchSettlementDecision({
    matchLegStartedAt: ANCHOR,
    observedAt: atMinutes(5),
    matchCount: 1,
  });
  const callA = selectedCallProof({
    humanCall: false,
    snapshotObservedAt: atMinutes(5),
  });
  const postAddA = postAddReadbackProof({
    matchCount: 1,
    source: "authoritative",
    roleIds: ["scope-role"],
  });
  const callB = selectedCallProof({
    scopeDigest: OTHER_SCOPE_DIGEST,
    humanCall: true,
    snapshotObservedAt: atMinutes(5),
  });
  const postAddB = postAddReadbackProof({
    scopeDigest: OTHER_SCOPE_DIGEST,
    matchCount: 2,
    source: "authoritative",
  });
  assert.equal(Object.isFrozen(callA), true);
  assert.equal(Object.isFrozen(postAddA), true);
  assert.equal(
    rawTargetOutcomeSequence({
      callDecision: callA,
      postAddReadback: postAddA,
      settlement,
    }).id,
    "cmqk75h7x00030bj8f5s6oaw8",
  );
  for (const mixed of [
    { callDecision: callB, postAddReadback: postAddA },
    { callDecision: callA, postAddReadback: postAddB },
  ]) {
    assert.throws(
      () => rawTargetOutcomeSequence({
        ...mixed,
        settlement,
      }),
      /one opaque run scope/,
    );
  }

  const curationPlan = planCuratedAdds({
    recommendedRoleIds: ["scope-role"],
    curatedRoleIds: ["scope-role"],
  });
  const membership = outcomeMembershipDecision(membershipSnapshot());
  const lateMatch = lateMatchDecision({
    noMatchesEnrollmentRecorded: false,
    recommendedRoleIds: ["scope-role"],
    curatedRoleIds: ["scope-role"],
  });
  const commonGateInputs = {
    scopeDigest: SCOPE_DIGEST,
    decisionObservedAt: atMinutes(5),
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    sequenceHealth: outcomeSequenceHealthDecision(sequenceSnapshot()),
    settlement,
    curationPlan,
    membership,
    reconciliation: null,
    lateMatch,
  };
  const gates = rawPhase3GateDecision({
    ...commonGateInputs,
    callDecision: callA,
    postAddReadback: postAddA,
  });
  assert.equal(gates.allowEnrollment, true);
  const staleCallGates = rawPhase3GateDecision({
    ...commonGateInputs,
    decisionObservedAt: atMinutes(60),
    callDecision: selectedCallProof({
      snapshotObservedAt: atMinutes(10),
    }),
    postAddReadback: postAddA,
  });
  assert.equal(staleCallGates.callSnapshotCurrent, false);
  assert.equal(staleCallGates.allowCuratedWrite, false);
  assert.equal(staleCallGates.allowEnrollment, false);
  const futureCallGates = rawPhase3GateDecision({
    ...commonGateInputs,
    callDecision: selectedCallProof({
      snapshotObservedAt: atMinutes(10),
    }),
    postAddReadback: postAddA,
  });
  assert.equal(futureCallGates.callSnapshotCurrent, false);
  assert.equal(futureCallGates.allowEnrollment, false);
  const crossCallGates = rawPhase3GateDecision({
    ...commonGateInputs,
    callDecision: callB,
    postAddReadback: postAddA,
  });
  assert.equal(crossCallGates.allowCuratedWrite, false);
  assert.equal(crossCallGates.allowEnrollment, false);
  const crossPostAddGates = rawPhase3GateDecision({
    ...commonGateInputs,
    callDecision: callA,
    postAddReadback: postAddB,
  });
  assert.equal(crossPostAddGates.allowCuratedWrite, false);
  assert.equal(crossPostAddGates.allowEnrollment, false);
  const contradictoryPostAdd = postAddReadbackProof({
    matchCount: 1,
    source: "authoritative",
    roleIds: ["unrelated-same-scope-role"],
  });
  const contradictoryPostAddGates = rawPhase3GateDecision({
    ...commonGateInputs,
    callDecision: callA,
    postAddReadback: contradictoryPostAdd,
  });
  assert.equal(contradictoryPostAddGates.postAddCurationBound, false);
  assert.equal(contradictoryPostAddGates.allowCuratedWrite, false);
  assert.equal(contradictoryPostAddGates.allowEnrollment, false);

  const auditInputs = {
    scopeDigest: SCOPE_DIGEST,
    observedAt: atMinutes(5),
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    sequenceHealth: commonGateInputs.sequenceHealth,
    settlement,
    curationPlan,
    callDecision: callA,
    postAddReadback: postAddA,
    membership,
    reconciliation: null,
    lateMatch,
  };
  const audit = rawBuildAggregateShadowAudit(auditInputs);
  for (const mixed of [
    { callDecision: callB, postAddReadback: postAddA },
    { callDecision: callA, postAddReadback: postAddB },
    { callDecision: callB, postAddReadback: postAddB },
  ]) {
    assert.throws(
      () => rawBuildAggregateShadowAudit({
        ...auditInputs,
        ...mixed,
      }),
      /call and post-add proofs must match/,
    );
  }
  assert.throws(
    () => rawBuildAggregateShadowAudit({
      ...auditInputs,
      postAddReadback: contradictoryPostAdd,
    }),
    /contain every curation target role/,
  );
  assert.throws(
    () => rawBuildAggregateShadowAudit({
      ...auditInputs,
      callDecision: undefined,
      postAddReadback: undefined,
      humanCall: true,
      postAddMatchCount: 2,
      callScopeDigest: SCOPE_DIGEST,
      postAddScopeDigest: SCOPE_DIGEST,
    }),
    /selected successful-call proof/,
  );
  assert.equal(JSON.stringify(audit).includes(SCOPE_DIGEST), false);
  assert.equal(JSON.stringify(audit).includes("scope-role"), false);
});

test("membership requires an authoritative complete snapshot and fails closed", () => {
  const liveId = targetOutcomeSequence({
    humanCall: false,
    matchCount: 1,
    settlementDecision: "matches_settled",
  }).id;
  assert.equal(
    outcomeMembershipDecision(membershipSnapshot([
      { sequenceId: liveId, lifecycle: "completed", hasReplied: false },
    ])).decision,
    "allow",
  );
  const active = outcomeMembershipDecision(membershipSnapshot([
    { sequenceId: liveId, lifecycle: "active", hasReplied: false },
  ]));
  assert.equal(active.decision, "skip_active");
  assert.equal(active.skipWithoutReview, true);

  assert.equal(
    outcomeMembershipDecision(membershipSnapshot([
      { sequenceId: liveId, lifecycle: "completed", hasReplied: true },
    ])).decision,
    "block_replied",
  );
  assert.equal(
    outcomeMembershipDecision(membershipSnapshot([
      { sequenceId: liveId, lifecycle: "completed", hasReplied: true },
      { sequenceId: liveId, lifecycle: "active" },
    ])).decision,
    "block_replied",
  );
  assert.equal(
    outcomeMembershipDecision(membershipSnapshot([
      { sequenceId: liveId, lifecycle: "mystery", hasReplied: false },
    ])).decision,
    "review_unknown_lifecycle",
  );
  assert.equal(
    outcomeMembershipDecision(membershipSnapshot([
      { sequenceId: liveId, lifecycle: "active", hasReplied: false },
      { sequenceId: liveId, lifecycle: "mystery", hasReplied: false },
    ])).decision,
    "review_unknown_lifecycle",
  );
  assert.equal(
    outcomeMembershipDecision(membershipSnapshot([
      { sequenceId: "unrelated-sequence", lifecycle: "active", hasReplied: true },
    ])).decision,
    "allow",
  );
  assert.equal(
    outcomeMembershipDecision(membershipSnapshot([
      { sequenceId: liveId, lifecycle: "active" },
    ])).decision,
    "review_malformed_membership",
  );

  const incomplete = outcomeMembershipDecision(membershipSnapshot(
    [{ sequenceId: liveId, lifecycle: "completed", hasReplied: false }],
    { complete: false },
  ));
  assert.equal(incomplete.decision, "review_incomplete_snapshot");
  assert.equal(incomplete.blockEnrollment, true);
  assert.equal(incomplete.targetMembershipCount, 0);

  const bareComplete = outcomeMembershipDecision({
    scopeDigest: SCOPE_DIGEST,
    authoritative: true,
    complete: true,
    memberships: [],
  });
  assert.equal(bareComplete.decision, "review_incomplete_snapshot");
  assert.equal(bareComplete.targetSequenceCoverageComplete, false);

  const incompleteCoverage = outcomeMembershipDecision(membershipSnapshot(
    [],
    { scannedTargetSequenceCount: ALL_OUTCOME_SEQUENCE_IDS.length - 1 },
  ));
  assert.equal(incompleteCoverage.decision, "review_incomplete_snapshot");
  assert.equal(incompleteCoverage.blockEnrollment, true);
  assert.equal(incompleteCoverage.scannedTargetSequenceCount, 6);
  assert.equal(incompleteCoverage.targetSequenceCoverageComplete, false);

  const duplicateCoverageIds = [
    ...ALL_OUTCOME_SEQUENCE_IDS.slice(0, -1),
    ALL_OUTCOME_SEQUENCE_IDS[0],
  ];
  const duplicateCoverage = outcomeMembershipDecision(membershipSnapshot(
    [],
    { scannedTargetSequenceIds: duplicateCoverageIds },
  ));
  assert.equal(duplicateCoverage.decision, "review_incomplete_snapshot");
  assert.equal(duplicateCoverage.scannedTargetSequenceDuplicateCount, 1);
  assert.equal(duplicateCoverage.scannedTargetSequenceMissingCount, 1);
  assert.equal(duplicateCoverage.targetSequenceCoverageComplete, false);

  const wrongCoverageIds = [
    ...ALL_OUTCOME_SEQUENCE_IDS.slice(0, -1),
    "unrelated-sequence",
  ];
  const wrongCoverage = outcomeMembershipDecision(membershipSnapshot(
    [],
    { scannedTargetSequenceIds: wrongCoverageIds },
  ));
  assert.equal(wrongCoverage.decision, "review_incomplete_snapshot");
  assert.equal(wrongCoverage.scannedTargetSequenceUnknownCount, 1);
  assert.equal(wrongCoverage.scannedTargetSequenceMissingCount, 1);
  assert.equal(wrongCoverage.targetSequenceCoverageComplete, false);

  assert.throws(
    () => outcomeMembershipDecision(),
    /membership snapshot/,
  );
});

test("aggregate audit allowlists counts and cannot leak candidate or role values", () => {
  const settlement = matchSettlementDecision({
    matchLegStartedAt: ANCHOR,
    observedAt: atMinutes(30),
    matchCount: 2,
  });
  const curationPlan = {
    ...planCuratedAdds({
      recommendedRoleIds: ["role-secret-a"],
      possibleRoleIds: ["role-secret-b"],
      curatedRoleIds: [],
    }),
    candidateName: "candidate-secret",
    candidateEmail: "candidate-secret@example.test",
  };
  const membership = outcomeMembershipDecision(membershipSnapshot());
  const lateMatch = {
    ...lateMatchDecision({
      noMatchesEnrollmentRecorded: false,
      recommendedRoleIds: ["role-secret-a"],
      possibleRoleIds: ["role-secret-b"],
      curatedRoleIds: [],
    }),
    arbitraryRoleId: "late-role-secret",
  };
  const sequenceHealth = outcomeSequenceHealthDecision(sequenceSnapshot());
  const gates = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: true,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: false,
    sequenceHealth,
    settlement,
    curationPlan,
    membership,
    reconciliation: null,
    lateMatch,
  });
  const targetSequence = targetOutcomeSequence({
    humanCall: false,
    matchCount: 2,
    settlementDecision: "matches_settled",
  });
  const auditInputs = {
    observedAt: atMinutes(30),
    matchStageEnabled: true,
    matchShadow: true,
    curateEnabled: true,
    enrollApproved: true,
    sequenceHealth,
    settlement,
    curationPlan,
    membership,
    reconciliation: null,
    lateMatch,
    targetSequence,
    humanCall: false,
    postAddMatchCount: 2,
    postAddMatchCountSource: "projected",
  };
  const audit = buildAggregateShadowAudit({
    ...auditInputs,
    candidateId: "candidate-id-secret",
    arbitraryDetail: "arbitrary-secret",
  });

  assert.equal(audit.policyVersion, PHASE3_SHADOW_POLICY_VERSION);
  assert.equal(audit.aggregateOnly, true);
  assert.equal(audit.curation.intendedAddCount, 2);
  assert.equal(audit.curation.expectedTargetReadbackCount, 2);
  assert.equal(audit.curation.postAddMatchCount, 2);
  assert.equal(audit.curation.postAddMatchCountSource, "projected");
  assert.equal(Object.hasOwn(audit.curation, "expectedReadbackCount"), false);
  assert.equal(audit.gates.candidateFacingWritesAllowed, false);
  assert.equal(audit.gates.curationReadbackVerified, false);
  assert.equal(audit.gates.callSnapshotCurrent, true);
  assert.equal(audit.membership.targetSequenceCoverageComplete, true);
  assert.equal(audit.lateMatch.allowSecondEnrollment, false);
  assert.equal(audit.reconciliation, null);
  assert.equal(audit.targetSequenceId, targetSequence.id);

  const humanAudit = buildAggregateShadowAudit({
    ...auditInputs,
    callDecision: selectedCallProof({
      humanCall: true,
      snapshotObservedAt: atMinutes(30),
    }),
  });
  assert.equal(
    humanAudit.targetSequenceId,
    "v0ua934p012p3lwpg7610wcz",
  );
  assert.notEqual(humanAudit.targetSequenceId, audit.targetSequenceId);

  assert.throws(
    () => buildAggregateShadowAudit({
      ...auditInputs,
      postAddMatchCount: 1,
    }),
    /final gate decision|contain every curation target role/,
  );

  const enrollmentGates = phase3GateDecision({
    matchStageEnabled: true,
    matchShadow: false,
    curateEnabled: true,
    enrollApproved: true,
    curationReadbackVerified: true,
    sequenceHealth: outcomeSequenceHealthDecision(sequenceSnapshot()),
    settlement,
    curationPlan,
    membership,
    lateMatch,
    reconciliation: curatedWriteReconciliationDecision({
      plan: curationPlan,
      mutationOutcome: "accepted",
      readbackState: "authoritative",
      curatedRoleIds: ["role-secret-a", "role-secret-b"],
      attemptCount: 1,
      maxAttempts: 3,
    }),
  });
  assert.equal(enrollmentGates.allowEnrollment, true);
  const verifiedReconciliation = curatedWriteReconciliationDecision({
    plan: curationPlan,
    mutationOutcome: "accepted",
    readbackState: "authoritative",
    curatedRoleIds: ["role-secret-a", "role-secret-b"],
    attemptCount: 1,
    maxAttempts: 3,
  });
  assert.throws(
    () => buildAggregateShadowAudit({
      ...auditInputs,
      reconciliation: verifiedReconciliation,
    }),
    /authoritative post-add match count/,
  );
  const enrollmentAuditInputs = {
    ...auditInputs,
    matchShadow: false,
    reconciliation: verifiedReconciliation,
    postAddMatchCountSource: "authoritative",
  };
  const enrollmentAudit = buildAggregateShadowAudit(enrollmentAuditInputs);
  assert.equal(enrollmentAudit.gates.allowEnrollment, true);

  const unhealthyAudit = buildAggregateShadowAudit({
    ...enrollmentAuditInputs,
    sequenceHealth: null,
    gates: {
      ...enrollmentGates,
      sequenceHealthHealthy: true,
      allowEnrollment: true,
      candidateFacingWritesAllowed: true,
    },
  });
  assert.equal(unhealthyAudit.gates.sequenceHealthHealthy, false);
  assert.equal(unhealthyAudit.gates.allowEnrollment, false);
  const approvalDeniedAudit = buildAggregateShadowAudit({
    ...enrollmentAuditInputs,
    enrollApproved: false,
  });
  assert.equal(approvalDeniedAudit.gates.allowEnrollment, false);
  const forcedShadowAudit = buildAggregateShadowAudit({
    ...enrollmentAuditInputs,
    matchShadow: true,
  });
  assert.equal(forcedShadowAudit.gates.allowCuratedWrite, false);
  assert.equal(forcedShadowAudit.gates.allowEnrollment, false);
  assert.equal(
    forcedShadowAudit.gates.candidateFacingWritesAllowed,
    false,
  );

  const activeMembership = outcomeMembershipDecision(membershipSnapshot([
    {
      sequenceId: ALL_OUTCOME_SEQUENCE_IDS[0],
      lifecycle: "active",
      hasReplied: false,
    },
  ]));
  const activeMembershipAudit = buildAggregateShadowAudit({
    ...auditInputs,
    membership: activeMembership,
  });
  assert.equal(activeMembershipAudit.gates.allowEnrollment, false);
  assert.equal(
    activeMembershipAudit.gates.membershipAllowsEnrollment,
    false,
  );

  const otherScopePlan = rawPlanCuratedAdds({
    scopeDigest: OTHER_SCOPE_DIGEST,
    recommendedRoleIds: ["other-secret-a"],
    possibleRoleIds: ["other-secret-b"],
  });
  const otherScopeLateMatch = rawLateMatchDecision({
    scopeDigest: OTHER_SCOPE_DIGEST,
    noMatchesEnrollmentRecorded: false,
    recommendedRoleIds: ["other-secret-a"],
    possibleRoleIds: ["other-secret-b"],
  });
  assert.throws(
    () => buildAggregateShadowAudit({
      ...auditInputs,
      curationPlan: otherScopePlan,
      lateMatch: otherScopeLateMatch,
    }),
    /one opaque run scope/,
  );
  assert.throws(
    () => buildAggregateShadowAudit({
      ...auditInputs,
      postAddReadback: postAddReadbackProof({
        scopeDigest: OTHER_SCOPE_DIGEST,
        matchCount: 2,
      }),
    }),
    /call and post-add proofs must match/,
  );
  assert.throws(
    () => buildAggregateShadowAudit({
      ...auditInputs,
      callDecision: selectedCallProof({
        scopeDigest: OTHER_SCOPE_DIGEST,
        humanCall: true,
        snapshotObservedAt: atMinutes(30),
      }),
    }),
    /call and post-add proofs must match/,
  );

  const mismatchedSettlement = matchSettlementDecision({
    matchLegStartedAt: ANCHOR,
    observedAt: atMinutes(5),
    matchCount: 1,
  });
  const mismatchedSettlementAudit = buildAggregateShadowAudit({
    ...auditInputs,
    matchShadow: false,
    settlement: mismatchedSettlement,
  });
  assert.equal(
    mismatchedSettlementAudit.gates.settlementCurationBound,
    false,
  );
  assert.equal(mismatchedSettlementAudit.gates.allowCuratedWrite, false);
  assert.equal(mismatchedSettlementAudit.gates.allowEnrollment, false);

  const serialized = JSON.stringify([audit, enrollmentAudit]);
  for (const secret of [
    "candidate-secret",
    "candidate-secret@example.test",
    "candidate-id-secret",
    "role-secret-a",
    "role-secret-b",
    "late-role-secret",
    "arbitrary-secret",
    "other-secret-a",
    "other-secret-b",
    SCOPE_DIGEST,
    OTHER_SCOPE_DIGEST,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("pure policy rejects malformed times, counts, ids, and normalized membership state", () => {
  assert.throws(
    () => nextMatchPollDecision({
      matchLegStartedAt: "not-a-time",
      afterAt: ANCHOR,
    }),
    /valid timestamp/,
  );
  assert.throws(
    () => matchSettlementDecision({
      matchLegStartedAt: ANCHOR,
      observedAt: atMinutes(5),
      matchCount: -1,
    }),
    /non-negative integer/,
  );
  assert.throws(
    () => planCuratedAdds({ recommendedRoleIds: [""] }),
    /non-empty bounded ids/,
  );
  assert.throws(
    () => planCuratedAdds({ recommendedRoleIds: [123] }),
    /only string ids/,
  );
  assert.throws(
    () => planCuratedAdds({ recommendedRoleIds: [{ id: "role" }] }),
    /only string ids/,
  );
  assert.throws(
    () => rawCuratedPostAddMatchCount({
      scopeDigest: SCOPE_DIGEST,
      curatedRecommendedRoleIds: ["role"],
    }),
    /source is invalid/,
  );
  assert.throws(
    () => targetOutcomeSequence({ humanCall: "yes", matchCount: 1 }),
    /boolean/,
  );
  assert.throws(
    () => curatedWriteReconciliationDecision({
      plan: planCuratedAdds({ recommendedRoleIds: ["rec-1"] }),
      mutationOutcome: "accepted",
      readbackState: "authoritative",
      curatedRoleIds: [],
      attemptCount: 1,
      maxAttempts: CURATED_ADD_ATTEMPT_LIMIT_MAX + 1,
    }),
    /cannot exceed/,
  );
  assert.throws(
    () => outcomeMembershipDecision({
      scopeDigest: SCOPE_DIGEST,
      authoritative: "yes",
      complete: true,
      memberships: [],
    }),
    /boolean/,
  );
});
