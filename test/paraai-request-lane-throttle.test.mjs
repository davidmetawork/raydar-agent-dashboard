import test from "node:test";
import assert from "node:assert/strict";

// The Para AI interview-request lanes' self-throttle (2026-09-26 incident):
// every worker tick used to die at its first Paraform read and then run the
// shared adapter's 1+3 throttle retries plus a 3x2 expiry-confirmation
// ladder, all 401, sending nothing. These tests pin the fix: a first
// 429/401 arms a shared, persisted cooldown with NO further Paraform calls
// (this tick or the next), the identity check is the only thing that may
// call it auth_expired, and the two lanes still answer to the existing
// `paraaiRequestLanes` brake untouched.
//
// Both KV state and "Paraform" itself are faked behind one fetch mock. Any
// request to any other origin fails the test: no real network IO may occur.
const KV_URL = "https://kv.request-lane-throttle.test";
const PARAFORM_BASE = "https://www.paraform.com/api";
process.env.KV_REST_API_URL = KV_URL;
process.env.KV_REST_API_TOKEN = "kv-test-token";
process.env.PARAAI_OUTREACH_KV_REST_API_URL = KV_URL;
process.env.PARAAI_OUTREACH_KV_REST_API_TOKEN = "kv-test-token";
process.env.PARAFORM_SESSION_COOKIE = "Fe26.2*test-session*";
process.env.PARAAI_AUTOMATION_RUNNER_KEY = "runner-test-secret";

let kv = new Map();
let zsets = new Map();
let paraformQueue = [];
let paraformFetchCount = 0;
let kvFetchCount = 0;

function resetFakes() {
  kv = new Map();
  zsets = new Map();
  paraformQueue = [];
  paraformFetchCount = 0;
  kvFetchCount = 0;
}

function evalScript([script, keyCount, ...rest]) {
  const keys = rest.slice(0, Number(keyCount));
  const args = rest.slice(Number(keyCount));
  if (script.includes("redis.call('GET', KEYS[1]) == ARGV[1]")) {
    if (kv.get(keys[0]) === args[0]) { kv.delete(keys[0]); return 1; }
    return 0;
  }
  throw new Error(`unexpected EVAL in test: ${script.slice(0, 60)}`);
}

function command([name, ...args]) {
  switch (String(name).toUpperCase()) {
    case "GET": return kv.get(args[0]) ?? null;
    case "SET": {
      const [key, value, ...options] = args;
      if (options.includes("NX") && kv.has(key)) return null;
      kv.set(key, value);
      return "OK";
    }
    case "DEL": return kv.delete(args[0]) ? 1 : 0;
    case "INCR": {
      const next = (Number(kv.get(args[0])) || 0) + 1;
      kv.set(args[0], String(next));
      return next;
    }
    case "EXPIRE": return kv.has(args[0]) ? 1 : 0;
    case "ZREVRANGE": return [...(zsets.get(args[0]) || [])].reverse();
    case "EVAL": return evalScript(args);
    default: throw new Error(`unexpected KV command in test: ${name}`);
  }
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

// Queue of { status, body, headers } consumed in order by the next Paraform
// call; defaults to an ordinary empty 200 once the queue runs dry so a test
// that stops caring about further calls does not crash on one.
function queueParaform(entry) { paraformQueue.push(entry); }

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith(KV_URL)) {
    kvFetchCount += 1;
    const body = JSON.parse(init.body || "null");
    const result = href.endsWith("/pipeline")
      ? body.map((item) => ({ result: command(item) }))
      : { result: command(body) };
    return jsonResponse(200, result);
  }
  if (href.startsWith(PARAFORM_BASE)) {
    paraformFetchCount += 1;
    const next = paraformQueue.shift() || {
      status: 200,
      body: { result: { data: { json: {} } } },
    };
    return jsonResponse(next.status, next.body, next.headers || {});
  }
  throw new Error(`unexpected fetch in test: ${href}`);
};

