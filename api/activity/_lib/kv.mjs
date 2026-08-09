// Upstash REST KV, activity:v1:* namespace ONLY.
//
// Same shape as api/applicants/_lib/kv.mjs (the pattern: each tab owns a tiny
// KV module scoped to its own prefix rather than importing another tab's
// store, whose writers are single-purpose by contract).
//
// Write ownership (the contract — do not widen):
//   activity:v1:feed             — GET  /api/activity/feed only (short TTL cache)
//   activity:v1:feed:lock        — GET  /api/activity/feed only (build lock)
//   activity:v1:thread:<id>      — GET  /api/activity/feed only (per-role-thread
//                                  durable cache, invalidated by getInbox)
//   activity:v1:triage           — POST /api/activity/triage only (hash)
//   activity:v1:session          — any activity route, on a Paraform-issued
//                                  rotation only (freshest wos-session value;
//                                  seeds from env, never printed)
//   activity:v1:alert:<slot>     — throttle markers for Slack alerts
//   activity:v1:digest:<day>     — GET /api/activity/digest only (once-a-day marker)

const KV_URL = String(process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";

export const kvConfigured = () => Boolean(KV_URL && KV_TOKEN);

export async function kv(command) {
  if (!kvConfigured()) throw new Error("activity state store not configured");
  const response = await fetch(KV_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`kv HTTP ${response.status}: ${String(body?.error || "request rejected").replace(/\s+/g, " ").slice(0, 180)}`);
  }
  if (body?.error) throw new Error(String(body.error).slice(0, 180));
  return body?.result ?? null;
}

const parse = (raw, fallback = null) => {
  try { return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
};

export async function getJson(key, fallback = null) {
  return parse(await kv(["GET", key]), fallback);
}

export async function setJson(key, value, { ttlSeconds } = {}) {
  const args = ["SET", key, JSON.stringify(value)];
  if (ttlSeconds) args.push("EX", String(ttlSeconds));
  return kv(args);
}

// hash used for triage: field -> JSON row
export async function hgetallJson(key) {
  const flat = (await kv(["HGETALL", key])) || [];
  const out = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = parse(flat[i + 1]);
  return out;
}

export async function hsetJson(key, field, value) {
  return kv(["HSET", key, field, JSON.stringify(value)]);
}

export async function hdel(key, field) {
  return kv(["HDEL", key, field]);
}

/** NX lock with TTL; returns true if we hold it. */
export async function acquireLock(key, ttlSeconds) {
  const r = await kv(["SET", key, "1", "NX", "EX", String(ttlSeconds)]);
  return r === "OK";
}

export async function releaseLock(key) {
  try { await kv(["DEL", key]); } catch { /* lock expires on its own */ }
}
