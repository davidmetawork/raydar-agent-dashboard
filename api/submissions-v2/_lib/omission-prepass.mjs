import { createHash } from "node:crypto";

/**
 * Deterministic omission pre-pass (rulebook R27/R28).
 *
 * When a candidate answers a multi-role send by naming some of the offered
 * roles positively and saying nothing about the rest, the silence is a
 * rejection of the rest: on the 2026-09-08 ground-truth sheet 44 of the 47
 * omission rows that sat beside a positive naming were Not Interested (94%),
 * 0 were Interested.
 *
 * This runs OUTSIDE the model and never fabricates a candidate quote (R27):
 * the recorded evidence is the offered-set digest, the roles the reply did
 * decide, and the provider message id. Every gate in R28 is enforced here, and
 * the whole pass is off unless SUBMISSIONS_V2_OMISSION_PREPASS is "apply".
 */

export const OMISSION_EVIDENCE_KIND = "omission_prepass_v1";
export const OMISSION_GROUNDED_REASON =
  "Not named in a reply that accepted other roles offered in the same message.";

const EMAIL_SCHEMA = "submissions.email_reply.v1";
// Offered lists we accept as an exact producer list. The Gmail reader takes
// them from the verified outbound parent's own trusted links; a Master Inbox
// contract event takes them from the registered outbound contract it was
// joined to; campaign.role_id is the literal producer role id on a sequence.
const EXACT_PRODUCER_ADAPTERS = new Set(["gmail-role-interest-v2"]);
const CONTRACT_ADAPTER_PREFIX = "master-inbox-contract-";
const EXACT_PRODUCER_ROLE_SOURCES = new Set(["campaign.role_id"]);
// A curated-list read and the candidate's own named roles are never an
// offered list the producer sent (R28).
const REJECTED_ROLE_SOURCES = new Set(["candidate_authored_explicit"]);
const QUOTED_HISTORY = /(?:^|\n)\s*(?:>|On\s.{1,200}\bwrote:|-{2,}\s*(?:original|forwarded)\s+message|begin forwarded message:|from:\s)/iu;

const text = (value) => String(value ?? "");
const digest = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");

export function omissionPrepassMode(env = process.env) {
  const value = text(env.SUBMISSIONS_V2_OMISSION_PREPASS).trim().toLowerCase();
  return value === "apply" ? "apply" : "off";
}

/** The exact producer list kind, or null when this event has no exact list. */
export function exactProducerRoleSource(event) {
  const evidence = event?.source_evidence || null;
  const declared = text(evidence?.exact_role_source).trim();
  if (declared && REJECTED_ROLE_SOURCES.has(declared)) return null;
  if (evidence?.resolution_version === "candidate-explicit-role-v1") return null;
  if (declared && EXACT_PRODUCER_ROLE_SOURCES.has(declared)) return declared;
  if (declared) return null;
  const adapter = text(event?.adapter_version).trim();
  const outbound = text(event?.outbound_message_id).trim();
  if (!outbound) return null;
  if (EXACT_PRODUCER_ADAPTERS.has(adapter)) return "outbound_parent_links";
  if (adapter.startsWith(CONTRACT_ADAPTER_PREFIX)) return "outbound_contract";
  return null;
}

/**
 * @returns {{mode: string, skipped: string|null, decisions: Array}} decisions is
 * always empty unless every gate passed; the caller applies them alongside the
 * classifier's own decisions.
 */
export function omissionDecisions({ event, decisions, env = process.env, operatorScopedRoles = false } = {}) {
  const mode = omissionPrepassMode(env);
  const skip = (reason) => ({ mode, skipped: reason, decisions: [] });
  if (mode !== "apply") return skip("prepass_off");
  if (!event || event.schema_version !== EMAIL_SCHEMA) return skip("not_email_reply");
  if (operatorScopedRoles) return skip("operator_scoped_roles");

  const offered = Array.isArray(event.offered_roles) ? event.offered_roles : [];
  const offeredIds = offered.map((role) => String(role?.role_id || "")).filter(Boolean);
  if (offeredIds.length !== offered.length || new Set(offeredIds).size !== offeredIds.length) return skip("offered_roles_invalid");
  if (offeredIds.length < 2) return skip("single_offered_role");

  const roleSource = exactProducerRoleSource(event);
  if (!roleSource) return skip("role_source_not_exact_producer");

  // One send only: quoted or forwarded history means the reply is arguing with
  // more than the message we bound the offered set from (R28, R24).
  if (QUOTED_HISTORY.test(text(event.candidate_authored_text))) return skip("reply_contains_quoted_history");

  const list = Array.isArray(decisions) ? decisions : [];
  if (!list.length) return skip("no_decisions");
  const decidedIds = list.map((decision) => String(decision?.role_id || ""));
  const offeredSet = new Set(offeredIds);
  if (decidedIds.some((roleId) => !offeredSet.has(roleId))) return skip("decision_outside_offer");
  if (new Set(decidedIds).size !== decidedIds.length) return skip("decision_duplicate_role");
  if (list.some((decision) => decision?.label === "needs_review")) return skip("reply_has_review_decision");
  if (!list.some((decision) => decision?.label === "interested")) return skip("no_interested_decision");

  const decided = new Set(decidedIds);
  const unnamed = offeredIds.filter((roleId) => !decided.has(roleId));
  if (!unnamed.length) return skip("every_offered_role_decided");

  const evidence = Object.freeze({
    kind: OMISSION_EVIDENCE_KIND,
    role_source: roleSource,
    offered_role_count: offeredIds.length,
    offered_role_set_digest: digest([...offeredIds].sort().join("\n")),
    named_role_ids: decidedIds,
    provider: text(event.provider) || null,
    provider_message_id: text(event.provider_message_id) || null,
    outbound_message_id: text(event.outbound_message_id) || null,
  });

  return {
    mode,
    skipped: null,
    decisions: unnamed.map((roleId) => Object.freeze({
      role_id: roleId,
      label: "not_interested",
      quote: null,
      review_reason: null,
      negative_reason: null,
      evidence_kind: OMISSION_EVIDENCE_KIND,
      evidence,
    })),
  };
}
