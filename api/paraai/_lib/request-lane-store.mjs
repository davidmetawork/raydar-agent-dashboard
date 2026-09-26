// Shared Upstash-REST KV client for the Para AI interview-request lanes' own
// self-throttle (candidate outreach email + expired-match actioning; see
// request-lane-throttle.mjs). Isolated from outreach-store.mjs/expired-store.mjs
// on purpose: cooldown, cadence and rate state are shared BETWEEN the two
// lanes, so they cannot live inside either lane's own single-lane store.
// Same physical store as the outreach state (same env fallback order), just a
// separate module so a lane's store outage can never be confused with this
// throttle's own.
const KV_URL = String(
  process.env.PARAAI_OUTREACH_KV_REST_API_URL
  || process.env.KV_REST_API_URL
  || "",
).replace(/\/+$/, "");
const KV_TOKEN = process.env.PARAAI_OUTREACH_KV_REST_API_TOKEN
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
