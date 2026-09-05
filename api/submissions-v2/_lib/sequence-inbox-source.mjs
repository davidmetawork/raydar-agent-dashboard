import { createHash, createHmac } from "node:crypto";

import {
  INBOX_SUBMISSIONS_PROJECTION_VERSION,
  inboxSubmissionsProjectionCoverage,
  inboxTrpcGet,
  publicMessage,
  readInboxSnapshotState,
  shouldExcludeSubmissionsInboxReply,
  validInboxGmailId,
} from "../../inbox/_lib/core.mjs";
import { EMAIL_SCHEMA } from "./contracts.mjs";

export const SEQUENCE_REPLY_FAMILY = "paraform_sequence_reply";
export const SEQUENCE_REPLY_ADAPTER_VERSION = "sequence-inbox-v1";
const KNOWN_OUTBOUND_FAMILIES = new Set([
  "para_ai_interview_request",
  "new_match",
  "fit_follow_up_with_matches",
]);
const CHECKPOINT_BLOCKING_DEFERRED_REASONS = new Set([
  "full_message_unavailable",
  "full_message_read_failed",
  "projection_identity_conflict",
  "provider_message_id_invalid",
  "cache_received_at_invalid",
  "provider_direction_unavailable",
  "received_at_invalid",
  "sender_identity_invalid",
  "mailbox_identity_invalid",
]);
const EMAIL = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/giu;
const text = (value, limit = 100_000) => String(value ?? "").trim().slice(0, limit);
const list = (value) => (Array.isArray(value) ? value : []);
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const fail = (code) => Object.assign(new Error(code), { code, retryable: true });

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function emails(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((item) => (
    String(item || "").toLowerCase().match(EMAIL) || []
  )))];
}

function mailboxIdentity(message, sender) {
  const recipients = emails(message?.to);
  if (recipients.length !== 1 || recipients[0] === sender) return null;
  return {
    email: recipients[0],
    id: recipients[0].replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, ""),
  };
}

