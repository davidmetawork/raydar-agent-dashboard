// The lite KV client's strict read, and the held-queue fields it feeds on
// /api/seq/health. KV is pointed at a stub before any module loads, because
// the store reads its URL at import time.
const ENV_NAMES = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "PARAFORM_COOKIE"];
const SAVED_ENV = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
process.env.KV_REST_API_URL = "https://kv.test.invalid";
process.env.KV_REST_API_TOKEN = "test-token";
delete process.env.PARAFORM_COOKIE;

import test from "node:test";
import assert from "node:assert/strict";

const { kvGetStrict, LITE_KEYS, LIVESET_SCHEMA } = await import("../api/seq/_lib/booking-protection-store.mjs");
const { default: healthHandler } = await import("../api/seq/health.mjs");

const originalFetch = global.fetch;
test.after(() => {
  global.fetch = originalFetch;
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

function kvStub({ docs = {}, sets = {} } = {}) {
  return async (url, init) => {
    if (!String(url).startsWith("https://kv.test.invalid")) return new Response("{}", { status: 503 });
    const command = JSON.parse(init?.body || "[]");
    const [op, key] = command;
    if (op === "GET") return json({ result: Object.hasOwn(docs, key) ? JSON.stringify(docs[key]) : null });
    if (op === "SMEMBERS") return json({ result: sets[key] || [] });
    return json({ result: null });
  };
}

test("kvGetStrict: a missing key is null, a transport failure or a body without result throws", async () => {
  global.fetch = kvStub({ docs: { present: { a: 1 } } });
  assert.deepEqual(await kvGetStrict("present"), { a: 1 });
  assert.equal(await kvGetStrict("absent"), null);

  global.fetch = async () => json({ error: "ERR something" });
  await assert.rejects(() => kvGetStrict("any"), (error) => error.code === "KV_UNAVAILABLE");

  global.fetch = async () => new Response("not json", { status: 200 });
  await assert.rejects(() => kvGetStrict("any"), (error) => error.code === "KV_UNAVAILABLE");

  global.fetch = async () => json({}, 502);
  await assert.rejects(() => kvGetStrict("any"), (error) => error.code === "KV_UNAVAILABLE");

  global.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(() => kvGetStrict("any"), (error) => error.code === "KV_UNAVAILABLE");
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

test("health counts unverified sequences and held jobs, without naming anything", async () => {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  global.fetch = kvStub({
    docs: {
      [LITE_KEYS.liveSet]: {
        schema: LIVESET_SCHEMA,
        builtAt: iso(3_600_000),
        byEmail: {},
        incomplete: true,
        unverifiedSequences: [{ id: "seq_2", name: "Audio Failed", reason: "PARAFORM_HTTP_401" }],
      },
      [LITE_KEYS.pending("held")]: {
        eventId: "held",
        email: "candidate@example.com",
        enqueuedAt: iso(30 * 3_600_000),
        hold: { checkedAgainst: iso(3_600_000), unverifiedSequenceIds: ["seq_2"], heldSince: iso(27 * 3_600_000), appliedCcuIds: [] },
      },
      [LITE_KEYS.pending("fresh")]: { eventId: "fresh", enqueuedAt: iso(120_000) },
    },
    sets: { [LITE_KEYS.pendingSet]: ["held", "fresh"] },
  });
  const res = response();
  await healthHandler({ method: "GET", headers: {} }, res);
  const lite = res.body.bookingProtectionLite;
  assert.equal(lite.liveSet.usable, true);
  assert.equal(lite.liveSet.incomplete, true);
  assert.equal(lite.liveSet.unverifiedSequences, 1);
  assert.equal(lite.pendingQueue.depth, 2);
  assert.equal(lite.pendingQueue.held, 1);
  assert.equal(lite.pendingQueue.oldestHeldAgeMinutes, 27 * 60);
  assert.equal(lite.pendingQueue.oldestPendingAgeMinutes, 30 * 60);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes("Audio Failed"), "no sequence names on the public endpoint");
  assert.ok(!text.includes("candidate@example.com"), "no candidate data on the public endpoint");
  assert.ok(Object.hasOwn(res.body.bookingStop, "raydarScheduler"), "the Scheduler-facing block is untouched");
});
