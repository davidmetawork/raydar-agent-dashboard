// Shared Upstash-REST KV client for the Para AI interview-request lanes' own
// self-throttle (candidate outreach email + expired-match actioning; see
// request-lane-throttle.mjs). Isolated from outreach-store.mjs/expired-store.mjs
// on purpose: cooldown, cadence and rate state are shared BETWEEN the two
// lanes, so they cannot live inside either lane's own single-lane store.
//
// Env fallback order (2026-09-26 review): PARAAI_REPLY_* first, matching the
// established convention for state shared BETWEEN the two lanes —
// request-claim.mjs (the cross-lane arbitration store) and expired-store.mjs
// both key off PARAAI_REPLY_KV_REST_API_URL/_TOKEN, not the outreach-only
// prefix. PARAAI_OUTREACH_*, PARAAI_REPLY_*, PARAAI_INTEREST_* and
// PARAAI_SOURCE_*_KV_REST_API_URL are independently-set env vars in this repo
// and are not guaranteed to point at the same physical Upstash instance, so
// this module falls back through BOTH per-lane prefixes (same layered
// pattern interest-store.mjs already uses) before the generic var, rather
// than defaulting straight to one lane's own prefix.
const KV_URL = String(
  process.env.PARAAI_REPLY_KV_REST_API_URL
  || process.env.PARAAI_OUTREACH_KV_REST_API_URL
  || process.env.KV_REST_API_URL
  || "",
).replace(/\/+$/, "");
const KV_TOKEN = process.env.PARAAI_REPLY_KV_REST_API_TOKEN
  || process.env.PARAAI_OUTREACH_KV_REST_API_TOKEN
  || process.env.KV_REST_API_TOKEN
  || "";

export const requestLaneStoreConfigured = () => Boolean(KV_URL && KV_TOKEN);

async function request(path, body) {
  if (!requestLaneStoreConfigured()) {
    const error = new Error("Para AI request-lane throttle store not configured");
    error.code = "REQUEST_LANE_STORE_NOT_CONFIGURED";
    throw error;
  }
  const response = await fetch(`${KV_URL}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KV_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  const raw = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* surfaced as a store failure below */ }
  if (!response.ok) {
    const detail = String(parsed?.error || parsed?.message || raw || "request rejected")
      .replace(/\s+/g, " ")
      .slice(0, 180);
    const error = new Error(`request-lane throttle store HTTP ${response.status}: ${detail}`);
    error.code = "REQUEST_LANE_STORE_REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
  return parsed;
}

export async function requestLaneKv(args) {
  const body = await request("", args);
  if (body?.error) {
    const error = new Error(String(body.error));
    error.code = "REQUEST_LANE_STORE_COMMAND_FAILED";
    throw error;
  }
  return body?.result ?? null;
}
