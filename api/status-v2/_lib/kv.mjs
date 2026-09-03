// Upstash REST KV, statv2:* namespace ONLY.
//
// Same shape and discipline as api/status/_lib/kv.mjs (which owns stat:*): a
// tiny module per namespace, reads never throw, writes never throw. Status v2
// owns statv2:* — its memoised source reads, its per-system change ring and
// the last-seen snapshot it diffs against — and touches nothing else.
// apphub:* is READ-ONLY here, through the applicants module's own helper.
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

/** Reads never throw: a KV blip must not blank the page. */
export async function vGet(key) {
  try {
    const raw = await kv(["GET", key]);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  } catch {
    return null;
  }
}

/** Writes never throw either: losing a memo must not 500 a page that rendered
 *  fine from live data. Returns false so a caller who cares can see it. */
export async function vSet(key, value, ttlSeconds) {
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
  health: "statv2:memo:health",
  metrics: "statv2:memo:metrics",
  funnel: "statv2:memo:funnel",
  events: (systemId) => `statv2:events:${systemId}`,
  last: (systemId) => `statv2:last:${systemId}`,
};

// Memos are short-lived by design; the ring is kept a week so "since you last
// looked" survives a weekend away.
export const MEMO_TTL_S = 15 * 60;
export const RING_TTL_S = 7 * 24 * 3600;
