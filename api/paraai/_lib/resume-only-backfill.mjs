// Durable, server-selected 45-day Para AI backfill.
//
// This controller is deliberately separate from the legacy caller-selected
// `mode:"enqueue"` path. The caller supplies only an operation name. Source
// cursors, call ids, candidate ids, limits, manifests, and release batches are
// selected and retained server-side.
//
// The cohort is submit-only and resume-only:
//   * successful Raydar Screener calls from the signed exhaustive Recall reader;
//   * substantive Paraform PHONE/TWILIO screens from the agency-wide Calls feed;
//   * a resolved candidate with a resume currently on file;
//   * no resume wait, no resume chase, and no candidate email when a resume is
//     missing or disappears before submission.

import { createHash, randomUUID } from "node:crypto";

import {
  campaignLeadsAll,
  candidateDetails,
  fetchCall,
  findResumeUri,
  getResume,
  hasFutureScheduledStep,
  listSequences,
  targetMembership,
  trpcGet,
} from "./core.mjs";
import {
  ALL_OUTCOME_SEQUENCE_IDS,
} from "./phase3-shadow-policy.mjs";
import {
  autoEligibility,
  automationCallReadiness,
  automationConfig,
  backfillReviewDecision,
  phase2CanaryJobVerification,
} from "./auto.mjs";
import {
  callIdFromHumanJob,
  fetchHumanCall,
  humanCallReadiness,
} from "./human-call.mjs";
import {
  advanceExistingTalentNetworkJob,
  clearVerifiedSubmissionFailures,
  isVerifiedSubmissionFailure,
  prepareJob,
} from "./pipeline.mjs";
import {
  enqueueAutoJob,
  getAutoQueueStats,
  getJob,
  kv,
  saveJob,
  transition,
} from "./store.mjs";
import {
  readPrivateRecallSourcePage,
} from "./source-recall-page-client.mjs";

export const RESUME_ONLY_BACKFILL_VERSION = 1;
export const RESUME_ONLY_BACKFILL_DAYS = 45;
export const RESUME_ONLY_BACKFILL_FIRST_TEN = 10;
export const RESUME_ONLY_BACKFILL_RELEASE_BATCH = 5;
export const RESUME_ONLY_BACKFILL_PLAN_BUDGET_MS = 65_000;

const CONTROL_KEY = "paraai:resume-only-backfill:v1";
const ENTRIES_KEY = "paraai:resume-only-backfill:v1:entries";
const PENDING_KEY = "paraai:resume-only-backfill:v1:pending";
const RECOVERY_KEY = "paraai:resume-only-backfill:v1:recovery";
const LOCK_KEY = "paraai:resume-only-backfill:v1:lock";
const LOCK_MS = 115_000;
const HUMAN_PAGE_SIZE = 50;
const HUMAN_ROSTER_URL = "https://webview-lake.vercel.app/api/roster";
const HUMAN_ROSTER_MAX_BYTES = 16 * 1024 * 1024;
const HUMAN_ROSTER_MAX_AGE_MS = 15 * 60_000;
const HUMAN_MATCH_WINDOW_MS = 2 * 60 * 60_000;
const JOB_ID = /^[A-Za-z0-9_-]{8,100}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const CONTROL_STATUSES = new Set([
  "planning",
  "insufficient",
  "planned",
  "canary_running",
  "canary_verified",
  "running",
  "paused",
  "complete",
]);
const CANARY_STATUSES = new Set([
  "not_planned",
  "insufficient",
  "planned",
  "running",
  "paused",
  "verified",
]);
const RELEASE_STATUSES = new Set([
  "not_armed",
  "running",
  "complete",
]);
const ENTRY_STATUSES = new Set([
  "discovered",
  "eligible",
  "authorized",
  "excluded",
]);
const RECOVERY_STATUSES = new Set([
  "planned",
  "committing",
  "running",
  "verified",
]);
const RECOVERY_ROLES = new Set([
  "carried",
  "retry",
  "replacement",
]);
const TERMINAL_VISIBLE_STATES = new Set([
  "awaiting_matches",
  "ready_to_enroll",
  "ensuring_email",
  "enrolling",
  "verifying",
  "enrolled",
  "no_email",
]);
const SUBMISSION_IN_FLIGHT_STATES = new Set([
  "submit_intent",
  "submitting",
  "submission_unknown",
  "awaiting_approval",
]);
const TERMINAL_PREPARATION_CODES = new Set([
  "ARCHIVE_IMPORT_EXCLUDED",
  "HUMAN_CALL_NOT_READY",
  "INVALID_BOT_ID",
  "NOT_SUCCESSFUL_SCREEN",
]);
const RECOVERY_TERMINAL_PREATTEMPT_CODES = new Set([
  "ALREADY_ENROLLED",
  "ARCHIVE_IMPORT_EXCLUDED",
  "FUTURE_NEXT_STEP",
  "HAS_REPLIED",
  "INTERNAL_CANDIDATE",
]);
const RECOVERY_RETRYABLE_PREATTEMPT_CODES = new Set([
  "AUTH_EXPIRED",
  "JOB_BUSY",
  "PREPARE_FAILED",
  "REVISION_CONFLICT",
]);
const PUBLIC_CANARY_DIAGNOSTIC_CODES = new Set([
  ...RECOVERY_TERMINAL_PREATTEMPT_CODES,
  ...RECOVERY_RETRYABLE_PREATTEMPT_CODES,
  "ALREADY_SUBMITTED",
  "AUTO_PROCESS_FAILED",
  "CALL_END_TIMESTAMP_MISSING",
  "DIRECT_SUBMIT_QUOTA_REACHED",
  "IDENTITY_STALE",
  "PREFERENCES_REQUIRED",
  "RESUME_MISSING",
  "SUBMISSION_ALREADY_CLAIMED",
  "SUBMISSION_ATTEMPT_ALREADY_STARTED",
  "SUBMISSION_FIELDS_REQUIRED",
  "SUBMIT_NOT_VISIBLE",
  "SUBMIT_STILL_UNCONFIRMED",
  "SUBMIT_WRITE_FAILED",
  "SUBMIT_WRITE_UNKNOWN",
]);
const PUBLIC_CANARY_DIAGNOSTIC_STATES = new Set([
  "awaiting_approval",
  "awaiting_matches",
  "detected",
  "enrolled",
  "enrolling",
  "ensuring_email",
  "error",
  "extracting",
  "needs_identity_review",
  "needs_review",
  "no_email",
  "ready_to_enroll",
  "ready_to_submit",
  "resolving_identity",
  "submission_unknown",
  "submit_intent",
  "submitting",
  "verifying",
  "waiting_for_resume",
]);
const PUBLIC_CANARY_DIAGNOSTIC_STEPS = new Set([
  "call_read",
  "human_call_read",
  "prepare",
  "process",
  "reroute",
  "resume_read",
  "submission_read",
  "submit",
  "submit_reconciliation",
]);

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function iso(value, code = "RESUME_ONLY_BACKFILL_TIMESTAMP_INVALID") {
  const parsed = typeof value === "number"
    ? value
    : Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) throw codedError(code);
  return new Date(parsed).toISOString();
}

function sha(namespace, value) {
  return createHash("sha256")
    .update(String(namespace))
    .update("\0")
    .update(String(value))
    .digest("hex");
}

function manifestDigest(control, entries) {
  const rows = [...entries]
    .sort((left, right) => (
      left.callAt.localeCompare(right.callAt)
      || left.id.localeCompare(right.id)
    ))
    .map((entry) => ({
      id: entry.id,
      source: entry.source,
      callAt: entry.callAt,
      candidateHash: entry.candidateHash,
      rosterHash: entry.rosterHash || null,
    }));
  return sha("paraai-resume-only-backfill-manifest-v1", JSON.stringify({
    boundaryAt: control.boundaryAt,
    cutoffAt: control.cutoffAt,
    entries: rows,
  }));
}

function recoveryManifestDigest(record) {
  return sha(
    "paraai-resume-only-backfill-recovery-manifest-v1",
    JSON.stringify({
      version: record.version,
      revision: record.revision,
      baseManifestDigest: record.baseManifestDigest,
      skippedUnreadable: record.skippedUnreadable,
      active: record.active.map((entry) => ({
        id: entry.id,
        role: entry.role,
        candidateHash: entry.candidateHash,
        expectedRevision: entry.expectedRevision,
      })),
      terminal: record.terminal.map((entry) => ({
        id: entry.id,
        code: entry.code,
        candidateHash: entry.candidateHash,
        expectedRevision: entry.expectedRevision,
      })),
    }),
  );
}

function safeReason(value) {
  const normalized = String(value?.code || value || "excluded")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80);
  return normalized || "excluded";
}

function jobHasTechnicalFailure(job) {
  return Boolean(
    job?.error
    || job?.automation?.lastFailure
    || Object.keys(job?.automation?.stepFailures || {}).length,
  );
}

function submissionLifecycleStarted(job) {
  return Boolean(
    job?.submitClaimedAt
    || job?.submitAttemptId
    || job?.submitAttemptStartedAt
    || job?.submitAcceptedAt
    || job?.submittedAt
    || job?.submissionApprovalCheckedAt
    || job?.matchLegStartedAt,
  );
}

function aggregateDiagnosticTokens(values) {
  const counts = new Map();
  for (const value of values) {
    const token = safeReason(value || "none");
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => (
      left.localeCompare(right)
    )),
  );
}

function publicCanaryDiagnosticCode(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!code) return "NONE";
  return PUBLIC_CANARY_DIAGNOSTIC_CODES.has(code)
    ? code
    : "OTHER";
}

function publicCanaryDiagnosticState(value) {
  const state = String(value || "").trim().toLowerCase();
  if (!state) return "missing";
  return PUBLIC_CANARY_DIAGNOSTIC_STATES.has(state)
    ? state
    : "other";
}

function publicCanaryDiagnosticStep(value) {
  const step = String(value || "").trim().toLowerCase();
  return PUBLIC_CANARY_DIAGNOSTIC_STEPS.has(step)
    ? step
    : "other";
}

function canaryDiagnosticCode(job) {
  const direct = String(job?.error?.code || "").trim();
  if (direct) return publicCanaryDiagnosticCode(direct);
  const last = String(
    job?.automation?.lastFailure?.code || "",
  ).trim();
  if (last) return publicCanaryDiagnosticCode(last);
  const step = Object.values(
    job?.automation?.stepFailures || {},
  ).find((failure) => String(failure?.code || "").trim());
  return publicCanaryDiagnosticCode(step?.code);
}

function canaryRecoveryClassification(job, manifestDigest) {
  if (!job) return "missing";
  const projected = {
    ...job,
    automation: {
      ...(job.automation || {}),
      canaryManifestDigest: manifestDigest,
    },
  };
  const verification = phase2CanaryJobVerification(
    projected,
    manifestDigest,
  );
  if (
    verification.submitAccepted
    && verification.talentNetworkVisible
    && !verification.preexistingVisible
  ) {
    return "accepted_visible";
  }
  if (verification.preexistingVisible) {
    return "preexisting_visible";
  }
  if (
    job.submitAttemptStartedAt
    || job.submitAcceptedAt
    || job.submittedAt
    || job.externalWriteMayHaveLanded === true
  ) {
    return "uncertain_submission";
  }
  const code = String(canaryDiagnosticCode(job)).toUpperCase();
  if (RECOVERY_TERMINAL_PREATTEMPT_CODES.has(code)) {
    return "pre_attempt_terminal";
  }
  if (RECOVERY_RETRYABLE_PREATTEMPT_CODES.has(code)) {
    return "retryable_pre_attempt_read";
  }
  if (
    job.state === "error"
    || job.error
    || job?.automation?.lastFailure
    || Object.keys(job?.automation?.stepFailures || {}).length
  ) {
    return "unclassified_pre_attempt_error";
  }
  return "pending_pre_attempt";
}

export function resumeOnlyBackfillPreparationDecision(job) {
  if (!job) {
    return {
      prepare: true,
      force: false,
      reason: null,
    };
  }
  const state = String(job.state || "");
  if (TERMINAL_VISIBLE_STATES.has(state)) {
    return {
      prepare: false,
      force: false,
      reason: "already_submitted",
    };
  }
  if (SUBMISSION_IN_FLIGHT_STATES.has(state)) {
    return {
      prepare: false,
      force: false,
      reason: "submission_in_flight",
    };
  }
  if (submissionLifecycleStarted(job)) {
    return {
      prepare: false,
      force: false,
      reason: "already_submitted",
    };
  }
  if (
    state === "waiting_for_resume"
    || job?.automation?.resumeWait != null
  ) {
    return {
      prepare: false,
      force: false,
      reason: "resume_wait_active",
    };
  }
  if (jobHasTechnicalFailure(job)) {
    return {
      prepare: false,
      force: false,
      reason: "technical_review",
    };
  }
  if (state === "ready_to_submit") {
    return {
      prepare: true,
      force: false,
      reason: null,
    };
  }
  if (state === "needs_review") {
    const reopen = backfillReviewDecision(job);
    return reopen.eligible
      ? {
          prepare: true,
          force: true,
          reason: null,
        }
      : {
          prepare: false,
          force: false,
          reason: reopen.reason || "review_preserved",
        };
  }
  return {
    prepare: false,
    force: false,
    reason: "state_preserved",
  };
}

