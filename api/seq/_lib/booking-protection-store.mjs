// ─────────────────────────────────────────────────────────────────────────────
// KV SCHEMA for the lightweight, event-driven booking-protection design
// (docs/research/booking-protection-minimum-2026-09-26.md, summary sections
// 1-7 — the appendix is superseded where it disagrees).
//
// Deliberately its OWN small REST client and its OWN key namespace
// (`seqguard:lite:*`), separate from booking-stop.mjs's `seqguard:*` (K.*).
// Two reasons:
//   1. isolation — this module can be read, reasoned about, and rolled back
//      without touching the heavily-tested legacy sweep/membership-refresh
//      code, which stays in place (unscheduled) as a documented fallback.
//   2. the one exception is intentional, not accidental: the webhook success
//      proof (`raydar-webhook-proof-v1` / the pause-canary proof) is written
//      through booking-stop.mjs's own K.raydarWebhookProof / K.raydarPauseCanaryProof
//      keys, because api/seq/health.mjs already reads those through
//      raydarWebhookProofStatus() and that reader must not need to learn a
//      second namespace. See api/seq/_lib/booking-protection-worker.mjs.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from "node:crypto";

const KV_URL = String(process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";

export const kvConfigured = () => Boolean(KV_URL && KV_TOKEN);

async function kv(command, { throwOnTransport = false } = {}) {
  if (!kvConfigured()) return null;
  try {
    const r = await fetch(KV_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KV_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`kv ${r.status}`);
    const b = await r.json().catch(() => null);
    return b?.result ?? null;
  } catch {
    if (throwOnTransport) {
      const err = new Error("KV_UNAVAILABLE");
      err.code = "KV_UNAVAILABLE";
      throw err;
    }
    return null;
  }
}

export const kvGet = async (key) => {
  const raw = await kv(["GET", key]);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};
export const kvSet = (key, value, ttlSeconds) =>
  kv(ttlSeconds
    ? ["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)]
    : ["SET", key, JSON.stringify(value)]);
export const kvSetNx = (key, value, ttlSeconds) =>
  kv(["SET", key, JSON.stringify(value), "EX", String(ttlSeconds), "NX"], { throwOnTransport: true });
export const kvDel = (key) => kv(["DEL", key], { throwOnTransport: true });
export const kvIncr = (key) => kv(["INCR", key], { throwOnTransport: true });
export const kvExpire = (key, ttlSeconds) => kv(["EXPIRE", key, String(ttlSeconds)]);
export const kvSadd = (key, member) => kv(["SADD", key, member], { throwOnTransport: true });
export const kvSrem = (key, member) => kv(["SREM", key, member], { throwOnTransport: true });
export const kvSmembers = async (key) =>
  (await kv(["SMEMBERS", key], { throwOnTransport: true })) || [];
export const kvScard = async (key) => Number((await kv(["SCARD", key])) || 0);

function secureKeyFragment(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

export const LITE_KEYS = {
  // The set of eventIds waiting for the background matcher. Bounded by
  // booking volume between worker ticks (every 5-15 minutes) — a handful at
  // most, never the whole population.
  pendingSet: "seqguard:lite:pending:set:v1",
  pending: (eventId) => `seqguard:lite:pending:job:${secureKeyFragment(eventId)}`,
  // The daily live-set index: email -> [{ccu,cu,n,s,sn,t}], built once a day
  // (or on manual rebuild — see api/seq/booking-liveset-refresh.mjs) from only
  // ENABLED, name-matched protected sequences that still have an active lead.
  // Consulting it costs 0 Paraform requests.
  liveSet: "seqguard:lite:liveset:v1",
  liveSetAttempt: "seqguard:lite:liveset:attempt:v1",
  // Daily catch-up bookkeeping: which booking ids the catch-up (or the worker)
  // has already resolved, so the reconciliation pass only acts on what the
  // webhook path missed.
  processed: (bookingId) => `seqguard:lite:processed:${secureKeyFragment(bookingId)}`,
  catchupAttempt: "seqguard:lite:catchup:attempt:v1",
  // Book Time rotor cursor (David's gap: connector bookings made on Paraform's
  // own Book Time page emit no webhook at all).
  bookTimeRotor: "seqguard:lite:booktime:rotor:v1",
  // Paraform request pacer state + a per-day request counter (item 6: "count
  // every request").
  pace: "seqguard:lite:pace:v1",
  paceCount: (day) => `seqguard:lite:pace:count:${day}`,
};

export const LIVESET_SCHEMA = "raydar-booking-liveset-v1";
// A day, plus slack for a slow or late daily run. Deliberately looser than the
// legacy snapshot's 60-minute ceiling (booking-stop-contract.mjs
// BOOKING_MEMBERSHIP_MAX_AGE_MS) — that ceiling existed to bound a 10-minute
// refresh's own worst case; this index is refreshed once a day by design.
export const LIVESET_MAX_AGE_MS = 36 * 3600 * 1000;
