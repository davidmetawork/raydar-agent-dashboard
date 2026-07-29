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
  buildPreferenceRouting,
  buildSubmissionPayload,
  loadJob,
  missingRequiredPreferences,
  prepareJob,
  reconcileSubmittedJob,
  refreshMatches,
  reroutePreparedJob,
  submitJob as pipelineSubmitJob,
} from "./pipeline.mjs";
import {
  LATE_MATCH_REVIEW_NOTE_CODE,
  LIVE_OUTCOME_SEQUENCES_BY_ID,
  MATCH_INITIAL_POLL_MS,
  MATCH_INITIAL_WINDOW_MS,
  MATCH_TIMEOUT_MS,
  PHASE3_SHADOW_POLICY_VERSION,
  nextMatchPollDecision,
  stageEnableReanchorDecision,
} from "./phase3-shadow-policy.mjs";
import {
  HUMAN_CALL_QUEUE_SOURCE,
  callIdFromHumanJob,
  fetchHumanCall,
  humanCallReadiness,
  isHumanCallJob,
  persistedHumanCallMetadata,
} from "./human-call.mjs";
import {
  humanIntroCallFromJob,
  isHumanIntroJob,
  persistedHumanIntroMetadata,
} from "./human-intro.mjs";
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
  authorizeAndEnqueuePhase2RemainderJob,
  bootstrapPhase3CandidateSuccessIndex,
  claimDueAutoJobs,
  claimPhase2FirstTenCanaryCommit,
  claimPhase2RemainderBatch,
  claimPhase3ShadowReleaseBatch,
  completePhase2FirstTenCanary,
  completePhase2RemainderBatch,
  completePhase3ShadowReleaseBatch,
  completeAutoJob,
  createPhase2FirstTenCanaryPlan,
  createPhase2RemainderPlan,
  createPhase3ShadowRelease,
  createJob,
  enqueueAutoJob,
  enqueuePhase2RemainderAutoJob,
  getAutoQueueStats,
  getCompletePhase2CanarySnapshot,
  getCompletePhase3ShadowSnapshot,
  getJob,
  getOrCreateResumeBackfillAnchor,
  getPhase2FirstTenCanary,
  getPhase2RemainderRelease,
  getPhase3CandidateSuccessProof,
  getPhase3ShadowRelease,
  getPhase3CandidateSuccessBootstrap,
  getRecentResumeAttachedSignal,
  getResumeAskSuppression,
  getSubmissionIntent,
  hashSubmissionPayload,
  listJobs,
  normalizeFailureRecord,
  phase2CanaryManifestDigest,
  phase2RemainderAttestationDigest,
  phase2RemainderManifestDigest,
  phase3ShadowReleaseManifestDigest,
  reanchorAndEnqueuePhase3ShadowJob,
  releaseJobLock,
  resumeChaseChainId,
  rescheduleAutoJob,
  saveJob,
  stableStringify,
  stopResumeAskSuppression,
  takeAlertSlot,
  transition,
  upsertPhase3CandidateSuccessProof,
} from "./store.mjs";

