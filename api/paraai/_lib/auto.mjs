import { randomUUID } from "node:crypto";

import {
  fetchCall,
  isSuccessfulCall,
  normLinkedin,
  normalizeEmail,
  notifySlack,
  paraAIConfig,
} from "./core.mjs";
import {
  loadJob,
  missingRequiredPreferences,
  prepareJob,
  reconcileSubmittedJob,
  submitJob,
} from "./pipeline.mjs";
import {
  acquireJobLock,
  claimDueAutoJobs,
  completeAutoJob,
  enqueueAutoJob,
  getJob,
  getSubmissionIntent,
  releaseJobLock,
  rescheduleAutoJob,
  saveJob,
  takeAlertSlot,
  transition,
} from "./store.mjs";

const TERMINAL_STATES = new Set([
  "awaiting_matches", "ready_to_enroll", "needs_review", "enrolled", "no_email",
]);
const SAFE_RETRY_CODES = new Set([
  "AUTH_EXPIRED", "PREPARE_FAILED", "REVISION_CONFLICT", "JOB_BUSY",
  "SUBMIT_WRITE_UNKNOWN", "SUBMIT_STILL_UNCONFIRMED",
]);
const TERMINAL_ERROR_CODES = new Set([
  "INVALID_BOT_ID",
  "NOT_SUCCESSFUL_SCREEN",
  "ALREADY_SUBMITTED",
  "FUTURE_NEXT_STEP",
  "HAS_REPLIED",
  "ALREADY_ENROLLED",
  "INTERNAL_CANDIDATE",
]);
const PREWRITE_STATES = new Set([
  "detected", "resolving_identity", "extracting", "ready_to_submit", "error",
]);
const SETTLED_NON_SUCCESS_VERDICTS = new Set([
  "no_show", "audio_fail", "error", "joined_silent", "incomplete",
]);
const BOT_ID = /^[A-Za-z0-9_-]{8,100}$/;

