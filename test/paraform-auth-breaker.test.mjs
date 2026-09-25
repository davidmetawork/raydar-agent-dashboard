import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AUTH_FLAG_KEY,
  AUTH_LAST_PROBE_KEY,
  AUTH_OPEN_ALERT_KEY,
  AUTH_PROBE_CADENCE_KEY,
  AUTH_READ_RECOVERY_KEY,
  AUTH_READ_SUSPECT_KEY,
  AUTH_REMINDER_ALERT_KEY,
  AUTH_WRITE_FAILURE_KEY,
  PROBE_READS,
  paraformAuthState,
  confirmationSeparationMs,
  probeParaformAuth,
  probeIntervalSeconds,
  probeReadBudgetMs,
  publicProbeReason,
  reportParaformReadAuthFailure,
  reportParaformWriteAuthFailure,
  reportParaformWriteAuthSuccess,
  runAuthProbeTick,
  runScheduledAuthProbeTick,
} from "../api/paraai/_lib/auth-probe.mjs";
import opsHandler from "../api/ops/paraform-auth.mjs";
import { notifySlotKey, pageNotify } from "../api/_lib/notify.mjs";

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
    if (step === "throttle") {
      const error = new Error("PARAFORM_THROTTLED");
      error.code = "PARAFORM_THROTTLED";
      return Promise.reject(error);
    }
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
      if (flags.includes("XX") && !store.has(key)) return null;
      store.set(key, rest[0]);
      return "OK";
    }
    if (command === "EVAL") {
      const failureKey = rest[1];
      const succeededAt = String(rest[2] || "");
      const current = JSON.parse(store.get(failureKey) || "null");
      if (current?.observedAt && current.observedAt <= succeededAt) {
        store.delete(failureKey);
        return 1;
      }
      return 0;
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

test("the raw Para AI throttle code is treated as a 401 observation", async () => {
  const trpc = scriptedTrpc(["throttle", "throttle", "throttle", "throttle"]);
  const result = await probeParaformAuth(
    {},
    { trpcGetImpl: trpc, sleepImpl: noSleep },
  );
  assert.equal(result.healthy, false);
  assert.equal(result.reason, "auth_expired");
  assert.equal(trpc.calls.length, 4);
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

test("a hung retry-pass read fails open, never down", async () => {
  // Pass 1: both distinct reads 401. Pass 2: the first read hangs. The
  // budget catch must land on healthy:null — down needs FOUR real 401s.
  const result = await probeParaformAuth(
    { budgetMs: 20 },
    { trpcGetImpl: scriptedTrpc(["401", "401", "hang"]), sleepImpl: noSleep },
  );
  assert.equal(result.healthy, null);
  assert.equal(result.reason, "PROBE_BUDGET_EXCEEDED");
});

test("the retry gap is inside the overall budget: a hang there fails open", async () => {
  // No read is in flight during the retry sleep, so only the aggregate
  // (2x per-read) budget can bound it.
  const hangingSleep = () => new Promise(() => {});
  const result = await probeParaformAuth(
    { budgetMs: 20 },
    { trpcGetImpl: scriptedTrpc(["401", "401"]), sleepImpl: hangingSleep },
  );
  assert.equal(result.healthy, null);
  assert.equal(result.reason, "PROBE_BUDGET_EXCEEDED");
});

test("slow 401s cannot stack past twice the per-read budget", async () => {
  // Each read 401s just under the per-read cap, so only the aggregate cap
  // can stop the stack: 4 reads x 30ms crosses 2 x 50ms before pass 2 ends.
  const slow401 = () => new Promise((_, reject) => {
    setTimeout(() => reject(authError()), 30);
  });
  const result = await probeParaformAuth(
    { budgetMs: 50 },
    { trpcGetImpl: slow401, sleepImpl: noSleep },
  );
  assert.equal(result.healthy, null);
  assert.equal(result.reason, "PROBE_BUDGET_EXCEEDED");
});

test("a malformed budget override falls back instead of disarming", () => {
  assert.equal(probeReadBudgetMs("8s"), 8000); // NaN must not become the cap
  assert.equal(probeReadBudgetMs(""), 8000);
  assert.equal(probeReadBudgetMs(undefined), 8000);
  assert.equal(probeReadBudgetMs("100"), 8000); // sub-500ms starves real reads
  assert.equal(probeReadBudgetMs("12000"), 12000);
});

test("probe cadence and confirmation intervals reject unsafe overrides", () => {
  assert.equal(probeIntervalSeconds(undefined), 300);
  assert.equal(probeIntervalSeconds("5"), 300);
  assert.equal(probeIntervalSeconds("120"), 300);
  assert.equal(probeIntervalSeconds("600"), 600);
  assert.equal(confirmationSeparationMs(undefined), 180_000);
  assert.equal(confirmationSeparationMs("500"), 180_000);
  assert.equal(confirmationSeparationMs("10000"), 180_000);
  assert.equal(confirmationSeparationMs("600000"), 600_000);
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
const CONFIRMATION_MS = confirmationSeparationMs();

async function openReadCircuit(kv, notify, now = NOW) {
  const suspected = await runAuthProbeTick(
    { now },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(suspected.status, "suspected");
  assert.equal(suspected.down, false);
  return runAuthProbeTick(
    { now: now + CONFIRMATION_MS },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
}

async function closeReadCircuit(kv, notify, now) {
  const recovering = await runAuthProbeTick(
    { now },
    { probeImpl: greenProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(recovering.status, "recovering");
  return runAuthProbeTick(
    { now: now + CONFIRMATION_MS },
    { probeImpl: greenProbe, kvImpl: kv, notifyImpl: notify },
  );
}

test("the shared cadence claim admits one probe across overlapping pollers", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  let probes = 0;
  const probe = async () => { probes += 1; return greenProbe(); };
  const [first, second] = await Promise.all([
    runScheduledAuthProbeTick(
      { now: NOW },
      { probeImpl: probe, kvImpl: kv, notifyImpl: notify },
    ),
    runScheduledAuthProbeTick(
      { now: NOW },
      { probeImpl: probe, kvImpl: kv, notifyImpl: notify },
    ),
  ]);
  assert.equal(probes, 1);
  assert.equal([first, second].filter((result) => result.status === "skipped").length, 1);
  assert.ok(kv.store.has(AUTH_PROBE_CADENCE_KEY));
  assert.ok(kv.calls.some(
    (call) => call[0] === "SET" && call[1] === AUTH_PROBE_CADENCE_KEY
      && call.includes("NX") && call.includes("EX") && call.includes("300"),
  ));
});

test("one failed observation is only a suspicion and a green sample clears it", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  const suspected = await runAuthProbeTick(
    { now: NOW },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(suspected.status, "suspected");
  assert.equal(kv.store.has(AUTH_READ_SUSPECT_KEY), true);
  assert.equal(kv.store.has(AUTH_FLAG_KEY), false);
  assert.equal(notify.messages.length, 0);
  const green = await runAuthProbeTick(
    { now: NOW + CONFIRMATION_MS },
    { probeImpl: greenProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(green.status, "healthy");
  assert.equal(kv.store.has(AUTH_READ_SUSPECT_KEY), false);
  assert.equal(notify.messages.length, 0);
});

test("lane AUTH_EXPIRED reports feed the circuit without posting lane Slack", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  const reported = await reportParaformReadAuthFailure(
    { lane: "paraai_interest", stage: "worker", now: NOW },
    { kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(reported.circuit.status, "suspected");
  assert.equal(notify.messages.length, 0);
  const confirmed = await runAuthProbeTick(
    { now: NOW + CONFIRMATION_MS },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(confirmed.opened, true);
  assert.equal(notify.messages.length, 1);
  assert.match(notify.messages[0], /auth circuit OPEN/);
});

test("one green observation keeps a read-layer incident open", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  await openReadCircuit(kv, notify);
  const recovering = await runAuthProbeTick(
    { now: NOW + 10 * 60_000 },
    { probeImpl: greenProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(recovering.status, "recovering");
  assert.equal(recovering.down, true);
  assert.equal(kv.store.has(AUTH_READ_RECOVERY_KEY), true);
  assert.equal(kv.store.has(AUTH_FLAG_KEY), true);
  assert.equal(notify.messages.filter((text) => /resumed/.test(text)).length, 0);
});

test("opening the circuit sets the flag and sends exactly one runbook alert", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  const result = await openReadCircuit(kv, notify);
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
  await openReadCircuit(kv, notify);
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
  await openReadCircuit(kv, notify);
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

test("going green clears the flag and slots and posts nothing (no recovery notes)", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  await openReadCircuit(kv, notify);
  const resumed = await closeReadCircuit(kv, notify, NOW + 3600_000);
  assert.equal(resumed.resumed, true);
  assert.equal(kv.store.has(AUTH_FLAG_KEY), false);
  assert.equal(kv.store.has(AUTH_OPEN_ALERT_KEY), false);
  assert.equal(kv.store.has(AUTH_REMINDER_ALERT_KEY), false);
  assert.equal(resumed.alertDelivered, false);
  assert.equal(notify.messages.filter((text) => /resumed/.test(text)).length, 0);
  assert.equal(notify.messages.length, 1, "only the OPEN page");
  // A cleared circuit that breaks again alerts again.
  const reopened = await openReadCircuit(kv, notify, NOW + 2 * 3600_000);
  assert.equal(reopened.opened, true);
  assert.equal(notify.messages.length, 2);
});

test("a mutation 401 opens the circuit even while all read probes are green", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  const failure = await reportParaformWriteAuthFailure(
    {
      lane: "paraai_outreach",
      stage: "digest_mutation",
      now: NOW,
    },
    { kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(failure.circuit.opened, true);
  assert.ok(kv.store.has(AUTH_WRITE_FAILURE_KEY));
  assert.ok(kv.store.has(AUTH_FLAG_KEY));
  assert.match(notify.messages[0], /mutation returned 401/);
  assert.match(notify.messages[0], /digest_mutation/);

  const stillDown = await runAuthProbeTick(
    { now: NOW + 5 * 60_000 },
    { probeImpl: greenProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(stillDown.down, true);
  assert.equal(stillDown.status, "down");
  assert.equal(kv.store.has(AUTH_FLAG_KEY), true);
  const heartbeat = JSON.parse(kv.store.get(AUTH_LAST_PROBE_KEY));
  assert.equal(heartbeat.reason, "write_auth_expired");
  assert.equal(notify.messages.length, 1);
});

test("only a later successful mutation clears the write-auth latch", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  await reportParaformWriteAuthFailure(
    { lane: "paraai_outreach", stage: "digest_mutation", now: NOW },
    { kvImpl: kv, notifyImpl: notify },
  );

  const older = await reportParaformWriteAuthSuccess(
    { lane: "paraai_outreach", stage: "digest_mutation", now: NOW - 1 },
    { kvImpl: kv },
  );
  assert.equal(older.cleared, false);
  assert.ok(kv.store.has(AUTH_WRITE_FAILURE_KEY));

  const newer = await reportParaformWriteAuthSuccess(
    { lane: "paraai_outreach", stage: "digest_mutation", now: NOW + 1 },
    { kvImpl: kv },
  );
  assert.equal(newer.cleared, true);
  assert.equal(kv.store.has(AUTH_WRITE_FAILURE_KEY), false);

  const resumed = await runAuthProbeTick(
    { now: NOW + 5 * 60_000 },
    { probeImpl: greenProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(resumed.resumed, true);
  assert.equal(kv.store.has(AUTH_FLAG_KEY), false);
});

test("overlapping green ticks close the episode exactly once and post nothing", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  await openReadCircuit(kv, notify);
  await runAuthProbeTick(
    { now: NOW + 3600_000 },
    { probeImpl: greenProbe, kvImpl: kv, notifyImpl: notify },
  );
  // cron + Fly land on the same episode at once: interleaved on the shared
  // store, both can read the flag as present, but only the DEL that
  // actually removes it claims the episode and posts.
  const [first, second] = await Promise.all([
    runAuthProbeTick(
      { now: NOW + 3600_000 + CONFIRMATION_MS },
      { probeImpl: greenProbe, kvImpl: kv, notifyImpl: notify },
    ),
    runAuthProbeTick(
      { now: NOW + 3600_000 + CONFIRMATION_MS },
      { probeImpl: greenProbe, kvImpl: kv, notifyImpl: notify },
    ),
  ]);
  assert.equal([first, second].filter((tick) => tick.resumed).length, 1);
  assert.equal(notify.messages.filter((text) => /resumed/.test(text)).length, 0);
  assert.equal(kv.store.has(AUTH_FLAG_KEY), false);
});

test("losing the open NX cannot mint a day-1 reminder seconds later", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  // The losing tick's view of the race: the winner claimed the open slot
  // (value = openedAt) moments ago but has not armed the reminder slot yet.
  kv.store.set(AUTH_OPEN_ALERT_KEY, new Date(NOW).toISOString());
  kv.store.set(AUTH_FLAG_KEY, JSON.stringify({
    since: new Date(NOW).toISOString(),
    evidence: { mode: "read", code: "AUTH_EXPIRED" },
  }));
  const result = await runAuthProbeTick(
    { now: NOW + 30_000 },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(result.status, "down");
  assert.notEqual(result.reminded, true);
  assert.equal(notify.messages.length, 0);
  // Nothing consumed the reminder slot: the winner's arm still lands clean.
  assert.equal(kv.store.has(AUTH_REMINDER_ALERT_KEY), false);
});

test("the reminder stays the crash fallback once the grace window passes", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  // A tick died between the open NX and the open notify two hours ago: the
  // open slot exists, no alert ever posted, no reminder slot armed.
  kv.store.set(AUTH_OPEN_ALERT_KEY, new Date(NOW - 2 * 3600_000).toISOString());
  kv.store.set(AUTH_FLAG_KEY, JSON.stringify({
    since: new Date(NOW - 2 * 3600_000).toISOString(),
    evidence: { mode: "read", code: "AUTH_EXPIRED" },
  }));
  const result = await runAuthProbeTick(
    { now: NOW },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(result.reminded, true);
  assert.equal(notify.messages.length, 1);
  assert.match(notify.messages[0], /still OPEN/);
});

test("down ticks keep the open slot alive: XX refresh, value preserved", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  await openReadCircuit(kv, notify);
  const openedAt = kv.store.get(AUTH_OPEN_ALERT_KEY);
  await runAuthProbeTick(
    { now: NOW + 5 * 60_000 },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify },
  );
  // The 30d TTL is only a leak guard: mid-episode expiry would re-post a
  // duplicate open alert on day 31, so every down tick re-arms it (XX: an
  // already-expired slot is never resurrected).
  assert.ok(kv.calls.some(
    (call) => call[0] === "SET" && call[1] === AUTH_OPEN_ALERT_KEY
      && call.includes("XX") && call.includes("EX")
      && call.includes(String(30 * 24 * 60 * 60)),
  ));
  // The refresh must never rewrite openedAt — the reminder grace reads it.
  assert.equal(kv.store.get(AUTH_OPEN_ALERT_KEY), openedAt);
});

test("a retry pass gone unknown fails open: no flag write, no alert", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  // Pass 1: both reads 401. Pass 2: 401 then a network failure — the real
  // probe (scripted tRPC) must land on unknown, and the tick must not open.
  const probeImpl = () => probeParaformAuth(
    {},
    { trpcGetImpl: scriptedTrpc(["401", "401", "401", "net"]), sleepImpl: noSleep },
  );
  const result = await runAuthProbeTick(
    { now: NOW },
    { probeImpl, kvImpl: kv, notifyImpl: notify },
  );
  assert.equal(result.status, "unknown");
  assert.equal(kv.store.has(AUTH_FLAG_KEY), false);
  assert.equal(notify.messages.length, 0);
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
  await openReadCircuit(kv, notify);
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
  const result = await openReadCircuit(kv, notify);
  assert.equal(result.opened, true);
  assert.equal(result.alertDelivered, false);
  const flag = JSON.parse(kv.store.get(AUTH_FLAG_KEY));
  assert.equal(flag.alert.delivered, false);
});

test("a throwing Slack client is swallowed and the flag still lands", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(new Error("slack down"));
  const result = await openReadCircuit(kv, notify);
  assert.equal(result.opened, true);
  assert.equal(result.alertDelivered, false);
  assert.ok(kv.store.has(AUTH_FLAG_KEY));
});

// ---------------------------------------------------------------------------
// The public state shape — {down, since, lastProbe, alert}, nothing internal.
// ---------------------------------------------------------------------------

test("paraformAuthState exposes down/since/lastProbe/alert and nothing else", () => {
  const state = paraformAuthState({
    flag: {
      version: 1,
      since: "2026-07-29T12:00:00.000Z",
      evidence: { code: "AUTH_EXPIRED" },
      alert: { openedAt: "2026-07-29T12:00:00.000Z", delivered: false },
    },
    lastProbe: { at: "2026-07-29T12:05:00.000Z", healthy: false, reason: "auth_expired" },
  });
  assert.deepEqual(state, {
    down: true,
    since: "2026-07-29T12:00:00.000Z",
    lastProbe: { at: "2026-07-29T12:05:00.000Z", healthy: false, reason: "auth_expired" },
    // The delivery summary is public ON PURPOSE: with no Slack token in
    // production, this is how anyone learns the open post never landed.
    alert: { openedAt: "2026-07-29T12:00:00.000Z", delivered: false },
  });
});

test("paraformAuthState with no flag reads as up", () => {
  assert.deepEqual(paraformAuthState({}), {
    down: false,
    since: null,
    lastProbe: null,
    alert: null,
  });
});

test("public probe reasons are a closed enum, never raw internals", () => {
  assert.equal(publicProbeReason("ok"), "ok");
  assert.equal(publicProbeReason("recovered_on_retry"), "recovered_on_retry");
  assert.equal(publicProbeReason("auth_expired"), "auth_expired");
  assert.equal(publicProbeReason("AUTH_EXPIRED"), "auth_expired");
  assert.equal(publicProbeReason("auth_suspected"), "auth_suspected");
  assert.equal(publicProbeReason("recovery_pending"), "recovery_pending");
  assert.equal(publicProbeReason("write_auth_expired"), "write_auth_expired");
  assert.equal(publicProbeReason("PROBE_BUDGET_EXCEEDED"), "probe_budget_exceeded");
  assert.equal(publicProbeReason("fetch failed"), "network");
  assert.equal(publicProbeReason("ECONNRESET"), "network");
  assert.equal(publicProbeReason("UND_ERR_CONNECT_TIMEOUT"), "network");
  assert.equal(publicProbeReason("23"), "network"); // DOMException timeout code
  assert.equal(
    publicProbeReason("no Paraform session cookie or n8n variable fallback configured"),
    "no_cookie",
  );
  assert.equal(publicProbeReason("PARAFORM_SESSION_COOKIE not found in n8n variables"), "no_cookie");
  assert.equal(publicProbeReason("n8n variables read failed: 502"), "store_error");
  assert.equal(publicProbeReason("PARAFORM_SESSION_COOKIE_PARTS_INVALID"), "store_error");
  assert.equal(publicProbeReason("HTTP_502"), "vendor_error");
  assert.equal(publicProbeReason("INTERNAL_SERVER_ERROR"), "vendor_error");
  // Anything unrecognized is a vendor detail the endpoint must not echo.
  assert.equal(publicProbeReason("some internal detail with a secret"), "vendor_error");
  assert.equal(publicProbeReason(null), null);
});

test("paraformAuthState maps raw reasons before they go public", () => {
  const state = paraformAuthState({
    lastProbe: {
      at: "2026-07-29T12:05:00.000Z",
      healthy: null,
      reason: "n8n variables read failed: 502",
    },
  });
  assert.equal(state.lastProbe.reason, "store_error");
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
  assert.equal(res.payload.alert, null);
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
  const probe = workerSource.indexOf("await runScheduledAuthProbeTick()");
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
    /try \{ await runScheduledAuthProbeTick\(\); \} catch \{ \/\* observe-only \*\/ \}/,
  );
});

test("the probe stays out of the frozen worker response", () => {
  // Phase 1 is observe-only: the flag is read via GET /api/ops/paraform-auth
  // and the worker response shape stays byte-identical for its consumers.
  assert.equal(workerSource.includes("authProbe:"), false);
  assert.equal((workerSource.match(/runScheduledAuthProbeTick/g) || []).length, 2,
    "one import, one guarded call — nothing feeds the response");
});

test("#notify switch on: the circuit still opens and latches, but System Health owns the page", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  const owns = () => true;
  const suspected = await runAuthProbeTick(
    { now: NOW },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify, healthOwnsSession: owns },
  );
  assert.equal(suspected.status, "suspected");
  const opened = await runAuthProbeTick(
    { now: NOW + CONFIRMATION_MS },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify, healthOwnsSession: owns },
  );
  assert.equal(opened.opened, true);
  assert.equal(opened.alertDelivered, false);
  assert.ok(kv.store.has(AUTH_FLAG_KEY), "the flag and the ops endpoint behave as before");
  const dayLater = await runAuthProbeTick(
    { now: NOW + CONFIRMATION_MS + 26 * 3600_000 },
    { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify, healthOwnsSession: owns },
  );
  assert.equal(dayLater.down, true);
  assert.deepEqual(notify.messages, [], "no OPEN and no daily reminder once the tile owns the session");
});

test("#notify switch on: a WRITE-layer 401 still pages #notify once (the tile cannot see it)", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  const pages = [];
  const pageImpl = async (text, options) => { pages.push({ text, options }); return { ok: true, via: "notify" }; };
  const writeDown = async () => ({
    healthy: false,
    reason: "write_auth_expired",
    evidence: { code: "AUTH_EXPIRED", mode: "write", lane: "paraai_outreach", stage: "digest_mutation" },
  });
  const deps = { probeImpl: writeDown, kvImpl: kv, notifyImpl: notify, healthOwnsSession: () => true, pageImpl };
  const opened = await runAuthProbeTick({ now: NOW }, deps);
  assert.equal(opened.opened, true);
  assert.equal(opened.alertDelivered, true);
  assert.equal(pages.length, 1);
  assert.match(pages[0].text, /mutation returned 401/);
  assert.doesNotMatch(pages[0].text, /daily reminder/, "no reminder follows once the switch is on");
  const dayLater = await runAuthProbeTick({ now: NOW + 26 * 3600_000 }, deps);
  assert.equal(dayLater.down, true);
  assert.equal(pages.length, 1, "no daily reminder in #notify");
  assert.deepEqual(notify.messages, [], "the legacy channel is untouched");
});

// PR 230 review round 2: with the switch on, the write-layer page is the
// ONLY post (reminders are silent), so a failed send must be retried.
const writeDownProbe = async () => ({
  healthy: false,
  reason: "write_auth_expired",
  evidence: { code: "AUTH_EXPIRED", mode: "write", lane: "paraai_outreach", stage: "digest_mutation" },
});

// A pageNotify stand-in with its real slot semantics: a held key answers
// ok:true skipped:"duplicate", and a failed send releases the key.
function pageRecorder() {
  const slots = new Set();
  const pages = [];
  let ok = true;
  const pageImpl = async (text, { key } = {}) => {
    if (key && slots.has(key)) return { ok: true, via: "notify", skipped: "duplicate", key };
    if (key) slots.add(key);
    if (!ok) {
      if (key) slots.delete(key);
      return { ok: false, via: "notify", key };
    }
    pages.push({ text, key });
    return { ok: true, via: "notify", key };
  };
  return { pageImpl, pages, slots, setOk: (value) => { ok = value; } };
}

test("#notify switch on: a WRITE-layer page that fails to send is retried on the next tick, then stops", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  const page = pageRecorder();
  const deps = { probeImpl: writeDownProbe, kvImpl: kv, notifyImpl: notify, healthOwnsSession: () => true, pageImpl: page.pageImpl };
  page.setOk(false);
  const opened = await runAuthProbeTick({ now: NOW }, deps);
  assert.equal(opened.opened, true);
  assert.equal(opened.alertDelivered, false);
  assert.equal(JSON.parse(kv.store.get(AUTH_FLAG_KEY)).alert.delivered, false);
  const stillFailing = await runAuthProbeTick({ now: NOW + 5 * 60_000 }, deps);
  assert.equal(stillFailing.alertRetried, true);
  assert.equal(stillFailing.alertDelivered, false);
  page.setOk(true);
  const retried = await runAuthProbeTick({ now: NOW + 10 * 60_000 }, deps);
  assert.equal(retried.alertRetried, true);
  assert.equal(retried.alertDelivered, true);
  assert.equal(page.pages.length, 1);
  assert.match(page.pages[0].text, /mutation returned 401/);
  const flag = JSON.parse(kv.store.get(AUTH_FLAG_KEY));
  assert.equal(flag.alert.delivered, true);
  assert.equal(flag.alert.via, "notify");
  const later = await runAuthProbeTick({ now: NOW + 26 * 3600_000 }, deps);
  assert.equal(later.alertRetried, undefined, "delivered: no more sends");
  assert.equal(page.pages.length, 1, "one post per episode");
  assert.deepEqual(notify.messages, [], "the legacy channel is untouched");
});

test("#notify switch on: a tick that finds the episode slot HELD by an in-flight send does not mark it delivered (review 3)", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  const page = pageRecorder();
  const keys = [];
  const pageImpl = async (text, opts = {}) => { keys.push(opts.key); return page.pageImpl(text, opts); };
  const deps = { probeImpl: writeDownProbe, kvImpl: kv, notifyImpl: notify, healthOwnsSession: () => true, pageImpl };
  page.setOk(false);
  await runAuthProbeTick({ now: NOW }, deps); // opens; the send fails, the slot is released
  assert.equal(JSON.parse(kv.store.get(AUTH_FLAG_KEY)).alert.delivered, false);
  // Tick A (cron) claims the episode slot and is still sending when tick B (Fly) runs.
  const key = keys[0];
  assert.match(key, /^paraform-auth-write-open:/);
  page.slots.add(key);
  const before = JSON.parse(kv.store.get(AUTH_FLAG_KEY)).alert;
  const b = await runAuthProbeTick({ now: NOW + 5 * 60_000 }, deps);
  assert.equal(b.alertDelivered, false, "a held slot is not a delivery");
  assert.equal(b.alertPending, true);
  assert.deepEqual(JSON.parse(kv.store.get(AUTH_FLAG_KEY)).alert, before, "B leaves record.alert for A to write");
  // A's send fails: pageNotify releases the slot and A records delivered:false.
  page.slots.delete(key);
  page.setOk(true);
  const c = await runAuthProbeTick({ now: NOW + 10 * 60_000 }, deps);
  assert.equal(c.alertDelivered, true, "the next tick still retries and lands it");
  assert.equal(page.pages.length, 1);
  assert.equal(JSON.parse(kv.store.get(AUTH_FLAG_KEY)).alert.delivered, true);
});

test("#notify switch flipped mid-episode: a write-layer outage posted to the legacy channel reaches #notify once", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  const page = pageRecorder();
  const off = { probeImpl: writeDownProbe, kvImpl: kv, notifyImpl: notify, healthOwnsSession: () => false, pageImpl: page.pageImpl };
  const opened = await runAuthProbeTick({ now: NOW }, off);
  assert.equal(opened.alertDelivered, true);
  assert.equal(notify.messages.length, 1, "switch off: the legacy post, as before");
  assert.equal(page.pages.length, 0);
  const on = { ...off, healthOwnsSession: () => true };
  const flipped = await runAuthProbeTick({ now: NOW + 3600_000 }, on);
  assert.equal(flipped.alertRetried, true);
  assert.equal(page.pages.length, 1);
  await runAuthProbeTick({ now: NOW + 2 * 3600_000 }, on);
  assert.equal(page.pages.length, 1, "once, not every tick");
});

test("#notify switch on: a READ-layer episode never takes the write-layer retry (the tile owns it)", async () => {
  const kv = fakeKv();
  const notify = notifyRecorder(true);
  const page = pageRecorder();
  const deps = { probeImpl: downProbe, kvImpl: kv, notifyImpl: notify, healthOwnsSession: () => true, pageImpl: page.pageImpl };
  await runAuthProbeTick({ now: NOW }, deps);
  const opened = await runAuthProbeTick({ now: NOW + CONFIRMATION_MS }, deps);
  assert.equal(opened.opened, true);
  assert.equal(JSON.parse(kv.store.get(AUTH_FLAG_KEY)).alert.layer, "read");
  // A mutation 401 later joins the same (read-layer) episode.
  const joined = await runAuthProbeTick({ now: NOW + CONFIRMATION_MS + 600_000 }, { ...deps, probeImpl: writeDownProbe });
  assert.equal(joined.alertRetried, undefined);
  assert.equal(page.pages.length, 0);
  assert.deepEqual(notify.messages, []);
});

// PR 230 review rounds 4 and 5: the write-layer page key comes from the atomic
// open slot. The real pageNotify runs over a KV fake that honours EX against
// a test clock: the claim is short (it covers one in-flight send), and only a
// landed page becomes a "delivered:" slot that lives (and is refreshed) as
// long as the episode.
function ttlKv(clock, seed = {}) {
  const inner = fakeKv(seed);
  const expiry = new Map();
  const lapse = (key) => {
    const at = expiry.get(key);
    if (at != null && at <= clock.now) { inner.store.delete(key); expiry.delete(key); }
  };
  const impl = async (args) => {
    const [command, key, ...rest] = args;
    if (clock.failDel && command === "DEL" && String(key).startsWith("notify:")) {
      clock.failDel = false;
      throw new Error("KV_HTTP_503");
    }
    if (key != null) lapse(key);
    const result = await inner(args);
    if (command === "SET" && result === "OK") {
      const flags = rest.slice(1).map((v) => String(v).toUpperCase());
      const ex = flags.indexOf("EX");
      if (ex >= 0) expiry.set(key, clock.now + Number(flags[ex + 1]) * 1000);
      else expiry.delete(key);
    }
    if (command === "DEL") expiry.delete(key);
    return result;
  };
  impl.store = inner.store;
  impl.calls = inner.calls;
  impl.expiry = expiry;
  return impl;
}

// The real pageNotify, switch on, over `kv`. clock.gate holds a send open,
// clock.hang never finishes it (the function was killed mid-send), and
// clock.sendOk=false makes Slack refuse it.
function ttlPageRecorder(clock, kv) {
  const pages = [];
  const env = { NOTIFY_SLACK_CHANNEL: "C_NOTIFY", HEALTH_ALERTS_ENABLED: "true" };
  const recorder = { pages, inFlight: 0 };
  recorder.pageImpl = (text, opts = {}) => pageNotify(text, {
    ...opts,
    env,
    kv: (command) => kv(command),
    notifySend: async (t) => {
      recorder.inFlight += 1;
      if (clock.hang) return new Promise(() => {});
      if (clock.gate) await clock.gate;
      if (clock.sendOk === false) return false;
      pages.push({ text: t, key: opts.key });
      return true;
    },
  });
  return recorder;
}

test("R4 refuter B: two overlapping FIRST ticks of one write-layer outage page #notify once", async () => {
  const clock = { now: NOW };
  const kv = ttlKv(clock);
  const page = ttlPageRecorder(clock, kv);
  const deps = { probeImpl: writeDownProbe, kvImpl: kv, notifyImpl: notifyRecorder(true), healthOwnsSession: () => true, pageImpl: page.pageImpl };
  await Promise.all([
    runAuthProbeTick({ now: NOW }, deps),
    runAuthProbeTick({ now: NOW + 40 }, deps),
  ]);
  assert.equal(page.pages.length, 1, `pages: ${JSON.stringify(page.pages.map((p) => p.key))}`);
  assert.equal(page.pages[0].key, `paraform-auth-write-open:${kv.store.get(AUTH_OPEN_ALERT_KEY)}`, "keyed on the open slot");
});

test("R4 refuter C: a lost delivered record never re-pages the episode, even past 24 h", async () => {
  const clock = { now: NOW };
  const kv = ttlKv(clock);
  const page = ttlPageRecorder(clock, kv);
  let releaseA; clock.gate = new Promise((r) => { releaseA = r; });
  const depsA = { probeImpl: writeDownProbe, kvImpl: kv, notifyImpl: notifyRecorder(true), healthOwnsSession: () => true, pageImpl: page.pageImpl };
  const a = runAuthProbeTick({ now: NOW }, depsA);
  while (!page.inFlight) await new Promise((r) => setImmediate(r)); // A is mid-send
  // Tick B read the flag during A's send; its top-of-tick flag SET lands after A's record.
  let releaseB; const bGate = new Promise((r) => { releaseB = r; });
  const kvB = async (args) => {
    if (args[0] === "SET" && args[1] === AUTH_FLAG_KEY) await bGate;
    return kv(args);
  };
  const b = runAuthProbeTick({ now: NOW + 1000 }, { ...depsA, kvImpl: kvB });
  await new Promise((r) => setTimeout(r, 10));
  clock.gate = null; releaseA(); await a;
  assert.equal(JSON.parse(kv.store.get(AUTH_FLAG_KEY)).alert.delivered, true, "A recorded its delivery");
  releaseB(); await b;
  assert.equal(page.pages.length, 1);
  // The outage stays down over a weekend: ticks every 5 min for 25 h.
  for (let t = 5; t <= 25 * 60; t += 5) {
    clock.now = NOW + t * 60_000;
    await runAuthProbeTick({ now: clock.now }, depsA);
  }
  assert.equal(page.pages.length, 1, `episode paged ${page.pages.length} times`);
  // Review 5 minor: the delivered slot restores the lost record.
  assert.equal(JSON.parse(kv.store.get(AUTH_FLAG_KEY)).alert.delivered, true, "the ops endpoint shows the page landed");
});

test("R4/R5: the write-layer claim is short, a landed page becomes a 30 d delivered slot refreshed each tick", async () => {
  const clock = { now: NOW };
  const kv = ttlKv(clock);
  const page = ttlPageRecorder(clock, kv);
  const deps = { probeImpl: writeDownProbe, kvImpl: kv, notifyImpl: notifyRecorder(true), healthOwnsSession: () => true, pageImpl: page.pageImpl };
  await runAuthProbeTick({ now: NOW }, deps);
  const slot = notifySlotKey(`paraform-auth-write-open:${kv.store.get(AUTH_OPEN_ALERT_KEY)}`);
  const thirtyDays = String(30 * 24 * 60 * 60);
  const claim = kv.calls.find((c) => c[0] === "SET" && c[1] === slot && c.includes("NX"));
  assert.equal(claim[claim.indexOf("EX") + 1], String(15 * 60), "the in-flight claim covers one send");
  assert.match(kv.store.get(slot), /^delivered:/, "a landed page marks the slot delivered");
  assert.equal(kv.expiry.get(slot), NOW + 30 * 24 * 3600_000, "delivered for 30 d");
  // Lose the delivered record; a day later the slot is still there, is
  // refreshed with the open slot, and restores the record without a send.
  const flag = JSON.parse(kv.store.get(AUTH_FLAG_KEY));
  kv.store.set(AUTH_FLAG_KEY, JSON.stringify({ ...flag, alert: null }));
  clock.now = NOW + 26 * 3600_000;
  const later = await runAuthProbeTick({ now: clock.now }, deps);
  assert.equal(later.alertDelivered, true);
  const refresh = kv.calls.find((c) => c[0] === "SET" && c[1] === slot && c.includes("XX"));
  assert.ok(refresh, "the page slot is refreshed with the open slot");
  assert.equal(refresh[refresh.indexOf("EX") + 1], thirtyDays);
  assert.equal(page.pages.length, 1, "one #notify post for the episode");
});

test("R4: a new write-layer episode after a close pages again under its own key", async () => {
  const clock = { now: NOW };
  const kv = ttlKv(clock);
  const page = ttlPageRecorder(clock, kv);
  const deps = { probeImpl: writeDownProbe, kvImpl: kv, notifyImpl: notifyRecorder(true), healthOwnsSession: () => true, pageImpl: page.pageImpl };
  await runAuthProbeTick({ now: NOW }, deps);
  assert.equal(page.pages.length, 1);
  // A later mutation succeeded (no write latch here), so a green read closes it.
  clock.now = NOW + 3600_000 + 1000;
  const closed = await runAuthProbeTick({ now: clock.now }, { ...deps, probeImpl: greenProbe });
  assert.equal(closed.resumed, true);
  clock.now = NOW + 2 * 3600_000;
  await runAuthProbeTick({ now: clock.now }, deps);
  assert.equal(page.pages.length, 2, "the next outage is a new incident");
  assert.notEqual(page.pages[0].key, page.pages[1].key);
});

// Review 5 refuters: an orphaned in-flight claim must delay the page, never
// lose it. Ticks every 5 min for 25 h; the page lands once, within minutes.
async function tickFor(clock, deps, fromMin, toMin) {
  for (let t = fromMin; t <= toMin; t += 5) {
    clock.now = NOW + t * 60_000;
    await runAuthProbeTick({ now: clock.now }, deps);
  }
}

test("R5-A: a function killed mid-send orphans the claim; a later tick still pages, once", async () => {
  const clock = { now: NOW, hang: true };
  const kv = ttlKv(clock);
  const page = ttlPageRecorder(clock, kv);
  const deps = { probeImpl: writeDownProbe, kvImpl: kv, notifyImpl: notifyRecorder(true), healthOwnsSession: () => true, pageImpl: page.pageImpl };
  void runAuthProbeTick({ now: NOW }, deps); // opens, claims, then dies inside sendSlack
  while (!page.inFlight) await new Promise((r) => setImmediate(r));
  clock.hang = false;
  await tickFor(clock, deps, 5, 30);
  assert.equal(page.pages.length, 1, "the orphaned claim lapsed and the retry paged");
  assert.equal(JSON.parse(kv.store.get(AUTH_FLAG_KEY)).alert.delivered, true);
  await tickFor(clock, deps, 35, 25 * 60);
  assert.equal(page.pages.length, 1, "and never again this episode");
});

test("R5-B: a failed send whose slot release hits a KV blip still pages on a later tick, once", async () => {
  const clock = { now: NOW, sendOk: false, failDel: true };
  const kv = ttlKv(clock);
  const page = ttlPageRecorder(clock, kv);
  const deps = { probeImpl: writeDownProbe, kvImpl: kv, notifyImpl: notifyRecorder(true), healthOwnsSession: () => true, pageImpl: page.pageImpl };
  const opened = await runAuthProbeTick({ now: NOW }, deps);
  assert.equal(opened.alertDelivered, false);
  assert.equal(clock.failDel, false, "the release DEL failed");
  clock.sendOk = true;
  await tickFor(clock, deps, 5, 30);
  assert.equal(page.pages.length, 1, "the orphaned claim lapsed and the retry paged");
  await tickFor(clock, deps, 35, 25 * 60);
  assert.equal(page.pages.length, 1, "and never again this episode");
});