const {
  MIN_COOLDOWN_SECONDS,
  REQUEST_LANE_COOLDOWN_CODE,
  REQUEST_LANE_RATE_LIMITED_CODE,
  acquireRequestLaneCadenceSlot,
  admitRequestLaneRate,
  armRequestLaneCooldown,
  boundRequestLaneTrpc,
  clearRequestLaneCooldown,
  parseRetryAfterSeconds,
  recordRequestLaneRequest,
  requestLaneAuthStatus,
  requestLaneCadenceSeconds,
  requestLaneCooldownStatus,
  requestLaneCounters,
  requestLaneIdentityCheckDue,
  requestLaneRatePerMinute,
  requestLaneTrpcGet,
  requestLaneTrpcPost,
} = await import("../api/paraai/_lib/request-lane-throttle.mjs");
const { canonicalBackgroundPauseRecord, PARAFORM_BACKGROUND_PAUSE_KEYS } =
  await import("../api/_lib/paraform-background-pause.mjs");
const { outreachConfig, runOutreachTick, outreachHealth } = await import("../api/paraai/_lib/outreach.mjs");
const { runExpiredTick } = await import("../api/paraai/_lib/expired.mjs");

const openOutreachConfig = () => ({
  ...outreachConfig({}),
  approved: true,
  sendApproved: true,
  dryRun: false,
  notBeforeMs: Date.parse("2026-07-18T17:00:00.000Z"),
  gmailConfigured: true,
  storeConfigured: true,
  mailbox: "david@raydar.xyz",
});

test.beforeEach(() => resetFakes());

// ── cooldown ────────────────────────────────────────────────────────────
test("no cooldown recorded reads as inactive", async () => {
  const status = await requestLaneCooldownStatus();
  assert.equal(status.active, false);
  assert.equal(status.untilMs, null);
});

test("arming persists a cooldown other callers observe, with a 60s floor", async () => {
  const now = Date.parse("2026-09-26T22:00:00.000Z");
  await armRequestLaneCooldown({ seconds: 5, reason: "401", source: "outreach", now });
  const status = await requestLaneCooldownStatus({ now: now + 1000 });
  assert.equal(status.active, true);
  assert.equal(status.reason, "401");
  assert.equal(status.source, "outreach");
  assert.equal(status.untilMs, now + MIN_COOLDOWN_SECONDS * 1000);
});

test("a longer Retry-After is honoured", async () => {
  const now = Date.parse("2026-09-26T22:00:00.000Z");
  await armRequestLaneCooldown({ seconds: 300, reason: "429", now });
  const status = await requestLaneCooldownStatus({ now: now + 1000 });
  assert.equal(status.untilMs, now + 300 * 1000);
});

test("a cooldown expires on its own and clearRequestLaneCooldown removes it early", async () => {
  const now = Date.parse("2026-09-26T22:00:00.000Z");
  await armRequestLaneCooldown({ seconds: 60, now });
  assert.equal((await requestLaneCooldownStatus({ now: now + 61_000 })).active, false);
  await armRequestLaneCooldown({ seconds: 60, now });
  await clearRequestLaneCooldown();
  assert.equal((await requestLaneCooldownStatus({ now: now + 1000 })).active, false);
});

test("cooldown status fails CLOSED (assume active), not open, on a KV read error (2026-09-26 review)", async () => {
  const now = Date.parse("2026-09-26T22:00:00.000Z");
  const throwingKv = async () => { throw new Error("kv unreachable"); };
  const status = await requestLaneCooldownStatus({ now, kvImpl: throwingKv });
  assert.equal(status.active, true, "an unreadable cooldown key must never be read as permission to call Paraform");
  assert.equal(status.reason, "kv_read_error");
  assert.ok(status.untilMs > now);
});

test("the pace check keeps failing CLOSED (throws) on the same kind of KV error, matching the cooldown check's direction", async () => {
  const throwingKv = async () => { throw new Error("kv unreachable"); };
  await assert.rejects(admitRequestLaneRate({ kvImpl: throwingKv }));
});

