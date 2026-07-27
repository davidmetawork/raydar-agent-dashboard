import test from "node:test";
import assert from "node:assert/strict";

// The endpoint refuses before it ever reads a record or touches the network, so
// these run without KV or Paraform. A dummy KV config only gets past the
// storeConfigured() guard.
process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || "https://kv.invalid";
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "test-token";
process.env.PARAAI_AUTOMATION_RUNNER_KEY = "runner-key-for-tests";

const { default: handler } = await import("../api/paraai/reply.mjs");

function stubs(body) {
  const res = {
    statusCode: null,
    payload: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  const req = {
    method: "POST",
    headers: { authorization: "Bearer runner-key-for-tests" },
    body,
    query: {},
  };
  return { req, res };
}

const WRITE_ACTIONS = ["pass", "off-market", "re-enable"];

for (const action of WRITE_ACTIONS) {
  test(`${action} refuses to write while the reply lane is unapproved`, async () => {
    delete process.env.PARAAI_REPLY_APPROVED;
    const { req, res } = stubs({ action, replyId: "cand:msg", expectedRevision: 1, confirmation: "X" });
    await handler(req, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.ok, false);
    assert.equal(res.payload.error, "reply_lane_not_approved");
  });
}

for (const [action, word] of [["pass", "PASS"], ["off-market", "OFF-MARKET"], ["re-enable", "RE-ENABLE"]]) {
  test(`${action} requires the exact confirmation string`, async () => {
    process.env.PARAAI_REPLY_APPROVED = "1";
    const { req, res } = stubs({ action, replyId: "cand:msg", expectedRevision: 1, confirmation: "wrong" });
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.error, "confirmation_required");
    assert.equal(res.payload.detail, `${word} cand:msg`);
    delete process.env.PARAAI_REPLY_APPROVED;
  });
}

test("dismiss is a Raydar-side action and needs neither approval nor a confirmation string", async () => {
  delete process.env.PARAAI_REPLY_APPROVED;
  const { req, res } = stubs({ action: "dismiss", replyId: "cand:msg", expectedRevision: 1 });
  await handler(req, res);
  // It gets past both guards and fails later on the unreachable dummy KV,
  // which is the proof that neither guard rejected it.
  assert.notEqual(res.payload?.error, "reply_lane_not_approved");
  assert.notEqual(res.payload?.error, "confirmation_required");
});

test("an unknown action is rejected before any gate or store work", async () => {
  const { req, res } = stubs({ action: "delete-everything", replyId: "cand:msg" });
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, "unknown_action");
});

test("a write action without a replyId is rejected", async () => {
  process.env.PARAAI_REPLY_APPROVED = "1";
  const { req, res } = stubs({ action: "pass", expectedRevision: 1, confirmation: "PASS " });
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, "replyId_required");
  delete process.env.PARAAI_REPLY_APPROVED;
});

test("a non POST or GET method is refused", async () => {
  const { req, res } = stubs({});
  req.method = "DELETE";
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});
