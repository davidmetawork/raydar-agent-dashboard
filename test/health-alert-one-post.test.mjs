// The tier-1 pager after the #notify consolidation (2026-09-25): exactly one
// DELIVERED post per DOWN incident. With the hourly STILL DOWN re-page gone,
// these pin the cases a transition-only pager would lose for good: a failed
// or cut-off send, a second incident inside the flap hour, and a tile that
// went DOWN while acked. No network, no KV: a fake store with a movable clock
// and a recording `send` seam.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { alertOnTransitions, pageIncidentKey } from "../api/health/_lib/alert.mjs";
import { CATALOG } from "../api/health/_lib/catalog.mjs";
import { readDownTicksOverrides } from "../api/health/_lib/engine.mjs";

const MIN = 60_000;

function fakeStore() {
  const clock = { now: 0 };
  const data = new Map();
  const live = (key) => {
    const entry = data.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= clock.now) { data.delete(key); return null; }
    return entry;
  };
  return {
    clock,
    data,
    store: {
      async get(key) { return live(key)?.value ?? null; },
      async setNx(key, value, ttl) {
        if (live(key)) return null;
        data.set(key, { value, expiresAt: clock.now + ttl * 1000 });
        return "OK";
      },
      async set(key, value, ttl) {
        data.set(key, { value, expiresAt: clock.now + ttl * 1000 });
        return "OK";
      },
      async del(key) { return data.delete(key) ? 1 : 0; },
    },
  };
}

function recorder(results = []) {
  const posts = [];
  const send = async (text) => {
    posts.push(text);
    return results.length ? results.shift() : true;
  };
  return { posts, send };
}

const down = (incidentAt, extra = {}) => ({
  tiles: {
    "booking-door": {
      state: "DOWN", tier: 1, name: "Agent booking door", reason: "admission closed",
      since: incidentAt, incidentAt, ...extra,
    },
  },
});
const ok = () => ({ tiles: { "booking-door": { state: "OK", tier: 1, name: "Agent booking door" } } });

async function tick(env, state, send) {
  return alertOnTransitions([], state, { send, store: env.store });
}

test("a tier-1 DOWN incident posts exactly once while it stays DOWN", async () => {
  const env = fakeStore();
  const { posts, send } = recorder();
  const first = await tick(env, down("10:00"), send);
  assert.deepEqual(first, [{ id: "booking-door", kind: "page", incident: "10:00" }]);
  for (let i = 1; i <= 90; i += 1) { // three hours of 2-minute ticks
    env.clock.now = i * 2 * MIN;
    assert.deepEqual(await tick(env, down("10:00"), send), []);
  }
  assert.equal(posts.length, 1);
  assert.match(posts[0], /^🔴 DOWN: Agent booking door — admission closed/);
});

test("tier-2 and non-DOWN tiles never page", async () => {
  const env = fakeStore();
  const { posts, send } = recorder();
  await tick(env, {
    tiles: {
      "n8n-workflows": { state: "DOWN", tier: 2, since: "a", incidentAt: "a" },
      "booking-door": { state: "DEGRADED", tier: 1, since: "a", incidentAt: "a" },
      "calls-api": { state: "UNKNOWN", tier: 1, since: "a", incidentAt: "a" },
    },
  }, send);
  assert.deepEqual(posts, []);
});

test("DOWN, OK, then DOWN again inside the hour and staying down posts exactly twice", async () => {
  const env = fakeStore();
  const { posts, send } = recorder();
  env.clock.now = 0; // 10:00
  await tick(env, down("10:00"), send);
  env.clock.now = 8 * MIN; // 10:08 back to OK: no recovery post
  await tick(env, ok(), send);
  const pagesAt = [];
  for (let m = 20; m <= 240; m += 2) { // 10:20 DOWN again, all day
    env.clock.now = m * MIN;
    const sent = await tick(env, down("10:20"), send);
    if (sent.length) pagesAt.push(m);
  }
  assert.equal(posts.length, 2, "the second incident must reach #notify");
  assert.deepEqual(pagesAt, [60], "deferred to the end of the flap hour, not dropped");
});

test("a second incident that clears inside the flap hour never posts", async () => {
  const env = fakeStore();
  const { posts, send } = recorder();
  await tick(env, down("10:00"), send);
  env.clock.now = 8 * MIN;
  await tick(env, ok(), send);
  for (let m = 20; m <= 40; m += 2) {
    env.clock.now = m * MIN;
    await tick(env, down("10:20"), send);
  }
  for (let m = 42; m <= 180; m += 2) {
    env.clock.now = m * MIN;
    await tick(env, ok(), send);
  }
  assert.equal(posts.length, 1);
});