export async function resumeOnlyBackfillTerminalPreflight(
  job,
  {
    candidateDetailsImpl = candidateDetails,
    targetMembershipImpl = targetMembership,
    targetMembershipSnapshot = null,
  } = {},
) {
  const candidateUserId = String(
    job?.identity?.candidateUserId || "",
  ).trim();
  if (!candidateUserId) {
    throw codedError(
      "RESUME_ONLY_BACKFILL_PREFLIGHT_IDENTITY_REQUIRED",
    );
  }
  const [details, membership] = await Promise.all([
    candidateDetailsImpl(candidateUserId, { strict: true }),
    targetMembershipSnapshot == null
      ? targetMembershipImpl(candidateUserId)
      : Promise.resolve({
          targets: targetMembershipSnapshot.targets,
          memberships:
            targetMembershipSnapshot.byCandidate.get(
              candidateUserId,
            ) || [],
        }),
  ]);
  const targets = Array.isArray(membership?.targets)
    ? membership.targets
    : [];
  const targetIds = targets.map((target) => (
    String(target?.sequence?.id || "").trim()
  ));
  const memberships = Array.isArray(membership?.memberships)
    ? membership.memberships
    : null;
  const membershipTargetIds = memberships?.map((row) => (
    String(row?.sequence?.id || "").trim()
  )) || [];
  const expectedTargetIds = new Set(ALL_OUTCOME_SEQUENCE_IDS);
  if (
    !details
    || targets.length !== ALL_OUTCOME_SEQUENCE_IDS.length
    || targetIds.some((id) => !id)
    || new Set(targetIds).size !== ALL_OUTCOME_SEQUENCE_IDS.length
    || targetIds.some((id) => !expectedTargetIds.has(id))
    || memberships == null
    || new Set(membershipTargetIds).size
      !== membershipTargetIds.length
    || memberships.some((row) => (
      !expectedTargetIds.has(
        String(row?.sequence?.id || "").trim(),
      )
      || !row?.lead
    ))
  ) {
    throw codedError(
      "RESUME_ONLY_BACKFILL_PREFLIGHT_INCOMPLETE",
    );
  }
  if (hasFutureScheduledStep(details)) {
    return {
      eligible: false,
      code: "FUTURE_NEXT_STEP",
    };
  }
  if (
    memberships.some(({ lead }) => lead?.has_replied === true)
  ) {
    return {
      eligible: false,
      code: "HAS_REPLIED",
    };
  }
  if (memberships.length) {
    return {
      eligible: false,
      code: "ALREADY_ENROLLED",
    };
  }
  return {
    eligible: true,
    code: null,
  };
}

export async function readResumeOnlyBackfillTargetMembershipSnapshot({
  listSequencesImpl = listSequences,
  campaignLeadsAllImpl = campaignLeadsAll,
} = {}) {
  const sequences = await listSequencesImpl();
  if (!Array.isArray(sequences)) {
    throw codedError(
      "RESUME_ONLY_BACKFILL_PREFLIGHT_INCOMPLETE",
    );
  }
  const targets = ALL_OUTCOME_SEQUENCE_IDS.map((id) => {
    const matches = sequences.filter(
      (row) => String(row?.id || "").trim() === id,
    );
    return {
      id,
      sequence: matches.length === 1 ? matches[0] : null,
    };
  });
  const ids = targets.map((target) => (
    String(target?.sequence?.id || "").trim()
  ));
  if (
    targets.length !== ALL_OUTCOME_SEQUENCE_IDS.length
    || ids.some((id) => !id)
    || new Set(ids).size !== ALL_OUTCOME_SEQUENCE_IDS.length
    || ids.some(
      (id, index) => id !== ALL_OUTCOME_SEQUENCE_IDS[index],
    )
  ) {
    throw codedError(
      "RESUME_ONLY_BACKFILL_PREFLIGHT_INCOMPLETE",
    );
  }
  const byCandidate = new Map();
  for (const target of targets) {
    const leads = await campaignLeadsAllImpl(target.sequence.id);
    if (!Array.isArray(leads)) {
      throw codedError(
        "RESUME_ONLY_BACKFILL_PREFLIGHT_INCOMPLETE",
      );
    }
    const seen = new Set();
    for (const lead of leads) {
      const candidateUserId = String(lead?.cu_id || "").trim();
      if (!candidateUserId || seen.has(candidateUserId)) {
        throw codedError(
          "RESUME_ONLY_BACKFILL_PREFLIGHT_INCOMPLETE",
        );
      }
      seen.add(candidateUserId);
      const memberships = byCandidate.get(candidateUserId) || [];
      memberships.push({
        sequence: target.sequence,
        lead: {
          has_replied: lead?.has_replied === true,
        },
      });
      byCandidate.set(candidateUserId, memberships);
    }
  }
  return {
    targets,
    byCandidate,
  };
}

async function bindResumeOnlyBackfillTerminalPreflight(
  terminalPreflightImpl,
  targetMembershipSnapshotImpl,
) {
  if (
    terminalPreflightImpl
      !== resumeOnlyBackfillTerminalPreflight
  ) {
    return terminalPreflightImpl;
  }
  const snapshot = await targetMembershipSnapshotImpl();
  return (job) => terminalPreflightImpl(job, {
    targetMembershipSnapshot: snapshot,
  });
}

function validControl(value) {
  const boundaryMs = Date.parse(String(value?.boundaryAt || ""));
  const cutoffMs = Date.parse(String(value?.cutoffAt || ""));
  const canaryIds = value?.canary?.ids;
  const manifest = value?.manifestDigest;
  return Boolean(
    value
    && value.version === RESUME_ONLY_BACKFILL_VERSION
    && Number.isFinite(boundaryMs)
    && Number.isFinite(cutoffMs)
    && boundaryMs - cutoffMs
      === RESUME_ONLY_BACKFILL_DAYS * 24 * 60 * 60_000
    && value.recall
    && typeof value.recall.exhausted === "boolean"
    && Array.isArray(value.recall.seenCursors)
    && value.recall.seenCursors.every(
      (cursor) => typeof cursor === "string",
    )
    && new Set(value.recall.seenCursors).size
      === value.recall.seenCursors.length
    && (
      value.recall.cursor == null
      || typeof value.recall.cursor === "string"
    )
    && Number.isSafeInteger(Number(value.recall.scanned))
    && Number(value.recall.scanned) >= 0
    && Number.isSafeInteger(Number(value.recall.discovered))
    && Number(value.recall.discovered) >= 0
    && value.human
    && typeof value.human.exhausted === "boolean"
    && Number.isSafeInteger(Number(value.human.cursor))
    && Number(value.human.cursor) >= 0
    && Number.isSafeInteger(Number(value.human.scanned))
    && Number(value.human.scanned) >= 0
    && Number.isSafeInteger(Number(value.human.discovered))
    && Number(value.human.discovered) >= 0
    && Number.isSafeInteger(
      Number(value.human.rosterSuccessful || 0),
    )
    && Number(value.human.rosterSuccessful || 0) >= 0
    && CONTROL_STATUSES.has(value.status)
    && value.canary
    && CANARY_STATUSES.has(value.canary.status)
    && Array.isArray(canaryIds)
    && [0, RESUME_ONLY_BACKFILL_FIRST_TEN].includes(
      canaryIds.length,
    )
    && canaryIds.every((id) => JOB_ID.test(String(id || "")))
    && new Set(canaryIds).size === canaryIds.length
    && (
      manifest == null
      || DIGEST.test(String(manifest))
    )
    && value.release
    && RELEASE_STATUSES.has(value.release.status)
    && Number.isSafeInteger(Number(value.release.authorized))
    && Number(value.release.authorized) >= 0
    && Number.isSafeInteger(Number(value.release.excluded))
    && Number(value.release.excluded) >= 0
    && Number.isSafeInteger(Number(value.release.batchOrdinal))
    && Number(value.release.batchOrdinal) >= 0
    && Number.isFinite(Date.parse(String(value.createdAt || "")))
    && Number.isFinite(Date.parse(String(value.updatedAt || "")))
    && (
      !new Set([
        "planned",
        "canary_running",
        "canary_verified",
        "running",
        "paused",
        "complete",
      ]).has(value.status)
      || (
        DIGEST.test(String(manifest || ""))
        && canaryIds.length === RESUME_ONLY_BACKFILL_FIRST_TEN
      )
    )
  );
}

function validEntry(value) {
  return Boolean(
    value
    && value.version === RESUME_ONLY_BACKFILL_VERSION
    && JOB_ID.test(String(value.id || ""))
    && ["agent", "human"].includes(value.source)
    && Number.isFinite(Date.parse(String(value.callAt || "")))
    && ENTRY_STATUSES.has(value.status)
    && (
      value.candidateHash == null
      || DIGEST.test(String(value.candidateHash))
    )
    && (
      value.source !== "human"
      || DIGEST.test(String(value.rosterHash || ""))
    )
    && (
      value.status === "discovered"
      || value.status === "excluded"
      || DIGEST.test(String(value.candidateHash || ""))
    )
    && (
      value.authorizedAt == null
      || Number.isFinite(Date.parse(String(value.authorizedAt)))
    )
  );
}

function validRecoveryMember(value) {
  return Boolean(
    value
    && JOB_ID.test(String(value.id || ""))
    && RECOVERY_ROLES.has(String(value.role || ""))
    && DIGEST.test(String(value.candidateHash || ""))
    && Number.isSafeInteger(Number(value.expectedRevision))
    && Number(value.expectedRevision) >= 0
  );
}

function validRecoveryTerminal(value) {
  return Boolean(
    value
    && JOB_ID.test(String(value.id || ""))
    && RECOVERY_TERMINAL_PREATTEMPT_CODES.has(
      String(value.code || ""),
    )
    && DIGEST.test(String(value.candidateHash || ""))
    && Number.isSafeInteger(Number(value.expectedRevision))
    && Number(value.expectedRevision) >= 0
  );
}

function validRecovery(value) {
  const active = Array.isArray(value?.active) ? value.active : [];
  const terminal = Array.isArray(value?.terminal)
    ? value.terminal
    : [];
  const activeIds = active.map((entry) => entry.id);
  const activeCandidates = active.map(
    (entry) => entry.candidateHash,
  );
  const terminalIds = terminal.map((entry) => entry.id);
  const terminalCandidates = terminal.map(
    (entry) => entry.candidateHash,
  );
  return Boolean(
    value
    && value.version === 1
    && value.revision === 1
    && RECOVERY_STATUSES.has(value.status)
    && DIGEST.test(String(value.baseManifestDigest || ""))
    && DIGEST.test(String(value.manifestDigest || ""))
    && Number.isSafeInteger(value.skippedUnreadable)
    && value.skippedUnreadable >= 0
    && active.length === RESUME_ONLY_BACKFILL_FIRST_TEN
    && active.every(validRecoveryMember)
    && terminal.length >= 1
    && terminal.length < RESUME_ONLY_BACKFILL_FIRST_TEN
    && terminal.every(validRecoveryTerminal)
    && new Set(activeIds).size === activeIds.length
    && new Set(activeCandidates).size === activeCandidates.length
    && new Set(terminalIds).size === terminalIds.length
    && terminalIds.every((id) => !activeIds.includes(id))
    && new Set(terminalCandidates).size
      === terminalCandidates.length
    && terminalCandidates.every(
      (hash) => !activeCandidates.includes(hash),
    )
    && active.filter((entry) => entry.role === "carried").length
      >= 1
    && active.filter(
      (entry) => entry.role === "replacement",
    ).length === terminal.length
    && active.filter((entry) => (
      entry.role === "carried" || entry.role === "retry"
    )).length + terminal.length
      === RESUME_ONLY_BACKFILL_FIRST_TEN
    && Number.isFinite(Date.parse(String(value.plannedAt || "")))
    && (
      value.committedAt == null
      || Number.isFinite(Date.parse(String(value.committedAt)))
    )
    && (
      value.verifiedAt == null
      || Number.isFinite(Date.parse(String(value.verifiedAt)))
    )
    && (
      ["planned", "committing"].includes(value.status)
        ? value.committedAt == null && value.verifiedAt == null
        : Number.isFinite(
            Date.parse(String(value.committedAt || "")),
          )
    )
    && (
      value.status === "verified"
        ? Number.isFinite(
            Date.parse(String(value.verifiedAt || "")),
          )
        : value.verifiedAt == null
    )
    && recoveryManifestDigest(value) === value.manifestDigest
  );
}

