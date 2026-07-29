import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AUTH_FLAG_KEY,
  AUTH_LAST_PROBE_KEY,
  AUTH_OPEN_ALERT_KEY,
  AUTH_REMINDER_ALERT_KEY,
  PROBE_READS,
  paraformAuthState,
  probeParaformAuth,
  runAuthProbeTick,
} from "../api/paraai/_lib/auth-probe.mjs";
import opsHandler from "../api/ops/paraform-auth.mjs";

// ---------------------------------------------------------------------------
// Offline stubs. No live Paraform call is ever made: the tRPC layer is
// injected, and the KV fake implements exactly the command subset the probe
// uses (GET / DEL / SET with NX+EX), logging calls for TTL assertions.
// ---------------------------------------------------------------------------

const authError = () => {
  const error = new Error("AUTH_EXPIRED");
  error.code = "AUTH_EXPIRED";
  return error;
};

const networkError = () => {
  const error = new Error("fetch failed");
  error.code = "NETWORK_DOWN";
  return error;
};

// Builds a trpcGetImpl from a scripted list of outcomes, consumed in call
// order: "ok" resolves, "401" rejects AUTH_EXPIRED, "net" rejects non-auth,
// "hang" never settles (budget-exceeded path).
function scriptedTrpc(script) {
  const calls = [];
  const impl = (proc, input, tries) => {
    calls.push({ proc, input, tries });
    const step = script.shift() || "ok";
    if (step === "ok") return Promise.resolve({ ok: true });
    if (step === "401") return Promise.reject(authError());
    if (step === "net") return Promise.reject(networkError());
    return new Promise(() => {});
  };
  impl.calls = calls;
  return impl;
}

function fakeKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = [];
  const impl = async (args) => {
    calls.push(args.map(String));
    const [command, key, ...rest] = args;
    if (command === "GET") return store.has(key) ? store.get(key) : null;
    if (command === "DEL") return store.delete(key) ? 1 : 0;
    if (command === "SET") {
      const flags = rest.slice(1).map(String);
      if (flags.includes("NX") && store.has(key)) return null;
      store.set(key, rest[0]);
      return "OK";
    }
    throw new Error(`fake kv: unsupported command ${command}`);
  };
  impl.store = store;
  impl.calls = calls;
  return impl;
}

function notifyRecorder(result = true) {
  const messages = [];
  const impl = async (text) => {
    messages.push(text);
    if (result instanceof Error) throw result;
    return result;
  };
  impl.messages = messages;
  return impl;
}

const noSleep = async () => {};

// ---------------------------------------------------------------------------
// probeParaformAuth — the down definition.
// ---------------------------------------------------------------------------

test("a healthy first read short-circuits the probe", async () => {
  const trpc = scriptedTrpc(["ok"]);
  const result = await probeParaformAuth({}, { trpcGetImpl: trpc, sleepImpl: noSleep });
  assert.equal(result.healthy, true);
  assert.equal(trpc.calls.length, 1);
  assert.equal(trpc.calls[0].proc, PROBE_READS[0].proc);
  // tries=1: the probe manages its own retry, core's backoff must not stack.
  assert.equal(trpc.calls[0].tries, 1);
});

test("a lone intermittent 401 never trips the breaker", async () => {
  const result = await probeParaformAuth(
    {},
    { trpcGetImpl: scriptedTrpc(["401", "ok"]), sleepImpl: noSleep },
  );
  assert.equal(result.healthy, true);
});

test("both reads 401 but the retry pass recovers → healthy", async () => {
  const trpc = scriptedTrpc(["401", "401", "ok"]);
  const result = await probeParaformAuth({}, { trpcGetImpl: trpc, sleepImpl: noSleep });
  assert.equal(result.healthy, true);
  assert.equal(result.reason, "recovered_on_retry");
  assert.equal(result.passes, 2);
});

test("down requires both distinct reads to 401 on both passes", async () => {
  const trpc = scriptedTrpc(["401", "401", "401", "401"]);
  const result = await probeParaformAuth({}, { trpcGetImpl: trpc, sleepImpl: noSleep });
  assert.equal(result.healthy, false);
  assert.equal(result.reason, "auth_expired");
  assert.deepEqual(result.evidence.procs, PROBE_READS.map((read) => read.proc));
  assert.equal(trpc.calls.length, 4);
  // Two DISTINCT procs, per the spec's two-read definition.
  assert.notEqual(trpc.calls[0].proc, trpc.calls[1].proc);
});

test("a network failure is not a dead cookie: fail open as unknown", async () => {
  const result = await probeParaformAuth(
    {},
    { trpcGetImpl: scriptedTrpc(["net"]), sleepImpl: noSleep },
  );
  assert.equal(result.healthy, null);
  assert.equal(result.reason, "NETWORK_DOWN");
});