test("parseRetryAfterSeconds reads delta-seconds and HTTP-dates", () => {
  const now = Date.parse("2026-09-26T22:00:00.000Z");
  assert.equal(parseRetryAfterSeconds("30", { now }), 30);
  assert.equal(parseRetryAfterSeconds(null, { now }), null);
  assert.equal(parseRetryAfterSeconds("", { now }), null);
  const future = new Date(now + 45_000).toUTCString();
  assert.equal(parseRetryAfterSeconds(future, { now }), 45);
});

// ── cadence ─────────────────────────────────────────────────────────────
test("cadence admits once per window per lane, and lanes do not share a slot", async () => {
  const now = Date.parse("2026-09-26T22:00:00.000Z");
  assert.equal(await acquireRequestLaneCadenceSlot({ lane: "outreach", cadenceSeconds: 120, now }), true);
  assert.equal(await acquireRequestLaneCadenceSlot({ lane: "outreach", cadenceSeconds: 120, now: now + 1000 }), false);
  // The expired lane's own cadence gate is a separate key.
  assert.equal(await acquireRequestLaneCadenceSlot({ lane: "expired", cadenceSeconds: 120, now: now + 1000 }), true);
});

test("cadence seconds default to 120 and clamp to [60, 300]", () => {
  assert.equal(requestLaneCadenceSeconds({}), 120);
  assert.equal(requestLaneCadenceSeconds({ PARAAI_REQUEST_LANE_CADENCE_SECONDS: "30" }), 60);
  assert.equal(requestLaneCadenceSeconds({ PARAAI_REQUEST_LANE_CADENCE_SECONDS: "600" }), 300);
  assert.equal(requestLaneCadenceSeconds({ PARAAI_REQUEST_LANE_CADENCE_SECONDS: "180" }), 180);
});

// ── rate pacing ───────────────────────────────────────────────────────────
test("the combined pace never admits more than 10 a minute, and never above 10 by env override", async () => {
  const now = Date.parse("2026-09-26T22:00:30.000Z");
  assert.equal(requestLaneRatePerMinute({ PARAAI_REQUEST_LANE_RATE_PER_MIN: "1000" }), 10);
  const admits = [];
  for (let i = 0; i < 12; i += 1) admits.push(await admitRequestLaneRate({ now }));
  assert.equal(admits.filter(Boolean).length, 10);
  assert.deepEqual(admits.slice(10), [false, false]);
  // A new minute bucket resets the pace.
  assert.equal(await admitRequestLaneRate({ now: now + 60_000 }), true);
});

// ── durable counters ──────────────────────────────────────────────────────
test("counters are durable per lane and per kind", async () => {
  const now = Date.parse("2026-09-26T22:00:00.000Z");
  await recordRequestLaneRequest({ lane: "outreach", kind: "status", now });
  await recordRequestLaneRequest({ lane: "outreach", kind: "status", now });
  await recordRequestLaneRequest({ lane: "outreach", kind: "job", now });
  await recordRequestLaneRequest({ lane: "expired", kind: "job", now });
  const counters = await requestLaneCounters({ now });
  assert.deepEqual(counters.byLane.outreach, { job: 1, status: 2 });
  assert.deepEqual(counters.byLane.expired, { job: 1, status: 0 });
  assert.equal(counters.total, 4);
});

// ── the single call path ──────────────────────────────────────────────────
test("a 401 arms the cooldown after exactly one Paraform call, no retry", async () => {
  queueParaform({ status: 401, body: {} });
  await assert.rejects(
    requestLaneTrpcGet("user.getCurrentUser", {}, { lane: "outreach" }),
    (error) => error.code === REQUEST_LANE_COOLDOWN_CODE,
  );
  assert.equal(paraformFetchCount, 1, "no in-tick retry and no expiry ladder");
  const status = await requestLaneCooldownStatus();
  assert.equal(status.active, true);
  assert.equal(status.reason, "401");
  assert.equal(status.source, "outreach");
});

test("a 429 with Retry-After arms a cooldown for that long, floored at 60s", async () => {
  const before = Date.now();
  queueParaform({ status: 429, body: {}, headers: { "retry-after": "180" } });
  await assert.rejects(
    requestLaneTrpcPost("submissionRequest.markReachedOutToCandidate", { id: "r1" }, { lane: "outreach" }),
    (error) => error.code === REQUEST_LANE_COOLDOWN_CODE,
  );
  const status = await requestLaneCooldownStatus();
  assert.equal(status.active, true);
  assert.equal(status.reason, "429");
  assert.ok(status.untilMs - before >= 179_000);
});