test("a failed Slack delivery is retried on the next tick, then posts nothing more", async () => {
  const env = fakeStore();
  const { posts, send } = recorder([false]);
  const first = await tick(env, down("10:00"), send);
  assert.deepEqual(first, [], "an undelivered page is not reported as sent");
  env.clock.now = 2 * MIN;
  const second = await tick(env, down("10:00"), send);
  assert.deepEqual(second, [{ id: "booking-door", kind: "page", incident: "10:00" }]);
  for (let m = 4; m <= 180; m += 2) {
    env.clock.now = m * MIN;
    await tick(env, down("10:00"), send);
  }
  assert.equal(posts.length, 2, "one failed try, one delivered page");
});

test("a send cut off mid-flight (tick killed) is retried once its claim lapses", async () => {
  const env = fakeStore();
  const { posts, send } = recorder();
  // What a killed tick leaves behind: the short claim and the flap slot, both
  // held for this incident, and no delivered marker.
  await env.store.setNx("hlth:alert:sent:booking-door:DOWN:10:00", { status: "sending" }, 5 * 60);
  await env.store.setNx("hlth:alert:sent:booking-door:DOWN", { incident: "10:00" }, 60 * 60);
  env.clock.now = 2 * MIN;
  await tick(env, down("10:00"), send);
  assert.equal(posts.length, 0, "still inside the claim");
  env.clock.now = 6 * MIN;
  await tick(env, down("10:00"), send);
  assert.equal(posts.length, 1, "retried well before the flap hour ends");
  env.clock.now = 8 * MIN;
  await tick(env, down("10:00"), send);
  assert.equal(posts.length, 1);
});

test("a tile that went DOWN while acked pages once when the ack runs out", async () => {
  const env = fakeStore();
  const { posts, send } = recorder();
  for (let m = 0; m <= 30; m += 2) {
    env.clock.now = m * MIN;
    await tick(env, down("10:00", { ackUntil: "10:30" }), send);
  }
  assert.equal(posts.length, 0, "acknowledged: no page");
  for (let m = 32; m <= 180; m += 2) {
    env.clock.now = m * MIN;
    await tick(env, down("10:00"), send);
  }
  assert.equal(posts.length, 1);
});

test("an incident already DOWN when alerts are enabled pages once, with no transition this tick", async () => {
  const env = fakeStore();
  const { posts, send } = recorder();
  // tick.mjs skips the pager entirely while HEALTH_ALERTS_ENABLED is off; the
  // first enabled tick has no transition for a tile that is already DOWN.
  await alertOnTransitions([], down("09:00"), { send, store: env.store });
  env.clock.now = 2 * MIN;
  await alertOnTransitions([], down("09:00"), { send, store: env.store });
  assert.equal(posts.length, 1);
});

test("a tile born DOWN (no incident pointer) is keyed on its since", () => {
  assert.equal(pageIncidentKey({ state: "DOWN", since: "t1" }), "t1");
  assert.equal(pageIncidentKey({ state: "DOWN", since: "t1", incidentAt: "t0" }), "t0");
});

test("the tick passes the tile state to the pager and echoes the override report", async () => {
  const tick = await readFile(new URL("../api/health/tick.mjs", import.meta.url), "utf8");
  assert.match(tick, /alertOnTransitions\(transitions, state\)/);
  assert.match(tick, /downTicks,/);
  const engine = await readFile(new URL("../api/health/_lib/engine.mjs", import.meta.url), "utf8");
  // runTick reads the overrides against the catalog and feeds them to the debounce.
  assert.match(engine, /readDownTicksOverrides\(process\.env, new Set\(CATALOG\.map/);
  assert.match(engine, /debounceTicksFor\(check\.id, state, downOverrides\)/);
});

test("HEALTH_DOWN_TICKS_OVERRIDES: a typo'd id or bad value is reported by name, not silently dropped", () => {
  const known = new Set(CATALOG.map((c) => c.id));
  assert.ok(known.has("booking-door"));
  const report = readDownTicksOverrides({
    HEALTH_DOWN_TICKS_OVERRIDES: JSON.stringify({ "booking-door": 8, booking_door: 8, "calls-api": 99 }),
  }, known);
  assert.deepEqual(report.effective, { "booking-door": 8 });
  assert.deepEqual(report.rejected.map((r) => r.key), ["booking_door", "calls-api"]);
  assert.match(report.rejected[0].reason, /no health tile/);
  assert.match(report.rejected[1].reason, /2 to 60/);

  const junk = readDownTicksOverrides({ HEALTH_DOWN_TICKS_OVERRIDES: "{not json" }, known);
  assert.deepEqual(junk.effective, {});
  assert.equal(junk.rejected.length, 1);

  assert.deepEqual(readDownTicksOverrides({}, known), { effective: {}, rejected: [] });
});
