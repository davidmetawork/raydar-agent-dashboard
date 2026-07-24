import { randomUUID } from "node:crypto";

import {
  fetchCall,
  findResumeUri,
  getResume,
  isSuccessfulCall,
  normLinkedin,
  normalizeEmail,
  notifySlack,
  paraAIConfig,
} from "./core.mjs";
import {
  advanceExistingTalentNetworkJob,
  loadJob,
  missingRequiredPreferences,
  prepareJob,
  reconcileSubmittedJob,
  reroutePreparedJob,
  submitJob,
} from "./pipeline.mjs";
import {
  acquireJobLock,
  claimDueAutoJobs,
  completeAutoJob,
  createJob,
  enqueueAutoJob,
  getJob,
  getSubmissionIntent,
  normalizeFailureRecord,
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
const DEFAULT_RESUME_WAIT_MINUTES = 60;
const DEFAULT_MAX_STEP_ATTEMPTS = 20;

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
  const phase1DeployedAtMs = finiteDate(env.PARAAI_PHASE1_DEPLOYED_AT);
  const configuredResumeWait = Number(env.PARAAI_RESUME_WAIT_MINUTES);
  const configuredStepAttempts = Number(env.PARAAI_MAX_STEP_ATTEMPTS);
  return {
    enabled: bool(env.PARAAI_AUTOMATION_APPROVED),
    detectEnabled: bool(env.PARAAI_AUTO_DETECT_ENABLED),
    prepareEnabled: bool(env.PARAAI_AUTO_PREPARE_ENABLED),
    autoSubmitApproved: bool(env.PARAAI_AUTOSUBMIT_APPROVED),
    dryRun: !("PARAAI_AUTOMATION_DRY_RUN" in env) || bool(env.PARAAI_AUTOMATION_DRY_RUN, true),
    strictScreenerSource: bool(env.PARAAI_REQUIRE_VERIFIED_CALL_SOURCE, true),
    notBeforeMs,
    phase1DeployedAtMs,
    organicExceptionBotIds: new Set(
      String(env.PARAAI_ORGANIC_EXCEPTION_BOT_IDS || "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => BOT_ID.test(value)),
    ),
    resumeWaitMinutes: Number.isFinite(configuredResumeWait)
      ? Math.max(0, configuredResumeWait)
      : DEFAULT_RESUME_WAIT_MINUTES,
    maxStepAttempts: Number.isFinite(configuredStepAttempts)
      ? Math.max(1, configuredStepAttempts)
      : DEFAULT_MAX_STEP_ATTEMPTS,
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
    config.phase1DeployedAtMs != null,
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
  if (!validHttpUrl(job?.submission?.screeningCallLink)) reasons.push("screening call link");
  for (const missing of missingRequiredPreferences(job?.reviewPreferences || {})) {
    reasons.push(
      missing === "visa sponsorship"
        ? "sponsorship unknown for international candidate"
        : `routing incomplete: ${missing}`,
    );
  }

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

export function resolveCallEndedAt(call, fallback = null) {
  const explicit = finiteDate(call?.endedAt || call?.ended_at || call?.completedAt || call?.completed_at);
  if (explicit != null) return explicit;
  const joined = finiteDate(call?.joinAt || call?.startedAt || call?.startTime);
  const durationSeconds = Number(call?.durationSecs ?? call?.duration_seconds ?? call?.duration);
  if (joined != null && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
    return joined + durationSeconds * 1000;
  }
  return finiteDate(fallback);
}

export function automationGraceDecision(job, config = automationConfig(), now = Date.now()) {
  const callEndedAtMs = finiteDate(job?.callEndedAt);
  if (callEndedAtMs == null) {
    return { ready: false, dueAt: null, reason: "call end timestamp is missing" };
  }
  const waitMinutes = Number.isFinite(Number(config.resumeWaitMinutes))
    ? Math.max(0, Number(config.resumeWaitMinutes))
    : DEFAULT_RESUME_WAIT_MINUTES;
  const dueAt = callEndedAtMs + waitMinutes * 60_000;
  return {
    ready: Number(now) >= dueAt,
    dueAt,
    reason: Number(now) >= dueAt ? null : "one-hour post-call grace period",
  };
}

export function automationFreezeDecision(
  job,
  config = automationConfig(),
  { queueSource = "unknown" } = {},
) {
  if (queueSource === "authorized_backfill") {
    return { frozen: false, mode: "authorized_backfill", reason: null };
  }
  const id = String(job?.id || "");
  const exceptions = config.organicExceptionBotIds instanceof Set
    ? config.organicExceptionBotIds
    : new Set(config.organicExceptionBotIds || []);
  if (exceptions.has(id)) {
    return { frozen: false, mode: "organic_exception", reason: null };
  }
  const cutoff = Number(config.phase1DeployedAtMs);
  const createdAt = finiteDate(job?.createdAt);
  if (!Number.isFinite(cutoff) || createdAt == null || createdAt < cutoff) {
    return {
      frozen: true,
      mode: "backfill_only",
      reason: !Number.isFinite(cutoff)
        ? "Phase 1 deployment cutoff is not pinned"
        : createdAt == null
          ? "job creation timestamp is missing"
          : "job predates the Phase 1 deployment",
    };
  }
  return { frozen: false, mode: "organic", reason: null };
}

export function needsPhase1Routing(job) {
  return Boolean(
    job?.state === "ready_to_submit" &&
    !job?.reviewPolicy?.preferenceRouting,
  );
}

export function unstoredPhase1FreezeDecision(
  botId,
  call,
  config = automationConfig(),
  { queueSource = "unknown", fallbackEndedAt = null } = {},
) {
  const endedAt = resolveCallEndedAt(call, fallbackEndedAt);
  return {
    endedAt,
    ...automationFreezeDecision({
      id: botId,
      createdAt: endedAt == null ? null : new Date(endedAt).toISOString(),
    }, config, { queueSource }),
  };
}

function reviewReason(code, message, { soft = false } = {}) {
  return {
    code: String(code || "review_required").slice(0, 100),
    message: String(message || code || "Review required").replace(/\s+/g, " ").trim().slice(0, 300),
    soft: soft === true,
  };
}

function mergeReviewReasons(job, ...values) {
  const rows = [...(Array.isArray(job?.reviewReasons) ? job.reviewReasons : []), ...values]
    .filter(Boolean);
  const unique = new Map();
  for (const row of rows) unique.set(String(row.code || row.message), row);
  return [...unique.values()];
}

export function automationFailureTransition(
  job,
  failure,
  { maxAttempts = DEFAULT_MAX_STEP_ATTEMPTS, now = Date.now() } = {},
) {
  const normalized = normalizeFailureRecord(failure) || normalizeFailureRecord({});
  const stepFailures = { ...(job?.automation?.stepFailures || {}) };
  const previous = stepFailures[normalized.step] || {};
  const count = Math.max(0, Number(previous.count) || 0) + 1;
  const reachedCeiling = count >= Math.max(1, Number(maxAttempts) || DEFAULT_MAX_STEP_ATTEMPTS);
  stepFailures[normalized.step] = {
    count,
    code: normalized.code,
    message: normalized.message,
    lastFailedAt: new Date(now).toISOString(),
  };
  const state = reachedCeiling ? "needs_review" : String(job?.state || "error");
  return transition(job, state, {
    automation: {
      ...(job?.automation || {}),
      lastFailure: normalized,
      stepFailures,
    },
    ...(reachedCeiling ? {
      reviewReason: "technical_failure_ceiling",
      reviewReasons: mergeReviewReasons(
        job,
        reviewReason(
          "technical_failure_ceiling",
          `${normalized.step}: ${normalized.message}`,
        ),
      ),
    } : {}),
    error: {
      code: normalized.code,
      detail: normalized.message,
      step: normalized.step,
      at: new Date(now).toISOString(),
    },
    journalDetail: `${normalized.step} failed (${count}/${Math.max(1, Number(maxAttempts) || DEFAULT_MAX_STEP_ATTEMPTS)})`,
    journalFailure: normalized,
  });
}

export function automationStepSuccessTransition(job, step) {
  const name = String(step || "").trim();
  const previous = job?.automation?.stepFailures?.[name];
  if (!name || !previous) return job;
  const stepFailures = { ...(job.automation.stepFailures || {}) };
  delete stepFailures[name];
  return transition(job, job.state, {
    automation: {
      ...(job.automation || {}),
      stepFailures,
      lastSucceededStep: name,
      lastSucceededAt: new Date().toISOString(),
    },
    journalDetail: `${name} recovered after ${Number(previous.count) || 0} failure(s)`,
  });
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

export async function trackedAutomationStep(step, operation, succeededSteps = null) {
  try {
    const result = await operation();
    succeededSteps?.add(step);
    return result;
  } catch (error) {
    if (!error?.step) {
      try {
        error.step = step;
      } catch {
        const wrapped = new Error(String(error?.message || error));
        wrapped.code = error?.code;
        wrapped.job = error?.job;
        wrapped.step = step;
        throw wrapped;
      }
    }
    throw error;
  }
}

async function persistAutomationFailure(botId, failure, config, preferredJob = null) {
  const id = String(botId || "");
  let current = preferredJob?.id === id
    ? await getJob(id).catch(() => preferredJob)
    : await getJob(id).catch(() => null);
  const apply = (job) => automationFailureTransition(job, failure, {
    maxAttempts: config.maxStepAttempts,
  });
  if (!current) {
    const at = new Date().toISOString();
    return createJob(apply({
      id,
      state: "error",
      createdAt: at,
      updatedAt: at,
      journal: [],
    }));
  }
  try {
    return await saveJob(apply(current), current.revision);
  } catch (error) {
    if (error?.code !== "REVISION_CONFLICT") throw error;
    current = await getJob(id);
    return saveJob(apply(current), current.revision);
  }
}

async function resetAutomationStep(botId, step) {
  let current = await getJob(botId).catch(() => null);
  if (!current?.automation?.stepFailures?.[step]) return current;
  try {
    return await saveJob(automationStepSuccessTransition(current, step), current.revision);
  } catch (error) {
    if (error?.code !== "REVISION_CONFLICT") throw error;
    current = await getJob(botId);
    if (!current?.automation?.stepFailures?.[step]) return current;
    return saveJob(automationStepSuccessTransition(current, step), current.revision);
  }
}

async function persistAutomationMode(job, freeze) {
  if (!job) return null;
  if (
    job?.automation?.mode === freeze.mode &&
    job?.automation?.freezeReason === freeze.reason
  ) return job;
  return saveJob(transition(job, job.state, {
    automation: {
      ...(job.automation || {}),
      mode: freeze.mode,
      freezeReason: freeze.reason || null,
    },
    journalDetail: freeze.frozen
      ? `automation frozen: ${freeze.reason}`
      : `automation mode: ${freeze.mode}`,
  }), job.revision);
}

async function ensureCallTiming(job, fallback = null, runStep = trackedAutomationStep) {
  if (finiteDate(job?.callEndedAt) != null) return job;
  const call = await runStep("call_read", () => fetchCall(job.id));
  const endedAt = resolveCallEndedAt(call, fallback || job?.updatedAt || job?.createdAt);
  if (endedAt == null) {
    const error = new Error("call end timestamp is missing");
    error.code = "CALL_END_TIMESTAMP_MISSING";
    error.step = "call_read";
    error.job = job;
    throw error;
  }
  return saveJob(transition(job, job.state, {
    callStartedAt: call.joinAt || job.callStartedAt || null,
    callEndedAt: new Date(endedAt).toISOString(),
    journalDetail: "call end timestamp persisted",
  }), job.revision);
}

async function refreshResumeForSubmission(job, runStep = trackedAutomationStep) {
  const resume = await runStep(
    "resume_read",
    () => getResume(job.identity?.candidateUserId),
  );
  const resumeUri = findResumeUri(resume);
  if (!resumeUri) return { job, resumeUri: "" };
  if (resumeUri === job?.submission?.resumeUri) return { job, resumeUri };
  const updated = await saveJob(transition(job, job.state, {
    submission: {
      ...(job.submission || {}),
      resumeUri,
      resumeStatus: "on_file",
    },
    journalDetail: "resume detected on profile before submission",
  }), job.revision);
  return { job: updated, resumeUri };
}

function automationErrorResult(job, defaultStep = "process") {
  const failure = normalizeFailureRecord({
    code: job?.error?.code || "AUTO_PROCESS_FAILED",
    message: job?.error?.detail || job?.error?.message || "automation step failed",
    step: job?.error?.step || defaultStep,
  });
  const priorFailures = Number(job?.automation?.stepFailures?.[failure.step]?.count) || 0;
  const retry = automationRetryDecision(failure.code, job?.state, priorFailures);
  return {
    action: retry.retry ? "reschedule" : "complete",
    ...(retry.retry ? { delayMs: retry.delayMs } : {}),
    state: job?.state || "error",
    detail: failure.code,
    failure,
    job,
  };
}

async function processAutoJobInner(
  botId,
  {
    config = automationConfig(),
    queueSource = "unknown",
    queueAttempts = 0,
    queueCallEndedAt = null,
    succeededSteps = new Set(),
  } = {},
) {
  const id = String(botId || "").trim();
  const runStep = (step, operation) => trackedAutomationStep(step, operation, succeededSteps);
  const historicalAuthorized = queueSource === "authorized_backfill";
  const approvalSource = automationApprovalSource(queueSource);
  if (!BOT_ID.test(id)) return { action: "complete", state: "invalid", detail: "invalid bot id" };
  if (!automationExecutionEnabled(config)) {
    return { action: "reschedule", delayMs: 5 * 60_000, state: "paused", detail: "automation is paused" };
  }

  let job = await getJob(id);
  if (job) {
    const freeze = automationFreezeDecision(job, config, { queueSource });
    job = await persistAutomationMode(job, freeze);
    if (freeze.frozen) {
      return {
        action: "complete",
        state: "backfill_only",
        detail: freeze.reason,
      };
    }
  }
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
    needsPhase1Routing(job) ||
    (config.strictScreenerSource && job.callSourceVerified !== true && job.state === "ready_to_submit")
  ) {
    const call = await runStep("call_read", () => fetchCall(id));
    const readiness = automationCallReadiness(call, config, {
      historicalAuthorized,
      queueSource,
      queueAttempts,
    });
    if (!readiness.ready) {
      return readiness.terminal
        ? { action: "complete", state: "ineligible_call", detail: readiness.reason, step: "call_read" }
        : { action: "reschedule", delayMs: 30_000, state: "waiting_for_artifacts", detail: readiness.reason, step: "call_read" };
    }
    if (!job) {
      const predeploy = unstoredPhase1FreezeDecision(id, call, config, {
        queueSource,
        fallbackEndedAt: queueCallEndedAt,
      });
      if (predeploy.frozen) {
        const at = new Date().toISOString();
        const callEndedAt = predeploy.endedAt == null
          ? null
          : new Date(predeploy.endedAt).toISOString();
        job = await createJob({
          id,
          state: "detected",
          createdAt: callEndedAt || at,
          updatedAt: at,
          callStartedAt: call.joinAt || call.startedAt || call.startTime || null,
          callEndedAt,
          callSourceVerified: call?.source?.isScreener === true,
          automation: {
            mode: predeploy.mode,
            freezeReason: predeploy.reason,
          },
          journal: [{
            state: "detected",
            at,
            detail: `automation frozen: ${predeploy.reason}`,
          }],
        });
        return {
          action: "complete",
          state: "backfill_only",
          detail: predeploy.reason,
          job,
        };
      }
    }
    job = await runStep(
      needsPhase1Routing(job) && job?.extracted ? "reroute" : "prepare",
      () => needsPhase1Routing(job) && job?.extracted
        ? reroutePreparedJob(job)
        : prepareJob({
            botId: id,
            force: Boolean(job),
            strictReads: true,
          }),
    );
    const endedAt = resolveCallEndedAt(call, queueCallEndedAt);
    if (endedAt != null && finiteDate(job.callEndedAt) == null) {
      job = await saveJob(transition(job, job.state, {
        callEndedAt: new Date(endedAt).toISOString(),
        journalDetail: "call end timestamp persisted",
      }), job.revision);
    }
    const freeze = automationFreezeDecision(job, config, { queueSource });
    job = await persistAutomationMode(job, freeze);
    if (freeze.frozen) {
      return {
        action: "complete",
        state: "backfill_only",
        detail: freeze.reason,
      };
    }
  } else if (["resolving_identity", "extracting"].includes(job.state)) {
    return { action: "reschedule", delayMs: 60_000, state: job.state, detail: "preparation is still in progress" };
  }

  if (job.state === "error") {
    return automationErrorResult(job, "prepare");
  }

  if (job.state === "needs_identity_review") {
    job = await saveJob(transition(job, job.state, {
      automation: {
        ...(job.automation || {}),
        status: "needs_review",
        reasons: ["identity"],
        evaluatedAt: new Date().toISOString(),
      },
      reviewReasons: mergeReviewReasons(
        job,
        reviewReason("identity", "Unresolved or ambiguous Paraform identity"),
      ),
      journalDetail: "automation needs review",
    }), job.revision);
    return { action: "complete", state: job.state, detail: "identity needs review" };
  }

  if (job.state === "ready_to_submit") {
    job = await ensureCallTiming(job, queueCallEndedAt, runStep);
    const grace = automationGraceDecision(job, config);
    if (!grace.ready) {
      if (grace.dueAt == null) {
        const error = new Error(grace.reason);
        error.code = "CALL_END_TIMESTAMP_MISSING";
        error.step = "call_read";
        error.job = job;
        throw error;
      }
      return {
        action: "reschedule",
        delayMs: Math.max(1_000, grace.dueAt - Date.now()),
        state: "post_call_grace",
        detail: grace.reason,
      };
    }
    job = await runStep(
      "submission_read",
      () => advanceExistingTalentNetworkJob(job, { approvalSource }),
    );
    if (job.state === "awaiting_matches") {
      return {
        action: "complete",
        state: job.state,
        detail: "existing Talent Network membership verified; submission write skipped",
        job,
      };
    }
    if (job.state === "error") return automationErrorResult(job, "submission_read");

    const resume = await refreshResumeForSubmission(job, runStep);
    job = resume.job;
    if (!resume.resumeUri) {
      const message = "no resume on profile (resume-wait ships Phase 2)";
      job = await saveJob(transition(job, "needs_review", {
        reviewReason: "no_resume_phase1",
        reviewReasons: mergeReviewReasons(
          job,
          reviewReason("no_resume_phase1", message),
        ),
        automation: {
          ...(job.automation || {}),
          status: "needs_review",
          reasons: [message],
          resumeWaitSweepEligible: true,
        },
        journalDetail: message,
      }), job.revision);
      return {
        action: "complete",
        state: job.state,
        detail: message,
        step: "resume_read",
      };
    }
    const eligibility = autoEligibility(job, config);
    if (!eligibility.eligible) {
      job = await saveJob(transition(job, "needs_review", {
        automation: {
          ...(job.automation || {}),
          status: "needs_review",
          reasons: eligibility.reasons,
          evaluatedAt: new Date().toISOString(),
        },
        reviewReasons: mergeReviewReasons(
          job,
          ...eligibility.reasons.map((reason) => reviewReason(
            reason.replace(/[^a-z0-9]+/gi, "_").toLowerCase(),
            reason,
          )),
        ),
        journalDetail: "automation needs review",
      }), job.revision);
      return { action: "complete", state: job.state, detail: eligibility.reasons.join(", ") };
    }
    job = await annotateAutomation(job, {
      status: "eligible",
      reasons: [],
    });
    if (!config.autoSubmitApproved || config.dryRun) {
      return { action: "reschedule", delayMs: 5 * 60_000, state: job.state, detail: "prepared; automatic writes are gated" };
    }
    const manualConfig = paraAIConfig();
    if (!manualConfig.submitApproved || manualConfig.dryRun) {
      return { action: "reschedule", delayMs: 5 * 60_000, state: job.state, detail: "base submit gate is closed" };
    }
    job = await runStep("submit", () => submitJob(job, {
      confirmation: `SUBMIT ${job.id}`,
      marketConfirmed: true,
      approvalSource,
    }));
    if (job?.extracted?.marketStatus?.consentToTalentNetwork === false) {
      await alertOnce(
        "RECORDED_SHARING_OBJECTION",
        job.id,
        "Submitted with recorded sharing objection — review if needed.",
        { objection: true },
      );
    }
    if (job.state === "error") return automationErrorResult(job, "submit");
    if (job.state === "awaiting_matches") {
      return {
        action: "complete",
        state: job.state,
        detail: "existing Talent Network membership verified; submission write skipped",
        job,
      };
    }
    return {
      action: "reschedule",
      delayMs: 30_000,
      state: job.state,
      detail: "submission accepted; approval pending",
      step: "submit",
      job,
    };
  }

  if (["submit_intent", "submitting"].includes(job.state)) {
    const intent = await runStep(
      "submit_reconciliation",
      () => getSubmissionIntent(job.identity?.candidateUserId),
    );
    if (intent && !intent.attemptStartedAt) {
      job = await runStep("submit", () => submitJob(job, {
        confirmation: `SUBMIT ${job.id}`,
        marketConfirmed: true,
        approvalSource,
      }));
      return {
        action: "reschedule",
        delayMs: 30_000,
        state: job.state,
        detail: "submission accepted; approval pending",
        step: "submit",
        job,
      };
    }
    job = await runStep(
      "submit_reconciliation",
      () => reconcileSubmittedJob(job),
    );
  } else if (["submission_unknown", "awaiting_approval"].includes(job.state)) {
    job = await runStep(
      "submit_reconciliation",
      () => reconcileSubmittedJob(job),
    );
  }

  if (job.state === "awaiting_approval" || job.state === "submission_unknown") {
    return {
      action: "reschedule",
      delayMs: approvalDelay(job),
      state: job.state,
      detail: job.state === "submission_unknown" ? "read-only reconciliation required" : "approval pending",
      step: "submit_reconciliation",
      job,
    };
  }
  if (TERMINAL_STATES.has(job.state)) return { action: "complete", state: job.state, detail: "automation step complete", job };
  return { action: "complete", state: job.state, detail: "manual workflow owns this state" };
}

export async function processAutoJob(botId, options = {}) {
  const succeededSteps = new Set();
  try {
    const result = await processAutoJobInner(botId, {
      ...options,
      succeededSteps,
    });
    return {
      ...result,
      succeededSteps: [...succeededSteps],
    };
  } catch (error) {
    try {
      error.succeededSteps = [...succeededSteps];
    } catch { /* the worker still persists the primary error */ }
    throw error;
  }
}

async function alertOnce(code, botId, detail, { ceiling = false, objection = false } = {}) {
  try {
    const key = objection
      ? `auto:sharing-objection:${botId}`
      : ceiling
        ? `auto:ceiling:${code}:${botId}`
        : code === "AUTH_EXPIRED"
          ? "auto-auth-expired"
          : `auto:${code}:${botId}`;
    if (!(await takeAlertSlot(key, code === "AUTH_EXPIRED" ? 12 * 3600 : 3600))) return;
    if (objection) {
      await notifySlack(
        `⚠️ Para AI automation: job ${botId} submitted with a recorded sharing objection — review if needed.`,
      );
      return;
    }
    await notifySlack(
      `🚨 Para AI automation: ${code} for job ${botId}. ${String(detail || "").slice(0, 160)} ` +
      (ceiling
        ? "The consecutive step-failure ceiling was reached; the candidate is in review."
        : "The durable retry policy remains in control."),
    );
  } catch { /* durable state and the worker response remain authoritative */ }
}

export async function runAutoTick({ config = automationConfig(), workerId = `vercel-${randomUUID()}` } = {}) {
  if (!automationExecutionEnabled(config)) {
    return { ok: true, disabled: true, paused: true, processed: [] };
  }
  const maxStepAttempts = Number.isFinite(Number(config.maxStepAttempts))
    ? Math.max(1, Number(config.maxStepAttempts))
    : DEFAULT_MAX_STEP_ATTEMPTS;
  config = { ...config, maxStepAttempts };
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
        queueCallEndedAt: lease.callEndedAt,
      });
      let action = result.action;
      let durableFailure = null;
      for (const step of result.succeededSteps || []) {
        await resetAutomationStep(lease.botId, step).catch(() => {});
      }
      if (result.failure) {
        durableFailure = await persistAutomationFailure(
          lease.botId,
          result.failure,
          config,
          result.job,
        );
        const count = Number(
          durableFailure?.automation?.stepFailures?.[result.failure.step]?.count,
        ) || 0;
        if (count >= maxStepAttempts || durableFailure?.state === "needs_review") {
          action = "complete";
          await alertOnce(
            result.failure.code,
            lease.botId,
            result.failure.message,
            { ceiling: true },
          );
        }
      }
      if (action === "reschedule") {
        await rescheduleAutoJob(lease.botId, {
          leaseToken: lease.leaseToken,
          generation: lease.generation,
          delayMs: result.delayMs,
          error: result.detail,
          failure: result.failure,
        });
      } else {
        await completeAutoJob(lease.botId, {
          leaseToken: lease.leaseToken,
          generation: lease.generation,
        });
      }
      processed.push({
        botId: lease.botId,
        state: durableFailure?.state || result.state,
        action,
        detail: result.detail,
      });
    } catch (error) {
      for (const step of error?.succeededSteps || []) {
        await resetAutomationStep(lease.botId, step).catch(() => {});
      }
      const failure = normalizeFailureRecord({
        code: error?.code || "AUTO_PROCESS_FAILED",
        message: error?.message || error,
        step: error?.step || "process",
      });
      const recorded = await persistAutomationFailure(
        lease.botId,
        failure,
        config,
        error?.job,
      ).catch(() => error?.job || null);
      const state = recorded?.state || error?.job?.state || "error";
      const failureCount = Number(
        recorded?.automation?.stepFailures?.[failure.step]?.count,
      ) || 1;
      const reachedCeiling = state === "needs_review" || failureCount >= maxStepAttempts;
      const retry = automationRetryDecision(failure.code, state, failureCount);
      if (retry.retry && !reachedCeiling) {
        await rescheduleAutoJob(lease.botId, {
          leaseToken: lease.leaseToken,
          generation: lease.generation,
          delayMs: retry.delayMs,
          error: failure.code,
          failure,
        }).catch(() => {});
      } else {
        await completeAutoJob(lease.botId, {
          leaseToken: lease.leaseToken,
          generation: lease.generation,
        }).catch(() => {});
      }
      await alertOnce(
        failure.code,
        lease.botId,
        failure.message,
        { ceiling: reachedCeiling },
      );
      processed.push({
        botId: lease.botId,
        state,
        action: retry.retry && !reachedCeiling ? "rescheduled" : "failed",
        detail: failure.code,
      });
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
      dueAt: endedAt + Math.max(
        0,
        Number(config.resumeWaitMinutes ?? DEFAULT_RESUME_WAIT_MINUTES),
      ) * 60_000,
      callEndedAt: new Date(endedAt).toISOString(),
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

export async function enqueueOrganicExceptions({
  config = automationConfig(),
  enqueueImpl = enqueueAutoJob,
  now = Date.now(),
  eventNonce = randomUUID,
} = {}) {
  const botIds = [...(config.organicExceptionBotIds || [])]
    .map((value) => String(value || "").trim())
    .filter((value) => BOT_ID.test(value));
  if (botIds.length !== 6) {
    const error = new Error("Phase 1 organic replay requires exactly six pinned candidate IDs");
    error.code = "PHASE1_EXCEPTION_COUNT_INVALID";
    throw error;
  }
  const results = [];
  for (const botId of botIds) {
    results.push(await enqueueImpl(botId, {
      source: "phase1_organic_exception",
      eventId: `phase1-organic:${botId}:${eventNonce()}`,
      dueAt: now,
    }));
  }
  return results;
}
