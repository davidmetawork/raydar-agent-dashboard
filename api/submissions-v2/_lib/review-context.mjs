const SOURCE_LABELS = Object.freeze({
  para_ai_interview_request: "Interview Request reply",
  new_match: "New Match reply",
  fit_follow_up_with_matches: "Fit Follow Up reply",
  paraform_sequence_reply: "Sequence reply",
  curated: "Curated List decision",
  manual: "Recruiter confirmation",
});

// This projection is only returned by the authenticated, no-store, on-demand
// Review endpoint; never include it in list polling, logs, or persisted UI state.
export function reviewContext(source, privatePayload = null) {
  const family = source.source_family === "email"
    ? source.envelope?.source_family
    : source.source_family;
  const knownFamily = Object.hasOwn(SOURCE_LABELS, family) ? family : null;
  const authored = source.source_family === "email" && typeof privatePayload?.candidate_authored_text === "string"
    ? privatePayload.candidate_authored_text.trim()
    : "";
  const outbound = source.source_family === "email" && typeof privatePayload?.sent_message_text === "string"
    ? privatePayload.sent_message_text.trim()
    : "";
  const characters = Array.from(authored);
  const outboundCharacters = Array.from(outbound);
  const received = new Date(source.received_at);
  return {
    source_family: knownFamily,
    source_label: SOURCE_LABELS[knownFamily] || "Candidate signal",
    received_at: source.received_at && Number.isFinite(received.getTime()) ? received.toISOString() : null,
    candidate_reply_excerpt: characters.length ? characters.slice(0, 1200).join("") : null,
    excerpt_truncated: characters.length > 1200,
    outbound_offer_excerpt: outboundCharacters.length ? outboundCharacters.slice(0, 2400).join("") : null,
    outbound_offer_truncated: outboundCharacters.length > 2400,
    offered_roles: (Array.isArray(source.offered_roles) ? source.offered_roles : []).map((role) => ({
      role_id: String(role?.role_id || "").trim().slice(0, 200),
      company: String(role?.company || "").trim().slice(0, 300) || null,
      title: String(role?.title || "").trim().slice(0, 500) || null,
    })).filter((role) => role.role_id),
    evidence_status: characters.length ? "available" : "unavailable",
  };
}
