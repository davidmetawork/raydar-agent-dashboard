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
  submitJob as pipelineSubmitJob,
} from "./pipeline.mjs";
import {
  HUMAN_CALL_QUEUE_SOURCE,
  callIdFromHumanJob,
  fetchHumanCall,
  humanCallReadiness,
  isHumanCallJob,
} from "./human-call.mjs";
import {
  DEFAULT_RESUME_BACKFILL_TERMINAL_ACK_DAYS,
  DEFAULT_RESUME_RETRY_DAYS,
  DEFAULT_RESUME_TERMINAL_ACK_HOURS,
  DEFAULT_RESUME_WAIT_MINUTES,
  MAX_RESUME_BACKFILL_TERMINAL_ACK_DAYS,
  MAX_RESUME_TERMINAL_ACK_HOURS,
  MIN_RESUME_BACKFILL_TERMINAL_ACK_DAYS,
  MIN_RESUME_TERMINAL_ACK_HOURS,
  RESUME_ATTACHMENT_PENDING_REVIEW_CODE,
  RESUME_ATTACHMENT_PENDING_REVIEW_MESSAGE,
  RESUME_RECEIVED_REVIEW_CODE,
  RESUME_RECEIVED_REVIEW_MESSAGE,
  resumeChaseNextDeliveryAckDeadline,
  resumeWaitPlan,
  resumeWaitSettings,
} from "./resume-wait.mjs";
import {
  acquireJobLock,
  claimDueAutoJobs,
  completeAutoJob,
  createJob,
  enqueueAutoJob,
  getJob,
  getOrCreateResumeBackfillAnchor,
  getRecentResumeAttachedSignal,
  getResumeAskSuppression,
  getSubmissionIntent,
  listJobs,
  normalizeFailureRecord,
  releaseJobLock,
  resumeChaseChainId,
  rescheduleAutoJob,
  saveJob,
  stopResumeAskSuppression,
  takeAlertSlot,
  transition,
} from "./store.mjs";