function plainHtml(value) {
  return String(value || "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu, "$2 ($1)")
    .replace(/<(?:br\s*\/?|\/p|\/div|\/li)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<").replace(/&gt;/giu, ">").replace(/&quot;/giu, '"');
}

/** Extract only the newly authored portion of a complete message body. */
export function sequenceAuthoredReply(body) {
  const raw = String(body || "");
  const withoutHtmlQuote = raw.split(/<(?:blockquote\b|div\b[^>]*\bclass=["'][^"']*\b(?:gmail_quote|yahoo_quoted)\b)/iu)[0];
  const value = /<[^>]+>/u.test(withoutHtmlQuote) ? plainHtml(withoutHtmlQuote) : withoutHtmlQuote;
  return value
    .split(/\n\s*(?:On [\s\S]{0,500}?wrote:|[-_]{2,}\s*(?:Original|Forwarded) Message|Begin forwarded message:|From:\s)/iu)[0]
    .split("\n")
    .filter((line) => !/^\s*>/u.test(line))
    .join("\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function exactCampaignRole(campaign) {
  if (campaign?.exact_role_source !== "campaign.role_id") return null;
  const roleId = text(campaign?.exact_role_id, 200);
  return roleId ? {
    role_id: roleId,
    company: "",
    title: "",
    url: `https://www.paraform.com/browse?role=${encodeURIComponent(roleId)}`,
  } : null;
}

function exactSavedCampaignMapping(reply, campaign, mappings) {
  const sequenceId = text(reply?.sequence_id, 500);
  const projectId = campaign?.exact_project_source === "campaign.project_id"
    ? text(campaign?.exact_project_id, 500)
    : "";
  const receivedAt = timestamp(reply?.date);
  const candidates = list(mappings).filter((mapping) => (
    text(mapping?.sequence_id, 500) === sequenceId
  ));
  if (!candidates.length) return { mapping: null, unverifiable: false };
  // One retained role-state key per role means any reverse-map multiplicity is
  // ambiguous, including an inactive or malformed sibling. Never let filtering
  // choose the apparently better row.
  if (candidates.length > 1) return { mapping: null, conflict: true, unverifiable: false };
  const verified = candidates.filter((mapping) => {
    const attestedAt = timestamp(mapping?.attested_at);
    return mapping?.valid === true
      && mapping?.active === true
      && mapping?.sequence_created === true
      && projectId
      && text(mapping?.project_id, 500) === projectId
      && receivedAt !== null
      && attestedAt !== null
      && attestedAt <= receivedAt
      && text(mapping?.role_id, 200)
      && text(mapping?.evidence_locator, 2_000);
  });
  const roleIds = new Set(verified.map((mapping) => text(mapping.role_id, 200)));
  if (roleIds.size > 1) return { mapping: null, conflict: true, unverifiable: false };
  return {
    mapping: verified.sort((left, right) => (
      text(left.evidence_locator, 2_000).localeCompare(text(right.evidence_locator, 2_000))
    ))[0] || null,
    conflict: false,
    unverifiable: verified.length === 0,
  };
}

function exactOutboundMappings(reply, mappings) {
  return list(mappings).filter((mapping) => {
    if (text(mapping?.sequence_id, 500) !== text(reply?.sequence_id, 500)) return false;
    if (!text(mapping?.outbound_message_id, 500) || !text(mapping?.evidence_locator, 2_000)) return false;
    const threadMatch = text(mapping?.provider_thread_id, 500)
      && text(mapping.provider_thread_id, 500) === text(reply?.thread_id, 500);
    const recipientMatch = text(mapping?.campaign_to_candidate_user_id, 500)
      && text(mapping.campaign_to_candidate_user_id, 500) === text(reply?.ccu_id, 500);
    return Boolean(threadMatch || recipientMatch);
  });
}

function mappedRoles(mapping) {
  const values = list(mapping?.roles).length
    ? mapping.roles
    : list(mapping?.role_ids).map((roleId) => ({ role_id: roleId }));
  const found = new Map();
  for (const raw of values) {
    const roleId = text(raw?.role_id ?? raw?.roleId, 200);
    if (!roleId) continue;
    found.set(roleId, {
      role_id: roleId,
      company: text(raw?.company, 300),
      title: text(raw?.title, 500),
      url: text(raw?.url, 1_000)
        || `https://www.paraform.com/browse?role=${encodeURIComponent(roleId)}`,
    });
  }
  return [...found.values()].sort((left, right) => left.role_id.localeCompare(right.role_id));
}

function roleResolution(reply, campaign, mappings, savedRoleMappings) {
  const campaignRole = exactCampaignRole(campaign);
  const saved = exactSavedCampaignMapping(reply, campaign, savedRoleMappings);
  if (saved.conflict) return { roles: [], error: "role_mapping_conflict" };
  const savedRoleId = text(saved.mapping?.role_id, 200);
  if (campaignRole && savedRoleId && campaignRole.role_id !== savedRoleId) {
    return { roles: [], error: "role_mapping_conflict" };
  }
  const exactMappings = exactOutboundMappings(reply, mappings);
  const mapped = exactMappings.map((mapping) => ({ mapping, roles: mappedRoles(mapping) }))
    .filter((item) => item.roles.length);
  const signatures = new Set(mapped.map((item) => item.roles.map((role) => role.role_id).join("\0")));
  if (signatures.size > 1) return { roles: [], error: "role_mapping_conflict" };
  const chosen = mapped[0] || null;
  if (campaignRole && chosen && !chosen.roles.some((role) => role.role_id === campaignRole.role_id)) {
    return { roles: [], error: "role_mapping_conflict" };
  }
  if (savedRoleId && chosen && !chosen.roles.some((role) => role.role_id === savedRoleId)) {
    return { roles: [], error: "role_mapping_conflict" };
  }
  if (chosen) {
    return {
      roles: chosen.roles,
      source: "exact_outbound_mapping",
      evidence_locator: text(chosen.mapping.evidence_locator, 2_000),
      outbound_message_id: text(chosen.mapping.outbound_message_id, 500),
      sent_message_text: text(chosen.mapping.sent_message_text),
      family: KNOWN_OUTBOUND_FAMILIES.has(chosen.mapping.family)
        ? chosen.mapping.family
        : SEQUENCE_REPLY_FAMILY,
    };
  }
  if (campaignRole) {
    return { roles: [campaignRole], source: "campaign.role_id", family: SEQUENCE_REPLY_FAMILY };
  }
  if (saved.mapping) {
    return {
      roles: mappedRoles({ role_ids: [savedRoleId] }),
      source: "sourcing.role_state.mapping",
      evidence_locator: text(saved.mapping.evidence_locator, 2_000),
      family: SEQUENCE_REPLY_FAMILY,
    };
  }
  if (saved.unverifiable) {
    return { roles: [], error: "role_mapping_unverifiable", family: SEQUENCE_REPLY_FAMILY };
  }
  return { roles: [], error: "role_unmapped", family: SEQUENCE_REPLY_FAMILY };
}

function savedRoleMappingCoverage(status, mappings) {
  const ready = status === "ready";
  const inventory = ready ? list(mappings) : [];
  return {
    sourcing_role_mapping_status: ready ? "ready" : "unavailable",
    sourcing_role_mapping_inventory_count: inventory.length,
    // This is a record validation count only. It does not imply that a row was
    // admitted: sequence collisions, project mismatch, and reply time still
    // fail closed in roleResolution.
    sourcing_role_mapping_valid_record_count: inventory.filter((mapping) => (
      mapping?.valid === true
    )).length,
  };
}

function senderIdentity(message) {
  const from = emails(message?.from);
  return from.length === 1 ? from[0] : null;
}

function directGmailOwnedMessage(message) {
  const subject = text(message?.subject, 1_000);
  return /\b(?:interview request(?:s)?|new match(?:es)?|raydar\s*-\s*1st round interview)\b/iu.test(subject);
}

function deferred(reply, reason, extra = {}) {
  return {
    status: "deferred",
    reason,
    sequence_id: text(reply?.sequence_id, 500) || null,
    provider_message_id: text(reply?.gmail_id, 500) || null,
    ...extra,
  };
}

/**
 * Pure adapter. `detail.complete === true` means the broker read the provider's
 * full message; cached preview text is never accepted as candidate evidence.
 */
export function adaptSequenceInboxReply({
  reply,
  campaign = null,
  detail,
  activationAt,
  outboundMappings = [],
  savedRoleMappings = [],
  forceNeutral = false,
  env = process.env,
} = {}) {
  if (!reply || !validInboxGmailId(reply.gmail_id)) return deferred(reply, "provider_message_id_invalid");
  if (detail?.complete !== true || !detail.message || typeof detail.message !== "object") {
    return deferred(reply, "full_message_unavailable");
  }
  const message = detail.message;
  if (message.sent_from_paraform === true) return deferred(reply, "outbound_message");
  if (message.sent_from_paraform !== false) return deferred(reply, "provider_direction_unavailable");
  const receivedAt = timestamp(message.date);
  const activation = timestamp(activationAt);
  if (activation === null) throw fail("sequence_inbox_activation_required");
  if (receivedAt === null) return deferred(reply, "received_at_invalid");
  if (receivedAt < activation) return deferred(reply, "before_activation");
  const sender = senderIdentity(message);
  if (!sender) return deferred(reply, "sender_identity_invalid");
  const mailbox = mailboxIdentity(message, sender);
  if (!mailbox) return deferred(reply, "mailbox_identity_invalid");
  // The direct Gmail adapter owns only its deterministic reply-subject
  // families. A body-only query hit has no safe family without its parent, so
  // it remains in Sequence instead of being silently lost.
  if (mailbox.email === "david@raydar.xyz" && directGmailOwnedMessage(message)) {
    return deferred(reply, "gmail_owned_mailbox");
  }
  const authoredText = sequenceAuthoredReply(message.body);
  if (!authoredText) return deferred(reply, "candidate_text_missing");
  if (shouldExcludeSubmissionsInboxReply({
    candidate_email: sender,
    from: message.from,
    subject: message.subject,
    snippet: authoredText,
  }, message.to)) return deferred(reply, "machine_or_excluded_message");

  const secret = String(env.SUBMISSIONS_V2_EMAIL_HMAC_KEY || "");
  const keyVersion = text(env.SUBMISSIONS_V2_EMAIL_HMAC_VERSION, 100);
  if (secret.length < 32 || !keyVersion) throw fail("sequence_inbox_email_hmac_not_configured");

  const resolution = forceNeutral
    ? { roles: [], error: "role_unmapped", family: SEQUENCE_REPLY_FAMILY }
    : roleResolution(reply, campaign, outboundMappings, savedRoleMappings);
  const cachedCandidateEmail = forceNeutral ? null : emails(reply.candidate_email)[0] || null;
  const candidateConflict = Boolean(cachedCandidateEmail && cachedCandidateEmail !== sender);
  const idempotencyKey = `gmail:${mailbox.id}:${reply.gmail_id}`;
  const content = {
    candidateText: authoredText,
    sentText: resolution.sent_message_text || "",
    offered: resolution.roles,
  };
  const event = {
    schema_version: EMAIL_SCHEMA,
    event_id: `sequence_${sha256(idempotencyKey).slice(0, 32)}`,
    source_family: resolution.family,
    source_family_version: "1",
    adapter_version: SEQUENCE_REPLY_ADAPTER_VERSION,
    mailbox_id: mailbox.id,
    provider: "gmail",
    provider_message_id: text(reply.gmail_id, 500),
    provider_thread_id: text(reply.thread_id, 500) || null,
    outbound_message_id: resolution.outbound_message_id || null,
    direction: "inbound",
    sent_at: null,
    received_at: new Date(receivedAt).toISOString(),
    normalized_sender_email_ref: null,
    sender_match_hmac: {
      key_version: keyVersion,
      digest: createHmac("sha256", secret).update(sender).digest("base64url"),
    },
    previous_sender_match_hmac: null,
    sender_display_name: text(message.from_name, 300) || null,
    subject_ref: null,
    candidate_authored_text_ref: null,
    candidate_authored_text: authoredText,
    sent_message_text: resolution.sent_message_text || "",
    offered_roles: resolution.roles,
    machine_message: false,
    raw_record_ref: forceNeutral
      ? `paraform-sequence:ambiguous:${text(reply.gmail_id, 500)}`
      : `paraform-sequence:${text(reply.sequence_id, 500)}:${text(reply.gmail_id, 500)}`,
    content_digest: sha256(JSON.stringify(content)),
    idempotency_key: idempotencyKey,
    candidate_user_id_hint: forceNeutral ? null : text(reply.candidate_user_id, 500) || null,
    review_reason_hint: candidateConflict ? "candidate_ambiguous" : null,
    source_evidence: {
      cache_version: 3,
      sequence_id: forceNeutral ? null : text(reply.sequence_id, 500),
      campaign_to_candidate_user_id: forceNeutral ? null : text(reply.ccu_id, 500) || null,
      cached_reply_category: text(reply.reply_category, 40) || null,
      exact_role_source: resolution.source || null,
      role_evidence_locator: resolution.evidence_locator || null,
    },
  };
  const reviewReasons = [
    ...(resolution.error ? [resolution.error === "role_unmapped" ? "role_unclear" : resolution.error] : []),
    ...(candidateConflict ? ["candidate_ambiguous"] : []),
  ];
  return {
    status: "ready",
    route: reviewReasons.length ? "needs_review" : "classify",
    review_reasons: reviewReasons,
    event,
    candidate_resolution_hint: {
      candidate_user_id: forceNeutral ? null : text(reply.candidate_user_id, 500) || null,
      source: forceNeutral ? null : text(reply.candidate_user_id, 500) ? "campaign_membership" : null,
      sender_matches_cached_email: cachedCandidateEmail ? !candidateConflict : null,
    },
    source_evidence: {
      cache_version: 3,
      sequence_id: forceNeutral ? null : text(reply.sequence_id, 500),
      campaign_to_candidate_user_id: forceNeutral ? null : text(reply.ccu_id, 500) || null,
      provider_message_id: text(reply.gmail_id, 500),
      provider_thread_id: text(reply.thread_id, 500) || null,
      cached_reply_category: text(reply.reply_category, 40) || null,
      full_message_read: true,
      exact_role_source: resolution.source || null,
      role_evidence_locator: resolution.evidence_locator || null,
    },
  };
}

/** Existing Paraform point read, shared with Sequence Inbox message view. */
export async function readCompleteSequenceInboxMessage(
  gmailId,
  { get = inboxTrpcGet, timeoutMs } = {},
) {
  if (!validInboxGmailId(gmailId)) throw fail("provider_message_id_invalid");
  const args = ["campaigns.getCampaignEmail", { gmail_id: gmailId }, 1];
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) args.push(Math.floor(timeoutMs));
  const message = await get(...args);
  if (!message || typeof message !== "object") throw fail("full_message_unavailable");
  return { complete: true, message: publicMessage(message) };
}

function campaignMap(state) {
  return new Map(list(state?.catalog?.targets).map((campaign) => [text(campaign?.id, 500), campaign]));
}

function cursorKey(reply) {
  const at = timestamp(reply?.date);
  return `${String(at ?? -1).padStart(16, "0")}:${text(reply?.gmail_id, 500)}`;
}

function decodeCursor(value, overlapMs = 0) {
  if (!value) return "";
  try {
    const decoded = Buffer.from(String(value), "base64url").toString("utf8");
    if (!/^\d{16}:(?:[a-zA-Z0-9._:-]{1,512}|~)$/u.test(decoded)) throw new Error();
    if (overlapMs > 0) {
      const milliseconds = Math.max(0, Number(decoded.slice(0, 16)) - overlapMs);
      return `${String(milliseconds).padStart(16, "0")}:`;
    }
    return decoded;
  } catch {
    throw fail("sequence_inbox_cursor_invalid");
  }
}

/**
 * Read a bounded page from the existing Inbox v3 cache. The caller injects a
 * full-message broker; this module has no Paraform or Gmail network client.
 */
export async function readCachedSequenceReplyBatch({
  readState = readInboxSnapshotState,
  readMessage,
  activationAt,
  outboundMappings = [],
  savedRoleMappings = [],
  savedRoleMappingDigest = null,
  savedRoleMappingStatus = "unavailable",
  env = process.env,
  limit = 25,
  cursor = null,
  cursorOverlapMs = 0,
  expectedCatalogDigest = null,
  expectedWatermark = null,
  now = () => new Date(),
} = {}) {
  if (typeof readMessage !== "function") throw fail("sequence_inbox_message_reader_required");
  const activation = timestamp(activationAt);
  if (activation === null) throw fail("sequence_inbox_activation_required");
  const loaded = await readState();
  if (loaded?.status !== "ready" || !loaded.value) throw fail("sequence_inbox_cache_unavailable");
  const state = loaded.value;
  const projectionCoverage = inboxSubmissionsProjectionCoverage(state, { now });
  const targets = campaignMap(state);
  const targetIds = [...targets.keys()];
  const projectionReady = state.catalog?.submissions_projection_version
      === INBOX_SUBMISSIONS_PROJECTION_VERSION
    && targetIds.every((sequenceId) => (
      state.snapshots?.get(sequenceId)?.submissions_projection_version
        === INBOX_SUBMISSIONS_PROJECTION_VERSION
    ));
  if (!projectionReady) {
    return {
      records: [],
      deferred: [deferred(null, "submissions_projection_unavailable")],
      next_cursor: null,
      checkpoint_cursor: cursor,
      coverage: {
        cache_state: projectionCoverage.state || "unseeded",
        cache_coverage_complete: Boolean(projectionCoverage.coverage_complete),
        cache_last_complete_at: projectionCoverage.last_complete_at || null,
        cache_confirmed_through: projectionCoverage.confirmed_through || null,
        cache_campaigns_targeted: Number(projectionCoverage.campaigns_targeted) || 0,
        cache_campaigns_missing: Number(projectionCoverage.campaigns_missing) || 0,
        cache_campaigns_stale: Number(projectionCoverage.campaigns_stale) || 0,
        catalog_digest: projectionCoverage.catalog_digest || null,
        ...savedRoleMappingCoverage(savedRoleMappingStatus, savedRoleMappings),
        watermark: projectionCoverage.confirmed_through || null,
        cached_replies: 0,
        before_activation: 0,
        page_size: 0,
        ready: 0,
        deferred: 1,
        has_more: false,
        checkpoint_safe: false,
        cycle_complete: false,
        full_success: false,
      },
    };
  }
  const baseCatalogDigest = text(projectionCoverage.catalog_digest, 128) || null;
  const mappingDigest = text(savedRoleMappingDigest, 128)
    || sha256(JSON.stringify(list(savedRoleMappings).map((mapping) => ({
      sequence_id: text(mapping?.sequence_id, 500),
      role_id: text(mapping?.role_id, 200),
      project_id: text(mapping?.project_id, 500),
      attested_at: text(mapping?.attested_at, 100),
      evidence_locator: text(mapping?.evidence_locator, 2_000),
      sequence_created: mapping?.sequence_created === true,
      active: mapping?.active === true,
      valid: mapping?.valid === true,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))));
  const currentDigest = sha256(JSON.stringify({
    cache_catalog_digest: baseCatalogDigest,
    sourcing_role_mapping_digest: mappingDigest,
  }));
  const currentWatermark = projectionCoverage.confirmed_through || null;
  const expectedWatermarkAt = expectedWatermark == null
    ? null
    : timestamp(expectedWatermark);
  const normalizedExpectedWatermark = expectedWatermarkAt === null
    ? null
    : new Date(expectedWatermarkAt).toISOString();
  const catalogChanged = Boolean(expectedCatalogDigest && expectedCatalogDigest !== currentDigest);
  const watermarkRegressed = Boolean(
    normalizedExpectedWatermark
    && (!currentWatermark || Date.parse(currentWatermark) < Date.parse(normalizedExpectedWatermark)),
  );
  if (catalogChanged || watermarkRegressed) {
    return {
      records: [],
      deferred: [],
      next_cursor: null,
      checkpoint_cursor: null,
      coverage: {
        cache_state: projectionCoverage.state || "unseeded",
        cache_coverage_complete: Boolean(projectionCoverage.coverage_complete),
        cache_last_complete_at: projectionCoverage.last_complete_at || null,
        cache_confirmed_through: currentWatermark,
        cache_campaigns_targeted: Number(projectionCoverage.campaigns_targeted) || 0,
        cache_campaigns_missing: Number(projectionCoverage.campaigns_missing) || 0,
        cache_campaigns_stale: Number(projectionCoverage.campaigns_stale) || 0,
        catalog_digest: currentDigest,
        ...savedRoleMappingCoverage(savedRoleMappingStatus, savedRoleMappings),
        watermark: currentWatermark,
        catalog_changed: catalogChanged,
        watermark_changed: watermarkRegressed,
        watermark_advanced: false,
        cached_replies: 0,
        before_activation: 0,
        page_size: 0,
        ready: 0,
        deferred: 0,
        has_more: false,
        checkpoint_safe: true,
        cycle_complete: false,
        full_success: false,
      },
    };
  }
  const overlapMs = Math.max(0, Math.min(3_600_000, Number(cursorOverlapMs) || 0));
  const afterKey = decodeCursor(cursor, overlapMs);
  const confirmedThrough = timestamp(projectionCoverage.confirmed_through);
  const maximum = Math.max(1, Math.min(50, Number(limit) || 25));
  const seen = new Map();
  const conflicting = new Map();
  const invalid = [];
  const beforeActivation = [];
  const eligible = [];
  const projectedReplies = targetIds.flatMap((sequenceId) => (
    list(state.snapshots.get(sequenceId)?.submissions_replies)
  ));
  for (const reply of projectedReplies) {
    const gmailId = text(reply?.gmail_id, 500);
    const cachedAt = timestamp(reply?.date);
    if (cachedAt === null) {
      invalid.push(deferred(reply, "cache_received_at_invalid"));
      continue;
    }
    if (cachedAt < activation) {
      beforeActivation.push(gmailId);
      continue;
    }
    if (confirmedThrough !== null && cachedAt > confirmedThrough) continue;
    if (!validInboxGmailId(gmailId)) {
      invalid.push(deferred(reply, "provider_message_id_invalid"));
      continue;
    }
    const identity = JSON.stringify([
      text(reply?.sequence_id, 500),
      text(reply?.candidate_user_id, 500),
      emails(reply?.candidate_email)[0] || "",
      text(targets.get(text(reply?.sequence_id, 500))?.exact_role_id, 200),
      text(targets.get(text(reply?.sequence_id, 500))?.exact_role_source, 100),
    ]);
    const prior = seen.get(gmailId);
    const priorIdentity = prior?.identity;
    if (priorIdentity) {
      if (priorIdentity !== identity) {
        // Read one full provider detail and emit only neutral Review evidence.
        // Never let iteration order choose a campaign/candidate binding.
        const eligibleIndex = eligible.findIndex((item) => text(item?.gmail_id, 500) === gmailId);
        if (eligibleIndex >= 0) eligible.splice(eligibleIndex, 1);
        const choices = [prior.reply, reply].filter(Boolean);
        const representative = [...choices].sort((left, right) => (
          cursorKey(left).localeCompare(cursorKey(right))
        ))[0];
        conflicting.set(gmailId, representative);
      }
      continue;
    }
    seen.set(gmailId, { identity, reply });
    if (confirmedThrough !== null && cachedAt <= confirmedThrough && cursorKey(reply) > afterKey) {
      eligible.push(reply);
    }
  }
  for (const reply of conflicting.values()) {
    const cachedAt = timestamp(reply?.date);
    if (cachedAt !== null && cachedAt >= activation && confirmedThrough !== null
      && cachedAt <= confirmedThrough && cursorKey(reply) > afterKey) {
      eligible.push({ ...reply, sequence_id: "", candidate_user_id: "", candidate_email: "", ccu_id: "", projection_identity_conflict: true });
    }
  }
  eligible.sort((left, right) => cursorKey(left).localeCompare(cursorKey(right)));
  const page = eligible.slice(0, maximum);
  const records = [];
  const deferredRecords = [...invalid];
  for (const reply of page) {
    let detail;
    try {
      detail = await readMessage(reply.gmail_id);
    } catch (error) {
      deferredRecords.push(deferred(reply, "full_message_read_failed", {
        error: text(error?.code || error?.message, 100) || "read_failed",
      }));
      continue;
    }
    const record = adaptSequenceInboxReply({
      reply,
      campaign: targets.get(text(reply.sequence_id, 500)) || null,
      detail,
      activationAt,
      outboundMappings,
      savedRoleMappings,
      forceNeutral: reply.projection_identity_conflict === true,
      env,
    });
    if (record.status === "ready") records.push(record);
    else deferredRecords.push(record);
  }
  const last = page.at(-1);
  const hasMore = eligible.length > page.length;
  const pageCheckpointSafe = !deferredRecords.some((record) => (
    CHECKPOINT_BLOCKING_DEFERRED_REASONS.has(record?.reason)
  ))
    && projectionCoverage.coverage_complete === true
    && confirmedThrough !== null;
  const confirmedCursor = confirmedThrough === null
    ? null
    : Buffer.from(`${String(confirmedThrough).padStart(16, "0")}:~`).toString("base64url");
  const checkpointCursor = pageCheckpointSafe
    ? hasMore && last
      ? Buffer.from(cursorKey(last)).toString("base64url")
      : confirmedCursor
    : cursor;
  // The per-sequence minimum refresh time is a durable, conservative event
  // watermark. Completion means every cached reply through that watermark was
  // read successfully; it deliberately does not require all sequences to be
  // refreshed inside one impossible global 15-minute window.
  const caughtUp = pageCheckpointSafe && !hasMore;
  return {
    records,
    deferred: deferredRecords,
    next_cursor: hasMore && last
      ? Buffer.from(cursorKey(last)).toString("base64url")
      : null,
    checkpoint_cursor: checkpointCursor,
    coverage: {
      cache_state: projectionCoverage.state || "unseeded",
      cache_coverage_complete: Boolean(projectionCoverage.coverage_complete),
      cache_last_complete_at: projectionCoverage.last_complete_at || null,
      cache_confirmed_through: projectionCoverage.confirmed_through || null,
      cache_campaigns_targeted: Number(projectionCoverage.campaigns_targeted) || 0,
      cache_campaigns_missing: Number(projectionCoverage.campaigns_missing) || 0,
      cache_campaigns_stale: Number(projectionCoverage.campaigns_stale) || 0,
      catalog_digest: currentDigest,
      ...savedRoleMappingCoverage(savedRoleMappingStatus, savedRoleMappings),
      watermark: currentWatermark,
      catalog_changed: false,
      watermark_changed: false,
      watermark_advanced: Boolean(
        normalizedExpectedWatermark
        && currentWatermark
        && Date.parse(currentWatermark) > Date.parse(normalizedExpectedWatermark),
      ),
      cached_replies: seen.size,
      before_activation: beforeActivation.length,
      page_size: page.length,
      ready: records.length,
      deferred: deferredRecords.length,
      has_more: hasMore,
      checkpoint_safe: pageCheckpointSafe,
      cycle_complete: !hasMore,
      full_success: caughtUp,
    },
  };
}
