import assert from "node:assert/strict";
import test from "node:test";

import { createDecisionHandler } from "../api/applicants/decision.mjs";
import { buildGeneration } from "../api/applicants/_lib/generation.mjs";

const KEY = "core:decisionv2fixture1234";
const NOW = "2026-09-07T18:00:00.000Z";
const V2 = {
  application: { applicationId: "11111111-1111-4111-8111-111111111111", tenantScopeId: "tenant-v2",
    personId: "22222222-2222-4222-8222-222222222222", sourceObservationId: "33333333-3333-4333-8333-333333333333",
    rowRevision: "row-v2-1", appliedTo: { title: "Engineer", hiringCompany: { state: "verified" } } },
  profile: { facts: {} }, factSetDigest: "a".repeat(64), factsCurrent: true,
  inputRevision: "input-v2-1", decisionRevision: 7,
  actionability: { eligibility: "waiting", reasons: ["profile_pending"], readinessRevision: "ready-v2-1",
    canCreateApproval: true, approvalState: "required" },
};

function harness(v2 = V2) {
  const row = { key: KEY, profileKey: "decisionv2fixture1234", name: "Applicant", roleTitle: "Legacy role",
    inputRevision: "legacy-input", readinessRevision: "legacy-readiness", decisionRevision: 1 };
  const artifacts = buildGeneration({ generationId: "decision-v2-generation", snapshot: { stream: [], applicantRowsV2: { [KEY]: v2 } },
    queue: [row], counts: { total: 1, queue: 1, stream: 0, profilePreparing: 0 } });
  const writes = [];
  const handler = createDecisionHandler({
    corsHandler: () => false, kvReady: () => true,
    authHandler: async (req) => { req.authedEmail = "operator@example.test"; req.applicantActor = { id: "operator", email: "operator@example.test" }; return true; },
    readActive: async () => artifacts.pointer, readArtifacts: async () => artifacts,
    writeDecision: async (...args) => { writes.push(args); return true; }, now: () => NOW,
  });
  const body = { key: KEY, action: "interview", requestId: "decision-v2-request-1234",
    generationId: artifacts.pointer.generationId, generationDigest: artifacts.pointer.digest,
    inputRevision: v2.inputRevision, readinessRevision: v2.actionability.readinessRevision,
    decisionRevision: v2.decisionRevision, applicationId: v2.application.applicationId,
    sourceObservationId: v2.application.sourceObservationId, rowRevision: v2.application.rowRevision };
  return { writes, async call(patch = {}) {
    const res = { setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method: "POST", body: { ...body, ...patch } }, res);
    return res;
  } };
}

test("a V2 waiting approval is sealed to its exact application and current revisions", async () => {
  const h = harness(); const res = await h.call();
  assert.equal(res.statusCode, 202, JSON.stringify(res.body));
  const record = h.writes[0][1];
  assert.equal(record.requestMode, "when_ready");
  assert.equal(record.inputRevision, V2.inputRevision);
  assert.equal(record.readinessRevision, V2.actionability.readinessRevision);
  assert.deepEqual(record.application, { id: V2.application.applicationId,
    sourceObservationId: V2.application.sourceObservationId, rowRevision: V2.application.rowRevision });
  const preparing = harness({ ...V2, factsCurrent: false });
  assert.equal((await preparing.call()).statusCode, 202,
    "P10 permits one durable waiting approval while profile facts are still preparing");
});

test("a V2 hold, unavailable approval, or mismatched V2 revision cannot be written", async () => {
  for (const patch of [
    { inputRevision: "old" }, { sourceObservationId: "other" }, { rowRevision: "old" },
  ]) {
    const h = harness(); const res = await h.call(patch);
    assert.equal(res.statusCode, 409); assert.equal(h.writes.length, 0);
  }
  for (const actionability of [
    { ...V2.actionability, eligibility: "hard_hold", reasons: ["identity_conflict"] },
    { ...V2.actionability, eligibility: "waiting", canCreateApproval: false },
    { ...V2.actionability, eligibility: "waiting", approvalState: "forbidden" },
  ]) {
    const h = harness({ ...V2, actionability }); const res = await h.call();
    assert.equal(res.statusCode, 409, JSON.stringify(res.body)); assert.equal(res.body.error, "interview_hard_hold");
    assert.equal(h.writes.length, 0);
  }
});
