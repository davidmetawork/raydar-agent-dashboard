// Upstash REST KV, stat:* namespace ONLY.
//
// Same shape and discipline as api/health/_lib/kv.mjs (which owns hlth:*):
// a tiny module per namespace, reads never throw. Status owns stat:* — its
// caches for GitHub run conclusions and the clients.raydar.xyz feeds — and
// touches nothing else; hlth:* is READ-ONLY for the status plane, through
// the health module's own helpers.
const KV_URL = String(process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";

export const kvConfigured = () => Boolean(KV_URL && KV_TOKEN);

async function kv(command) {
  if (!kvConfigured()) return null;
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
  const body = await r.json().catch(() => null);
  return body?.result ?? null;
}

/** Reads never throw: a KV blip must not blank the Status page. */
export async function sGet(key) {
  try {
    const raw = await kv(["GET", key]);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  } catch {
    return null;
  }
}

/** Cache writes never throw either: losing a cache refresh must not 500 the
 *  page that just rendered fine from live data. Returns false on failure so
 *  a caller who cares can log it. */
export async function sSet(key, value, ttlSeconds) {
  try {
    await kv(ttlSeconds
      ? ["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)]
      : ["SET", key, JSON.stringify(value)]);
    return true;
  } catch {
    return false;
  }
}

export const K = {
  ghaCache: "stat:cache:gha",
  feedsCache: "stat:cache:feeds",
};
