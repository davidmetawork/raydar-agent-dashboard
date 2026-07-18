import { timingSafeEqual } from "node:crypto";

import {
  automationConfig,
  enqueueBackfill,
  recoverRecentSuccessfulCalls,
  runAutoTick,
} from "./_lib/auto.mjs";
import { notifySlack } from "./_lib/core.mjs";
import { outreachHealth, runOutreachTick } from "./_lib/outreach.mjs";
import { getAutoQueueStats, storeConfigured, takeAlertSlot } from "./_lib/store.mjs";

export const config = { maxDuration: 120 };

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req) {
  const token = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  return [process.env.PARAAI_AUTOMATION_RUNNER_KEY, process.env.CRON_SECRET]
    .filter(Boolean)
    .some((secret) => equalSecret(token, secret));
}

function requestBody(req) {
  if (req.method === "GET") return req.query || {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req.body && typeof req.body === "object" ? req.body : {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ ok: false, error: "GET_or_POST_only" });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });

  const body = requestBody(req);
  const mode = String(body.mode || (req.method === "GET" ? "recover" : "tick"));
  try {
    if (mode === "status") {
      return res.status(200).json({
        ok: true,
        config: automationConfig(),
        queue: await getAutoQueueStats(),
        outreach: await outreachHealth(),
      });
    }
    if (mode === "enqueue") {
      const botIds = Array.isArray(body.botIds) ? body.botIds.slice(0, 10) : [];
      if (!botIds.length) return res.status(400).json({ ok: false, error: "botIds_required" });
      return res.status(200).json({ ok: true, results: await enqueueBackfill(botIds), queue: await getAutoQueueStats() });
    }
    if (!new Set(["tick", "recover"]).has(mode)) {
      return res.status(400).json({ ok: false, error: "unsupported_mode" });
    }
    const tick = await runAutoTick();
    let outreach = null;
    let outreachError = null;
    try {
      outreach = await runOutreachTick();
    } catch (error) {
      outreachError = {
        error: String(error?.code || "outreach_failed"),
        detail: String(error?.message || error).slice(0, 180),
      };
      if (await takeAlertSlot("outreach-worker-failed", 3600).catch(() => false)) {
        await notifySlack(
          `🚨 Para AI outreach worker failed (${outreachError.error}). Direct-submit queue processing continued.`,
        ).catch(() => {});
      }
    }
    let recovery = null;
    let recoveryError = null;
    if (mode === "recover") {
      try {
        recovery = await recoverRecentSuccessfulCalls();
      } catch (error) {
        recoveryError = {
          error: String(error?.code || "recovery_failed"),
          detail: String(error?.message || error).slice(0, 180),
        };
        if (await takeAlertSlot("auto-recovery-failed", 3600).catch(() => false)) {
          await notifySlack(
            `🚨 Para AI recovery scan failed (${recoveryError.error}). Durable queue processing continued; inspect worker health.`,
          ).catch(() => {});
        }
      }
    }
    return res.status(200).json({
      ok: true,
      degraded: Boolean(recoveryError || outreachError),
      recovery,
      recoveryError,
      outreach,
      outreachError,
      tick,
      queue: await getAutoQueueStats(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: String(error?.code || "worker_failed"),
      detail: String(error?.message || error).slice(0, 240),
    });
  }
}
