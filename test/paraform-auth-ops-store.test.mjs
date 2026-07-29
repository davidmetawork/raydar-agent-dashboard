import test from "node:test";
import assert from "node:assert/strict";

// GET /api/ops/paraform-auth past the storeConfigured() guard. The store
// module captures KV env at import time, so a dummy config is stubbed before
// the dynamic import (mirrors test/paraai-reply-endpoint.test.mjs) and the
// kv call itself is injected through the handler's deps seam — no network is
// ever touched. The unconfigured-store path lives in
// test/paraform-auth-breaker.test.mjs, which runs without this stub.
process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || "https://kv.invalid";
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || "test-token";

const { default: opsHandler } = await import("../api/ops/paraform-auth.mjs");
const { AUTH_FLAG_KEY, AUTH_LAST_PROBE_KEY } = await import(
  "../api/paraai/_lib/auth-probe.mjs"
);

function fakeRes() {
  return {
    statusCode: null,
    payload: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test("a throwing kv fails OPEN: 200, ok:false, down:false", async () => {
  const res = fakeRes();
  const kvImpl = async () => { throw new Error("kv unreachable"); };
  await opsHandler({ method: "GET", headers: {} }, res, { kvImpl });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.error, "state_store_unreachable");
  assert.equal(res.payload.down, false);
  assert.equal(res.payload.alert, null);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("the seam feeds the real read path: flag, alert summary, mapped reason", async () => {
  const values = new Map([
    [AUTH_FLAG_KEY, JSON.stringify({
      version: 1,
      since: "2026-07-29T12:00:00.000Z",
      evidence: { code: "AUTH_EXPIRED" },
      alert: { openedAt: "2026-07-29T12:00:00.000Z", delivered: false },
    })],
    [AUTH_LAST_PROBE_KEY, JSON.stringify({
      at: "2026-07-29T12:05:00.000Z",
      healthy: null,
      reason: "n8n variables read failed: 502",
    })],
  ]);
  const kvImpl = async ([, key]) => values.get(key) ?? null;
  const res = fakeRes();
  await opsHandler({ method: "GET", headers: {} }, res, { kvImpl });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.down, true);
  assert.equal(res.payload.since, "2026-07-29T12:00:00.000Z");
  assert.deepEqual(res.payload.alert, {
    openedAt: "2026-07-29T12:00:00.000Z",
    delivered: false,
  });
  // The raw store message must never be republished — only the closed enum.
  assert.equal(res.payload.lastProbe.reason, "store_error");
  assert.equal(typeof res.payload.alerting.slackConfigured, "boolean");
});
