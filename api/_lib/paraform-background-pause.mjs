// Narrow, operator-controlled brakes for background workflows that can touch
// Paraform.  A missing key deliberately preserves the normal runtime.  A
// malformed or unreadable key fails closed so a transient control-plane outage
// cannot turn an intended pause into more provider traffic.
export const PARAFORM_BACKGROUND_PAUSE_KEYS = Object.freeze({
  paraaiWorker: "ops:paraform-background-pause:v1:paraai-worker",
});

const PAUSE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function unavailable() {
  return { paused: true, state: "unreadable" };
}

function parseRecord(raw) {
  if (raw === null || raw === undefined) return { paused: false, state: "absent" };
  if (typeof raw !== "string") return unavailable();
  try {
    const record = JSON.parse(raw);
    if (
      !record
      || typeof record !== "object"
      || Array.isArray(record)
      || Object.keys(record).length !== 2
      || typeof record.paused !== "boolean"
      || typeof record.pauseId !== "string"
      || !PAUSE_ID.test(record.pauseId)
    ) return unavailable();
    return { paused: record.paused, state: "configured" };
  } catch {
    return unavailable();
  }
}

export async function paraformBackgroundPauseState(scope, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = PARAFORM_BACKGROUND_PAUSE_KEYS[scope];
  const baseUrl = String(env.KV_REST_API_URL || "").replace(/\/+$/, "");
  const token = String(env.KV_REST_API_TOKEN || "");
  if (!key || !baseUrl || !token || typeof fetchImpl !== "function") return unavailable();
  try {
    const response = await fetchImpl(baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(["GET", key]),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return unavailable();
    const body = await response.json();
    if (!Object.prototype.hasOwnProperty.call(body || {}, "result")) return unavailable();
    return parseRecord(body.result);
  } catch {
    return unavailable();
  }
}
