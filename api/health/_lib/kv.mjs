// Upstash REST KV, hlth:* namespace ONLY.
//
// Deliberately a separate tiny module rather than importing api/seq/_lib/
// booking-stop.mjs: that module is seqguard-scoped, pulls a large dependency
// tree, and its writers are single-purpose by contract. Health owns hlth:*
// and touches nothing else — seqguard:* and paraai:* are READ-ONLY here.
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

/** Reads never throw: a KV blip must not blank the board. */
export async function hGet(key) {
  try {
    const raw = await kv(["GET", key]);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  } catch {
    return null;
  }
}

export async function hGetMany(keys) {
  if (!keys.length) return [];
  try {
    const raw = await kv(["MGET", ...keys]);
    if (!Array.isArray(raw)) return keys.map(() => null);
    return raw.map((value) => {
      if (value == null) return null;
      try { return JSON.parse(value); } catch { return null; }
    });
  } catch {
    return keys.map(() => null);
  }
}

/** Writes DO throw so the tick can report its own storage failure honestly. */
export function hSet(key, value, ttlSeconds) {
  return kv(ttlSeconds
    ? ["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)]
    : ["SET", key, JSON.stringify(value)]);
}

/** "OK" when won, null when already held. Never throws — used for alert dedupe,
 *  where the safe failure is to alert rather than to go quiet. */
export async function hSetNx(key, value, ttlSeconds) {
  try {
    return await kv(["SET", key, JSON.stringify(value), "EX", String(ttlSeconds), "NX"]);
  } catch {
    return "OK";
  }
}

export async function hDel(key) {
  try { return await kv(["DEL", key]); } catch { return null; }
}

export const K = {
  state: "hlth:state",
  samples: (id) => `hlth:samples:${id}`,
  trans: (id) => `hlth:trans:${id}`,
  beat: (lane) => `hlth:beat:${lane}`,
  ack: (id) => `hlth:ack:${id}`,
  alertSent: (id, state) => `hlth:alert:sent:${id}:${state}`,
  lastDelivered: "hlth:alert:lastDelivered",
  incident: (id, openedAt) => `hlth:incident:${id}:${openedAt}`,
  incidentIndex: "hlth:incidents",
  selftest: "hlth:selftest",
  digestSent: (day) => `hlth:digest:${day}`,
};
