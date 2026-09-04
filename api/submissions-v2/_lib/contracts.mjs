import { createHash } from "node:crypto";

export const EMAIL_SCHEMA = "submissions.email_reply.v1";
export const EMAIL_FAMILIES = new Set([
  "para_ai_interview_request",
  "new_match",
  "fit_follow_up_with_matches",
  "paraform_sequence_reply",
]);

const text = (value, limit = 10_000) => String(value ?? "").trim().slice(0, limit);
const iso = (value) => {
  const parsed = new Date(value || "");
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};
const digest = (value) => createHash("sha256").update(String(value || "")).digest("hex");

function matchHmac(value) {
  if (!value || typeof value !== "object") return value || null;
  const keyVersion = text(value.key_version ?? value.version, 100);
  const hmacDigest = text(value.digest ?? value.value, 500);
  return keyVersion && hmacDigest ? { key_version: keyVersion, digest: hmacDigest } : null;
}

function role(raw) {
  const roleId = text(raw?.role_id ?? raw?.roleId, 200);
  if (!roleId) return null;
  const url = text(raw?.url, 1_000) || `https://www.paraform.com/browse?role=${encodeURIComponent(roleId)}`;
  return {
    role_id: roleId,
    company: text(raw?.company, 300),
    title: text(raw?.title, 500),
    url,
  };
}

function sequenceEvidence(value) {
  if (!value || typeof value !== "object") return null;
  const cacheVersion = Number(value.cache_version);
  const sequenceId = text(value.sequence_id, 500);
  if (cacheVersion !== 3 || !sequenceId) return null;
  return {
    cache_version: 3,
    sequence_id: sequenceId,
    campaign_to_candidate_user_id: text(value.campaign_to_candidate_user_id, 500) || null,
    cached_reply_category: text(value.cached_reply_category, 40) || null,
    exact_role_source: text(value.exact_role_source, 100) || null,
    role_evidence_locator: text(value.role_evidence_locator, 2_000) || null,
  };
}

function currentMasterInbox(input) {
  const family = text(input?.family, 100);
  const payload = input?.payload && typeof input.payload === "object" ? input.payload : {};
  const rawRoleIds = Array.isArray(input?.roleIds) ? input.roleIds
    : Array.isArray(payload?.offeredRoleIds) ? payload.offeredRoleIds
      : input?.roleId ? [input.roleId] : [];
  const offeredRoles = [...new Map(rawRoleIds.map((roleId) => role({ roleId }))
    .filter(Boolean).map((item) => [item.role_id, item])).values()];
  return {
    event_id: text(input?.id, 200) || `mi_${digest(input?.eventKey).slice(0, 32)}`,
    schema_version: EMAIL_SCHEMA,
    adapter_version: `master-inbox-contract-${Number(input?.contractVersion || 0)}`,
    source_family: family,
    source_family_version: String(Number(input?.contractVersion || 0)),
    mailbox_id: text(input?.mailboxId, 200),
    provider: "master_inbox",
    provider_message_id: text(input?.providerMessageId, 500),
    provider_thread_id: text(payload?.providerThreadId, 500) || null,
    outbound_message_id: text(payload?.contractId, 500) || null,
    direction: "inbound",
    sent_at: iso(payload?.sentAt),
    received_at: iso(payload?.receivedAt),
    normalized_sender_email_ref: null,
    sender_match_hmac: matchHmac(input?.senderMatchHmac ?? payload?.senderMatchHmac),
    previous_sender_match_hmac: matchHmac(input?.previousSenderMatchHmac ?? payload?.previousSenderMatchHmac),
    sender_display_name: text(payload?.senderDisplayName, 300) || null,
    subject_ref: null,
    candidate_authored_text_ref: null,
    candidate_authored_text: text(payload?.candidateText, 100_000),
    sent_message_text: text(payload?.sentMessageText, 100_000),
    offered_roles: offeredRoles,
    machine_message: Boolean(payload?.machineMessage),
    raw_record_ref: text(payload?.sourceMessageId, 1_000) || null,
    content_digest: text(payload?.contentDigest, 200) || digest(payload?.candidateText),
    idempotency_key: text(input?.eventKey, 500),
    candidate_user_id_hint: null,
    review_reason_hint: null,
    source_evidence: null,
  };
}