const TERMINAL_STATES = new Set([
  "awaiting_matches", "ready_to_enroll", "needs_review", "enrolled", "no_email",
]);
const SAFE_RETRY_CODES = new Set([
  "AUTH_EXPIRED", "PREPARE_FAILED", "REVISION_CONFLICT", "JOB_BUSY",
  "SUBMIT_WRITE_UNKNOWN", "SUBMIT_STILL_UNCONFIRMED", "RESUME_CHASE_STOP_FAILED",
  "RESUME_CHASE_READ_FAILED", "RESUME_ATTACH_REDUE_FAILED",
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
const BACKFILL_REOPEN_STATES = new Set(["needs_review", "ready_to_submit"]);
const SETTLED_NON_SUCCESS_VERDICTS = new Set([
  "no_show", "audio_fail", "error", "joined_silent", "incomplete",
]);
const BOT_ID = /^[A-Za-z0-9_-]{8,100}$/;
const DEFAULT_MAX_STEP_ATTEMPTS = 20;
const DAY_MS = 24 * 60 * 60_000;
export const RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS =
  DEFAULT_RESUME_TERMINAL_ACK_HOURS * 60 * 60_000;
// Compatibility aliases for the old boundary exports. They now represent the
// generous terminal-acknowledgement operations deadline, not a blind grace.
export const RESUME_WAIT_CHASE_GRACE_MS =
  RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS;
export const RESUME_WAIT_TERMINAL_SETTLE_MS =
  RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS;
const RESUME_ATTACH_SOURCE_PREFIX = "resume_attached:";
export const RESUME_WAIT_TERMINAL_REASON = "No resume after 7 days of retries and chase emails";
const LEGACY_BACKFILL_REASON_TOKENS = new Set([
  "talent network consent",
  "active market evidence",
  "open to opportunities evidence",
  "market evidence quote",
  "preference company stages",
  "preference workplace types",
  "preference locations",
  "location provenance",
  "preference minimum base salary",
  "resume",
  "no resume phase1",
  "no resume on profile resume wait ships phase 2",
]);

const bool = (value, fallback = false) => {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const finiteDate = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

export function automationConfig(env = process.env) {
  const notBeforeMs = finiteDate(env.PARAAI_AUTO_NOT_BEFORE);
  const phase1DeployedAtMs = finiteDate(env.PARAAI_PHASE1_DEPLOYED_AT);
  const resumeWait = resumeWaitSettings(env);
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
    resumeWaitMinutes: resumeWait.waitMinutes,
    resumeWaitEnabled: bool(env.PARAAI_RESUME_WAIT_ENABLED),
    resumeSignalConfigured: (
      String(env.PARAAI_RESUME_SIGNAL_SECRET || "").trim().length >= 24
    ),
    resumeRetryDays: resumeWait.retryDays,
    resumeTerminalAckHours: resumeWait.terminalAckHours,
    resumeBackfillTerminalAckDays:
      resumeWait.backfillTerminalAckDays,
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
    config.phase1DeployedAtMs != null &&
    (!config.resumeWaitEnabled || config.resumeSignalConfigured === true),
  );
}

export function automationApprovalSource(queueSource) {
  if (queueSource === "authorized_backfill") {
    return "authorized_backfill_2026-07-16";
  }
  if (queueSource === HUMAN_CALL_QUEUE_SOURCE) {
    return "paraform_human_call_verified_automation";
  }
  return "recall_verified_automation";
}

export function automationApprovalSourceForJob(
  job,
  queueSource,
  { historicalAuthorized = false } = {},
) {
  if (historicalAuthorized) {
    return automationApprovalSource("authorized_backfill");
  }
  return automationApprovalSource(
    job?.humanCall === true || isHumanCallJob(job?.id)
      ? HUMAN_CALL_QUEUE_SOURCE
      : queueSource,
  );
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
    : normalizedCode === "RESUME_ATTACH_REDUE_FAILED"
      ? 1_000
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
  if (job?.humanCall === true) {
    if (job?.humanCallMeta?.provenanceVerified !== true) {
      reasons.push("human call provenance");
    }
  } else if (config.strictScreenerSource && job?.callSourceVerified !== true) {
    reasons.push("call source");
  }
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
  const resumeFirstCheckAt = config.resumeWaitEnabled
    ? finiteDate(job?.automation?.resumeWait?.firstCheckAt)
    : null;
  const callEndedAtMs = finiteDate(job?.callEndedAt);
  if (callEndedAtMs == null && resumeFirstCheckAt == null) {
    return { ready: false, dueAt: null, reason: "call end timestamp is missing" };
  }
  const waitMinutes = Number.isFinite(Number(config.resumeWaitMinutes))
    ? Math.max(0, Number(config.resumeWaitMinutes))
    : DEFAULT_RESUME_WAIT_MINUTES;
  const dueAt = resumeFirstCheckAt ?? callEndedAtMs + waitMinutes * 60_000;
  return {
    ready: Number(now) >= dueAt,
    dueAt,
    reason: Number(now) >= dueAt ? null : "one-hour post-call grace period",
  };
}

function resumeWaitScheduledAt(wait, checkNumber) {
  const anchor = finiteDate(wait?.enteredAt);
  const first = finiteDate(wait?.firstCheckAt);
  const normalizedCheck = Math.max(1, Math.floor(Number(checkNumber) || 1));
  if (anchor == null || first == null) return null;
  return normalizedCheck === 1
    ? first
    : anchor + (normalizedCheck - 1) * DAY_MS;
}

export { resumeWaitPlan };

export function resumeWaitSource(queueSource = "unknown") {
  const source = String(queueSource || "unknown");
  if (source === "authorized_backfill") return "authorized_backfill";
  if (source === "phase1_resume_sweep") return "phase1_sweep";
  return "organic";
}

export function isResumeAttachTrigger(queueSource, resumeWait = null) {
  const source = String(queueSource || "");
  return Boolean(
    source.startsWith(RESUME_ATTACH_SOURCE_PREFIX) &&
    source !== String(resumeWait?.lastTrigger || ""),
  );
}

export function resumeWaitCheckDecision(
  job,
  config = automationConfig(),
  { queueSource = "unknown", now = Date.now() } = {},
) {
  const wait = job?.automation?.resumeWait;
  const nextCheckAt = finiteDate(wait?.nextCheckAt);
  const retryDays = Number.isFinite(Number(config.resumeRetryDays))
    ? Math.max(1, Math.floor(Number(config.resumeRetryDays)))
    : DEFAULT_RESUME_RETRY_DAYS;
  const totalScheduledChecks = retryDays + 1;
  const attachTriggered = isResumeAttachTrigger(queueSource, wait);
  const scheduledDue = nextCheckAt != null && Number(now) >= nextCheckAt;
  return {
    check: attachTriggered || scheduledDue,
    scheduled: !attachTriggered && scheduledDue,
    attachTriggered,
    trigger: attachTriggered ? String(queueSource) : "scheduled",
    dueAt: nextCheckAt,
    totalScheduledChecks,
  };
}

export function automationFreezeDecision(
  job,
  config = automationConfig(),
  { queueSource = "unknown" } = {},
) {
  if (
    queueSource === HUMAN_CALL_QUEUE_SOURCE
    || job?.humanCall === true
    || isHumanCallJob(job?.id)
  ) {
    return { frozen: false, mode: "human_call", reason: null };
  }
  if (
    queueSource === "authorized_backfill" ||
    job?.automation?.mode === "authorized_backfill" ||
    job?.automation?.resumeWait?.source === "authorized_backfill"
  ) {
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
    (
      !job?.reviewPolicy?.preferenceRouting ||
      job?.automation?.preferenceRerouteRequired === true
    ),
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

function backfillReasonToken(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function backfillReasonValues(job) {
  const values = [];
  for (const reason of Array.isArray(job?.reviewReasons) ? job.reviewReasons : []) {
    if (!reason) continue;
    if (typeof reason === "string") {
      values.push(reason);
      continue;
    }
    values.push(reason.code, reason.message || reason.detail);
  }
  values.push(job?.reviewReason);
  values.push(...(Array.isArray(job?.automation?.reasons) ? job.automation.reasons : []));
  return [...new Set(values.map(backfillReasonToken).filter(Boolean))];
}

export function backfillReviewDecision(job) {
  if (job?.humanCall === true || isHumanCallJob(job?.id)) {
    return { eligible: false, reason: "human_call_lane", reasons: [] };
  }
  if (!BACKFILL_REOPEN_STATES.has(String(job?.state || ""))) {
    return { eligible: false, reason: "state_preserved", reasons: [] };
  }
  if (!job?.extracted || !job?.identity?.candidateUserId) {
    return { eligible: false, reason: "stored_routing_inputs_missing", reasons: [] };
  }
  if (job?.identity?.ambiguous === true) {
    return { eligible: false, reason: "identity_review", reasons: [] };
  }
  if (
    job?.error ||
    job?.automation?.lastFailure ||
    Object.keys(job?.automation?.stepFailures || {}).length
  ) {
    return { eligible: false, reason: "technical_review", reasons: [] };
  }
  if (!normalizeEmail(job?.submission?.email)) {
    return { eligible: false, reason: "email_review", reasons: [] };
  }
  if (!normLinkedin(job?.submission?.linkedinUrl)) {
    return { eligible: false, reason: "linkedin_review", reasons: [] };
  }

  const reasons = backfillReasonValues(job);
  const unknownReasons = reasons.filter((reason) => !LEGACY_BACKFILL_REASON_TOKENS.has(reason));
  if (unknownReasons.length) {
    return { eligible: false, reason: "hard_review_reason", reasons };
  }
  if (job.state === "needs_review" && !reasons.length) {
    return { eligible: false, reason: "unclassified_review", reasons };
  }
  if (
    job.state === "ready_to_submit" &&
    job?.automation?.status === "needs_review" &&
    !reasons.length
  ) {
    return { eligible: false, reason: "unclassified_review", reasons };
  }
  return { eligible: true, reason: null, reasons };
}

export function ensureResumeWaitPlan(
  job,
  config = automationConfig(),
  {
    queueSource = "unknown",
    anchorAt = null,
    source = null,
  } = {},
) {
  const existing = job?.automation?.resumeWait;
  if (
    finiteDate(existing?.enteredAt) != null &&
    finiteDate(existing?.firstCheckAt) != null &&
    finiteDate(existing?.expiresAt) != null
  ) {
    return existing;
  }
  const resolvedAnchor = finiteDate(anchorAt) ?? finiteDate(job?.callEndedAt);
  return resumeWaitPlan({
    source: source || resumeWaitSource(queueSource),
    anchorAt: resolvedAnchor,
    callEndedAt: finiteDate(job?.callEndedAt) ?? resolvedAnchor,
    waitMinutes: config.resumeWaitMinutes,
    retryDays: config.resumeRetryDays,
    terminalAckHours: config.resumeTerminalAckHours,
    backfillTerminalAckDays:
      config.resumeBackfillTerminalAckDays,
  });
}

function resumeCheckJournalDetail(wait, total, { scheduled, found }) {
  const count = Math.max(0, Number(wait?.scheduledChecks) || 0);
  const trigger = scheduled ? "" : " (attach trigger)";
  return `resume check ${count}/${total}${trigger}: ${found ? "resume on file" : "none on file"}`;
}

function resumeTerminalAckDeadlineAt(
  wait,
  config = {},
  openedAt = Date.now(),
) {
  const hours = Number(config.resumeTerminalAckHours);
  const organicDeadline = Number(openedAt) + (
    Number.isFinite(hours)
      ? Math.max(
          MIN_RESUME_TERMINAL_ACK_HOURS,
          Math.min(MAX_RESUME_TERMINAL_ACK_HOURS, hours),
        )
      : DEFAULT_RESUME_TERMINAL_ACK_HOURS
  ) * 60 * 60_000;
  const existingClaimDeadline = finiteDate(wait?.claimableThroughAt) ?? 0;
  if (!["authorized_backfill", "phase1_sweep"].includes(wait?.source)) {
    return Math.max(organicDeadline, existingClaimDeadline);
  }
  const configuredDays = Number(
    config.resumeBackfillTerminalAckDays,
  );
  const days = Number.isFinite(configuredDays)
    ? Math.max(
        MIN_RESUME_BACKFILL_TERMINAL_ACK_DAYS,
        Math.min(
          MAX_RESUME_BACKFILL_TERMINAL_ACK_DAYS,
          configuredDays,
        ),
      )
    : DEFAULT_RESUME_BACKFILL_TERMINAL_ACK_DAYS;
  const anchorAt = finiteDate(wait?.enteredAt);
  return Math.max(
    organicDeadline,
    existingClaimDeadline,
    (anchorAt ?? Number(openedAt)) + days * DAY_MS,
  );
}

export function resumeWaitMissingTransition(
  job,
  config = automationConfig(),
  {
    queueSource = "unknown",
    now = Date.now(),
    probeStartedAt = now,
    wait: suppliedWait = null,
  } = {},
) {
  const wait = suppliedWait || ensureResumeWaitPlan(job, config, { queueSource });
  const decision = resumeWaitCheckDecision({
    ...job,
    automation: { ...(job?.automation || {}), resumeWait: wait },
  }, config, { queueSource, now });
  if (!decision.check) return { job, decision, expired: false };

  const scheduledChecks = decision.scheduled
    ? Math.min(
        decision.totalScheduledChecks,
        Math.max(0, Number(wait.scheduledChecks) || 0) + 1,
      )
    : Math.max(0, Number(wait.scheduledChecks) || 0);
  const nextScheduledAt = scheduledChecks < decision.totalScheduledChecks
    ? resumeWaitScheduledAt(wait, scheduledChecks + 1)
    : null;
  const nextWait = {
    ...wait,
    scheduledChecks,
    nextCheckAt: nextScheduledAt == null ? null : new Date(nextScheduledAt).toISOString(),
    lastCheckedAt: new Date(now).toISOString(),
    lastTrigger: decision.attachTriggered ? decision.trigger : wait.lastTrigger,
  };
  const expired = Boolean(
    decision.scheduled &&
    scheduledChecks >= decision.totalScheduledChecks &&
    Number(now) >= finiteDate(wait.expiresAt),
  );
  if (expired) {
    const openedAt = Number(now);
    const markerSinceAt = finiteDate(probeStartedAt) ?? openedAt;
    const opsDeadlineAt = resumeTerminalAckDeadlineAt(
      wait,
      config,
      openedAt,
    );
    const nextJob = transition(job, "waiting_for_resume", {
      reviewReason: (job?.reviewReasons || [])
        .find((reason) => reason?.code !== "no_resume_phase1")?.code || null,
      reviewReasons: (job?.reviewReasons || [])
        .filter((reason) => reason?.code !== "no_resume_phase1"),
      automation: {
        ...(job?.automation || {}),
        status: "waiting_for_resume",
        reasons: [],
        resumeWait: {
          ...nextWait,
          nextCheckAt: new Date(opsDeadlineAt).toISOString(),
          terminalAck: {
            status: "awaiting_ack",
            openedAt: new Date(openedAt).toISOString(),
            markerSinceAt: new Date(markerSinceAt).toISOString(),
            opsDeadlineAt: new Date(opsDeadlineAt).toISOString(),
          },
        },
        resumeWaitSweepEligible: false,
      },
      submission: {
        ...(job?.submission || {}),
        resumeUri: "",
        resumeStatus: "missing",
      },
      journalDetail: resumeCheckJournalDetail(
        nextWait,
        decision.totalScheduledChecks,
        { scheduled: decision.scheduled, found: false },
      ),
    });
    return { job: nextJob, decision, expired: true, settling: true };
  }

  return {
    job: transition(job, "waiting_for_resume", {
      reviewReason: (job?.reviewReasons || [])
        .find((reason) => reason?.code !== "no_resume_phase1")?.code || null,
      reviewReasons: (job?.reviewReasons || [])
        .filter((reason) => reason?.code !== "no_resume_phase1"),
      automation: {
        ...(job?.automation || {}),
        status: "waiting_for_resume",
        reasons: [],
        resumeWait: nextWait,
        resumeWaitSweepEligible: false,
      },
      submission: {
        ...(job?.submission || {}),
        resumeUri: "",
        resumeStatus: "missing",
      },
      journalDetail: resumeCheckJournalDetail(
        nextWait,
        decision.totalScheduledChecks,
        { scheduled: decision.scheduled, found: false },
      ),
    }),
    decision,
    expired: false,
  };
}

export function resumeWaitFoundTransition(
  job,
  resumeUri,
  config = automationConfig(),
  {
    queueSource = "unknown",
    now = Date.now(),
  } = {},
) {
  const wait = ensureResumeWaitPlan(job, config, { queueSource });
  const decision = resumeWaitCheckDecision({
    ...job,
    automation: { ...(job?.automation || {}), resumeWait: wait },
  }, config, { queueSource, now });
  const scheduledChecks = decision.scheduled
    ? Math.min(
        decision.totalScheduledChecks,
        Math.max(0, Number(wait.scheduledChecks) || 0) + 1,
      )
    : Math.max(0, Number(wait.scheduledChecks) || 0);
  const nextWait = {
    ...wait,
    scheduledChecks,
    nextCheckAt: null,
    lastCheckedAt: new Date(now).toISOString(),
    lastTrigger: decision.attachTriggered ? decision.trigger : wait.lastTrigger,
    terminalAck: undefined,
  };
  const remainingReviewReasons = (job?.reviewReasons || [])
    .filter((reason) => ![
      "no_resume_phase1",
      "no_resume_after_7_days",
      RESUME_ATTACHMENT_PENDING_REVIEW_CODE,
      RESUME_RECEIVED_REVIEW_CODE,
    ].includes(reason?.code));
  const nextState = remainingReviewReasons.length ? "needs_review" : "ready_to_submit";
  return transition(job, nextState, {
    reviewReason: remainingReviewReasons[0]?.code || null,
    reviewReasons: remainingReviewReasons,
    automation: {
      ...(job?.automation || {}),
      status: remainingReviewReasons.length ? "needs_review" : "resume_on_file",
      reasons: remainingReviewReasons.map((reason) => reason.message || reason.code),
      resumeWait: nextWait,
      resumeWaitSweepEligible: false,
    },
    submission: {
      ...(job?.submission || {}),
      resumeUri: String(resumeUri || "").trim(),
      resumeStatus: "on_file",
    },
    journalDetail: resumeCheckJournalDetail(
      nextWait,
      decision.totalScheduledChecks,
      { scheduled: decision.scheduled, found: true },
    ),
  });
}

export function isTerminalResumeWaitReview(job) {
  const terminalReasons = new Map([
    ["no_resume_after_7_days", RESUME_WAIT_TERMINAL_REASON],
    [
      RESUME_ATTACHMENT_PENDING_REVIEW_CODE,
      RESUME_ATTACHMENT_PENDING_REVIEW_MESSAGE,
    ],
    [RESUME_RECEIVED_REVIEW_CODE, RESUME_RECEIVED_REVIEW_MESSAGE],
  ]);
  const expectedMessage = terminalReasons.get(job?.reviewReason);
  return Boolean(
    job?.state === "needs_review" &&
    expectedMessage &&
    Array.isArray(job?.reviewReasons) &&
    job.reviewReasons.some((reason) => (
      reason?.code === job.reviewReason &&
      reason?.message === expectedMessage
    )) &&
    finiteDate(job?.automation?.resumeWait?.expiresAt) != null
  );
}

function terminalResumeReviewDetail(job) {
  return String(
    (job?.reviewReasons || []).find((reason) => (
      reason?.code === job?.reviewReason
    ))?.message
    || RESUME_WAIT_TERMINAL_REASON,
  );
}

export function resumeWaitTerminalSettleDecision(
  job,
  {
    now = Date.now(),
    sharedState = null,
    config = automationConfig(),
  } = {},
) {
  const terminal = job?.automation?.resumeWait?.terminalAck;
  const terminalOpsDeadlineAt = finiteDate(terminal?.opsDeadlineAt);
  const storedClaimDeadlineAt = finiteDate(
    job?.automation?.resumeWait?.claimableThroughAt,
  );
  const storedOpsDeadlineAt = Math.max(
    terminalOpsDeadlineAt ?? 0,
    storedClaimDeadlineAt ?? 0,
  ) || null;
  const markerSinceAt = finiteDate(terminal?.markerSinceAt);
  const settling = Boolean(
    job?.state === "waiting_for_resume" &&
    terminal?.status === "awaiting_ack" &&
    terminalOpsDeadlineAt != null &&
    markerSinceAt != null &&
    Number(job?.automation?.resumeWait?.scheduledChecks) > 0
  );
  const chain = sharedState?.chain || null;
  const terminalAck = chain?.terminalAck;
  const explicitAck = Boolean(
    terminalAck
    && terminalAck.touch === 3
    && ["delivered", "terminal_no_send"].includes(terminalAck.outcome)
    && finiteDate(terminalAck.acknowledgedAt) != null
  );
  const chainStopped = Boolean(
    chain?.stopped === true || chain?.status === "stopped",
  );
  const nextDeliveryDeadline = resumeChaseNextDeliveryAckDeadline(
    chain,
    {
      terminalAckHours: config.resumeTerminalAckHours,
    },
  );
  const opsDeadlineAt = Math.max(
    storedOpsDeadlineAt ?? 0,
    nextDeliveryDeadline ?? 0,
  ) || null;
  const acknowledged = explicitAck || chainStopped;
  const deadlineElapsed = settling && Number(now) >= opsDeadlineAt;
  const outcome = explicitAck
    ? terminalAck.outcome
    : chainStopped
      ? "terminal_no_send"
      : deadlineElapsed
        ? "ops_deadline_elapsed"
        : null;
  const acknowledgedAt = explicitAck
    ? finiteDate(terminalAck.acknowledgedAt)
    : chainStopped
      ? finiteDate(chain?.stoppedAt)
      : null;
  return {
    settling,
    acknowledged,
    deadlineElapsed,
    readyToClose: settling && (acknowledged || deadlineElapsed),
    delayMs: settling
      ? Math.max(1_000, opsDeadlineAt - Number(now))
      : null,
    markerSinceAt,
    opsDeadlineAt,
    deadlineExtended: Boolean(
      settling
      && storedOpsDeadlineAt != null
      && opsDeadlineAt > storedOpsDeadlineAt
    ),
    outcome,
    acknowledgedAt,
    stopReason: chainStopped
      ? String(chain?.stopReason || "terminal_no_send")
      : null,
  };
}

export function resumeWaitTerminalTransition(
  job,
  config = automationConfig(),
  {
    queueSource = "unknown",
    now = Date.now(),
    terminalOutcome = null,
    acknowledgedAt = null,
    terminalStopReason = null,
  } = {},
) {
  const wait = job?.automation?.resumeWait;
  const decision = resumeWaitCheckDecision(job, config, { queueSource, now });
  const attachTriggered = decision.attachTriggered;
  const resolvedTerminalOutcome = terminalOutcome
    || wait?.terminalAck?.outcome
    || "ops_deadline_elapsed";
  const resolvedAcknowledgedAt = acknowledgedAt
    ?? finiteDate(wait?.terminalAck?.acknowledgedAt);
  const terminalReview = terminalStopReason === "resume_received"
    ? {
        code: RESUME_ATTACHMENT_PENDING_REVIEW_CODE,
        message: RESUME_ATTACHMENT_PENDING_REVIEW_MESSAGE,
      }
    : terminalStopReason === RESUME_RECEIVED_REVIEW_CODE
      ? {
          code: RESUME_RECEIVED_REVIEW_CODE,
          message: RESUME_RECEIVED_REVIEW_MESSAGE,
        }
      : {
          code: "no_resume_after_7_days",
          message: RESUME_WAIT_TERMINAL_REASON,
        };
  const nextWait = {
    ...wait,
    nextCheckAt: null,
    lastCheckedAt: new Date(now).toISOString(),
    lastTrigger: attachTriggered ? decision.trigger : wait?.lastTrigger || null,
    terminalAck: wait?.terminalAck
      ? {
          ...wait.terminalAck,
          status: resolvedTerminalOutcome === "ops_deadline_elapsed"
            ? "deadline_elapsed"
            : "acknowledged",
          outcome: resolvedTerminalOutcome,
          acknowledgedAt: resolvedAcknowledgedAt == null
            ? null
            : new Date(resolvedAcknowledgedAt).toISOString(),
          closedAt: new Date(now).toISOString(),
        }
      : undefined,
  };
  return transition(job, "needs_review", {
    reviewReason: terminalReview.code,
    reviewReasons: mergeReviewReasons(
      {
        ...job,
        reviewReasons: (job?.reviewReasons || [])
          .filter((reason) => ![
            "no_resume_phase1",
            "no_resume_after_7_days",
            RESUME_ATTACHMENT_PENDING_REVIEW_CODE,
            RESUME_RECEIVED_REVIEW_CODE,
          ].includes(reason?.code)),
      },
      reviewReason(terminalReview.code, terminalReview.message),
    ),
    automation: {
      ...(job?.automation || {}),
      status: "needs_review",
      reasons: [terminalReview.message],
      resumeWait: nextWait,
      resumeWaitSweepEligible: false,
    },
    submission: {
      ...(job?.submission || {}),
      resumeUri: "",
      resumeStatus: "missing",
    },
    journalDetail: attachTriggered
      ? resumeCheckJournalDetail(
          nextWait,
          decision.totalScheduledChecks,
          { scheduled: false, found: false },
        )
      : resolvedTerminalOutcome === "delivered"
        ? "resume wait closed after touch-3 delivery acknowledgement"
        : resolvedTerminalOutcome === "terminal_no_send"
          ? "resume wait closed after touch-3 terminal no-send acknowledgement"
          : "resume wait closed at the terminal acknowledgement operations deadline",
  });
}

export function resumeWaitTerminalMarkerMissingTransition(
  job,
  config = automationConfig(),
  {
    queueSource = "unknown",
    now = Date.now(),
  } = {},
) {
  const wait = job?.automation?.resumeWait;
  const decision = resumeWaitCheckDecision(job, config, { queueSource, now });
  if (
    job?.state !== "waiting_for_resume"
    || wait?.terminalAck?.status !== "awaiting_ack"
    || !decision.attachTriggered
  ) {
    return job;
  }
  const nextWait = {
    ...wait,
    lastCheckedAt: new Date(now).toISOString(),
    lastTrigger: decision.trigger,
  };
  return transition(job, "waiting_for_resume", {
    automation: {
      ...(job?.automation || {}),
      status: "waiting_for_resume",
      resumeWait: nextWait,
    },
    journalDetail: resumeCheckJournalDetail(
      nextWait,
      decision.totalScheduledChecks,
      { scheduled: false, found: false },
    ),
  });
}

export function resumeWaitTerminalDeadlineTransition(
  job,
  {
    opsDeadlineAt,
    now = Date.now(),
  } = {},
) {
  const deadline = finiteDate(opsDeadlineAt);
  const current = finiteDate(
    job?.automation?.resumeWait?.terminalAck?.opsDeadlineAt,
  );
  if (
    job?.state !== "waiting_for_resume"
    || job?.automation?.resumeWait?.terminalAck?.status !== "awaiting_ack"
    || deadline == null
    || current == null
    || deadline <= current
  ) {
    return job;
  }
  const nextWait = {
    ...job.automation.resumeWait,
    claimableThroughAt: new Date(deadline).toISOString(),
    nextCheckAt: new Date(deadline).toISOString(),
    terminalAck: {
      ...job.automation.resumeWait.terminalAck,
      opsDeadlineAt: new Date(deadline).toISOString(),
    },
  };
  return transition(job, "waiting_for_resume", {
    automation: {
      ...(job.automation || {}),
      status: "waiting_for_resume",
      resumeWait: nextWait,
    },
    journalDetail:
      "resume terminal acknowledgement deadline extended for the next legitimate chase delivery",
  });
}

export function resumeWaitTerminalAttachMissingTransition(
  job,
  config = automationConfig(),
  {
    queueSource = "unknown",
    now = Date.now(),
  } = {},
) {
  if (!isTerminalResumeWaitReview(job)) return job;
  const decision = resumeWaitCheckDecision(job, config, { queueSource, now });
  if (!decision.attachTriggered) return job;
  return resumeWaitTerminalTransition(job, config, { queueSource, now });
}

export async function ensureRecentResumeAttachRedue(
  job,
  {
    probeStartedAt,
    now = Date.now(),
    getSignalImpl = getRecentResumeAttachedSignal,
    enqueueImpl = enqueueAutoJob,
  } = {},
) {
  const candidateUserId = String(job?.identity?.candidateUserId || "").trim();
  const probeAt = Number(probeStartedAt);
  if (!candidateUserId || !Number.isFinite(probeAt)) {
    return { redue: false, reason: "probe_unavailable" };
  }
  try {
    const signal = await getSignalImpl(candidateUserId, { now });
    const receivedAt = finiteDate(signal?.receivedAt);
    const eventHash = String(signal?.eventHash || "");
    if (
      receivedAt == null ||
      receivedAt < probeAt ||
      !/^[a-f0-9]{64}$/.test(eventHash)
    ) {
      return { redue: false, reason: "no_new_signal" };
    }
    const queued = await enqueueImpl(job.id, {
      source: `${RESUME_ATTACH_SOURCE_PREFIX}${eventHash}`,
      eventId: `resume-race:${job.id}:${eventHash}`,
      dueAt: Number(now),
      now: Number(now),
    });
    return {
      redue: true,
      enqueued: queued?.enqueued === true,
      duplicate: queued?.duplicate === true,
    };
  } catch (error) {
    const wrapped = new Error(String(error?.message || error || "resume attach re-due failed"));
    wrapped.code = "RESUME_ATTACH_REDUE_FAILED";
    wrapped.step = "resume_attach_redue";
    wrapped.job = job;
    throw wrapped;
  }
}

export function isPhase1ResumeWaitCard(job) {
  return Boolean(
    job?.state === "needs_review" &&
    job?.automation?.resumeWaitSweepEligible === true &&
    job?.reviewReason === "no_resume_phase1" &&
    Array.isArray(job?.reviewReasons) &&
    job.reviewReasons.some((reason) => reason?.code === "no_resume_phase1"),
  );
}

export function phase1ResumeWaitSweepTransition(
  job,
  config = automationConfig(),
  { now = Date.now() } = {},
) {
  if (!isPhase1ResumeWaitCard(job)) return null;
  const wait = resumeWaitPlan({
    source: "phase1_sweep",
    anchorAt: now,
    waitMinutes: config.resumeWaitMinutes,
    retryDays: config.resumeRetryDays,
    terminalAckHours: config.resumeTerminalAckHours,
    backfillTerminalAckDays:
      config.resumeBackfillTerminalAckDays,
  });
  return transition(job, "waiting_for_resume", {
    reviewReason: null,
    reviewReasons: job.reviewReasons.filter((reason) => reason?.code !== "no_resume_phase1"),
    automation: {
      ...(job.automation || {}),
      status: "waiting_for_resume",
      reasons: [],
      resumeWait: wait,
      resumeWaitSweepEligible: false,
    },
    journalDetail: "Phase 1 no-resume card swept into the Phase 2 resume wait",
  });
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
  const step = job?.humanCall === true ? "human_call_read" : "call_read";
  const call = await runStep(
    step,
    () => job?.humanCall === true
      ? fetchHumanCall(callIdFromHumanJob(job.id))
      : fetchCall(job.id),
  );
  const endedAt = resolveCallEndedAt(call, fallback || job?.updatedAt || job?.createdAt);
  if (endedAt == null) {
    const error = new Error("call end timestamp is missing");
    error.code = "CALL_END_TIMESTAMP_MISSING";
    error.step = step;
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

function resumeWaitDelay(wait, now = Date.now()) {
  const nextCheckAt = finiteDate(wait?.nextCheckAt);
  return nextCheckAt == null
    ? 1_000
    : Math.max(1_000, nextCheckAt - Number(now));
}

function resumeChaseScopeForJob(job) {
  const chainAnchorAt = String(
    job?.automation?.resumeWait?.enteredAt || "",
  );
  return {
    jobId: String(job?.id || ""),
    chainAnchorAt,
    chainCallEndedAt: finiteDate(job?.callEndedAt) == null
      ? ""
      : new Date(finiteDate(job.callEndedAt)).toISOString(),
    chainId: resumeChaseChainId(job?.id, chainAnchorAt),
  };
}

async function stopResumeChase(job, reason, runStep = trackedAutomationStep) {
  const candidateUserId = String(job?.identity?.candidateUserId || "").trim();
  if (!candidateUserId || !job?.automation?.resumeWait) return null;
  try {
    return await runStep(
      "resume_chase_stop",
      () => stopResumeAskSuppression(candidateUserId, {
        reason,
        ...resumeChaseScopeForJob(job),
      }),
    );
  } catch (error) {
    error.code = "RESUME_CHASE_STOP_FAILED";
    error.step = "resume_chase_stop";
    error.job = job;
    throw error;
  }
}

async function readResumeChaseState(
  job,
  runStep = trackedAutomationStep,
) {
  const candidateUserId = String(
    job?.identity?.candidateUserId || "",
  ).trim();
  if (!candidateUserId || !job?.automation?.resumeWait) return null;
  const { chainId } = resumeChaseScopeForJob(job);
  try {
    return await runStep(
      "resume_chase_read",
      () => getResumeAskSuppression(candidateUserId, { chainId }),
    );
  } catch (error) {
    error.code = "RESUME_CHASE_READ_FAILED";
    error.step = "resume_chase_read";
    error.job = job;
    throw error;
  }
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
    getJobImpl = getJob,
    submitJobImpl = pipelineSubmitJob,
  } = {},
) {
  const id = String(botId || "").trim();
  const submitJob = submitJobImpl;
  const runStep = (step, operation) => trackedAutomationStep(step, operation, succeededSteps);
  let historicalAuthorized = queueSource === "authorized_backfill";
  let humanIntake = (
    queueSource === HUMAN_CALL_QUEUE_SOURCE
    || isHumanCallJob(id)
  );
  if (!BOT_ID.test(id)) return { action: "complete", state: "invalid", detail: "invalid bot id" };
  if (!automationExecutionEnabled(config)) {
    return { action: "reschedule", delayMs: 5 * 60_000, state: "paused", detail: "automation is paused" };
  }

  let job = await getJobImpl(id);
  let verifiedResumeUri = "";
  humanIntake = humanIntake || job?.humanCall === true;
  if (
    job?.automation?.mode === "authorized_backfill" ||
    job?.automation?.resumeWait?.source === "authorized_backfill"
  ) {
    historicalAuthorized = true;
  }
  const approvalSource = automationApprovalSourceForJob(job, queueSource, {
    historicalAuthorized,
  });
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
  if (job && !historicalAuthorized && !humanIntake) {
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
    (
      !humanIntake
      && config.strictScreenerSource
      && job.callSourceVerified !== true
      && job.state === "ready_to_submit"
    )
  ) {
    const callReadStep = humanIntake ? "human_call_read" : "call_read";
    const call = await runStep(
      callReadStep,
      () => humanIntake
        ? fetchHumanCall(callIdFromHumanJob(id))
        : fetchCall(id),
    );
    const readiness = humanIntake
      ? humanCallReadiness(call)
      : automationCallReadiness(call, config, {
          historicalAuthorized,
          queueSource,
          queueAttempts,
        });
    if (!readiness.ready) {
      if (humanIntake && readiness.terminal && job) {
        job = await saveJob(transition(job, "needs_review", {
          reviewReason: "human_call_substance_gate",
          reviewReasons: mergeReviewReasons(
            job,
            reviewReason("human_call_substance_gate", readiness.reason),
          ),
          automation: {
            ...(job.automation || {}),
            status: "needs_review",
            reasons: [readiness.reason],
            evaluatedAt: new Date().toISOString(),
          },
          journalDetail: readiness.reason,
        }), job.revision);
        return {
          action: "complete",
          state: job.state,
          detail: readiness.reason,
          step: callReadStep,
          job,
        };
      }
      return readiness.terminal
        ? { action: "complete", state: "ineligible_call", detail: readiness.reason, step: callReadStep }
        : { action: "reschedule", delayMs: 30_000, state: "waiting_for_artifacts", detail: readiness.reason, step: callReadStep };
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
            callRecord: call,
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

  if (
    config.resumeWaitEnabled &&
    isTerminalResumeWaitReview(job) &&
    isResumeAttachTrigger(queueSource, job.automation?.resumeWait)
  ) {
    const resume = await runStep(
      "resume_read",
      () => getResume(job.identity?.candidateUserId),
    );
    const resumeUri = findResumeUri(resume);
    if (resumeUri) {
      verifiedResumeUri = resumeUri;
      await stopResumeChase(job, "resume_detected", runStep);
      job = await saveJob(
        resumeWaitFoundTransition(job, resumeUri, config, {
          queueSource,
          now: Date.now(),
        }),
        job.revision,
      );
    } else {
      job = await saveJob(
        resumeWaitTerminalAttachMissingTransition(job, config, {
          queueSource,
          now: Date.now(),
        }),
        job.revision,
      );
      return {
        action: "complete",
        state: job.state,
        detail: terminalResumeReviewDetail(job),
        alert: {
          code: "NO_RESUME_AFTER_RETRIES",
          detail: terminalResumeReviewDetail(job),
          ttlSeconds: 180 * 24 * 60 * 60,
        },
        job,
      };
    }
  }

  let terminalSettle = resumeWaitTerminalSettleDecision(job, {
    now: Date.now(),
    config,
  });
  if (config.resumeWaitEnabled && terminalSettle.settling) {
    if (isResumeAttachTrigger(queueSource, job.automation?.resumeWait)) {
      const resume = await runStep(
        "resume_read",
        () => getResume(job.identity?.candidateUserId),
      );
      const resumeUri = findResumeUri(resume);
      if (resumeUri) {
        verifiedResumeUri = resumeUri;
        await stopResumeChase(job, "resume_detected", runStep);
        job = await saveJob(
          resumeWaitFoundTransition(job, resumeUri, config, {
            queueSource,
            now: Date.now(),
          }),
          job.revision,
        );
      } else {
        job = await saveJob(
          resumeWaitTerminalMarkerMissingTransition(job, config, {
            queueSource,
            now: Date.now(),
          }),
          job.revision,
        );
      }
    }
    if (job.state === "waiting_for_resume") {
      const sharedState = await readResumeChaseState(job, runStep);
      terminalSettle = resumeWaitTerminalSettleDecision(job, {
        now: Date.now(),
        sharedState,
        config,
      });
      if (terminalSettle.deadlineExtended) {
        job = await saveJob(
          resumeWaitTerminalDeadlineTransition(job, {
            opsDeadlineAt: terminalSettle.opsDeadlineAt,
            now: Date.now(),
          }),
          job.revision,
        );
        terminalSettle = resumeWaitTerminalSettleDecision(job, {
          now: Date.now(),
          sharedState,
          config,
        });
      }
      if (!terminalSettle.readyToClose) {
        return {
          action: "reschedule",
          delayMs: terminalSettle.delayMs,
          state: job.state,
          detail: "awaiting touch-3 terminal acknowledgement",
          job,
        };
      }
      const raceRedue = await runStep(
        "resume_attach_redue",
        () => ensureRecentResumeAttachRedue(job, {
          probeStartedAt: terminalSettle.markerSinceAt,
          now: Date.now(),
        }),
      );
      if (raceRedue.redue) {
        return {
          action: "complete",
          state: job.state,
          detail: "resume attach race re-due scheduled",
          job,
        };
      }
      job = await saveJob(
        resumeWaitTerminalTransition(job, config, {
          queueSource,
          now: Date.now(),
          terminalOutcome: terminalSettle.outcome,
          acknowledgedAt: terminalSettle.acknowledgedAt,
          terminalStopReason: terminalSettle.stopReason,
        }),
        job.revision,
      );
      return {
        action: "complete",
        state: job.state,
        detail: terminalResumeReviewDetail(job),
        alert: {
          code: "NO_RESUME_AFTER_RETRIES",
          detail: terminalResumeReviewDetail(job),
          ttlSeconds: 180 * 24 * 60 * 60,
        },
        job,
      };
    }
  }

  if (job.state === "waiting_for_resume") {
    if (!config.resumeWaitEnabled) {
      return {
        action: "reschedule",
        delayMs: 5 * 60_000,
        state: job.state,
        detail: "resume-wait machinery is gated off",
      };
    }
    const check = resumeWaitCheckDecision(job, config, {
      queueSource,
      now: Date.now(),
    });
    if (!check.check) {
      return {
        action: "reschedule",
        delayMs: resumeWaitDelay(job.automation?.resumeWait),
        state: job.state,
        detail: "waiting for the next scheduled resume check",
      };
    }

    const resumeProbeStartedAt = Date.now();
    job = await runStep(
      "submission_read",
      () => advanceExistingTalentNetworkJob(job, { approvalSource }),
    );
    if (job.state === "awaiting_matches") {
      await stopResumeChase(job, "already_submitted", runStep);
      return {
        action: "complete",
        state: job.state,
        detail: "existing Talent Network membership verified; resume wait skipped",
        job,
      };
    }
    if (job.state === "error") return automationErrorResult(job, "submission_read");

    const resume = await runStep(
      "resume_read",
      () => getResume(job.identity?.candidateUserId),
    );
    const resumeUri = findResumeUri(resume);
    if (resumeUri) {
      verifiedResumeUri = resumeUri;
      await stopResumeChase(job, "resume_detected", runStep);
      job = await saveJob(
        resumeWaitFoundTransition(job, resumeUri, config, {
          queueSource,
          now: Date.now(),
        }),
        job.revision,
      );
    } else {
      const checked = resumeWaitMissingTransition(job, config, {
        queueSource,
        now: Date.now(),
        probeStartedAt: resumeProbeStartedAt,
      });
      job = await saveJob(checked.job, job.revision);
      const raceRedue = await runStep(
        "resume_attach_redue",
        () => ensureRecentResumeAttachRedue(job, {
          probeStartedAt: resumeProbeStartedAt,
          now: Date.now(),
        }),
      );
      if (checked.settling) {
        if (raceRedue.redue) {
          return {
            action: "complete",
            state: job.state,
            detail: "resume attach race re-due scheduled",
            job,
          };
        }
        const sharedState = await readResumeChaseState(job, runStep);
        const terminalDecision = resumeWaitTerminalSettleDecision(job, {
          now: Date.now(),
          sharedState,
          config,
        });
        if (terminalDecision.deadlineExtended) {
          job = await saveJob(
            resumeWaitTerminalDeadlineTransition(job, {
              opsDeadlineAt: terminalDecision.opsDeadlineAt,
              now: Date.now(),
            }),
            job.revision,
          );
        }
        const extendedDecision = resumeWaitTerminalSettleDecision(job, {
          now: Date.now(),
          sharedState,
          config,
        });
        if (extendedDecision.readyToClose) {
          job = await saveJob(
            resumeWaitTerminalTransition(job, config, {
              queueSource,
              now: Date.now(),
              terminalOutcome: extendedDecision.outcome,
              acknowledgedAt: extendedDecision.acknowledgedAt,
              terminalStopReason: extendedDecision.stopReason,
            }),
            job.revision,
          );
          return {
            action: "complete",
            state: job.state,
            detail: terminalResumeReviewDetail(job),
            alert: {
              code: "NO_RESUME_AFTER_RETRIES",
              detail: terminalResumeReviewDetail(job),
              ttlSeconds: 180 * 24 * 60 * 60,
            },
            job,
          };
        }
        return {
          action: "reschedule",
          delayMs: resumeWaitDelay(job.automation?.resumeWait),
          state: job.state,
          detail: "awaiting touch-3 terminal acknowledgement",
          job,
        };
      }
      return {
        action: "reschedule",
        delayMs: resumeWaitDelay(job.automation?.resumeWait),
        state: job.state,
        detail: "resume is not on the profile",
        step: "resume_read",
        job,
      };
    }
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
      await stopResumeChase(job, "already_submitted", runStep);
      return {
        action: "complete",
        state: job.state,
        detail: "existing Talent Network membership verified; submission write skipped",
        job,
      };
    }
    if (job.state === "error") return automationErrorResult(job, "submission_read");

    const resumeProbeStartedAt = Date.now();
    const resume = verifiedResumeUri
      ? { job, resumeUri: verifiedResumeUri }
      : await refreshResumeForSubmission(job, runStep);
    job = resume.job;
    if (resume.resumeUri && job?.automation?.resumeWait) {
      await stopResumeChase(job, "resume_detected", runStep);
    }
    if (!resume.resumeUri) {
      if (config.resumeWaitEnabled) {
        const wait = ensureResumeWaitPlan(job, config, { queueSource });
        const checked = resumeWaitMissingTransition(job, config, {
          queueSource,
          now: Date.now(),
          probeStartedAt: resumeProbeStartedAt,
          wait,
        });
        job = await saveJob(checked.job, job.revision);
        const raceRedue = await runStep(
          "resume_attach_redue",
          () => ensureRecentResumeAttachRedue(job, {
            probeStartedAt: resumeProbeStartedAt,
            now: Date.now(),
          }),
        );
        if (checked.settling) {
          if (raceRedue.redue) {
            return {
              action: "complete",
              state: job.state,
              detail: "resume attach race re-due scheduled",
              job,
            };
          }
          return {
            action: "reschedule",
            delayMs: resumeWaitDelay(job.automation?.resumeWait),
            state: job.state,
            detail: "closing the day-7 resume attach boundary",
            job,
          };
        }
        return {
          action: "reschedule",
          delayMs: resumeWaitDelay(job.automation?.resumeWait),
          state: job.state,
          detail: "resume is not on the profile",
          step: "resume_read",
          job,
        };
      }
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
      await stopResumeChase(job, "already_submitted", runStep);
      return {
        action: "complete",
        state: job.state,
        detail: "existing Talent Network membership verified; submission write skipped",
        job,
      };
    }
    await stopResumeChase(job, "submission_confirmed", runStep);
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
      await stopResumeChase(
        job,
        job.state === "awaiting_matches" ? "already_submitted" : "submission_confirmed",
        runStep,
      );
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
    if (job.state === "awaiting_approval") {
      await stopResumeChase(job, "submission_confirmed", runStep);
    }
    return {
      action: "reschedule",
      delayMs: approvalDelay(job),
      state: job.state,
      detail: job.state === "submission_unknown" ? "read-only reconciliation required" : "approval pending",
      step: "submit_reconciliation",
      job,
    };
  }
  if (job.state === "awaiting_matches") {
    await stopResumeChase(job, "submission_confirmed", runStep);
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

async function alertOnce(
  code,
  botId,
  detail,
  {
    ceiling = false,
    objection = false,
    ttlSeconds = null,
  } = {},
) {
  try {
    const key = objection
      ? `auto:sharing-objection:${botId}`
      : ceiling
        ? `auto:ceiling:${code}:${botId}`
        : code === "AUTH_EXPIRED"
          ? "auto-auth-expired"
          : `auto:${code}:${botId}`;
    const ttl = Number.isFinite(Number(ttlSeconds))
      ? Math.max(60, Number(ttlSeconds))
      : code === "AUTH_EXPIRED"
        ? 12 * 3600
        : 3600;
    if (!(await takeAlertSlot(key, ttl))) return;
    if (objection) {
      await notifySlack(
        `⚠️ Para AI automation: job ${botId} submitted with a recorded sharing objection — review if needed.`,
      );
      return;
    }
    if (code === "NO_RESUME_AFTER_RETRIES") {
      await notifySlack(
        `⚠️ Para AI automation: job ${botId} needs review. ${RESUME_WAIT_TERMINAL_REASON}.`,
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
      if (result.alert) {
        await alertOnce(
          result.alert.code,
          lease.botId,
          result.alert.detail,
          { ttlSeconds: result.alert.ttlSeconds },
        );
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

function persistedBackfillAnchor(job) {
  if (
    job?.automation?.mode !== "authorized_backfill" &&
    job?.automation?.resumeWait?.source !== "authorized_backfill"
  ) return null;
  return finiteDate(job?.automation?.backfillBatchEntryAt)
    ?? finiteDate(job?.automation?.resumeWait?.enteredAt);
}

function validBackfillResumeWait(job) {
  const wait = job?.automation?.resumeWait;
  return Boolean(
    wait?.source === "authorized_backfill" &&
    finiteDate(wait.enteredAt) != null &&
    finiteDate(wait.firstCheckAt) != null &&
    finiteDate(wait.expiresAt) != null,
  );
}

export async function enqueueBackfill(
  botIds = [],
  {
    config = automationConfig(),
    now = Date.now(),
    getJobImpl = getJob,
    getBackfillAnchorImpl = getOrCreateResumeBackfillAnchor,
    saveJobImpl = saveJob,
    enqueueImpl = enqueueAutoJob,
  } = {},
) {
  const values = Array.isArray(botIds) ? botIds : [];
  const results = new Array(values.length);
  const entries = [];
  const seen = new Set();

  for (let index = 0; index < values.length; index++) {
    const botId = String(values[index] || "").trim();
    if (!BOT_ID.test(botId)) {
      results[index] = { botId, enqueued: false, error: "invalid_bot_id" };
      continue;
    }
    if (seen.has(botId)) {
      results[index] = { botId, enqueued: false, duplicate: true, error: "duplicate_input" };
      continue;
    }
    seen.add(botId);
    try {
      const current = await getJobImpl(botId);
      if (!current) {
        results[index] = { botId, enqueued: false, error: "job_not_found" };
        continue;
      }
      entries.push({ index, botId, current });
    } catch (error) {
      results[index] = {
        botId,
        enqueued: false,
        error: String(error?.code || "job_read_failed"),
      };
    }
  }

  if (!entries.length) return results.filter(Boolean);
  const priorRowAnchor = entries
    .map(({ current }) => persistedBackfillAnchor(current))
    .find((value) => value != null);
  const batchAnchorRecord = await getBackfillAnchorImpl({
    now: priorRowAnchor ?? now,
  });
  const commonAnchor = finiteDate(
    batchAnchorRecord?.anchorAt ?? batchAnchorRecord,
  );
  if (commonAnchor == null) {
    throw new Error("durable authorized-backfill anchor is invalid");
  }

  for (const { index, botId, current } of entries) {
    const decision = backfillReviewDecision(current);
    if (!decision.eligible) {
      results[index] = {
        botId,
        enqueued: false,
        preserved: true,
        error: decision.reason,
      };
      continue;
    }

    const existingAnchor = persistedBackfillAnchor(current);
    if (
      existingAnchor != null
      && existingAnchor !== commonAnchor
    ) {
      results[index] = {
        botId,
        enqueued: false,
        preserved: true,
        error: "backfill_anchor_conflict",
      };
      continue;
    }
    const rowAnchor = commonAnchor;
    const resumeWait = validBackfillResumeWait(current)
      ? current.automation.resumeWait
      : resumeWaitPlan({
          source: "authorized_backfill",
          anchorAt: rowAnchor,
          waitMinutes: config.resumeWaitMinutes,
          retryDays: config.resumeRetryDays,
          terminalAckHours: config.resumeTerminalAckHours,
          backfillTerminalAckDays:
            config.resumeBackfillTerminalAckDays,
        });
    const batchEntryAt = new Date(rowAnchor).toISOString();
    let anchored = current;

    if (!(existingAnchor != null && validBackfillResumeWait(current))) {
      try {
        anchored = await saveJobImpl(transition(current, "ready_to_submit", {
          automation: {
            ...(current.automation || {}),
            mode: "authorized_backfill",
            status: "prepared",
            reasons: [],
            freezeReason: null,
            backfillBatchEntryAt: batchEntryAt,
            preferenceRerouteRequired: true,
            resumeWait,
          },
          reviewReason: null,
          reviewReasons: [],
          error: null,
          journalDetail: "authorized backfill clocks anchored at batch entry",
        }), current.revision);
      } catch (error) {
        results[index] = {
          botId,
          enqueued: false,
          error: String(error?.code || "anchor_failed"),
        };
        continue;
      }
    }

    try {
      const eventAnchor = finiteDate(anchored.automation.resumeWait.enteredAt);
      const queued = await enqueueImpl(botId, {
        source: "authorized_backfill",
        eventId: `backfill:${botId}:${eventAnchor}`,
        dueAt: Number(now),
      });
      results[index] = {
        ...queued,
        batchEntryAt,
        firstCheckAt: anchored.automation.resumeWait.firstCheckAt,
      };
    } catch (error) {
      results[index] = {
        botId,
        enqueued: false,
        batchEntryAt,
        firstCheckAt: anchored.automation.resumeWait.firstCheckAt,
        error: String(error?.code || "enqueue_failed"),
      };
    }
  }
  return results.filter(Boolean);
}

export async function sweepPhase1ResumeWaitCards({
  config = automationConfig(),
  now = Date.now(),
  listJobsImpl = listJobs,
  saveJobImpl = saveJob,
  enqueueImpl = enqueueAutoJob,
} = {}) {
  if (!config.resumeWaitEnabled || !automationExecutionEnabled(config)) {
    return {
      ok: true,
      disabled: true,
      reason: config.resumeWaitEnabled ? "automation_not_ready" : "resume_wait_disabled",
      swept: 0,
      enqueued: 0,
      results: [],
    };
  }
  const jobs = await listJobsImpl(500);
  const results = [];
  for (const current of jobs) {
    let job = current;
    if (isPhase1ResumeWaitCard(current)) {
      const swept = phase1ResumeWaitSweepTransition(current, config, { now });
      try {
        job = await saveJobImpl(swept, current.revision);
      } catch (error) {
        results.push({
          botId: current.id,
          swept: false,
          enqueued: false,
          error: String(error?.code || "sweep_save_failed"),
        });
        continue;
      }
    } else if (!(
      current?.state === "waiting_for_resume" &&
      current?.automation?.resumeWait?.source === "phase1_sweep"
    )) {
      continue;
    }

    try {
      const queued = await enqueueImpl(job.id, {
        source: "phase1_resume_sweep",
        eventId: `phase2-resume-sweep:${job.id}:${job.automation.resumeWait.enteredAt}`,
        dueAt: finiteDate(job.automation.resumeWait.nextCheckAt) ?? now,
      });
      results.push({
        botId: job.id,
        swept: job !== current,
        enqueued: queued.enqueued,
        duplicate: queued.duplicate,
      });
    } catch (error) {
      results.push({
        botId: job.id,
        swept: job !== current,
        enqueued: false,
        error: String(error?.code || "sweep_enqueue_failed"),
      });
    }
  }
  return {
    ok: true,
    disabled: false,
    swept: results.filter((result) => result.swept).length,
    enqueued: results.filter((result) => result.enqueued).length,
    results,
  };
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
