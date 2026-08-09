// Paraform tRPC READ transport for the Applicants profile view.
//
// Deliberately a LOCAL COPY of the api/seq/_lib/core.mjs transport rather than
// an import: sibling trees share only the auth helpers across api trees (see
// how api/paraai/_lib/core.mjs re-exports auth but owns its own transport), so
// a seq-side transport change can never silently alter this surface. Reads
// only — this tree performs no Paraform writes.

const BASE = "https://www.paraform.com/api";
const COOKIE = process.env.PARAFORM_COOKIE || "";          // browser session cookie value (env, never logged)

export const hasCookie = () => Boolean(COOKIE);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Paraform migrated from NextAuth to WorkOS (2026-07): iron-sealed WorkOS session
// values start with "Fe26.2" and ride the `wos-session` cookie; legacy NextAuth
// JWEs ("eyJ...") ride `__Secure-next-auth.session-token`. Auto-pick the name from
// the value so a cookie refresh stays a value-only swap; PARAFORM_SESSION_COOKIE_NAME
// overrides (allowlisted).
const PARAFORM_COOKIE_NAMES = new Set(["wos-session", "__Secure-next-auth.session-token"]);
export function paraformCookieName(value) {
  const override = process.env.PARAFORM_SESSION_COOKIE_NAME;
  if (override) {
    if (!PARAFORM_COOKIE_NAMES.has(override.trim())) throw new Error("PARAFORM_SESSION_COOKIE_NAME_INVALID");
    return override.trim();
  }
  return String(value || "").startsWith("Fe26.2") ? "wos-session" : "__Secure-next-auth.session-token";
}

const headers = () => ({
  accept: "application/json",
  "content-type": "application/json",
  cookie: `${paraformCookieName(COOKIE)}=${COOKIE}`,
});
const env = (json) => ({ json, meta: { values: {}, v: 1 } });

// Paraform answers 401 to a BURST as well as to a dead session, so a 401 is a
// QUESTION, not a verdict — the false-expiry incidents behind this design are
// written up in api/seq/_lib/core.mjs. Every read rides the retry ladder and
// only reports AUTH_EXPIRED after a serial probe confirms the session is dead.
const throttled = () =>
  Object.assign(new Error("PARAFORM_THROTTLED"), { code: "PARAFORM_THROTTLED" });
const authExpired = () =>
  Object.assign(new Error("AUTH_EXPIRED"), { code: "AUTH_EXPIRED" });

// An exhausted-but-unconfirmed throttle and a confirmed expiry both mean "the
// cookie channel cannot answer right now" — callers degrade the same way.
export function isParaformAuthError(error) {
  return error?.code === "AUTH_EXPIRED" || error?.code === "PARAFORM_THROTTLED";
}

const AUTH_RETRY_DELAYS_MS = [600, 1800, 4500];
const authRetryDelays = () => {
  const parsed = String(process.env.PARAFORM_THROTTLE_DELAYS_MS || "")
    .split(",").map((n) => n.trim()).filter(Boolean).map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : AUTH_RETRY_DELAYS_MS;
};
const probeDelayMs = () => Number(process.env.PARAFORM_PROBE_DELAY_MS || 1500);

async function classifyThrottle(fn, { delays = authRetryDelays() } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (e?.code !== "PARAFORM_THROTTLED") throw e;
      if (attempt < delays.length) {
        // Jitter so parallel invocations do not retry in lockstep.
        await sleep(delays[attempt] + Math.floor(Math.random() * 400));
        continue;
      }
      throw (await isSessionActuallyExpired()) ? authExpired() : e;
    }
  }
}

/** A cheap read retried with growing backoff. One probe is not enough: it races
 *  the very burst it is trying to rule out. */
async function isSessionActuallyExpired({ probes = 3 } = {}) {
  for (let i = 0; i < probes; i++) {
    try { await trpcGetRaw("user.getCurrentUser", {}, 1); return false; }
    catch (e) {
      if (e?.code !== "PARAFORM_THROTTLED") return false; // reached it, so auth is fine
      await sleep(probeDelayMs() * (i + 1) + Math.floor(Math.random() * 600));
    }
  }
  return true;
}

export async function trpcGet(proc, json, tries = 3) {
  return classifyThrottle(() => trpcGetRaw(proc, json, tries));
}

async function trpcGetRaw(proc, json, tries = 3) {
  const url = `${BASE}/trpc/${proc}?input=` + encodeURIComponent(JSON.stringify(env(json)));
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(20000) });
      if (r.status === 401) throw throttled();
      // A 5xx/429 body is usually HTML; classify it before the JSON parse so
      // the failure stays retryable instead of an opaque parse error.
      if (r.status === 429 || r.status >= 500) throw transportStatusError(r.status);
      const b = await r.json();
      if (b?.error) throw new Error(b.error.json?.message || "trpc error");
      return b?.result?.data?.json;
    } catch (e) { if (e.code === "PARAFORM_THROTTLED" || a === tries - 1) throw e; await sleep(500 * (a + 1)); }
  }
}

function transportStatusError(status) {
  const e = new Error(`PARAFORM_HTTP_${status}`);
  e.code = `PARAFORM_HTTP_${status}`;
  e.status = status;
  return e;
}