test("once the cooldown is armed, every further call is blocked before it reaches Paraform", async () => {
  queueParaform({ status: 401, body: {} });
  await assert.rejects(requestLaneTrpcGet("user.getCurrentUser", {}, { lane: "outreach" }));
  assert.equal(paraformFetchCount, 1);
  // Three more calls, including from the OTHER lane: none reach Paraform.
  await assert.rejects(
    requestLaneTrpcGet("submissionRequest.getRecruiterSubmissionRequestHistory", {}, { lane: "outreach" }),
    (error) => error.code === REQUEST_LANE_COOLDOWN_CODE,
  );
  await assert.rejects(
    requestLaneTrpcGet("submissionRequest.getRecruiterParaAIStatus", {}, { lane: "expired" }),
    (error) => error.code === REQUEST_LANE_COOLDOWN_CODE,
  );
  await assert.rejects(
    requestLaneTrpcPost("submissionRequest.dismissSubmissionRequest", { id: "r2" }, { lane: "expired" }),
    (error) => error.code === REQUEST_LANE_COOLDOWN_CODE,
  );
  assert.equal(paraformFetchCount, 1, "the cooldown blocks every later call, both lanes, with zero further Paraform IO");
});

test("a successful call never arms a cooldown and returns the vendor payload", async () => {
  queueParaform({ status: 200, body: { result: { data: { json: { ok: true } } } } });
  const result = await requestLaneTrpcGet("user.getCurrentUser", {}, { lane: "outreach" });
  assert.deepEqual(result, { ok: true });
  assert.equal((await requestLaneCooldownStatus()).active, false);
});

test("a non-throttle vendor error is not treated as a cooldown signal", async () => {
  queueParaform({ status: 500, body: { message: "vendor down" } });
  await assert.rejects(
    requestLaneTrpcGet("user.getCurrentUser", {}, { lane: "outreach" }),
    (error) => error.code !== REQUEST_LANE_COOLDOWN_CODE,
  );
  assert.equal((await requestLaneCooldownStatus()).active, false);
});

test("the shared pace cap stops the 11th call of the minute without any cooldown", async () => {
  for (let i = 0; i < 10; i += 1) {
    queueParaform({ status: 200, body: { result: { data: { json: {} } } } });
  }
  for (let i = 0; i < 10; i += 1) {
    await requestLaneTrpcGet("user.getCurrentUser", {}, { lane: "outreach" });
  }
  await assert.rejects(
    requestLaneTrpcGet("user.getCurrentUser", {}, { lane: "expired" }),
    (error) => error.code === REQUEST_LANE_RATE_LIMITED_CODE,
  );
  assert.equal(paraformFetchCount, 10, "the 11th call is refused before it is ever sent");
  assert.equal((await requestLaneCooldownStatus()).active, false, "self-pacing is not a vendor-confirmed throttle");
});

// ── cross-lane mutex (2026-09-26 review finding) ─────────────────────────
// Without this, two overlapping worker invocations (e.g. a cron tick plus a
// manual "run now") could each pass the cooldown check before either one's
// first Paraform call had failed: invocation A's outreach tick mid-flight on
// its first read, invocation B unable to get A's poll lock so falling
// through into the expired lane, checks the still-inactive cooldown, and
// fires its own first read concurrently with A's — both hit Paraform and
// both 401 before either could arm the cooldown. These tests pin that this
// can no longer happen: at most one of two concurrent "first calls" ever
// reaches Paraform.
test("cross-lane mutex: a mutex already held by another invocation blocks the call before it ever reaches Paraform, without arming a false cooldown", async () => {
  // Simulate an overlapping invocation's laneCall already inside its own
  // critical section — the exact window the 429/401 hasn't resolved in yet.
  kv.set("paraai:request-lanes:cross-lane-mutex", "v1:some-other-invocation");
  await assert.rejects(
    requestLaneTrpcGet("user.getCurrentUser", {}, { lane: "outreach" }),
    (error) => error.code === REQUEST_LANE_COOLDOWN_CODE && /cross_lane_busy/.test(error.message),
  );
  assert.equal(paraformFetchCount, 0, "blocked before it ever reached Paraform");
  assert.equal(
    (await requestLaneCooldownStatus()).active,
    false,
    "a busy mutex is a transient block, not a vendor-confirmed throttle — it must not arm the real cooldown",
  );
});

