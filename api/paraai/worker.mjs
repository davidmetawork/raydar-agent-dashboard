import { createHash, timingSafeEqual } from "node:crypto";

import {
  armPhase2RemainderRelease,
  armPhase3ShadowRelease,
  automationConfig,
  commitPhase2FirstTenCanary,
  enqueueBackfill,
  enqueueOrganicExceptions,
  phase2FirstTenCanaryStatus,
  phase2RemainderReleaseStatus,
  phase3ShadowExecutionEnabled,
  phase3ShadowReleaseStatus,
  planPhase2FirstTenCanary,
  recoverRecentSuccessfulCalls,
  runAutoTick,
  runPhase2RemainderTick,
  runPhase3ShadowReleaseTick,
  sweepPhase1ResumeWaitCards,
} from "./_lib/auto.mjs";
import { runAuthProbeTick } from "./_lib/auth-probe.mjs";
import { runCuratedFitDeadmanTick } from "./_lib/curated-fit-deadman.mjs";
import { runStuckWatchdogTick } from "./_lib/stuck-watchdog.mjs";
import { notifySlack } from "./_lib/core.mjs";
import {
  PHASE3_AGGREGATE_ALERT_KEY,
  PHASE3_AGGREGATE_ALERT_TTL_SECONDS,
} from "./_lib/phase3-shadow-policy.mjs";
import { outreachHealth, runOutreachTick } from "./_lib/outreach.mjs";
import { replyHealth, runReplyTick } from "./_lib/reply.mjs";
import { expiredHealth, runExpiredTick } from "./_lib/expired.mjs";
import { interestStatus, runInterestTick } from "./_lib/interest.mjs";
import {
  runPhase4SourceCaptureTick,
} from "./_lib/source-capture-coordinator.mjs";
import {
  armResumeOnlyBackfillRemainder,
  commitResumeOnlyBackfillRecovery,
  commitResumeOnlyBackfillFirstTen,
  planResumeOnlyBackfillRecovery,
  resumeOnlyBackfillDiagnostics,
  resumeOnlyBackfillRecoveryStatus,
  resumeOnlyBackfillStatus,
  runResumeOnlyBackfillPlanTick,
  runResumeOnlyBackfillReleaseTick,
  verifyResumeOnlyBackfillFirstTen,
} from "./_lib/resume-only-backfill.mjs";
import {
  enqueueAutoJob,
  getAutoQueueStats,
  listJobs,
  recordPhase3ShadowAggregateAuditResult,
  storeConfigured,
  takeAlertSlot,
} from "./_lib/store.mjs";

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

export function phase3AggregateAuditFailure(status) {
  if (
    !status
    || typeof status !== "object"
    || status.status === "not_armed"
  ) return { checked: false, reason: null };
  if (
    ["armed", "running"].includes(String(status.status || ""))
    || Number(status.pendingRelease) > 0
    || Number(status.claimed) > 0
  ) {
    return { checked: false, reason: null };
  }
  const checks = [
    ["candidate_facing_write", status.candidateFacingWrites],
    ["curation_write", status.curationWrites],
    ["enrollment_write", status.enrollments],
    ["policy_mismatch", status.policyMismatches],
    ["invalid_audit", status.invalidAudits],
    ["hard_technical_failure", status.hardTechnicalFailures],
    ["release_review", status.releaseReview],
    ["missing_release_job", status.missing],
  ];
  const failed = checks.find(([, value]) => Number(value) > 0);
  if (failed) return { checked: true, reason: failed[0] };
  if (status.shadowFenceIntact === false) {
    return { checked: true, reason: "shadow_fence_broken" };
  }
  if (status.status === "snapshot_incomplete") {
    return { checked: true, reason: "snapshot_incomplete" };
  }
  return { checked: true, reason: null };
}

