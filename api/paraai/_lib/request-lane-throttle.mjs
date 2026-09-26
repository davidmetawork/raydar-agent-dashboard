// Self-throttle for the two Para AI interview-request lanes (candidate
// outreach email + expired-match actioning). INCIDENT 2026-09-26: from
// ~21:58Z every worker tick died at its FIRST Paraform read and then ran the
// generic adapter's 1+3 throttle retries (600/1800/4500ms) plus, once those
// were exhausted, a 3x2 expiry-confirmation ladder (isParaformSessionActually
// Expired) — every one of those extra reads also 401'd, so the ladder
// concluded the session was dead when it was really just a burst, and kept
// re-arming itself into more refusals at ~2.9 ticks/min. That generic
// classifier (core.mjs's classifyThrottle) is shared by every OTHER Para AI
// lane too and stays untouched here; this module is a narrower, additive
// brake that ONLY the two request lanes route their Paraform calls through
// (see outreach.mjs / expired-actions.mjs).
//
// Contract, all of it durable/shared via KV — never per-process, so two
// overlapping invocations (Fly + a manual tick) still agree:
//   - COOLDOWN: the first 429 or 401 in a lane tick arms a shared cooldown of
//     max(Retry-After, 60s). While armed, neither lane makes another Paraform
//     call — not a retry of the same call, not the next item in a batch, not
//     the other lane's tick — until it expires.
//   - NO IN-TICK RETRIES, NO LADDER: every call this module makes is exactly
//     one attempt (`tries: 1` end to end). A 401 is never treated as proof of
//     a dead session by itself.
//   - IDENTITY CHECK: only `requestLaneAuthStatus` may turn a 401 into
//     `auth_expired` / the "login dead" page, and it is rate-limited to at
//     most once every 10 minutes, independent of the shared 5-minute
//     `auth-probe.mjs` cadence used everywhere else.
//   - CADENCE: the lanes' Paraform work is gated to a configurable 1-5 minute
//     window (default 2 min) per lane, instead of running on every 5s worker
//     tick. The worker keeps ticking fast for its non-Paraform bookkeeping;
//     only the Paraform-touching part of each lane waits for its slot.
//   - PACE: at most 10 Paraform requests/minute across BOTH lanes combined
//     (David's seat decision, 2026-09-26), enforced by refusing the call
//     itself (never sent) once the shared per-minute bucket is spent.
//   - COUNTERS: every attempted request (job or status) is counted durably,
//     per lane per day, and exposed by outreachHealth() for the health route.
import {
  requestLaneKv,
  requestLaneStoreConfigured,
} from "./request-lane-store.mjs";
import { trpcGetRaw, trpcPostRaw } from "./core.mjs";
import { reportParaformReadAuthFailure } from "./auth-probe.mjs";

export const REQUEST_LANE_COOLDOWN_CODE = "PARAFORM_REQUEST_LANES_COOLING_DOWN";
export const REQUEST_LANE_RATE_LIMITED_CODE = "PARAFORM_REQUEST_LANES_RATE_LIMITED";

const COOLDOWN_KEY = "paraai:request-lanes:cooldown";
const CADENCE_KEY_PREFIX = "paraai:request-lanes:cadence:";
const IDENTITY_CHECK_KEY = "paraai:request-lanes:identity-check-at";
const RATE_BUCKET_PREFIX = "paraai:request-lanes:rate-minute:";
const COUNTER_PREFIX = "paraai:request-lanes:count:";
const CROSS_LANE_MUTEX_KEY = "paraai:request-lanes:cross-lane-mutex";

export const MIN_COOLDOWN_SECONDS = 60;
const DEFAULT_RATE_PER_MINUTE = 10;
// David's seat decision, 2026-09-26: never exceed this regardless of an env
// override, so a bad config value can widen the pace but never blow past the
// agreed ceiling.
const MAX_RATE_PER_MINUTE = 10;
export const IDENTITY_CHECK_MIN_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_CADENCE_SECONDS = 120;
export const MIN_CADENCE_SECONDS = 60;
export const MAX_CADENCE_SECONDS = 300;
const RATE_BUCKET_TTL_SECONDS = 90;
const COUNTER_TTL_SECONDS = 3 * 24 * 60 * 60;
// Longer than core.mjs's own PARAAI_TRPC_TIMEOUT_MS (20s default), so the
// mutex always outlives the single call it guards even in the worst case,
// and short enough that a truly stuck call cannot wedge the lanes for long.
const CROSS_LANE_MUTEX_TTL_SECONDS = 30;
const CROSS_LANE_MUTEX_MAX_WAIT_MS = 400;
const CROSS_LANE_MUTEX_RETRY_MS = 40;