test("cross-lane mutex: two overlapping first calls (one per lane, simulating two overlapping worker invocations) never both reach Paraform", async () => {
  // Both queued 401s exist only so the SECOND call would also fail vendor-side
  // if it ever reached Paraform; the assertion below is that it never does.
  queueParaform({ status: 401, body: {} });
  queueParaform({ status: 401, body: {} });
  const [outreachResult, expiredResult] = await Promise.allSettled([
    requestLaneTrpcGet("submissionRequest.getRecruiterSubmissionRequestHistory", {}, { lane: "outreach" }),
    requestLaneTrpcGet("submissionRequest.getRecruiterParaAIStatus", {}, { lane: "expired" }),
  ]);
  assert.equal(outreachResult.status, "rejected");
  assert.equal(expiredResult.status, "rejected");
  assert.equal(outreachResult.reason.code, REQUEST_LANE_COOLDOWN_CODE);
  assert.equal(expiredResult.reason.code, REQUEST_LANE_COOLDOWN_CODE);
  assert.equal(
    paraformFetchCount,
    1,
    "the mutex serializes the two concurrent first calls, so only one of them ever reaches Paraform — the other queues behind the mutex and then sees the cooldown the first one just armed",
  );
  const status = await requestLaneCooldownStatus();
  assert.equal(status.active, true);
  assert.equal(status.reason, "401");
});

test("cross-lane mutex: released after a successful call, so the next call is never blocked by a stale lock", async () => {
  queueParaform({ status: 200, body: { result: { data: { json: { ok: true } } } } });
  await requestLaneTrpcGet("user.getCurrentUser", {}, { lane: "outreach" });
  queueParaform({ status: 200, body: { result: { data: { json: { ok: true } } } } });
  const result = await requestLaneTrpcGet("user.getCurrentUser", {}, { lane: "expired" });
  assert.deepEqual(result, { ok: true });
  assert.equal(paraformFetchCount, 2);
});

test("boundRequestLaneTrpc is a drop-in trpcGet/trpcPost pair, extra legacy args are harmless", async () => {
  queueParaform({ status: 200, body: { result: { data: { json: { hello: "world" } } } } });
  const { trpcGet } = boundRequestLaneTrpc("outreach");
  // The historical call sites pass a third "tries" argument; it must be
  // silently ignored (this module always makes exactly one attempt).
  const result = await trpcGet("user.getCurrentUser", {}, 1);
  assert.deepEqual(result, { hello: "world" });
  const counters = await requestLaneCounters();
  assert.equal(counters.byLane.outreach.status, 1, "trpcGet is counted as a status read");
});

// ── identity check ────────────────────────────────────────────────────────
test("the identity check is due immediately and then not again for 10 minutes", async () => {
  const now = Date.parse("2026-09-26T22:00:00.000Z");
  assert.equal(await requestLaneIdentityCheckDue({ now }), true);
  await requestLaneAuthStatus({ now, readImpl: async () => ({}) });
  assert.equal(await requestLaneIdentityCheckDue({ now: now + 5 * 60_000 }), false);
  assert.equal(await requestLaneIdentityCheckDue({ now: now + 10 * 60_000 }), true);
});

test("identity check: a real 401 reports auth_expired through the given reporter, at most once per window", async () => {
  const reports = [];
  const now = Date.parse("2026-09-26T22:00:00.000Z");
  const result = await requestLaneAuthStatus({
    now,
    readImpl: async () => { const e = new Error("x"); e.code = "PARAFORM_THROTTLED"; throw e; },
    reportFailureImpl: async (args) => { reports.push(args); },
  });
  assert.equal(result.checked, true);
  assert.equal(result.authExpired, true);
  assert.deepEqual(reports, [{ lane: "paraai_request_lanes", stage: "identity_check" }]);
  // Not due yet: a second call in the same window never re-reports.
  await requestLaneAuthStatus({ now: now + 60_000, readImpl: async () => { throw new Error("should not run"); }, reportFailureImpl: async (args) => reports.push(args) });
  assert.equal(reports.length, 1);
});

