// Paraform tRPC transport for the Activity tab.
//
// Descends from the HM chase transport (main repo src/hm-chase/client.mjs) and
// api/seq/_lib/core.mjs, with the two lessons that lane paid for baked in:
//
//   1. Paraform 401/403s are BURST-shaped, not session-death. hm-chase read
//      ~100 applications through resolveApplicationThread at concurrency 6 and
//      ate 33 auth failures every tick; serial reads measure 100% clean
//      (seq core.mjs and the 2026-08-09 research capture, main repo
//      docs/ACTIVITY-TAB-RESEARCH-2026-08-09.md). This transport is used
//      serially or at concurrency 2, retries auth blips with growing delays,
//      and NEVER treats one 401 as an expired session.
//
//   2. Paraform periodically rotates the wos-session value via Set-Cookie.
//      The chase persisted rotations to the desktop .env; nothing refreshed
//      the Vercel copy, which is how deployed cookies go stale. Here a
//      rotation is absorbed into KV (activity:v1:session) so the deployed
//      cookie self-heals; env is only the seed. The rotated value is never
//      logged.
//
// Read/write allowlists: a future edit cannot quietly reach a new surface.
// consolidatedMessaging.send is the ONLY write, single-try, never retried —
// a comment post is not idempotent and recovery is read-back, never resend.

import { getJson, setJson, kvConfigured } from "./kv.mjs";

export const BASE = "https://www.paraform.com/api";
const TIMEOUT_MS = 20_000;
const SESSION_KEY = "activity:v1:session";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COOKIE_NAMES = new Set(["wos-session", "__Secure-next-auth.session-token"]);

export function paraformCookieName(value) {
  const override = process.env.PARAFORM_SESSION_COOKIE_NAME;
  if (override) {
    if (!COOKIE_NAMES.has(override.trim())) throw new Error("PARAFORM_SESSION_COOKIE_NAME_INVALID");
    return override.trim();
  }
  return String(value || "").startsWith("Fe26.2") ? "wos-session" : "__Secure-next-auth.session-token";
}

let sessionValue = null;   // resolved once per invocation: KV if present, else env
let sessionLoaded = false;
let rotations = 0;

export const hasCookie = () => Boolean(process.env.PARAFORM_COOKIE || process.env.PARAFORM_SESSION_COOKIE);

async function cookieValue() {
  if (!sessionLoaded) {
    sessionLoaded = true;
    if (kvConfigured()) {
      try {
        const stored = await getJson(SESSION_KEY);
        if (stored?.value && stored.value.length >= 32) sessionValue = stored.value;
      } catch { /* env seed below */ }
    }
    if (!sessionValue) sessionValue = process.env.PARAFORM_SESSION_COOKIE || process.env.PARAFORM_COOKIE || null;
  }
  if (!sessionValue) throw new Error("PARAFORM_COOKIE_MISSING");
  return sessionValue;
}

async function headers() {
  const v = await cookieValue();
  return {
    accept: "application/json",
    "content-type": "application/json",
    cookie: `${paraformCookieName(v)}=${v}`,
  };
}

/** Absorb a Paraform-issued session rotation into memory + KV. Never logged. */
async function absorbRotation(response) {
  let list = [];
  try {
    list = response?.headers?.getSetCookie?.() ?? [];
    if (!list.length) {
      const one = response?.headers?.get?.("set-cookie");
      if (one) list = [one];
    }
  } catch { return false; }
  if (!list.length) return false;
  const current = sessionValue;
  const want = paraformCookieName(current || "");
  for (const raw of list) {
    const eq = String(raw).indexOf("=");
    if (eq < 1 || String(raw).slice(0, eq).trim() !== want) continue;
    const value = String(raw).slice(eq + 1).split(";")[0].trim();
    if (!value || value.length < 32) continue; // a clear or truncated echo must not replace a working credential
    if (value === current) return false;
    sessionValue = value;
    rotations++;
    if (kvConfigured()) {
      try { await setJson(SESSION_KEY, { value, at: new Date().toISOString() }); } catch { /* memory copy still serves this invocation */ }
    }
    return true;
  }
  return false;
}

export class AuthExpired extends Error {
  constructor() { super("AUTH_EXPIRED"); this.name = "AuthExpired"; }
}

// Transport accounting — log-safe counters only, no payloads, no cookie.
let calls = 0;
let auth401 = 0;
export const transportStats = () => ({ calls, auth401, rotations });

