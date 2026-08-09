// Independent scheduler for the lifecycle watchdog.
//
// GitHub scheduled events are best-effort and can be delayed or dropped. This
// Vercel cron checks the workflow's newest run on an offset cadence and only
// dispatches it when GitHub has not started one recently. The dispatched
// workflow remains the single implementation of endpoint probes, auto-heal,
// cron verification, and the Health-tab heartbeat.

import { cronAuth } from "../seq/_lib/core.mjs";

export const config = { maxDuration: 30 };

const API = "https://api.github.com";
const REPO = "davidmetawork/raydar";
const WORKFLOW = "lifecycle-lane-watchdog.yml";
const FRESH_MS = 20 * 60 * 1000;

function headers(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "raydar-lifecycle-watchdog-relay",
    "x-github-api-version": "2022-11-28",
  };
}

async function request(url, options, fetchImpl) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 429 && response.status < 500) return response;
      lastError = new Error(`GitHub HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError || new Error("GitHub request failed");
}

export async function runLifecycleWatchdogRelay({
  token = process.env.GH_ACTIONS_DISPATCH_TOKEN || "",
  fetchImpl = fetch,
  nowMs = Date.now(),
} = {}) {
  if (!token) return { ok: false, status: 503, error: "dispatch_token_missing" };

  const workflowUrl = `${API}/repos/${REPO}/actions/workflows/${WORKFLOW}`;
  let latestResponse;
  try {
    latestResponse = await request(
      `${workflowUrl}/runs?per_page=1`,
      { headers: headers(token) },
      fetchImpl,
    );
  } catch (error) {
    console.error("lifecycle_watchdog_relay_read_failed", {
      error: String(error?.message || error).slice(0, 160),
    });
    return { ok: false, status: 502, error: "github_read_failed" };
  }

  if (!latestResponse.ok) {
    console.error("lifecycle_watchdog_relay_read_rejected", { status: latestResponse.status });
    return { ok: false, status: 502, error: "github_read_rejected" };
  }

  const latestBody = await latestResponse.json().catch(() => ({}));
  const latest = latestBody?.workflow_runs?.[0] || null;
  const createdMs = Date.parse(latest?.created_at || "");
  const ageMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : null;

  if (ageMs != null && ageMs <= FRESH_MS) {
    return {
      ok: true,
      action: "skipped_recent_run",
      latestRunId: latest.id || null,
      ageMin: Math.floor(ageMs / 60_000),
    };
  }

  let dispatchResponse;
  try {
    dispatchResponse = await request(
      `${workflowUrl}/dispatches`,
      {
        method: "POST",
        headers: { ...headers(token), "content-type": "application/json" },
        body: JSON.stringify({ ref: "main" }),
      },
      fetchImpl,
    );
  } catch (error) {
    console.error("lifecycle_watchdog_relay_dispatch_failed", {
      error: String(error?.message || error).slice(0, 160),
    });
    return { ok: false, status: 502, error: "github_dispatch_failed" };
  }

  if (dispatchResponse.status !== 204) {
    console.error("lifecycle_watchdog_relay_dispatch_rejected", { status: dispatchResponse.status });
    return { ok: false, status: 502, error: "github_dispatch_rejected" };
  }

  return {
    ok: true,
    action: "dispatched",
    previousRunId: latest?.id || null,
    previousAgeMin: ageMs == null ? null : Math.floor(ageMs / 60_000),
  };
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const auth = cronAuth(req);
  if (!auth.ok) {
    return res.status(auth.reason === "no_cron_secret" ? 503 : 401)
      .json({ ok: false, error: auth.reason });
  }

  const result = await runLifecycleWatchdogRelay();
  return res.status(result.status || 200).json(result);
}
