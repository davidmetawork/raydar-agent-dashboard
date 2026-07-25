import { timingSafeEqual } from "node:crypto";

import {
  armPhase2RemainderRelease,
  automationConfig,
  commitPhase2FirstTenCanary,
  enqueueBackfill,
  enqueueOrganicExceptions,
  phase2FirstTenCanaryStatus,
  phase2RemainderReleaseStatus,
  planPhase2FirstTenCanary,
  recoverRecentSuccessfulCalls,
  runAutoTick,
  runPhase2RemainderTick,
  sweepPhase1ResumeWaitCards,
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

export function runnerAuthorized(req) {
  const token = String(req.headers?.authorization || "")
    .replace(/^Bearer\s+/i, "");
  return equalSecret(token, process.env.PARAAI_AUTOMATION_RUNNER_KEY);
}

function requestBody(req) {
  if (req.method === "GET") return req.query || {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req.body && typeof req.body === "object" ? req.body : {};
}

export async function runAutomationCycle({
  mode = "tick",
  config: automation = automationConfig(),
  sweepImpl = sweepPhase1ResumeWaitCards,
  tickImpl = runAutoTick,
  remainderImpl = null,
} = {}) {
  let resumeSweep = null;
  let resumeSweepError = null;
  if (mode === "recover") {
    try {
      resumeSweep = await sweepImpl({ config: automation });
    } catch (error) {
      resumeSweepError = {
        error: String(error?.code || "resume_sweep_failed"),
        detail: String(error?.message || error).slice(0, 180),
      };
    }
  }
  const tick = await tickImpl({ config: automation });
  let remainder = null;
  let remainderError = null;
  if (typeof remainderImpl === "function" || storeConfigured()) {
    try {
      remainder = await (remainderImpl || runPhase2RemainderTick)({
        config: automation,
      });
    } catch (error) {
      const code = String(error?.code || "");
      remainderError = {
        error: /^PHASE2_REMAINDER_[A-Z0-9_]+$/u.test(code)
          ? code.toLowerCase()
          : "phase2_remainder_failed",
      };
    }
  }
  return {
    resumeSweep,
    resumeSweepError,
    tick,
    remainder,
    remainderError,
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ ok: false, error: "GET_or_POST_only" });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });

  const body = requestBody(req);
  const mode = String(body.mode || (req.method === "GET" ? "recover" : "tick"));
  const canaryModes = new Set([
    "phase2-first-ten-plan",
    "phase2-first-ten-commit",
    "phase2-first-ten-status",
  ]);
  const remainderModes = new Set([
    "phase2-remainder-arm",
    "phase2-remainder-tick",
    "phase2-remainder-status",
  ]);
  if (canaryModes.has(mode) || remainderModes.has(mode)) {
    if (!runnerAuthorized(req)) {
      return res.status(401).json({ ok: false, error: "runner_key_required" });
    }
    if (
      Object.prototype.hasOwnProperty.call(body, "botIds")
      || Object.prototype.hasOwnProperty.call(body, "jobIds")
      || Object.prototype.hasOwnProperty.call(body, "limit")
      || Object.prototype.hasOwnProperty.call(body, "batch")
      || Object.prototype.hasOwnProperty.call(body, "batchSize")
      || Object.prototype.hasOwnProperty.call(body, "cursor")
      || Object.prototype.hasOwnProperty.call(body, "force")
    ) {
      return res.status(400).json({
        ok: false,
        error: "caller_selection_forbidden",
      });
    }
    const allowedFields = new Map([
      ["phase2-first-ten-plan", new Set(["mode"])],
      [
        "phase2-first-ten-commit",
        new Set(["mode", "manifestDigest"]),
      ],
      ["phase2-first-ten-status", new Set(["mode"])],
      [
        "phase2-remainder-arm",
        new Set(["mode", "canaryManifestDigest"]),
      ],
      ["phase2-remainder-tick", new Set(["mode"])],
      ["phase2-remainder-status", new Set(["mode"])],
    ]).get(mode);
    if (
      allowedFields
      && Object.keys(body).some(
        (field) => !allowedFields.has(field),
      )
    ) {
      return res.status(400).json({
        ok: false,
        error: "caller_parameters_forbidden",
      });
    }
    if (
      ["phase2-first-ten-plan", "phase2-first-ten-commit"].includes(mode)
      && req.method !== "POST"
    ) {
      return res.status(405).json({
        ok: false,
        error: "canary_mutation_POST_only",
      });
    }
    if (
      ["phase2-remainder-arm", "phase2-remainder-tick"].includes(mode)
      && req.method !== "POST"
    ) {
      return res.status(405).json({
        ok: false,
        error: "remainder_mutation_POST_only",
      });
    }
  }
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
      if (
        req.method !== "POST"
        || !runnerAuthorized(req)
        || process.env.PARAAI_BACKFILL_RAW_ENQUEUE_BREAK_GLASS !== "true"
      ) {
        return res.status(403).json({
          ok: false,
          error: "raw_enqueue_disabled",
        });
      }
      const botIds = Array.isArray(body.botIds) ? body.botIds.slice(0, 10) : [];
      if (!botIds.length) return res.status(400).json({ ok: false, error: "botIds_required" });
      const results = await enqueueBackfill(botIds);
      return res.status(200).json({
        ok: results.every((result) => (
          result?.enqueued === true || result?.duplicate === true
        )),
        attempted: results.length,
        enqueued: results.filter((result) => result?.enqueued === true).length,
        duplicate: results.filter((result) => result?.duplicate === true).length,
        failed: results.filter((result) => (
          result?.enqueued !== true && result?.duplicate !== true
        )).length,
        queue: await getAutoQueueStats(),
      });
    }
    if (mode === "phase1-exceptions") {
      const results = await enqueueOrganicExceptions();
      return res.status(200).json({
        ok: true,
        enqueued: results.filter((result) => result.enqueued).length,
        total: results.length,
        queue: await getAutoQueueStats(),
      });
    }
    if (mode === "resume-wait-sweep") {
      const sweep = await sweepPhase1ResumeWaitCards();
      return res.status(200).json({
        ok: true,
        sweep,
        queue: await getAutoQueueStats(),
      });
    }
    if (mode === "phase2-first-ten-plan") {
      const canary = await planPhase2FirstTenCanary();
      return res.status(200).json({
        ...canary,
        queue: await getAutoQueueStats(),
      });
    }
    if (mode === "phase2-first-ten-commit") {
      const canary = await commitPhase2FirstTenCanary({
        manifestDigest: body.manifestDigest,
      });
      return res.status(200).json({
        ...canary,
        queue: await getAutoQueueStats(),
      });
    }
    if (mode === "phase2-first-ten-status") {
      const canary = await phase2FirstTenCanaryStatus();
      return res.status(200).json({
        ...canary,
        queue: await getAutoQueueStats(),
      });
    }
    if (mode === "phase2-remainder-arm") {
      const remainder = await armPhase2RemainderRelease({
        canaryManifestDigest: body.canaryManifestDigest,
      });
      return res.status(200).json(remainder);
    }
    if (mode === "phase2-remainder-tick") {
      return res.status(200).json(await runPhase2RemainderTick());
    }
    if (mode === "phase2-remainder-status") {
      return res.status(200).json(await phase2RemainderReleaseStatus());
    }
    if (!new Set(["tick", "recover"]).has(mode)) {
      return res.status(400).json({ ok: false, error: "unsupported_mode" });
    }
    const automation = automationConfig();
    const {
      resumeSweep,
      resumeSweepError,
      tick,
      remainder,
      remainderError,
    } = await runAutomationCycle({ mode, config: automation });
    if (
      resumeSweepError &&
      await takeAlertSlot("resume-wait-sweep-failed", 3600).catch(() => false)
    ) {
      await notifySlack(
        `🚨 Para AI resume-wait sweep failed (${resumeSweepError.error}). Direct-submit queue processing continued.`,
      ).catch(() => {});
    }
    const remainderIssue = remainderError?.error || (
      remainder?.ok === false ? remainder.status : null
    );
    if (
      remainderIssue
      && await takeAlertSlot(
        "phase2-remainder-controller-degraded",
        3600,
      ).catch(() => false)
    ) {
      await notifySlack(
        `🚨 Para AI Phase 2 remainder controller requires review (${remainderIssue}). Normal queue processing continued.`,
      ).catch(() => {});
    }
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
      degraded: Boolean(
        recoveryError
        || resumeSweepError
        || outreachError
        || remainderError
        || remainder?.ok === false
      ),
      recovery,
      recoveryError,
      resumeSweep,
      resumeSweepError,
      outreach,
      outreachError,
      tick,
      remainder,
      remainderError,
      queue: await getAutoQueueStats(),
    });
  } catch (error) {
    if (remainderModes.has(mode)) {
      const code = String(error?.code || "");
      const safeCode = /^PHASE2_REMAINDER_[A-Z0-9_]+$/u.test(code)
        ? code.toLowerCase()
        : "phase2_remainder_failed";
      const status = new Set([
        "PHASE2_REMAINDER_DIGEST_INVALID",
        "PHASE2_REMAINDER_TIMESTAMP_INVALID",
        "PHASE2_REMAINDER_ANCHOR_INVALID",
      ]).has(code)
        ? 400
        : new Set([
            "PHASE2_REMAINDER_ANCHOR_CONFLICT",
            "PHASE2_REMAINDER_CANARY_NOT_VERIFIED",
            "PHASE2_REMAINDER_DIGEST_MISMATCH",
            "PHASE2_REMAINDER_INDEX_LIMIT",
            "PHASE2_REMAINDER_JOB_CHANGED",
            "PHASE2_REMAINDER_MANIFEST_CONFLICT",
            "PHASE2_REMAINDER_RECORD_INVALID",
            "PHASE2_REMAINDER_SNAPSHOT_CHANGED",
            "PHASE2_REMAINDER_SNAPSHOT_INCOMPLETE",
          ]).has(code)
          ? 409
          : 500;
      return res.status(status).json({
        ok: false,
        error: safeCode,
      });
    }
    if (canaryModes.has(mode)) {
      const code = String(error?.code || "");
      const safeCode = /^PHASE2_CANARY_[A-Z0-9_]+$/u.test(code)
        ? code.toLowerCase()
        : "phase2_canary_failed";
      const status = new Set([
        "PHASE2_CANARY_DIGEST_INVALID",
        "PHASE2_CANARY_TIMESTAMP_INVALID",
      ]).has(code)
        ? 400
        : new Set([
            "PHASE2_CANARY_DIGEST_MISMATCH",
            "PHASE2_CANARY_INDEX_LIMIT",
            "PHASE2_CANARY_JOB_CHANGED",
            "PHASE2_CANARY_PLAN_REQUIRED",
            "PHASE2_CANARY_SNAPSHOT_CHANGED",
            "PHASE2_CANARY_SNAPSHOT_INCOMPLETE",
          ]).has(code)
          ? 409
          : 500;
      return res.status(status).json({
        ok: false,
        error: safeCode,
      });
    }
    return res.status(500).json({
      ok: false,
      error: String(error?.code || "worker_failed"),
      detail: String(error?.message || error).slice(0, 240),
    });
  }
}