function canonical(input) {
  return {
    event_id: text(input?.event_id, 200),
    schema_version: text(input?.schema_version, 100),
    adapter_version: text(input?.adapter_version ?? input?.source_family_version, 100),
    source_family: text(input?.source_family, 100),
    source_family_version: text(input?.source_family_version, 100),
    mailbox_id: text(input?.mailbox_id, 200),
    provider: text(input?.provider, 100),
    provider_message_id: text(input?.provider_message_id, 500),
    provider_thread_id: text(input?.provider_thread_id, 500) || null,
    outbound_message_id: text(input?.outbound_message_id, 500) || null,
    direction: text(input?.direction, 40),
    sent_at: iso(input?.sent_at),
    received_at: iso(input?.received_at),
    normalized_sender_email_ref: text(input?.normalized_sender_email_ref, 2_000) || null,
    sender_match_hmac: matchHmac(input?.sender_match_hmac),
    previous_sender_match_hmac: matchHmac(input?.previous_sender_match_hmac),
    sender_display_name: text(input?.sender_display_name, 300) || null,
    subject_ref: text(input?.subject_ref, 2_000) || null,
    candidate_authored_text_ref: text(input?.candidate_authored_text_ref, 2_000) || null,
    candidate_authored_text: text(input?.candidate_authored_text, 100_000),
    sent_message_text: text(input?.sent_message_text, 100_000),
    offered_roles: Array.isArray(input?.offered_roles) ? input.offered_roles.map(role).filter(Boolean) : [],
    machine_message: Boolean(input?.machine_message),
    raw_record_ref: text(input?.raw_record_ref, 2_000) || null,
    content_digest: text(input?.content_digest, 200),
    idempotency_key: text(input?.idempotency_key, 500),
    candidate_user_id_hint: text(input?.candidate_user_id_hint, 500) || null,
    review_reason_hint: input?.review_reason_hint === "candidate_ambiguous"
      ? "candidate_ambiguous"
      : null,
    source_evidence: sequenceEvidence(input?.source_evidence),
  };
}

export function normalizeEmailReply(input) {
  const event = input?.schema_version === EMAIL_SCHEMA ? canonical(input) : currentMasterInbox(input);
  const errors = [];
  if (event.schema_version !== EMAIL_SCHEMA) errors.push("unsupported_schema_version");
  if (!EMAIL_FAMILIES.has(event.source_family)) errors.push("unsupported_source_family");
  if (!event.event_id || !event.mailbox_id || !event.provider_message_id || !event.idempotency_key) errors.push("missing_event_identity");
  if (event.direction !== "inbound") errors.push("not_inbound");
  if (!event.received_at) errors.push("received_at_invalid");
  if (!event.sender_match_hmac) errors.push("sender_match_hmac_missing");
  if (!event.offered_roles.length) errors.push("offered_roles_missing");
  if (new Set(event.offered_roles.map((item) => item.role_id)).size !== event.offered_roles.length) errors.push("offered_roles_duplicate");
  if (!event.candidate_authored_text) {
    errors.push(event.candidate_authored_text_ref ? "candidate_text_inline_required" : "candidate_text_missing");
  }
  if (!/^[a-f0-9]{64}$/i.test(event.content_digest)) errors.push("content_digest_invalid");
  return { event, errors, quarantined: errors.some((code) => code.startsWith("unsupported_")) };
}

export function safeEventProjection(event) {
  return {
    event_id: event.event_id,
    schema_version: event.schema_version,
    adapter_version: event.adapter_version,
    source_family: event.source_family,
    source_family_version: event.source_family_version,
    mailbox_id: event.mailbox_id,
    provider: event.provider,
    provider_message_id: event.provider_message_id,
    provider_thread_id: event.provider_thread_id,
    outbound_message_id: event.outbound_message_id,
    direction: event.direction,
    sent_at: event.sent_at,
    received_at: event.received_at,
    sender_match_hmac: event.sender_match_hmac,
    previous_sender_match_hmac: event.previous_sender_match_hmac,
    sender_display_name: event.sender_display_name,
    offered_roles: event.offered_roles,
    machine_message: event.machine_message,
    content_digest: event.content_digest,
    idempotency_key: event.idempotency_key,
    subject_ref: event.subject_ref,
    candidate_authored_text_ref: event.candidate_authored_text_ref,
    normalized_sender_email_ref: event.normalized_sender_email_ref,
    raw_record_ref: event.raw_record_ref,
    candidate_user_id_hint: event.candidate_user_id_hint,
    review_reason_hint: event.review_reason_hint,
    source_evidence: event.source_evidence,
  };
}

export function privateEventPayload(event) {
  return {
    candidate_authored_text: event.candidate_authored_text,
    sent_message_text: event.sent_message_text,
  };
}