test("identity check: a clean read proves throttling, not expiry, and reports nothing", async () => {
  const reports = [];
  const result = await requestLaneAuthStatus({
    now: Date.parse("2026-09-26T22:00:00.000Z"),
    readImpl: async () => ({ id: "me" }),
    reportFailureImpl: async (args) => reports.push(args),
  });
  assert.equal(result.authExpired, false);
  assert.deepEqual(reports, []);
});

test("identity check: a non-401 failure (transport/5xx) fails open and reports nothing", async () => {
  const reports = [];
  const result = await requestLaneAuthStatus({
    now: Date.parse("2026-09-26T22:00:00.000Z"),
    readImpl: async () => { const e = new Error("x"); e.code = "HTTP_500"; throw e; },
    reportFailureImpl: async (args) => reports.push(args),
  });
  assert.equal(result.authExpired, false);
  assert.equal(result.inconclusive, true);
  assert.deepEqual(reports, []);
});

// ── the existing operator brake is untouched ─────────────────────────────
test("the paraaiRequestLanes background-pause brake still parses independently of this module", () => {
  const raw = canonicalBackgroundPauseRecord("paraai-request-lanes-selfthrottle-20260926");
  assert.equal(PARAFORM_BACKGROUND_PAUSE_KEYS.paraaiRequestLanes, "ops:paraform-background-pause:v1:paraai-request-lanes");
  assert.ok(raw.includes("paraai-request-lanes-selfthrottle-20260926"));
});

// ── wired into the two lanes end to end ──────────────────────────────────
test("runOutreachTick: a 401 on the very first Paraform read stops the tick cleanly; the very next tick's only further Paraform IO is the rate-limited identity check, never a retry of the lane's own work", async () => {
  queueParaform({ status: 401, body: {} });
  const first = await runOutreachTick({
    config: openOutreachConfig(),
    now: Date.parse("2026-09-26T22:00:00.000Z"),
    pauseState: async () => ({ paused: false }),
  });
  assert.equal(first.reason, "request_lane_cooldown");
  assert.equal(first.processed, 0);
  assert.equal(paraformFetchCount, 1, "exactly one read, no 1+3 retry ladder, no 3x2 expiry confirmation");

  // The very next tick (a fresh call, as the 5s Fly poller would make it)
  // still must not retry the lane's OWN work — its one extra fetch is the
  // rate-limited identity check earning its "at most once per 10 min" shot at
  // proving throttling vs. a dead session, not a second lane attempt.
  const second = await runOutreachTick({
    config: openOutreachConfig(),
    now: Date.parse("2026-09-26T22:00:05.000Z"),
    pauseState: async () => ({ paused: false }),
  });
  assert.equal(second.reason, "request_lane_cooldown");
  assert.equal(paraformFetchCount, 2, "one lane read + one identity check, not a retry of the lane's own history read");

  // A THIRD tick, still inside both the cooldown and the identity check's
  // 10-minute window, must not fetch again at all.
  const third = await runOutreachTick({
    config: openOutreachConfig(),
    now: Date.parse("2026-09-26T22:00:10.000Z"),
    pauseState: async () => ({ paused: false }),
  });
  assert.equal(third.reason, "request_lane_cooldown");
  assert.equal(paraformFetchCount, 2, "the identity check itself is rate-limited to at most once per 10 minutes");
});