export function phase3AggregateSafetyDigest(status) {
  const safetyState = {
    candidateFacingWrites:
      Math.max(0, Number(status?.candidateFacingWrites) || 0),
    curationWrites: Math.max(0, Number(status?.curationWrites) || 0),
    enrollments: Math.max(0, Number(status?.enrollments) || 0),
    policyMismatches:
      Math.max(0, Number(status?.policyMismatches) || 0),
    invalidAudits: Math.max(0, Number(status?.invalidAudits) || 0),
    hardTechnicalFailures:
      Math.max(0, Number(status?.hardTechnicalFailures) || 0),
    activeRetryFailures:
      Math.max(0, Number(status?.activeRetryFailures) || 0),
    releaseReview: Math.max(0, Number(status?.releaseReview) || 0),
    missing: Math.max(0, Number(status?.missing) || 0),
    shadowFenceBroken: status?.shadowFenceIntact === false,
    snapshotIncomplete: status?.status === "snapshot_incomplete",
  };
  return createHash("sha256")
    .update(JSON.stringify(safetyState))
    .digest("hex");
}

function phase3AggregateAlertSlotKey(health) {
  const episode = Number(health?.failureEpisodeStartedAtMs);
  return Number.isSafeInteger(episode) && episode > 0
    ? `${PHASE3_AGGREGATE_ALERT_KEY}:${episode}`
    : PHASE3_AGGREGATE_ALERT_KEY;
}

export async function phase3ShadowStatusWithEscalation({
  statusImpl = phase3ShadowReleaseStatus,
  recordImpl = recordPhase3ShadowAggregateAuditResult,
  alertSlotImpl = takeAlertSlot,
  notifyImpl = notifySlack,
} = {}) {
  let status;
  try {
    status = await statusImpl();
  } catch (cause) {
    try {
      const health = await recordImpl({
        failed: true,
        reason: "status_check_failed",
        exception: true,
      });
      if (
        health.shouldAlert
        && await alertSlotImpl(
          phase3AggregateAlertSlotKey(health),
          PHASE3_AGGREGATE_ALERT_TTL_SECONDS,
        )
      ) {
        await notifyImpl(
          "🚨 Para AI Phase 3 shadow aggregate audit failed on consecutive status checks (status_check_failed). Shadow write fences remain authoritative.",
        );
      }
    } catch { /* preserve the primary status failure */ }
    throw cause;
  }
  const audit = phase3AggregateAuditFailure(status);
  if (!audit.checked) return status;
  let health = null;
  try {
    health = await recordImpl({
      failed: Boolean(audit.reason),
      reason: audit.reason || "clean",
      manifestDigest: status.manifestDigest,
      evidenceAt: status.lastAuditAt,
      readCount: Math.max(0, Number(status.matchReads) || 0),
      decisions: Math.max(0, Number(status.decisions) || 0),
      safetyDigest: phase3AggregateSafetyDigest(status),
    });
    if (
      health.shouldAlert
      && await alertSlotImpl(
        phase3AggregateAlertSlotKey(health),
        PHASE3_AGGREGATE_ALERT_TTL_SECONDS,
      )
    ) {
      await notifyImpl(
        `🚨 Para AI Phase 3 shadow aggregate audit failed on ${health.failureStreak} consecutive status checks (${health.reason}). Shadow write fences remain authoritative.`,
      );
    }
  } catch { /* status remains authoritative; the next check retries the streak */ }
  return {
    ...status,
    ...(health ? {
      auditFailureStreak: health.failureStreak,
      aggregateAuditFailing: health.failing,
    } : {
      auditHealthRecorded: false,
    }),
  };
}

