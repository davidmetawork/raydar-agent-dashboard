// Capture-independent Phase 3 decision policy.
//
// The shadow runtime feeds captured Paraform reads into these pure decisions.
// This module itself contains no vendor response parser, client, mutation,
// environment read, or queue/store import, which keeps policy evaluation
// deterministic and independently testable.

export const PHASE3_SHADOW_POLICY_VERSION = "phase3-shadow-policy-v1";

export const MATCH_INITIAL_POLL_MS = 5 * 60_000;
export const MATCH_INITIAL_WINDOW_MS = 30 * 60_000;
export const MATCH_STEADY_POLL_MS = 30 * 60_000;
export const MATCH_LATE_POLL_MS = 4 * 60 * 60_000;
export const MATCH_TIMEOUT_MS = 24 * 60 * 60_000;
export const CURATED_ADD_ATTEMPT_LIMIT_MAX = 20;
export const LATE_MATCH_REVIEW_NOTE_CODE =
  "LATE_MATCHES_AFTER_NO_MATCHES";

const LIVE_SEQUENCE_ROWS = [
  {
    id: "cmqk75h7x00030bj8f5s6oaw8",
    expectedName: "(1) Agent Call Follow Up - Curated List",
    callType: "agent",
    matchBucket: "one",
  },
  {
    id: "vw168sypaoagu5j5g209cps3",
    expectedName: "(2+) Agent Call Follow Up - Curated List",
    callType: "agent",
    matchBucket: "multiple",
  },
  {
    id: "u5zsfwujwasmmcufdmzem08f",
    expectedName: "(1) Human Call Follow Up - Curated List",
    callType: "human",
    matchBucket: "one",
  },
  {
    id: "v0ua934p012p3lwpg7610wcz",
    expectedName: "(2+) Human Call Follow Up - Curated List",
    callType: "human",
    matchBucket: "multiple",
  },
  {
    id: "cmqpje4lh00040cki15nuuqc8",
    expectedName: "No Matches - Added to Para AI",
    callType: "either",
    matchBucket: "none",
  },
];

export const LIVE_OUTCOME_SEQUENCES_BY_ID = Object.freeze(
  Object.fromEntries(
    LIVE_SEQUENCE_ROWS.map((row) => [row.id, Object.freeze({ ...row })]),
  ),
);

export const RETIRED_OUTCOME_SEQUENCE_IDS = Object.freeze([
  "j8ecj7vyxcccyfaeqnmkvpwn",
  "k930x8ttnmje4qlx1gvv6ly5",
]);

export const ALL_OUTCOME_SEQUENCE_IDS = Object.freeze([
  ...Object.keys(LIVE_OUTCOME_SEQUENCES_BY_ID),
  ...RETIRED_OUTCOME_SEQUENCE_IDS,
]);

const ALL_OUTCOME_SEQUENCE_ID_SET = new Set(ALL_OUTCOME_SEQUENCE_IDS);
const REANCHORABLE_STATES = new Set(["awaiting_matches"]);
const MEMBERSHIP_LIFECYCLES = new Set(["active", "completed"]);
const MUTATION_OUTCOMES = new Set(["accepted", "unknown", "rejected"]);
const READBACK_STATES = new Set(["not_run", "unsettled", "authoritative"]);
const SAFE_MATCH_DECISIONS = new Set([
  "matches_settled",
  "zero_settled",
  "pending",
  "pending_zero",
  "timeout",
]);
const SAFE_MEMBERSHIP_DECISIONS = new Set([
  "allow",
  "skip_active",
  "block_replied",
  "review_incomplete_snapshot",
  "review_malformed_membership",
  "review_unknown_lifecycle",
]);
const SAFE_RECONCILIATION_ACTIONS = new Set([
  "readback_only",
  "verified",
  "plan_missing_only",
  "review",
  "review_exhausted",
]);
const POST_ADD_COUNT_SOURCES = new Set(["authoritative", "projected"]);
const SCOPE_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function validScopeDigest(value) {
  return (
    typeof value === "string"
    && SCOPE_DIGEST_PATTERN.test(value)
  );
}

function scopeDigest(value, field = "scopeDigest") {
  if (!validScopeDigest(value)) {
    throw new TypeError(`${field} must be a lowercase sha256 digest`);
  }
  return value;
}

function finiteTimestamp(value, field) {
  const parsed = typeof value === "number"
    ? value
    : Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return parsed;
}

function iso(value) {
  return new Date(value).toISOString();
}

function strictBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean`);
  }
  return value;
}

function count(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function normalizedIds(value, field) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  const output = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new TypeError(`${field} must contain only string ids`);
    }
    const id = raw.trim();
    if (!id || id.length > 256) {
      throw new TypeError(`${field} must contain non-empty bounded ids`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      output.push(id);
    }
  }
  return output;
}

function nextAnchoredSlot(anchorMs, afterMs, intervalMs, firstOffsetMs) {
  if (afterMs < anchorMs + firstOffsetMs) {
    return anchorMs + firstOffsetMs;
  }
  const completed = Math.floor(
    (afterMs - (anchorMs + firstOffsetMs)) / intervalMs,
  );
  return anchorMs + firstOffsetMs + ((completed + 1) * intervalMs);
}

/**
 * Return the next anchor-based poll slot after a completed poll.
 *
 * Generation reads run at +5,+10,...,+30 minutes, then +60,+90,...,+24h.
 * A settled-zero job uses the separate +4,+8,...,+24h late-match grid.
 */
export function nextMatchPollDecision({
  matchLegStartedAt,
  afterAt = matchLegStartedAt,
  lateMatchMode = false,
} = {}) {
  const anchorMs = finiteTimestamp(matchLegStartedAt, "matchLegStartedAt");
  const afterMs = finiteTimestamp(afterAt, "afterAt");
  strictBoolean(lateMatchMode, "lateMatchMode");
  if (afterMs < anchorMs) {
    throw new RangeError("afterAt cannot predate matchLegStartedAt");
  }

  const timeoutMs = anchorMs + MATCH_TIMEOUT_MS;
  if (afterMs >= timeoutMs) {
    return Object.freeze({
      phase: lateMatchMode ? "late" : "generation",
      dueAt: null,
      cadenceMs: lateMatchMode ? MATCH_LATE_POLL_MS : MATCH_STEADY_POLL_MS,
      timeoutAt: iso(timeoutMs),
      complete: true,
    });
  }

  let dueMs;
  let phase;
  let cadenceMs;
  if (lateMatchMode) {
    phase = "late";
    cadenceMs = MATCH_LATE_POLL_MS;
    dueMs = nextAnchoredSlot(
      anchorMs,
      afterMs,
      MATCH_LATE_POLL_MS,
      MATCH_LATE_POLL_MS,
    );
  } else if (afterMs < anchorMs + MATCH_INITIAL_WINDOW_MS) {
    phase = "initial";
    cadenceMs = MATCH_INITIAL_POLL_MS;
    dueMs = nextAnchoredSlot(
      anchorMs,
      afterMs,
      MATCH_INITIAL_POLL_MS,
      MATCH_INITIAL_POLL_MS,
    );
  } else {
    phase = "steady";
    cadenceMs = MATCH_STEADY_POLL_MS;
    dueMs = nextAnchoredSlot(
      anchorMs,
      afterMs,
      MATCH_STEADY_POLL_MS,
      MATCH_INITIAL_WINDOW_MS,
    );
  }

  if (dueMs > timeoutMs) {
    return Object.freeze({
      phase,
      dueAt: null,
      cadenceMs,
      timeoutAt: iso(timeoutMs),
      complete: true,
    });
  }
  return Object.freeze({
    phase,
    dueAt: iso(dueMs),
    cadenceMs,
    timeoutAt: iso(timeoutMs),
    complete: false,
  });
}

/**
 * Decide settlement from already-normalized capture output.
 * No vendor response shape is accepted or inferred here.
 */
export function matchSettlementDecision({
  scopeDigest: rawScopeDigest,
  matchLegStartedAt,
  observedAt,
  matchCount,
} = {}) {
  const normalizedScopeDigest = scopeDigest(
    rawScopeDigest,
    "match settlement scopeDigest",
  );
  const anchorMs = finiteTimestamp(matchLegStartedAt, "matchLegStartedAt");
  const observedMs = finiteTimestamp(observedAt, "observedAt");
  if (observedMs < anchorMs) {
    throw new RangeError("observedAt cannot predate matchLegStartedAt");
  }
  if (matchCount !== null) count(matchCount, "matchCount");

  const elapsedMs = observedMs - anchorMs;
  let decision = "pending";
  if (elapsedMs > MATCH_TIMEOUT_MS) {
    decision = "timeout";
  } else if (matchCount !== null && matchCount >= 1) {
    decision = "matches_settled";
  } else if (
    matchCount === 0
    && elapsedMs >= MATCH_INITIAL_WINDOW_MS
  ) {
    decision = "zero_settled";
  } else if (elapsedMs === MATCH_TIMEOUT_MS) {
    decision = "timeout";
  } else if (matchCount === 0) {
    decision = "pending_zero";
  }

  return Object.freeze({
    scopeDigest: normalizedScopeDigest,
    decision,
    matchCount,
    elapsedMs,
    settled: ["matches_settled", "zero_settled"].includes(decision),
    timedOut: decision === "timeout",
    useLateMatchCadence: decision === "zero_settled",
  });
}

/**
 * Re-anchor only pre-enable, readback-verified jobs that have never run a
 * match leg. Unknown/terminal/pre-submit states fail closed.
 */
export function stageEnableReanchorDecision({
  stageEnabledAt,
  submittedAt,
  state,
  submitReadbackVerified,
  matchLegStartedAt = null,
  matchLegPreviouslyRun,
  enrolledAt = null,
  returningCandidate = false,
} = {}) {
  const enabledMs = finiteTimestamp(stageEnabledAt, "stageEnabledAt");
  strictBoolean(submitReadbackVerified, "submitReadbackVerified");
  strictBoolean(matchLegPreviouslyRun, "matchLegPreviouslyRun");
  strictBoolean(returningCandidate, "returningCandidate");
  const anchorMs = matchLegStartedAt == null
    ? null
    : finiteTimestamp(matchLegStartedAt, "matchLegStartedAt");

  // Terminal state wins even when legacy submittedAt data is absent or bad.
  if (enrolledAt != null || state === "enrolled") {
    if (enrolledAt != null) finiteTimestamp(enrolledAt, "enrolledAt");
    return Object.freeze({
      action: "skip_terminal",
      state,
      matchLegStartedAt: anchorMs == null ? null : iso(anchorMs),
    });
  }

  // Once a real match leg has run, its anchor is immutable. An old anchor on
  // a never-run job is only a legacy placeholder and can be replaced below.
  if (matchLegPreviouslyRun) {
    return Object.freeze({
      action: anchorMs == null
        ? "skip_previously_run"
        : "keep_existing_anchor",
      state,
      matchLegStartedAt: anchorMs == null ? null : iso(anchorMs),
    });
  }
  if (!REANCHORABLE_STATES.has(state)) {
    return Object.freeze({
      action: "skip_unrecognized_state",
      state,
      matchLegStartedAt: anchorMs == null ? null : iso(anchorMs),
    });
  }
  let submittedMs = null;
  if (submittedAt != null && String(submittedAt).trim()) {
    submittedMs = finiteTimestamp(submittedAt, "submittedAt");
  } else if (!returningCandidate) {
    return Object.freeze({
      action: "wait_for_submitted_timestamp",
      state,
      matchLegStartedAt: anchorMs == null ? null : iso(anchorMs),
    });
  }
  if (submittedMs != null && submittedMs > enabledMs) {
    return Object.freeze({
      action: "skip_post_enable_submission",
      state,
      matchLegStartedAt: anchorMs == null ? null : iso(anchorMs),
    });
  }
  if (!submitReadbackVerified) {
    return Object.freeze({
      action: "wait_for_submit_readback",
      state,
      matchLegStartedAt: anchorMs == null ? null : iso(anchorMs),
    });
  }
  if (anchorMs != null && anchorMs >= enabledMs) {
    return Object.freeze({
      action: "keep_existing_anchor",
      state,
      matchLegStartedAt: iso(anchorMs),
    });
  }
  return Object.freeze({
    action: "reanchor",
    state: "awaiting_matches",
    matchLegStartedAt: iso(enabledMs),
  });
}

/**
 * Verify the five live outcome sequence IDs from an authoritative normalized
 * snapshot. IDs and enabled state are safety-critical; names are diagnostics.
 */
export function outcomeSequenceHealthDecision(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("sequence snapshot must be an object");
  }
  const authoritative = strictBoolean(
    snapshot.authoritative,
    "sequence snapshot authoritative",
  );
  const complete = strictBoolean(
    snapshot.complete,
    "sequence snapshot complete",
  );
  if (!Array.isArray(snapshot.sequences)) {
    throw new TypeError("sequence snapshot sequences must be an array");
  }

  const byId = new Map();
  let malformedCount = 0;
  let duplicateCount = 0;
  for (const sequence of snapshot.sequences) {
    if (!sequence || typeof sequence !== "object" || Array.isArray(sequence)) {
      malformedCount++;
      continue;
    }
    const id = typeof sequence.id === "string" ? sequence.id.trim() : "";
    if (!id) {
      malformedCount++;
      continue;
    }
    if (!LIVE_OUTCOME_SEQUENCES_BY_ID[id]) continue;
    if (byId.has(id)) {
      duplicateCount++;
      continue;
    }
    if (typeof sequence.enabled !== "boolean") malformedCount++;
    byId.set(id, sequence);
  }

  const missingIds = [];
  const disabledIds = [];
  const nameDriftIds = [];
  let enabledCount = 0;
  for (const expected of LIVE_SEQUENCE_ROWS) {
    const observed = byId.get(expected.id);
    if (!observed) {
      missingIds.push(expected.id);
      continue;
    }
    if (observed.enabled === true) enabledCount++;
    else disabledIds.push(expected.id);
    const observedName = typeof observed.name === "string"
      ? observed.name.trim()
      : "";
    if (observedName !== expected.expectedName) {
      nameDriftIds.push(expected.id);
    }
  }

  const healthy =
    authoritative
    && complete
    && missingIds.length === 0
    && disabledIds.length === 0
    && malformedCount === 0
    && duplicateCount === 0;
  return Object.freeze({
    healthy,
    authoritative,
    complete,
    expectedCount: LIVE_SEQUENCE_ROWS.length,
    foundCount: byId.size,
    enabledCount,
    missingCount: missingIds.length,
    disabledCount: disabledIds.length,
    malformedCount,
    duplicateCount,
    nameDriftCount: nameDriftIds.length,
    missingIds: Object.freeze(missingIds),
    disabledIds: Object.freeze(disabledIds),
    nameDriftIds: Object.freeze(nameDriftIds),
  });
}

function hasCompleteOutcomeSequenceHealthProof(proof) {
  return Boolean(
    proof
    && typeof proof === "object"
    && !Array.isArray(proof)
    && proof.healthy === true
    && proof.authoritative === true
    && proof.complete === true
    && proof.expectedCount === LIVE_SEQUENCE_ROWS.length
    && proof.foundCount === LIVE_SEQUENCE_ROWS.length
    && proof.enabledCount === LIVE_SEQUENCE_ROWS.length
    && proof.missingCount === 0
    && proof.disabledCount === 0
    && proof.malformedCount === 0
    && proof.duplicateCount === 0
    && Number.isInteger(proof.nameDriftCount)
    && proof.nameDriftCount >= 0
    && proof.nameDriftCount <= LIVE_SEQUENCE_ROWS.length
    && Array.isArray(proof.missingIds)
    && proof.missingIds.length === 0
    && Array.isArray(proof.disabledIds)
    && proof.disabledIds.length === 0
    && Array.isArray(proof.nameDriftIds)
    && proof.nameDriftIds.length === proof.nameDriftCount
  );
}

function exactNormalizedIdList(value) {
  if (!Array.isArray(value)) return null;
  let ids;
  try {
    ids = normalizedIds(value, "normalized id proof");
  } catch {
    return null;
  }
  if (ids.length !== value.length) return null;
  for (let index = 0; index < ids.length; index++) {
    if (
      typeof value[index] !== "string"
      || value[index].trim() !== ids[index]
    ) {
      return null;
    }
  }
  return ids;
}

function hasCompleteCurationPlanProof(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return false;
  if (!validScopeDigest(plan.scopeDigest)) return false;
  const recommendedRoleIds = exactNormalizedIdList(plan.recommendedRoleIds);
  const possibleRoleIds = exactNormalizedIdList(plan.possibleRoleIds);
  const targetRoleIds = exactNormalizedIdList(plan.targetRoleIds);
  const presentTargetRoleIds = exactNormalizedIdList(
    plan.presentTargetRoleIds,
  );
  const missingRoleIds = exactNormalizedIdList(plan.missingRoleIds);
  const tierOverlapRoleIds = exactNormalizedIdList(plan.tierOverlapRoleIds);
  if (
    !recommendedRoleIds
    || !possibleRoleIds
    || !targetRoleIds
    || !presentTargetRoleIds
    || !missingRoleIds
    || !tierOverlapRoleIds
  ) {
    return false;
  }

  const recommendedSet = new Set(recommendedRoleIds);
  const expectedTargetRoleIds = [
    ...recommendedRoleIds,
    ...possibleRoleIds.filter((id) => !recommendedSet.has(id)),
  ];
  const expectedTierOverlapRoleIds = possibleRoleIds.filter(
    (id) => recommendedSet.has(id),
  );
  if (
    targetRoleIds.some((id, index) => id !== expectedTargetRoleIds[index])
    || targetRoleIds.length !== expectedTargetRoleIds.length
    || tierOverlapRoleIds.some(
      (id, index) => id !== expectedTierOverlapRoleIds[index],
    )
    || tierOverlapRoleIds.length !== expectedTierOverlapRoleIds.length
  ) {
    return false;
  }

  const targetSet = new Set(targetRoleIds);
  const presentSet = new Set(presentTargetRoleIds);
  const missingSet = new Set(missingRoleIds);
  if (
    [...presentSet].some((id) => !targetSet.has(id) || missingSet.has(id))
    || [...missingSet].some((id) => !targetSet.has(id))
    || [...targetSet].some(
      (id) => !presentSet.has(id) && !missingSet.has(id),
    )
  ) {
    return false;
  }
  return Boolean(
    plan.recommendedCount === recommendedRoleIds.length
    && plan.possibleCount === possibleRoleIds.length
    && plan.targetCount === targetRoleIds.length
    && plan.alreadyPresentCount === presentTargetRoleIds.length
    && plan.missingCount === missingRoleIds.length
    && plan.expectedTargetReadbackCount === targetRoleIds.length
    && plan.alreadyPresentCount + plan.missingCount === plan.targetCount
  );
}

function curationPlanProofsMatch(left, right) {
  if (
    !hasCompleteCurationPlanProof(left)
    || !hasCompleteCurationPlanProof(right)
  ) {
    return false;
  }
  for (const field of [
    "recommendedRoleIds",
    "possibleRoleIds",
    "targetRoleIds",
    "presentTargetRoleIds",
    "missingRoleIds",
    "tierOverlapRoleIds",
  ]) {
    if (
      left[field].length !== right[field].length
      || left[field].some((id, index) => id !== right[field][index])
    ) {
      return false;
    }
  }
  return [
    "recommendedCount",
    "possibleCount",
    "targetCount",
    "alreadyPresentCount",
    "missingCount",
    "expectedTargetReadbackCount",
  ].every((field) => left[field] === right[field])
    && left.scopeDigest === right.scopeDigest;
}

function copyCurationPlanProof(plan) {
  if (!hasCompleteCurationPlanProof(plan)) {
    throw new TypeError("plan must come from planCuratedAdds");
  }
  return Object.freeze({
    scopeDigest: plan.scopeDigest,
    recommendedRoleIds: Object.freeze([...plan.recommendedRoleIds]),
    possibleRoleIds: Object.freeze([...plan.possibleRoleIds]),
    targetRoleIds: Object.freeze([...plan.targetRoleIds]),
    presentTargetRoleIds: Object.freeze([...plan.presentTargetRoleIds]),
    missingRoleIds: Object.freeze([...plan.missingRoleIds]),
    tierOverlapRoleIds: Object.freeze([...plan.tierOverlapRoleIds]),
    recommendedCount: plan.recommendedCount,
    possibleCount: plan.possibleCount,
    targetCount: plan.targetCount,
    alreadyPresentCount: plan.alreadyPresentCount,
    missingCount: plan.missingCount,
    expectedTargetReadbackCount: plan.expectedTargetReadbackCount,
  });
}

function hasCompleteLateMatchProof(proof) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  if (!hasCompleteCurationPlanProof(proof.curationPlan)) return false;
  if (
    !validScopeDigest(proof.scopeDigest)
    || proof.scopeDigest !== proof.curationPlan.scopeDigest
    || typeof proof.noMatchesEnrollmentRecorded !== "boolean"
    || typeof proof.detected !== "boolean"
    || proof.allowSecondEnrollment !== false
    || proof.enrollmentAction !== "none"
    || typeof proof.shouldAddReviewNote !== "boolean"
  ) {
    return false;
  }
  const expectedDetected =
    proof.noMatchesEnrollmentRecorded
    && proof.curationPlan.targetCount > 0;
  if (proof.detected !== expectedDetected) return false;
  if (proof.detected) {
    return proof.reviewNoteCode === LATE_MATCH_REVIEW_NOTE_CODE;
  }
  return (
    proof.reviewNoteCode === null
    && proof.shouldAddReviewNote === false
  );
}

function hasSettledMatchProof(proof) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  const common =
    validScopeDigest(proof.scopeDigest)
    && proof.settled === true
    && proof.timedOut === false
    && Number.isFinite(proof.elapsedMs)
    && proof.elapsedMs >= 0
    && proof.elapsedMs <= MATCH_TIMEOUT_MS;
  if (proof.decision === "matches_settled") {
    return Boolean(
      common
      && Number.isInteger(proof.matchCount)
      && proof.matchCount >= 1
      && proof.useLateMatchCadence === false
    );
  }
  if (proof.decision === "zero_settled") {
    return Boolean(
      common
      && proof.matchCount === 0
      && proof.elapsedMs >= MATCH_INITIAL_WINDOW_MS
      && proof.useLateMatchCadence === true
    );
  }
  return false;
}

function hasSelectedSuccessfulCallProof(proof) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  const endedMs = Date.parse(String(proof.endedAt || ""));
  const observedMs = Date.parse(String(proof.snapshotObservedAt || ""));
  return Boolean(
    validScopeDigest(proof.scopeDigest)
    && proof.decision === "selected"
    && Number.isFinite(endedMs)
    && Number.isFinite(observedMs)
    && iso(endedMs) === proof.endedAt
    && iso(observedMs) === proof.snapshotObservedAt
    && endedMs <= observedMs
    && proof.snapshotAuthoritative === true
    && proof.snapshotComplete === true
    && Number.isInteger(proof.scannedCallCount)
    && proof.scannedCallCount >= 1
    && typeof proof.humanCall === "boolean"
    && proof.callType === (proof.humanCall ? "human" : "agent")
  );
}

function hasCompletePostAddReadbackProof(proof) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  const recommendedRoleIds = exactNormalizedIdList(
    proof.curatedRecommendedRoleIds,
  );
  const possibleRoleIds = exactNormalizedIdList(
    proof.curatedPossibleRoleIds,
  );
  const presentRoleIds = exactNormalizedIdList(proof.presentRoleIds);
  if (!recommendedRoleIds || !possibleRoleIds || !presentRoleIds) return false;
  const recommendedSet = new Set(recommendedRoleIds);
  const expectedPresentRoleIds = [
    ...recommendedRoleIds,
    ...possibleRoleIds.filter((id) => !recommendedSet.has(id)),
  ];
  return Boolean(
    validScopeDigest(proof.scopeDigest)
    && POST_ADD_COUNT_SOURCES.has(proof.source)
    && typeof proof.authoritative === "boolean"
    && proof.authoritative === (proof.source === "authoritative")
    && proof.matchCount === expectedPresentRoleIds.length
    && presentRoleIds.length === expectedPresentRoleIds.length
    && presentRoleIds.every(
      (id, index) => id === expectedPresentRoleIds[index],
    )
  );
}

function postAddReadbackCoversCurationPlan(proof, plan) {
  if (
    !hasCompletePostAddReadbackProof(proof)
    || !hasCompleteCurationPlanProof(plan)
  ) {
    return false;
  }
  const presentRoleIds = new Set(proof.presentRoleIds);
  return plan.targetRoleIds.every((id) => presentRoleIds.has(id));
}

function hasCompleteOutcomeMembershipAllowProof(proof) {
  return Boolean(
    proof
    && typeof proof === "object"
    && !Array.isArray(proof)
    && validScopeDigest(proof.scopeDigest)
    && proof.decision === "allow"
    && proof.blockEnrollment === false
    && proof.skipWithoutReview === false
    && proof.snapshotAuthoritative === true
    && proof.snapshotComplete === true
    && proof.expectedTargetSequenceCount === ALL_OUTCOME_SEQUENCE_IDS.length
    && proof.scannedTargetSequenceCount === ALL_OUTCOME_SEQUENCE_IDS.length
    && proof.scannedTargetSequenceIdCount === ALL_OUTCOME_SEQUENCE_IDS.length
    && proof.scannedTargetSequenceDuplicateCount === 0
    && proof.scannedTargetSequenceUnknownCount === 0
    && proof.scannedTargetSequenceMissingCount === 0
    && proof.targetSequenceCoverageComplete === true
    && Number.isInteger(proof.targetMembershipCount)
    && proof.targetMembershipCount >= 0
    && proof.targetMembershipCount <= ALL_OUTCOME_SEQUENCE_IDS.length
    && proof.activeCount === 0
    && proof.completedCount === proof.targetMembershipCount
    && proof.repliedCount === 0
    && proof.unknownCount === 0
    && proof.malformedCount === 0
  );
}

function hasVerifiedCuratedReconciliationProof(proof, plan) {
  if (!hasCompleteCurationPlanProof(plan)) return false;
  const proofTargetRoleIds = exactNormalizedIdList(proof?.targetRoleIds);
  return Boolean(
    proof
    && typeof proof === "object"
    && !Array.isArray(proof)
    && proof.scopeDigest === plan.scopeDigest
    && proof.action === "verified"
    && proof.readbackOnly === false
    && typeof proof.externalWriteMayHaveLanded === "boolean"
    && proof.retryOriginalSetAllowed === false
    && proof.missingOnlyPlanAllowed === false
    && proof.enrollmentBlocked === false
    && Number.isInteger(proof.attemptCount)
    && proof.attemptCount >= 1
    && Number.isInteger(proof.maxAttempts)
    && proof.maxAttempts >= proof.attemptCount
    && proof.maxAttempts <= CURATED_ADD_ATTEMPT_LIMIT_MAX
    && proof.attemptsRemaining === proof.maxAttempts - proof.attemptCount
    && Array.isArray(proof.missingRoleIds)
    && proof.missingRoleIds.length === 0
    && proof.missingCount === 0
    && proof.verifiedCount === plan.targetCount
    && curationPlanProofsMatch(proof.planProof, plan)
    && proofTargetRoleIds
    && proofTargetRoleIds.length === plan.targetRoleIds.length
    && proofTargetRoleIds.every(
      (id, index) => id === plan.targetRoleIds[index],
    )
  );
}

/**
 * Final gate lattice. Shadow always wins over candidate-facing write flags,
 * while enrollment additionally requires the exact settlement, curation,
 * seven-sequence membership, and write-reconciliation proofs for this run.
 */
export function phase3GateDecision({
  scopeDigest: rawScopeDigest,
  decisionObservedAt,
  matchStageEnabled,
  matchShadow,
  curateEnabled,
  enrollApproved,
  sequenceHealth = null,
  settlement = null,
  curationPlan = null,
  callDecision = null,
  postAddReadback = null,
  membership = null,
  reconciliation = null,
  lateMatch = null,
} = {}) {
  const normalizedScopeDigest = scopeDigest(
    rawScopeDigest,
    "phase 3 gate scopeDigest",
  );
  const decisionObservedMs = finiteTimestamp(
    decisionObservedAt,
    "decisionObservedAt",
  );
  strictBoolean(matchStageEnabled, "matchStageEnabled");
  strictBoolean(matchShadow, "matchShadow");
  strictBoolean(curateEnabled, "curateEnabled");
  strictBoolean(enrollApproved, "enrollApproved");

  const allowReads = matchStageEnabled;
  const sequenceHealthHealthy =
    hasCompleteOutcomeSequenceHealthProof(sequenceHealth);
  const settlementAllowsEnrollment = hasSettledMatchProof(settlement);
  const curationPlanHealthy = hasCompleteCurationPlanProof(curationPlan);
  const settlementMatchCount = settlementAllowsEnrollment
    ? settlement.matchCount
    : null;
  const settlementCurationBound =
    settlementAllowsEnrollment
    && curationPlanHealthy
    && settlementMatchCount === curationPlan.targetCount;
  const lateMatchProofHealthy = hasCompleteLateMatchProof(lateMatch);
  const lateMatchCurationBound =
    lateMatchProofHealthy
    && curationPlanHealthy
    && curationPlanProofsMatch(lateMatch.curationPlan, curationPlan);
  const lateMatchDetected =
    lateMatchProofHealthy && lateMatch.detected === true;
  const noMatchesEnrollmentRecorded =
    lateMatchProofHealthy
      ? lateMatch.noMatchesEnrollmentRecorded
      : null;
  const lateMatchAllowsEnrollment =
    lateMatchCurationBound && noMatchesEnrollmentRecorded === false;
  const membershipAllowsEnrollment =
    hasCompleteOutcomeMembershipAllowProof(membership);
  const callDecisionSelected =
    hasSelectedSuccessfulCallProof(callDecision);
  const callSnapshotCurrent =
    callDecisionSelected
    && callDecision.snapshotObservedAt === iso(decisionObservedMs);
  const callScopeBound =
    callDecisionSelected
    && callDecision.scopeDigest === normalizedScopeDigest
    && callSnapshotCurrent;
  const postAddReadbackHealthy =
    hasCompletePostAddReadbackProof(postAddReadback);
  const postAddReadbackScopeBound =
    postAddReadbackHealthy
    && postAddReadback.scopeDigest === normalizedScopeDigest;
  const curationReadbackVerified =
    postAddReadbackScopeBound
    && postAddReadback.authoritative === true;
  const curationReadbackScopeBound = curationReadbackVerified;
  const postAddMatchCount = postAddReadbackHealthy
    ? postAddReadback.matchCount
    : null;
  const postAddMatchCountSource = postAddReadbackHealthy
    ? postAddReadback.source
    : null;
  const postAddCurationBound =
    postAddReadbackScopeBound
    && curationPlanHealthy
    && postAddReadbackCoversCurationPlan(
      postAddReadback,
      curationPlan,
    );
  const sequenceInputsCompatible =
    settlement?.decision === "zero_settled"
    || (
      settlement?.decision === "matches_settled"
      && postAddMatchCount >= 1
    );
  const targetSequenceProof = (
    callScopeBound
    && postAddReadbackScopeBound
    && settlementAllowsEnrollment
    && sequenceInputsCompatible
  )
    ? targetOutcomeSequence({
      callDecision,
      postAddReadback,
      settlement,
    })
    : null;
  const proofScopeBound = Boolean(
    settlement?.scopeDigest === normalizedScopeDigest
    && curationPlan?.scopeDigest === normalizedScopeDigest
    && callScopeBound
    && (
      postAddReadback == null
      || (
        postAddReadbackScopeBound
        && postAddCurationBound
      )
    )
    && membership?.scopeDigest === normalizedScopeDigest
    && lateMatch?.scopeDigest === normalizedScopeDigest
    && (
      reconciliation == null
      || reconciliation.scopeDigest === normalizedScopeDigest
    )
  );
  const allowCuratedWrite =
    matchStageEnabled
    && !matchShadow
    && curateEnabled
    && proofScopeBound
    && settlementCurationBound
    && lateMatchCurationBound;
  const curationMissingCount = curationPlanHealthy
    ? curationPlan.missingCount
    : null;
  const reconciliationRequired =
    allowCuratedWrite && curationMissingCount > 0;
  const reconciliationAllowsEnrollment = reconciliationRequired
    ? hasVerifiedCuratedReconciliationProof(reconciliation, curationPlan)
    : reconciliation == null;
  const allowEnrollment =
    allowCuratedWrite
    && enrollApproved
    && curationReadbackVerified
    && curationReadbackScopeBound
    && postAddCurationBound
    && targetSequenceProof != null
    && sequenceHealthHealthy
    && lateMatchAllowsEnrollment
    && membershipAllowsEnrollment
    && reconciliationAllowsEnrollment;
  const ignoredWriteFlags = [];
  if (matchShadow && curateEnabled) ignoredWriteFlags.push("curate_enabled_in_shadow");
  if (matchShadow && enrollApproved) ignoredWriteFlags.push("enroll_enabled_in_shadow");
  if (enrollApproved && !curateEnabled) {
    ignoredWriteFlags.push("enroll_enabled_without_curate");
  }
  if (enrollApproved && !curationReadbackVerified) {
    ignoredWriteFlags.push("enroll_without_curated_readback");
  }
  if ((curateEnabled || enrollApproved) && !callDecisionSelected) {
    ignoredWriteFlags.push("write_without_selected_successful_call");
  }
  if ((curateEnabled || enrollApproved) && !callScopeBound) {
    ignoredWriteFlags.push("write_without_bound_call_decision");
  }
  if ((curateEnabled || enrollApproved) && !callSnapshotCurrent) {
    ignoredWriteFlags.push("write_with_stale_call_snapshot");
  }
  if (enrollApproved && !postAddReadbackHealthy) {
    ignoredWriteFlags.push("enroll_without_post_add_readback");
  }
  if (enrollApproved && !postAddReadbackScopeBound) {
    ignoredWriteFlags.push("enroll_without_bound_post_add_readback");
  }
  if (enrollApproved && !postAddCurationBound) {
    ignoredWriteFlags.push("enroll_without_post_add_curation_binding");
  }
  if (enrollApproved && !sequenceHealthHealthy) {
    ignoredWriteFlags.push("enroll_without_healthy_sequences");
  }
  if (enrollApproved && !settlementAllowsEnrollment) {
    ignoredWriteFlags.push("enroll_without_settled_matches");
  }
  if (enrollApproved && !curationPlanHealthy) {
    ignoredWriteFlags.push("enroll_without_complete_curation_plan");
  }
  if (enrollApproved && !settlementCurationBound) {
    ignoredWriteFlags.push("enroll_without_settlement_curation_binding");
  }
  if (enrollApproved && !lateMatchProofHealthy) {
    ignoredWriteFlags.push("enroll_without_late_match_proof");
  }
  if (enrollApproved && !lateMatchCurationBound) {
    ignoredWriteFlags.push("enroll_without_late_match_curation_binding");
  }
  if (enrollApproved && noMatchesEnrollmentRecorded === true) {
    ignoredWriteFlags.push("enroll_after_no_matches_enrollment");
  }
  if (enrollApproved && !membershipAllowsEnrollment) {
    ignoredWriteFlags.push("enroll_without_safe_membership");
  }
  if (enrollApproved && !reconciliationAllowsEnrollment) {
    ignoredWriteFlags.push("enroll_without_verified_reconciliation");
  }
  if ((curateEnabled || enrollApproved) && !proofScopeBound) {
    ignoredWriteFlags.push("write_without_bound_run_scope");
  }
  if (enrollApproved && !curationReadbackScopeBound) {
    ignoredWriteFlags.push("enroll_without_bound_curated_readback");
  }

  return Object.freeze({
    scopeDigest: normalizedScopeDigest,
    allowMatchRead: allowReads,
    allowCuratedRead: allowReads,
    allowShadowAudit: matchStageEnabled && matchShadow,
    allowCuratedWrite,
    allowEnrollment,
    curationReadbackVerified,
    curationReadbackScopeBound,
    callDecisionSelected,
    callSnapshotCurrent,
    callScopeBound,
    postAddReadbackHealthy,
    postAddReadbackScopeBound,
    postAddMatchCount,
    postAddMatchCountSource,
    postAddCurationBound,
    targetSequenceId: targetSequenceProof?.id || null,
    proofScopeBound,
    sequenceHealthHealthy,
    settlementDecision: SAFE_MATCH_DECISIONS.has(settlement?.decision)
      ? settlement.decision
      : "pending",
    settlementMatchCount,
    settlementAllowsEnrollment,
    curationPlanHealthy,
    curationPlanProof: curationPlanHealthy
      ? copyCurationPlanProof(curationPlan)
      : null,
    settlementCurationBound,
    curationMissingCount,
    lateMatchProofHealthy,
    lateMatchCurationBound,
    lateMatchDetected,
    noMatchesEnrollmentRecorded,
    lateMatchAllowsEnrollment,
    membershipDecision: SAFE_MEMBERSHIP_DECISIONS.has(membership?.decision)
      ? membership.decision
      : "review_malformed_membership",
    membershipAllowsEnrollment,
    reconciliationRequired,
    reconciliationAction: reconciliation == null
      ? "not_applicable"
      : safeEnum(
        reconciliation.action,
        SAFE_RECONCILIATION_ACTIONS,
        "review",
      ),
    reconciliationAllowsEnrollment,
    candidateFacingWritesAllowed: allowCuratedWrite || allowEnrollment,
    ignoredWriteFlags: Object.freeze(ignoredWriteFlags),
  });
}

/**
 * Plan only the target roles absent from authoritative Curated List state.
 */
export function planCuratedAdds({
  scopeDigest: rawScopeDigest,
  recommendedRoleIds = [],
  possibleRoleIds = [],
  curatedRoleIds = [],
} = {}) {
  const normalizedScopeDigest = scopeDigest(
    rawScopeDigest,
    "curation plan scopeDigest",
  );
  const recommended = normalizedIds(recommendedRoleIds, "recommendedRoleIds");
  const possible = normalizedIds(possibleRoleIds, "possibleRoleIds");
  const curated = normalizedIds(curatedRoleIds, "curatedRoleIds");
  const recommendedSet = new Set(recommended);
  const curatedSet = new Set(curated);
  const targetRoleIds = [
    ...recommended,
    ...possible.filter((id) => !recommendedSet.has(id)),
  ];
  const targetSet = new Set(targetRoleIds);
  const presentTargetRoleIds = targetRoleIds.filter((id) => curatedSet.has(id));
  const missingRoleIds = targetRoleIds.filter((id) => !curatedSet.has(id));
  const tierOverlapRoleIds = possible.filter((id) => recommendedSet.has(id));

  return Object.freeze({
    scopeDigest: normalizedScopeDigest,
    recommendedRoleIds: Object.freeze(recommended),
    possibleRoleIds: Object.freeze(possible),
    targetRoleIds: Object.freeze(targetRoleIds),
    presentTargetRoleIds: Object.freeze(presentTargetRoleIds),
    missingRoleIds: Object.freeze(missingRoleIds),
    tierOverlapRoleIds: Object.freeze(tierOverlapRoleIds),
    recommendedCount: recommended.length,
    possibleCount: possible.length,
    targetCount: targetSet.size,
    alreadyPresentCount: presentTargetRoleIds.length,
    missingCount: missingRoleIds.length,
    expectedTargetReadbackCount: targetSet.size,
  });
}

/**
 * Scope-bearing sequence-driving proof from the post-add Curated List state.
 * This deliberately counts every Recommended/Possible role present, including
 * roles curated on a prior call, rather than roles added this run. Projected
 * state is allowed for shadow auditing but cannot authorize enrollment.
 */
export function curatedPostAddMatchCount({
  scopeDigest: rawScopeDigest,
  source,
  curatedRecommendedRoleIds = [],
  curatedPossibleRoleIds = [],
} = {}) {
  const normalizedScopeDigest = scopeDigest(
    rawScopeDigest,
    "post-add readback scopeDigest",
  );
  if (!POST_ADD_COUNT_SOURCES.has(source)) {
    throw new TypeError("post-add readback source is invalid");
  }
  const recommended = normalizedIds(
    curatedRecommendedRoleIds,
    "curatedRecommendedRoleIds",
  );
  const possible = normalizedIds(
    curatedPossibleRoleIds,
    "curatedPossibleRoleIds",
  );
  const recommendedSet = new Set(recommended);
  const presentRoleIds = [
    ...recommended,
    ...possible.filter((id) => !recommendedSet.has(id)),
  ];
  return Object.freeze({
    scopeDigest: normalizedScopeDigest,
    source,
    authoritative: source === "authoritative",
    curatedRecommendedRoleIds: Object.freeze(recommended),
    curatedPossibleRoleIds: Object.freeze(possible),
    presentRoleIds: Object.freeze(presentRoleIds),
    matchCount: presentRoleIds.length,
  });
}

/**
 * Reconcile a single-attempt curated write. Accepted and unknown responses both
 * require readback. A retry can only become a new plan for the exact missing
 * subset after an authoritative readback; retrying the original set is never
 * allowed.
 */
export function curatedWriteReconciliationDecision({
  plan,
  mutationOutcome,
  readbackState,
  curatedRoleIds = [],
  attemptCount,
  maxAttempts,
} = {}) {
  if (!hasCompleteCurationPlanProof(plan)) {
    throw new TypeError("plan must come from planCuratedAdds");
  }
  if (!MUTATION_OUTCOMES.has(mutationOutcome)) {
    throw new TypeError("mutationOutcome is invalid");
  }
  if (!READBACK_STATES.has(readbackState)) {
    throw new TypeError("readbackState is invalid");
  }
  positiveInteger(attemptCount, "attemptCount");
  positiveInteger(maxAttempts, "maxAttempts");
  if (maxAttempts > CURATED_ADD_ATTEMPT_LIMIT_MAX) {
    throw new RangeError(
      `maxAttempts cannot exceed ${CURATED_ADD_ATTEMPT_LIMIT_MAX}`,
    );
  }
  if (attemptCount > maxAttempts) {
    throw new RangeError("attemptCount cannot exceed maxAttempts");
  }

  const after = new Set(normalizedIds(curatedRoleIds, "curatedRoleIds"));
  const missingRoleIds = plan.targetRoleIds.filter((id) => !after.has(id));
  let action = "readback_only";
  if (readbackState === "authoritative" && missingRoleIds.length === 0) {
    action = "verified";
  } else if (
    readbackState === "authoritative"
    && mutationOutcome !== "rejected"
    && attemptCount >= maxAttempts
  ) {
    action = "review_exhausted";
  } else if (
    readbackState === "authoritative"
    && mutationOutcome !== "rejected"
  ) {
    action = "plan_missing_only";
  } else if (
    readbackState === "authoritative"
    && mutationOutcome === "rejected"
  ) {
    action = "review";
  }

  return Object.freeze({
    scopeDigest: plan.scopeDigest,
    action,
    readbackOnly: action === "readback_only",
    externalWriteMayHaveLanded: mutationOutcome === "unknown",
    retryOriginalSetAllowed: false,
    missingOnlyPlanAllowed: action === "plan_missing_only",
    enrollmentBlocked: action !== "verified",
    attemptCount,
    maxAttempts,
    attemptsRemaining: maxAttempts - attemptCount,
    planProof: copyCurationPlanProof(plan),
    targetRoleIds: Object.freeze([...plan.targetRoleIds]),
    missingRoleIds: Object.freeze(missingRoleIds),
    missingCount: missingRoleIds.length,
    verifiedCount: plan.targetRoleIds.length - missingRoleIds.length,
  });
}

/**
 * Late matches after a No-Matches enrollment may be curated, but they never
 * authorize a second enrollment.
 */
export function lateMatchDecision({
  scopeDigest: rawScopeDigest,
  noMatchesEnrollmentRecorded,
  recommendedRoleIds = [],
  possibleRoleIds = [],
  curatedRoleIds = [],
  existingReviewNoteCodes = [],
} = {}) {
  const normalizedScopeDigest = scopeDigest(
    rawScopeDigest,
    "late match scopeDigest",
  );
  strictBoolean(noMatchesEnrollmentRecorded, "noMatchesEnrollmentRecorded");
  const existingNoteCodes = new Set(normalizedIds(
    existingReviewNoteCodes,
    "existingReviewNoteCodes",
  ));
  const curationPlan = planCuratedAdds({
    scopeDigest: normalizedScopeDigest,
    recommendedRoleIds,
    possibleRoleIds,
    curatedRoleIds,
  });
  const detected =
    noMatchesEnrollmentRecorded && curationPlan.targetCount > 0;
  return Object.freeze({
    scopeDigest: normalizedScopeDigest,
    noMatchesEnrollmentRecorded,
    detected,
    curationPlan,
    allowSecondEnrollment: false,
    enrollmentAction: "none",
    reviewNoteCode: detected
      ? LATE_MATCH_REVIEW_NOTE_CODE
      : null,
    shouldAddReviewNote:
      detected && !existingNoteCodes.has(LATE_MATCH_REVIEW_NOTE_CODE),
  });
}

/**
 * Select call type from the most recent successful normalized call. Failed
 * calls never override an earlier success, and conflicting equal-time results
 * require review.
 */
export function mostRecentSuccessfulCallDecision({
  scopeDigest: rawScopeDigest,
  snapshotObservedAt,
  authoritative,
  complete,
  calls = [],
} = {}) {
  const normalizedScopeDigest = scopeDigest(
    rawScopeDigest,
    "call decision scopeDigest",
  );
  const observedMs = finiteTimestamp(
    snapshotObservedAt,
    "snapshotObservedAt",
  );
  strictBoolean(authoritative, "authoritative");
  strictBoolean(complete, "complete");
  if (!Array.isArray(calls)) {
    throw new TypeError("calls must be an array");
  }
  const successful = [];
  for (const call of calls) {
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      throw new TypeError("calls must contain normalized objects");
    }
    strictBoolean(call.successful, "call.successful");
    strictBoolean(call.humanCall, "call.humanCall");
    if (!call.successful) continue;
    const endedMs = finiteTimestamp(call.endedAt, "call.endedAt");
    if (endedMs > observedMs) {
      throw new RangeError("successful call cannot end after snapshotObservedAt");
    }
    successful.push({
      endedMs,
      humanCall: call.humanCall,
    });
  }
  const snapshotProof = {
    scopeDigest: normalizedScopeDigest,
    snapshotObservedAt: iso(observedMs),
    snapshotAuthoritative: authoritative,
    snapshotComplete: complete,
    scannedCallCount: calls.length,
  };
  if (!authoritative || !complete) {
    return Object.freeze({
      ...snapshotProof,
      decision: "review_incomplete_snapshot",
      endedAt: null,
      humanCall: null,
      callType: null,
    });
  }
  if (successful.length === 0) {
    return Object.freeze({
      ...snapshotProof,
      decision: "none",
      endedAt: null,
      humanCall: null,
      callType: null,
    });
  }

  const mostRecentMs = Math.max(...successful.map((call) => call.endedMs));
  const mostRecent = successful.filter(
    (call) => call.endedMs === mostRecentMs,
  );
  const callTypes = new Set(mostRecent.map((call) => call.humanCall));
  if (callTypes.size > 1) {
    return Object.freeze({
      ...snapshotProof,
      decision: "review_ambiguous_tie",
      endedAt: iso(mostRecentMs),
      humanCall: null,
      callType: null,
    });
  }
  const humanCall = mostRecent[0].humanCall;
  return Object.freeze({
    ...snapshotProof,
    decision: "selected",
    endedAt: iso(mostRecentMs),
    humanCall,
    callType: humanCall ? "human" : "agent",
  });
}

export function targetOutcomeSequence({
  callDecision,
  postAddReadback,
  settlement,
} = {}) {
  if (!hasSelectedSuccessfulCallProof(callDecision)) {
    throw new TypeError(
      "callDecision must be a selected successful-call proof",
    );
  }
  if (!hasCompletePostAddReadbackProof(postAddReadback)) {
    throw new TypeError(
      "postAddReadback must be a complete post-add proof",
    );
  }
  if (!hasSettledMatchProof(settlement)) {
    throw new TypeError("settlement must be a settled match proof");
  }
  if (
    callDecision.scopeDigest !== settlement.scopeDigest
    || postAddReadback.scopeDigest !== settlement.scopeDigest
  ) {
    throw new RangeError(
      "sequence decision proofs must share one opaque run scope",
    );
  }
  const { humanCall } = callDecision;
  const matchCount = postAddReadback.matchCount;
  const settlementDecision = settlement.decision;
  let row;
  if (settlementDecision === "zero_settled") {
    row = LIVE_SEQUENCE_ROWS.find((entry) => entry.matchBucket === "none");
  } else {
    if (matchCount < 1) {
      throw new RangeError(
        "matches_settled requires a positive post-add match count",
      );
    }
    const callType = humanCall ? "human" : "agent";
    const matchBucket = matchCount === 1 ? "one" : "multiple";
    row = LIVE_SEQUENCE_ROWS.find(
      (entry) =>
        entry.callType === callType && entry.matchBucket === matchBucket,
    );
  }
  return Object.freeze({
    scopeDigest: settlement.scopeDigest,
    ...LIVE_OUTCOME_SEQUENCES_BY_ID[row.id],
  });
}

/**
 * Evaluate an explicit authoritative, complete normalized membership snapshot
 * by the seven stable IDs. Full seven-ID scan coverage is required before an
 * empty snapshot can mean "no membership"; unknown/incomplete state fails closed.
 */
export function outcomeMembershipDecision(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("membership snapshot must be an object");
  }
  const normalizedScopeDigest = scopeDigest(
    snapshot.scopeDigest,
    "membership snapshot scopeDigest",
  );
  const authoritative = strictBoolean(
    snapshot.authoritative,
    "membership snapshot authoritative",
  );
  const complete = strictBoolean(
    snapshot.complete,
    "membership snapshot complete",
  );
  if (!Array.isArray(snapshot.memberships)) {
    throw new TypeError("membership snapshot memberships must be an array");
  }
  const expectedTargetSequenceCount =
    Number.isInteger(snapshot.expectedTargetSequenceCount)
    && snapshot.expectedTargetSequenceCount >= 0
      ? snapshot.expectedTargetSequenceCount
      : 0;
  const scannedTargetSequenceCount =
    Number.isInteger(snapshot.scannedTargetSequenceCount)
    && snapshot.scannedTargetSequenceCount >= 0
      ? snapshot.scannedTargetSequenceCount
      : 0;
  const rawScannedTargetSequenceIds = snapshot.scannedTargetSequenceIds;
  const scannedTargetSequenceIdsProvided = Array.isArray(
    rawScannedTargetSequenceIds,
  );
  const scannedTargetSequenceIds = scannedTargetSequenceIdsProvided
    ? normalizedIds(
      rawScannedTargetSequenceIds,
      "membership snapshot scannedTargetSequenceIds",
    )
    : [];
  const scannedTargetSequenceIdSet = new Set(scannedTargetSequenceIds);
  const scannedTargetSequenceIdCount = scannedTargetSequenceIds.length;
  const scannedTargetSequenceDuplicateCount =
    scannedTargetSequenceIdsProvided
      ? rawScannedTargetSequenceIds.length - scannedTargetSequenceIdCount
      : 0;
  const scannedTargetSequenceUnknownCount =
    scannedTargetSequenceIds.filter(
      (sequenceId) => !ALL_OUTCOME_SEQUENCE_ID_SET.has(sequenceId),
    ).length;
  const scannedTargetSequenceMissingCount =
    ALL_OUTCOME_SEQUENCE_IDS.filter(
      (sequenceId) => !scannedTargetSequenceIdSet.has(sequenceId),
    ).length;
  const targetSequenceCoverageComplete =
    expectedTargetSequenceCount === ALL_OUTCOME_SEQUENCE_IDS.length
    && scannedTargetSequenceCount === ALL_OUTCOME_SEQUENCE_IDS.length
    && scannedTargetSequenceIdsProvided
    && scannedTargetSequenceIdCount === ALL_OUTCOME_SEQUENCE_IDS.length
    && scannedTargetSequenceDuplicateCount === 0
    && scannedTargetSequenceUnknownCount === 0
    && scannedTargetSequenceMissingCount === 0;
  if (!authoritative || !complete || !targetSequenceCoverageComplete) {
    return Object.freeze({
      scopeDigest: normalizedScopeDigest,
      decision: "review_incomplete_snapshot",
      blockEnrollment: true,
      skipWithoutReview: false,
      snapshotAuthoritative: authoritative,
      snapshotComplete: complete,
      expectedTargetSequenceCount,
      scannedTargetSequenceCount,
      scannedTargetSequenceIdCount,
      scannedTargetSequenceDuplicateCount,
      scannedTargetSequenceUnknownCount,
      scannedTargetSequenceMissingCount,
      targetSequenceCoverageComplete,
      targetMembershipCount: 0,
      activeCount: 0,
      completedCount: 0,
      repliedCount: 0,
      unknownCount: 0,
      malformedCount: 0,
    });
  }

  const bySequence = new Map();
  let malformedCount = 0;
  for (const membership of snapshot.memberships) {
    if (
      !membership
      || typeof membership !== "object"
      || Array.isArray(membership)
    ) {
      malformedCount++;
      continue;
    }
    const sequenceId = typeof membership.sequenceId === "string"
      ? membership.sequenceId.trim()
      : "";
    const lifecycle = typeof membership.lifecycle === "string"
      ? membership.lifecycle.trim().toLowerCase()
      : "";
    if (!sequenceId) {
      malformedCount++;
      continue;
    }
    if (!ALL_OUTCOME_SEQUENCE_ID_SET.has(sequenceId)) continue;
    if (!lifecycle || typeof membership.hasReplied !== "boolean") {
      malformedCount++;
      continue;
    }
    const hasReplied = membership.hasReplied;
    const current = bySequence.get(sequenceId) || {
      hasReplied: false,
      active: false,
      completed: false,
      unknown: false,
    };
    current.hasReplied ||= hasReplied;
    current.active ||= lifecycle === "active";
    current.completed ||= lifecycle === "completed";
    current.unknown ||= !MEMBERSHIP_LIFECYCLES.has(lifecycle);
    bySequence.set(sequenceId, current);
  }

  const rows = [...bySequence.values()];
  const repliedCount = rows.filter((row) => row.hasReplied).length;
  const activeCount = rows.filter((row) => row.active).length;
  const completedCount = rows.filter(
    (row) => row.completed && !row.active,
  ).length;
  const unknownCount = rows.filter((row) => row.unknown).length;
  let decision = "allow";
  if (repliedCount > 0) decision = "block_replied";
  else if (malformedCount > 0) decision = "review_malformed_membership";
  else if (unknownCount > 0) decision = "review_unknown_lifecycle";
  else if (activeCount > 0) decision = "skip_active";

  return Object.freeze({
    scopeDigest: normalizedScopeDigest,
    decision,
    blockEnrollment: decision !== "allow",
    skipWithoutReview: decision === "skip_active",
    snapshotAuthoritative: authoritative,
    snapshotComplete: complete,
    expectedTargetSequenceCount,
    scannedTargetSequenceCount,
    scannedTargetSequenceIdCount,
    scannedTargetSequenceDuplicateCount,
    scannedTargetSequenceUnknownCount,
    scannedTargetSequenceMissingCount,
    targetSequenceCoverageComplete,
    targetMembershipCount: rows.length,
    activeCount,
    completedCount,
    repliedCount,
    unknownCount,
    malformedCount,
  });
}

function safeEnum(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

/**
 * Build an allowlisted, aggregate-only shadow audit. Sequence-driving counts
 * cannot undercut the curation target, and verified readback/enrollment requires
 * authoritative counts. Dynamic identifiers are ignored by construction.
 */
export function buildAggregateShadowAudit({
  scopeDigest: rawScopeDigest,
  observedAt,
  matchStageEnabled,
  matchShadow,
  curateEnabled,
  enrollApproved,
  sequenceHealth = null,
  settlement,
  curationPlan,
  callDecision,
  postAddReadback,
  membership,
  reconciliation = null,
  lateMatch = null,
} = {}) {
  const normalizedScopeDigest = scopeDigest(
    rawScopeDigest,
    "aggregate audit scopeDigest",
  );
  const observedMs = finiteTimestamp(observedAt, "observedAt");
  if (!settlement || !curationPlan || !membership || !lateMatch) {
    throw new TypeError("aggregate audit decisions are required");
  }
  if (!hasSelectedSuccessfulCallProof(callDecision)) {
    throw new TypeError(
      "aggregate audit requires a selected successful-call proof",
    );
  }
  if (!hasCompletePostAddReadbackProof(postAddReadback)) {
    throw new TypeError(
      "aggregate audit requires a complete post-add readback proof",
    );
  }
  if (
    callDecision.scopeDigest !== normalizedScopeDigest
    || postAddReadback.scopeDigest !== normalizedScopeDigest
  ) {
    throw new RangeError(
      "aggregate audit call and post-add proofs must match the run",
    );
  }
  const postAddMatchCount = postAddReadback.matchCount;
  const postAddMatchCountSource = postAddReadback.source;
  const gates = phase3GateDecision({
    scopeDigest: normalizedScopeDigest,
    decisionObservedAt: iso(observedMs),
    matchStageEnabled,
    matchShadow,
    curateEnabled,
    enrollApproved,
    sequenceHealth,
    settlement,
    curationPlan,
    callDecision,
    postAddReadback,
    membership,
    reconciliation,
    lateMatch,
  });
  const settlementAllowsEnrollment = hasSettledMatchProof(settlement);
  const curationPlanHealthy = hasCompleteCurationPlanProof(curationPlan);
  if (!curationPlanHealthy) {
    throw new TypeError("aggregate audit requires a complete curation plan");
  }
  const curationTargetCount = count(
    curationPlan.targetCount,
    "targetCount",
  );
  const postAddCurationBound =
    postAddReadbackCoversCurationPlan(postAddReadback, curationPlan);
  if (!postAddCurationBound) {
    throw new RangeError(
      "post-add readback must contain every curation target role",
    );
  }
  const membershipAllowsEnrollment =
    hasCompleteOutcomeMembershipAllowProof(membership);
  const proofScopeBound = Boolean(
    gates.scopeDigest === normalizedScopeDigest
    && gates.proofScopeBound === true
    && gates.callScopeBound === true
    && gates.postAddReadbackScopeBound === true
    && settlement.scopeDigest === normalizedScopeDigest
    && curationPlan.scopeDigest === normalizedScopeDigest
    && membership.scopeDigest === normalizedScopeDigest
    && lateMatch.scopeDigest === normalizedScopeDigest
    && (
      reconciliation == null
      || reconciliation.scopeDigest === normalizedScopeDigest
    )
  );
  if (!proofScopeBound) {
    throw new RangeError(
      "aggregate audit proofs must share one opaque run scope",
    );
  }
  const lateMatchProofHealthy = hasCompleteLateMatchProof(lateMatch);
  const lateMatchCurationBound =
    lateMatchProofHealthy
    && curationPlanProofsMatch(lateMatch.curationPlan, curationPlan);
  const lateMatchDetected =
    lateMatchProofHealthy && lateMatch.detected === true;
  const noMatchesEnrollmentRecorded =
    lateMatchProofHealthy
      ? lateMatch.noMatchesEnrollmentRecorded
      : null;
  const lateMatchAllowsEnrollment =
    lateMatchCurationBound && noMatchesEnrollmentRecorded === false;
  const settlementMatchCount = settlementAllowsEnrollment
    ? settlement.matchCount
    : null;
  const settlementCurationBound =
    settlementAllowsEnrollment
    && curationPlanHealthy
    && settlementMatchCount === curationPlan.targetCount;
  const curationReadbackVerified =
    postAddReadback.authoritative === true;
  const expectedTargetSequence = targetOutcomeSequence({
    callDecision,
    postAddReadback,
    settlement,
  });
  const authoritativePostAddCountRequired =
    gates.curationReadbackVerified === true
    || gates.allowEnrollment === true
    || reconciliation?.action === "verified";
  if (
    authoritativePostAddCountRequired
    && postAddReadback.authoritative !== true
  ) {
    throw new RangeError(
      "authoritative post-add match count is required for verified enrollment",
    );
  }
  const reconciliationRequired =
    gates.allowCuratedWrite === true && curationPlan.missingCount > 0;
  const reconciliationAllowsEnrollment = reconciliationRequired
    ? hasVerifiedCuratedReconciliationProof(reconciliation, curationPlan)
    : reconciliation == null;
  const settlementDecision = safeEnum(
    settlement.decision,
    SAFE_MATCH_DECISIONS,
    "pending",
  );
  const membershipDecision = safeEnum(
    membership.decision,
    SAFE_MEMBERSHIP_DECISIONS,
    "review_malformed_membership",
  );
  const reconciliationAction = reconciliation == null
    ? "not_applicable"
    : safeEnum(
      reconciliation.action,
      SAFE_RECONCILIATION_ACTIONS,
      "review",
    );
  if (
    gates.settlementDecision !== settlementDecision
    || gates.proofScopeBound !== true
    || gates.callDecisionSelected !== true
    || gates.callSnapshotCurrent !== true
    || gates.callScopeBound !== true
    || gates.postAddReadbackHealthy !== true
    || gates.postAddReadbackScopeBound !== true
    || gates.postAddMatchCount !== postAddMatchCount
    || gates.postAddMatchCountSource !== postAddMatchCountSource
    || gates.postAddCurationBound !== postAddCurationBound
    || gates.curationReadbackVerified !== curationReadbackVerified
    || gates.curationReadbackScopeBound !== curationReadbackVerified
    || gates.targetSequenceId !== expectedTargetSequence.id
    || gates.settlementMatchCount !== settlementMatchCount
    || gates.settlementAllowsEnrollment !== settlementAllowsEnrollment
    || gates.curationPlanHealthy !== true
    || !curationPlanProofsMatch(gates.curationPlanProof, curationPlan)
    || gates.settlementCurationBound !== settlementCurationBound
    || gates.curationMissingCount !== curationPlan.missingCount
    || gates.lateMatchProofHealthy !== lateMatchProofHealthy
    || gates.lateMatchCurationBound !== lateMatchCurationBound
    || gates.lateMatchDetected !== lateMatchDetected
    || (
      gates.noMatchesEnrollmentRecorded
      !== noMatchesEnrollmentRecorded
    )
    || gates.lateMatchAllowsEnrollment !== lateMatchAllowsEnrollment
    || gates.membershipDecision !== membershipDecision
    || gates.membershipAllowsEnrollment !== membershipAllowsEnrollment
    || gates.reconciliationRequired !== reconciliationRequired
    || gates.reconciliationAction !== reconciliationAction
    || (
      gates.reconciliationAllowsEnrollment
      !== reconciliationAllowsEnrollment
    )
  ) {
    throw new RangeError(
      "aggregate audit proofs must match the final gate decision",
    );
  }
  if (
    gates.allowEnrollment === true
    && (
      gates.allowCuratedWrite !== true
      || gates.curationReadbackVerified !== true
      || gates.curationReadbackScopeBound !== true
      || gates.callDecisionSelected !== true
      || gates.callSnapshotCurrent !== true
      || gates.callScopeBound !== true
      || gates.postAddReadbackHealthy !== true
      || gates.postAddReadbackScopeBound !== true
      || gates.postAddCurationBound !== true
      || gates.targetSequenceId !== expectedTargetSequence.id
      || gates.sequenceHealthHealthy !== true
      || !settlementAllowsEnrollment
      || !settlementCurationBound
      || !lateMatchAllowsEnrollment
      || !membershipAllowsEnrollment
      || !reconciliationAllowsEnrollment
    )
  ) {
    throw new RangeError(
      "enrollment cannot contradict settlement, membership, or reconciliation",
    );
  }
  if (
    gates.allowCuratedWrite === true
    && (
      gates.allowMatchRead !== true
      || gates.allowCuratedRead !== true
      || gates.callDecisionSelected !== true
      || gates.callSnapshotCurrent !== true
      || gates.callScopeBound !== true
      || !curationPlanHealthy
      || !settlementCurationBound
      || !lateMatchCurationBound
    )
  ) {
    throw new RangeError(
      "curated write cannot contradict stage, settlement, or late-match proofs",
    );
  }
  if (
    gates.candidateFacingWritesAllowed
    !== (
      gates.allowCuratedWrite === true
      || gates.allowEnrollment === true
    )
  ) {
    throw new RangeError(
      "candidate-facing write summary must match the final gate decision",
    );
  }
  if (
    gates.allowShadowAudit === true
    && (
      gates.allowCuratedWrite === true
      || gates.allowEnrollment === true
      || gates.candidateFacingWritesAllowed === true
    )
  ) {
    throw new RangeError(
      "shadow audit cannot coexist with candidate-facing writes",
    );
  }
  const targetSequenceId = expectedTargetSequence.id;

  return Object.freeze({
    policyVersion: PHASE3_SHADOW_POLICY_VERSION,
    observedAt: iso(observedMs),
    aggregateOnly: true,
    match: Object.freeze({
      decision: settlementDecision,
      matchCount: settlementMatchCount,
      settled: settlement.settled === true,
      timedOut: settlement.timedOut === true,
    }),
    curation: Object.freeze({
      recommendedCount: count(
        curationPlan.recommendedCount,
        "recommendedCount",
      ),
      possibleCount: count(curationPlan.possibleCount, "possibleCount"),
      targetCount: curationTargetCount,
      alreadyPresentCount: count(
        curationPlan.alreadyPresentCount,
        "alreadyPresentCount",
      ),
      intendedAddCount: count(curationPlan.missingCount, "missingCount"),
      expectedTargetReadbackCount: count(
        curationPlan.expectedTargetReadbackCount,
        "expectedTargetReadbackCount",
      ),
      postAddMatchCount,
      postAddMatchCountSource,
    }),
    gates: Object.freeze({
      allowMatchRead: gates.allowMatchRead === true,
      allowCuratedRead: gates.allowCuratedRead === true,
      allowShadowAudit: gates.allowShadowAudit === true,
      allowCuratedWrite: gates.allowCuratedWrite === true,
      allowEnrollment: gates.allowEnrollment === true,
      curationReadbackVerified:
        gates.curationReadbackVerified === true,
      sequenceHealthHealthy: gates.sequenceHealthHealthy === true,
      curationReadbackScopeBound:
        gates.curationReadbackScopeBound === true,
      callDecisionSelected: gates.callDecisionSelected === true,
      callSnapshotCurrent: gates.callSnapshotCurrent === true,
      callScopeBound: gates.callScopeBound === true,
      postAddReadbackHealthy: gates.postAddReadbackHealthy === true,
      postAddReadbackScopeBound:
        gates.postAddReadbackScopeBound === true,
      postAddCurationBound: gates.postAddCurationBound === true,
      proofScopeBound,
      settlementDecision,
      settlementMatchCount,
      settlementAllowsEnrollment,
      curationPlanHealthy,
      settlementCurationBound,
      curationMissingCount: curationPlan.missingCount,
      lateMatchProofHealthy,
      lateMatchCurationBound,
      lateMatchDetected,
      noMatchesEnrollmentRecorded,
      lateMatchAllowsEnrollment,
      membershipDecision,
      membershipAllowsEnrollment,
      reconciliationRequired,
      reconciliationAction,
      reconciliationAllowsEnrollment,
      candidateFacingWritesAllowed:
        gates.candidateFacingWritesAllowed === true,
      ignoredWriteFlagCount: Array.isArray(gates.ignoredWriteFlags)
        ? gates.ignoredWriteFlags.length
        : 0,
    }),
    membership: Object.freeze({
      decision: membershipDecision,
      targetMembershipCount: count(
        membership.targetMembershipCount,
        "targetMembershipCount",
      ),
      activeCount: count(membership.activeCount, "activeCount"),
      completedCount: count(membership.completedCount, "completedCount"),
      repliedCount: count(membership.repliedCount, "repliedCount"),
      unknownCount: count(membership.unknownCount, "unknownCount"),
      malformedCount: count(
        membership.malformedCount,
        "membership.malformedCount",
      ),
      snapshotAuthoritative: membership.snapshotAuthoritative === true,
      snapshotComplete: membership.snapshotComplete === true,
      expectedTargetSequenceCount: count(
        membership.expectedTargetSequenceCount,
        "membership.expectedTargetSequenceCount",
      ),
      scannedTargetSequenceCount: count(
        membership.scannedTargetSequenceCount,
        "membership.scannedTargetSequenceCount",
      ),
      scannedTargetSequenceIdCount: count(
        membership.scannedTargetSequenceIdCount,
        "membership.scannedTargetSequenceIdCount",
      ),
      scannedTargetSequenceDuplicateCount: count(
        membership.scannedTargetSequenceDuplicateCount,
        "membership.scannedTargetSequenceDuplicateCount",
      ),
      scannedTargetSequenceUnknownCount: count(
        membership.scannedTargetSequenceUnknownCount,
        "membership.scannedTargetSequenceUnknownCount",
      ),
      scannedTargetSequenceMissingCount: count(
        membership.scannedTargetSequenceMissingCount,
        "membership.scannedTargetSequenceMissingCount",
      ),
      targetSequenceCoverageComplete:
        membership.targetSequenceCoverageComplete === true,
    }),
    reconciliation: reconciliation
      ? Object.freeze({
        action: safeEnum(
          reconciliation.action,
          SAFE_RECONCILIATION_ACTIONS,
          "review",
        ),
        missingCount: count(
          reconciliation.missingCount,
          "reconciliation.missingCount",
        ),
        verifiedCount: count(
          reconciliation.verifiedCount,
          "reconciliation.verifiedCount",
        ),
        retryOriginalSetAllowed:
          reconciliation.retryOriginalSetAllowed === true,
        enrollmentBlocked: reconciliation.enrollmentBlocked === true,
        attemptCount: positiveInteger(
          reconciliation.attemptCount,
          "reconciliation.attemptCount",
        ),
        maxAttempts: positiveInteger(
          reconciliation.maxAttempts,
          "reconciliation.maxAttempts",
        ),
        attemptsRemaining: count(
          reconciliation.attemptsRemaining,
          "reconciliation.attemptsRemaining",
        ),
      })
      : null,
    lateMatch: Object.freeze({
      noMatchesEnrollmentRecorded,
      detected: lateMatchDetected,
      intendedAddCount: count(
        lateMatch.curationPlan.missingCount,
        "lateMatch.intendedAddCount",
      ),
      allowSecondEnrollment: false,
      reviewNoteCode: lateMatchDetected
        ? LATE_MATCH_REVIEW_NOTE_CODE
        : null,
      shouldAddReviewNote: lateMatch.shouldAddReviewNote === true,
    }),
    targetSequenceId,
  });
}
