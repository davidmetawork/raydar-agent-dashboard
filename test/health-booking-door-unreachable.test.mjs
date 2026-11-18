// The Monitor pager's blind spot of 2026-11-18, pinned end to end.
//
// The raydar.xyz renewal went unpaid and the registrar parked the domain from
// 11:48Z to 16:00Z. The booking-door probe ran every two minutes throughout
// and logged "fetch failed", which the engine filed as UNKNOWN. Only a
// tier-1 DOWN pages, so #notify heard nothing for four hours.
//
// These tests drive the real tick handler (api/health/tick.mjs) with the
// pager switched on, a fake KV, a fake Slack and a fake booking site. Nothing
// here touches the network: every fetch is answered by this file.
//
// api/health/_lib/kv.mjs reads KV_REST_API_URL at module load, so the env is
// set before the dynamic import() below (same pattern as
// test/health-upcoming-cache.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";

const KV_URL = "https://kv.example.test";
const HOLD_URL = "https://book.raydar.xyz/api/hold";
const HEALTH_URL = "https://book.raydar.xyz/api/health";
const SLACK_URL = "https://slack.com/api/chat.postMessage";

process.env.KV_REST_API_URL = KV_URL;
process.env.KV_REST_API_TOKEN = "test-token";
process.env.CRON_SECRET = "test-cron-secret";
process.env.HEALTH_ALERTS_ENABLED = "true";
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.HEALTH_SLACK_CHANNEL = "C_TEST_NOTIFY";
delete process.env.SLACK_WEBHOOK_URL;

const { default: tick } = await import("../api/health/tick.mjs");
const { K } = await import("../api/health/_lib/kv.mjs");
const { CATALOG } = await import("../api/health/_lib/catalog.mjs");

function kvCommand(store, command) {
  const [op, ...a] = command;
  switch (String(op).toUpperCase()) {
    case "GET": return store.has(a[0]) ? store.get(a[0]) : null;
    case "MGET": return a.map((key) => (store.has(key) ? store.get(key) : null));
    case "SET": {
      const nx = a.slice(2).some((x) => String(x).toUpperCase() === "NX");
      if (nx && store.has(a[0])) return null;
      store.set(a[0], a[1]);
      return "OK";
    }
    case "DEL": return store.delete(a[0]) ? 1 : 0;
    default: return null;
  }
}

const connectionError = (code) =>
  Object.assign(new TypeError("fetch failed"), { cause: { code } });
const timeoutError = () =>
  Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const answer = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

/**
 * @param {object} world mutable: `door` is what the booking site does this
 *   tick ("open" | "unreachable" | "timeout" | a number = that HTTP status);
 *   `others` is what every other probed endpoint does ("ok" | "unreachable").
 */
function harness(world) {
  const store = new Map();
  const slack = [];
  const fetchStub = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith(KV_URL)) {
      const parsed = JSON.parse(init.body);
      if (href.endsWith("/pipeline")) return answer(200, parsed.map((c) => ({ result: kvCommand(store, c) })));
      return answer(200, { result: kvCommand(store, parsed) });
    }
    if (href === SLACK_URL) {
      slack.push(JSON.parse(init.body).text);
      return answer(200, { ok: true });
    }
    if (href === HOLD_URL || href === HEALTH_URL) {
      if (world.door === "unreachable") throw connectionError("ERR_TLS_CERT_ALTNAME_INVALID");
      if (world.door === "timeout") throw timeoutError();
      if (href === HEALTH_URL) return answer(200, { ok: true, agentAdmission: true, checks: {} });
      if (world.door === "open") return answer(409, { error: "slot_taken" });
      return answer(world.door, { error: "odd" });
    }
    if (world.others === "unreachable") throw connectionError("ENOTFOUND");
    return answer(200, {});
  };
  const runTick = async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fetchStub;
    try {
      const res = {
        code: 0, body: null,
        status(c) { this.code = c; return this; },
        json(b) { this.body = b; return this; },
      };
      await tick({ headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, res);
      assert.equal(res.code, 200, "the tick itself must succeed");
    } finally {
      globalThis.fetch = original;
    }
    return JSON.parse(store.get(K.state)).tiles;
  };
  const doorPosts = () => slack.filter((text) => text.includes("Agent booking door"));
  return { runTick, slack, doorPosts };
}

