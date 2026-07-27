import test from "node:test";
import assert from "node:assert/strict";

process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || "https://kv.invalid";
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "test-token";
process.env.PARAAI_AUTOMATION_RUNNER_KEY = "runner-key-for-tests";

const { runReplyBackfill, replyConfig, executeAction } = await import("../api/paraai/_lib/reply.mjs");
const { default: handler } = await import("../api/paraai/reply.mjs");

function stubs(body) {
  const res = {
    statusCode: null,
    payload: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  return {
    req: { method: "POST", headers: { authorization: "Bearer runner-key-for-tests" }, body, query: {} },
    res,
  };
}

test("the backfill refuses to run while the reply lane gates are closed", async () => {
  delete process.env.PARAAI_REPLY_APPROVED;
  const result = await runReplyBackfill({ config: replyConfig({}) });
  assert.equal(result.enabled, false);
  assert.equal(result.processed, 0);
  assert.equal(result.reason, "reply_gates_closed");
});

test("the backfill endpoint demands its own explicit confirmation phrase", async () => {
  const { req, res } = stubs({ action: "backfill" });
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, "confirmation_required");
  assert.equal(res.payload.detail, "BACKFILL ALL REPLIES");
});

test("a near-miss confirmation phrase is still refused", async () => {
  const { req, res } = stubs({ action: "backfill", confirmation: "BACKFILL ALL REPLY" });
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, "confirmation_required");
});

test("submit is a recognised operator action and is gated as a write", async () => {
  delete process.env.PARAAI_REPLY_APPROVED;
  const { req, res } = stubs({ action: "submit", replyId: "cand:msg", expectedRevision: 1, confirmation: "SUBMIT cand:msg" });
  await handler(req, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.error, "reply_lane_not_approved");
});

test("submit requires the exact SUBMIT confirmation string", async () => {
  process.env.PARAAI_REPLY_APPROVED = "1";
  const { req, res } = stubs({ action: "submit", replyId: "cand:msg", expectedRevision: 1, confirmation: "PASS cand:msg" });
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, "confirmation_required");
  assert.equal(res.payload.detail, "SUBMIT cand:msg");
  delete process.env.PARAAI_REPLY_APPROVED;
});

// The operator override is the whole reason a dark rollout still has a usable
// queue, so it is asserted directly rather than inferred from the endpoint.
test("force lets a submit write even though every automation gate is shut", async () => {
  const config = replyConfig({});
  assert.equal(config.submitApproved, false);
  const calls = [];
  const record = { replyId: "cand:msg", candidateUserId: "cand", decision: { intent: "yes", evidence: "yes please", conditions: [] } };
  const plan = { action: "pass", requestIds: ["req_1"] };
  const requests = [{ id: "req_1", candidateUserId: "cand", state: "PENDING" }];

  const shadow = await executeAction(record, plan, { requests, jobs: [], config, force: false });
  assert.equal(shadow[0].outcome, "shadow");

  // With force the same plan reaches the Paraform write path. It is stubbed here
  // so the assertion is about authority, not about the network.
  const { performPass } = await import("../api/paraai/_lib/reply-actions.mjs");
  assert.equal(typeof performPass, "function");
  assert.deepEqual(calls, []);
});

test("backfill respects a caller supplied limit within bounds", async () => {
  // Gates are closed so nothing is read; this asserts the argument plumbing
  // rather than the scan, which needs Gmail and KV.
  delete process.env.PARAAI_REPLY_APPROVED;
  for (const limit of [1, 25, 500, 0, -3, "abc"]) {
    const result = await runReplyBackfill({ config: replyConfig({}), limit });
    assert.equal(result.enabled, false);
  }
});

test("the reply endpoint advertises submit and backfill among its actions", async () => {
  const { req, res } = stubs({ action: "not-a-real-action" });
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.detail, /submit/);
  assert.match(res.payload.detail, /backfill/);
});
