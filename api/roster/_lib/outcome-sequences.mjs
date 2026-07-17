import { campaignLeadsAll } from "../../paraai/_lib/core.mjs";

export const OUTCOME_SEQUENCE_CACHE_TTL_MS = 5 * 60 * 1000;
export const OUTCOME_SEQUENCE_STALE_MAX_AGE_MS = 15 * 60 * 1000;
export const OUTCOME_SEQUENCE_READ_ATTEMPTS = 2;

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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  attempts = OUTCOME_SEQUENCE_READ_ATTEMPTS,
  waitImpl = wait,
} = {}) {
  const entries = [];
  for (const rule of rules) {
    let leads = null;
    let lastError = null;
    for (let attempt = 0; attempt < Math.max(1, Number(attempts) || 1); attempt++) {
      try {
        leads = await readLeads(rule.id);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (error?.code === "AUTH_EXPIRED" || attempt >= attempts - 1) break;
        await waitImpl(250 * (attempt + 1));
      }
    }
    if (lastError) {
      const error = new Error(`outcome sequence ${rule.id} read failed: ${String(lastError?.message || lastError)}`);
      error.code = lastError?.code === "AUTH_EXPIRED" ? "AUTH_EXPIRED" : "OUTCOME_SEQUENCE_READ_FAILED";
      error.sequenceId = rule.id;
      error.cause = lastError;
      throw error;
    }
    entries.push({ ...rule, leads: Array.isArray(leads) ? leads : [] });
  }
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
  staleMaxAgeMs = OUTCOME_SEQUENCE_STALE_MAX_AGE_MS,
} = {}) {
  let cache = { at: 0, snapshot: null, pending: null };

  return async function loadOutcomeSequenceSnapshot({ refresh = false } = {}) {
    const current = Number(now());
    if (!refresh && cache.snapshot && current - cache.at < ttlMs) {
      return { ...cache.snapshot, cached: true };
    }
    if (cache.pending) {
      const snapshot = await cache.pending;
      return { ...snapshot, cached: snapshot?.cached === true };
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
        const failedAt = Number(now());
        const staleSnapshot = cache.snapshot && failedAt - cache.at <= staleMaxAgeMs
          ? {
              ...cache.snapshot,
              cached: true,
              stale: true,
              refreshError: String(error?.code || error?.message || error).slice(0, 120),
            }
          : null;
        cache.pending = null;
        if (staleSnapshot) return staleSnapshot;
        throw error;
      });
    const snapshot = await cache.pending;
    return { ...snapshot, cached: snapshot?.cached === true };
  };
}
