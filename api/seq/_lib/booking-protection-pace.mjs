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
import { BASE, headers } from "./core.mjs";
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

function todayUtc(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Build a `paced(fn)` wrapper bound to durable KV state, so pacing survives
 * across separate serverless invocations (each cron tick is a fresh process).
 * `fn` should be a single Paraform request with no internal retry ladder —
 * see `singleShotTrpc` below.
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
    if (Number.isFinite(state.lastRequestAt)) {
      const wait = state.lastRequestAt + minIntervalMs - nowMs;
      if (wait > 0) await sleep(wait);
    }
    await incrementCount(todayUtc(now()));
    try {
      const result = await fn();
      await saveState({ lastRequestAt: now(), backoffUntil: null });
      return result;
    } catch (error) {
      const retryAfterMs = Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0
        ? error.retryAfterMs
        : 0;
      const backoffUntil = now() + Math.max(retryAfterMs, defaultBackoffMs);
      await saveState({ lastRequestAt: now(), backoffUntil });
      throw error;
    }
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
 */
export async function singleShotTrpc(method, proc, json, {
  fetchImpl = fetch,
  timeoutMs = 20_000,
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
      headers: headers(),
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
    get: (proc, json) => pace(() => singleShotTrpc("GET", proc, json)),
    post: (proc, json) => pace(() => singleShotTrpc("POST", proc, json)),
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
    fetchProfile: () => pace(() =>
      singleShotTrpc("GET", "candidateUser.getCandidateProfileInfo", { candidateUserId: cuId })),
  });
}
