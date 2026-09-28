// ─────────────────────────────────────────────────────────────────────────────
// PARAFORM REQUEST PACER — dedicated to the lightweight booking-protection
// system only (docs/research/booking-protection-minimum-2026-09-26.md item 6:
// "Pace every Paraform request at <= 10/min (David's seat), one in flight;
// when the session is refused, wait (Retry-After or 60s, whichever is longer)
// instead of retrying hard; count every request.").
//
// This is deliberately NOT core.mjs's trpcGet/trpcPost. Those ride
// classifyThrottle, which on a 401 retries with its own backoff ladder and
// then serially re-probes up to 3 times before calling a session dead
// (core.mjs, "Throttle vs expiry"). That machinery is right for the launcher
// and the legacy sweep, which need to tell a burst apart from a dead cookie
// under real concurrency. This system runs at a small fraction of David's
// seat cap by design, so a refusal here is treated as a plain signal to slow
// down: back off and let the NEXT scheduled tick try again, rather than
// spending part of the daily budget finding out why.
//
// One exception, added 2026-09-28: a 401 is also what a DEAD session gets,
// and backing off never fixes that. The daily live-set refresh failed with
// PARAFORM_HTTP_401 on 09-27 and 09-28 because the shared n8n slot was dead
// while the 'david' slot was live, and nothing on this path ever moved off
// it. So a 401 now gets the same evidence core.mjs's raw reads use
// (unauthorizedRead: serial probes of the exact cookie that got the 401),
// with every probe spaced and counted like any other request here. A
// throttle verdict keeps the old behaviour exactly: nothing is parked and
// the pacer backs off. Only a confirmed-dead session is parked (by
// unauthorizedRead itself), and then the request gets ONE attempt on the
// next store session; a call never MOVES onto the static env seal (a
// process whose resolver itself falls back to it still sends it, as every
// other path would, and learns once whether it is dead). One
// attempt per session, at most two sessions per call, never more than one
// in flight. A 401 that carries Retry-After is Paraform saying "throttled",
// so it gets no probes.
//
// Each serverless instance would otherwise re-learn a dead session on its
// own (the store's park is in-process), paying about a minute of probes per
// cold worker or catch-up tick. So a confirmed-dead session is remembered for
// the store's own 30-minute rejection window, in this process and in the
// pacer's KV state, as a short SHA-256 fingerprint (never the value). A call
// that holds a remembered-dead session skips it without sending anything.
// The fingerprint is of the exact value, so a reseeded or renewed session is
// never skipped by it. Two consequences to know: a verdict (even a false
// one) now reaches every invocation for those 30 minutes, not just the one
// that reached it, and a warm instance that still caches the dead value
// parks its whole slot in-process (PR 240's per-slot park), so it can ignore
// a reseed of that slot until the park lapses. Both fail toward waiting:
// jobs stay queued.
import { createHash } from "node:crypto";
import {
  BASE,
  ensureParaformSession,
  notifyParaformSessionRejected,
  paraformCookieValue,
  sessionHeaders,
  unauthorizedRead,
} from "./core.mjs";
import {
  PARAFORM_SESSION_REJECTION_TTL_MS,
  resolvedParaformSession,
} from "../../_lib/paraform-session-store.mjs";
import {
  LITE_KEYS,
  kvGet,
  kvSet,
  kvIncr,
  kvExpire,
} from "./booking-protection-store.mjs";
import { cachedRelationshipStatus } from "./booking-stop.mjs";

// 6.5s spacing -> ~9.2 requests/minute, safely under the seat's 10/min cap
// with margin for clock jitter between ticks.
export const PACE_MIN_INTERVAL_MS = 6500;
export const PACE_DEFAULT_BACKOFF_MS = 60_000;
// How long other invocations are held off while a 401 is being confirmed.
// The production probe run takes about a minute at this pacer's spacing
// (five ladder waits, then three serial probes); the final state written
// when it ends replaces this hold.
export const PACE_CONFIRM_HOLD_MS = 2 * PACE_DEFAULT_BACKOFF_MS;

