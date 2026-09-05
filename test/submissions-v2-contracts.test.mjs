import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEmailReply } from "../api/submissions-v2/_lib/contracts.mjs";
import { decryptJson, encryptJson } from "../api/submissions-v2/_lib/private-data.mjs";
import {
  CLASSIFIER_LIMITS,
  CLASSIFIER_PINS,
  classifyReply,
  forecastClassificationCost,
  validateClassification,
} from "../api/submissions-v2/_lib/classifier.mjs";

const role = { role_id: "role-1", company: "Example", title: "Engineer", url: "https://www.paraform.com/browse?role=role-1" };
const event = { candidate_authored_text: "Yes, I am interested in this role.", sent_message_text: "Would you consider it?", offered_roles: [role] };

test("normalizes the current Master Inbox consumer event without Gmail access", () => {
  const normalized = normalizeEmailReply({ id: "evt-1", eventKey: "mail:message:role", contractVersion: 1, family: "new_match", mailboxId: "mailbox", providerMessageId: "message", roleId: "role-1", senderMatchHmac: { key_version: "v1", digest: "match-digest" }, payload: { receivedAt: "2026-08-31T20:00:00Z", candidateText: "Yes", sourceMessageId: "private-message" } });
  assert.deepEqual(normalized.errors, []);
  assert.equal(normalized.event.schema_version, "submissions.email_reply.v1");
  assert.deepEqual(normalized.event.sender_match_hmac, { key_version: "v1", digest: "match-digest" });
  assert.equal(normalized.event.offered_roles[0].role_id, "role-1");
});

test("one current Master Inbox reply preserves every exact offered role", () => {
  const normalized = normalizeEmailReply({
    id: "evt-multi", eventKey: "mail:message:roles", contractVersion: 1, family: "fit_follow_up_with_matches",
    mailboxId: "mailbox", providerMessageId: "message-multi", roleIds: ["role-2", "role-1", "role-2"],
    senderMatchHmac: { key_version: "v1", digest: "match-digest" },
    payload: { receivedAt: "2026-08-31T20:00:00Z", candidateText: "Both sound good", sourceMessageId: "private-message" },
  });
  assert.deepEqual(normalized.errors, []);
  assert.deepEqual(normalized.event.offered_roles.map((item) => item.role_id), ["role-2", "role-1"]);
});

test("legacy Master Inbox payload role arrays remain readable during rollout", () => {
  const normalized = normalizeEmailReply({
    id: "evt-legacy-multi", eventKey: "mail:legacy:roles", contractVersion: 1, family: "new_match",
    mailboxId: "mailbox", providerMessageId: "message-legacy", senderMatchHmac: { key_version: "v1", digest: "match-digest" },
    payload: { receivedAt: "2026-08-31T20:00:00Z", candidateText: "The first one", sourceMessageId: "private-message", offeredRoleIds: ["role-a", "role-b"] },
  });
  assert.deepEqual(normalized.errors, []);
  assert.deepEqual(normalized.event.offered_roles.map((item) => item.role_id), ["role-a", "role-b"]);
});

test("quarantines unknown canonical source families", () => {
  const normalized = normalizeEmailReply({ schema_version: "submissions.email_reply.v1", event_id: "evt", source_family: "other", source_family_version: "1", mailbox_id: "box", provider: "master_inbox", provider_message_id: "msg", direction: "inbound", received_at: "2026-08-31T20:00:00Z", candidate_authored_text: "Yes", offered_roles: [role], content_digest: "a".repeat(64), idempotency_key: "stable-key" });
  assert.equal(normalized.quarantined, true);
  assert.ok(normalized.errors.includes("unsupported_source_family"));
});

test("Sequence Inbox canonical events retain bounded evidence and unmapped roles remain reviewable", () => {
  const normalized = normalizeEmailReply({
    schema_version: "submissions.email_reply.v1",
    event_id: "sequence-event-1",
    source_family: "paraform_sequence_reply",
    source_family_version: "1",
    adapter_version: "sequence-inbox-v1",
    mailbox_id: "noah-heyraydar-com",
    provider: "gmail",
    provider_message_id: "message-1",
    provider_thread_id: "thread-1",
    direction: "inbound",
    received_at: "2026-09-03T12:00:00.000Z",
    sender_match_hmac: { key_version: "v1", digest: "match" },
    candidate_authored_text: "Yes, please tell me more.",
    offered_roles: [],
    content_digest: "c".repeat(64),
    idempotency_key: "gmail:noah-heyraydar-com:message-1",
    candidate_user_id_hint: "candidate-user-1",
    source_evidence: {
      cache_version: 3,
      sequence_id: "sequence-1",
      campaign_to_candidate_user_id: "member-1",
      cached_reply_category: "INTERESTED",
    },
  });
  assert.equal(normalized.quarantined, false);
  assert.deepEqual(normalized.errors, ["offered_roles_missing"]);
  assert.equal(normalized.event.candidate_user_id_hint, "candidate-user-1");
  assert.equal(normalized.event.source_evidence.sequence_id, "sequence-1");
});