const TERMINAL_STATES = new Set([
  "awaiting_matches", "ready_to_enroll", "needs_review", "enrolled", "no_email",
]);
const SAFE_RETRY_CODES = new Set([
  "AUTH_EXPIRED", "PREPARE_FAILED", "REVISION_CONFLICT", "JOB_BUSY",
  "SUBMIT_WRITE_UNKNOWN", "SUBMIT_STILL_UNCONFIRMED", "RESUME_CHASE_STOP_FAILED",
  "RESUME_CHASE_READ_FAILED", "RESUME_ATTACH_REDUE_FAILED",
  "PHASE3_CALL_SNAPSHOT_INCOMPLETE", "PHASE3_CALL_PROOF_REQUIRED",
  "PHASE3_CALL_SNAPSHOT_REQUIRED", "PHASE3_CALL_PROOF_CHANGED",
  "PHASE3_BOOTSTRAP_STATUS_FAILED",
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
const PHASE3_MATCH_READ_PROC =
  "candidateMatching.getRankedRolesForCandidate";
const PHASE3_SHADOW_RELEASE_PERMANENT_ERRORS = new Set([
  "job_missing",
  "job_changed",
  "phase3_shadow_release_job_changed",
  "phase3_shadow_release_transition_invalid",
]);
const SETTLED_NON_SUCCESS_VERDICTS = new Set([
  "no_show", "audio_fail", "error", "joined_silent", "incomplete",
]);
const BOT_ID = /^[A-Za-z0-9_-]{8,100}$/;
export const PHASE2_FIRST_TEN_CANARY_LIMIT = 10;
export const PHASE2_REMAINDER_BATCH_MAX = 5;
const PHASE2_REMAINDER_REVIEW_ERRORS = new Set([
  "human_call_lane",
  "state_preserved",
  "stored_routing_inputs_missing",
  "identity_review",
  "technical_review",
  "email_review",
  "linkedin_review",
  "hard_review_reason",
  "unclassified_review",
  "remainder_job_changed",
  "remainder_manifest_conflict",
  "backfill_anchor_conflict",
  "job_not_found",
]);
const PHASE2_ATTACH_SUBMIT_MAX_MS = 15 * 60_000;
const PHASE2_ATTACH_PROOF_MAX_AGE_MS = 24 * 60 * 60_000;
const PHASE2_CANARY_VERIFIED_STATES = new Set([
  "awaiting_matches",
  "ready_to_enroll",
  "enrolled",
]);
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
  const matchStageEnabledAtMs = finiteDate(
    env.PARAAI_MATCH_STAGE_ENABLED_AT,
  );
  const matchReadProc = String(env.PARAAI_MATCH_READ_PROC || "").trim();
  const resumeWait = resumeWaitSettings(env);
  const configuredStepAttempts = Number(env.PARAAI_MAX_STEP_ATTEMPTS);
  return {
    enabled: bool(env.PARAAI_AUTOMATION_APPROVED),
    detectEnabled: bool(env.PARAAI_AUTO_DETECT_ENABLED),
    prepareEnabled: bool(env.PARAAI_AUTO_PREPARE_ENABLED),
    autoSubmitApproved: bool(env.PARAAI_AUTOSUBMIT_APPROVED),
    matchStageEnabled: bool(env.PARAAI_MATCH_STAGE_ENABLED),
    matchShadow: bool(env.PARAAI_MATCH_SHADOW),
    curateEnabled: bool(env.PARAAI_CURATE_ENABLED),
    enrollApproved: bool(env.PARAAI_ENROLL_APPROVED),
    matchStageEnabledAtMs,
    matchReadProc,
    matchReadPinned: matchReadProc === PHASE3_MATCH_READ_PROC,
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

export function phase3ShadowExecutionEnabled(
  config = {},
  {
    now = Date.now(),
  } = {},
) {
  const current = Number(now);
  const anchor = config?.matchStageEnabledAtMs;
  return Boolean(
    config?.matchStageEnabled === true
    && config?.matchShadow === true
    && config?.curateEnabled === false
    && config?.enrollApproved === false
    && config?.matchReadPinned === true
    && config?.matchReadProc === PHASE3_MATCH_READ_PROC
    && Number.isFinite(current)
    && Number.isFinite(anchor)
    && anchor <= current
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

export function resumeOnlyBackfillMissingResumeTransition(
  job,
  {
    now = Date.now(),
    reason = "resume_missing_before_submit",
  } = {},
) {
  const at = new Date(Number(now)).toISOString();
  const message =
    "Resume-only backfill stopped before submission because no resume is on file";
  return transition(job, "needs_review", {
    reviewReason: "resume_only_backfill_resume_missing",
    reviewReasons: mergeReviewReasons(
      job,
      reviewReason(
        "resume_only_backfill_resume_missing",
        message,
      ),
    ),
    automation: {
      ...(job?.automation || {}),
      status: "needs_review",
      reasons: [message],
      evaluatedAt: at,
      resumeOnlyStoppedAt: at,
      resumeOnlyStopReason: String(reason || "").slice(0, 100),
      resumeWait: null,
      resumeWaitSweepEligible: false,
    },
    error: null,
    journalDetail:
      "resume-only authorized backfill stopped without resume chase",
  });
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

function phase3ScopedError(code, message, job, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.step = "match_read";
  error.job = job;
  return error;
}

function phase3ExistingWriteCounter(shadow, field) {
  return (
    shadow
    && typeof shadow === "object"
    && Object.hasOwn(shadow, field)
  )
    ? shadow[field]
    : 0;
}

function phase3ShadowCompletionHasReadProof(job) {
  const shadow = job?.phase3Shadow;
  if (
    shadow?.complete !== true
    || Number(shadow?.readCount || 0) < 1
    || finiteDate(shadow?.observedAt) == null
    || finiteDate(job?.matchCheckedAt) == null
  ) return false;
  if (shadow.settlementDecision === "matches_settled") {
    return Boolean(
      Number(shadow.matchCount) >= 1
      && shadow.audit?.match?.decision === "matches_settled"
    );
  }
  if (shadow.settlementDecision === "zero_settled") {
    return Boolean(
      shadow.matchCount === 0
      && finiteDate(shadow.zeroBaselineObservedAt) != null
      && shadow.audit?.match?.decision === "zero_settled"
    );
  }
  return false;
}

function phase3BootstrapAdmissionValid(job, config, release) {
  const stageEnabledAt = new Date(
    Number(config.matchStageEnabledAtMs),
  ).toISOString();
  const digest = String(job?.phase3Shadow?.releaseDigest || "");
  const jobId = String(job?.id || "");
  const entry = Array.isArray(release?.entries)
    ? release.entries.find((row) => String(row?.id || "") === jobId)
    : null;
  return Boolean(
    /^[a-f0-9]{64}$/u.test(digest)
    && release?.manifestDigest === digest
    && release?.commonAnchorAt === stageEnabledAt
    && ["claimed", "scheduled"].includes(String(entry?.status || ""))
    && job?.phase3Shadow?.bootstrap === true
    && job?.phase3Shadow?.stageEnabledAt === stageEnabledAt
    && job?.matchLegStartedAt === stageEnabledAt
  );
}

async function phase3ContinuousAdmissionAllowed(
  job,
  config,
  getReleaseImpl,
) {
  const anchorMs = finiteDate(job?.matchLegStartedAt);
  const stageEnabledAtMs = Number(config?.matchStageEnabledAtMs);
  const hasBootstrapMarker = Boolean(
    job?.phase3Shadow?.bootstrap === true
    || String(job?.phase3Shadow?.releaseDigest || ""),
  );
  if (hasBootstrapMarker) {
    let release;
    try {
      release = await getReleaseImpl();
    } catch (cause) {
      throw phase3ScopedError(
        "PHASE3_BOOTSTRAP_STATUS_FAILED",
        "Phase 3 bootstrap admission could not be verified",
        job,
        cause,
      );
    }
    return phase3BootstrapAdmissionValid(job, config, release)
      ? "allowed"
      : "invalid";
  }
  if (
    anchorMs != null
    && Number.isFinite(stageEnabledAtMs)
    && anchorMs >= stageEnabledAtMs
  ) return "allowed";
  let release;
  try {
    release = await getReleaseImpl();
  } catch (cause) {
    throw phase3ScopedError(
      "PHASE3_BOOTSTRAP_STATUS_FAILED",
      "Phase 3 bootstrap admission could not be verified",
      job,
      cause,
    );
  }
  if (!release) return "pending";
  const entry = Array.isArray(release.entries)
    ? release.entries.find(
        (row) => String(row?.id || "") === String(job?.id || ""),
      )
    : null;
  if (!entry || entry.status === "review") return "out_of_scope";
  if (["pending", "claimed"].includes(String(entry.status || ""))) {
    return "pending";
  }
  return "invalid";
}

export function continuousPhase3ShadowTransition(
  job,
  config,
  {
    now = Date.now(),
  } = {},
) {
  if (
    job?.state !== "awaiting_matches"
    || !phase3ShadowExecutionEnabled(config, { now })
  ) return job;
  const anchorMs = finiteDate(job.matchLegStartedAt);
  if (anchorMs == null || anchorMs > now) {
    const error = new Error("a current match-leg anchor is required");
    error.code = "MATCH_LEG_ANCHOR_REQUIRED";
    error.step = "match_read";
    error.job = job;
    throw error;
  }
  if (
    job?.phase3Shadow?.policyVersion === PHASE3_SHADOW_POLICY_VERSION
    && (
      phase3ShadowCompletionHasReadProof(job)
      || finiteDate(job?.phase3Shadow?.nextPollAt) != null
    )
  ) return job;
  if (job?.phase3Shadow?.bootstrap === true) {
    throw phase3ScopedError(
      "PHASE3_BOOTSTRAP_SCHEDULE_INVALID",
      "the atomic Phase 3 bootstrap schedule is invalid",
      job,
    );
  }
  const afterAt = finiteDate(job?.matchCheckedAt) ?? anchorMs;
  const poll = nextMatchPollDecision({
    matchLegStartedAt: new Date(anchorMs).toISOString(),
    afterAt: new Date(Math.max(anchorMs, afterAt)).toISOString(),
    lateMatchMode: job?.phase3Shadow?.lateMatchMode === true,
  });
  const completedWithoutReadProof = Boolean(
    poll.complete && !phase3ShadowCompletionHasReadProof(job),
  );
  const nextPollAt = completedWithoutReadProof
    ? new Date(now).toISOString()
    : poll.dueAt;
  const stageEnabledAtMs = Number(config?.matchStageEnabledAtMs);
  const stageEnabledAt = new Date(
    Number.isFinite(stageEnabledAtMs) && stageEnabledAtMs <= now
      ? stageEnabledAtMs
      : anchorMs,
  ).toISOString();
  return transition(job, "awaiting_matches", {
    phase3Shadow: {
      ...(job?.phase3Shadow || {}),
      policyVersion: PHASE3_SHADOW_POLICY_VERSION,
      stageEnabledAt,
      bootstrap: false,
      nextPollAt,
      complete: false,
      candidateFacingWrites: phase3ExistingWriteCounter(
        job?.phase3Shadow,
        "candidateFacingWrites",
      ),
      curationWrites: phase3ExistingWriteCounter(
        job?.phase3Shadow,
        "curationWrites",
      ),
      enrollments: phase3ExistingWriteCounter(
        job?.phase3Shadow,
        "enrollments",
      ),
    },
    journalDetail: "Phase 3 continuous shadow polling scheduled",
  });
}

export async function ensureContinuousPhase3ShadowJob(
  job,
  config,
  {
    now = Date.now(),
    saveJobImpl = saveJob,
  } = {},
) {
  const next = continuousPhase3ShadowTransition(job, config, { now });
  if (next === job) return job;
  return saveJobImpl(next, job.revision);
}

function missingPhase3CandidateSuccessProof(proof) {
  const observedAt = String(proof?.storeObservedAt || "");
  const observedAtMs = finiteDate(observedAt);
  return Boolean(
    proof
    && typeof proof === "object"
    && !Array.isArray(proof)
    && proof.version === 1
    && proof.source === "candidate_success_index_v1"
    && proof.authoritative === false
    && proof.complete === false
    && proof.bootstrapComplete === true
    && proof.quarantined === false
    && proof.proofVersion === 0
    && proof.proofUpdatedAt == null
    && proof.proofSemanticDigest == null
    && /^[a-f0-9]{40}$/u.test(
      String(proof.bootstrapGenerationDigest || ""),
    )
    && proof.conflict === false
    && observedAtMs != null
    && new Date(observedAtMs).toISOString() === observedAt
    && Array.isArray(proof.calls)
    && proof.calls.length === 0
  );
}

function phase3CallProofRepairError(cause = null) {
  const error = new Error(
    "the authoritative successful-call source could not repair the candidate proof",
  );
  error.code = "PHASE3_CALL_PROOF_REPAIR_SOURCE_INVALID";
  if (cause) error.cause = cause;
  return error;
}

/**
 * Repair only a genuinely absent candidate-scoped proof. This does not infer
 * provenance from legacy state: it re-reads the exact Recall/Paraform source,
 * applies the existing success validators, and writes under the job's current
 * candidateId-first identity. Poisoned, malformed, and merely incomplete
 * records remain fail-closed.
 */
export async function repairMissingPhase3CandidateSuccessProof(
  job,
  proof,
  {
    now = Date.now,
    fetchCallImpl = fetchCall,
    fetchHumanCallImpl = fetchHumanCall,
    humanIntroCallFromJobImpl = humanIntroCallFromJob,
    humanCallReadinessImpl = humanCallReadiness,
    persistedHumanCallMetadataImpl = persistedHumanCallMetadata,
    persistedHumanIntroMetadataImpl = persistedHumanIntroMetadata,
    upsertProofImpl = upsertPhase3CandidateSuccessProof,
  } = {},
) {
  if (!missingPhase3CandidateSuccessProof(proof)) return proof;
  const id = String(job?.id || "").trim();
  const candidateUserId = String(
    job?.identity?.candidateUserId || "",
  ).trim();
  const candidateId = String(job?.identity?.candidateId || "").trim();
  const current = Number(typeof now === "function" ? now() : now);
  if (
    !BOT_ID.test(id)
    || (!candidateId && !candidateUserId)
    || !Number.isFinite(current)
  ) {
    throw phase3CallProofRepairError();
  }

  let call;
  let humanCall = false;
  let provenanceVerified = false;
  try {
    if (isHumanIntroJob(id)) {
      if (job?.humanCall !== true || job?.humanIntro !== true) {
        throw new Error("human intro job markers are invalid");
      }
      call = await humanIntroCallFromJobImpl(job);
      const readiness = humanCallReadinessImpl(call);
      const metadata = persistedHumanIntroMetadataImpl(call);
      if (
        readiness?.ready !== true
        || metadata?.provenanceVerified !== true
      ) {
        throw new Error("human intro provenance is invalid");
      }
      humanCall = true;
      provenanceVerified = true;
    } else if (isHumanCallJob(id)) {
      if (job?.humanCall !== true || job?.humanIntro === true) {
        throw new Error("human call job markers are invalid");
      }
      const callId = callIdFromHumanJob(id);
      call = await fetchHumanCallImpl(callId);
      const readiness = humanCallReadinessImpl(call);
      const metadata = persistedHumanCallMetadataImpl(call);
      if (
        String(call?.id || "") !== callId
        || readiness?.ready !== true
        || metadata?.provenanceVerified !== true
        || (
          String(call?.candidateUserId || "").trim()
          && String(call.candidateUserId).trim() !== candidateUserId
        )
      ) {
        throw new Error("human call provenance is invalid");
      }
      humanCall = true;
      provenanceVerified = true;
    } else {
      if (job?.humanCall === true || job?.humanIntro === true) {
        throw new Error("agent call job markers are invalid");
      }
      call = await fetchCallImpl(id);
      if (
        String(call?.botId || "") !== id
        || call?.source?.isScreener !== true
        || !isSuccessfulCall(call)
      ) {
        throw new Error("agent call provenance is invalid");
      }
    }
  } catch (cause) {
    throw phase3CallProofRepairError(cause);
  }

  const endedAtMs = resolveCallEndedAt(call);
  if (
    endedAtMs == null
    || endedAtMs > current
  ) {
    throw phase3CallProofRepairError();
  }
  try {
    return await upsertProofImpl({
      candidateUserId,
      candidateId,
      endedAt: new Date(endedAtMs).toISOString(),
      humanCall,
      callType: humanCall ? "human" : "agent",
      callSourceVerified: true,
      humanProvenanceVerified: provenanceVerified,
      successfulCallVerified: true,
      now: current,
    });
  } catch (cause) {
    throw phase3CallProofRepairError(cause);
  }
}

async function processPhase3ShadowAutoJob(
  job,
  config,
  runStep,
  {
    now = Date.now,
    refreshMatchesImpl = refreshMatches,
    saveJobImpl = saveJob,
    phase3CallProofImpl = getPhase3CandidateSuccessProof,
    phase3CallProofRepairImpl =
      repairMissingPhase3CandidateSuccessProof,
    getPhase3ReleaseImpl = getPhase3ShadowRelease,
  } = {},
) {
  const current = Number(typeof now === "function" ? now() : now);
  const admission = await phase3ContinuousAdmissionAllowed(
    job,
    config,
    getPhase3ReleaseImpl,
  );
  if (admission === "pending") {
    return {
      action: "reschedule",
      dueAt: current + 60_000,
      delayMs: 60_000,
      state: job.state,
      detail: "Phase 3 bootstrap admission is pending",
      job,
    };
  }
  if (admission === "out_of_scope") {
    const at = new Date(current).toISOString();
    job = await saveJobImpl(transition(job, "needs_review", {
      reviewReason: "phase3_bootstrap_out_of_scope",
      error: {
        code: "PHASE3_BOOTSTRAP_OUT_OF_SCOPE",
        detail: "job was not selected by the immutable Phase 3 bootstrap",
        at,
      },
      phase3Shadow: {
        ...(job?.phase3Shadow || {}),
        policyVersion: PHASE3_SHADOW_POLICY_VERSION,
        releaseDisposition: "out_of_scope",
        complete: true,
        candidateFacingWrites: phase3ExistingWriteCounter(
          job?.phase3Shadow,
          "candidateFacingWrites",
        ),
        curationWrites: phase3ExistingWriteCounter(
          job?.phase3Shadow,
          "curationWrites",
        ),
        enrollments: phase3ExistingWriteCounter(
          job?.phase3Shadow,
          "enrollments",
        ),
      },
      journalDetail: "Phase 3 bootstrap manifest excluded this job",
    }), job.revision);
    return {
      action: "complete",
      state: job.state,
      detail: "Phase 3 bootstrap manifest excluded this job",
      job,
    };
  }
  if (admission !== "allowed") {
    throw phase3ScopedError(
      "PHASE3_BOOTSTRAP_SCHEDULE_INVALID",
      "the Phase 3 bootstrap marker conflicts with its release",
      job,
    );
  }
  job = await ensureContinuousPhase3ShadowJob(job, config, {
    now: current,
    saveJobImpl,
  });
  if (job?.phase3Shadow?.complete === true) {
    return {
      action: "complete",
      state: job.state,
      detail: "Phase 3 shadow decision complete",
      job,
    };
  }
  const nextPollMs = finiteDate(job?.phase3Shadow?.nextPollAt);
  if (nextPollMs == null) {
    const error = new Error("Phase 3 shadow poll schedule is missing");
    error.code = "PHASE3_SHADOW_SCHEDULE_REQUIRED";
    error.step = "match_read";
    error.job = job;
    throw error;
  }
  if (nextPollMs > current) {
    return {
      action: "reschedule",
      dueAt: nextPollMs,
      delayMs: Math.max(1_000, nextPollMs - current),
      state: job.state,
      detail: "Phase 3 shadow match poll scheduled",
      job,
    };
  }
  job = await runStep(
    "match_read",
    () => refreshMatchesImpl(job, {
      callSnapshotImpl: async () => {
        try {
          const proof = await phase3CallProofImpl({
            candidateUserId: job?.identity?.candidateUserId,
            candidateId: job?.identity?.candidateId,
          });
          return await phase3CallProofRepairImpl(job, proof, { now });
        } catch (cause) {
          throw phase3ScopedError(
            "PHASE3_CALL_SNAPSHOT_REQUIRED",
            "the durable same-candidate successful-call proof is unavailable",
            job,
            cause,
          );
        }
      },
    }),
  );
  if (job.state === "needs_review") {
    const timeout =
      job?.error?.code === "MATCHES_PENDING_TIMEOUT";
    const code = timeout
      ? "MATCHES_PENDING_TIMEOUT"
      : String(
          job?.error?.code || "PHASE3_SHADOW_REVIEW_REQUIRED",
        );
    const detail = String(
      job?.error?.detail
        || (
          timeout
            ? "match generation never settled"
            : "aggregate Phase 3 proof requires review"
        ),
    ).slice(0, 160);
    return {
      action: "complete",
      state: job.state,
      detail,
      alert: {
        code,
        detail,
        aggregateOnly: true,
      },
      job,
    };
  }
  if (job?.phase3Shadow?.complete === true) {
    return {
      action: "complete",
      state: job.state,
      detail: "Phase 3 shadow decision complete",
      job,
    };
  }
  const dueAt = finiteDate(job?.phase3Shadow?.nextPollAt);
  if (dueAt == null) {
    const error = new Error("Phase 3 shadow poll schedule is missing");
    error.code = "PHASE3_SHADOW_SCHEDULE_REQUIRED";
    error.step = "match_read";
    error.job = job;
    throw error;
  }
  return {
    action: "reschedule",
    dueAt,
    delayMs: Math.max(1_000, dueAt - Number(
      typeof now === "function" ? now() : now,
    )),
    state: job.state,
    detail: "Phase 3 shadow match read remains unsettled",
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
    refreshMatchesImpl = refreshMatches,
    saveJobImpl = saveJob,
    phase3CallProofImpl = getPhase3CandidateSuccessProof,
    phase3CallProofRepairImpl =
      repairMissingPhase3CandidateSuccessProof,
    getPhase3ReleaseImpl = getPhase3ShadowRelease,
    now = Date.now,
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
  const phase3Enabled = phase3ShadowExecutionEnabled(config, {
    now: typeof now === "function" ? now() : now,
  });
  let job = phase3Enabled ? await getJobImpl(id) : null;
  if (phase3Enabled && job?.state === "awaiting_matches") {
    await stopResumeChase(
      job,
      "submission_confirmed",
      runStep,
    ).catch(() => null);
    return processPhase3ShadowAutoJob(job, config, runStep, {
      now,
      refreshMatchesImpl,
      saveJobImpl,
      phase3CallProofImpl,
      phase3CallProofRepairImpl,
      getPhase3ReleaseImpl,
    });
  }
  if (!automationExecutionEnabled(config)) {
    return { action: "reschedule", delayMs: 5 * 60_000, state: "paused", detail: "automation is paused" };
  }

  job ||= await getJobImpl(id);
  let verifiedResumeUri = "";
  humanIntake = humanIntake || job?.humanCall === true;
  const resumeOnlySubmit =
    job?.automation?.resumeOnlySubmit === true;
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
    resumeOnlySubmit
    && (
      job.state === "waiting_for_resume"
      || job?.automation?.resumeWait != null
    )
  ) {
    job = await saveJobImpl(
      resumeOnlyBackfillMissingResumeTransition(job, {
        now: typeof now === "function" ? now() : now,
        reason: "resume_wait_fence_violation",
      }),
      job.revision,
    );
    return {
      action: "complete",
      state: job.state,
      detail:
        "resume-only backfill stopped without resume chase",
      step: "resume_read",
      job,
    };
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
      if (phase3Enabled) {
        await stopResumeChase(
          job,
          "already_submitted",
          runStep,
        ).catch(() => null);
        return processPhase3ShadowAutoJob(job, config, runStep, {
          now,
          refreshMatchesImpl,
          saveJobImpl,
          phase3CallProofImpl,
          phase3CallProofRepairImpl,
          getPhase3ReleaseImpl,
        });
      }
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
      if (phase3Enabled) {
        await stopResumeChase(
          job,
          "already_submitted",
          runStep,
        ).catch(() => null);
        return processPhase3ShadowAutoJob(job, config, runStep, {
          now,
          refreshMatchesImpl,
          saveJobImpl,
          phase3CallProofImpl,
          phase3CallProofRepairImpl,
          getPhase3ReleaseImpl,
        });
      }
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
      if (resumeOnlySubmit) {
        job = await saveJobImpl(
          resumeOnlyBackfillMissingResumeTransition(job, {
            now: typeof now === "function" ? now() : now,
          }),
          job.revision,
        );
        return {
          action: "complete",
          state: job.state,
          detail:
            "resume-only backfill stopped without resume chase",
          step: "resume_read",
          job,
        };
      }
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
      if (phase3Enabled) {
        await stopResumeChase(
          job,
          "already_submitted",
          runStep,
        ).catch(() => null);
        return processPhase3ShadowAutoJob(job, config, runStep, {
          now,
          refreshMatchesImpl,
          saveJobImpl,
          phase3CallProofImpl,
          phase3CallProofRepairImpl,
          getPhase3ReleaseImpl,
        });
      }
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
    if (phase3Enabled) {
      await stopResumeChase(
        job,
        "submission_confirmed",
        runStep,
      ).catch(() => null);
      return processPhase3ShadowAutoJob(job, config, runStep, {
        now,
        refreshMatchesImpl,
        saveJobImpl,
        phase3CallProofImpl,
        phase3CallProofRepairImpl,
        getPhase3ReleaseImpl,
      });
    }
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

export async function alertOnce(
  code,
  botId,
  detail,
  {
    ceiling = false,
    objection = false,
    ttlSeconds = null,
    aggregateOnly = false,
  } = {},
  {
    takeAlertSlotImpl = takeAlertSlot,
    notifySlackImpl = notifySlack,
  } = {},
) {
  // Phase 3 candidate failures are aggregate-only by contract. Their active
  // retries and terminal reviews are counted by phase3ShadowReleaseStatus;
  // the aggregate escalation path is the sole Slack owner.
  if (aggregateOnly) return false;
  try {
    const key = objection
      ? `auto:sharing-objection:${botId}`
      : ceiling
        ? `auto:ceiling:${code}:${botId}`
        : code === "AUTH_EXPIRED"
          ? "auto-auth-expired"
          : `auto:${code}:${botId}`;
    const ttl = (
      ttlSeconds != null
      && ttlSeconds !== ""
      && Number.isFinite(Number(ttlSeconds))
    )
      ? Math.max(60, Number(ttlSeconds))
      : code === "AUTH_EXPIRED"
        ? 12 * 3600
        : 3600;
    if (!(await takeAlertSlotImpl(key, ttl))) return false;
    if (objection) {
      await notifySlackImpl(
        `⚠️ Para AI automation: job ${botId} submitted with a recorded sharing objection — review if needed.`,
      );
      return true;
    }
    if (code === "NO_RESUME_AFTER_RETRIES") {
      await notifySlackImpl(
        `⚠️ Para AI automation: job ${botId} needs review. ${RESUME_WAIT_TERMINAL_REASON}.`,
      );
      return true;
    }
    await notifySlackImpl(
      `🚨 Para AI automation: ${code} for job ${botId}. ${String(detail || "").slice(0, 160)} ` +
      (ceiling
        ? "The consecutive step-failure ceiling was reached; the candidate is in review."
        : "The durable retry policy remains in control."),
    );
    return true;
  } catch { /* durable state and the worker response remain authoritative */ }
  return false;
}

export async function runAutoTick({
  config = automationConfig(),
  workerId = `vercel-${randomUUID()}`,
  phase3CallProofImpl = getPhase3CandidateSuccessProof,
  phase3CallProofRepairImpl =
    repairMissingPhase3CandidateSuccessProof,
} = {}) {
  if (
    !automationExecutionEnabled(config)
    && !phase3ShadowExecutionEnabled(config)
  ) {
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
        phase3CallProofImpl,
        phase3CallProofRepairImpl,
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
          const aggregateOnly = Boolean(
            result.failure.step === "match_read"
            && (
              String(result.failure.code).startsWith("PHASE3_")
              || result.failure.code === "MATCHES_PENDING_TIMEOUT"
            )
          );
          if (!aggregateOnly) {
            await alertOnce(
              result.failure.code,
              lease.botId,
              result.failure.message,
              { ceiling: true },
            );
          }
        }
      }
      if (result.alert && result.alert.aggregateOnly !== true) {
        await alertOnce(
          result.alert.code,
          lease.botId,
          result.alert.detail,
          {
            ttlSeconds: result.alert.ttlSeconds,
          },
        );
      }
      if (action === "reschedule") {
        await rescheduleAutoJob(lease.botId, {
          leaseToken: lease.leaseToken,
          generation: lease.generation,
          delayMs: result.delayMs,
          dueAt: result.dueAt,
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
      const aggregateOnly = Boolean(
        failure.step === "match_read"
        && (
          String(failure.code).startsWith("PHASE3_")
          || failure.code === "MATCHES_PENDING_TIMEOUT"
        )
      );
      // Both active retries and terminal reviews are represented by the
      // durable Phase 3 aggregate; it is the sole notification owner.
      if (!aggregateOnly) {
        await alertOnce(
          failure.code,
          lease.botId,
          failure.message,
          {
            ceiling: reachedCeiling,
          },
        );
      }
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

export { phase2CanaryManifestDigest };

function phase2CanaryCreatedAt(job) {
  return finiteDate(job?.createdAt) ?? Number.POSITIVE_INFINITY;
}

function phase2CanaryHasResume(job) {
  return Boolean(String(job?.submission?.resumeUri || "").trim());
}

function journalHasDetail(job, predicate) {
  return (Array.isArray(job?.journal) ? job.journal : [])
    .some((row) => predicate(String(row?.detail || "")));
}

export function phase2LiveAttachProof(
  job,
  {
    now = Date.now(),
    maxAgeMs = PHASE2_ATTACH_PROOF_MAX_AGE_MS,
  } = {},
) {
  const wait = job?.automation?.resumeWait;
  const trigger = String(wait?.lastTrigger || "");
  const checkedAt = finiteDate(wait?.lastCheckedAt);
  const attemptAt = finiteDate(job?.submitAttemptStartedAt);
  const acceptedAt = finiteDate(job?.submitAcceptedAt);
  const approvalAt = finiteDate(job?.submissionApprovalCheckedAt);
  const matchLegAt = finiteDate(job?.matchLegStartedAt);
  const current = Number(now);
  const maximumAge = Math.max(
    PHASE2_ATTACH_SUBMIT_MAX_MS,
    Number(maxAgeMs) || PHASE2_ATTACH_PROOF_MAX_AGE_MS,
  );
  return Boolean(
    PHASE2_CANARY_VERIFIED_STATES.has(String(job?.state || ""))
    && /^resume_attached:[a-f0-9]{64}$/u.test(trigger)
    && checkedAt != null
    && Number.isFinite(current)
    && checkedAt <= current
    && current - checkedAt <= maximumAge
    && attemptAt != null
    && acceptedAt != null
    && approvalAt != null
    && matchLegAt != null
    && attemptAt >= checkedAt
    && acceptedAt >= attemptAt
    && acceptedAt - checkedAt <= PHASE2_ATTACH_SUBMIT_MAX_MS
    && approvalAt >= acceptedAt
    && matchLegAt >= acceptedAt
    && job?.submitReadbackVerified === true
    && journalHasDetail(
      job,
      (detail) => /^resume check \d+\/\d+ \(attach trigger\): resume on file$/u
        .test(detail),
    )
    && journalHasDetail(
      job,
      (detail) => detail === "Paraform submission verified",
    )
  );
}

function authorizedBackfillJob(job) {
  return Boolean(
    job?.automation?.mode === "authorized_backfill"
    || job?.automation?.resumeWait?.source === "authorized_backfill"
    || job?.automation?.backfillBatchEntryAt
  );
}

function phase2CanaryEligibleJobs(
  jobs = [],
  {
    config = automationConfig(),
  } = {},
) {
  const sorted = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => {
      if (
        !BOT_ID.test(String(job?.id || ""))
        || job?.automation?.mode !== "backfill_only"
        || !phase2CanaryHasResume(job)
        || job?.automation?.resumeWait?.source === "authorized_backfill"
        || job?.automation?.backfillBatchEntryAt
        || !backfillReviewDecision(job).eligible
      ) return false;
      const freeze = automationFreezeDecision(job, config, {
        queueSource: "unknown",
      });
      return freeze.frozen === true && freeze.mode === "backfill_only";
    })
    .sort((left, right) => {
      const leftCreatedAt = phase2CanaryCreatedAt(left);
      const rightCreatedAt = phase2CanaryCreatedAt(right);
      if (leftCreatedAt !== rightCreatedAt) {
        return leftCreatedAt < rightCreatedAt ? -1 : 1;
      }
      const leftId = String(left.id);
      const rightId = String(right.id);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
  const seenCandidates = new Set();
  return sorted.filter((job) => {
    const candidateUserId = String(
      job?.identity?.candidateUserId || "",
    ).trim();
    if (!candidateUserId || seenCandidates.has(candidateUserId)) return false;
    seenCandidates.add(candidateUserId);
    return true;
  });
}

export function selectPhase2FirstTenCanary(
  jobs = [],
  options = {},
) {
  return phase2CanaryEligibleJobs(jobs, options)
    .slice(0, PHASE2_FIRST_TEN_CANARY_LIMIT);
}

function phase2CanaryPublicResult(
  record,
  {
    replayed = false,
  } = {},
) {
  const result = record?.result && typeof record.result === "object"
    ? record.result
    : {};
  const completed = record?.status === "complete";
  const failed = Math.max(0, Math.floor(Number(result.failed) || 0));
  const status = record?.status === "planned"
    ? failed > 0
      ? "retryable"
      : "planned"
    : completed
      ? "completed"
      : "in_progress";
  return {
    ok: failed === 0,
    status,
    replayed: replayed === true,
    snapshotComplete: record?.snapshotComplete === true,
    scanned: Math.max(0, Math.floor(Number(record?.snapshotTotal) || 0)),
    eligible: Math.max(0, Math.floor(Number(record?.eligibleCount) || 0)),
    selected: Math.max(0, Math.floor(Number(record?.count) || 0)),
    attempted: Math.max(0, Math.floor(Number(result.attempted) || 0)),
    enqueued: Math.max(0, Math.floor(Number(result.enqueued) || 0)),
    duplicate: Math.max(0, Math.floor(Number(result.duplicate) || 0)),
    failed,
    manifestDigest: /^[a-f0-9]{64}$/u.test(
      String(record?.manifestDigest || ""),
    )
      ? String(record.manifestDigest)
      : null,
    attachProof: record?.attachProof === true,
  };
}

function assertCompletePhase2CanarySnapshot(snapshot) {
  if (
    snapshot?.complete !== true
    || !Number.isInteger(snapshot?.total)
    || snapshot.total < 0
    || snapshot.total >= 500
    || !/^[a-f0-9]{40}$/u.test(String(snapshot?.fingerprint || ""))
    || !Array.isArray(snapshot?.jobs)
    || snapshot.jobs.length !== snapshot.total
  ) {
    const error = new Error("phase 2 canary snapshot is incomplete");
    error.code = "PHASE2_CANARY_SNAPSHOT_INCOMPLETE";
    throw error;
  }
  return snapshot;
}

function assertCompletePhase3ShadowSnapshot(snapshot) {
  const jobs = Array.isArray(snapshot?.jobs)
    ? snapshot.jobs
    : null;
  const observedAt = String(snapshot?.observedAt || "");
  const observedAtMs = finiteDate(observedAt);
  const ids = jobs?.map((job) => String(job?.id || "")) || [];
  if (
    snapshot?.version !== 1
    || snapshot?.source !== "phase3_shadow_job_index_v1"
    || snapshot?.snapshotComplete !== true
    || !Number.isInteger(snapshot?.total)
    || snapshot.total < 0
    || snapshot?.missing !== 0
    || snapshot?.invalid !== 0
    || !/^[a-f0-9]{40}$/u.test(
      String(snapshot?.snapshotFingerprint || ""),
    )
    || observedAtMs == null
    || new Date(observedAtMs).toISOString() !== observedAt
    || !jobs
    || jobs.length !== snapshot.total
    || new Set(ids).size !== ids.length
    || jobs.some((job) => (
      !BOT_ID.test(String(job?.id || ""))
      || !Number.isSafeInteger(Number(job?.revision))
      || Number(job.revision) < 0
      || job?.phase3Shadow?.policyVersion
        !== PHASE3_SHADOW_POLICY_VERSION
    ))
  ) {
    const error = new Error("phase 3 shadow snapshot is incomplete");
    error.code = "PHASE3_SHADOW_SNAPSHOT_INCOMPLETE";
    throw error;
  }
  return snapshot;
}

export async function planPhase2FirstTenCanary(
  {
    now = Date.now(),
    config = automationConfig(),
    getCanaryImpl = getPhase2FirstTenCanary,
    snapshotImpl = getCompletePhase2CanarySnapshot,
    createPlanImpl = createPhase2FirstTenCanaryPlan,
  } = {},
) {
  const current = Number(now);
  if (!Number.isFinite(current)) {
    const error = new Error("phase 2 canary timestamp is invalid");
    error.code = "PHASE2_CANARY_TIMESTAMP_INVALID";
    throw error;
  }
  const existing = await getCanaryImpl();
  if (existing) {
    return phase2CanaryPublicResult(existing, { replayed: true });
  }

  const snapshot = assertCompletePhase2CanarySnapshot(
    await snapshotImpl(),
  );
  if (!snapshot.jobs.some((job) => phase2LiveAttachProof(job, {
    now: current,
  }))) {
    return {
      ok: true,
      status: "awaiting_attach_proof",
      replayed: false,
      snapshotComplete: true,
      scanned: snapshot.total,
      eligible: 0,
      selected: 0,
      attempted: 0,
      enqueued: 0,
      duplicate: 0,
      failed: 0,
      manifestDigest: null,
      attachProof: false,
    };
  }
  const eligible = phase2CanaryEligibleJobs(snapshot.jobs, { config });
  if (eligible.length < PHASE2_FIRST_TEN_CANARY_LIMIT) {
    return {
      ok: true,
      status: "insufficient",
      replayed: false,
      snapshotComplete: true,
      scanned: snapshot.total,
      eligible: eligible.length,
      selected: 0,
      attempted: 0,
      enqueued: 0,
      duplicate: 0,
      failed: 0,
      manifestDigest: null,
      attachProof: true,
    };
  }
  const selected = eligible.slice(0, PHASE2_FIRST_TEN_CANARY_LIMIT);
  const manifestDigest = phase2CanaryManifestDigest(
    selected.map((job) => job.id),
  );
  const plan = await createPlanImpl({
    entries: selected.map((job) => ({
      id: job.id,
      revision: job.revision,
    })),
    manifestDigest,
    snapshotFingerprint: snapshot.fingerprint,
    snapshotTotal: snapshot.total,
    eligibleCount: eligible.length,
    authorizedBackfillCount: snapshot.jobs
      .filter(authorizedBackfillJob).length,
    attachProof: true,
    now: current,
  });
  return phase2CanaryPublicResult(plan?.record, {
    replayed: plan?.existing === true,
  });
}

export async function commitPhase2FirstTenCanary(
  {
    manifestDigest,
    now = Date.now(),
    claimImpl = claimPhase2FirstTenCanaryCommit,
    completeImpl = completePhase2FirstTenCanary,
    enqueueImpl = enqueueBackfill,
  } = {},
) {
  const current = Number(now);
  const digest = String(manifestDigest || "").toLowerCase();
  if (!Number.isFinite(current)) {
    const error = new Error("phase 2 canary timestamp is invalid");
    error.code = "PHASE2_CANARY_TIMESTAMP_INVALID";
    throw error;
  }
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    const error = new Error("phase 2 canary manifest digest is invalid");
    error.code = "PHASE2_CANARY_DIGEST_INVALID";
    throw error;
  }
  const claim = await claimImpl({
    manifestDigest: digest,
    now: current,
  });
  if (!claim?.acquired) {
    return phase2CanaryPublicResult(claim?.record, {
      replayed: true,
    });
  }
  const manifestIds = claim.record.botIds.map(String);
  let results;
  try {
    results = await enqueueImpl(manifestIds, {
      now: current,
      canaryManifestDigest: digest,
      canaryExpectedRevisions: new Map(
        manifestIds.map((id, index) => [
          id,
          Number(claim.record.revisions[index]),
        ]),
      ),
    });
  } catch {
    const error = new Error("phase 2 canary enqueue failed");
    error.code = "PHASE2_CANARY_ENQUEUE_FAILED";
    throw error;
  }
  const rows = Array.isArray(results) ? results : [];
  const summary = {
    attempted: manifestIds.length,
    enqueued: rows.filter((row) => row?.enqueued === true).length,
    duplicate: rows.filter((row) => row?.duplicate === true).length,
    failed: Math.max(
      0,
      manifestIds.length
        - rows.filter((row) => (
            row?.enqueued === true || row?.duplicate === true
          )).length,
    ),
  };
  const completed = await completeImpl({
    ownerToken: claim.ownerToken,
    manifestDigest: digest,
    result: summary,
    now: current,
  });
  return phase2CanaryPublicResult(completed, {
    replayed: claim.recovered === true,
  });
}

export async function phase2FirstTenCanaryStatus(
  {
    getCanaryImpl = getPhase2FirstTenCanary,
    snapshotImpl = getCompletePhase2CanarySnapshot,
  } = {},
) {
  const record = await getCanaryImpl();
  if (!record) {
    return {
      ok: true,
      status: "not_planned",
      replayed: false,
      snapshotComplete: false,
      scanned: 0,
      eligible: 0,
      selected: 0,
      attempted: 0,
      enqueued: 0,
      duplicate: 0,
      failed: 0,
      manifestDigest: null,
      attachProof: false,
      authorized: 0,
      preferencesRouted: 0,
      payloadHashVerified: 0,
      submitAttemptStarted: 0,
      submitAccepted: 0,
      talentNetworkVisible: 0,
      preexistingVisible: 0,
      waitingForResume: 0,
      needsReview: 0,
      errors: 0,
      missing: 0,
      authorizedDelta: 0,
      releaseFenceIntact: false,
      verified: false,
    };
  }
  const snapshot = assertCompletePhase2CanarySnapshot(
    await snapshotImpl(),
  );
  const snapshotJobs = new Map(
    snapshot.jobs.map((job) => [String(job.id), job]),
  );
  const jobs = record.botIds.map((id) => snapshotJobs.get(id) || null);
  const checks = jobs.map((job) => phase2CanaryJobVerification(
    job,
    record.manifestDigest,
  ));
  const count = (field) => checks.filter((row) => row[field]).length;
  const authorizedNow = snapshot.jobs.filter(authorizedBackfillJob).length;
  const authorizedDelta = authorizedNow
    - Math.max(
      0,
      Number(record?.authorizedBackfillCountAtPlan) || 0,
    );
  const releaseFenceIntact = authorizedDelta === record.count;
  const base = phase2CanaryPublicResult(record, { replayed: true });
  const verification = {
    authorized: count("authorized"),
    preferencesRouted: count("preferencesRouted"),
    payloadHashVerified: count("payloadHashVerified"),
    submitAttemptStarted: count("submitAttemptStarted"),
    submitAccepted: count("submitAccepted"),
    talentNetworkVisible: count("talentNetworkVisible"),
    preexistingVisible: count("preexistingVisible"),
    waitingForResume: count("waitingForResume"),
    needsReview: count("needsReview"),
    errors: count("error"),
    missing: count("missing"),
    authorizedDelta,
    releaseFenceIntact,
  };
  const verified = Boolean(
    record.status === "complete"
    && record.count === PHASE2_FIRST_TEN_CANARY_LIMIT
    && verification.authorized === PHASE2_FIRST_TEN_CANARY_LIMIT
    && verification.preferencesRouted === PHASE2_FIRST_TEN_CANARY_LIMIT
    && verification.payloadHashVerified === PHASE2_FIRST_TEN_CANARY_LIMIT
    && verification.submitAttemptStarted === PHASE2_FIRST_TEN_CANARY_LIMIT
    && verification.submitAccepted === PHASE2_FIRST_TEN_CANARY_LIMIT
    && verification.talentNetworkVisible === PHASE2_FIRST_TEN_CANARY_LIMIT
    && verification.preexistingVisible === 0
    && verification.waitingForResume === 0
    && verification.needsReview === 0
    && verification.errors === 0
    && verification.missing === 0
    && releaseFenceIntact
  );
  return {
    ...base,
    ...verification,
    verified,
    ok: base.ok && verified,
  };
}

function routingPreferencesConform(job) {
  const provenance = job?.reviewPolicy?.preferenceRouting;
  const input = job?.reviewPolicy?.preferenceRoutingInput;
  const preferences = job?.reviewPreferences;
  if (
    !provenance
    || typeof provenance !== "object"
    || !preferences
    || typeof preferences !== "object"
    || !input
    || typeof input !== "object"
    || !input.native
    || typeof input.native !== "object"
    || !input.context
    || typeof input.context !== "object"
    || missingRequiredPreferences(preferences).length
  ) return false;
  for (const field of [
    "locations",
    "workplaceTypes",
    "idealFundingRounds",
    "salaryMin",
    "requiresSponsorship",
  ]) {
    const row = provenance[field];
    if (
      !row
      || typeof row !== "object"
      || !Object.hasOwn(row, "stated")
      || !Object.hasOwn(row, "routed")
      || typeof row.rule !== "string"
      || !row.rule
      || stableStringify(row.routed) !== stableStringify(preferences[field])
    ) return false;
  }
  let canonical;
  try {
    canonical = buildPreferenceRouting(
      job.extracted,
      input.native,
      input.context,
    );
  } catch {
    return false;
  }
  if (
    stableStringify(canonical.preferences)
      !== stableStringify(preferences)
    || stableStringify(canonical.policy.preferenceRouting)
      !== stableStringify(provenance)
  ) return false;
  const routedAt = finiteDate(job?.automation?.preferenceRoutedAt);
  const batchAt = finiteDate(job?.automation?.backfillBatchEntryAt);
  return Boolean(
    job?.automation?.preferenceRerouteRequired === false
    && routedAt != null
    && batchAt != null
    && routedAt >= batchAt
  );
}

function payloadHashConforms(job) {
  try {
    return (
      /^[a-f0-9]{64}$/u.test(String(job?.submitPayloadHash || ""))
      && hashSubmissionPayload(buildSubmissionPayload(job))
        === job.submitPayloadHash
    );
  } catch {
    return false;
  }
}

export function phase2CanaryJobVerification(job, manifestDigest) {
  if (!job) {
    return {
      missing: true,
      authorized: false,
      preferencesRouted: false,
      payloadHashVerified: false,
      submitAttemptStarted: false,
      submitAccepted: false,
      talentNetworkVisible: false,
      preexistingVisible: false,
      waitingForResume: false,
      needsReview: false,
      error: true,
    };
  }
  const attemptAt = finiteDate(job.submitAttemptStartedAt);
  const acceptedAt = finiteDate(job.submitAcceptedAt);
  const approvalAt = finiteDate(job.submissionApprovalCheckedAt);
  const matchLegAt = finiteDate(job.matchLegStartedAt);
  const batchAt = finiteDate(job?.automation?.backfillBatchEntryAt);
  const orderedCanarySubmission = Boolean(
    batchAt != null
    && attemptAt != null
    && acceptedAt != null
    && approvalAt != null
    && matchLegAt != null
    && attemptAt >= batchAt
    && acceptedAt >= attemptAt
    && approvalAt >= acceptedAt
    && matchLegAt >= approvalAt
  );
  const readbackVisible = Boolean(
    PHASE2_CANARY_VERIFIED_STATES.has(String(job.state || ""))
    && job.submitReadbackVerified === true
    && approvalAt != null
    && matchLegAt != null
    && journalHasDetail(
      job,
      (detail) => detail === "Paraform submission verified",
    )
  );
  const visible = readbackVisible && orderedCanarySubmission;
  const preexistingVisible = Boolean(
    readbackVisible
    && (
      attemptAt == null
      || journalHasDetail(
        job,
        (detail) => detail
          === "Talent Network membership already visible; submission write skipped",
      )
    )
  );
  return {
    missing: false,
    authorized: Boolean(
      authorizedBackfillJob(job)
      && job?.automation?.canaryManifestDigest === manifestDigest
    ),
    preferencesRouted: routingPreferencesConform(job),
    payloadHashVerified: payloadHashConforms(job),
    submitAttemptStarted: Boolean(
      batchAt != null
      && attemptAt != null
      && attemptAt >= batchAt
    ),
    submitAccepted: Boolean(
      orderedCanarySubmission
    ),
    talentNetworkVisible: visible,
    preexistingVisible,
    waitingForResume: job.state === "waiting_for_resume",
    needsReview: job.state === "needs_review",
    error: Boolean(
      job.state === "error"
      || job.error
      || job?.automation?.lastFailure
      || Object.keys(job?.automation?.stepFailures || {}).length
    ),
  };
}

function phase2RemainderScan(
  jobs = [],
  {
    config = automationConfig(),
    canaryJobIds = new Set(),
  } = {},
) {
  const eligible = [];
  let excludedReview = 0;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const id = String(job?.id || "");
    if (
      !BOT_ID.test(id)
      || canaryJobIds.has(id)
      || job?.automation?.mode !== "backfill_only"
      || authorizedBackfillJob(job)
      || job?.automation?.canaryManifestDigest
      || job?.automation?.remainderManifestDigest
    ) continue;
    const freeze = automationFreezeDecision(job, config, {
      queueSource: "unknown",
    });
    if (freeze.frozen !== true || freeze.mode !== "backfill_only") {
      continue;
    }
    const decision = backfillReviewDecision(job);
    if (!decision.eligible) {
      excludedReview += 1;
      continue;
    }
    eligible.push({
      job,
      resumeReady: phase2CanaryHasResume(job),
    });
  }
  eligible.sort((left, right) => {
    if (left.resumeReady !== right.resumeReady) {
      return left.resumeReady ? -1 : 1;
    }
    const leftCreatedAt = phase2CanaryCreatedAt(left.job);
    const rightCreatedAt = phase2CanaryCreatedAt(right.job);
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt < rightCreatedAt ? -1 : 1;
    }
    const leftId = String(left.job.id);
    const rightId = String(right.job.id);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  return { eligible, excludedReview };
}

export function selectPhase2RemainderJobs(
  jobs = [],
  options = {},
) {
  return phase2RemainderScan(jobs, options).eligible
    .map(({ job }) => job);
}

function phase2RemainderPublicResult(
  record,
  {
    queue = null,
    replayed = false,
    status = null,
  } = {},
) {
  if (!record) {
    return {
      ok: true,
      status: status || "not_armed",
      replayed: false,
      canaryVerified: false,
      selected: 0,
      resumeReady: 0,
      resumeMissing: 0,
      excludedReview: 0,
      pending: 0,
      claimed: 0,
      authorized: 0,
      review: 0,
      retries: 0,
      manifestDigest: null,
      canaryManifestDigest: null,
      queue: queue || {
        queued: 0,
        due: 0,
        leased: 0,
      },
    };
  }
  const entries = Array.isArray(record.entries) ? record.entries : [];
  const count = (value) => entries
    .filter((entry) => entry.status === value).length;
  const reviewCount = count("review");
  const publicStatus = status || (
    record.status === "complete" && reviewCount > 0
      ? "complete_with_review"
      : record.status
  );
  return {
    ok: record.status !== "paused" && reviewCount === 0,
    status: publicStatus,
    replayed: replayed === true,
    canaryVerified: record?.canaryVerification?.verified === true,
    selected: entries.length,
    resumeReady: Math.max(0, Number(record.resumeReadyCount) || 0),
    resumeMissing: Math.max(0, Number(record.resumeMissingCount) || 0),
    excludedReview: Math.max(
      0,
      Number(record.excludedReviewCount) || 0,
    ),
    pending: count("pending"),
    claimed: count("claimed"),
    authorized: count("authorized"),
    review: reviewCount,
    retries: entries.filter((entry) => Number(entry.attempts) > 1).length,
    manifestDigest: /^[a-f0-9]{64}$/u.test(
      String(record.manifestDigest || ""),
    )
      ? record.manifestDigest
      : null,
    canaryManifestDigest: /^[a-f0-9]{64}$/u.test(
      String(record.canaryManifestDigest || ""),
    )
      ? record.canaryManifestDigest
      : null,
    queue: queue || {
      queued: 0,
      due: 0,
      leased: 0,
    },
  };
}

function phase2RemainderCommonAnchor(canaryRecord, snapshot, now) {
  const jobsById = new Map(
    snapshot.jobs.map((job) => [String(job.id), job]),
  );
  const anchors = canaryRecord.botIds.map((id) => {
    const job = jobsById.get(String(id));
    const value = finiteDate(job?.automation?.backfillBatchEntryAt)
      ?? finiteDate(job?.automation?.resumeWait?.enteredAt);
    return value == null ? null : new Date(value).toISOString();
  });
  const unique = new Set(anchors.filter(Boolean));
  const anchor = unique.size === 1 && anchors.every(Boolean)
    ? [...unique][0]
    : null;
  const anchorMs = finiteDate(anchor);
  if (
    anchorMs == null
    || anchorMs > Number(now) + 60_000
    || Number(now) - anchorMs >= 7 * DAY_MS
  ) {
    const error = new Error("phase 2 remainder anchor is invalid");
    error.code = "PHASE2_REMAINDER_ANCHOR_INVALID";
    throw error;
  }
  return anchor;
}

export async function armPhase2RemainderRelease(
  {
    canaryManifestDigest,
    now = Date.now(),
    config = automationConfig(),
    getReleaseImpl = getPhase2RemainderRelease,
    getCanaryImpl = getPhase2FirstTenCanary,
    snapshotImpl = getCompletePhase2CanarySnapshot,
    canaryStatusImpl = phase2FirstTenCanaryStatus,
    createPlanImpl = createPhase2RemainderPlan,
  } = {},
) {
  const current = Number(now);
  const digest = String(canaryManifestDigest || "").toLowerCase();
  if (!Number.isFinite(current)) {
    const error = new Error("phase 2 remainder timestamp is invalid");
    error.code = "PHASE2_REMAINDER_TIMESTAMP_INVALID";
    throw error;
  }
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    const error = new Error("phase 2 canary digest is invalid");
    error.code = "PHASE2_REMAINDER_DIGEST_INVALID";
    throw error;
  }
  const existing = await getReleaseImpl();
  if (existing) {
    if (existing.canaryManifestDigest !== digest) {
      const error = new Error("phase 2 canary digest does not match");
      error.code = "PHASE2_REMAINDER_DIGEST_MISMATCH";
      throw error;
    }
    return phase2RemainderPublicResult(existing, { replayed: true });
  }
  const canary = await getCanaryImpl();
  if (!canary || canary.manifestDigest !== digest) {
    const error = new Error("phase 2 canary digest does not match");
    error.code = "PHASE2_REMAINDER_DIGEST_MISMATCH";
    throw error;
  }
  let snapshot;
  try {
    snapshot = assertCompletePhase2CanarySnapshot(
      await snapshotImpl(),
    );
  } catch (cause) {
    const error = new Error("phase 2 remainder snapshot is incomplete");
    error.code = cause?.code === "PHASE2_CANARY_INDEX_LIMIT"
      ? "PHASE2_REMAINDER_INDEX_LIMIT"
      : "PHASE2_REMAINDER_SNAPSHOT_INCOMPLETE";
    throw error;
  }
  const verification = await canaryStatusImpl({
    getCanaryImpl: async () => canary,
    snapshotImpl: async () => snapshot,
  });
  if (
    verification?.ok !== true
    || verification?.verified !== true
    || verification?.selected !== PHASE2_FIRST_TEN_CANARY_LIMIT
    || verification?.releaseFenceIntact !== true
  ) {
    const error = new Error("phase 2 canary is not mechanically verified");
    error.code = "PHASE2_REMAINDER_CANARY_NOT_VERIFIED";
    throw error;
  }
  const commonAnchorAt = phase2RemainderCommonAnchor(
    canary,
    snapshot,
    current,
  );
  const canaryJobIds = new Set(canary.botIds.map(String));
  const scan = phase2RemainderScan(snapshot.jobs, {
    config,
    canaryJobIds,
  });
  const entries = scan.eligible.map(({ job, resumeReady }) => ({
    id: job.id,
    revision: Number(job.revision),
    resumeReady,
  }));
  const canaryVerification = {
    canaryManifestDigest: digest,
    snapshotFingerprint: snapshot.fingerprint,
    commonAnchorAt,
    verified: true,
    selected: Number(verification.selected),
    authorized: Number(verification.authorized),
    preferencesRouted: Number(verification.preferencesRouted),
    payloadHashVerified: Number(verification.payloadHashVerified),
    submitAttemptStarted: Number(verification.submitAttemptStarted),
    submitAccepted: Number(verification.submitAccepted),
    talentNetworkVisible: Number(verification.talentNetworkVisible),
    preexistingVisible: Number(verification.preexistingVisible),
    waitingForResume: Number(verification.waitingForResume),
    needsReview: Number(verification.needsReview),
    errors: Number(verification.errors),
    missing: Number(verification.missing),
    authorizedDelta: Number(verification.authorizedDelta),
    releaseFenceIntact: verification.releaseFenceIntact === true,
  };
  const manifestDigest = phase2RemainderManifestDigest({
    canaryManifestDigest: digest,
    snapshotFingerprint: snapshot.fingerprint,
    commonAnchorAt,
    entries,
  });
  const plan = await createPlanImpl({
    entries,
    manifestDigest,
    canaryManifestDigest: digest,
    canaryVerification,
    canaryVerificationDigest: phase2RemainderAttestationDigest(
      canaryVerification,
    ),
    snapshotFingerprint: snapshot.fingerprint,
    snapshotTotal: snapshot.total,
    commonAnchorAt,
    excludedReviewCount: scan.excludedReview,
    now: current,
  });
  return phase2RemainderPublicResult(plan.record, {
    replayed: plan.existing === true,
  });
}

export async function phase2RemainderReleaseStatus(
  {
    getReleaseImpl = getPhase2RemainderRelease,
    queueStatsImpl = getAutoQueueStats,
  } = {},
) {
  const [record, queue] = await Promise.all([
    getReleaseImpl(),
    queueStatsImpl(),
  ]);
  return phase2RemainderPublicResult(record, { queue });
}

export async function runPhase2RemainderTick(
  {
    config = automationConfig(),
    now = Date.now(),
    claimImpl = claimPhase2RemainderBatch,
    enqueueImpl = enqueueBackfill,
    authorizeEnqueueImpl =
      authorizeAndEnqueuePhase2RemainderJob,
    queueEnqueueImpl = enqueuePhase2RemainderAutoJob,
    completeImpl = completePhase2RemainderBatch,
  } = {},
) {
  const current = Number(now);
  if (!Number.isFinite(current)) {
    const error = new Error("phase 2 remainder timestamp is invalid");
    error.code = "PHASE2_REMAINDER_TIMESTAMP_INVALID";
    throw error;
  }
  if (!automationExecutionEnabled(config)) {
    return phase2RemainderPublicResult(null, {
      status: "execution_disabled",
    });
  }
  const claim = await claimImpl({
    now: current,
    batchSize: Math.max(
      1,
      Math.min(
        PHASE2_REMAINDER_BATCH_MAX,
        Number(config?.workerBatch) || 1,
      ),
    ),
  });
  if (!claim?.claimed) {
    return phase2RemainderPublicResult(claim?.record || null, {
      queue: claim?.queue,
      replayed: Boolean(claim?.busy || claim?.complete),
      status: claim?.status,
    });
  }
  const ids = claim.entries.map((entry) => entry.id);
  let results;
  try {
    results = await enqueueImpl(ids, {
      config,
      now: current,
      remainderManifestDigest: claim.record.manifestDigest,
      remainderExpectedRevisions: new Map(
        claim.entries.map((entry) => [entry.id, entry.revision]),
      ),
      expectedBackfillAnchorAt: claim.record.commonAnchorAt,
      authorizeEnqueueImpl: (
        next,
        expectedRevision,
        options,
      ) => {
        const entry = claim.entries.find(
          (row) => row.id === next?.id,
        );
        if (!entry) {
          const error = new Error("phase 2 remainder row changed");
          error.code = "PHASE2_REMAINDER_JOB_CHANGED";
          throw error;
        }
        return authorizeEnqueueImpl(
          next,
          expectedRevision,
          {
            ...options,
            now: current,
            manifestDigest: claim.record.manifestDigest,
            ownerToken: claim.ownerToken,
            entryIndex: entry.index,
            commonAnchorAt: claim.record.commonAnchorAt,
          },
        );
      },
      enqueueImpl: (id, options) => {
        const entry = claim.entries.find((row) => row.id === id);
        if (!entry) {
          const error = new Error("phase 2 remainder row changed");
          error.code = "PHASE2_REMAINDER_JOB_CHANGED";
          throw error;
        }
        return queueEnqueueImpl(id, {
          ...options,
          now: current,
          manifestDigest: claim.record.manifestDigest,
          ownerToken: claim.ownerToken,
          entryIndex: entry.index,
          commonAnchorAt: claim.record.commonAnchorAt,
        });
      },
    });
  } catch (error) {
    const code = String(error?.code || "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/gu, "_")
      .slice(0, 80);
    const completed = await completeImpl({
      ownerToken: claim.ownerToken,
      manifestDigest: claim.record.manifestDigest,
      outcomes: claim.entries.map((entry) => ({
        index: entry.index,
        status: "retry",
        error: code || "batch_enqueue_failed",
      })),
      now: current,
    });
    return phase2RemainderPublicResult(completed, {
      queue: claim.queue,
      replayed: claim.recovered === true,
    });
  }
  const byId = new Map(
    (Array.isArray(results) ? results : []).map((row) => [
      String(row?.botId || ""),
      row,
    ]),
  );
  const outcomes = claim.entries.map((entry) => {
    const result = byId.get(entry.id);
    if (result?.enqueued === true || result?.duplicate === true) {
      return { index: entry.index, status: "authorized", error: "" };
    }
    const code = String(result?.error || "enqueue_failed")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/gu, "_")
      .slice(0, 80);
    return {
      index: entry.index,
      status: PHASE2_REMAINDER_REVIEW_ERRORS.has(code)
        ? "review"
        : "retry",
      error: code,
    };
  });
  const completed = await completeImpl({
    ownerToken: claim.ownerToken,
    manifestDigest: claim.record.manifestDigest,
    outcomes,
    now: current,
  });
  return phase2RemainderPublicResult(completed, {
    queue: claim.queue,
    replayed: claim.recovered === true,
  });
}

function phase3MatchLegPreviouslyRun(job) {
  return Boolean(
    finiteDate(job?.matchCheckedAt) != null
    || finiteDate(job?.phase3Shadow?.observedAt) != null
    || Number(job?.phase3Shadow?.readCount || 0) > 0
  );
}

function phase3ReturningCandidate(job) {
  return Boolean(
    !job?.submittedAt
    && job?.submitReadbackVerified === true
    && journalHasDetail(
      job,
      (detail) => detail
        === "Talent Network membership already visible; submission write skipped",
    )
  );
}

export function selectPhase3ShadowBootstrapJobs(
  jobs = [],
  {
    stageEnabledAt,
  } = {},
) {
  const anchor = new Date(
    finiteDate(stageEnabledAt) ?? Number.NaN,
  ).toISOString();
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => {
      try {
        return stageEnableReanchorDecision({
          stageEnabledAt: anchor,
          submittedAt: job?.submittedAt,
          state: job?.state,
          submitReadbackVerified: job?.submitReadbackVerified === true,
          matchLegStartedAt: job?.matchLegStartedAt || null,
          matchLegPreviouslyRun: phase3MatchLegPreviouslyRun(job),
          enrolledAt: job?.enrolledAt || null,
          returningCandidate: phase3ReturningCandidate(job),
        }).action === "reanchor";
      } catch {
        return false;
      }
    })
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function phase3ShadowReleasePublicResult(
  record,
  {
    replayed = false,
    aggregate = null,
    callProofBootstrap = null,
    queue = null,
    status = null,
  } = {},
) {
  if (!record) {
    return {
      ok: true,
      status: status || "not_armed",
      replayed: false,
      policyVersion: PHASE3_SHADOW_POLICY_VERSION,
      snapshotComplete: false,
      callProofBootstrapComplete: false,
      callProofCandidates: 0,
      callProofConflicts: 0,
      callProofScope: "durable_pipeline_jobs",
      sourceWatermarkComplete: false,
      phase4Q37Ready: false,
      scanned: 0,
      selected: 0,
      reanchored: 0,
      queued: 0,
      matchReads: 0,
      decisions: 0,
      uniqueCandidates: 0,
      bootstrapDecisions: 0,
      organicDecisions: 0,
      settled: 0,
      pending: 0,
      bootstrapPending: 0,
      organicPending: 0,
      timedOut: 0,
      invalidAudits: 0,
      activeRetryFailures: 0,
      technicalFailures: 0,
      hardTechnicalFailures: 0,
      recommended: 0,
      possible: 0,
      zeroRoutes: 0,
      oneRoutes: 0,
      multipleRoutes: 0,
      lateReviews: 0,
      policyMismatches: 0,
      candidateFacingWrites: 0,
      curationWrites: 0,
      enrollments: 0,
      missing: 0,
      firstAuditAt: null,
      lastAuditAt: null,
      manifestDigest: null,
      releaseFenceIntact: false,
      bootstrapAuditFenceIntact: false,
      shadowFenceIntact: true,
      verificationReady: false,
      curationEvidence: "projected",
      queue: queue || { queued: 0, due: 0, leased: 0 },
    };
  }
  const entries = Array.isArray(record.entries) ? record.entries : [];
  const count = (value) => entries.filter(
    (entry) => entry.status === value,
  ).length;
  const review = count("review");
  const aggregateHealthy = !aggregate || Boolean(
    Number(aggregate.policyMismatches || 0) === 0
    && Number(aggregate.candidateFacingWrites || 0) === 0
    && Number(aggregate.curationWrites || 0) === 0
    && Number(aggregate.enrollments || 0) === 0
    && Number(aggregate.missing || 0) === 0
    && Number(aggregate.invalidAudits || 0) === 0
    && Number(aggregate.hardTechnicalFailures || 0) === 0
    && aggregate.releaseFenceIntact === true
    && aggregate.shadowFenceIntact !== false
  );
  const base = {
    ok: review === 0 && aggregateHealthy,
    status: status || (
      record.status === "released" && review
        ? "released_with_review"
        : record.status
    ),
    replayed: replayed === true,
    policyVersion: PHASE3_SHADOW_POLICY_VERSION,
    snapshotComplete: record.snapshotComplete === true,
    callProofBootstrapComplete: Boolean(
      callProofBootstrap?.status === "complete"
      || callProofBootstrap?.snapshotComplete === true
    ),
    callProofCandidates: Math.max(
      0,
      Number(
        callProofBootstrap?.candidateCount
        ?? callProofBootstrap?.candidates,
      ) || 0,
    ),
    callProofConflicts: Math.max(
      0,
      Number(callProofBootstrap?.conflicts) || 0,
    ),
    callProofScope: "durable_pipeline_jobs",
    sourceWatermarkComplete: false,
    phase4Q37Ready: false,
    scanned: Math.max(0, Number(record.snapshotTotal) || 0),
    selected: entries.length,
    pendingRelease: count("pending"),
    claimed: count("claimed"),
    released: count("scheduled"),
    releaseReview: review,
    manifestDigest: /^[a-f0-9]{64}$/u.test(
      String(record.manifestDigest || ""),
    )
      ? record.manifestDigest
      : null,
    queue: queue || { queued: 0, due: 0, leased: 0 },
  };
  return {
    ...base,
    ...(aggregate || {
      reanchored: count("scheduled"),
      queued: 0,
      matchReads: 0,
      decisions: 0,
      uniqueCandidates: 0,
      bootstrapDecisions: 0,
      organicDecisions: 0,
      settled: 0,
      pending: count("scheduled"),
      bootstrapPending: count("scheduled"),
      organicPending: 0,
      timedOut: 0,
      invalidAudits: 0,
      activeRetryFailures: 0,
      technicalFailures: 0,
      hardTechnicalFailures: 0,
      recommended: 0,
      possible: 0,
      zeroRoutes: 0,
      oneRoutes: 0,
      multipleRoutes: 0,
      lateReviews: 0,
      policyMismatches: 0,
      candidateFacingWrites: 0,
      curationWrites: 0,
      enrollments: 0,
      missing: 0,
      firstAuditAt: null,
      lastAuditAt: null,
      releaseFenceIntact: false,
      bootstrapAuditFenceIntact: false,
      shadowFenceIntact: true,
      verificationReady: false,
      curationEvidence: "projected",
      observedStatuses: {
        ranked: 0,
        pending: 0,
        unknown: 0,
      },
    }),
  };
}

function assertPhase3ShadowConfig(config, { now = Date.now() } = {}) {
  if (!phase3ShadowExecutionEnabled(config, { now })) {
    const error = new Error("phase 3 shadow gates are not safely configured");
    error.code = "PHASE3_SHADOW_RELEASE_GATES_CLOSED";
    throw error;
  }
}

function assertPhase3ShadowReleaseAnchor(record, config) {
  if (
    record
    && (
      record.policyVersion !== PHASE3_SHADOW_POLICY_VERSION
      || record.commonAnchorAt !== new Date(
        Number(config.matchStageEnabledAtMs),
      ).toISOString()
    )
  ) {
    const error = new Error(
      "phase 3 shadow release anchor conflicts with configuration",
    );
    error.code = "PHASE3_SHADOW_RELEASE_ANCHOR_CONFLICT";
    throw error;
  }
}

export async function armPhase3ShadowRelease(
  {
    now = Date.now(),
    config = automationConfig(),
    getReleaseImpl = getPhase3ShadowRelease,
    getCallProofBootstrapImpl = getPhase3CandidateSuccessBootstrap,
    snapshotImpl = getCompletePhase2CanarySnapshot,
    bootstrapCallProofImpl = bootstrapPhase3CandidateSuccessIndex,
    createReleaseImpl = createPhase3ShadowRelease,
  } = {},
) {
  const current = Number(now);
  if (!Number.isFinite(current)) {
    const error = new Error("phase 3 shadow timestamp is invalid");
    error.code = "PHASE3_SHADOW_RELEASE_TIMESTAMP_INVALID";
    throw error;
  }
  assertPhase3ShadowConfig(config, { now: current });
  const existing = await getReleaseImpl();
  if (existing) {
    assertPhase3ShadowReleaseAnchor(existing, config);
  }
  let callProofBootstrap = null;
  try {
    callProofBootstrap = await getCallProofBootstrapImpl();
  } catch {
    const error = new Error(
      "phase 3 candidate success bootstrap record is invalid",
    );
    error.code = "PHASE3_SHADOW_RELEASE_CALL_PROOF_INVALID";
    throw error;
  }
  if (existing && callProofBootstrap) {
    return phase3ShadowReleasePublicResult(existing, {
      replayed: true,
      callProofBootstrap,
    });
  }
  let snapshot;
  try {
    snapshot = assertCompletePhase2CanarySnapshot(
      await snapshotImpl(),
    );
  } catch (cause) {
    const error = new Error("phase 3 shadow snapshot is incomplete");
    error.code = cause?.code === "PHASE2_CANARY_INDEX_LIMIT"
      ? "PHASE3_SHADOW_RELEASE_INDEX_LIMIT"
      : "PHASE3_SHADOW_RELEASE_SNAPSHOT_INCOMPLETE";
    throw error;
  }
  if (!callProofBootstrap) {
    try {
      callProofBootstrap = await bootstrapCallProofImpl({
        jobs: snapshot.jobs,
        snapshotFingerprint: snapshot.fingerprint,
        snapshotTotal: snapshot.total,
        now: current,
      });
    } catch (cause) {
      const error = new Error(
        "phase 3 candidate success proof bootstrap failed",
      );
      error.code = cause?.code === "PHASE3_CALL_PROOF_SNAPSHOT_CHANGED"
        ? "PHASE3_SHADOW_RELEASE_CALL_PROOF_SNAPSHOT_CHANGED"
        : "PHASE3_SHADOW_RELEASE_CALL_PROOF_FAILED";
      throw error;
    }
  }
  if (existing) {
    return phase3ShadowReleasePublicResult(existing, {
      replayed: true,
      callProofBootstrap,
    });
  }
  const anchorMs = Number(config.matchStageEnabledAtMs);
  const commonAnchorAt = new Date(anchorMs).toISOString();
  const jobs = selectPhase3ShadowBootstrapJobs(snapshot.jobs, {
    stageEnabledAt: commonAnchorAt,
  });
  const entries = jobs.map((job) => ({
    id: job.id,
    revision: Number(job.revision),
  }));
  const manifestDigest = phase3ShadowReleaseManifestDigest({
    policyVersion: PHASE3_SHADOW_POLICY_VERSION,
    snapshotFingerprint: snapshot.fingerprint,
    commonAnchorAt,
    entries,
  });
  const release = await createReleaseImpl({
    entries,
    manifestDigest,
    snapshotFingerprint: snapshot.fingerprint,
    snapshotTotal: snapshot.total,
    commonAnchorAt,
    policyVersion: PHASE3_SHADOW_POLICY_VERSION,
    now: current,
  });
  return phase3ShadowReleasePublicResult(release.record, {
    replayed: release.existing === true,
    callProofBootstrap,
  });
}

function phase3ShadowBootstrapTransition(
  job,
  release,
  {
    now = Date.now(),
  } = {},
) {
  const anchor = release.commonAnchorAt;
  const poll = nextMatchPollDecision({
    matchLegStartedAt: anchor,
    afterAt: anchor,
  });
  return transition(job, "awaiting_matches", {
    matchLegStartedAt: anchor,
    phase3Shadow: {
      ...(job?.phase3Shadow || {}),
      policyVersion: PHASE3_SHADOW_POLICY_VERSION,
      releaseDigest: release.manifestDigest,
      stageEnabledAt: anchor,
      bootstrap: true,
      reanchorFromRevision: Number(job?.revision),
      reanchoredAt: new Date(now).toISOString(),
      nextPollAt: poll.dueAt,
      complete: false,
      candidateFacingWrites: phase3ExistingWriteCounter(
        job?.phase3Shadow,
        "candidateFacingWrites",
      ),
      curationWrites: phase3ExistingWriteCounter(
        job?.phase3Shadow,
        "curationWrites",
      ),
      enrollments: phase3ExistingWriteCounter(
        job?.phase3Shadow,
        "enrollments",
      ),
    },
    journalDetail: "Phase 3 shadow match leg re-anchored",
  });
}

export async function runPhase3ShadowReleaseTick(
  {
    config = automationConfig(),
    now = Date.now(),
    getReleaseImpl = getPhase3ShadowRelease,
    claimImpl = claimPhase3ShadowReleaseBatch,
    getJobImpl = getJob,
    admitImpl = reanchorAndEnqueuePhase3ShadowJob,
    completeImpl = completePhase3ShadowReleaseBatch,
  } = {},
) {
  const current = Number(now);
  if (!Number.isFinite(current)) {
    const error = new Error("phase 3 shadow timestamp is invalid");
    error.code = "PHASE3_SHADOW_RELEASE_TIMESTAMP_INVALID";
    throw error;
  }
  try {
    assertPhase3ShadowConfig(config, { now: current });
  } catch {
    return phase3ShadowReleasePublicResult(null, {
      status: "stage_disabled",
    });
  }
  const currentRelease = await getReleaseImpl();
  assertPhase3ShadowReleaseAnchor(currentRelease, config);
  const claim = await claimImpl({
    now: current,
    expectedCommonAnchorAt: new Date(
      Number(config.matchStageEnabledAtMs),
    ).toISOString(),
    expectedPolicyVersion: PHASE3_SHADOW_POLICY_VERSION,
    batchSize: Math.max(
      1,
      Math.min(5, Number(config?.workerBatch) || 1),
    ),
  });
  assertPhase3ShadowReleaseAnchor(claim?.record, config);
  if (!claim?.claimed) {
    return phase3ShadowReleasePublicResult(claim?.record || null, {
      queue: claim?.queue,
      replayed: Boolean(claim?.busy || claim?.released),
      status: claim?.status,
    });
  }
  const outcomes = [];
  for (const entry of claim.entries) {
    try {
      const currentJob = await getJobImpl(entry.id);
      if (!currentJob) {
        outcomes.push({
          index: entry.index,
          status: "review",
          error: "job_missing",
        });
        continue;
      }
      const alreadyAdmitted = Boolean(
        currentJob?.phase3Shadow?.releaseDigest
          === claim.record.manifestDigest
        && currentJob?.phase3Shadow?.stageEnabledAt
          === claim.record.commonAnchorAt
        && currentJob?.phase3Shadow?.bootstrap === true
      );
      if (!alreadyAdmitted) {
        const decision = stageEnableReanchorDecision({
          stageEnabledAt: claim.record.commonAnchorAt,
          submittedAt: currentJob?.submittedAt,
          state: currentJob?.state,
          submitReadbackVerified:
            currentJob?.submitReadbackVerified === true,
          matchLegStartedAt: currentJob?.matchLegStartedAt || null,
          matchLegPreviouslyRun:
            phase3MatchLegPreviouslyRun(currentJob),
          enrolledAt: currentJob?.enrolledAt || null,
          returningCandidate: phase3ReturningCandidate(currentJob),
        });
        if (decision.action !== "reanchor") {
          outcomes.push({
            index: entry.index,
            status: "review",
            error: "job_changed",
          });
          continue;
        }
      }
      const next = alreadyAdmitted
        ? currentJob
        : phase3ShadowBootstrapTransition(
            currentJob,
            claim.record,
            { now: current },
          );
      const admission = await admitImpl(
        next,
        entry.revision,
        {
          manifestDigest: claim.record.manifestDigest,
          ownerToken: claim.ownerToken,
          entryIndex: entry.index,
          commonAnchorAt: claim.record.commonAnchorAt,
          dueAt: Date.parse(claim.record.commonAnchorAt)
            + MATCH_INITIAL_POLL_MS,
          now: current,
        },
      );
      outcomes.push({
        index: entry.index,
        status: admission?.admitted === true
          ? "scheduled"
          : "retry",
        error: admission?.queue?.error || "",
      });
    } catch (error) {
      const code = String(error?.code || "release_failed")
        .toLowerCase()
        .replace(/[^a-z0-9_]+/gu, "_")
        .slice(0, 80);
      outcomes.push({
        index: entry.index,
        status: PHASE3_SHADOW_RELEASE_PERMANENT_ERRORS.has(code)
          ? "review"
          : "retry",
        error: code,
      });
    }
  }
  const completed = await completeImpl({
    ownerToken: claim.ownerToken,
    manifestDigest: claim.record.manifestDigest,
    outcomes,
    now: current,
  });
  return phase3ShadowReleasePublicResult(completed, {
    queue: claim.queue,
    replayed: claim.recovered === true,
  });
}

function phase3CanonicalIsoMs(value) {
  const text = String(value || "");
  const parsed = finiteDate(text);
  return (
    parsed != null
    && new Date(parsed).toISOString() === text
  )
    ? parsed
    : null;
}

function phase3WriteCounterViolationMagnitude(value) {
  if (!Number.isSafeInteger(value) || value < 0) return 1;
  return value;
}

function phase3PersistedWriteCounterViolation(job, field) {
  const shadow = job?.phase3Shadow;
  if (shadow?.policyVersion !== PHASE3_SHADOW_POLICY_VERSION) return 0;
  return phase3WriteCounterViolationMagnitude(shadow?.[field]);
}

function phase3ShadowAuditEvidenceValid(job) {
  const shadow = job?.phase3Shadow;
  const audit = shadow?.audit;
  const gates = audit?.gates;
  const match = audit?.match;
  const curation = audit?.curation;
  const routing = shadow?.intendedRouting;
  const lateMatch = audit?.lateMatch;
  const matchCount = Number(shadow?.matchCount);
  const endorsedCount = Number(shadow?.endorsedCount);
  const suggestedCount = Number(shadow?.suggestedCount);
  const intendedAddCount = Number(routing?.intendedCuratedAddCount);
  const candidateKey = String(
    job?.identity?.candidateId
      || job?.identity?.candidateUserId
      || "",
  ).trim();
  const settledDecision = String(shadow?.settlementDecision || "");
  const expectedZero = settledDecision === "zero_settled";
  const expectedMatches = settledDecision === "matches_settled";
  const matchLegStartedMs = phase3CanonicalIsoMs(
    job?.matchLegStartedAt,
  );
  const auditObservedMs = phase3CanonicalIsoMs(audit?.observedAt);
  const currentObservedMs = phase3CanonicalIsoMs(shadow?.observedAt);
  const zeroBaselineObservedMs = phase3CanonicalIsoMs(
    shadow?.zeroBaselineObservedAt,
  );
  const preservedZeroBaseline = Boolean(
    expectedZero
    && shadow?.lateMatchMode === true
    && zeroBaselineObservedMs != null
    && auditObservedMs === zeroBaselineObservedMs
    && currentObservedMs != null
    && currentObservedMs >= zeroBaselineObservedMs
  );
  const currentAuditBound = Boolean(
    auditObservedMs != null
    && auditObservedMs === currentObservedMs
    && shadow?.statusKind === "settled"
  );
  const auditTimingValid = Boolean(
    matchLegStartedMs != null
    && auditObservedMs != null
    && auditObservedMs >= matchLegStartedMs
    && auditObservedMs - matchLegStartedMs <= MATCH_TIMEOUT_MS
    && (
      !expectedZero
      || auditObservedMs - matchLegStartedMs >= MATCH_INITIAL_WINDOW_MS
    )
  );
  const writeCountersValid = [
    shadow?.candidateFacingWrites,
    shadow?.curationWrites,
    shadow?.enrollments,
  ].every((value) => Number.isSafeInteger(value) && value === 0);
  const routingValid = Boolean(
    routing
    && Object.hasOwn(
      LIVE_OUTCOME_SEQUENCES_BY_ID,
      String(routing.targetSequenceId || ""),
    )
    && routing.targetSequenceId === audit?.targetSequenceId
    && Number(routing.matchCount) === matchCount
    && Number(routing.endorsedCount) === endorsedCount
    && Number(routing.suggestedCount) === suggestedCount
    && Number.isInteger(intendedAddCount)
    && intendedAddCount >= 0
    && intendedAddCount === Number(curation?.intendedAddCount)
    && routing.postAddMatchCountSource === "projected"
  );
  const explicitLateReview = Boolean(
    lateMatch?.detected === true
    && lateMatch?.allowSecondEnrollment === false
    && lateMatch?.reviewNoteCode === LATE_MATCH_REVIEW_NOTE_CODE
    && lateMatch?.shouldAddReviewNote === true
    && shadow?.lateMatchDetected === true
    && routing?.lateMatchReview === true
    && routing?.enrollmentAction === "none"
    && routing?.allowSecondEnrollment === false
    && routing?.reviewNoteCode === LATE_MATCH_REVIEW_NOTE_CODE
  );
  return Boolean(
    shadow?.policyVersion === PHASE3_SHADOW_POLICY_VERSION
    && candidateKey
    && (
      shadow?.complete === true
      || preservedZeroBaseline
    )
    && shadow?.policyMismatch !== true
    && shadow?.malformedStatusObserved !== true
    && auditTimingValid
    && writeCountersValid
    && (currentAuditBound || preservedZeroBaseline)
    && (expectedZero || expectedMatches)
    && Number.isInteger(matchCount)
    && matchCount >= 0
    && (expectedZero ? matchCount === 0 : matchCount >= 1)
    && Number.isInteger(endorsedCount)
    && endorsedCount >= 0
    && Number.isInteger(suggestedCount)
    && suggestedCount >= 0
    && endorsedCount + suggestedCount === matchCount
    && audit
    && audit.policyVersion === PHASE3_SHADOW_POLICY_VERSION
    && audit.aggregateOnly === true
    && (
      audit.observedAt === shadow.observedAt
      || (
        preservedZeroBaseline
        && audit.observedAt === shadow.zeroBaselineObservedAt
      )
    )
    && match?.decision === settledDecision
    && match?.settled === true
    && match?.timedOut === false
    && Number(match?.matchCount) === matchCount
    && Number(curation?.recommendedCount) === endorsedCount
    && Number(curation?.possibleCount) === suggestedCount
    && Number(curation?.targetCount) === matchCount
    && Number(curation?.postAddMatchCount) === matchCount
    && curation?.postAddMatchCountSource === "projected"
    && gates?.allowMatchRead === true
    && gates?.allowCuratedRead === true
    && gates?.allowShadowAudit === true
    && gates?.allowCuratedWrite === false
    && gates?.allowEnrollment === false
    && gates?.candidateFacingWritesAllowed === false
    && gates?.curationPlanHealthy === true
    && gates?.settlementCurationBound === true
    && gates?.proofScopeBound === true
    && gates?.settlementDecision === settledDecision
    && Number(gates?.settlementMatchCount) === matchCount
    && gates?.settlementAllowsEnrollment === true
    && gates?.lateMatchProofHealthy === true
    && gates?.lateMatchCurationBound === true
    && (
      lateMatch?.detected === true
        ? explicitLateReview && routingValid
        : routingValid
    )
  );
}

export async function phase3ShadowReleaseStatus(
  {
    config = automationConfig(),
    getReleaseImpl = getPhase3ShadowRelease,
    getCallProofBootstrapImpl = getPhase3CandidateSuccessBootstrap,
    snapshotImpl = getCompletePhase3ShadowSnapshot,
    queueStatsImpl = getAutoQueueStats,
    now = Date.now(),
  } = {},
) {
  const [record, queue, callProofBootstrapResult] = await Promise.all([
    getReleaseImpl(),
    queueStatsImpl(),
    getCallProofBootstrapImpl()
      .then((value) => ({ value, failed: false }))
      .catch(() => ({ value: null, failed: true })),
  ]);
  const callProofBootstrap = callProofBootstrapResult.value;
  const callProofBootstrapComplete = Boolean(
    callProofBootstrap?.status === "complete",
  );
  if (!record) {
    return phase3ShadowReleasePublicResult(null, {
      queue,
      callProofBootstrap,
    });
  }
  assertPhase3ShadowConfig(config, { now });
  assertPhase3ShadowReleaseAnchor(record, config);
  let snapshot;
  try {
    snapshot = assertCompletePhase3ShadowSnapshot(
      await snapshotImpl(),
    );
  } catch {
    return phase3ShadowReleasePublicResult(record, {
      queue,
      callProofBootstrap,
      status: "snapshot_incomplete",
      aggregate: {
        reanchored: 0,
        queued: 0,
        matchReads: 0,
        decisions: 0,
        uniqueCandidates: 0,
        bootstrapDecisions: 0,
        organicDecisions: 0,
        settled: 0,
        pending: 0,
        bootstrapPending: Number(record.count) || 0,
        organicPending: 0,
        timedOut: 0,
        invalidAudits: 0,
        activeRetryFailures: 0,
        technicalFailures: Math.max(1, Number(record.count) || 1),
        hardTechnicalFailures: Math.max(
          1,
          Number(record.count) || 1,
        ),
        recommended: 0,
        possible: 0,
        zeroRoutes: 0,
        oneRoutes: 0,
        multipleRoutes: 0,
        lateReviews: 0,
        policyMismatches: 0,
        candidateFacingWrites: 0,
        curationWrites: 0,
        enrollments: 0,
        missing: record.count,
        firstAuditAt: null,
        lastAuditAt: null,
        releaseFenceIntact: false,
        bootstrapAuditFenceIntact: false,
        shadowFenceIntact: false,
        verificationReady: false,
        curationEvidence: "projected",
        observedStatuses: { ranked: 0, pending: 0, unknown: 0 },
      },
    });
  }
  const jobsById = new Map(
    snapshot.jobs.map((job) => [String(job.id), job]),
  );
  const bootstrapJobs = record.entries.map(
    (entry) => jobsById.get(String(entry.id)) || null,
  );
  const releaseAnchorMs = finiteDate(record.commonAnchorAt);
  const currentPolicyJobs = snapshot.jobs.filter((job) => (
    job?.phase3Shadow?.policyVersion === PHASE3_SHADOW_POLICY_VERSION
  ));
  const safetyJobs = [...new Map([
    ...currentPolicyJobs,
    ...bootstrapJobs.filter(Boolean),
  ].map((job) => [String(job.id), job])).values()];
  const shadowJobs = currentPolicyJobs.filter((job) => {
    const shadow = job?.phase3Shadow;
    if (
      !shadow
      || typeof shadow !== "object"
      || releaseAnchorMs == null
    ) return false;
    const bootstrapBound = Boolean(
      shadow.bootstrap === true
      && shadow.releaseDigest === record.manifestDigest
      && shadow.stageEnabledAt === record.commonAnchorAt
      && job.matchLegStartedAt === record.commonAnchorAt
    );
    const matchLegStartedMs = finiteDate(job.matchLegStartedAt);
    const stageEnabledMs = finiteDate(shadow.stageEnabledAt);
    const continuousBound = Boolean(
      shadow.bootstrap === false
      && matchLegStartedMs != null
      && matchLegStartedMs >= releaseAnchorMs
      && stageEnabledMs != null
      && stageEnabledMs >= releaseAnchorMs
      && stageEnabledMs <= matchLegStartedMs
    );
    return bootstrapBound || continuousBound;
  });
  const observed = shadowJobs.filter(
    (job) => finiteDate(job.phase3Shadow?.observedAt) != null,
  );
  const auditTimes = shadowJobs
    .filter(phase3ShadowAuditEvidenceValid)
    .map((job) => phase3CanonicalIsoMs(
      job.phase3Shadow?.audit?.observedAt,
    ))
    .filter((value) => value != null)
    .sort((left, right) => left - right);
  const statusCounts = { ranked: 0, pending: 0, unknown: 0 };
  for (const job of observed) {
    const history = Array.isArray(job.phase3Shadow?.observedStatusKinds)
      ? job.phase3Shadow.observedStatusKinds
      : [job.phase3Shadow?.statusKind];
    for (const statusKind of new Set(history.map(
      (value) => String(value || ""),
    ).filter(Boolean))) {
      if (statusKind === "settled") {
        statusCounts.ranked++;
      } else if (statusKind === "pending") {
        statusCounts.pending++;
      } else if (["unknown", "malformed"].includes(statusKind)) {
        statusCounts.unknown++;
      }
    }
  }
  const readCount = shadowJobs.reduce(
    (total, job) => total
      + Math.max(0, Number(job.phase3Shadow?.readCount) || 0),
    0,
  );
  const completeJobs = shadowJobs.filter(
    phase3ShadowAuditEvidenceValid,
  );
  const completedCandidateKeys = new Set(completeJobs.map((job) => String(
    job?.identity?.candidateId
      || job?.identity?.candidateUserId
      || "",
  )).filter(Boolean));
  const bootstrapCompleteJobs = completeJobs.filter((job) => (
    job.phase3Shadow?.bootstrap === true
    && job.phase3Shadow?.releaseDigest === record.manifestDigest
  ));
  const organicCompleteJobs = completeJobs.filter((job) => (
    job.phase3Shadow?.bootstrap === false
  ));
  const timedOutJobs = safetyJobs.filter(
    (job) => job.phase3Shadow?.settlementDecision === "timeout",
  );
  const pendingJobs = shadowJobs.filter(
    (job) => (
      !phase3ShadowAuditEvidenceValid(job)
      && job.phase3Shadow?.settlementDecision !== "timeout"
    ),
  );
  const bootstrapPending = Math.max(
    0,
    Number(record.count) - bootstrapCompleteJobs.length,
  );
  const organicPending = pendingJobs.filter(
    (job) => job.phase3Shadow?.bootstrap === false,
  ).length;
  const recommended = completeJobs.reduce(
    (total, job) => total
      + Math.max(0, Number(job.phase3Shadow?.endorsedCount) || 0),
    0,
  );
  const possible = completeJobs.reduce(
    (total, job) => total
      + Math.max(0, Number(job.phase3Shadow?.suggestedCount) || 0),
    0,
  );
  const routeCounts = {
    zero: 0,
    one: 0,
    multiple: 0,
    lateReview: 0,
  };
  for (const job of completeJobs) {
    if (job.phase3Shadow?.intendedRouting?.lateMatchReview === true) {
      routeCounts.lateReview++;
      continue;
    }
    const matchCount = Number(job.phase3Shadow?.matchCount);
    if (matchCount === 0) routeCounts.zero++;
    else if (matchCount === 1) routeCounts.one++;
    else if (Number.isFinite(matchCount) && matchCount >= 2) {
      routeCounts.multiple++;
    }
  }
  const invalidAuditJobs = safetyJobs.filter((job) => {
    const shadow = job?.phase3Shadow;
    const benignNonAuditReview = Boolean(
      shadow?.policyMismatch !== true
      && !shadow?.audit
      && !shadow?.intendedRouting
      && (
        shadow?.settlementDecision === "timeout"
        || shadow?.technicalFailure === true
      )
    );
    return Boolean(
      (
        (shadow?.complete === true && !benignNonAuditReview)
        || (shadow?.audit && typeof shadow.audit === "object")
        || shadow?.intendedRouting
      )
      && !phase3ShadowAuditEvidenceValid(job)
    );
  });
  const invalidAuditIds = new Set(
    invalidAuditJobs.map((job) => String(job.id)),
  );
  const invalidWriteCounterIds = new Set(safetyJobs.filter((job) => {
    const shadow = job?.phase3Shadow;
    if (shadow?.policyVersion !== PHASE3_SHADOW_POLICY_VERSION) {
      return false;
    }
    return [
      shadow.candidateFacingWrites,
      shadow.curationWrites,
      shadow.enrollments,
    ].some((value) => (
      !Number.isSafeInteger(value) || value !== 0
    ));
  }).map((job) => String(job.id)));
  const policyMismatchIds = new Set(safetyJobs.filter(
    (job) => (
      job.phase3Shadow?.policyMismatch === true
      || invalidAuditIds.has(String(job.id))
      || invalidWriteCounterIds.has(String(job.id))
    ),
  ).map((job) => String(job.id)));
  const policyMismatches = policyMismatchIds.size;
  const candidateFacingWrites = safetyJobs.reduce(
    (total, job) => total + Math.max(
      phase3PersistedWriteCounterViolation(
        job,
        "candidateFacingWrites",
      ),
      job.phase3Shadow?.audit?.gates?.candidateFacingWritesAllowed === true
        ? 1
        : 0,
    ),
    0,
  );
  const curationWrites = safetyJobs.reduce(
    (total, job) => total
      + phase3PersistedWriteCounterViolation(
        job,
        "curationWrites",
      ),
    0,
  );
  const enrollments = safetyJobs.reduce(
    (total, job) => total
      + phase3PersistedWriteCounterViolation(
        job,
        "enrollments",
      ),
    0,
  );
  const reanchored = bootstrapJobs.filter((job) => (
    job?.phase3Shadow?.releaseDigest === record.manifestDigest
    && job?.phase3Shadow?.stageEnabledAt === record.commonAnchorAt
    && job?.phase3Shadow?.bootstrap === true
    && job?.matchLegStartedAt === record.commonAnchorAt
  )).length;
  const missing = bootstrapJobs.filter((job) => !job).length;
  const releaseReviews = record.entries.filter(
    (entry) => entry.status === "review",
  ).length;
  const activeRetryFailureIds = new Set(safetyJobs.filter((job) => {
    const failure = job?.automation?.stepFailures?.match_read;
    return Boolean(
      job?.phase3Shadow?.policyVersion
        === PHASE3_SHADOW_POLICY_VERSION
      && job?.phase3Shadow?.complete !== true
      && failure
      && typeof failure === "object"
      && !Array.isArray(failure)
    );
  }).map((job) => String(job.id)));
  const technicalFailureIds = new Set(safetyJobs.filter((job) => (
    invalidAuditIds.has(String(job.id))
    || activeRetryFailureIds.has(String(job.id))
    || job.state === "needs_review"
    || job.phase3Shadow?.settlementDecision === "timeout"
    || Boolean(job.phase3Shadow?.technicalFailure)
  )).map((job) => String(job.id)));
  const benignTechnicalReviewIds = new Set(safetyJobs.filter((job) => {
    const shadow = job?.phase3Shadow;
    if (shadow?.policyMismatch === true) return false;
    if (
      shadow?.technicalFailureCode
        === "PHASE3_CALL_PROOF_CONFLICT"
      && shadow?.callProofConflict === true
    ) return true;
    return Boolean(
      !shadow?.audit
      && !shadow?.intendedRouting
      && shadow?.settlementDecision === "timeout"
    );
  }).map((job) => String(job.id)));
  const hardTechnicalFailureIds = new Set(
    [...technicalFailureIds].filter(
      (id) => !benignTechnicalReviewIds.has(id),
    ),
  );
  const infrastructureTechnicalFailures = (
    releaseReviews
    + missing
    + Number(
      callProofBootstrapResult.failed
      || !callProofBootstrapComplete,
    )
  );
  const technicalFailures = (
    technicalFailureIds.size
    + infrastructureTechnicalFailures
  );
  const hardTechnicalFailures = (
    hardTechnicalFailureIds.size
    + infrastructureTechnicalFailures
  );
  const queued = shadowJobs.filter((job) => (
    job.phase3Shadow?.complete !== true
    && finiteDate(job.phase3Shadow?.nextPollAt) != null
  )).length;
  const firstAuditAt = auditTimes.length
    ? new Date(auditTimes[0]).toISOString()
    : null;
  const lastAuditAt = auditTimes.length
    ? new Date(auditTimes.at(-1)).toISOString()
    : null;
  const monitoringWindowMs = auditTimes.length
    && Number.isFinite(Number(now))
    && Number(now) >= auditTimes[0]
    ? Number(now) - auditTimes[0]
    : 0;
  const releaseFenceIntact = Boolean(
    record.status === "released"
    && record.entries.every((entry) => entry.status === "scheduled")
    && reanchored === record.count
    && missing === 0
  );
  const bootstrapAuditFenceIntact = Boolean(
    releaseFenceIntact
    && bootstrapCompleteJobs.length === record.count
  );
  const shadowFenceIntact = Boolean(
    candidateFacingWrites === 0
    && curationWrites === 0
    && enrollments === 0
  );
  const aggregate = {
    reanchored,
    queued,
    matchReads: readCount,
    decisions: completeJobs.length,
    uniqueCandidates: completedCandidateKeys.size,
    bootstrapDecisions: bootstrapCompleteJobs.length,
    organicDecisions: organicCompleteJobs.length,
    settled: completeJobs.length,
    pending: pendingJobs.length,
    bootstrapPending,
    organicPending,
    timedOut: timedOutJobs.length,
    invalidAudits: invalidAuditJobs.length,
    activeRetryFailures: activeRetryFailureIds.size,
    technicalFailures,
    hardTechnicalFailures,
    recommended,
    possible,
    zeroRoutes: routeCounts.zero,
    oneRoutes: routeCounts.one,
    multipleRoutes: routeCounts.multiple,
    lateReviews: routeCounts.lateReview,
    policyMismatches,
    candidateFacingWrites,
    curationWrites,
    enrollments,
    missing,
    firstAuditAt,
    lastAuditAt,
    observedStatuses: statusCounts,
    releaseFenceIntact,
    bootstrapAuditFenceIntact,
    shadowFenceIntact,
    verificationReady: Boolean(
      completeJobs.length >= 10
      && completedCandidateKeys.size >= 10
      && monitoringWindowMs >= 48 * 60 * 60_000
      && policyMismatches === 0
      && invalidAuditJobs.length === 0
      && hardTechnicalFailures === 0
      && shadowFenceIntact
      && releaseFenceIntact
      && callProofBootstrapComplete
      && Number(now) >= auditTimes.at(-1)
    ),
    curationEvidence: "projected",
  };
  return phase3ShadowReleasePublicResult(record, {
    aggregate,
    callProofBootstrap,
    queue,
    status: aggregate.verificationReady
      ? "shadow_verified"
      : record.status === "released"
        && releaseFenceIntact
        && shadowFenceIntact
        && policyMismatches === 0
        && hardTechnicalFailures === 0
        ? "shadow_observing"
      : record.status === "released"
        ? "shadow_running"
        : null,
  });
}

export async function enqueueBackfill(
  botIds = [],
  {
    config = automationConfig(),
    now = Date.now(),
    canaryManifestDigest = null,
    canaryExpectedRevisions = null,
    remainderManifestDigest = null,
    remainderExpectedRevisions = null,
    expectedBackfillAnchorAt = null,
    getJobImpl = getJob,
    getBackfillAnchorImpl = getOrCreateResumeBackfillAnchor,
    saveJobImpl = saveJob,
    authorizeEnqueueImpl = null,
    enqueueImpl = enqueueAutoJob,
  } = {},
) {
  const canaryDigest = canaryManifestDigest == null
    ? null
    : String(canaryManifestDigest || "").toLowerCase();
  const remainderDigest = remainderManifestDigest == null
    ? null
    : String(remainderManifestDigest || "").toLowerCase();
  if (canaryDigest != null && remainderDigest != null) {
    const error = new Error("one backfill manifest provenance is required");
    error.code = "PHASE2_REMAINDER_MANIFEST_CONFLICT";
    throw error;
  }
  const provenanceKind = canaryDigest != null
    ? "canary"
    : remainderDigest != null
      ? "remainder"
      : null;
  const provenanceDigest = canaryDigest ?? remainderDigest;
  const expectedRevisions = provenanceKind === "canary"
    ? canaryExpectedRevisions
    : remainderExpectedRevisions;
  if (
    provenanceDigest != null
    && !/^[a-f0-9]{64}$/u.test(provenanceDigest)
  ) {
    const error = new Error(`valid ${provenanceKind} manifest digest required`);
    if (provenanceKind === "remainder") {
      error.code = "PHASE2_REMAINDER_DIGEST_INVALID";
    }
    throw error;
  }
  const expectedAnchor = expectedBackfillAnchorAt == null
    ? null
    : finiteDate(expectedBackfillAnchorAt);
  if (
    expectedBackfillAnchorAt != null
    && expectedAnchor == null
  ) {
    const error = new Error("phase 2 remainder anchor is invalid");
    error.code = "PHASE2_REMAINDER_ANCHOR_INVALID";
    throw error;
  }
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
  if (expectedAnchor != null && commonAnchor !== expectedAnchor) {
    const error = new Error("durable authorized-backfill anchor changed");
    error.code = "PHASE2_REMAINDER_ANCHOR_CONFLICT";
    throw error;
  }

  for (const { index, botId, current } of entries) {
    const provenanceField = provenanceKind === "canary"
      ? "canaryManifestDigest"
      : "remainderManifestDigest";
    const otherProvenanceField = provenanceKind === "canary"
      ? "remainderManifestDigest"
      : "canaryManifestDigest";
    const sameManifestAuthorization = Boolean(
      provenanceDigest
      && current?.automation?.[provenanceField] === provenanceDigest
      && authorizedBackfillJob(current)
    );
    if (
      provenanceDigest
      && String(current?.id || "") !== botId
    ) {
      results[index] = {
        botId,
        enqueued: false,
        preserved: true,
        error: `${provenanceKind}_job_changed`,
      };
      continue;
    }
    if (
      provenanceDigest
      && (
        (
          current?.automation?.[provenanceField]
          && current.automation[provenanceField] !== provenanceDigest
        )
        || current?.automation?.[otherProvenanceField]
      )
    ) {
      results[index] = {
        botId,
        enqueued: false,
        preserved: true,
        error: `${provenanceKind}_manifest_conflict`,
      };
      continue;
    }
    if (provenanceDigest && !sameManifestAuthorization) {
      const expectedRevision = expectedRevisions instanceof Map
        ? expectedRevisions.get(botId)
        : null;
      const freeze = automationFreezeDecision(current, config, {
        queueSource: "unknown",
      });
      if (
        !Number.isInteger(expectedRevision)
        || Number(current.revision) !== expectedRevision
        || current?.automation?.mode !== "backfill_only"
        || (
          provenanceKind === "canary"
          && !phase2CanaryHasResume(current)
        )
        || freeze.frozen !== true
        || freeze.mode !== "backfill_only"
      ) {
        results[index] = {
          botId,
          enqueued: false,
          preserved: true,
          error: `${provenanceKind}_job_changed`,
        };
        continue;
      }
    }
    if (
      sameManifestAuthorization
      && current?.state !== "ready_to_submit"
    ) {
      results[index] = {
        botId,
        enqueued: false,
        duplicate: true,
        preserved: true,
      };
      continue;
    }
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
    let admittedQueue = null;

    if (!(existingAnchor != null && validBackfillResumeWait(current))) {
      const next = transition(current, "ready_to_submit", {
        automation: {
          ...(current.automation || {}),
          mode: "authorized_backfill",
          status: "prepared",
          reasons: [],
          freezeReason: null,
          backfillBatchEntryAt: batchEntryAt,
          ...(provenanceDigest
            ? { [provenanceField]: provenanceDigest }
            : {}),
          preferenceRerouteRequired: true,
          resumeWait,
        },
        reviewReason: null,
        reviewReasons: [],
        error: null,
        journalDetail: "authorized backfill clocks anchored at batch entry",
      });
      try {
        if (provenanceKind === "remainder") {
          if (typeof authorizeEnqueueImpl !== "function") {
            const error = new Error(
              "phase 2 remainder atomic admission is required",
            );
            error.code = "PHASE2_REMAINDER_ATOMIC_ADMISSION_REQUIRED";
            throw error;
          }
          const eventAnchor = finiteDate(
            next.automation.resumeWait.enteredAt,
          );
          const admission = await authorizeEnqueueImpl(
            next,
            current.revision,
            {
              source: "authorized_backfill",
              eventId: `backfill:${botId}:${eventAnchor}`,
              dueAt: Number(now),
            },
          );
          if (admission?.admitted !== true) {
            results[index] = {
              ...(admission?.queue || {}),
              botId,
              enqueued: false,
              duplicate: false,
              batchEntryAt,
              firstCheckAt: resumeWait.firstCheckAt,
              error: String(
                admission?.queue?.error || "queue_capacity",
              ),
            };
            continue;
          }
          anchored = admission.job;
          admittedQueue = admission.queue;
        } else {
          anchored = await saveJobImpl(next, current.revision);
        }
      } catch (error) {
        const code = String(error?.code || "anchor_failed");
        results[index] = {
          botId,
          enqueued: false,
          error: code === "PHASE2_REMAINDER_JOB_CHANGED"
            ? "remainder_job_changed"
            : code,
        };
        continue;
      }
    }

    try {
      const eventAnchor = finiteDate(anchored.automation.resumeWait.enteredAt);
      const queued = admittedQueue || await enqueueImpl(
        botId,
        {
          source: "authorized_backfill",
          eventId: `backfill:${botId}:${eventAnchor}`,
          dueAt: Number(now),
          expectedJobRevision: Number(anchored.revision),
          commonAnchorAt: batchEntryAt,
        },
      );
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
