import assert from "node:assert/strict";
import test from "node:test";
import { reviewContext } from "../api/submissions-v2/_lib/review-context.mjs";
import { encryptJson } from "../api/submissions-v2/_lib/private-data.mjs";
import { createService } from "../api/submissions-v2/_lib/service.mjs";
import { routeSubmissionsV2 } from "../api/submissions-v2/_lib/router.mjs";

const signalId = "11111111-1111-4111-8111-111111111111";
const source = {
  id: signalId, event_id: "review-event-1", source_family: "email",
  received_at: "2026-09-04T21:00:00Z", encrypted_body_object_key: "private/events/test",
  envelope: { source_family: "para_ai_interview_request", provider_message_id: "private-id" },
};
const env = { SUBMISSIONS_V2_UI_ENABLED: "true", SUBMISSIONS_V2_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url") };
const runtimeControls = async () => ({ control_epoch: 1, ui_enabled: true });

test("Review context exposes only exact candidate-authored text and fixed source labels", () => {
  const result = reviewContext(source, {
    candidate_authored_text: "  I have a question.\nIs the role remote?  ",
    sent_message_text: "private outbound text", sender_email: "private@example.test",
  });
  assert.deepEqual(result, {
    source_family: "para_ai_interview_request", source_label: "Interview Request reply",
    received_at: "2026-09-04T21:00:00.000Z", candidate_reply_excerpt: "I have a question.\nIs the role remote?",
    excerpt_truncated: false, outbound_offer_excerpt: "private outbound text",
    outbound_offer_truncated: false, offered_roles: [], evidence_status: "available",
  });
  assert.equal(JSON.stringify(result).includes("private@example.test"), false);
  const long = reviewContext(source, { candidate_authored_text: "😀".repeat(1201) });
  assert.equal(Array.from(long.candidate_reply_excerpt).length, 1200);
  assert.equal(long.excerpt_truncated, true);
  assert.equal(reviewContext(source, { sent_message_text: "Interested" }).evidence_status, "unavailable");
  assert.equal(reviewContext({ ...source, source_family: "manual" }, { candidate_authored_text: "Untrusted" }).candidate_reply_excerpt, null);
  assert.equal(reviewContext({ ...source, envelope: { source_family: "<script>" } }).source_label, "Candidate signal");
});

test("Review context includes bounded original-offer evidence and exact retained roles", () => {
  const result = reviewContext({
    ...source,
    offered_roles: [{ role_id: "role-1", company: "Acme", title: "Backend Engineer", url: "https://unreturned.example" }],
  }, {
    candidate_authored_text: "Sounds useful.",
    sent_message_text: "Would you consider the Backend Engineer role?".repeat(100),
  });
  assert.equal(Array.from(result.outbound_offer_excerpt).length, 2400);
  assert.equal(result.outbound_offer_truncated, true);
  assert.deepEqual(result.offered_roles, [{ role_id: "role-1", company: "Acme", title: "Backend Engineer" }]);
  assert.equal(JSON.stringify(result).includes("unreturned.example"), false);
});

test("Review reads a single visible source and decrypts with its immutable event identity", async () => {
  let reads = 0;
  const envelope = encryptJson({ candidate_authored_text: "Please explain the hours.", sent_message_text: "Private sent message" }, { env, context: "event:review-event-1" });
  const service = createService({ env, repository: {
    runtimeControls,
    sourceForReview: async (input) => { assert.deepEqual(input, { caseId: null, signalId }); return source; },
  }, blob: { readPrivateObject: async (path) => { reads += 1; assert.equal(path, source.encrypted_body_object_key); return { bytes: Buffer.from(JSON.stringify(envelope)) }; } } });
  const result = await service.reviewContext({ signal_id: signalId });
  assert.equal(reads, 1);
  assert.equal(result.review_context.candidate_reply_excerpt, "Please explain the hours.");
  assert.equal(result.review_context.outbound_offer_excerpt, "Private sent message");
});

test("Review rejects invalid or closed identities before private reads and respects UI controls", async () => {
  let reads = 0;
  const service = createService({ env, repository: { runtimeControls, sourceForReview: async () => null },
    blob: { readPrivateObject: async () => { reads += 1; throw new Error("must not read"); } } });
  for (const input of [{}, { case_id: signalId, signal_id: signalId }, { signal_id: "invalid" }]) {
    await assert.rejects(() => service.reviewContext(input), { code: "review_identity_invalid", status: 400 });
  }
  await assert.rejects(() => service.reviewContext({ case_id: signalId }), { code: "review_item_not_found", status: 404 });
  assert.equal(reads, 0);
  const disabled = createService({ env: { ...env, SUBMISSIONS_V2_UI_ENABLED: "false" }, repository: { runtimeControls } });
  await assert.rejects(() => disabled.reviewContext({ signal_id: signalId }), { code: "submissions_v2_disabled" });
});

test("Review never falls back to outbound text or raw provider errors on corrupt private evidence", async () => {
  const wrong = encryptJson({ candidate_authored_text: "Wrong candidate's reply" }, { env, context: "event:other-event" });
  for (const readPrivateObject of [
    async () => { throw new Error("secret token and raw provider text"); },
    async () => ({ bytes: Buffer.from("malformed") }),
    async () => ({ bytes: Buffer.from(JSON.stringify(wrong)) }),
  ]) {
    const service = createService({ env, repository: { runtimeControls, sourceForReview: async () => source }, blob: { readPrivateObject } });
    const result = await service.reviewContext({ signal_id: signalId });
    assert.equal(result.review_context.evidence_status, "unavailable");
    assert.equal(result.review_context.candidate_reply_excerpt, null);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
});

test("Review endpoint is human-authenticated and private no-store even on denial", async () => {
  const res = { headers: {}, statusCode: 200, setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await routeSubmissionsV2({ method: "GET", url: `/api/submissions-v2/review-context?signal_id=${signalId}`, headers: {}, query: { signal_id: signalId } }, res);
  assert.ok([401, 503].includes(res.statusCode));
  assert.equal(res.headers["cache-control"], "private, no-store, max-age=0");
  assert.equal(res.body.review_context, undefined);
});
