// Narrow, operator-controlled brakes for background workflows that can touch
// Paraform.  A missing key deliberately preserves the normal runtime.  A
// malformed or unreadable key fails closed so a transient control-plane outage
// cannot turn an intended pause into more provider traffic.
export const PARAFORM_BACKGROUND_PAUSE_KEYS = Object.freeze({
  paraaiWorker: "ops:paraform-background-pause:v1:paraai-worker",
  dashboardReaders: "ops:paraform-background-pause:v1:dashboard-readers",
  // The two Para AI interview-request lanes (candidate outreach email and
  // expired-match actioning). David turned them back on 2026-09-25 while the
  // rest of the worker stays under `paraaiWorker`, so they answer to this key
  // instead, in both worker states.
  paraaiRequestLanes: "ops:paraform-background-pause:v1:paraai-request-lanes",
});

const PAUSE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function controlUnavailable() {
  const error = new Error("background pause control unavailable");
  error.code = "BACKGROUND_PAUSE_CONTROL_UNAVAILABLE";
  return error;
}

function unavailable() {
  return { paused: true, state: "unreadable" };
}

export function canonicalBackgroundPauseRecord(pauseId) {
  if (typeof pauseId !== "string") return null;
  const value = pauseId;
  if (!PAUSE_ID.test(value)) return null;
  return JSON.stringify({ pauseId: value, paused: true });
}

export function backgroundPauseStatusFromRaw(raw) {
  if (raw === null || raw === undefined) return { paused: false, state: "absent" };
  if (typeof raw !== "string") return unavailable();
  try {
    const record = JSON.parse(raw);
    if (
      !record
      || typeof record !== "object"
      || Array.isArray(record)
      || Object.keys(record).length !== 2
      || record.paused !== true
      || typeof record.pauseId !== "string"
      || !PAUSE_ID.test(record.pauseId)
    ) return unavailable();
    return { paused: true, state: "configured", pauseId: record.pauseId };
  } catch {
    return unavailable();
  }
}

export async function backgroundPauseKvCommand(command, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const baseUrl = String(env.KV_REST_API_URL || "").replace(/\/+$/, "");
  const token = String(env.KV_REST_API_TOKEN || "");
  if (!baseUrl || !token || typeof fetchImpl !== "function") {
    throw controlUnavailable();
  }
  try {
    const response = await fetchImpl(baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw controlUnavailable();
    const body = await response.json();
    if (body?.error || !Object.prototype.hasOwnProperty.call(body || {}, "result")) {
      throw controlUnavailable();
    }
    return body.result;
  } catch (error) {
    if (error?.code === "BACKGROUND_PAUSE_CONTROL_UNAVAILABLE") throw error;
    throw controlUnavailable();
  }
}

export async function paraformBackgroundPauseState(scope, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = PARAFORM_BACKGROUND_PAUSE_KEYS[scope];
  if (!key) return unavailable();
  try {
    return backgroundPauseStatusFromRaw(
      await backgroundPauseKvCommand(["GET", key], { env, fetchImpl }),
    );
  } catch {
    return unavailable();
  }
}