function cooldownError(untilMs, reason) {
  const error = new Error(
    `Para AI request lanes are cooling down after a Paraform ${reason || "throttle"} (until ${new Date(untilMs || Date.now()).toISOString()})`,
  );
  error.code = REQUEST_LANE_COOLDOWN_CODE;
  error.until = untilMs || null;
  return error;
}

function rateLimitedError() {
  const error = new Error(
    "Para AI request lanes hit their own per-minute Paraform pace cap (David's seat, 2026-09-26)",
  );
  error.code = REQUEST_LANE_RATE_LIMITED_CODE;
  return error;
}

export function requestLaneRatePerMinute(env = process.env) {
  const parsed = Number(env.PARAAI_REQUEST_LANE_RATE_PER_MIN);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(MAX_RATE_PER_MINUTE, Math.floor(parsed))
    : DEFAULT_RATE_PER_MINUTE;
}

export function requestLaneCadenceSeconds(env = process.env) {
  const parsed = Number(env.PARAAI_REQUEST_LANE_CADENCE_SECONDS);
  if (!Number.isFinite(parsed)) return DEFAULT_CADENCE_SECONDS;
  return Math.max(
    MIN_CADENCE_SECONDS,
    Math.min(MAX_CADENCE_SECONDS, Math.floor(parsed)),
  );
}

// Retry-After is either delta-seconds or an HTTP-date. Paraform's own 401s
// have never been observed to carry one, so this mostly exists for the day
// they add one, or for a real 429 from a fronting proxy.
export function parseRetryAfterSeconds(value, { now = Date.now() } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsedMs = Date.parse(raw);
  return Number.isFinite(parsedMs) ? Math.max(0, Math.ceil((parsedMs - now) / 1000)) : null;
}

// ── Cooldown ──────────────────────────────────────────────────────────────
export async function requestLaneCooldownStatus({
  now = Date.now(),
  kvImpl = requestLaneKv,
} = {}) {
  if (!requestLaneStoreConfigured()) {
    return { active: false, untilMs: null, reason: null, configured: false };
  }
  // Fail CLOSED on a transient KV read error (2026-09-26 review): a thrown
  // GET is treated as "assume a cooldown is active" for a short window,
  // matching admitRequestLaneRate's fail-closed behavior on the same kind of
  // outage, rather than "no cooldown set" — an unreadable key must never be
  // read as permission to call Paraform. A genuinely missing key (no error,
  // just a null/undefined result) still means "no cooldown", same as before.
  let raw;
  try {
    raw = await kvImpl(["GET", COOLDOWN_KEY]);
  } catch (error) {
    return {
      active: true,
      untilMs: now + MIN_COOLDOWN_SECONDS * 1000,
      reason: "kv_read_error",
      configured: true,
      error: String(error?.message || error).slice(0, 180),
    };
  }
  if (!raw) return { active: false, untilMs: null, reason: null, configured: true };
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { active: false, untilMs: null, reason: null, configured: true };
  }
  const untilMs = Number(parsed?.untilMs);
  const active = Number.isFinite(untilMs) && untilMs > now;
  return {
    active,
    untilMs: Number.isFinite(untilMs) ? untilMs : null,
    reason: parsed?.reason || null,
    source: parsed?.source || null,
    armedAt: parsed?.armedAt || null,
    configured: true,
  };
}

export async function armRequestLaneCooldown({
  seconds,
  reason = "throttled",
  source = null,
  now = Date.now(),
  kvImpl = requestLaneKv,
} = {}) {
  const ttlSeconds = Math.max(
    MIN_COOLDOWN_SECONDS,
    Math.ceil(Number(seconds)) || MIN_COOLDOWN_SECONDS,
  );
  const record = {
    untilMs: now + ttlSeconds * 1000,
    reason,
    source,
    armedAt: new Date(now).toISOString(),
  };
  await kvImpl(["SET", COOLDOWN_KEY, JSON.stringify(record), "EX", ttlSeconds]);
  return record;
}

