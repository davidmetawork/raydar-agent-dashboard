import test from "node:test";
import assert from "node:assert/strict";

const ENV_NAMES = ["HEALTH_BEAT_KEY", "KV_REST_API_URL", "KV_REST_API_TOKEN"];
const SAVED_ENV = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const SAVED_FETCH = globalThis.fetch;

process.env.HEALTH_BEAT_KEY = "health-beat-test-key";
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "test-token";

const writes = [];
globalThis.fetch = async (_url, init) => {
  writes.push(JSON.parse(init.body));
  return {
    ok: true,
    async json() { return { result: "OK" }; },
  };
};

const { default: beatHandler } = await import("../api/health/beat.mjs");

test.after(() => {
  globalThis.fetch = SAVED_FETCH;
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function request(body) {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.HEALTH_BEAT_KEY}` },
    body,
  };
}

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("health beat accepts warn and persists the typed status", async () => {
  writes.length = 0;
  const res = response();
  await beatHandler(request({
    lane: "gha-paraai-curate",
    status: "warn",
    note: "1 candidate quarantined",
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, lane: "gha-paraai-curate", status: "warn" });
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "SET");
  assert.equal(writes[0][1], "hlth:beat:gha-paraai-curate");
  const stored = JSON.parse(writes[0][2]);
  assert.equal(stored.status, "warn");
  assert.equal(stored.note, "1 candidate quarantined");
  assert.ok(!Number.isNaN(Date.parse(stored.at)));
});

test("health beat rejects an unknown status instead of storing a false OK", async () => {
  writes.length = 0;
  const res = response();
  await beatHandler(request({ lane: "gha-paraai-curate", status: "warning" }), res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "invalid_status" });
  assert.equal(writes.length, 0);
});

test("health beat rejects an explicit null status instead of storing a false OK", async () => {
  writes.length = 0;
  const res = response();
  await beatHandler(request({ lane: "gha-paraai-curate", status: null }), res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "invalid_status" });
  assert.equal(writes.length, 0);
});

test("health beat keeps an omitted status backward-compatible as OK", async () => {
  writes.length = 0;
  const res = response();
  await beatHandler(request({ lane: "gha-paraai-curate" }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(JSON.parse(writes[0][2]).status, "ok");
});

test("health beat stores valid producer metrics on the beat", async () => {
  writes.length = 0;
  const res = response();
  await beatHandler(request({
    lane: "interview-invites",
    status: "ok",
    metrics: { planned: 14, sent: 12, deferred: 2, gmail429: 0 },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, lane: "interview-invites", status: "ok" });
  const stored = JSON.parse(writes[0][2]);
  assert.deepEqual(stored.metrics, { planned: 14, sent: 12, deferred: 2, gmail429: 0 });
});

test("health beat drops malformed metrics WITHOUT losing the heartbeat", async () => {
  // Losing the beat would fake a dead lane — worse than losing a number.
  // The drop is visible in the response so producer tests can catch it.
  writes.length = 0;
  for (const bad of [
    { sent: "twelve" },                          // non-numeric value
    { note: Infinity },                          // non-finite
    ["array"],                                   // not a plain object
    Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i])), // too many keys
    { "bad key!": 1 },                           // invalid key
    {},                                          // empty object
  ]) {
    const res = response();
    await beatHandler(request({ lane: "interview-invites", status: "warn", metrics: bad }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.metricsDropped, true);
    const stored = JSON.parse(writes.at(-1)[2]);
    assert.equal(stored.status, "warn", "the typed status must survive a metrics drop");
    assert.ok(!("metrics" in stored));
  }
});

test("health beat accepts the Scheduler cron control-plane guard lane", async () => {
  writes.length = 0;
  const res = response();
  await beatHandler(request({
    lane: "gha-scheduler-cron-guard",
    status: "fail",
    note: "production Scheduler crons disabled",
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    lane: "gha-scheduler-cron-guard",
    status: "fail",
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], "hlth:beat:gha-scheduler-cron-guard");
  assert.equal(JSON.parse(writes[0][2]).status, "fail");
});