function parseRecord(raw, validator, code) {
  let value;
  try {
    value = JSON.parse(String(raw || ""));
  } catch {
    throw codedError(code);
  }
  if (!validator(value)) throw codedError(code);
  return value;
}

export const resumeOnlyBackfillRedisStore = Object.freeze({
  async getControl() {
    const raw = await kv(["GET", CONTROL_KEY]);
    return raw == null
      ? null
      : parseRecord(
          raw,
          validControl,
          "RESUME_ONLY_BACKFILL_CONTROL_INVALID",
        );
  },

  async setControl(control) {
    if (!validControl(control)) {
      throw codedError("RESUME_ONLY_BACKFILL_CONTROL_INVALID");
    }
    await kv(["SET", CONTROL_KEY, JSON.stringify(control)]);
    return control;
  },

  async getRecovery() {
    const raw = await kv(["GET", RECOVERY_KEY]);
    return raw == null
      ? null
      : parseRecord(
          raw,
          validRecovery,
          "RESUME_ONLY_BACKFILL_RECOVERY_INVALID",
        );
  },

  async createRecovery(recovery) {
    if (!validRecovery(recovery)) {
      throw codedError("RESUME_ONLY_BACKFILL_RECOVERY_INVALID");
    }
    return await kv([
      "SET",
      RECOVERY_KEY,
      JSON.stringify(recovery),
      "NX",
    ]) === "OK";
  },

  async setRecovery(recovery) {
    if (!validRecovery(recovery)) {
      throw codedError("RESUME_ONLY_BACKFILL_RECOVERY_INVALID");
    }
    await kv(["SET", RECOVERY_KEY, JSON.stringify(recovery)]);
    return recovery;
  },

  async addEntry(entry) {
    if (!validEntry(entry)) {
      throw codedError("RESUME_ONLY_BACKFILL_ENTRY_INVALID");
    }
    const script = `
      if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
        return 0
      end
      redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
      redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
      return 1
    `;
    return Number(await kv([
      "EVAL",
      script,
      2,
      ENTRIES_KEY,
      PENDING_KEY,
      entry.id,
      JSON.stringify(entry),
      String(Date.parse(entry.callAt)),
    ])) === 1;
  },

  async getEntry(id) {
    const raw = await kv(["HGET", ENTRIES_KEY, String(id || "")]);
    return raw == null
      ? null
      : parseRecord(
          raw,
          validEntry,
          "RESUME_ONLY_BACKFILL_ENTRY_INVALID",
        );
  },

  async setEntry(entry) {
    if (!validEntry(entry)) {
      throw codedError("RESUME_ONLY_BACKFILL_ENTRY_INVALID");
    }
    await kv(["HSET", ENTRIES_KEY, entry.id, JSON.stringify(entry)]);
    return entry;
  },

  async removePending(id) {
    await kv(["ZREM", PENDING_KEY, String(id || "")]);
  },

  async pendingIds(limit = 1) {
    return (await kv([
      "ZRANGE",
      PENDING_KEY,
      "0",
      String(Math.max(0, Number(limit) - 1)),
    ]) || []).map(String);
  },

  async entries() {
    const rows = await kv(["HVALS", ENTRIES_KEY]) || [];
    return rows.map((raw) => parseRecord(
      raw,
      validEntry,
      "RESUME_ONLY_BACKFILL_ENTRY_INVALID",
    ));
  },
});

