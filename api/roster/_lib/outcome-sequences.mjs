import { campaignLeadsAll } from "../../paraai/_lib/core.mjs";

export const OUTCOME_SEQUENCE_CACHE_TTL_MS = 5 * 60 * 1000;

// Stable Paraform sequence IDs are the contract. Names can be edited in the
// vendor UI and are therefore diagnostics only.
export const OUTCOME_SEQUENCE_RULES = Object.freeze([
  Object.freeze({
    id: "vw168sypaoagu5j5g209cps3",
    expectedName: "(2+) Agent Call Follow Up - Curated List",
    outcome: "Sent List",
  }),
  Object.freeze({
    id: "cmqk75h7x00030bj8f5s6oaw8",
    expectedName: "(1) Agent Call Follow Up - Curated List",
    outcome: "Sent List",
  }),
  Object.freeze({
    id: "u5zsfwujwasmmcufdmzem08f",
    expectedName: "(1) Human Call Follow Up - Curated List",
    outcome: "Sent List",
  }),
  Object.freeze({
    id: "v0ua934p012p3lwpg7610wcz",
    expectedName: "(2+) Human Call Follow Up - Curated List",
    outcome: "Sent List",
  }),
  Object.freeze({
    id: "cmqpje4lh00040cki15nuuqc8",
    expectedName: "No Matches - Added to Para AI",
    outcome: "No Matches - Para AI",
  }),
]);

const text = (value) => String(value || "").trim();

export function leadCandidateUserId(lead) {
  return text(
    lead?.cu_id
      || lead?.candidate_user_id
      || lead?.candidateUserId
      || lead?.candidate_user?.id
      || lead?.candidateUser?.id,
  );
}

export function buildOutcomeMembershipIndex(entries = []) {
  const byCandidateUserId = new Map();
  let leadCount = 0;
  let skippedLeadCount = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const sequenceId = text(entry?.id);
    const outcome = text(entry?.outcome);
    if (!sequenceId || !outcome) continue;
    for (const lead of Array.isArray(entry?.leads) ? entry.leads : []) {
      leadCount++;
      const candidateUserId = leadCandidateUserId(lead);
      if (!candidateUserId) {
        skippedLeadCount++;
        continue;
      }
      const current = byCandidateUserId.get(candidateUserId) || {
        candidateUserId,
        outcomes: new Set(),
        sequenceIds: new Set(),
      };
      current.outcomes.add(outcome);
      current.sequenceIds.add(sequenceId);
      byCandidateUserId.set(candidateUserId, current);
    }
  }

  const memberships = new Map();
  for (const [candidateUserId, current] of byCandidateUserId) {
    const outcomes = [...current.outcomes].sort();
    const sequenceIds = [...current.sequenceIds].sort();
    memberships.set(candidateUserId, {
      candidateUserId,
      outcomeComplete: true,
      verifiedOutcome: outcomes.length === 1 ? outcomes[0] : null,
      outcomeConflict: outcomes.length > 1,
      outcomes,
      sequenceIds,
    });
  }

  return {
    memberships,
    candidateCount: memberships.size,
    leadCount,
    skippedLeadCount,
  };
}

export function applyOutcomeMemberships(statuses = [], membershipIndex = new Map()) {
  return (Array.isArray(statuses) ? statuses : []).map((status) => {
    if (status?.ambiguous === true || !status?.candidateUserId) {
      return {
        ...status,
        outcomeComplete: false,
        verifiedOutcome: null,
        outcomeConflict: false,
        outcomeSequenceIds: [],
      };
    }
    const membership = membershipIndex.get(String(status.candidateUserId));
    if (!membership) {
      return {
        ...status,
        outcomeComplete: false,
        verifiedOutcome: null,
        outcomeConflict: false,
        outcomeSequenceIds: [],
      };
    }
    return {
      ...status,
      // These five sequences are downstream of Talent Network review. Exact
      // candidate-ID membership is therefore also authoritative Added proof.
      status: "added",
      label: "Added",
      added: true,
      source: status.status === "added" ? status.source : "outcome_sequence",
      outcomeComplete: true,
      verifiedOutcome: membership.verifiedOutcome,
      outcomeConflict: membership.outcomeConflict,
      outcomeSequenceIds: membership.sequenceIds,
    };
  });
}

export async function readOutcomeSequenceSnapshot({
  readLeads = campaignLeadsAll,
  rules = OUTCOME_SEQUENCE_RULES,
} = {}) {
  const entries = await Promise.all(rules.map(async (rule) => ({
    ...rule,
    leads: await readLeads(rule.id),
  })));
  return {
    complete: true,
    entries,
    ruleCount: entries.length,
  };
}

export function createOutcomeSequenceSnapshotLoader({
  scan = readOutcomeSequenceSnapshot,
  now = Date.now,
  ttlMs = OUTCOME_SEQUENCE_CACHE_TTL_MS,
} = {}) {
  let cache = { at: 0, snapshot: null, pending: null };

  return async function loadOutcomeSequenceSnapshot({ refresh = false } = {}) {
    const current = Number(now());
    if (!refresh && cache.snapshot && current - cache.at < ttlMs) {
      return { ...cache.snapshot, cached: true };
    }
    if (cache.pending) {
      const snapshot = await cache.pending;
      return { ...snapshot, cached: false };
    }
    cache.pending = Promise.resolve()
      .then(() => scan())
      .then((snapshot) => {
        if (snapshot?.complete !== true) {
          const error = new Error("Paraform outcome sequence scan was incomplete");
          error.code = "OUTCOME_SEQUENCE_SCAN_INCOMPLETE";
          throw error;
        }
        const completedAt = Number(now());
        const value = {
          ...snapshot,
          generatedAt: new Date(completedAt).toISOString(),
        };
        cache = { at: completedAt, snapshot: value, pending: null };
        return value;
      })
      .catch((error) => {
        cache.pending = null;
        throw error;
      });
    const snapshot = await cache.pending;
    return { ...snapshot, cached: false };
  };
}