export async function clearRequestLaneCooldown({ kvImpl = requestLaneKv } = {}) {
  await kvImpl(["DEL", COOLDOWN_KEY]);
}

// ── Cadence (1-5 min, default 2 min, per lane) ───────────────────────────
// A plain SET NX EX gate whose TTL is never shortened by an early release —
// unlike the outreach/expired poll locks (which ARE released the moment a
// tick finishes and so only guard against overlap), this key is left to
// expire on its own. That expiry IS the cadence.
export async function acquireRequestLaneCadenceSlot({
  lane,
  cadenceSeconds = requestLaneCadenceSeconds(),
  now = Date.now(),
  kvImpl = requestLaneKv,
} = {}) {
  // No durable store means no lane runs its real Paraform work anyway
  // (outreachExecutionEnabled/expiredDetectionEnabled both require
  // storeConfigured), so there is nothing here to gate — admit, and let the
  // caller's own storeConfigured gate be the one that matters.
  if (!requestLaneStoreConfigured()) return true;
  const ttl = Math.max(
    MIN_CADENCE_SECONDS,
    Math.min(MAX_CADENCE_SECONDS, Math.floor(cadenceSeconds) || DEFAULT_CADENCE_SECONDS),
  );
  const result = await kvImpl([
    "SET",
    `${CADENCE_KEY_PREFIX}${String(lane || "unknown")}`,
    String(now),
    "NX",
    "EX",
    ttl,
  ]);
  return result === "OK";
}

// ── Rate pacing (<=10/min, combined across lanes) ────────────────────────
function minuteBucket(now) {
  return Math.floor(now / 60_000);
}

export async function admitRequestLaneRate({
  now = Date.now(),
  ratePerMinute = requestLaneRatePerMinute(),
  kvImpl = requestLaneKv,
} = {}) {
  // See acquireRequestLaneCadenceSlot: without a store, nothing durable can be
  // paced anyway, and every real caller already requires storeConfigured.
  if (!requestLaneStoreConfigured()) return true;
  const key = `${RATE_BUCKET_PREFIX}${minuteBucket(now)}`;
  const count = Number(await kvImpl(["INCR", key]));
  if (count === 1) await kvImpl(["EXPIRE", key, RATE_BUCKET_TTL_SECONDS]).catch(() => {});
  return count <= Math.max(1, Math.min(MAX_RATE_PER_MINUTE, ratePerMinute));
}

// ── Durable per-lane, per-kind daily counters (health-exposed) ───────────
function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export async function recordRequestLaneRequest({
  lane,
  kind = "job",
  now = Date.now(),
  kvImpl = requestLaneKv,
} = {}) {
  if (!requestLaneStoreConfigured()) return 0;
  const safeLane = String(lane || "unknown");
  const safeKind = kind === "status" ? "status" : "job";
  const key = `${COUNTER_PREFIX}${dayKey(now)}:${safeLane}:${safeKind}`;
  const count = Number(await kvImpl(["INCR", key]));
  if (count === 1) await kvImpl(["EXPIRE", key, COUNTER_TTL_SECONDS]).catch(() => {});
  return count;
}

export async function requestLaneCounters({
  now = Date.now(),
  lanes = ["outreach", "expired"],
  kinds = ["job", "status"],
  kvImpl = requestLaneKv,
} = {}) {
  const date = dayKey(now);
  if (!requestLaneStoreConfigured()) {
    return { date, byLane: {}, total: 0, configured: false };
  }
  const index = [];
  const reads = [];
  for (const lane of lanes) {
    for (const kind of kinds) {
      reads.push(kvImpl(["GET", `${COUNTER_PREFIX}${date}:${lane}:${kind}`]).catch(() => null));
      index.push({ lane, kind });
    }
  }
  const results = await Promise.all(reads);
  const totals = { date, byLane: {}, total: 0, configured: true };
  results.forEach((raw, i) => {
    const { lane, kind } = index[i];
    const n = Number(raw) || 0;
    totals.byLane[lane] = totals.byLane[lane] || { job: 0, status: 0 };
    totals.byLane[lane][kind] = n;
    totals.total += n;
  });
  return totals;
}