export async function withResumeOnlyBackfillLock(
  operation,
  {
    kvImpl = kv,
    token = randomUUID(),
    lockMs = LOCK_MS,
  } = {},
) {
  const owner = String(token || randomUUID());
  const acquired = await kvImpl([
    "SET",
    LOCK_KEY,
    owner,
    "NX",
    "PX",
    String(lockMs),
  ]);
  if (acquired !== "OK") {
    throw codedError("RESUME_ONLY_BACKFILL_BUSY");
  }
  try {
    return await operation();
  } finally {
    const release = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `;
    await kvImpl([
      "EVAL",
      release,
      1,
      LOCK_KEY,
      owner,
    ]).catch(() => {});
  }
}

function initialControl(now) {
  const boundaryAt = iso(now);
  const cutoffAt = iso(
    Date.parse(boundaryAt)
      - RESUME_ONLY_BACKFILL_DAYS * 24 * 60 * 60_000,
  );
  return {
    version: RESUME_ONLY_BACKFILL_VERSION,
    status: "planning",
    boundaryAt,
    cutoffAt,
    recall: {
      cursor: null,
      seenCursors: [],
      exhausted: false,
      scanned: 0,
      discovered: 0,
    },
    human: {
      cursor: 0,
      exhausted: false,
      scanned: 0,
      discovered: 0,
      rosterSuccessful: 0,
    },
    preparation: {
      attempted: 0,
      eligible: 0,
      excluded: 0,
    },
    createdAt: boundaryAt,
    updatedAt: boundaryAt,
    manifestDigest: null,
    canary: {
      status: "not_planned",
      ids: [],
      committedAt: null,
      verifiedAt: null,
    },
    release: {
      status: "not_armed",
      authorized: 0,
      excluded: 0,
      batchOrdinal: 0,
      armedAt: null,
      completedAt: null,
    },
  };
}

function inFrozenWindow(at, control) {
  const value = Date.parse(String(at || ""));
  return Number.isFinite(value)
    && value >= Date.parse(control.cutoffAt)
    && value < Date.parse(control.boundaryAt);
}

function referenceEntry(
  id,
  source,
  callAt,
  {
    rosterHash = null,
  } = {},
) {
  const jobId = source === "human" ? `hc-${id}` : id;
  return {
    version: RESUME_ONLY_BACKFILL_VERSION,
    id: jobId,
    source,
    callAt: iso(callAt),
    status: "discovered",
    candidateHash: null,
    rosterHash,
    reason: null,
    authorizedAt: null,
  };
}

export function confidentHumanBackfillReference(item) {
  const platform = String(item?.meeting_platform || "").trim().toLowerCase();
  // The list procedure applies `has_transcript:true` server-side but does not
  // echo that field in its rows. This is discovery only: the point read below
  // independently requires a present, substantive two-speaker transcript
  // before preparation can make the row eligible.
  return Boolean(
    item
    && typeof item === "object"
    && String(item.id || "").trim()
    && /(phone|twilio)/u.test(platform)
    && Number.isFinite(Date.parse(String(item.event_scheduled_at || "")))
  );
}

function normalizedName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['’-]/gu, "")
    .replace(/[^a-z\s]/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function nameTokens(value) {
  return normalizedName(value).split(" ").filter(Boolean);
}

export function exactHumanBackfillNamesMatch(left, right) {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (a.length < 2 || b.length < 2) return false;
  if (a[0] !== b[0] || a.at(-1) !== b.at(-1)) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const counts = new Map();
  for (const token of longer) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  for (const token of shorter) {
    const count = counts.get(token) || 0;
    if (count < 1) return false;
    counts.set(token, count - 1);
  }
  return true;
}

function humanMeetingCandidateName(item) {
  const linked = String(
    item?.candidate_user?.candidate?.name || "",
  ).trim();
  if (linked) return linked;
  return String(item?.event_title || "")
    .replace(/\s*\/\s*(?:david|alzen).*$/iu, "")
    .replace(
      /\s+(?:and|with|&)\s+(?:david|alzen).*$/iu,
      "",
    )
    .trim();
}

export function matchHumanBackfillRosterRow(item, rows) {
  if (!confidentHumanBackfillReference(item)) return null;
  const meetingName = humanMeetingCandidateName(item);
  const scheduledAt = Date.parse(
    String(item?.event_scheduled_at || ""),
  );
  const matches = (Array.isArray(rows) ? rows : []).filter((row) => (
    exactHumanBackfillNamesMatch(meetingName, row.name)
    && Math.abs(scheduledAt - row.startedAtMs)
      <= HUMAN_MATCH_WINDOW_MS
  ));
  return matches.length === 1 ? matches[0] : null;
}

export async function readHumanSuccessRoster({
  boundaryAt,
  cutoffAt,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const boundaryMs = Date.parse(String(boundaryAt || ""));
  const cutoffMs = Date.parse(String(cutoffAt || ""));
  const current = Number(now);
  if (
    !Number.isFinite(boundaryMs)
    || !Number.isFinite(cutoffMs)
    || cutoffMs >= boundaryMs
    || !Number.isFinite(current)
  ) {
    throw codedError("RESUME_ONLY_BACKFILL_ROSTER_WINDOW_INVALID");
  }
  const url = new URL(HUMAN_ROSTER_URL);
  url.searchParams.set(
    "resumeChaseGuard",
    String(Math.floor(current)),
  );
  const response = await fetchImpl(url, {
    headers: {
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const declared = Number(response.headers?.get?.("content-length"));
  if (
    Number.isFinite(declared)
    && declared > HUMAN_ROSTER_MAX_BYTES
  ) {
    throw codedError("RESUME_ONLY_BACKFILL_ROSTER_INVALID");
  }
  const raw = await response.text();
  if (
    !response.ok
    || Buffer.byteLength(raw, "utf8") > HUMAN_ROSTER_MAX_BYTES
  ) {
    throw codedError("RESUME_ONLY_BACKFILL_ROSTER_UNAVAILABLE");
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw codedError("RESUME_ONLY_BACKFILL_ROSTER_INVALID");
  }
  const generatedAt = Date.parse(String(body?.generatedAt || ""));
  if (
    body?.ok !== true
    || !Array.isArray(body?.rows)
    || Number(body?.count) !== body.rows.length
    || !Number.isFinite(generatedAt)
    || generatedAt > current + 60_000
    || current - generatedAt > HUMAN_ROSTER_MAX_AGE_MS
    || body?.degraded?.status !== false
    || body?.degraded?.history !== false
    || body?.degraded?.calendar !== false
    || body?.calendarFeed?.complete !== true
    || body?.calendarFeed?.degraded !== false
    || body?.calendarFeed?.stale !== false
  ) {
    throw codedError("RESUME_ONLY_BACKFILL_ROSTER_INVALID");
  }
  const selected = [];
  const seen = new Set();
  for (const row of body.rows) {
    const startedAtMs = Date.parse(String(
      row?.startedAt || row?.scheduledAt || "",
    ));
    const name = String(row?.candidate || "").trim();
    const key = String(row?.key || "").trim();
    if (
      String(row?.callType || "").trim().toLowerCase() !== "human"
      || String(row?.status || "").trim().toLowerCase() !== "success"
      || !Number.isFinite(startedAtMs)
      || startedAtMs < cutoffMs
      || startedAtMs >= boundaryMs
      || nameTokens(name).length < 2
      || !key
    ) {
      continue;
    }
    const rosterHash = sha(
      "paraai-resume-only-backfill-human-roster-v1",
      `${key}\0${new Date(startedAtMs).toISOString()}\0${normalizedName(name)}`,
    );
    if (seen.has(rosterHash)) {
      throw codedError("RESUME_ONLY_BACKFILL_ROSTER_INVALID");
    }
    seen.add(rosterHash);
    selected.push({
      name,
      startedAtMs,
      rosterHash,
    });
  }
  return selected;
}

export function confidentHumanBackfillCall(call) {
  const platform = String(call?.platform || "").trim().toLowerCase();
  const readiness = humanCallReadiness(call);
  return Boolean(
    call?.humanCall === true
    && call?.humanPopulation === "phone_screen"
    && /(phone|twilio)/u.test(platform)
    && call?.transcriptPresent === true
    && call?.substance?.substantive === true
    && readiness.ready === true
    && readiness.profileOnly !== true
  );
}

export async function readHumanBackfillPage(
  {
    cursor = 0,
    trpcGetImpl = trpcGet,
  } = {},
) {
  const selected = Number(cursor);
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw codedError("RESUME_ONLY_BACKFILL_HUMAN_CURSOR_INVALID");
  }
  const body = await trpcGetImpl(
    "candidateUserMeeting.getMeetingsForRecruiter",
    {
      limit: HUMAN_PAGE_SIZE,
      filters: {
        sort: {
          field: "meeting_date",
          order: "desc",
        },
      },
      past: true,
      has_transcript: true,
      search_query: "",
      include_agency_calls: true,
      cursor: selected,
      direction: "forward",
    },
  );
  if (
    !body
    || !Array.isArray(body.items)
    || body.items.length > HUMAN_PAGE_SIZE
    || !Object.hasOwn(body, "next_cursor")
  ) {
    throw codedError("RESUME_ONLY_BACKFILL_HUMAN_PAGE_INVALID");
  }
  const nextCursor = body.next_cursor == null
    ? null
    : Number(body.next_cursor);
  if (
    nextCursor != null
    && (
      !Number.isSafeInteger(nextCursor)
      || nextCursor !== selected + body.items.length
      || nextCursor <= selected
    )
  ) {
    throw codedError("RESUME_ONLY_BACKFILL_HUMAN_PAGE_INVALID");
  }
  return {
    items: body.items,
    nextCursor,
    exhausted: nextCursor == null,
  };
}

async function discoverRecallPage(control, store, readPage) {
  if (control.recall.exhausted) return control;
  const page = await readPage({
    boundaryAt: control.boundaryAt,
    cursor: control.recall.cursor,
    seenCursors: control.recall.seenCursors,
  });
  let discovered = 0;
  let reachedCutoff = false;
  for (const reference of page.references) {
    if (!inFrozenWindow(reference.joinAt, control)) {
      if (Date.parse(reference.joinAt) < Date.parse(control.cutoffAt)) {
        reachedCutoff = true;
      }
      continue;
    }
    if (await store.addEntry(referenceEntry(
      reference.id,
      "agent",
      reference.joinAt,
    ))) {
      discovered += 1;
    }
  }
  const priorCursor = control.recall.cursor;
  return {
    ...control,
    recall: {
      cursor: reachedCutoff || page.exhausted
        ? null
        : page.nextCursor,
      seenCursors: reachedCutoff || page.exhausted
        ? control.recall.seenCursors
        : priorCursor == null
          ? []
          : [...control.recall.seenCursors, priorCursor],
      exhausted: reachedCutoff || page.exhausted,
      scanned: control.recall.scanned + page.scanned,
      discovered: control.recall.discovered + discovered,
    },
  };
}

async function discoverHumanPage(
  control,
  store,
  readPage,
  readRoster,
) {
  if (control.human.exhausted) return control;
  const [page, roster] = await Promise.all([
    readPage({ cursor: control.human.cursor }),
    readRoster({
      boundaryAt: control.boundaryAt,
      cutoffAt: control.cutoffAt,
    }),
  ]);
  let discovered = 0;
  let reachedCutoff = false;
  for (const item of page.items) {
    const scheduledAt = String(item?.event_scheduled_at || "");
    const scheduledAtMs = Date.parse(scheduledAt);
    if (
      Number.isFinite(scheduledAtMs)
      && scheduledAtMs < Date.parse(control.cutoffAt)
    ) {
      reachedCutoff = true;
    }
    if (
      !confidentHumanBackfillReference(item)
      || !inFrozenWindow(scheduledAt, control)
    ) {
      continue;
    }
    const rosterRow = matchHumanBackfillRosterRow(item, roster);
    if (!rosterRow) continue;
    if (await store.addEntry(referenceEntry(
      String(item.id).trim(),
      "human",
      scheduledAt,
      { rosterHash: rosterRow.rosterHash },
    ))) {
      discovered += 1;
    }
  }
  return {
    ...control,
    human: {
      cursor: reachedCutoff || page.exhausted
        ? control.human.cursor
        : page.nextCursor,
      exhausted: reachedCutoff || page.exhausted,
      scanned: control.human.scanned + page.items.length,
      discovered: control.human.discovered + discovered,
      rosterSuccessful: roster.length,
    },
  };
}

async function excludeEntry(entry, reason, store) {
  const next = {
    ...entry,
    status: "excluded",
    reason: safeReason(reason),
    candidateHash: entry.candidateHash || null,
  };
  await store.setEntry(next);
  await store.removePending(entry.id);
  return next;
}

async function prepareEntry(
  entry,
  control,
  store,
  {
    config,
    fetchAgentCall,
    fetchHumanCallImpl,
    getJobImpl,
    getResumeImpl,
    prepareJobImpl,
  },
) {
  if (entry.status !== "discovered") {
    await store.removePending(entry.id);
    return entry;
  }
  try {
    let call;
    if (entry.source === "human") {
      call = await fetchHumanCallImpl(
        callIdFromHumanJob(entry.id),
      );
      if (
        !confidentHumanBackfillCall(call)
        || !inFrozenWindow(
          call.endedAt || call.joinAt || entry.callAt,
          control,
        )
      ) {
        return excludeEntry(entry, "human_call_not_eligible", store);
      }
    } else {
      call = await fetchAgentCall(entry.id);
      const readiness = automationCallReadiness(call, config, {
        historicalAuthorized: true,
        queueSource: "authorized_backfill",
      });
      if (
        !readiness.ready
        || !inFrozenWindow(
          call.endedAt || call.joinAt || entry.callAt,
          control,
        )
      ) {
        return excludeEntry(
          entry,
          readiness.reason || "agent_call_not_eligible",
          store,
        );
      }
    }

    const existing = await getJobImpl(entry.id);
    const preparation = resumeOnlyBackfillPreparationDecision(
      existing,
    );
    if (!preparation.prepare) {
      return excludeEntry(entry, preparation.reason, store);
    }
    const job = await prepareJobImpl({
      botId: entry.id,
      force: preparation.force,
      strictReads: true,
      callRecord: call,
    });
    if (job?.state !== "ready_to_submit") {
      return excludeEntry(
        entry,
        job?.error?.code || job?.reviewReason || job?.state || "not_ready",
        store,
      );
    }
    if (jobHasTechnicalFailure(job)) {
      return excludeEntry(entry, "technical_review", store);
    }
    const candidateUserId = String(
      job?.identity?.candidateUserId || "",
    ).trim();
    if (!candidateUserId) {
      return excludeEntry(entry, "identity_missing", store);
    }
    const resume = await getResumeImpl(candidateUserId);
    if (!findResumeUri(resume)) {
      return excludeEntry(entry, "resume_missing", store);
    }
    const eligibility = autoEligibility(job, config);
    if (!eligibility.eligible) {
      return excludeEntry(
        entry,
        `automation_${eligibility.reasons.join("_")}`,
        store,
      );
    }
    const next = {
      ...entry,
      status: "eligible",
      candidateHash: sha(
        "paraai-resume-only-backfill-candidate-v1",
        candidateUserId,
      ),
      reason: null,
    };
    await store.setEntry(next);
    await store.removePending(entry.id);
    return next;
  } catch (error) {
    if (TERMINAL_PREPARATION_CODES.has(String(error?.code || ""))) {
      return excludeEntry(entry, error, store);
    }
    await store.setEntry({
      ...entry,
      status: "discovered",
      reason: `retry_${safeReason(error)}`,
    });
    throw codedError(
      "RESUME_ONLY_BACKFILL_PREPARATION_RETRY",
    );
  }
}

async function selectFirstTen(
  entries,
  store,
  {
    getJobImpl,
    advanceExistingImpl,
    terminalPreflightImpl,
  },
) {
  const selected = [];
  const seenCandidates = new Set();
  for (const entry of [...entries].sort((left, right) => (
    left.callAt.localeCompare(right.callAt)
    || left.id.localeCompare(right.id)
  ))) {
    if (selected.length >= RESUME_ONLY_BACKFILL_FIRST_TEN) break;
    if (
      !DIGEST.test(String(entry.candidateHash || ""))
      || seenCandidates.has(entry.candidateHash)
    ) {
      continue;
    }
    try {
      const job = await getJobImpl(entry.id);
      if (job?.state !== "ready_to_submit") {
        await excludeEntry(
          entry,
          TERMINAL_VISIBLE_STATES.has(String(job?.state || ""))
            ? "already_submitted"
            : "canary_job_changed",
          store,
        );
        continue;
      }
      const checked = await advanceExistingImpl(job, {
        approvalSource: "authorized_backfill_resume_only_plan",
      });
      if (checked?.state !== "ready_to_submit") {
        await excludeEntry(entry, "already_submitted", store);
        continue;
      }
      const preflight = await terminalPreflightImpl(checked);
      if (!preflight?.eligible) {
        await excludeEntry(
          entry,
          preflight?.code || "terminal_preflight",
          store,
        );
        continue;
      }
      seenCandidates.add(entry.candidateHash);
      selected.push(entry.id);
    } catch {
      throw codedError(
        "RESUME_ONLY_BACKFILL_CANARY_SELECTION_RETRY",
      );
    }
  }
  return selected;
}

async function finishPlan(
  control,
  store,
  dependencies,
) {
  let entries = await store.entries();
  const humanRosterClaims = new Map();
  for (const entry of entries.filter(
    (candidate) => candidate.source === "human",
  )) {
    const claims = humanRosterClaims.get(entry.rosterHash) || [];
    claims.push(entry);
    humanRosterClaims.set(entry.rosterHash, claims);
  }
  for (const claims of humanRosterClaims.values()) {
    if (claims.length < 2) continue;
    for (const entry of claims) {
      if (entry.status === "eligible") {
        await excludeEntry(
          entry,
          "ambiguous_human_roster_match",
          store,
        );
      }
    }
  }
  entries = await store.entries();
  let eligible = entries.filter((entry) => entry.status === "eligible");
  const selected = await selectFirstTen(
    eligible,
    store,
    dependencies,
  );
  entries = await store.entries();
  eligible = entries.filter((entry) => entry.status === "eligible");
  const counts = entryCounts(entries);
  if (selected.length < RESUME_ONLY_BACKFILL_FIRST_TEN) {
    return {
      ...control,
      status: "insufficient",
      preparation: {
        attempted: counts.total,
        eligible: counts.eligible,
        excluded: counts.excluded,
      },
      updatedAt: new Date().toISOString(),
      canary: {
        ...control.canary,
        status: "insufficient",
        ids: [],
      },
    };
  }
  const digest = manifestDigest(control, eligible);
  return {
    ...control,
    status: "planned",
    manifestDigest: digest,
    preparation: {
      attempted: counts.total,
      eligible: counts.eligible,
      excluded: counts.excluded,
    },
    updatedAt: new Date().toISOString(),
    canary: {
      ...control.canary,
      status: "planned",
      ids: selected,
    },
  };
}

function entryCounts(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  const bySource = {
    agent: rows.filter((entry) => entry.source === "agent").length,
    human: rows.filter((entry) => entry.source === "human").length,
  };
  const byStatus = {};
  const exclusions = {};
  for (const entry of rows) {
    byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
    if (entry.status === "excluded") {
      const reason = safeReason(entry.reason);
      exclusions[reason] = (exclusions[reason] || 0) + 1;
    }
  }
  return {
    total: rows.length,
    agent: bySource.agent,
    human: bySource.human,
    eligible: byStatus.eligible || 0,
    authorized: byStatus.authorized || 0,
    excluded: byStatus.excluded || 0,
    discovered: byStatus.discovered || 0,
    exclusions,
  };
}

async function publicStatus(control, store, {
  getJobImpl = getJob,
  queueStatsImpl = getAutoQueueStats,
} = {}) {
  if (!control) {
    return {
      ok: true,
      status: "not_planned",
      windowDays: RESUME_ONLY_BACKFILL_DAYS,
      sources: {
        recallExhausted: false,
        humanExhausted: false,
        scanned: 0,
        discovered: 0,
      },
      cohort: entryCounts([]),
      canary: emptyCanaryStatus(),
      release: {
        status: "not_armed",
        authorized: 0,
        excluded: 0,
        batchOrdinal: 0,
      },
      queue: await queueStatsImpl(),
    };
  }
  const entries = await store.entries();
  const canary = await activeMechanicalCanaryStatus(
    control,
    entries,
    store,
    { getJobImpl },
  );
  const recovery = typeof store?.getRecovery === "function"
    ? await store.getRecovery()
    : null;
  return {
    ok: !["paused", "insufficient"].includes(control.status),
    status: control.status,
    windowDays: RESUME_ONLY_BACKFILL_DAYS,
    boundaryAt: control.boundaryAt,
    cutoffAt: control.cutoffAt,
    sources: {
      recallExhausted: control.recall.exhausted,
      humanExhausted: control.human.exhausted,
      scanned: control.recall.scanned + control.human.scanned,
      discovered:
        control.recall.discovered + control.human.discovered,
      humanRosterSuccessful:
        Number(control.human.rosterSuccessful) || 0,
    },
    cohort: entryCounts(entries),
    canary,
    recovery: recoveryPublicStatus(recovery),
    release: {
      status: control.release.status,
      authorized: Number(control.release.authorized) || 0,
      excluded: Number(control.release.excluded) || 0,
      batchOrdinal: Number(control.release.batchOrdinal) || 0,
    },
    queue: await queueStatsImpl(),
  };
}

function emptyCanaryStatus() {
  return {
    status: "not_planned",
    selected: 0,
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
    resumeOnlyFenceIntact: false,
    verified: false,
  };
}

export async function mechanicalCanaryStatus(
  control,
  entries,
  {
    getJobImpl = getJob,
  } = {},
) {
  const ids = Array.isArray(control?.canary?.ids)
    ? control.canary.ids
    : [];
  if (
    ids.length !== RESUME_ONLY_BACKFILL_FIRST_TEN
    || !DIGEST.test(String(control?.manifestDigest || ""))
  ) {
    return {
      ...emptyCanaryStatus(),
      status: control?.canary?.status || "not_planned",
      selected: ids.length,
    };
  }
  const entryMap = new Map(
    (Array.isArray(entries) ? entries : [])
      .map((entry) => [entry.id, entry]),
  );
  const jobs = await Promise.all(ids.map((id) => getJobImpl(id)));
  const checks = jobs.map((job, index) => {
    const entry = entryMap.get(ids[index]);
    const projected = job
      ? {
          ...job,
          automation: {
            ...(job.automation || {}),
            canaryManifestDigest: control.manifestDigest,
          },
        }
      : null;
    const base = phase2CanaryJobVerification(
      projected,
      control.manifestDigest,
    );
    const resumeOnlyFence = Boolean(
      job
      && entry?.status === "authorized"
      && job?.automation?.mode === "authorized_backfill"
      && job?.automation?.resumeOnlySubmit === true
      && job?.automation?.resumeOnlyManifestDigest
        === control.manifestDigest
      && job?.automation?.resumeOnlyCohort === "canary"
      && job?.automation?.resumeWait == null
      && DIGEST.test(String(entry?.candidateHash || ""))
    );
    return {
      ...base,
      authorized: base.authorized && resumeOnlyFence,
      resumeOnlyFence,
    };
  });
  const count = (field) => checks.filter((row) => row[field]).length;
  const result = {
    status: control.canary.status,
    selected: ids.length,
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
    resumeOnlyFenceIntact:
      count("resumeOnlyFence") === RESUME_ONLY_BACKFILL_FIRST_TEN,
  };
  result.verified = Boolean(
    result.selected === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.authorized === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.preferencesRouted === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.payloadHashVerified === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.submitAttemptStarted === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.submitAccepted === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.talentNetworkVisible === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.preexistingVisible === 0
    && result.waitingForResume === 0
    && result.needsReview === 0
    && result.errors === 0
    && result.missing === 0
    && result.resumeOnlyFenceIntact
  );
  return result;
}

function recoveryPublicStatus(recovery) {
  if (!recovery) {
    return {
      status: "not_planned",
      revision: 0,
      selected: 0,
      carried: 0,
      retry: 0,
      replacements: 0,
      terminal: 0,
      skippedUnreadable: 0,
      manifestBound: false,
      committed: false,
      verified: false,
    };
  }
  const countRole = (role) => recovery.active.filter(
    (entry) => entry.role === role,
  ).length;
  return {
    status: recovery.status,
    revision: recovery.revision,
    selected: recovery.active.length,
    carried: countRole("carried"),
    retry: countRole("retry"),
    replacements: countRole("replacement"),
    terminal: recovery.terminal.length,
    skippedUnreadable: recovery.skippedUnreadable,
    manifestBound:
      recoveryManifestDigest(recovery)
        === recovery.manifestDigest,
    committed: recovery.committedAt != null,
    verified: recovery.status === "verified",
  };
}

function acceptedVisibleRecoveryProof(job, baseManifestDigest) {
  if (!job) return false;
  const projected = {
    ...job,
    automation: {
      ...(job.automation || {}),
      canaryManifestDigest: baseManifestDigest,
    },
  };
  const verification = phase2CanaryJobVerification(
    projected,
    baseManifestDigest,
  );
  return Boolean(
    verification.submitAccepted
    && verification.talentNetworkVisible
    && !verification.preexistingVisible
  );
}

function entryCandidateMatchesJob(entry, job) {
  const candidateUserId = String(
    job?.identity?.candidateUserId || "",
  ).trim();
  return Boolean(
    candidateUserId
    && DIGEST.test(String(entry?.candidateHash || ""))
    && sha(
      "paraai-resume-only-backfill-candidate-v1",
      candidateUserId,
    ) === entry.candidateHash
  );
}

function recoveryReplacementReadMustAbort(error) {
  const code = String(error?.code || "").trim();
  return Boolean(
    code === "AUTH_EXPIRED"
    || code === "STATE_STORE_REQUEST_FAILED"
    || /^RESUME_ONLY_BACKFILL_[A-Z0-9_]+$/u.test(code)
  );
}

function recoveryStageError(error, fallbackCode) {
  const code = String(error?.code || "").trim();
  if (code === "AUTH_EXPIRED") {
    return codedError(
      "RESUME_ONLY_BACKFILL_RECOVERY_AUTH_EXPIRED",
    );
  }
  if (code === "STATE_STORE_REQUEST_FAILED") {
    return codedError(
      "RESUME_ONLY_BACKFILL_RECOVERY_STATE_STORE_FAILED",
    );
  }
  if (/^RESUME_ONLY_BACKFILL_[A-Z0-9_]+$/u.test(code)) {
    return error;
  }
  return codedError(fallbackCode);
}

export async function mechanicalRecoveryCanaryStatus(
  control,
  recovery,
  entries,
  {
    getJobImpl = getJob,
  } = {},
) {
  if (
    !validRecovery(recovery)
    || recovery.baseManifestDigest !== control?.manifestDigest
    || recovery.terminal.some(
      (entry) => !control?.canary?.ids?.includes(entry.id),
    )
    || recovery.active.some((entry) => (
      entry.role === "replacement"
        ? control?.canary?.ids?.includes(entry.id)
        : !control?.canary?.ids?.includes(entry.id)
    ))
  ) {
    return {
      ...emptyCanaryStatus(),
      status: recovery?.status || "not_planned",
      selected: Array.isArray(recovery?.active)
        ? recovery.active.length
        : 0,
    };
  }
  const entryMap = new Map(
    (Array.isArray(entries) ? entries : [])
      .map((entry) => [entry.id, entry]),
  );
  const jobs = await Promise.all(
    recovery.active.map((entry) => getJobImpl(entry.id)),
  );
  const checks = jobs.map((job, index) => {
    const recoveryEntry = recovery.active[index];
    const entry = entryMap.get(recoveryEntry.id);
    const projected = job
      ? {
          ...job,
          automation: {
            ...(job.automation || {}),
            canaryManifestDigest:
              recovery.baseManifestDigest,
          },
        }
      : null;
    const base = phase2CanaryJobVerification(
      projected,
      recovery.baseManifestDigest,
    );
    const resumeOnlyFence = Boolean(
      job
      && entry?.status === "authorized"
      && entry.candidateHash === recoveryEntry.candidateHash
      && job?.automation?.mode === "authorized_backfill"
      && job?.automation?.resumeOnlySubmit === true
      && job?.automation?.resumeOnlyManifestDigest
        === recovery.baseManifestDigest
      && job?.automation?.resumeOnlyRecoveryManifestDigest
        === recovery.manifestDigest
      && job?.automation?.resumeOnlyCohort
        === "canary_recovery"
      && job?.automation?.resumeWait == null
      && entryCandidateMatchesJob(entry, job)
    );
    return {
      ...base,
      authorized: base.authorized && resumeOnlyFence,
      resumeOnlyFence,
    };
  });
  const count = (field) => checks.filter((row) => row[field]).length;
  const result = {
    status: recovery.status,
    selected: recovery.active.length,
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
    resumeOnlyFenceIntact:
      count("resumeOnlyFence")
        === RESUME_ONLY_BACKFILL_FIRST_TEN,
  };
  result.verified = Boolean(
    result.selected === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.authorized === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.preferencesRouted === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.payloadHashVerified === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.submitAttemptStarted === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.submitAccepted === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.talentNetworkVisible
      === RESUME_ONLY_BACKFILL_FIRST_TEN
    && result.preexistingVisible === 0
    && result.waitingForResume === 0
    && result.needsReview === 0
    && result.errors === 0
    && result.missing === 0
    && result.resumeOnlyFenceIntact
  );
  return result;
}

async function activeMechanicalCanaryStatus(
  control,
  entries,
  store,
  dependencies,
) {
  const recovery = typeof store?.getRecovery === "function"
    ? await store.getRecovery()
    : null;
  if (
    recovery
    && ["running", "verified"].includes(recovery.status)
  ) {
    return mechanicalRecoveryCanaryStatus(
      control,
      recovery,
      entries,
      dependencies,
    );
  }
  return mechanicalCanaryStatus(
    control,
    entries,
    dependencies,
  );
}

function recoveryMember(entry, job, role) {
  if (
    !entryCandidateMatchesJob(entry, job)
    || !Number.isSafeInteger(Number(job?.revision))
  ) {
    throw codedError(
      "RESUME_ONLY_BACKFILL_RECOVERY_SNAPSHOT_INVALID",
    );
  }
  return {
    id: entry.id,
    role,
    candidateHash: entry.candidateHash,
    expectedRevision: Number(job.revision),
  };
}

export async function planResumeOnlyBackfillRecovery({
  now = Date.now(),
  store = resumeOnlyBackfillRedisStore,
  lockImpl = withResumeOnlyBackfillLock,
  getJobImpl = getJob,
  getResumeImpl = getResume,
  advanceExistingImpl = advanceExistingTalentNetworkJob,
  terminalPreflightImpl = resumeOnlyBackfillTerminalPreflight,
  targetMembershipSnapshotImpl =
    readResumeOnlyBackfillTargetMembershipSnapshot,
  config = automationConfig(),
} = {}) {
  return lockImpl(async () => {
    let control;
    try {
      control = await store.getControl();
    } catch (error) {
      throw recoveryStageError(
        error,
        "RESUME_ONLY_BACKFILL_RECOVERY_STATE_READ_FAILED",
      );
    }
    if (
      !control
      || control.status !== "canary_running"
      || control.canary.status !== "running"
      || control.release.status !== "not_armed"
      || control.release.authorized !== 0
    ) {
      throw codedError(
        "RESUME_ONLY_BACKFILL_RECOVERY_NOT_ALLOWED",
      );
    }
    let existing;
    try {
      existing = await store.getRecovery();
    } catch (error) {
      throw recoveryStageError(
        error,
        "RESUME_ONLY_BACKFILL_RECOVERY_STATE_READ_FAILED",
      );
    }
    if (existing) return recoveryPublicStatus(existing);
    let runTerminalPreflight;
    try {
      runTerminalPreflight =
        await bindResumeOnlyBackfillTerminalPreflight(
          terminalPreflightImpl,
          targetMembershipSnapshotImpl,
        );
    } catch (error) {
      throw recoveryStageError(
        error,
        "RESUME_ONLY_BACKFILL_RECOVERY_TARGET_SNAPSHOT_FAILED",
      );
    }
    let allEntries;
    try {
      allEntries = await store.entries();
    } catch (error) {
      throw recoveryStageError(
        error,
        "RESUME_ONLY_BACKFILL_RECOVERY_STATE_READ_FAILED",
      );
    }
    const entryMap = new Map(
      allEntries.map((entry) => [entry.id, entry]),
    );
    const originalIds = new Set(control.canary.ids);
    const active = [];
    const terminal = [];
    const seenCandidates = new Set();
    let skippedUnreadable = 0;

    for (const id of control.canary.ids) {
      const entry = entryMap.get(id);
      let job;
      try {
        job = await getJobImpl(id);
      } catch (error) {
        throw recoveryStageError(
          error,
          "RESUME_ONLY_BACKFILL_RECOVERY_ORIGINAL_STATE_READ_FAILED",
        );
      }
      if (
        !entry
        || entry.status !== "authorized"
        || !entryCandidateMatchesJob(entry, job)
        || seenCandidates.has(entry.candidateHash)
      ) {
        throw codedError(
          "RESUME_ONLY_BACKFILL_RECOVERY_SNAPSHOT_INVALID",
        );
      }
      seenCandidates.add(entry.candidateHash);
      const classification = canaryRecoveryClassification(
        job,
        control.manifestDigest,
      );
      if (classification === "accepted_visible") {
        active.push(recoveryMember(entry, job, "carried"));
        continue;
      }
      if (classification === "pre_attempt_terminal") {
        const code = String(canaryDiagnosticCode(job));
        let preflight;
        try {
          preflight = await runTerminalPreflight(job);
        } catch (error) {
          throw recoveryStageError(
            error,
            "RESUME_ONLY_BACKFILL_RECOVERY_ORIGINAL_READ_FAILED",
          );
        }
        if (
          submissionLifecycleStarted(job)
          || preflight?.eligible !== false
          || preflight?.code !== code
        ) {
          throw codedError(
            "RESUME_ONLY_BACKFILL_RECOVERY_CLASSIFICATION_CHANGED",
          );
        }
        const snapshot = recoveryMember(entry, job, "retry");
        terminal.push({
          id: snapshot.id,
          code,
          candidateHash: snapshot.candidateHash,
          expectedRevision: snapshot.expectedRevision,
        });
        continue;
      }
      if (
        classification === "pending_pre_attempt"
        && job?.state === "ready_to_submit"
        && !submissionLifecycleStarted(job)
        && !jobHasTechnicalFailure(job)
      ) {
        let preflight;
        let resume;
        try {
          preflight = await runTerminalPreflight(job);
          resume = await getResumeImpl(
            job.identity.candidateUserId,
          );
        } catch (error) {
          throw recoveryStageError(
            error,
            "RESUME_ONLY_BACKFILL_RECOVERY_ORIGINAL_READ_FAILED",
          );
        }
        const eligibility = autoEligibility(job, config);
        if (
          preflight?.eligible === true
          && findResumeUri(resume)
          && eligibility.eligible
        ) {
          active.push(recoveryMember(entry, job, "retry"));
          continue;
        }
      }
      throw codedError(
        "RESUME_ONLY_BACKFILL_RECOVERY_REVIEW_REQUIRED",
      );
    }

    for (const entry of [...allEntries].sort((left, right) => (
      left.callAt.localeCompare(right.callAt)
      || left.id.localeCompare(right.id)
    ))) {
      if (active.length >= RESUME_ONLY_BACKFILL_FIRST_TEN) break;
      if (
        entry.status !== "eligible"
        || originalIds.has(entry.id)
        || seenCandidates.has(entry.candidateHash)
      ) {
        continue;
      }
      let job;
      try {
        job = await getJobImpl(entry.id);
      } catch (error) {
        throw recoveryStageError(
          error,
          "RESUME_ONLY_BACKFILL_RECOVERY_REPLACEMENT_STATE_READ_FAILED",
        );
      }
      if (
        job?.state !== "ready_to_submit"
        || jobHasTechnicalFailure(job)
        || submissionLifecycleStarted(job)
        || !entryCandidateMatchesJob(entry, job)
      ) {
        continue;
      }
      let checked;
      try {
        checked = await advanceExistingImpl(job, {
          approvalSource:
            "authorized_backfill_resume_only_recovery_plan",
        });
      } catch (error) {
        if (recoveryReplacementReadMustAbort(error)) {
          throw recoveryStageError(
            error,
            "RESUME_ONLY_BACKFILL_RECOVERY_REPLACEMENT_READ_FAILED",
          );
        }
        skippedUnreadable += 1;
        continue;
      }
      if (checked?.state !== "ready_to_submit") {
        try {
          await excludeEntry(entry, "already_submitted", store);
        } catch (error) {
          throw recoveryStageError(
            error,
            "RESUME_ONLY_BACKFILL_RECOVERY_ENTRY_EXCLUSION_FAILED",
          );
        }
        continue;
      }
      let preflight;
      try {
        preflight = await runTerminalPreflight(checked);
      } catch (error) {
        if (recoveryReplacementReadMustAbort(error)) {
          throw recoveryStageError(
            error,
            "RESUME_ONLY_BACKFILL_RECOVERY_REPLACEMENT_READ_FAILED",
          );
        }
        skippedUnreadable += 1;
        continue;
      }
      if (!preflight?.eligible) {
        try {
          await excludeEntry(
            entry,
            preflight?.code || "terminal_preflight",
            store,
          );
        } catch (error) {
          throw recoveryStageError(
            error,
            "RESUME_ONLY_BACKFILL_RECOVERY_ENTRY_EXCLUSION_FAILED",
          );
        }
        continue;
      }
      let resume;
      try {
        resume = await getResumeImpl(
          checked.identity.candidateUserId,
        );
      } catch (error) {
        if (recoveryReplacementReadMustAbort(error)) {
          throw recoveryStageError(
            error,
            "RESUME_ONLY_BACKFILL_RECOVERY_REPLACEMENT_READ_FAILED",
          );
        }
        skippedUnreadable += 1;
        continue;
      }
      const eligibility = autoEligibility(checked, config);
      if (!findResumeUri(resume) || !eligibility.eligible) {
        try {
          await excludeEntry(
            entry,
            !findResumeUri(resume)
              ? "resume_missing_at_recovery"
              : "job_changed",
            store,
          );
        } catch (error) {
          throw recoveryStageError(
            error,
            "RESUME_ONLY_BACKFILL_RECOVERY_ENTRY_EXCLUSION_FAILED",
          );
        }
        continue;
      }
      seenCandidates.add(entry.candidateHash);
      active.push(recoveryMember(
        entry,
        checked,
        "replacement",
      ));
    }

    if (
      active.length !== RESUME_ONLY_BACKFILL_FIRST_TEN
      || terminal.length < 1
      || active.filter((entry) => entry.role === "carried").length
        < 1
    ) {
      throw codedError(
        "RESUME_ONLY_BACKFILL_RECOVERY_INSUFFICIENT",
      );
    }
    const plannedAt = iso(now);
    const proposed = {
      version: 1,
      revision: 1,
      status: "planned",
      baseManifestDigest: control.manifestDigest,
      manifestDigest: "",
      skippedUnreadable,
      active,
      terminal,
      plannedAt,
      committedAt: null,
      verifiedAt: null,
    };
    proposed.manifestDigest = recoveryManifestDigest(proposed);
    let created;
    try {
      created = await store.createRecovery(proposed);
    } catch (error) {
      throw recoveryStageError(
        error,
        "RESUME_ONLY_BACKFILL_RECOVERY_CREATE_FAILED",
      );
    }
    if (!created) {
      let raced;
      try {
        raced = await store.getRecovery();
      } catch (error) {
        throw recoveryStageError(
          error,
          "RESUME_ONLY_BACKFILL_RECOVERY_STATE_READ_FAILED",
        );
      }
      if (!raced) {
        throw codedError(
          "RESUME_ONLY_BACKFILL_RECOVERY_CREATE_FAILED",
        );
      }
      return recoveryPublicStatus(raced);
    }
    return recoveryPublicStatus(proposed);
  });
}

function recoveryStampMatches(job, recovery) {
  return Boolean(
    job?.automation?.mode === "authorized_backfill"
    && job?.automation?.resumeOnlySubmit === true
    && job?.automation?.resumeOnlyManifestDigest
      === recovery.baseManifestDigest
    && job?.automation?.resumeOnlyRecoveryManifestDigest
      === recovery.manifestDigest
    && job?.automation?.resumeOnlyCohort
      === "canary_recovery"
    && job?.automation?.resumeWait == null
  );
}

async function validateRecoveryTerminal(
  record,
  entry,
  job,
  terminalPreflightImpl,
) {
  if (
    entry?.status !== "authorized"
    || entry?.candidateHash !== record.candidateHash
    || !entryCandidateMatchesJob(entry, job)
    || submissionLifecycleStarted(job)
    || canaryDiagnosticCode(job) !== record.code
  ) {
    throw codedError(
      "RESUME_ONLY_BACKFILL_RECOVERY_CLASSIFICATION_CHANGED",
    );
  }
  const preflight = await terminalPreflightImpl(job);
  if (
    preflight?.eligible !== false
    || preflight?.code !== record.code
  ) {
    throw codedError(
      "RESUME_ONLY_BACKFILL_RECOVERY_CLASSIFICATION_CHANGED",
    );
  }
}

function recoverySubmissionReadbackVerified(job) {
  const attemptAt = Date.parse(
    String(job?.submitAttemptStartedAt || ""),
  );
  const approvalAt = Date.parse(
    String(job?.submissionApprovalCheckedAt || ""),
  );
  const matchLegAt = Date.parse(
    String(job?.matchLegStartedAt || ""),
  );
  return Boolean(
    job?.state === "awaiting_matches"
    && job?.submitReadbackVerified === true
    && Number.isFinite(attemptAt)
    && Number.isFinite(approvalAt)
    && Number.isFinite(matchLegAt)
    && approvalAt >= attemptAt
    && matchLegAt >= approvalAt
    && (job?.journal || []).some(
      (entry) => entry?.detail === "Paraform submission verified",
    )
    && !(job?.journal || []).some(
      (entry) => entry?.detail
        === "Talent Network membership already visible; submission write skipped",
    )
  );
}

async function reconcileRunningRecoverySubmissionProofs({
  recovery,
  store,
  getJobImpl,
  saveJobImpl,
}) {
  const entryMap = new Map(
    (await store.entries()).map((entry) => [entry.id, entry]),
  );
  let reconciled = 0;
  for (const record of recovery.active) {
    const job = await getJobImpl(record.id);
    const entry = entryMap.get(record.id);
    if (
      !job
      || !entry
      || entry.status !== "authorized"
      || entry.candidateHash !== record.candidateHash
      || !entryCandidateMatchesJob(entry, job)
      || !recoveryStampMatches(job, recovery)
    ) {
      throw codedError(
        "RESUME_ONLY_BACKFILL_RECOVERY_COMMIT_FAILED",
      );
    }
    if (!recoverySubmissionReadbackVerified(job)) continue;
    const automation = clearVerifiedSubmissionFailures(job);
    const clearedStepFailure = Object.keys(
      automation.stepFailures || {},
    ).length !== Object.keys(
      job?.automation?.stepFailures || {},
    ).length;
    const clearedLastFailure = Boolean(
      job?.automation?.lastFailure
      && automation.lastFailure == null,
    );
    const clearedError = isVerifiedSubmissionFailure(
      job.error,
      { defaultStep: "submit" },
    );
    const attemptAt = Date.parse(job.submitAttemptStartedAt);
    const acceptedAt = Date.parse(
      String(job.submitAcceptedAt || ""),
    );
    const repairedAcceptedAt = (
      !Number.isFinite(acceptedAt)
      || acceptedAt < attemptAt
    )
      ? job.submissionApprovalCheckedAt
      : job.submitAcceptedAt;
    if (
      !clearedStepFailure
      && !clearedLastFailure
      && !clearedError
      && repairedAcceptedAt === job.submitAcceptedAt
    ) continue;
    const next = transition(job, job.state, {
      submitAcceptedAt: repairedAcceptedAt,
      automation,
      error: clearedError ? null : job.error,
      journalDetail:
        "verified recovery submission proof normalized without another write",
    });
    await saveJobImpl(next, job.revision);
    reconciled += 1;
  }
  return reconciled;
}

export async function commitResumeOnlyBackfillRecovery({
  now = Date.now(),
  store = resumeOnlyBackfillRedisStore,
  lockImpl = withResumeOnlyBackfillLock,
  getJobImpl = getJob,
  getResumeImpl = getResume,
  saveJobImpl = saveJob,
  enqueueImpl = enqueueAutoJob,
  terminalPreflightImpl = resumeOnlyBackfillTerminalPreflight,
  targetMembershipSnapshotImpl =
    readResumeOnlyBackfillTargetMembershipSnapshot,
  config = automationConfig(),
} = {}) {
  return lockImpl(async () => {
    const control = await store.getControl();
    let recovery = await store.getRecovery();
    if (
      !control
      || !recovery
      || recovery.baseManifestDigest !== control.manifestDigest
      || !["planned", "committing", "running"].includes(
        recovery.status,
      )
      || control.release.status !== "not_armed"
      || control.release.authorized !== 0
    ) {
      throw codedError(
        "RESUME_ONLY_BACKFILL_RECOVERY_NOT_ALLOWED",
      );
    }
    const originalIds = new Set(control.canary.ids);
    if (
      recovery.terminal.some(
        (entry) => !originalIds.has(entry.id),
      )
      || recovery.active.some((entry) => (
        entry.role === "replacement"
          ? originalIds.has(entry.id)
          : !originalIds.has(entry.id)
      ))
    ) {
      throw codedError(
        "RESUME_ONLY_BACKFILL_RECOVERY_INVALID",
      );
    }
    if (recovery.status === "running") {
      return {
        ...recoveryPublicStatus(recovery),
        reconciledVisibleSubmissions:
          await reconcileRunningRecoverySubmissionProofs({
            recovery,
            store,
            getJobImpl,
            saveJobImpl,
          }),
      };
    }
    const runTerminalPreflight =
      await bindResumeOnlyBackfillTerminalPreflight(
        terminalPreflightImpl,
        targetMembershipSnapshotImpl,
      );
    const entryMap = new Map(
      (await store.entries()).map((entry) => [entry.id, entry]),
    );
    const jobs = new Map();
    for (const record of [
      ...recovery.active,
      ...recovery.terminal,
    ]) {
      const job = await getJobImpl(record.id);
      const entry = entryMap.get(record.id);
      if (
        !job
        || !entry
        || entry.candidateHash !== record.candidateHash
        || !entryCandidateMatchesJob(entry, job)
      ) {
        throw codedError(
          "RESUME_ONLY_BACKFILL_RECOVERY_SNAPSHOT_CHANGED",
        );
      }
      jobs.set(record.id, job);
    }
    for (const record of recovery.terminal) {
      await validateRecoveryTerminal(
        record,
        entryMap.get(record.id),
        jobs.get(record.id),
        runTerminalPreflight,
      );
    }
    if (recovery.status === "planned") {
      for (const record of recovery.active) {
        const job = jobs.get(record.id);
        const entry = entryMap.get(record.id);
        const stamped = recoveryStampMatches(job, recovery);
        if (record.role === "carried") {
          if (
            entry.status !== "authorized"
            || !acceptedVisibleRecoveryProof(
              job,
              recovery.baseManifestDigest,
            )
            || !["NONE", "AUTH_EXPIRED"].includes(
              canaryDiagnosticCode(job),
            )
            || Object.keys(
              job?.automation?.stepFailures || {},
            ).length
          ) {
            throw codedError(
              "RESUME_ONLY_BACKFILL_RECOVERY_CARRY_INVALID",
            );
          }
          continue;
        }
        if (
          stamped
          && acceptedVisibleRecoveryProof(
            job,
            recovery.baseManifestDigest,
          )
        ) {
          continue;
        }
        if (
          !stamped
          && Number(job.revision) !== record.expectedRevision
        ) {
          throw codedError(
            "RESUME_ONLY_BACKFILL_RECOVERY_SNAPSHOT_CHANGED",
          );
        }
        if (
          job.state !== "ready_to_submit"
          || submissionLifecycleStarted(job)
          || jobHasTechnicalFailure(job)
          || (
            record.role === "retry"
            && entry.status !== "authorized"
          )
          || (
            record.role === "replacement"
            && !["eligible", "authorized"].includes(entry.status)
          )
        ) {
          throw codedError(
            "RESUME_ONLY_BACKFILL_RECOVERY_SNAPSHOT_CHANGED",
          );
        }
        const preflight = await runTerminalPreflight(job);
        const resume = await getResumeImpl(
          job.identity.candidateUserId,
        );
        if (
          preflight?.eligible !== true
          || !findResumeUri(resume)
          || !autoEligibility(job, config).eligible
        ) {
          throw codedError(
            "RESUME_ONLY_BACKFILL_RECOVERY_PREFLIGHT_CHANGED",
          );
        }
      }

      for (const record of recovery.active) {
        let job = await getJobImpl(record.id);
        const entry = await store.getEntry(record.id);
        if (record.role === "carried") {
          if (
            !recoveryStampMatches(job, recovery)
            || job.error
            || job?.automation?.lastFailure
          ) {
            const next = transition(job, job.state, {
              automation: {
                ...(job.automation || {}),
                lastFailure: null,
                stepFailures: {},
                resumeOnlyRecoveryManifestDigest:
                  recovery.manifestDigest,
                resumeOnlyCohort: "canary_recovery",
              },
              error: null,
              journalDetail:
                "verified canary submission carried into recovery manifest",
            });
            await saveJobImpl(next, job.revision);
          }
          continue;
        }
        if (recoveryStampMatches(job, recovery)) continue;
        const resume = await getResumeImpl(
          job.identity.candidateUserId,
        );
        const resumeUri = findResumeUri(resume);
        if (!resumeUri) {
          throw codedError(
            "RESUME_ONLY_BACKFILL_RECOVERY_PREFLIGHT_CHANGED",
          );
        }
        const batchEntryAt = String(
          job?.automation?.backfillBatchEntryAt || iso(now),
        );
        const next = transition(job, "ready_to_submit", {
          submission: {
            ...(job.submission || {}),
            resumeUri,
            resumeStatus: "on_file",
          },
          automation: {
            ...(job.automation || {}),
            mode: "authorized_backfill",
            status: "prepared",
            reasons: [],
            freezeReason: null,
            backfillBatchEntryAt: batchEntryAt,
            resumeOnlySubmit: true,
            resumeOnlyManifestDigest:
              recovery.baseManifestDigest,
            resumeOnlyRecoveryManifestDigest:
              recovery.manifestDigest,
            resumeOnlyCohort: "canary_recovery",
            preferenceRerouteRequired: true,
            resumeWait: null,
          },
          reviewReason: null,
          reviewReasons: [],
          error: null,
          journalDetail:
            "resume-only recovery manifest staged before queue admission",
        });
        await saveJobImpl(next, job.revision);
        await store.setEntry({
          ...entry,
          status: "authorized",
          reason: null,
          authorizedAt: entry.authorizedAt || batchEntryAt,
        });
      }
      recovery = {
        ...recovery,
        status: "committing",
      };
      await store.setRecovery(recovery);
    } else {
      for (const record of recovery.active) {
        const job = jobs.get(record.id);
        const entry = entryMap.get(record.id);
        if (
          entry.status !== "authorized"
          || !recoveryStampMatches(job, recovery)
          || (
            record.role === "carried"
            && !acceptedVisibleRecoveryProof(
              job,
              recovery.baseManifestDigest,
            )
          )
        ) {
          throw codedError(
            "RESUME_ONLY_BACKFILL_RECOVERY_COMMIT_FAILED",
          );
        }
      }
    }

    let queued = 0;
    let duplicate = 0;
    for (const record of recovery.active) {
      if (record.role === "carried") continue;
      const job = await getJobImpl(record.id);
      const result = await enqueueImpl(record.id, {
        source: "authorized_backfill",
        eventId:
          `resume-only:${recovery.manifestDigest}:${record.id}`,
        dueAt: now,
        callEndedAt: job?.callEndedAt
          || entryMap.get(record.id)?.callAt,
        now,
      });
      if (
        result?.enqueued !== true
        && result?.duplicate !== true
      ) {
        throw codedError(
          "RESUME_ONLY_BACKFILL_RECOVERY_COMMIT_FAILED",
        );
      }
      queued += result.enqueued === true ? 1 : 0;
      duplicate += result.duplicate === true ? 1 : 0;
    }
    recovery = {
      ...recovery,
      status: "running",
      committedAt: recovery.committedAt || iso(now),
    };
    await store.setRecovery(recovery);
    return {
      ...recoveryPublicStatus(recovery),
      carriedCommitted: recovery.active.filter(
        (entry) => entry.role === "carried",
      ).length,
      queued,
      duplicate,
    };
  });
}

export async function resumeOnlyBackfillRecoveryStatus({
  store = resumeOnlyBackfillRedisStore,
  getJobImpl = getJob,
} = {}) {
  const control = await store.getControl();
  const recovery = await store.getRecovery();
  const entries = await store.entries();
  return {
    ok: true,
    ...recoveryPublicStatus(recovery),
    canary: recovery
      ? await mechanicalRecoveryCanaryStatus(
          control,
          recovery,
          entries,
          { getJobImpl },
        )
      : emptyCanaryStatus(),
  };
}

function aggregateCanaryDiagnostics(jobs, manifestDigest) {
  const failureSteps = jobs.flatMap((job) => (
    Object.entries(job?.automation?.stepFailures || {})
      .map(([step, failure]) => (
        `${publicCanaryDiagnosticStep(step)}:${safeReason(
          publicCanaryDiagnosticCode(failure?.code),
        )}`
      ))
  ));
  return {
    selected: jobs.length,
    states: aggregateDiagnosticTokens(
      jobs.map((job) => (
        publicCanaryDiagnosticState(job?.state)
      )),
    ),
    errorCodes: aggregateDiagnosticTokens(
      jobs.map(canaryDiagnosticCode),
    ),
    failureSteps: aggregateDiagnosticTokens(failureSteps),
    classifications: aggregateDiagnosticTokens(
      jobs.map((job) => canaryRecoveryClassification(
        job,
        manifestDigest,
      )),
    ),
  };
}

export async function resumeOnlyBackfillDiagnostics({
  store = resumeOnlyBackfillRedisStore,
  getJobImpl = getJob,
} = {}) {
  const control = await store.getControl();
  if (!control) {
    return {
      ok: true,
      status: "not_planned",
      selected: 0,
      states: {},
      errorCodes: {},
      failureSteps: {},
      classifications: {},
    };
  }
  const ids = Array.isArray(control?.canary?.ids)
    ? control.canary.ids
    : [];
  const recovery = typeof store?.getRecovery === "function"
    ? await store.getRecovery()
    : null;
  const jobs = await Promise.all(ids.map((id) => getJobImpl(id)));
  const canaryDiagnostics = aggregateCanaryDiagnostics(
    jobs,
    control.manifestDigest,
  );
  const recoveryJobs = recovery
    ? await Promise.all(
        recovery.active.map((entry) => getJobImpl(entry.id)),
      )
    : [];
  return {
    ok: true,
    status: control.status,
    canaryStatus: control.canary.status,
    ...canaryDiagnostics,
    recovery: recoveryPublicStatus(recovery),
    activeRecovery: aggregateCanaryDiagnostics(
      recoveryJobs,
      control.manifestDigest,
    ),
  };
}

export async function runResumeOnlyBackfillPlanTick({
  now = Date.now(),
  store = resumeOnlyBackfillRedisStore,
  lockImpl = withResumeOnlyBackfillLock,
  readRecallPageImpl = readPrivateRecallSourcePage,
  readHumanPageImpl = readHumanBackfillPage,
  readHumanRosterImpl = readHumanSuccessRoster,
  fetchAgentCall = fetchCall,
  fetchHumanCallImpl = fetchHumanCall,
  getJobImpl = getJob,
  getResumeImpl = getResume,
  prepareJobImpl = prepareJob,
  advanceExistingImpl = advanceExistingTalentNetworkJob,
  terminalPreflightImpl = resumeOnlyBackfillTerminalPreflight,
  targetMembershipSnapshotImpl =
    readResumeOnlyBackfillTargetMembershipSnapshot,
  queueStatsImpl = getAutoQueueStats,
  config = automationConfig(),
  budgetMs = RESUME_ONLY_BACKFILL_PLAN_BUDGET_MS,
} = {}) {
  return lockImpl(async () => {
    let control = await store.getControl();
    if (!control) {
      control = initialControl(now);
      await store.setControl(control);
    }
    if (control.status !== "planning") {
      return publicStatus(control, store, {
        getJobImpl,
        queueStatsImpl,
      });
    }
    const startedAt = Date.now();
    if (!control.recall.exhausted) {
      control = await discoverRecallPage(
        control,
        store,
        readRecallPageImpl,
      );
      control.updatedAt = new Date().toISOString();
      await store.setControl(control);
    }
    if (!control.human.exhausted) {
      control = await discoverHumanPage(
        control,
        store,
        readHumanPageImpl,
        readHumanRosterImpl,
      );
      control.updatedAt = new Date().toISOString();
      await store.setControl(control);
    }

    while (Date.now() - startedAt < Number(budgetMs)) {
      const [id] = await store.pendingIds(1);
      if (!id) break;
      const entry = await store.getEntry(id);
      if (!entry) {
        await store.removePending(id);
        continue;
      }
      await prepareEntry(entry, control, store, {
        config,
        fetchAgentCall,
        fetchHumanCallImpl,
        getJobImpl,
        getResumeImpl,
        prepareJobImpl,
      });
    }

    const [pending] = await store.pendingIds(1);
    if (
      control.recall.exhausted
      && control.human.exhausted
      && !pending
    ) {
      const runTerminalPreflight =
        await bindResumeOnlyBackfillTerminalPreflight(
          terminalPreflightImpl,
          targetMembershipSnapshotImpl,
        );
      control = await finishPlan(control, store, {
        getJobImpl,
        advanceExistingImpl,
        terminalPreflightImpl: runTerminalPreflight,
      });
      await store.setControl(control);
    } else {
      const counts = entryCounts(await store.entries());
      control = {
        ...control,
        preparation: {
          attempted:
            counts.eligible + counts.excluded,
          eligible: counts.eligible,
          excluded: counts.excluded,
        },
        updatedAt: new Date().toISOString(),
      };
      await store.setControl(control);
    }
    return publicStatus(control, store, {
      getJobImpl,
      queueStatsImpl,
    });
  });
}

async function authorizeEntry(
  entry,
  control,
  cohort,
  store,
  {
    getJobImpl,
    getResumeImpl,
    saveJobImpl,
    enqueueImpl,
    terminalPreflightImpl,
    recoveryManifestDigest = null,
    now,
    config,
  },
) {
  let job = await getJobImpl(entry.id);
  if (!job) {
    await excludeEntry(entry, "job_missing", store);
    return { authorized: false, excluded: true };
  }
  const stamped = Boolean(
    job?.automation?.resumeOnlySubmit === true
    && job?.automation?.resumeOnlyManifestDigest
      === control.manifestDigest
    && (
      recoveryManifestDigest == null
      || job?.automation?.resumeOnlyRecoveryManifestDigest
        === recoveryManifestDigest
    )
  );
  if (stamped && entry.status === "authorized") {
    return {
      authorized: true,
      duplicate: true,
    };
  }
  if (TERMINAL_VISIBLE_STATES.has(String(job.state || ""))) {
    if (!stamped) {
      await excludeEntry(entry, "already_submitted", store);
      return { authorized: false, excluded: true };
    }
    await store.setEntry({
      ...entry,
      status: "authorized",
      reason: null,
      authorizedAt:
        entry.authorizedAt || job.automation.backfillBatchEntryAt,
    });
    return {
      authorized: true,
      duplicate: true,
    };
  }
  if (job.state !== "ready_to_submit") {
    await excludeEntry(
      entry,
      TERMINAL_VISIBLE_STATES.has(String(job.state || ""))
        ? "already_submitted"
        : "job_changed",
      store,
    );
    return { authorized: false, excluded: true };
  }
  const eligibility = autoEligibility(job, config);
  if (
    jobHasTechnicalFailure(job)
    || !eligibility.eligible
  ) {
    await excludeEntry(entry, "job_changed", store);
    return { authorized: false, excluded: true };
  }
  const candidateUserId = String(
    job?.identity?.candidateUserId || "",
  ).trim();
  if (
    !candidateUserId
    || sha(
      "paraai-resume-only-backfill-candidate-v1",
      candidateUserId,
    ) !== entry.candidateHash
  ) {
    await excludeEntry(entry, "candidate_changed", store);
    return { authorized: false, excluded: true };
  }
  const resume = await getResumeImpl(candidateUserId);
  const resumeUri = findResumeUri(resume);
  if (!resumeUri) {
    await excludeEntry(entry, "resume_missing_at_release", store);
    return { authorized: false, excluded: true };
  }
  const preflight = await terminalPreflightImpl(job);
  if (!preflight?.eligible) {
    if (entry.status === "authorized") {
      throw codedError(
        "RESUME_ONLY_BACKFILL_RECOVERY_PREFLIGHT_CHANGED",
      );
    }
    await excludeEntry(
      entry,
      preflight?.code || "terminal_preflight",
      store,
    );
    return { authorized: false, excluded: true };
  }
  if (stamped) {
    const queued = await enqueueImpl(entry.id, {
      source: "authorized_backfill",
      eventId:
        `resume-only:${recoveryManifestDigest || control.manifestDigest}:${entry.id}`,
      dueAt: now,
      callEndedAt: job.callEndedAt || entry.callAt,
      now,
    });
    await store.setEntry({
      ...entry,
      status: "authorized",
      reason: null,
      authorizedAt:
        entry.authorizedAt || job.automation.backfillBatchEntryAt,
    });
    return {
      authorized: true,
      duplicate: queued.duplicate === true,
    };
  }
  const batchEntryAt = iso(now);
  const next = transition(job, "ready_to_submit", {
    submission: {
      ...(job.submission || {}),
      resumeUri,
      resumeStatus: "on_file",
    },
    automation: {
      ...(job.automation || {}),
      mode: "authorized_backfill",
      status: "prepared",
      reasons: [],
      freezeReason: null,
      backfillBatchEntryAt: batchEntryAt,
      resumeOnlySubmit: true,
      resumeOnlyManifestDigest: control.manifestDigest,
      ...(recoveryManifestDigest == null
        ? {}
        : {
            resumeOnlyRecoveryManifestDigest:
              recoveryManifestDigest,
          }),
      resumeOnlyCohort: cohort,
      preferenceRerouteRequired: true,
      resumeWait: null,
    },
    reviewReason: null,
    reviewReasons: [],
    error: null,
    journalDetail:
      "resume-only authorized backfill entered submit batch",
  });
  job = await saveJobImpl(next, job.revision);
  const queued = await enqueueImpl(entry.id, {
    source: "authorized_backfill",
    eventId:
      `resume-only:${recoveryManifestDigest || control.manifestDigest}:${entry.id}`,
    dueAt: now,
    callEndedAt: job.callEndedAt || entry.callAt,
    now,
  });
  await store.setEntry({
    ...entry,
    status: "authorized",
    reason: null,
    authorizedAt: batchEntryAt,
  });
  return {
    authorized: true,
    duplicate: queued.duplicate === true,
  };
}

export async function commitResumeOnlyBackfillFirstTen({
  now = Date.now(),
  store = resumeOnlyBackfillRedisStore,
  lockImpl = withResumeOnlyBackfillLock,
  getJobImpl = getJob,
  getResumeImpl = getResume,
  saveJobImpl = saveJob,
  enqueueImpl = enqueueAutoJob,
  terminalPreflightImpl = resumeOnlyBackfillTerminalPreflight,
  targetMembershipSnapshotImpl =
    readResumeOnlyBackfillTargetMembershipSnapshot,
  queueStatsImpl = getAutoQueueStats,
  config = automationConfig(),
} = {}) {
  return lockImpl(async () => {
    let control = await store.getControl();
    if (!control) {
      throw codedError("RESUME_ONLY_BACKFILL_PLAN_REQUIRED");
    }
    if (!["planned", "canary_running"].includes(control.status)) {
      return publicStatus(control, store, {
        getJobImpl,
        queueStatsImpl,
      });
    }
    if (
      control.canary.ids.length
        !== RESUME_ONLY_BACKFILL_FIRST_TEN
      || !DIGEST.test(String(control.manifestDigest || ""))
    ) {
      throw codedError("RESUME_ONLY_BACKFILL_PLAN_INVALID");
    }
    const runTerminalPreflight =
      await bindResumeOnlyBackfillTerminalPreflight(
        terminalPreflightImpl,
        targetMembershipSnapshotImpl,
      );
    let authorized = 0;
    let excluded = 0;
    for (const id of control.canary.ids) {
      const entry = await store.getEntry(id);
      if (!entry) {
        throw codedError("RESUME_ONLY_BACKFILL_ENTRY_INVALID");
      }
      const result = await authorizeEntry(
        entry,
        control,
        "canary",
        store,
        {
          getJobImpl,
          getResumeImpl,
          saveJobImpl,
          enqueueImpl,
          terminalPreflightImpl: runTerminalPreflight,
          now,
          config,
        },
      );
      authorized += result.authorized ? 1 : 0;
      excluded += result.excluded ? 1 : 0;
    }
    control = {
      ...control,
      status: excluded ? "paused" : "canary_running",
      updatedAt: new Date().toISOString(),
      canary: {
        ...control.canary,
        status: excluded ? "paused" : "running",
        committedAt:
          control.canary.committedAt || iso(now),
      },
    };
    await store.setControl(control);
    const status = await publicStatus(control, store, {
      getJobImpl,
      queueStatsImpl,
    });
    return {
      ...status,
      committed: authorized,
      commitExcluded: excluded,
    };
  });
}

export async function verifyResumeOnlyBackfillFirstTen({
  store = resumeOnlyBackfillRedisStore,
  lockImpl = withResumeOnlyBackfillLock,
  getJobImpl = getJob,
  queueStatsImpl = getAutoQueueStats,
} = {}) {
  return lockImpl(async () => {
    let control = await store.getControl();
    if (!control) {
      throw codedError("RESUME_ONLY_BACKFILL_PLAN_REQUIRED");
    }
    const entries = await store.entries();
    let recovery = typeof store?.getRecovery === "function"
      ? await store.getRecovery()
      : null;
    const mechanical = await activeMechanicalCanaryStatus(
      control,
      entries,
      store,
      { getJobImpl },
    );
    if (!mechanical.verified) {
      const status = await publicStatus(control, store, {
        getJobImpl,
        queueStatsImpl,
      });
      return {
        ...status,
        ok: false,
        verificationRecorded: false,
      };
    }
    const verifiedAt = new Date().toISOString();
    if (recovery) {
      if (!["running", "verified"].includes(recovery.status)) {
        throw codedError(
          "RESUME_ONLY_BACKFILL_RECOVERY_NOT_COMMITTED",
        );
      }
      recovery = {
        ...recovery,
        status: "verified",
        verifiedAt: recovery.verifiedAt || verifiedAt,
      };
      await store.setRecovery(recovery);
      control = {
        ...control,
        status: "canary_verified",
        updatedAt: verifiedAt,
      };
    } else {
      control = {
        ...control,
        status: "canary_verified",
        updatedAt: verifiedAt,
        canary: {
          ...control.canary,
          status: "verified",
          verifiedAt,
        },
      };
    }
    await store.setControl(control);
    return {
      ...await publicStatus(control, store, {
        getJobImpl,
        queueStatsImpl,
      }),
      verificationRecorded: true,
    };
  });
}

export async function armResumeOnlyBackfillRemainder({
  now = Date.now(),
  store = resumeOnlyBackfillRedisStore,
  lockImpl = withResumeOnlyBackfillLock,
  getJobImpl = getJob,
  queueStatsImpl = getAutoQueueStats,
} = {}) {
  return lockImpl(async () => {
    let control = await store.getControl();
    if (!control) {
      throw codedError("RESUME_ONLY_BACKFILL_PLAN_REQUIRED");
    }
    const entries = await store.entries();
    const recovery = typeof store?.getRecovery === "function"
      ? await store.getRecovery()
      : null;
    const mechanical = await activeMechanicalCanaryStatus(
      control,
      entries,
      store,
      { getJobImpl },
    );
    if (
      control.status !== "canary_verified"
      || (
        recovery
          ? recovery.status !== "verified"
          : control.canary.status !== "verified"
      )
      || !mechanical.verified
    ) {
      throw codedError(
        "RESUME_ONLY_BACKFILL_CANARY_NOT_VERIFIED",
      );
    }
    control = {
      ...control,
      status: "running",
      updatedAt: new Date().toISOString(),
      release: {
        ...control.release,
        status: "running",
        armedAt: iso(now),
      },
    };
    await store.setControl(control);
    return publicStatus(control, store, {
      getJobImpl,
      queueStatsImpl,
    });
  });
}

export function resumeOnlyBackfillReleaseCapacity(queue) {
  const queued = Number(queue?.queued);
  const due = Number(queue?.due);
  const leased = Number(queue?.leased);
  if (
    ![queued, due, leased].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    throw codedError("RESUME_ONLY_BACKFILL_QUEUE_INVALID");
  }
  if (leased >= 5) return 0;
  return Math.max(
    0,
    Math.min(
      RESUME_ONLY_BACKFILL_RELEASE_BATCH,
      200 - queued,
      10 - due,
    ),
  );
}

export async function runResumeOnlyBackfillReleaseTick({
  now = Date.now(),
  store = resumeOnlyBackfillRedisStore,
  lockImpl = withResumeOnlyBackfillLock,
  getJobImpl = getJob,
  getResumeImpl = getResume,
  saveJobImpl = saveJob,
  enqueueImpl = enqueueAutoJob,
  terminalPreflightImpl = resumeOnlyBackfillTerminalPreflight,
  targetMembershipSnapshotImpl =
    readResumeOnlyBackfillTargetMembershipSnapshot,
  queueStatsImpl = getAutoQueueStats,
  config = automationConfig(),
} = {}) {
  return lockImpl(async () => {
    let control = await store.getControl();
    if (!control || control.status !== "running") {
      return publicStatus(control, store, {
        getJobImpl,
        queueStatsImpl,
      });
    }
    const queue = await queueStatsImpl();
    const capacity = resumeOnlyBackfillReleaseCapacity(queue);
    if (capacity < 1) {
      return {
        ...await publicStatus(control, store, {
          getJobImpl,
          queueStatsImpl,
        }),
        throttled: true,
      };
    }
    const recovery = typeof store?.getRecovery === "function"
      ? await store.getRecovery()
      : null;
    const canaryIds = new Set([
      ...control.canary.ids,
      ...(recovery?.active || []).map((entry) => entry.id),
    ]);
    const runTerminalPreflight =
      await bindResumeOnlyBackfillTerminalPreflight(
        terminalPreflightImpl,
        targetMembershipSnapshotImpl,
      );
    const candidates = (await store.entries())
      .filter((entry) => (
        entry.status === "eligible"
        && !canaryIds.has(entry.id)
      ))
      .sort((left, right) => (
        left.callAt.localeCompare(right.callAt)
        || left.id.localeCompare(right.id)
      ))
      .slice(0, capacity);
    if (!candidates.length) {
      control = {
        ...control,
        status: "complete",
        updatedAt: new Date().toISOString(),
        release: {
          ...control.release,
          status: "complete",
          completedAt: iso(now),
        },
      };
      await store.setControl(control);
      return publicStatus(control, store, {
        getJobImpl,
        queueStatsImpl,
      });
    }
    let authorized = 0;
    let excluded = 0;
    for (const entry of candidates) {
      const result = await authorizeEntry(
        entry,
        control,
        "remainder",
        store,
        {
          getJobImpl,
          getResumeImpl,
          saveJobImpl,
          enqueueImpl,
          terminalPreflightImpl: runTerminalPreflight,
          now,
          config,
        },
      );
      authorized += result.authorized ? 1 : 0;
      excluded += result.excluded ? 1 : 0;
    }
    control = {
      ...control,
      updatedAt: new Date().toISOString(),
      release: {
        ...control.release,
        authorized:
          Number(control.release.authorized || 0) + authorized,
        excluded:
          Number(control.release.excluded || 0) + excluded,
        batchOrdinal:
          Number(control.release.batchOrdinal || 0) + 1,
      },
    };
    await store.setControl(control);
    return {
      ...await publicStatus(control, store, {
        getJobImpl,
        queueStatsImpl,
      }),
      batch: {
        attempted: candidates.length,
        authorized,
        excluded,
      },
    };
  });
}

export async function resumeOnlyBackfillStatus({
  store = resumeOnlyBackfillRedisStore,
  getJobImpl = getJob,
  queueStatsImpl = getAutoQueueStats,
} = {}) {
  return publicStatus(
    await store.getControl(),
    store,
    {
      getJobImpl,
      queueStatsImpl,
    },
  );
}
