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
  fetchCall,
  findResumeUri,
  getResume,
  trpcGet,
} from "./core.mjs";
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
  const canary = await mechanicalCanaryStatus(
    control,
    entries,
    { getJobImpl },
  );
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
  const jobs = await Promise.all(ids.map((id) => getJobImpl(id)));
  const failureSteps = jobs.flatMap((job) => (
    Object.entries(job?.automation?.stepFailures || {})
      .map(([step, failure]) => (
        `${publicCanaryDiagnosticStep(step)}:${safeReason(
          publicCanaryDiagnosticCode(failure?.code),
        )}`
      ))
  ));
  return {
    ok: true,
    status: control.status,
    canaryStatus: control.canary.status,
    selected: ids.length,
    states: aggregateDiagnosticTokens(
      jobs.map((job) => publicCanaryDiagnosticState(job?.state)),
    ),
    errorCodes: aggregateDiagnosticTokens(
      jobs.map(canaryDiagnosticCode),
    ),
    failureSteps: aggregateDiagnosticTokens(failureSteps),
    classifications: aggregateDiagnosticTokens(
      jobs.map((job) => canaryRecoveryClassification(
        job,
        control.manifestDigest,
      )),
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
      control = await finishPlan(control, store, {
        getJobImpl,
        advanceExistingImpl,
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
  if (stamped) {
    const queued = await enqueueImpl(entry.id, {
      source: "authorized_backfill",
      eventId:
        `resume-only:${control.manifestDigest}:${entry.id}`,
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
      `resume-only:${control.manifestDigest}:${entry.id}`,
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
    const mechanical = await mechanicalCanaryStatus(
      control,
      entries,
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
    control = {
      ...control,
      status: "canary_verified",
      updatedAt: new Date().toISOString(),
      canary: {
        ...control.canary,
        status: "verified",
        verifiedAt: new Date().toISOString(),
      },
    };
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
    const mechanical = await mechanicalCanaryStatus(
      control,
      entries,
      { getJobImpl },
    );
    if (
      control.status !== "canary_verified"
      || control.canary.status !== "verified"
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
    const canaryIds = new Set(control.canary.ids);
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
