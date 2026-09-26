// /api/seq/health additive coverage: the lightweight system gets its own
// block, and item 7 ("keep /api/seq/health keys the Scheduler reads, with
// truthful values") means the legacy bookingStop.raydarScheduler.* shape must
// still be present and untouched.
const ENV_NAMES = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "PARAFORM_COOKIE"];
const SAVED_ENV = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
for (const name of ENV_NAMES) delete process.env[name];

import test from "node:test";
import assert from "node:assert/strict";

const { default: healthHandler } = await import("../api/seq/health.mjs");

test.after(() => {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function response() {
  return {
    body: undefined,
    headers: {},
    statusCode: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() {},
  };
}

test("health reports the lite system as unconfigured (not crashed) when KV isn't set up, and keeps the legacy scheduler fields", async () => {
  const res = response();
  await healthHandler({ method: "GET", headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.bookingProtectionLite, { configured: false });
  // The Scheduler-facing shape from before this change must still exist.
  assert.ok(Object.hasOwn(res.body.bookingStop, "raydarScheduler"));
  assert.ok(Object.hasOwn(res.body.bookingStop.raydarScheduler, "enabled"));
  assert.ok(Object.hasOwn(res.body.bookingStop.raydarScheduler, "indexConfigured"));
});