export async function runAutomationCycle({
  mode = "tick",
  config: automation = automationConfig(),
  sweepImpl = sweepPhase1ResumeWaitCards,
  tickImpl = runAutoTick,
  remainderImpl = null,
  resumeOnlyBackfillImpl = null,
  phase3ReleaseImpl = null,
  phase3StatusImpl = null,
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
  let resumeOnlyBackfill = null;
  let resumeOnlyBackfillError = null;
  if (
    typeof resumeOnlyBackfillImpl === "function"
    || storeConfigured()
  ) {
    try {
      resumeOnlyBackfill = await (
        resumeOnlyBackfillImpl
        || runResumeOnlyBackfillReleaseTick
      )();
    } catch (error) {
      const code = String(error?.code || "");
      resumeOnlyBackfillError = {
        error: /^RESUME_ONLY_BACKFILL_[A-Z0-9_]+$/u.test(code)
          ? code.toLowerCase()
          : "resume_only_backfill_failed",
      };
    }
  }
  let phase3Release = null;
  let phase3ReleaseError = null;
  if (typeof phase3ReleaseImpl === "function" || storeConfigured()) {
    try {
      phase3Release = await (
        phase3ReleaseImpl || runPhase3ShadowReleaseTick
      )({
        config: automation,
      });
    } catch (error) {
      const code = String(error?.code || "");
      phase3ReleaseError = {
        error: /^PHASE3_SHADOW_RELEASE_[A-Z0-9_]+$/u.test(code)
          ? code.toLowerCase()
          : "phase3_shadow_release_failed",
      };
    }
  }
  let phase3Status = null;
  let phase3StatusError = null;
  if (
    phase3ShadowExecutionEnabled(automation)
    && (typeof phase3StatusImpl === "function" || storeConfigured())
  ) {
    try {
      phase3Status = await phase3ShadowStatusWithEscalation({
        statusImpl: phase3StatusImpl || phase3ShadowReleaseStatus,
      });
    } catch (error) {
      phase3StatusError = {
        error: "phase3_shadow_status_failed",
      };
    }
  }
  return {
    resumeSweep,
    resumeSweepError,
    tick,
    remainder,
    remainderError,
    resumeOnlyBackfill,
    resumeOnlyBackfillError,
    phase3Release,
    phase3ReleaseError,
    phase3Status,
    phase3StatusError,
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ ok: false, error: "GET_or_POST_only" });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });

  const body = requestBody(req);
  const query = req?.query && typeof req.query === "object"
    ? req.query
    : {};
  const requestedMode = body.mode
    ?? (req.method === "GET" ? "recover" : "tick");
  const mode = typeof requestedMode === "string"
    ? requestedMode
    : "";
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
  const phase3Modes = new Set([
    "phase3-shadow-arm",
    "phase3-shadow-status",
  ]);
  const phase4SourceModes = new Set([
    "phase4-source-capture-tick",
  ]);
  const resumeOnlyBackfillModes = new Set([
    "resume-only-backfill-plan",
    "resume-only-backfill-commit-first-ten",
    "resume-only-backfill-verify-first-ten",
    "resume-only-backfill-arm",
    "resume-only-backfill-tick",
    "resume-only-backfill-status",
    "resume-only-backfill-diagnostics",
    "resume-only-backfill-recovery-plan",
    "resume-only-backfill-recovery-commit",
    "resume-only-backfill-recovery-status",
  ]);
  if (
    canaryModes.has(mode)
    || remainderModes.has(mode)
    || phase3Modes.has(mode)
    || phase4SourceModes.has(mode)
    || resumeOnlyBackfillModes.has(mode)
  ) {
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
      ["phase3-shadow-arm", new Set(["mode"])],
      ["phase3-shadow-status", new Set(["mode"])],
      [
        "phase4-source-capture-tick",
        new Set(["mode"]),
      ],
      ["resume-only-backfill-plan", new Set(["mode"])],
      [
        "resume-only-backfill-commit-first-ten",
        new Set(["mode"]),
      ],
      [
        "resume-only-backfill-verify-first-ten",
        new Set(["mode"]),
      ],
      ["resume-only-backfill-arm", new Set(["mode"])],
      ["resume-only-backfill-tick", new Set(["mode"])],
      ["resume-only-backfill-status", new Set(["mode"])],
      ["resume-only-backfill-diagnostics", new Set(["mode"])],
      ["resume-only-backfill-recovery-plan", new Set(["mode"])],
      ["resume-only-backfill-recovery-commit", new Set(["mode"])],
      ["resume-only-backfill-recovery-status", new Set(["mode"])],
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
      resumeOnlyBackfillModes.has(mode)
      && Object.keys(query).some((field) => field !== "mode")
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
    if (mode === "phase3-shadow-arm" && req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "phase3_shadow_mutation_POST_only",
      });
    }
    if (
      mode === "phase4-source-capture-tick"
      && req.method !== "POST"
    ) {
      return res.status(405).json({
        ok: false,
        error: "phase4_source_capture_POST_only",
      });
    }
    if (
      resumeOnlyBackfillModes.has(mode)
      && mode !== "resume-only-backfill-status"
      && req.method !== "POST"
    ) {
      return res.status(405).json({
        ok: false,
        error: "resume_only_backfill_mutation_POST_only",
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
        reply: await replyHealth(),
        expired: await expiredHealth(),
        interest: await interestStatus(),
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
    if (mode === "phase3-shadow-arm") {
      const release = await armPhase3ShadowRelease();
      return res.status(200).json({
        ...release,
        queue: await getAutoQueueStats(),
      });
    }
    if (mode === "phase3-shadow-status") {
      return res.status(200).json(
        await phase3ShadowStatusWithEscalation(),
      );
    }
    if (mode === "phase4-source-capture-tick") {
      return res.status(200).json(
        await runPhase4SourceCaptureTick({ mode }),
      );
    }
    if (mode === "resume-only-backfill-plan") {
      return res.status(200).json(
        await runResumeOnlyBackfillPlanTick(),
      );
    }
    if (mode === "resume-only-backfill-commit-first-ten") {
      return res.status(200).json(
        await commitResumeOnlyBackfillFirstTen(),
      );
    }
    if (mode === "resume-only-backfill-verify-first-ten") {
      return res.status(200).json(
        await verifyResumeOnlyBackfillFirstTen(),
      );
    }
    if (mode === "resume-only-backfill-arm") {
      return res.status(200).json(
        await armResumeOnlyBackfillRemainder(),
      );
    }
    if (mode === "resume-only-backfill-tick") {
      return res.status(200).json(
        await runResumeOnlyBackfillReleaseTick(),
      );
    }
    if (mode === "resume-only-backfill-status") {
      return res.status(200).json(
        await resumeOnlyBackfillStatus(),
      );
    }
    if (mode === "resume-only-backfill-diagnostics") {
      return res.status(200).json(
        await resumeOnlyBackfillDiagnostics(),
      );
    }
    if (mode === "resume-only-backfill-recovery-plan") {
      return res.status(200).json(
        await planResumeOnlyBackfillRecovery(),
      );
    }
    if (mode === "resume-only-backfill-recovery-commit") {
      return res.status(200).json(
        await commitResumeOnlyBackfillRecovery(),
      );
    }
    if (mode === "resume-only-backfill-recovery-status") {
      return res.status(200).json(
        await resumeOnlyBackfillRecoveryStatus(),
      );
    }
    if (!new Set(["tick", "recover"]).has(mode)) {
      return res.status(400).json({ ok: false, error: "unsupported_mode" });
    }
    // OBSERVE-ONLY Paraform auth circuit probe (phase 1). It rides every
    // */5 tick BEFORE the lane cycle so a full AUTH_EXPIRED outage — the
    // exact condition it detects — cannot starve it behind a throwing tick,
    // its reads are time-capped so a hung Paraform call cannot eat the
    // worker budget, and it never throws into the cycle. Deliberately
    // absent from this response: the worker/monitor wiring is frozen, the
    // flag is read via GET /api/ops/paraform-auth, and no lane holds on it
    // yet. Covered by test/paraform-auth-breaker.test.mjs.
    try { await runAuthProbeTick(); } catch { /* observe-only */ }
    // Independent dead-man for the GitHub Actions curated-fit lane. This runs
    // from Vercel/Upstash so a GitHub outage cannot suppress both execution and
    // its alarm. Aggregate watermark only; no candidate data or Paraform write.
    try {
      await runCuratedFitDeadmanTick({
        alertSlotImpl: takeAlertSlot,
        notifyImpl: notifySlack,
      });
    } catch { /* observe-only */ }
    // Stuck-job watchdog. Every alert this lane had fired on an explicit error
    // code, so the 2026-08-03 outage — a Vercel-killed function that never got
    // to raise one — ran 14 hours in silence while health stayed green. This
    // watches movement instead of errors: a job that should be mid-flight and
    // has not moved is reported whatever the cause. Time-capped and never
    // throws, for the same reason as the auth probe above.
    try {
      await runStuckWatchdogTick({
        listJobsImpl: listJobs,
        alertSlotImpl: takeAlertSlot,
        notifyImpl: notifySlack,
        enqueueImpl: enqueueAutoJob,
      });
    } catch { /* observe-only */ }
    const automation = automationConfig();
    const {
      resumeSweep,
      resumeSweepError,
      tick,
      remainder,
      remainderError,
      resumeOnlyBackfill,
      resumeOnlyBackfillError,
      phase3Release,
      phase3ReleaseError,
      phase3Status,
      phase3StatusError,
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
    const resumeOnlyBackfillIssue =
      resumeOnlyBackfillError?.error || (
        resumeOnlyBackfill?.ok === false
          ? resumeOnlyBackfill.status
          : null
      );
    if (
      resumeOnlyBackfillIssue
      && await takeAlertSlot(
        "resume-only-backfill-controller-degraded",
        3600,
      ).catch(() => false)
    ) {
      await notifySlack(
        `🚨 Para AI resume-only backfill controller requires review (${resumeOnlyBackfillIssue}). Normal queue processing continued; no resume chase was opened.`,
      ).catch(() => {});
    }
    const phase3ReleaseIssue = phase3ReleaseError?.error || (
      phase3Release?.ok === false ? phase3Release.status : null
    );
    if (
      phase3ReleaseIssue
      && await takeAlertSlot(
        "phase3-shadow-release-controller-degraded",
        3600,
      ).catch(() => false)
    ) {
      await notifySlack(
        `🚨 Para AI Phase 3 shadow release requires review (${phase3ReleaseIssue}). Normal queue processing continued.`,
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
    // Reply actioning runs after outreach and is isolated the same way: a
    // classifier or Paraform failure here must never stop direct submission.
    let reply = null;
    let replyError = null;
    try {
      reply = await runReplyTick();
    } catch (error) {
      replyError = {
        error: String(error?.code || "reply_failed"),
        detail: String(error?.message || error).slice(0, 180),
      };
      if (await takeAlertSlot("reply-worker-failed", 3600).catch(() => false)) {
        await notifySlack(
          `🚨 Para AI reply actioning failed (${replyError.error}). Direct-submit and outreach processing continued.`,
        ).catch(() => {});
      }
    }
    // ORDER IS A CONTRACT: expired-match actioning runs AFTER reply actioning,
    // never before. A candidate can answer on day 6 and the request expire on
    // day 7, and whichever lane runs first takes the shared per-request claim.
    // The reply lane must get that classification pass, because a request its
    // candidate answered has a truthful outcome that "Candidate didn't get
    // back" would contradict in front of a hiring manager. Isolated the same
    // way: a Paraform failure here must never stop direct submission.
    // Covered by test/paraai-expired-worker-order.test.mjs.
    let expired = null;
    let expiredError = null;
    try {
      expired = await runExpiredTick();
    } catch (error) {
      expiredError = {
        error: String(error?.code || "expired_failed"),
        detail: String(error?.message || error).slice(0, 180),
      };
      if (await takeAlertSlot("expired-worker-failed", 3600).catch(() => false)) {
        await notifySlack(
          `🚨 Para AI expired-match actioning failed (${expiredError.error}). Direct-submit, outreach and reply processing continued.`,
        ).catch(() => {});
      }
    }
    // Curated-interest detection is the final normal actioning lane. Its own
    // durable sweep lease self-paces the expensive population read, while each
    // worker tick can still resume a previously detected submission job.
    // Failures remain isolated from every established lane.
    let interest = null;
    let interestError = null;
    try {
      interest = await runInterestTick();
    } catch (error) {
      interestError = {
        error: String(error?.code || "interest_failed"),
        detail: String(error?.message || error).slice(0, 180),
      };
      if (await takeAlertSlot("interest-worker-failed", 3600).catch(() => false)) {
        await notifySlack(
          `🚨 Para AI curated-interest worker failed (${interestError.error}). Direct-submit, outreach, reply and expired-match processing continued.`,
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
        || replyError
        || expiredError
        || interestError
        || remainderError
        || remainder?.ok === false
        || resumeOnlyBackfillError
        || resumeOnlyBackfill?.ok === false
        || phase3ReleaseError
        || phase3Release?.ok === false
        || phase3StatusError
        || phase3Status?.aggregateAuditFailing === true
      ),
      recovery,
      recoveryError,
      resumeSweep,
      resumeSweepError,
      outreach,
      outreachError,
      reply,
      replyError,
      expired,
      expiredError,
      interest,
      interestError,
      tick,
      remainder,
      remainderError,
      resumeOnlyBackfill,
      resumeOnlyBackfillError,
      phase3Release,
      phase3ReleaseError,
      phase3Status,
      phase3StatusError,
      queue: await getAutoQueueStats(),
    });
  } catch (error) {
    if (resumeOnlyBackfillModes.has(mode)) {
      const code = String(error?.code || "");
      const safeCode =
        /^RESUME_ONLY_BACKFILL_[A-Z0-9_]+$/u.test(code)
          ? code.toLowerCase()
          : "resume_only_backfill_failed";
      const status = new Set([
        "RESUME_ONLY_BACKFILL_HUMAN_CURSOR_INVALID",
        "RESUME_ONLY_BACKFILL_TIMESTAMP_INVALID",
      ]).has(code)
        ? 400
        : code === "RESUME_ONLY_BACKFILL_RECOVERY_AUTH_EXPIRED"
          ? 503
        : new Set([
            "RESUME_ONLY_BACKFILL_BUSY",
            "RESUME_ONLY_BACKFILL_CANARY_NOT_VERIFIED",
            "RESUME_ONLY_BACKFILL_CONTROL_INVALID",
            "RESUME_ONLY_BACKFILL_ENTRY_INVALID",
            "RESUME_ONLY_BACKFILL_PLAN_INVALID",
            "RESUME_ONLY_BACKFILL_PLAN_REQUIRED",
            "RESUME_ONLY_BACKFILL_RECOVERY_CARRY_INVALID",
            "RESUME_ONLY_BACKFILL_RECOVERY_CLASSIFICATION_CHANGED",
            "RESUME_ONLY_BACKFILL_RECOVERY_COMMIT_FAILED",
            "RESUME_ONLY_BACKFILL_RECOVERY_CREATE_FAILED",
            "RESUME_ONLY_BACKFILL_RECOVERY_INSUFFICIENT",
            "RESUME_ONLY_BACKFILL_RECOVERY_INVALID",
            "RESUME_ONLY_BACKFILL_RECOVERY_NOT_ALLOWED",
            "RESUME_ONLY_BACKFILL_RECOVERY_NOT_COMMITTED",
            "RESUME_ONLY_BACKFILL_RECOVERY_PREFLIGHT_CHANGED",
            "RESUME_ONLY_BACKFILL_RECOVERY_REVIEW_REQUIRED",
            "RESUME_ONLY_BACKFILL_RECOVERY_SNAPSHOT_CHANGED",
            "RESUME_ONLY_BACKFILL_RECOVERY_SNAPSHOT_INVALID",
          ]).has(code)
          ? 409
          : 500;
      return res.status(status).json({
        ok: false,
        error: safeCode,
      });
    }
    if (phase4SourceModes.has(mode)) {
      return res.status(500).json({
        ok: false,
        error: "phase4_source_capture_failed",
      });
    }
    if (phase3Modes.has(mode)) {
      const code = String(error?.code || "");
      const safeCode = /^PHASE3_SHADOW_RELEASE_[A-Z0-9_]+$/u.test(code)
        ? code.toLowerCase()
        : "phase3_shadow_release_failed";
      const status = new Set([
        "PHASE3_SHADOW_RELEASE_TIMESTAMP_INVALID",
      ]).has(code)
        ? 400
        : new Set([
            "PHASE3_SHADOW_RELEASE_DIGEST_MISMATCH",
            "PHASE3_SHADOW_RELEASE_ANCHOR_CONFLICT",
            "PHASE3_SHADOW_RELEASE_GATES_CLOSED",
            "PHASE3_SHADOW_RELEASE_INDEX_LIMIT",
            "PHASE3_SHADOW_RELEASE_MANIFEST_CONFLICT",
            "PHASE3_SHADOW_RELEASE_RECORD_INVALID",
            "PHASE3_SHADOW_RELEASE_SNAPSHOT_CHANGED",
            "PHASE3_SHADOW_RELEASE_SNAPSHOT_INCOMPLETE",
          ]).has(code)
          ? 409
          : 500;
      return res.status(status).json({
        ok: false,
        error: safeCode,
      });
    }
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