const bool = (value, fallback = false) => {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const finiteDate = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

export function automationConfig(env = process.env) {
  const notBeforeMs = finiteDate(env.PARAAI_AUTO_NOT_BEFORE);
  const consentRequiredAtMs = finiteDate(env.PARAAI_CONSENT_REQUIRED_AT);
  return {
    enabled: bool(env.PARAAI_AUTOMATION_APPROVED),
    detectEnabled: bool(env.PARAAI_AUTO_DETECT_ENABLED),
    prepareEnabled: bool(env.PARAAI_AUTO_PREPARE_ENABLED),
    autoSubmitApproved: bool(env.PARAAI_AUTOSUBMIT_APPROVED),
    dryRun: !("PARAAI_AUTOMATION_DRY_RUN" in env) || bool(env.PARAAI_AUTOMATION_DRY_RUN, true),
    strictScreenerSource: bool(env.PARAAI_REQUIRE_VERIFIED_CALL_SOURCE, true),
    notBeforeMs,
    consentRequiredAtMs,
    workerBatch: Math.max(1, Math.min(5, Number(env.PARAAI_WORKER_BATCH || 1))),
    recoveryStatusUrl: String(
      env.PARAAI_RECOVERY_STATUS_URL || "https://webview-lake.vercel.app/api/status",
    ).trim(),
  };
}

export function automationExecutionEnabled(config = {}) {
  return Boolean(
    config.enabled &&
    config.detectEnabled &&
    config.prepareEnabled &&
    config.autoSubmitApproved &&
    config.dryRun === false &&
    config.notBeforeMs != null &&
    config.consentRequiredAtMs != null,
  );
}

export function automationApprovalSource(queueSource) {
  return queueSource === "authorized_backfill"
    ? "authorized_backfill_2026-07-16"
    : "recall_verified_automation";
}

export function automationRetryDecision(code, state, attempts = 0) {
  const normalizedCode = String(code || "AUTO_PROCESS_FAILED");
  const normalizedState = String(state || "error");
  const writeNeedsReconciliation = ["submit_intent", "submitting", "submission_unknown", "awaiting_approval"]
    .includes(normalizedState);
  const retry = !TERMINAL_ERROR_CODES.has(normalizedCode) && (
    SAFE_RETRY_CODES.has(normalizedCode) ||
    PREWRITE_STATES.has(normalizedState) ||
    writeNeedsReconciliation
  );
  const exponent = Math.max(0, Math.min(5, Number(attempts) || 0));
  const delayMs = normalizedCode === "AUTH_EXPIRED"
    ? 15 * 60_000
    : Math.min(15 * 60_000, 30_000 * (2 ** exponent));
  return { retry, delayMs };
}

function validHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function autoEligibility(job, config = automationConfig()) {
  const reasons = [];
  if (job?.state !== "ready_to_submit") reasons.push("state");
  if (config.strictScreenerSource && job?.callSourceVerified !== true) reasons.push("call source");
  const signals = Array.isArray(job?.identity?.signals) ? job.identity.signals : [];
  const strongIdentity = signals.some((signal) => ["linkedin", "phone", "scheduled_time"].includes(signal));
  if (!job?.identity?.candidateUserId || signals.length < 2 || !strongIdentity || job?.identity?.ambiguous) {
    reasons.push("identity");
  }
  if (!String(job?.submission?.name || "").trim()) reasons.push("name");
  if (!normalizeEmail(job?.submission?.email)) reasons.push("email");
  if (!normLinkedin(job?.submission?.linkedinUrl)) reasons.push("linkedin");
  if (!String(job?.submission?.resumeUri || "").trim()) reasons.push("resume");
  if (!validHttpUrl(job?.submission?.screeningCallLink)) reasons.push("screening call link");
  reasons.push(...missingRequiredPreferences(job?.reviewPreferences || {}).map((value) => `preference:${value}`));
  if (job?.reviewPolicy?.locationSource === "legacy_mapping") reasons.push("location provenance");

  const market = job?.extracted?.marketStatus || {};
  if (market.activelyOnMarket !== true) reasons.push("active-market evidence");
  if (market.openToOpportunities !== true) reasons.push("open-to-opportunities evidence");
  const startedAt = finiteDate(job?.callStartedAt);
  if (config.consentRequiredAtMs != null) {
    if (startedAt == null) reasons.push("call timestamp");
    else if (startedAt >= config.consentRequiredAtMs) {
      if (market.consentToTalentNetwork !== true || market.consentVerifiedFromTranscript !== true) {
        reasons.push("talent-network consent");
      }
    }
  }
  if (
    !Array.isArray(market.evidence) ||
    !market.evidence.length ||
    market.evidenceVerified !== true
  ) reasons.push("market evidence quote");

  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function automationCallCutoff(call, config, { historicalAuthorized = false } = {}) {
  if (historicalAuthorized) return { allowed: true, reason: null };
  if (config.notBeforeMs == null) {
    return { allowed: false, terminal: false, reason: "automation cutoff is not pinned" };
  }
  const startedAt = finiteDate(call?.joinAt || call?.startedAt || call?.startTime);
  if (startedAt == null) {
    return { allowed: false, terminal: true, reason: "call timestamp is missing" };
  }
  if (startedAt < config.notBeforeMs) {
    return { allowed: false, terminal: true, reason: "call predates automation cutoff" };
  }
  return { allowed: true, reason: null };
}

export function automationCallReadiness(
  call,
  config,
  {
    historicalAuthorized = false,
    queueSource = "unknown",
    queueAttempts = 0,
  } = {},
) {
  if (config.strictScreenerSource && call?.source?.isScreener !== true) {
    return { ready: false, terminal: call?.source?.isScreener === false, reason: "call source unverified" };
  }
  const cutoff = automationCallCutoff(call, config, { historicalAuthorized });
  if (!cutoff.allowed) {
    return { ready: false, terminal: cutoff.terminal, reason: cutoff.reason };
  }
  const verdict = String(call?.verdict?.verdict || call?.verdict || "").toLowerCase();
  const transcriptReady = Boolean(
    call?.media?.hasTranscript &&
    Array.isArray(call?.transcript) &&
    call.transcript.length,
  );
  if (verdict === "pending" || !transcriptReady) {
    const terminalVerdict = SETTLED_NON_SUCCESS_VERDICTS.has(verdict);
    const finalTranscriptSignal = queueSource === "recall:transcript.done";
    const settleAttempts = Math.max(0, Number(queueAttempts) || 0);
    const settleLimit = finalTranscriptSignal ? 10 : 20;
    if (terminalVerdict && settleAttempts >= settleLimit) {
      return { ready: false, terminal: true, reason: `call verdict is ${verdict}` };
    }
    return { ready: false, terminal: false, reason: "call artifacts are still settling" };
  }
  if (!isSuccessfulCall(call)) return { ready: false, terminal: true, reason: `call verdict is ${verdict || "unknown"}` };
  return { ready: true, terminal: false, reason: null };
}

function staleTransient(job, now = Date.now()) {
  if (!["resolving_identity", "extracting"].includes(job?.state)) return false;
  const updated = finiteDate(job?.updatedAt);
  return updated == null || now - updated >= 5 * 60_000;
}

function approvalDelay(job) {
  const checks = (job?.journal || []).filter((row) =>
    /approval still pending|remains unconfirmed/i.test(String(row?.detail || ""))).length;
  return [30_000, 2 * 60_000, 5 * 60_000, 15 * 60_000][Math.min(checks, 3)];
}

async function annotateAutomation(job, details) {
  return saveJob(transition(job, job.state, {
    automation: {
      ...(job.automation || {}),
      ...details,
      evaluatedAt: new Date().toISOString(),
    },
    journalDetail: details.status ? `automation ${details.status}` : "automation evaluated",
  }), job.revision);
}

export async function processAutoJob(
  botId,
  { config = automationConfig(), queueSource = "unknown", queueAttempts = 0 } = {},
) {
  const id = String(botId || "").trim();
  const historicalAuthorized = queueSource === "authorized_backfill";
  const approvalSource = automationApprovalSource(queueSource);
  if (!BOT_ID.test(id)) return { action: "complete", state: "invalid", detail: "invalid bot id" };
  if (!automationExecutionEnabled(config)) {
    return { action: "reschedule", delayMs: 5 * 60_000, state: "paused", detail: "automation is paused" };
  }

  let job = await getJob(id);
  if (job && !historicalAuthorized) {
    const startedAt = finiteDate(job.callStartedAt);
    if (startedAt == null || startedAt < config.notBeforeMs) {
      return {
        action: "complete",
        state: "ineligible_call",
        detail: startedAt == null ? "call timestamp is missing" : "call predates automation cutoff",
      };
    }
  }
  if (
    !job ||
    ["detected", "error"].includes(job.state) ||
    staleTransient(job) ||
    (config.strictScreenerSource && job.callSourceVerified !== true && job.state === "ready_to_submit")
  ) {
    const call = await fetchCall(id);
    const readiness = automationCallReadiness(call, config, {
      historicalAuthorized,
      queueSource,
      queueAttempts,
    });
    if (!readiness.ready) {
      return readiness.terminal
        ? { action: "complete", state: "ineligible_call", detail: readiness.reason }
        : { action: "reschedule", delayMs: 30_000, state: "waiting_for_artifacts", detail: readiness.reason };
    }
    job = await prepareJob({
      botId: id,
      force: Boolean(job),
      strictReads: true,
    });
  } else if (["resolving_identity", "extracting"].includes(job.state)) {
    return { action: "reschedule", delayMs: 60_000, state: job.state, detail: "preparation is still in progress" };
  }

  if (job.state === "error") {
    const retry = automationRetryDecision(job.error?.code, job.state, queueAttempts);
    return retry.retry
      ? {
          action: "reschedule",
          delayMs: retry.delayMs,
          state: job.state,
          detail: String(job.error?.code || "PREPARE_FAILED"),
        }
      : {
          action: "complete",
          state: job.state,
          detail: String(job.error?.code || "terminal preparation error"),
        };
  }

  if (job.state === "needs_identity_review") {
    job = await annotateAutomation(job, { status: "needs_review", reasons: ["identity"] });
    return { action: "complete", state: job.state, detail: "identity needs review" };
  }

  if (job.state === "ready_to_submit") {
    const eligibility = autoEligibility(job, config);
    job = await annotateAutomation(job, {
      status: eligibility.eligible ? "eligible" : "needs_review",
      reasons: eligibility.reasons,
    });
    if (!eligibility.eligible) {
      return { action: "complete", state: job.state, detail: eligibility.reasons.join(", ") };
    }
    if (!config.autoSubmitApproved || config.dryRun) {
      return { action: "reschedule", delayMs: 5 * 60_000, state: job.state, detail: "prepared; automatic writes are gated" };
    }
    const manualConfig = paraAIConfig();
    if (!manualConfig.submitApproved || manualConfig.dryRun) {
      return { action: "reschedule", delayMs: 5 * 60_000, state: job.state, detail: "base submit gate is closed" };
    }
    job = await submitJob(job, {
      confirmation: `SUBMIT ${job.id}`,
      marketConfirmed: true,
      approvalSource,
    });
    return { action: "reschedule", delayMs: 30_000, state: job.state, detail: "submission accepted; approval pending" };
  }

  if (["submit_intent", "submitting"].includes(job.state)) {
    const intent = await getSubmissionIntent(job.identity?.candidateUserId);
    if (intent && !intent.attemptStartedAt) {
      job = await submitJob(job, {
        confirmation: `SUBMIT ${job.id}`,
        marketConfirmed: true,
        approvalSource,
      });
      return { action: "reschedule", delayMs: 30_000, state: job.state, detail: "submission accepted; approval pending" };
    }
    job = await reconcileSubmittedJob(job);
  } else if (["submission_unknown", "awaiting_approval"].includes(job.state)) {
    job = await reconcileSubmittedJob(job);
  }

  if (job.state === "awaiting_approval" || job.state === "submission_unknown") {
    return {
      action: "reschedule",
      delayMs: approvalDelay(job),
      state: job.state,
      detail: job.state === "submission_unknown" ? "read-only reconciliation required" : "approval pending",
    };
  }
  if (TERMINAL_STATES.has(job.state)) return { action: "complete", state: job.state, detail: "automation step complete" };
  return { action: "complete", state: job.state, detail: "manual workflow owns this state" };
}

async function alertOnce(code, botId, detail) {
  try {
    const key = code === "AUTH_EXPIRED" ? "auto-auth-expired" : `auto:${code}:${botId}`;
    if (!(await takeAlertSlot(key, code === "AUTH_EXPIRED" ? 12 * 3600 : 3600))) return;
    await notifySlack(
      `🚨 Para AI automation: ${code} for job ${botId}. ${String(detail || "").slice(0, 160)} ` +
      "No external mutation will be retried automatically.",
    );
  } catch { /* durable state and the worker response remain authoritative */ }
}

export async function runAutoTick({ config = automationConfig(), workerId = `vercel-${randomUUID()}` } = {}) {
  if (!automationExecutionEnabled(config)) {
    return { ok: true, disabled: true, paused: true, processed: [] };
  }
  const leases = await claimDueAutoJobs(config.workerBatch, { workerId });
  const processed = [];
  for (const lease of leases) {
    let jobLock = null;
    try {
      jobLock = await acquireJobLock(lease.botId, { ttlSeconds: 150 });
      if (!jobLock) {
        await rescheduleAutoJob(lease.botId, {
          leaseToken: lease.leaseToken,
          generation: lease.generation,
          delayMs: 15_000,
          error: "JOB_BUSY",
        });
        processed.push({ botId: lease.botId, state: "busy", action: "rescheduled" });
        continue;
      }
      const result = await processAutoJob(lease.botId, {
        config,
        queueSource: lease.source,
        queueAttempts: lease.attempts,
      });
      if (result.action === "reschedule") {
        await rescheduleAutoJob(lease.botId, {
          leaseToken: lease.leaseToken,
          generation: lease.generation,
          delayMs: result.delayMs,
          error: result.detail,
        });
      } else {
        await completeAutoJob(lease.botId, {
          leaseToken: lease.leaseToken,
          generation: lease.generation,
        });
      }
      processed.push({ botId: lease.botId, state: result.state, action: result.action, detail: result.detail });
    } catch (error) {
      const code = String(error?.code || "AUTO_PROCESS_FAILED");
      const state = error?.job?.state || (await getJob(lease.botId).catch(() => null))?.state || "error";
      const retry = automationRetryDecision(code, state, lease.attempts);
      if (retry.retry) {
        await rescheduleAutoJob(lease.botId, {
          leaseToken: lease.leaseToken,
          generation: lease.generation,
          delayMs: retry.delayMs,
          error: code,
        }).catch(() => {});
      } else {
        await completeAutoJob(lease.botId, {
          leaseToken: lease.leaseToken,
          generation: lease.generation,
        }).catch(() => {});
      }
      await alertOnce(code, lease.botId, error?.message);
      processed.push({ botId: lease.botId, state, action: retry.retry ? "rescheduled" : "failed", detail: code });
    } finally {
      if (jobLock) await releaseJobLock(lease.botId, jobLock).catch(() => {});
    }
  }
  return { ok: true, disabled: false, processed };
}

export async function recoverRecentSuccessfulCalls({ config = automationConfig(), fetchImpl = fetch } = {}) {
  if (!automationExecutionEnabled(config)) return { ok: true, disabled: true, paused: true, discovered: 0 };
  const base = config.recoveryStatusUrl;
  const url = `${base}${base.includes("?") ? "&" : "?"}fresh=${Date.now()}`;
  const response = await fetchImpl(url, {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) throw new Error(`recovery status read failed: ${response.status}`);
  const generatedAt = finiteDate(body.generatedAt);
  if (generatedAt == null || Date.now() - generatedAt > 5 * 60_000) throw new Error("recovery status feed is stale");
  let discovered = 0;
  for (const call of Array.isArray(body.calls) ? body.calls : []) {
    const botId = String(call?.botId || "").trim();
    const endedAt = finiteDate(call?.endedAt || call?.startedAt);
    if (!BOT_ID.test(botId) || String(call?.verdict || call?.category || "").toLowerCase() !== "success") continue;
    if (endedAt == null || endedAt < config.notBeforeMs) continue;
    const result = await enqueueAutoJob(botId, {
      source: "recovery_status",
      eventId: `recovery:${botId}`,
      dueAt: Date.now(),
    });
    if (result.enqueued) discovered++;
  }
  return { ok: true, disabled: false, discovered };
}

export async function enqueueBackfill(botIds = []) {
  const results = [];
  for (const value of botIds) {
    const botId = String(value || "").trim();
    if (!BOT_ID.test(botId)) {
      results.push({ botId, enqueued: false, error: "invalid_bot_id" });
      continue;
    }
    results.push(await enqueueAutoJob(botId, {
      source: "authorized_backfill",
      eventId: `backfill:${botId}:${randomUUID()}`,
      dueAt: Date.now(),
    }));
  }
  return results;
}