test("a 401 followed by a network failure cannot confirm down", async () => {
  const result = await probeParaformAuth(
    {},
    { trpcGetImpl: scriptedTrpc(["401", "net"]), sleepImpl: noSleep },
  );
  assert.equal(result.healthy, null);
});

test("a hung read hits the probe budget and fails open", async () => {
  const result = await probeParaformAuth(
    { budgetMs: 20 },
    { trpcGetImpl: scriptedTrpc(["hang"]), sleepImpl: noSleep },
  );
  assert.equal(result.healthy, null);
  assert.equal(result.reason, "PROBE_BUDGET_EXCEEDED");
});

// ---------------------------------------------------------------------------
// runAuthProbeTick — flag lifecycle and alert discipline.
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const downProbe = async () => ({
  healthy: false,
  reason: "auth_expired",
  passes: 2,
  evidence: { procs: PROBE_READS.map((read) => read.proc), passes: 2, code: "AUTH_EXPIRED" },
});
const greenProbe = async () => ({ healthy: true, reason: "ok", passes: 1 });
const unknownProbe = async () => ({ healthy: null, reason: "NETWORK_DOWN", passes: 1 });

test("opening the circuit sets the flag and sends exactly one runbook alert", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  const result = await runAuthProbeTick(
    { now: NOW },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(result.status, "down");
  assert.equal(result.opened, true);
  const flag = JSON.parse(kv.store.get(AUTH_FLAG_KEY));
  assert.equal(flag.since, new Date(NOW).toISOString());
  assert.equal(flag.evidence.code, "AUTH_EXPIRED");
  assert.equal(flag.alert.delivered, true);
  assert.equal(notify.messages.length, 1);
  assert.match(notify.messages[0], /persist-paraform-browser-session\.mjs/);
  assert.match(notify.messages[0], /[Oo]bserve-only/);
  // The heartbeat is written with a TTL on every tick.
  assert.ok(kv.store.has(AUTH_LAST_PROBE_KEY));
  assert.ok(kv.calls.some(
    (call) => call[0] === "SET" && call[1] === AUTH_LAST_PROBE_KEY && call.includes("EX"),
  ));
});

test("subsequent down ticks keep since, re-alert nothing", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  await runAuthProbeTick({ now: NOW }, { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify });
  const later = await runAuthProbeTick(
    { now: NOW + 5 * 60_000 },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(later.status, "down");
  assert.notEqual(later.opened, true);
  assert.notEqual(later.reminded, true);
  assert.equal(notify.messages.length, 1);
  const flag = JSON.parse(kv.store.get(AUTH_FLAG_KEY));
  assert.equal(flag.since, new Date(NOW).toISOString());
});

