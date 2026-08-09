// Upstash REST KV, apphub:* namespace ONLY.
//
// Deliberately a separate tiny module (pattern: api/health/_lib/kv.mjs) rather
// than importing api/paraai/_lib/store.mjs: that module is paraai-scoped and
// its writers are single-purpose by contract. Applicants owns apphub:* and
// touches nothing else — paraai:*, hlth:*, seqguard:* are off-limits here.
//
// Write ownership (the contract — do not widen):
//   apphub:snapshot          — POST /api/applicants/sync only
//   apphub:acks              — POST /api/applicants/sync only
//   apphub:decisions         — POST /api/applicants/decision only
//   apphub:profile:<cuId>    — GET  /api/applicants/profile only (6h TTL)
//   apphub:rank:<companyId>  — GET  /api/applicants/profile only (30d TTL)

const KV_URL = String(process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";

export const kvConfigured = () => Boolean(KV_URL && KV_TOKEN);

export async function kv(command) {
  if (!kvConfigured()) throw new Error("applicants state store not configured");
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

export async function getJson(key, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", key]));
}

export async function setJson(key, value, ttlSeconds, { kvImpl = kv } = {}) {
  return kvImpl(ttlSeconds
    ? ["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)]
    : ["SET", key, JSON.stringify(value)]);
}

// Upstash REST returns HGETALL as a flat [field, value, field, value] array.
export async function hashGetAllJson(key, { kvImpl = kv } = {}) {
  const flat = await kvImpl(["HGETALL", key]);
  const out = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = parse(flat[i + 1]);
  return out;
}

export async function hashSetJson(key, fields, { kvImpl = kv } = {}) {
  const entries = Object.entries(fields || {});
  if (!entries.length) return 0;
  return kvImpl(["HSET", key, ...entries.flatMap(([field, value]) => [field, JSON.stringify(value)])]);
}

export async function hashGetJson(key, field, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["HGET", key, field]));
}

export async function hashDel(key, field, { kvImpl = kv } = {}) {
  return kvImpl(["HDEL", key, field]);
}

// `<cuId>:<roleId>` — the one field-key contract every apphub hash shares.
export const KEY_RE = /^[a-z0-9]+:[a-z0-9]+$/i;
export const validKey = (key) => typeof key === "string" && key.length <= 130 && KEY_RE.test(key);

export const PROFILE_TTL_SECONDS = 6 * 60 * 60;
export const RANK_TTL_SECONDS = 30 * 24 * 60 * 60;

export const K = {
  snapshot: "apphub:snapshot",
  decisions: "apphub:decisions",
  acks: "apphub:acks",
  profile: (cuId) => `apphub:profile:${cuId}`,
  rank: (companyId) => `apphub:rank:${companyId}`,
};