function todayUtc(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// The session this process will send: what the store resolver settled on, or
// the static env value when nothing has been resolved.
function heldParaformSession() {
  return resolvedParaformSession() || { value: paraformCookieValue(), slot: "env" };
}

async function nextParaformSession() {
  await ensureParaformSession();
  return resolvedParaformSession();
}

export function sessionFingerprint(cookie) {
  return createHash("sha256").update(String(cookie ?? "")).digest("hex").slice(0, 16);
}

// fingerprint -> epoch ms until which that exact session is known dead.
let confirmedDead = new Map();

export function __resetPacerSessionMemoryForTests() {
  confirmedDead = new Map();
}

// The union of this process's memory and the KV state's, minus expired ones.
function liveDeadSessions(state, nowMs) {
  const merged = new Map();
  const entries = [
    ...(Array.isArray(state?.deadSessions) ? state.deadSessions : []),
    ...[...confirmedDead].map(([fp, until]) => ({ fp, until })),
  ];
  for (const entry of entries) {
    if (typeof entry?.fp !== "string" || !Number.isFinite(entry?.until)) continue;
    if (entry.until <= nowMs) continue;
    merged.set(entry.fp, Math.max(entry.until, merged.get(entry.fp) || 0));
  }
  return merged;
}

/**
 * Build a `paced(fn)` wrapper bound to durable KV state, so pacing survives
 * across separate serverless invocations (each cron tick is a fresh process).
 * `fn(cookie)` should be a single Paraform request on that exact session
 * value, with no internal retry ladder — see `singleShotTrpc` below.
 */
export function createPacer({
  loadState = () => kvGet(LITE_KEYS.pace),
  saveState = (value) => kvSet(LITE_KEYS.pace, value, 7 * 24 * 3600),
  incrementCount = async (day) => {
    await kvIncr(LITE_KEYS.paceCount(day));
    await kvExpire(LITE_KEYS.paceCount(day), 45 * 24 * 3600);
  },
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  minIntervalMs = PACE_MIN_INTERVAL_MS,
  defaultBackoffMs = PACE_DEFAULT_BACKOFF_MS,
  confirmHoldMs = PACE_CONFIRM_HOLD_MS,
  heldSession = heldParaformSession,
  nextSession = nextParaformSession,
  confirmRefusal = (cookie, fetchImpl) => unauthorizedRead(cookie, { fetchImpl }),
  probeFetch = (url, init) => fetch(url, init),
  log = (message) => console.warn(message),
} = {}) {
  async function pacedOnce(fn) {
    const nowMs = now();
    const state = (await loadState()) || {};
    if (Number.isFinite(state.backoffUntil) && nowMs < state.backoffUntil) {
      const error = new Error("PARAFORM_PACED_BACKOFF");
      error.code = "PARAFORM_PACED_BACKOFF";
      error.retryAt = state.backoffUntil;
      throw error;
    }
    const dead = liveDeadSessions(state, nowMs);
    const isDead = (cookie) => dead.has(sessionFingerprint(cookie));
    const markDead = (cookie) => {
      const until = now() + PARAFORM_SESSION_REJECTION_TTL_MS;
      const fp = sessionFingerprint(cookie);
      dead.set(fp, until);
      confirmedDead.set(fp, until);
    };
    // Every write carries the remembered-dead fingerprints forward. A KV
    // failure here only loses the memory; the next call re-confirms.
    const persist = (value) => saveState({
      ...value,
      deadSessions: [...dead].map(([fp, until]) => ({ fp, until })),
    });
    const sessionDead = () => Object.assign(new Error("PARAFORM_SESSION_DEAD"), {
      code: "PARAFORM_SESSION_DEAD",
      status: 401,
    });

    // Every Paraform request this call makes, the confirming probes
    // included, goes through send(): at least minIntervalMs after the last
    // one ended, and counted.
    let lastRequestAt = state.lastRequestAt;
    async function send(request) {
      if (Number.isFinite(lastRequestAt)) {
        const wait = lastRequestAt + minIntervalMs - now();
        if (wait > 0) await sleep(wait);
      }
      await incrementCount(todayUtc(now()));
      try {
        return await request();
      } finally {
        lastRequestAt = now();
      }
    }

    // A store session other than `from` that is not known dead, or null.
    // Never the env seal.
    async function moveFrom(from) {
      const next = await nextSession();
      if (next && next.slot !== "env" && next.value && next.value !== from && !isDead(next.value)) {
        return next;
      }
      return null;
    }

    let held = heldSession();
    if (isDead(held.value)) {
      // Confirmed dead within the last 30 minutes, by this process or
      // another invocation: park it here too and skip it without a request.
      notifyParaformSessionRejected({ cookie: held.value });
      const next = await moveFrom(held.value);
      if (!next) {
        log(`booking-protection pacer: the ${held.slot} Paraform session was confirmed dead recently and no other store session is available`);
        // Back off like any refusal, so the calls after this one wait
        // instead of each re-reading the n8n store to reach the same answer.
        await persist({ lastRequestAt: state.lastRequestAt ?? null, backoffUntil: now() + defaultBackoffMs })
          .catch(() => {});
        throw sessionDead();
      }
      log(`booking-protection pacer: skipping the ${held.slot} Paraform session (confirmed dead recently); using the ${next.slot} session`);
      held = next;
    }

    let failure;
    try {
      const result = await send(() => fn(held.value));
      await persist({ lastRequestAt, backoffUntil: null });
      return result;
    } catch (error) {
      failure = error;
    }

    if (failure?.code === "PARAFORM_REFUSED_AUTH" && !(failure.retryAfterMs > 0)) {
      let moved = null;
      try {
        // Hold other invocations off while the probes run. If this write
        // fails, no probes run and the call backs off exactly as before.
        await persist({ lastRequestAt, backoffUntil: now() + confirmHoldMs });
        const verdict = await confirmRefusal(
          held.value,
          (url, init) => send(() => probeFetch(url, init)),
        );
        if (verdict?.code === "AUTH_EXPIRED") {
          // unauthorizedRead has already parked the slot, if the process still
          // held this cookie.
          markDead(held.value);
          moved = await moveFrom(held.value);
          if (!moved) {
            log(`booking-protection pacer: the ${held.slot} Paraform session is confirmed dead and no other store session is available`);
            // Not AUTH_EXPIRED: applyDecisions answers that code with its own
            // unpaced probes and aborts the whole batch. This is recorded as
            // one pause error, the job stays queued, and the refresh alert
            // names it.
            failure = sessionDead();
          }
        }
      } catch {
        // The confirmation is best-effort: on any error keep the original
        // refusal and back off exactly as before.
      }
      if (moved) {
        log(`booking-protection pacer: the ${held.slot} Paraform session is confirmed dead; one attempt on the ${moved.slot} session`);
        try {
          const result = await send(() => fn(moved.value));
          await persist({ lastRequestAt, backoffUntil: null });
          return result;
        } catch (error) {
          failure = error; // no second confirmation in the same call
        }
      }
    }

    const retryAfterMs = Number.isFinite(failure?.retryAfterMs) && failure.retryAfterMs > 0
      ? failure.retryAfterMs
      : 0;
    const backoffUntil = now() + Math.max(retryAfterMs, defaultBackoffMs);
    await persist({ lastRequestAt: now(), backoffUntil });
    throw failure;
  }

  // "One in flight" (item 6) has to hold even when a caller with its own
  // internal concurrency (e.g. booking-stop.mjs applyDecisions' 2-way
  // read-back verify loop) awaits this pacer from two call sites at once.
  // The durable KV state above only serializes ACROSS separate serverless
  // invocations; within one process, two concurrent callers would both read
  // `lastRequestAt` before either wrote it back and both fire together. This
  // chain makes every call to `paced(fn)` in this process queue behind the
  // one before it, so requests this pacer issues are never more than one in
  // flight regardless of how many callers hold a reference to it.
  let chain = Promise.resolve();
  return function paced(fn) {
    const result = chain.then(() => pacedOnce(fn));
    chain = result.then(() => undefined, () => undefined);
    return result;
  };
}

/**
 * One Paraform tRPC call, exactly one attempt, no retry ladder — the pacer
 * (above) decides what happens on refusal, not this function. Throws a
 * classified error carrying `retryAfterMs` (from the `Retry-After` header,
 * when Paraform sends one) on any non-2xx status or transport failure.
 * `cookie` is the exact session value to send; the pacer passes the one it
 * will test if this call gets a 401.
 */
export async function singleShotTrpc(method, proc, json, {
  fetchImpl = fetch,
  timeoutMs = 20_000,
  cookie = paraformCookieValue(),
} = {}) {
  const verb = method === "GET" ? "GET" : "POST";
  const body = { json, meta: { values: {}, v: 1 } };
  const url = verb === "GET"
    ? `${BASE}/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(body))}`
    : `${BASE}/trpc/${proc}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: verb,
      headers: sessionHeaders(cookie),
      ...(verb === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    const error = new Error("PARAFORM_TRANSPORT_ERROR");
    error.code = "PARAFORM_TRANSPORT_ERROR";
    throw error;
  }
  if (!response.ok) {
    const retryAfterHeader = response.headers?.get?.("retry-after");
    const retryAfterSeconds = Number(retryAfterHeader);
    const error = new Error(`PARAFORM_HTTP_${response.status}`);
    error.code = response.status === 401 ? "PARAFORM_REFUSED_AUTH" : "PARAFORM_REFUSED";
    error.status = response.status;
    error.retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : 0;
    throw error;
  }
  const parsed = await response.json();
  if (parsed?.error) {
    const error = new Error(parsed.error.json?.message || "PARAFORM_TRPC_ERROR");
    error.code = "PARAFORM_TRPC_ERROR";
    throw error;
  }
  return parsed?.result?.data?.json;
}

/** Convenience: a {get, post} pair of paced, single-shot tRPC callers bound to
 *  one pacer instance, for callers that just want "the paced client". */
export function pacedTrpcClient(pace = createPacer()) {
  return {
    get: (proc, json) => pace((cookie) => singleShotTrpc("GET", proc, json, { cookie })),
    post: (proc, json) => pace((cookie) => singleShotTrpc("POST", proc, json, { cookie })),
  };
}

/**
 * The `applyDecisionsOverrides` booking-stop.mjs's `applyDecisions()` was
 * built to accept (see the comment at its definition) — routing its two
 * Paraform calls (pause + read-back search) through THIS pacer instead of
 * core.mjs's burst-tuned `trpcPost`/`trpcGet` + `withThrottleRetry` ladder.
 *
 * Every production caller in the lightweight booking-protection system
 * (booking-worker.mjs, booking-catchup.mjs) must build one pacer per
 * invocation and pass its overrides through — see those files for why this
 * exists (item 6: <=10/min, one in flight, wait-don't-retry-hard on refusal).
 *
 * `concurrency: 1` bounds the pause loop to one in flight; `mutateThrottleRetry`
 * is replaced with a single attempt (no internal retry ladder — a refusal is
 * pushed to `pauseErrors` and the job stays queued for the next, paced tick,
 * exactly per item 6) so a refusal costs one request, not up to six over 31s.
 * A 401 also buys the pacer's paced serial probes (createPacer, above), so a
 * dead session is left for the next store session instead of retried.
 * `searchLead` reimplements campaignLeadBySearch's own response-shaping
 * (match the returned lead to the exact ccu_id that was mutated) without its
 * `withThrottleRetry` wrapper, for the same reason.
 */
export function pacedApplyDecisionsOverrides(pace) {
  const client = pacedTrpcClient(pace);
  return {
    concurrency: 1,
    mutateThrottleRetry: (fn) => fn(),
    mutatePause: (ccuId) =>
      client.post("campaigns.updateCandidatePauseStatus", {
        campaign_to_candidate_user_id: ccuId,
        is_paused: true,
      }),
    searchLead: async (sequenceId, email, { expectedCcuId = null } = {}) => {
      if (!email) return null;
      const r = await client.get("campaigns.getCampaignLeads", {
        campaign_id: sequenceId,
        search: String(email),
      });
      const leads = Array.isArray(r?.leads) ? r.leads : [];
      if (expectedCcuId == null) return leads[0] || null;
      const target = String(expectedCcuId);
      return leads.find((lead) => String(lead?.ccu_id || "") === target) || null;
    },
  };
}

/**
 * A `relationshipStatusLoader(cuId)` for the Book Time rotor
 * (booking-protection-catchup.mjs bookTimeRotorCheck) that routes its one
 * Paraform profile read through this pacer, while keeping
 * `cachedRelationshipStatus`'s own 30-minute KV cache (so a cache hit costs
 * zero Paraform requests and never touches the pacer at all).
 */
export function pacedRelationshipStatusLoader(pace) {
  return (cuId) => cachedRelationshipStatus(cuId, {
    fetchProfile: () => pace((cookie) =>
      singleShotTrpc("GET", "candidateUser.getCandidateProfileInfo", { candidateUserId: cuId }, { cookie })),
  });
}
