import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { encryptJson } from "../api/submissions-v2/_lib/private-data.mjs";
import { repairRoleEvidence, reviewedRoleRepairPlan, roleRepairBrokerRequest, roleRepairEvidence, roleRepairPlanDigest, roleRepairPlanSignature, roleRepairStoredPayload } from "../submissions-v2-worker/repair-role-evidence.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fixture() {
  const result = {
    source: { id: "signal", event_id: "event", processing_state: "needs_role", provider: "gmail",
      provider_message_id: "reply", provider_thread_id: "thread", mailbox_id: "david-raydar-xyz",
      received_at: "2026-09-03T00:00:00.000Z", sender_match_hmac_current: "sender", sender_match_hmac_current_version: "v1", outbound_message_id: "exact-parent", encrypted_body_object_key: "submissions/resumes/v2/events/evidence" },
    storedPayload: { candidate_authored_text: "Yes, I am interested.", sent_message_text: "Original role outreach" },
    event: { event_id: "event", provider_message_id: "reply", provider_thread_id: "thread", mailbox_id: "david-raydar-xyz",
      received_at: "2026-09-03T00:00:00.000Z", sender_match_hmac: { digest: "sender", key_version: "v1" },
      outbound_message_id: "exact-parent", candidate_authored_text: "Yes, I am interested.", sent_message_text: "Original role outreach", content_digest: "",
      offered_roles: [{ role_id: "role-1" }] },
    candidate: { candidate_user_id: "candidate-1", ambiguous: false }, roles: [{ role_id: "role-1", active: true }],
  };
  result.event.content_digest = digest({ candidateText: result.event.candidate_authored_text, sentText: result.event.sent_message_text, offered: result.event.offered_roles });
  result.source.content_digest = digest({ candidateText: result.storedPayload.candidate_authored_text, sentText: result.storedPayload.sent_message_text, offered: [] });
  return result;
}
test("repair retains exact evidence without deciding intent or exporting message text", () => {
  const result = roleRepairEvidence(fixture());
  assert.equal(result.status, "repairable");
  assert.deepEqual(result.role_ids, ["role-1"]);
  assert.match(result.source_digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("interested"), false);
});
for (const [name, mutate, reason] of [
  ["missing original", (f) => { f.event.outbound_message_id = null; }, "exact_outbound_role_missing"],
  ["missing encrypted source payload", (f) => { f.source.encrypted_body_object_key = null; }, "source_payload_missing"],
  ["changed provider message", (f) => { f.event.provider_message_id = "other"; }, "message_evidence_changed"],
  ["changed parent", (f) => { f.event.outbound_message_id = "other-parent"; }, "message_evidence_changed"],
  ["changed sender", (f) => { f.event.sender_match_hmac.digest = "other"; }, "sender_evidence_changed"],
  ["changed authored reply", (f) => { f.event.candidate_authored_text = "Quoted interest"; }, "authored_reply_changed"],
  ["changed outbound content", (f) => { f.event.sent_message_text = "Different outreach"; }, "outbound_content_changed"],
  ["ambiguous candidate", (f) => { f.candidate.ambiguous = true; }, "candidate_unresolved"],
  ["inactive role", (f) => { f.roles[0].active = false; }, "role_unavailable"],
  ["additional role not in immutable content", (f) => { f.event.offered_roles.push({ role_id: "other" }); }, "content_evidence_changed"],
  ["already resolved", (f) => { f.source.processing_state = "resolved"; }, "source_not_eligible"],
]) test(`repair refuses ${name}`, () => {
  const input = fixture(); mutate(input);
  assert.deepEqual(roleRepairEvidence(input), { signal_id: "signal", status: "review", reason });
});
test("the application digest changes if a repair target changes", () => {
  const first = fixture(); const second = fixture(); second.candidate.candidate_user_id = "candidate-2";
  assert.notEqual(roleRepairPlanDigest([roleRepairEvidence(first)]), roleRepairPlanDigest([roleRepairEvidence(second)]));
});
test("repair reads the broker's documented object shape without treating metadata as bytes", () => {
  const env = { SUBMISSIONS_V2_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
  const encrypted = encryptJson({ candidate_authored_text: "Yes, I am interested." }, { env, context: "event:event" });
  const payload = roleRepairStoredPayload({ bytes: Buffer.from(JSON.stringify(encrypted)), content_type: "application/json" }, { env, eventId: "event" });
  assert.deepEqual(payload, { candidate_authored_text: "Yes, I am interested." });
  assert.throws(() => roleRepairStoredPayload({ content_type: "application/json" }, { env, eventId: "event" }), { code: "repair_payload_read_invalid" });
});
test("repair uses the legacy broker scope accepted by existing source records", () => {
  assert.deepEqual(roleRepairBrokerRequest({ after: 1, before: 2, threadId: "thread" }), {
    operation: "thread", scope: "interview_request_v1", after: 1, before: 2, threadId: "thread",
  });
});
test("apply accepts only the signed reviewed plan and fails before broker access without the API database URL", async () => {
  const env = { SUBMISSIONS_V2_EMAIL_HMAC_KEY: "x".repeat(32), SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: "2026-09-03T00:00:00.000Z" };
  const plan = [{ signal_id: "00000000-0000-4000-8000-000000000001", status: "repairable", candidate_id: "candidate-1",
    role_ids: ["role-1"], source_digest: "a".repeat(64), proof_digest: "b".repeat(64) }];
  const planDigest = roleRepairPlanDigest(plan);
  const reviewed = { schema_version: 1, mode: "dry_run", digest: planDigest, plan_signature: roleRepairPlanSignature(planDigest, env), plan };
  assert.deepEqual(reviewedRoleRepairPlan(reviewed, { applyDigest: planDigest, env }), plan);
  await assert.rejects(
    repairRoleEvidence({ env, applyDigest: planDigest, reviewedPlan: reviewed, fetchImpl: async () => { throw new Error("broker must not run"); } }),
    (error) => error.code === "repair_api_apply_database_required",
  );
  reviewed.plan[0].role_ids = ["other-role"];
  assert.throws(() => reviewedRoleRepairPlan(reviewed, { applyDigest: planDigest, env }), { code: "repair_reviewed_plan_invalid" });
});