test("runExpiredTick: a 401 on its first read stops the tick cleanly and is not reported as an error", async () => {
  queueParaform({ status: 401, body: {} });
  const result = await runExpiredTick({
    mode: "organic",
    now: Date.parse("2026-09-26T22:00:00.000Z"),
    env: { PARAAI_EXPIRED_APPROVED: "true" },
    pauseState: async () => ({ paused: false }),
  });
  assert.equal(result.reason, "request_lane_cooldown");
  assert.equal(result.ran, false);
  assert.equal(result.errors, undefined, "a cooldown is never counted as an error");
  // readSubmissionRequestHistory and readParaAiStatus are now sequential, so
  // the first (queued) 401 stops the second from ever being attempted.
  assert.equal(paraformFetchCount, 1, "the two Paraform reads at tick start are sequential, not concurrent, so one 401 stops both");
});

test("the shared cooldown blocks BOTH lanes: an outreach 401 also stops the expired lane's next tick", async () => {
  queueParaform({ status: 401, body: {} });
  await runOutreachTick({
    config: openOutreachConfig(),
    now: Date.parse("2026-09-26T22:00:00.000Z"),
    pauseState: async () => ({ paused: false }),
  });
  assert.equal(paraformFetchCount, 1);
  const expired = await runExpiredTick({
    mode: "organic",
    now: Date.parse("2026-09-26T22:00:01.000Z"),
    env: { PARAAI_EXPIRED_APPROVED: "true" },
    pauseState: async () => ({ paused: false }),
  });
  assert.equal(expired.reason, "request_lane_cooldown");
  // The expired lane itself never touches Paraform; the one extra fetch here
  // is the shared identity check taking its single chance, triggered by
  // whichever lane next observes the cooldown.
  assert.equal(paraformFetchCount, 2, "the expired lane's own work never runs; the +1 is the shared identity check, not a lane retry");
});

test("runOutreachTick: the request lanes' Paraform work is cadence-gated, not run on every call", async () => {
  const history = [];
  const now = Date.parse("2026-09-26T22:00:00.000Z");
  const first = await runOutreachTick({
    config: openOutreachConfig(),
    now,
    pauseState: async () => ({ paused: false }),
    historyImpl: async () => history,
  });
  assert.equal(first.reason, undefined);
  assert.equal(first.enabled, true);
  const second = await runOutreachTick({
    config: openOutreachConfig(),
    now: now + 1000,
    pauseState: async () => ({ paused: false }),
    historyImpl: async () => { throw new Error("must not run again inside the same cadence window"); },
  });
  assert.equal(second.reason, "request_lane_cadence_not_due");
  assert.equal(second.processed, 0);
});

test("the existing paraaiRequestLanes brake still stops everything before this module is even consulted", async () => {
  const outreach = await runOutreachTick({
    config: openOutreachConfig(),
    pauseState: async () => ({ paused: true }),
  });
  assert.deepEqual(outreach, { enabled: true, processed: 0, reason: "request_lanes_paused" });
  const expired = await runExpiredTick({
    mode: "organic",
    env: { PARAAI_EXPIRED_APPROVED: "true" },
    pauseState: async () => ({ paused: true }),
  });
  assert.deepEqual(expired, { ok: true, ran: false, reason: "request_lanes_paused" });
  assert.equal(paraformFetchCount, 0);
  // pauseState is injected directly (as the real callers do it too — see
  // handleParaaiWorker), so the brake read itself makes no KV call here; the
  // point of this test is that NEITHER tick falls through to this module's
  // own cooldown/cadence KV reads once the brake says paused.
  assert.equal(kvFetchCount, 0, "the pause check short-circuits before this module reads any state");
});

test("outreachHealth exposes the cooldown and the durable per-lane counters", async () => {
  queueParaform({ status: 401, body: {} });
  await runOutreachTick({
    config: openOutreachConfig(),
    now: Date.parse("2026-09-26T22:00:00.000Z"),
    pauseState: async () => ({ paused: false }),
  });
  const health = await outreachHealth({ config: openOutreachConfig() });
  assert.equal(health.requestLaneThrottle.cooldown.active, true);
  assert.equal(health.requestLaneThrottle.cooldown.reason, "401");
  assert.ok(health.requestLaneThrottle.counters.byLane.outreach.status >= 1);
  assert.equal(health.requestLaneThrottle.cadenceSeconds, 120);
  assert.equal(health.requestLaneThrottle.ratePerMinute, 10);
});