test("canonical email events retain only bounded explicit-role resolution provenance", () => {
  const normalized = normalizeEmailReply({
    schema_version: "submissions.email_reply.v1", event_id: "evt-explicit", source_family: "new_match",
    source_family_version: "2", mailbox_id: "box", provider: "gmail", provider_message_id: "msg-explicit",
    direction: "inbound", received_at: "2026-09-05T15:00:00Z", candidate_authored_text: "Acme — Engineer",
    sender_match_hmac: { key_version: "v1", digest: "match" }, offered_roles: [role],
    content_digest: "a".repeat(64), idempotency_key: "stable-explicit-key",
    source_evidence: {
      resolution_version: "candidate-explicit-role-v1",
      exact_role_source: "candidate_authored_explicit",
      role_evidence_digest: "b".repeat(64),
      role_catalog_digest: "c".repeat(64),
      match_kinds: ["company_full_title", "company_full_title"],
      resolved_role_count: 1,
      candidate_text: "must not survive normalization",
    },
  });
  assert.deepEqual(normalized.errors, []);
  assert.deepEqual(normalized.event.source_evidence, {
    resolution_version: "candidate-explicit-role-v1",
    exact_role_source: "candidate_authored_explicit",
    role_evidence_digest: "b".repeat(64),
    role_catalog_digest: "c".repeat(64),
    match_kinds: ["company_full_title"],
    resolved_role_count: 1,
  });
});

test("pointer-only candidate text is quarantined before classification until the signed adapter resolves it", () => {
  const normalized = normalizeEmailReply({
    schema_version: "submissions.email_reply.v1", event_id: "evt-pointer", source_family: "new_match",
    source_family_version: "1", mailbox_id: "box", provider: "master_inbox", provider_message_id: "msg-pointer",
    direction: "inbound", received_at: "2026-08-31T20:00:00Z",
    candidate_authored_text_ref: "private-object-reference", sender_match_hmac: { key_version: "v1", digest: "match" },
    offered_roles: [role], content_digest: "b".repeat(64), idempotency_key: "stable-pointer-key",
  });
  assert.ok(normalized.errors.includes("candidate_text_inline_required"));
});

test("encrypts private event text with authenticated encryption", () => {
  const env = { SUBMISSIONS_V2_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url") };
  const encrypted = encryptJson({ reply: "private" }, { env, context: "event:evt" });
  assert.equal(encrypted.algorithm, "aes-256-gcm");
  assert.deepEqual(decryptJson(encrypted, { env, context: "event:evt" }), { reply: "private" });
  assert.equal(JSON.stringify(encrypted).includes("private"), false);
});

test("deterministic encrypted objects are byte-identical only for the same context and value", () => {
  const env = { SUBMISSIONS_V2_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64url") };
  const first = encryptJson({ nested: { b: 2, a: 1 } }, { env, context: "event:stable", deterministic: true });
  const replay = encryptJson({ nested: { a: 1, b: 2 } }, { env, context: "event:stable", deterministic: true });
  const changed = encryptJson({ nested: { a: 1, b: 3 } }, { env, context: "event:stable", deterministic: true });
  assert.deepEqual(replay, first);
  assert.notEqual(changed.nonce, first.nonce);
  assert.deepEqual(decryptJson(replay, { env, context: "event:stable" }), { nested: { a: 1, b: 2 } });
});

test("classification validation rejects a nonverbatim decisive quote", () => {
  assert.equal(validateClassification({ decisions: [{ role_id: "role-1", label: "interested", quote: "Absolutely", review_reason: null, negative_reason: null }] }, event).reason, "quote_not_verbatim");
});

test("uses pinned nano first and accepts grounded structured output", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body); calls.push(request);
    return { ok: true, json: async () => ({ id: "resp", output_text: JSON.stringify({ decisions: [{ role_id: "role-1", label: "interested", quote: "Yes, I am interested in this role.", review_reason: null, negative_reason: null }] }), usage: { input_tokens: 200, output_tokens: 50 } }) };
  };
  const result = await classifyReply(event, { env: { SUBMISSIONS_V2_OPENAI_API_KEY: "test" }, fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, CLASSIFIER_PINS.primary);
  assert.equal(calls[0].store, false);
  assert.equal(calls[0].text.format.strict, true);
  assert.equal(result.decisions[0].label, "interested");
});

test("falls back only after invalid primary output", async () => {
  const models = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body); models.push(request.model);
    const quote = models.length === 1 ? "Invented quote" : "Yes, I am interested in this role.";
    return { ok: true, json: async () => ({ output_text: JSON.stringify({ decisions: [{ role_id: "role-1", label: "interested", quote, review_reason: null, negative_reason: null }] }), usage: { input_tokens: 100, output_tokens: 20 } }) };
  };
  const result = await classifyReply(event, { env: { SUBMISSIONS_V2_OPENAI_API_KEY: "test" }, fetchImpl });
  assert.deepEqual(models, [CLASSIFIER_PINS.primary, CLASSIFIER_PINS.fallback]);
  assert.equal(result.attempts[0].reason, "quote_not_verbatim");
});

test("classifier reserves the worst-case request cost before every model call", () => {
  const primary = forecastClassificationCost(CLASSIFIER_PINS.primary, event);
  const fallback = forecastClassificationCost(CLASSIFIER_PINS.fallback, event);
  assert.ok(primary > 0);
  assert.ok(fallback > primary);
  assert.ok(primary + fallback <= CLASSIFIER_LIMITS.costUsd);
});