export const READ_PROCEDURES = new Set([
  "user.getCurrentUser",
  "candidateUser.getCRMExternalCandidates",
  "consolidatedMessaging.getInbox",
  "consolidatedMessaging.getThread",
  "consolidatedMessaging.resolveApplicationThread", // fallback only — threadIds are constructible
  "consolidatedMessaging.getMentionList",
  "role.getRoleOwner",
]);

export const WRITE_PROCEDURES = new Set(["consolidatedMessaging.send"]);

export async function trpcGet(proc, json, { tries = 4 } = {}) {
  if (!READ_PROCEDURES.has(proc)) throw new Error(`PROCEDURE_NOT_ALLOWED:${proc}`);
  const url = `${BASE}/trpc/${proc}?input=` +
    encodeURIComponent(JSON.stringify({ json, meta: { values: {}, v: 1 } }));
  let last;
  for (let a = 0; a < tries; a++) {
    try {
      calls++;
      // Headers rebuilt per attempt: a 401 carrying a rotated cookie means the
      // next attempt succeeds with the new credential.
      const r = await fetch(url, { headers: await headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      await absorbRotation(r);
      if (r.status === 401 || r.status === 403) { auth401++; throw new AuthExpired(); }
      const b = await r.json();
      if (b?.error) throw new Error(String(b.error.json?.message || "trpc_error").slice(0, 300));
      return b?.result?.data?.json;
    } catch (e) {
      last = e;
      if (a === tries - 1) break;
      // Auth blips get longer to pass than network hiccups (burst decay).
      await sleep(Math.min(6000, (e instanceof AuthExpired ? 1500 : 500) * (a + 1)));
    }
  }
  throw last;
}

// tries=1 always: a comment post is NOT idempotent. A timed-out send may have
// landed; a blind retry is a double-post at a hiring manager. Recovery is
// read-back reconciliation in the caller, never a retry here.
export async function trpcPost(proc, json) {
  if (!WRITE_PROCEDURES.has(proc)) throw new Error(`PROCEDURE_NOT_ALLOWED:${proc}`);
  calls++;
  const r = await fetch(`${BASE}/trpc/${proc}`, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify({ json, meta: { values: {}, v: 1 } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await absorbRotation(r);
  if (r.status === 401 || r.status === 403) { auth401++; throw new AuthExpired(); }
  const b = await r.json();
  if (b?.error) throw new Error(String(b.error.json?.message || "trpc_error").slice(0, 300));
  return b?.result?.data?.json;
}

// ---------------------------------------------------------------- reads ----

// Identity is the authority on whether the session is genuinely dead. Wider
// bounded window than ordinary reads so transient auth bursts never page as
// "session expired" (observed live: two full three-attempt bursts failing,
// followed immediately by a healthy response).
export const whoAmI = () => trpcGet("user.getCurrentUser", {}, { tries: 6 });

export const getInbox = (input = {}) => trpcGet("consolidatedMessaging.getInbox", input);
export const getThread = (threadId) => trpcGet("consolidatedMessaging.getThread", { threadId });
export const getMentionList = (threadId) => trpcGet("consolidatedMessaging.getMentionList", { threadId });
export const getRoleOwner = (roleId) => trpcGet("role.getRoleOwner", { role_id: roleId });
export const resolveApplicationThread = (applicationId) =>
  trpcGet("consolidatedMessaging.resolveApplicationThread", { applicationId });

export async function crmPage(filters, cursor) {
  return trpcGet("candidateUser.getCRMExternalCandidates", cursor ? { filters, cursor } : { filters });
}

/**
 * Serial session check that distinguishes a dead session from a blip:
 * three probes with pauses; expired only if ALL fail with auth errors.
 */
export async function sessionState() {
  if (!hasCookie() ) return "no_cookie";
  for (let i = 0; i < 3; i++) {
    try {
      const me = await trpcGet("user.getCurrentUser", {}, { tries: 1 });
      if (me?.id) return "live";
    } catch (e) {
      if (!(e instanceof AuthExpired)) return "error";
    }
    await sleep(700);
  }
  return "expired";
}

// ---------------------------------------------------------------- write ----

// replyTo is the "application:<applicationId>" subthread id. Without it the
// text posts as a plain thread message instead of a comment on the candidate.
export function sendComment({ threadId, text, replyTo }) {
  if (!threadId) throw new Error("SEND_THREAD_ID_REQUIRED");
  if (!text || !text.trim()) throw new Error("SEND_TEXT_REQUIRED");
  if (!replyTo || !replyTo.startsWith("application:")) throw new Error("SEND_REPLY_TO_REQUIRED");
  return trpcPost("consolidatedMessaging.send", { threadId, text, replyTo });
}
