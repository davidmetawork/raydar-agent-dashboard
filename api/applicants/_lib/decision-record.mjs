// The one shape an `apphub:decisions` field may hold.
//
// Two writers produce it — a human click (POST /api/applicants/decision) and
// an armed rule (GET /api/applicants/rules-tick) — and everything downstream
// must be unable to tell them apart. The desktop invite loop pulls un-acked
// `interview` decisions, applies every send-time gate, sends, and acks back;
// it neither knows nor cares which writer produced the field. That is the
// whole point of the design, and it only holds while both writers go through
// this module.
//
// `by` is the ONLY difference: a signed-in email address, or `rule:<id>`.
// The tab reads that prefix to render "by Rule · <name>" instead of a person.

/** Prefix that marks a decision as machine-made. */
export const RULE_ACTOR_PREFIX = "rule:";

export const ruleActor = (ruleId) => `${RULE_ACTOR_PREFIX}${String(ruleId ?? "").slice(0, 60)}`;

export const isRuleActor = (by) => String(by ?? "").startsWith(RULE_ACTOR_PREFIX);

export const ruleIdFromActor = (by) =>
  (isRuleActor(by) ? String(by).slice(RULE_ACTOR_PREFIX.length) : null);

/**
 * Build the record. Field caps match what the tab renders; `name` and
 * `roleTitle` are display-only echoes so the Decided archive can label a row
 * without re-joining the snapshot.
 */
export function decisionRecord({ action, by, name, roleTitle, at, reason }) {
  return {
    action,
    at: at ?? new Date().toISOString(),
    by: String(by ?? "").trim().toLowerCase() || "unknown",
    name: String(name ?? "").slice(0, 120),
    roleTitle: String(roleTitle ?? "").slice(0, 160),
    // Optional, and only ever set by a human Pass. Absent on every record
    // written before reasons existed and on every automatic decision, so
    // readers must treat it as missing rather than empty.
    ...(reason ? { reason: String(reason).slice(0, 40) } : {}),
  };
}

/**
 * The reasons a Pass may carry. A fixed list, not free text: the whole point
 * is to be countable later ("you have passed 14 people for this"), and free
 * text cannot be counted. `other` exists so the chip row is never a trap.
 */
export const PASS_REASONS = [
  { id: "wrong_seniority", label: "Wrong seniority" },
  { id: "wrong_industry", label: "Wrong industry" },
  { id: "no_relevant_experience", label: "No relevant experience" },
  { id: "job_hopper", label: "Job hopper" },
  { id: "not_credible", label: "Not credible" },
  { id: "other", label: "Other" },
];
export const PASS_REASON_IDS = new Set(PASS_REASONS.map((r) => r.id));
