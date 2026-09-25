// End to end: the real tick engine (runTick) feeding the real tier-1 pager
// (alertOnTransitions) through a fake Upstash KV with a movable clock. Pins the
// PR 229 round-2 review findings:
//  - a DOWN, a long DEGRADED or UNKNOWN stretch, then a new DOWN is a new
//    DOWN episode and pages again (incidentAt alone lasts until OK and would
//    swallow the second outage for 31 days);
//  - a short dip out of DOWN stays one page;
//  - DOWN, OK, DOWN still pages twice;
//  - a failed read of hlth:state neither pages nor persists, so an ongoing
//    outage is not re-posted under a fresh key.
// No network, no Slack: fetch is replaced, and `send` records posts.
import test from "node:test";
import assert from "node:assert/strict";

const KV_URL = "https://kv.example.test";
const HOLD_URL = "https://book.raydar.xyz/api/hold";
const MIN = 60_000;
const T0 = Date.parse("2026-09-25T10:00:00Z");

// kv.mjs reads its env at module load: set it before the dynamic import.
process.env.KV_REST_API_URL = KV_URL;
process.env.KV_REST_API_TOKEN = "test-token";
delete process.env.HEALTH_DOWN_TICKS_OVERRIDES;
delete process.env.SLACK_BOT_TOKEN;
delete process.env.SLACK_WEBHOOK_URL;

const { runTick } = await import("../api/health/_lib/engine.mjs");
const { alertOnTransitions } = await import("../api/health/_lib/alert.mjs");
const { K } = await import("../api/health/_lib/kv.mjs");

function harness() {
  const clock = { now: T0 };
  const data = new Map();
  const faults = { failStateGet: false };
  const door = { status: 409 };
  const live = (key) => {
    const entry = data.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= clock.now) { data.delete(key); return null; }
    return entry.value;
  };
  const run = ([op, ...a]) => {
    if (op === "GET") return live(a[0]);
    if (op === "MGET") return a.map((key) => live(key));
    if (op === "DEL") return data.delete(a[0]) ? 1 : 0;
    if (op === "SET") {
      const [key, value, ...opts] = a;
      const exAt = opts.indexOf("EX");
      const nx = opts.includes("NX");
      if (nx && live(key) != null) return null;
      const expiresAt = exAt >= 0 ? clock.now + Number(opts[exAt + 1]) * 1000 : 0;
      data.set(key, { value, expiresAt });
      return "OK";
    }
    if (op === "LPUSH" || op === "LTRIM" || op === "LRANGE") return [];
    return null;
  };
  const fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith(KV_URL)) {
      const body = JSON.parse(init.body);
      if (href.endsWith("/pipeline")) {
        return { ok: true, status: 200, json: async () => body.map((c) => ({ result: run(c) })) };
      }
      if (faults.failStateGet && body[0] === "GET" && body[1] === K.state) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ result: run(body) }) };
    }
    if (href === HOLD_URL) {
      return { ok: false, status: door.status, text: async () => JSON.stringify({ error: `probe-${door.status}` }) };
    }
    // Every other probe: an empty-but-parseable body. Irrelevant here.
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const posts = [];
  const send = async (text) => { posts.push(text); return true; };
  const doorPosts = () => posts.filter((p) => p.includes("Agent booking door"));

  async function tickAt(minutes) {
    clock.now = T0 + minutes * MIN;
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      const out = await runTick({ now: clock.now });
      if (out.stateLoaded) await alertOnTransitions(out.transitions, out.state, { send });
      return out;
    } finally {
      globalThis.fetch = original;
    }
  }
  /** Tick every `step` minutes over [from, to] with the door answering `status`. */
  async function hold(status, from, to, step = 10) {
    door.status = status;
    let last;
    for (let m = from; m <= to; m += step) last = await tickAt(m);
    return last;
  }
  return { data, faults, door, doorPosts, tickAt, hold };
}

test("DOWN (503), six hours DEGRADED (429), then DOWN (403) pages twice", async () => {
  const h = harness();
  await h.hold(409, 0, 10); // baseline: open
  await h.hold(503, 20, 60); // DOWN (after the two-tick debounce)
  assert.equal(h.doorPosts().length, 1);
  const degraded = await h.hold(429, 70, 70 + 6 * 60);
  assert.equal(degraded.state.tiles["booking-door"].state, "DEGRADED");
  assert.ok(degraded.state.tiles["booking-door"].incidentAt, "still one open incident (never OK)");
  await h.hold(403, 440, 440 + 18 * 60);
  assert.equal(h.doorPosts().length, 2, "the second outage reaches #notify");
  assert.match(h.doorPosts()[1], /booking gates off/);
});

test("DOWN, a six-hour UNKNOWN stretch, then DOWN also pages twice", async () => {
  const h = harness();
  await h.hold(409, 0, 10);
  await h.hold(503, 20, 60);
  await h.hold(418, 70, 70 + 6 * 60); // unexpected answer: UNKNOWN
  await h.hold(503, 440, 600);
  assert.equal(h.doorPosts().length, 2);
});

test("a short dip out of DOWN (20 minutes DEGRADED) stays one page", async () => {
  const h = harness();
  await h.hold(409, 0, 10);
  await h.hold(503, 20, 60);
  await h.hold(429, 70, 90);
  await h.hold(403, 100, 100 + 12 * 60);
  assert.equal(h.doorPosts().length, 1);
});

test("DOWN, OK, DOWN (hours apart) still pages twice", async () => {
  const h = harness();
  await h.hold(409, 0, 10);
  await h.hold(503, 20, 60);
  await h.hold(409, 70, 300);
  await h.hold(503, 310, 600);
  assert.equal(h.doorPosts().length, 2);
});

test("a failed hlth:state read mid-outage neither pages nor persists", async () => {
  const h = harness();
  await h.hold(409, 0, 10);
  await h.hold(503, 20, 60);
  assert.equal(h.doorPosts().length, 1);
  const before = h.data.get(K.state).value;

  h.faults.failStateGet = true;
  const blip = await h.tickAt(70);
  h.faults.failStateGet = false;
  assert.equal(blip.stateLoaded, false);
  assert.equal(blip.kvOk, true, "the self-test passed; only the state read failed");
  assert.equal(h.data.get(K.state).value, before, "the blip state was not persisted");

  await h.hold(503, 80, 80 + 6 * 60);
  assert.equal(h.doorPosts().length, 1, "the ongoing outage is not re-posted");
});

test("a genuinely missing hlth:state (first tick ever) proceeds normally", async () => {
  const h = harness();
  const first = await h.tickAt(0);
  assert.equal(first.stateLoaded, true);
  assert.ok(h.data.get(K.state), "the first state is persisted");
});
