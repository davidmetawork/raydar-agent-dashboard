// Independent dead-man monitor for the legacy curated-fit scheduler.
//
// The routing lane currently runs on GitHub Actions. Its in-repo health job is
// useful when Actions is healthy, but shares the exact failure domain that left
// the lane silent during the 2026-08-06 Actions outage. The always-on dashboard
// worker reads the public aggregate state watermark and alerts from Vercel +
// Upstash instead. It never reads candidate records and never writes Paraform.

import { notifySlack } from "./core.mjs";
import { takeAlertSlot } from "./store.mjs";

export const CURATED_FIT_STATE_URL = String(
  process.env.PARAAI_CURATED_FIT_STATE_URL
    || "https://clients.raydar.xyz/paraai-curated-fit-heartbeat.json",
).trim();
export const CURATED_FIT_STALE_AFTER_MS = 90 * 60_000;
export const CURATED_FIT_ALERT_TTL_SECONDS = 3 * 60 * 60;
const MAX_STATE_BYTES = 2 * 1024 * 1024;

const errorDetail = (error) => String(error?.message || error)
  .replace(/\s+/g, " ")
  .slice(0, 120);

export async function curatedFitDeadmanStatus({
  fetchImpl = fetch,
  now = Date.now(),
  staleAfterMs = CURATED_FIT_STALE_AFTER_MS,
  url = CURATED_FIT_STATE_URL,
} = {}) {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response?.ok) {
      return { ok: false, code: "state_unreadable", ageMs: null, detail: `HTTP_${response?.status || 0}` };
    }
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_STATE_BYTES) {
      return { ok: false, code: "state_oversized", ageMs: null, detail: "content_length_limit" };
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_STATE_BYTES) {
      return { ok: false, code: "state_oversized", ageMs: null, detail: "body_length_limit" };
    }
    let state;
    try { state = JSON.parse(raw); } catch {
      return { ok: false, code: "state_malformed", ageMs: null, detail: "invalid_json" };
    }
    const lastRunMs = Date.parse(String(state?.lastRun || ""));
    if (state?.version !== 1 || !Number.isFinite(lastRunMs)) {
      return { ok: false, code: "state_malformed", ageMs: null, detail: "invalid_watermark" };
    }
    const ageMs = Math.max(0, Number(now) - lastRunMs);
    if (ageMs > staleAfterMs) {
      return { ok: false, code: "scheduler_stale", ageMs, detail: "last_run_too_old" };
    }
    return { ok: true, code: "healthy", ageMs, detail: null };
  } catch (error) {
    return { ok: false, code: "state_unreadable", ageMs: null, detail: errorDetail(error) };
  }
}

export async function runCuratedFitDeadmanTick({
  statusImpl = curatedFitDeadmanStatus,
  alertSlotImpl = takeAlertSlot,
  notifyImpl = notifySlack,
} = {}) {
  const status = await statusImpl();
  if (status.ok) return { ...status, alerted: false };
  const claimed = await alertSlotImpl(
    `curated-fit-deadman:${status.code}`,
    CURATED_FIT_ALERT_TTL_SECONDS,
  ).catch(() => false);
  if (claimed) {
    const age = Number.isFinite(status.ageMs)
      ? `; last run ${Math.round(status.ageMs / 60_000)} minutes ago`
      : "";
    await notifyImpl(
      `🚨 Para AI curated-fit scheduler is unhealthy (${status.code}${age}). The independent dashboard dead-man detected this outside GitHub Actions; candidate writes remain fail-closed.`,
    ).catch(() => {});
  }
  return { ...status, alerted: claimed };
}