test("after the daily slot lapses, one still-down reminder posts with day N", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  await runAuthProbeTick({ now: NOW }, { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify });
  // The reminder slot is armed with EX 86400 at open; the fake KV has no
  // clock, so the TTL lapse a day later is simulated by expiring the key.
  assert.ok(kv.calls.some(
    (call) => call[0] === "SET" && call[1] === AUTH_REMINDER_ALERT_KEY
      && call.includes("EX") && call.includes("86400"),
  ));
  kv.store.delete(AUTH_REMINDER_ALERT_KEY);
  const dayTwo = await runAuthProbeTick(
    { now: NOW + 30 * 3600_000 },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(dayTwo.reminded, true);
  assert.equal(dayTwo.day, 2);
  assert.equal(notify.messages.length, 2);
  assert.match(notify.messages[1], /still OPEN \(day 2\)/);
  // The slot is re-armed: the very next tick stays silent.
  const next = await runAuthProbeTick(
    { now: NOW + 30 * 3600_000 + 5 * 60_000 },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.notEqual(next.reminded, true);
  assert.equal(notify.messages.length, 2);
});

test("going green clears the flag and slots and posts the resumed message", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  await runAuthProbeTick({ now: NOW }, { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify });
  const resumed = await runAuthProbeTick(
    { now: NOW + 3600_000 },
    { probeImpl: greenProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(resumed.resumed, true);
  assert.equal(kv.store.has(AUTH_FLAG_KEY), false);
  assert.equal(kv.store.has(AUTH_OPEN_ALERT_KEY), false);
  assert.equal(kv.store.has(AUTH_REMINDER_ALERT_KEY), false);
  assert.match(notify.messages.at(-1), /cookie healthy — resumed/);
  // A cleared circuit that breaks again alerts again.
  const reopened = await runAuthProbeTick(
    { now: NOW + 2 * 3600_000 },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(reopened.opened, true);
  assert.equal(notify.messages.length, 3);
});

test("green with no flag is the silent steady state", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  const result = await runAuthProbeTick(
    { now: NOW },
    { probeImpl: greenProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(result.status, "healthy");
  assert.equal(result.resumed, false);
  assert.equal(notify.messages.length, 0);
  assert.equal(kv.store.has(AUTH_FLAG_KEY), false);
});

test("an unknown probe never opens, closes, or clears the circuit", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  // While up: unknown writes only the heartbeat.
  const idle = await runAuthProbeTick(
    { now: NOW },
    { probeImpl: unknownProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(idle.status, "unknown");
  assert.equal(kv.store.has(AUTH_FLAG_KEY), false);
  // While down: the open circuit stays exactly as it is.
  await runAuthProbeTick({ now: NOW }, { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify });
  const held = await runAuthProbeTick(
    { now: NOW + 5 * 60_000 },
    { probeImpl: unknownProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(held.status, "unknown");
  assert.equal(held.down, true);
  assert.ok(kv.store.has(AUTH_FLAG_KEY));
  assert.equal(notify.messages.length, 1);
});

test("Slack being unconfigured degrades to the durable flag, never a throw", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(false); // notifySlack returns false without a token
  const result = await runAuthProbeTick(
    { now: NOW },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(result.opened, true);
  assert.equal(result.alertDelivered, false);
  const flag = JSON.parse(kv.store.get(AUTH_FLAG_KEY));
  assert.equal(flag.alert.delivered, false);
});

test("a throwing Slack client is swallowed and the flag still lands", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(new Error("slack down"));
  const result = await runAuthProbeTick(
    { now: NOW },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(result.opened, true);
  assert.equal(result.alertDelivered, false);
  assert.ok(kv.store.has(AUTH_FLAG_KEY));
});

// ---------------------------------------------------------------------------
// The public state shape — {down, since, lastProbe} and nothing internal.
// ---------------------------------------------------------------------------

test("paraformAuthState exposes down/since/lastProbe and nothing else", () => {
  const state = paraformAuthState({
    flag: {
      version: 1,
      since: "2026-07-29T12:00:00.000Z",
      evidence: { code: "AUTH_EXPIRED" },
      alert: { openedAt: "x", delivered: false },
    },
    lastProbe: { at: "2026-07-29T12:05:00.000Z", healthy: false, reason: "auth_expired" },
  });
  assert.deepEqual(state, {
    down: true,
    since: "2026-07-29T12:00:00.000Z",
    lastProbe: { at: "2026-07-29T12:05:00.000Z", healthy: false, reason: "auth_expired" },
  });
});

test("paraformAuthState with no flag reads as up", () => {
  assert.deepEqual(paraformAuthState({}), { down: false, since: null, lastProbe: null });
});

// ---------------------------------------------------------------------------
// GET /api/ops/paraform-auth — method guard and fail-open store handling.
// ---------------------------------------------------------------------------

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

test("the ops endpoint is GET only", async () => {
  const res = fakeRes();
  await opsHandler({ method: "POST", headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

test("without a store the endpoint fails OPEN: ok:false, down:false", async () => {
  // Offline test runs have no KV_REST_API_* env, so this exercises the real
  // storeConfigured()=false path — the same shape a consumer must treat as
  // "proceed normally", per the endpoint's fail-open contract.
  assert.equal(Boolean(process.env.KV_REST_API_URL), false);
  const res = fakeRes();
  await opsHandler({ method: "GET", headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.down, false);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

// ---------------------------------------------------------------------------
// Worker integration — the probe rides the tick without touching it.
// ---------------------------------------------------------------------------

const workerSource = readFileSync(
  new URL("../api/paraai/worker.mjs", import.meta.url),
  "utf8",
);

test("the probe runs on the tick path, before the lane cycle", () => {
  const probe = workerSource.indexOf("await runAuthProbeTick()");
  const cycle = workerSource.indexOf("await runAutomationCycle(");
  assert.ok(probe > 0, "expected the auth probe on the worker tick");
  assert.ok(cycle > 0, "expected the automation cycle in the handler");
  // Before the cycle: a throwing tick (e.g. a full AUTH_EXPIRED outage)
  // must not starve the probe that exists to detect exactly that.
  assert.ok(probe < cycle, "the probe must run before the lane cycle");
});

test("a probe failure can never break the tick", () => {
  assert.match(
    workerSource,
    /try \{ await runAuthProbeTick\(\); \} catch \{ \/\* observe-only \*\/ \}/,
  );
});

test("the probe stays out of the frozen worker response", () => {
  // Phase 1 is observe-only: the flag is read via GET /api/ops/paraform-auth
  // and the worker response shape stays byte-identical for its consumers.
  assert.equal(workerSource.includes("authProbe:"), false);
  assert.equal((workerSource.match(/runAuthProbeTick/g) || []).length, 2,
    "one import, one guarded call — nothing feeds the response");
});