test("an unreachable booking site goes DOWN on the second failed check and pages exactly once", async () => {
  const world = { door: "open", others: "ok" };
  const h = harness(world);

  let tiles = await h.runTick();
  assert.equal(tiles["booking-door"].state, "OK");
  assert.deepEqual(h.doorPosts(), []);

  // First failed check: held as pending, nobody is paged.
  world.door = "unreachable";
  tiles = await h.runTick();
  assert.equal(tiles["booking-door"].state, "OK");
  assert.equal(tiles["booking-door"].pending, "DOWN");
  assert.deepEqual(h.doorPosts(), []);

  // Second failed check in a row: DOWN, one page.
  tiles = await h.runTick();
  assert.equal(tiles["booking-door"].state, "DOWN");
  assert.match(tiles["booking-door"].reason, /^book\.raydar\.xyz cannot be reached: fetch failed \(ERR_TLS_CERT_ALTNAME_INVALID\)$/);
  assert.equal(h.doorPosts().length, 1);
  assert.match(h.doorPosts()[0], /^🔴 DOWN: Agent booking door — book\.raydar\.xyz cannot be reached/);

  // Still down two minutes later: no second page inside the hour.
  tiles = await h.runTick();
  assert.equal(tiles["booking-door"].state, "DOWN");
  assert.equal(h.doorPosts().length, 1);

  // Back: leaves DOWN at once, one recovery line.
  world.door = "open";
  tiles = await h.runTick();
  assert.equal(tiles["booking-door"].state, "OK");
  assert.equal(h.doorPosts().length, 2);
  assert.match(h.doorPosts()[1], /^🟢 RECOVERED: Agent booking door/);
});

test("a booking site that never answers inside the time limit counts as unreachable too", async () => {
  const world = { door: "open", others: "ok" };
  const h = harness(world);
  await h.runTick();
  world.door = "timeout";
  await h.runTick();
  const tiles = await h.runTick();
  assert.equal(tiles["booking-door"].state, "DOWN");
  assert.match(tiles["booking-door"].reason, /^book\.raydar\.xyz cannot be reached: timeout$/);
  assert.equal(h.doorPosts().length, 1);
});

test("a single failed check that clears is never a page", async () => {
  const world = { door: "open", others: "ok" };
  const h = harness(world);
  await h.runTick();
  world.door = "unreachable";
  await h.runTick();
  world.door = "open";
  const tiles = await h.runTick();
  assert.equal(tiles["booking-door"].state, "OK");
  assert.equal(tiles["booking-door"].pending, undefined);
  assert.deepEqual(h.doorPosts(), []);
});

test("an answer below 500 that the door check cannot read stays UNKNOWN and never pages", async () => {
  const world = { door: "open", others: "ok" };
  const h = harness(world);
  await h.runTick();
  world.door = 418;
  await h.runTick();
  const tiles = await h.runTick();
  assert.equal(tiles["booking-door"].state, "UNKNOWN");
  assert.match(tiles["booking-door"].reason, /unexpected hold answer HTTP 418/);
  assert.deepEqual(h.doorPosts(), []);
});

test("every other critical check still files a failed connection as UNKNOWN", async () => {
  // David's yes covered the booking door alone. With the whole network
  // failing, the booking door is the only pulled check that goes DOWN.
  const world = { door: "unreachable", others: "unreachable" };
  const h = harness(world);
  await h.runTick();
  const tiles = await h.runTick();

  assert.equal(tiles["booking-door"].state, "DOWN");
  const otherCriticalPulls = CATALOG
    .filter((c) => c.tier === 1 && c.kind === "pull" && !c.paused && c.id !== "booking-door");
  assert.deepEqual(
    otherCriticalPulls.map((c) => c.id).sort(),
    ["calls-api", "lifecycle-connector-chase", "lifecycle-human-handoff", "screener-feed", "screener-uplink"],
  );
  for (const c of otherCriticalPulls) {
    assert.equal(tiles[c.id].state, "UNKNOWN", `${c.id} must stay UNKNOWN on a failed connection`);
    assert.equal(tiles[c.id].reason, "fetch failed");
    assert.ok(!h.slack.some((text) => text.includes(c.name)), `${c.name} must not page`);
  }
  assert.equal(h.doorPosts().length, 1);
});