// ── Rate-limited identity check (>=10 min apart) ─────────────────────────
// The only thing in this module allowed to turn a 401 into "the login is
// dead". It runs a single, distinct, low-cost read WHILE the cooldown is
// armed (that is the entire point: prove or disprove expiry independently of
// the ordinary lane traffic the cooldown is already blocking).
export async function requestLaneIdentityCheckDue({
  now = Date.now(),
  minIntervalMs = IDENTITY_CHECK_MIN_INTERVAL_MS,
  kvImpl = requestLaneKv,
} = {}) {
  const raw = await kvImpl(["GET", IDENTITY_CHECK_KEY]).catch(() => null);
  const lastMs = Number(raw);
  return !Number.isFinite(lastMs) || now - lastMs >= minIntervalMs;
}

async function markRequestLaneIdentityCheck({
  now = Date.now(),
  minIntervalMs = IDENTITY_CHECK_MIN_INTERVAL_MS,
  kvImpl = requestLaneKv,
} = {}) {
  await kvImpl([
    "SET",
    IDENTITY_CHECK_KEY,
    String(now),
    "EX",
    Math.ceil(minIntervalMs / 1000) + 60,
  ]);
}

export async function requestLaneAuthStatus({
  now = Date.now(),
  minIntervalMs = IDENTITY_CHECK_MIN_INTERVAL_MS,
  readImpl = () => trpcGetRaw("user.getCurrentUser", {}, 1),
  reportFailureImpl = reportParaformReadAuthFailure,
  recordImpl = recordRequestLaneRequest,
  kvImpl = requestLaneKv,
} = {}) {
  const due = await requestLaneIdentityCheckDue({ now, minIntervalMs, kvImpl });
  if (!due) return { checked: false, reason: "not_due", authExpired: false };
  await markRequestLaneIdentityCheck({ now, minIntervalMs, kvImpl }).catch(() => {});
  await recordImpl({ lane: "identity-check", kind: "status", now, kvImpl }).catch(() => {});
  try {
    await readImpl();
    return { checked: true, authExpired: false };
  } catch (error) {
    if (String(error?.code || "") !== "PARAFORM_THROTTLED") {
      // A non-401 error (transport, 5xx, procedure) proves nothing about the
      // cookie — fail open, exactly like the shared auth-probe module does.
      return { checked: true, authExpired: false, inconclusive: true, error: String(error?.code || "") };
    }
    await reportFailureImpl({ lane: "paraai_request_lanes", stage: "identity_check" }).catch(() => {});
    return { checked: true, authExpired: true };
  }
}

// ── Cross-lane mutex (2026-09-26 review) ─────────────────────────────────
// The cooldown above is armed only AFTER a call has actually failed, so on
// its own it cannot stop two calls that are already in flight before either
// one has failed. Same-lane overlap is already covered by the per-lane poll
// locks (acquireOutreachPollSlot / acquireExpiredPollSlot), but nothing
// previously spanned the two LANES together: if a second, overlapping
// invocation of the worker route occurs (worker.mjs's own header comment
// names this as an expected case — "two overlapping invocations (Fly + a
// manual tick)"), invocation A's outreach tick could be mid-flight on its
// first Paraform read while invocation B, unable to get A's poll lock, fell
// through into the expired lane and passed the still-inactive cooldown
// check before A's read had failed and armed it — both calls would then hit
// Paraform, and both 401, before either could arm the cooldown.
//
// Every Paraform call either lane makes funnels through laneCall() below, so
// gating laneCall() itself with one shared KV mutex closes this for both
// lanes at the root, with no changes needed at either call site. It is held
// only for the duration of a single call (acquire, call, arm-on-failure,
// release) — never the whole tick — so it costs nothing beyond that single
// round trip, and legitimate lane throughput (already cadence- and
// pace-capped well below this) is unaffected.
async function acquireCrossLaneMutex({ now = Date.now(), kvImpl = requestLaneKv } = {}) {
  const token = `v1:${now}:${Math.random().toString(36).slice(2)}`;
  const deadline = now + CROSS_LANE_MUTEX_MAX_WAIT_MS;
  for (;;) {
    const result = await kvImpl([
      "SET", CROSS_LANE_MUTEX_KEY, token, "NX", "EX", CROSS_LANE_MUTEX_TTL_SECONDS,
    ]);
    if (result === "OK") return token;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => { setTimeout(resolve, CROSS_LANE_MUTEX_RETRY_MS); });
  }
}

