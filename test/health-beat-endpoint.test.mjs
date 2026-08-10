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