async function releaseCrossLaneMutex(token, { kvImpl = requestLaneKv } = {}) {
  if (!token) return;
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  await kvImpl(["EVAL", script, 1, CROSS_LANE_MUTEX_KEY, token]).catch(() => {});
}

// ── The single call path both lanes route their Paraform work through ───
function throttleSignal(error) {
  const code = String(error?.code || "");
  if (code === "PARAFORM_THROTTLED") return "401";
  if (code === `HTTP_429` || Number(error?.status) === 429) return "429";
  return null;
}

async function laneCall({
  lane,
  kind = "job",
  now = Date.now(),
  rawFn,
  kvImpl = requestLaneKv,
}) {
  const configured = requestLaneStoreConfigured();
  // Without a store there is nothing durable to serialize against anyway
  // (every gate in this module already fails open when unconfigured) —
  // skip straight to the call rather than mutex-guard a no-op.
  const mutexToken = configured ? await acquireCrossLaneMutex({ now, kvImpl }) : null;
  if (configured && !mutexToken) {
    // Another invocation is inside its own critical section right now.
    // Treat it exactly like an already-armed cooldown so every existing
    // call site's handling (stop cleanly, no alert, no retry) applies
    // unchanged — this is deliberately indistinguishable from a cooldown to
    // the caller.
    throw cooldownError(now + MIN_COOLDOWN_SECONDS * 1000, "cross_lane_busy");
  }
  try {
    const cooldown = await requestLaneCooldownStatus({ now, kvImpl });
    if (cooldown.active) throw cooldownError(cooldown.untilMs, cooldown.reason);
    const paced = await admitRequestLaneRate({ now, kvImpl });
    if (!paced) throw rateLimitedError();
    await recordRequestLaneRequest({ lane, kind, now, kvImpl }).catch(() => {});
    try {
      return await rawFn();
    } catch (error) {
      const signal = throttleSignal(error);
      if (!signal) throw error;
      const retryAfterSeconds = parseRetryAfterSeconds(error?.retryAfter, { now });
      const armed = await armRequestLaneCooldown({
        seconds: Math.max(MIN_COOLDOWN_SECONDS, retryAfterSeconds || 0),
        reason: signal,
        source: lane,
        now,
        kvImpl,
      }).catch(() => ({ untilMs: now + MIN_COOLDOWN_SECONDS * 1000 }));
      throw cooldownError(armed.untilMs, signal);
    }
  } finally {
    if (mutexToken) await releaseCrossLaneMutex(mutexToken, { kvImpl });
  }
}

// One attempt only (`tries: 1` all the way down): no retry ladder, no
// expiry-confirmation reads. `meta.kind` marks a read as "status" (health,
// polling reads that never write) vs the default "job" (a request that acts
// on a specific candidate/request row).
export async function requestLaneTrpcGet(proc, json = {}, { lane = "unknown", kind = "job" } = {}) {
  return laneCall({ lane, kind, rawFn: () => trpcGetRaw(proc, json, 1) });
}

export async function requestLaneTrpcPost(proc, json = {}, { lane = "unknown", kind = "job" } = {}) {
  return laneCall({ lane, kind, rawFn: () => trpcPostRaw(proc, json) });
}

// Drop-in `trpcGet`/`trpcPost`-shaped functions bound to one lane, so a
// module can swap its import from core.mjs for this and change nothing else
// at any call site (existing extra args like the `1` "tries" hint are
// harmless no-ops here — this module always makes exactly one attempt).
export function boundRequestLaneTrpc(lane) {
  return {
    // Reads (history, digest, status) are "status" load; writes are the
    // "job" a request actually needed done. Matches the GET/POST split
    // already used throughout outreach.mjs and expired-actions.mjs.
    trpcGet: (proc, json = {}) => requestLaneTrpcGet(proc, json, { lane, kind: "status" }),
    trpcPost: (proc, json = {}) => requestLaneTrpcPost(proc, json, { lane, kind: "job" }),
  };
}
