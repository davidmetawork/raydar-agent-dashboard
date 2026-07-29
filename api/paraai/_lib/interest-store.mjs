import { createHash, randomUUID } from "node:crypto";

// State for the curated-list interest lane. Conventions follow
// outreach-store.mjs: private KV, hashed candidate keys (never PII), optimistic
// revisions, permanent submission claims, per-candidate leases.
//
// Plan: docs/PLAN-CURATED-INTEREST-TO-SUBMISSION-2026-07-28.md (main repo)

const INDEX_KEY = "paraai:interest:index";
const JOB_INDEX_KEY = "paraai:interest:job:index";
const SWEEP_KEY = "paraai:interest:sweep";
const REVIEW_INDEX_KEY = "paraai:interest:review:index";
const SNAP_TTL_SECONDS = 730 * 24 * 60 * 60;
const JOB_TTL_SECONDS = 180 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 150;
const REVIEW_TTL_SECONDS = 730 * 24 * 60 * 60;

const KV_URL = String(
  process.env.PARAAI_INTEREST_KV_REST_API_URL
  || process.env.PARAAI_OUTREACH_KV_REST_API_URL
  || process.env.KV_REST_API_URL
  || "",
).replace(/\/+$/, "");
const KV_TOKEN = process.env.PARAAI_INTEREST_KV_REST_API_TOKEN
  || process.env.PARAAI_OUTREACH_KV_REST_API_TOKEN
  || process.env.KV_REST_API_TOKEN
  || "";

const parse = (value, fallback = null) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

export const storeConfigured = () => Boolean(KV_URL && KV_TOKEN);

async function request(path, body) {
  if (!storeConfigured()) {
    const error = new Error("Para AI interest state store not configured");
    error.code = "INTEREST_NOT_CONFIGURED";
    throw error;
  }
  const response = await fetch(`${KV_URL}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KV_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  const raw = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  if (!response.ok) {
    const detail = String(parsed?.error || parsed?.message || raw || "request rejected")
      .replace(/\s+/g, " ")
      .slice(0, 180);
    const error = new Error(`interest state store HTTP ${response.status}: ${detail}`);
    error.code = "INTEREST_STORE_REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
  return parsed;
}

async function kv(args) {
  const body = await request("", args);
  if (body?.error) {
    const error = new Error(String(body.error));
    error.code = "INTEREST_STORE_COMMAND_FAILED";
    throw error;
  }
  return body?.result ?? null;
}

export async function probeInterestStore({ kvImpl = kv } = {}) {
  const nonce = randomUUID();
  const key = `paraai:interest:canary:${nonce}`;
  const value = `v1:${nonce}`;
  const set = await kvImpl(["SET", key, value, "EX", 60]);
  const read = await kvImpl(["GET", key]);
  const removed = await kvImpl(["DEL", key]);
  if (set !== "OK" || read !== value || Number(removed) !== 1) {
    const error = new Error("interest state-store canary did not read back");
    error.code = "INTEREST_STORE_CANARY_FAILED";
    throw error;
  }
  return { ok: true, write: true, read: true, cleanup: true };
}

export function interestCandidateHash(candidateUserId) {
  const value = String(candidateUserId || "").trim();
  if (!value) throw new Error("candidateUserId required");
  return createHash("sha256")
    .update("paraai-interest-candidate")
    .update("\0")
    .update(value)
    .digest("hex");
}

const snapKey = (cuid) => `paraai:interest:snap:${interestCandidateHash(cuid)}`;
const jobKey = (cuid) => `paraai:interest:job:${interestCandidateHash(cuid)}`;
const lockKey = (cuid) => `paraai:interest:lock:${interestCandidateHash(cuid)}`;
const reviewKey = (cuid) => `paraai:interest:review:${interestCandidateHash(cuid)}`;

// Submission claims are per (candidate, role) and PERMANENT. They are never
// released: a claim means "this lane has committed to submitting this candidate
// to this role", and a timeout may have landed.
export const claimKey = (cuid, roleId) =>
  `paraai:interest:claim:${interestCandidateHash(cuid)}:${String(roleId || "").trim()}`;

// Email outbox is claim-before-send, keyed by the batch so a rebuilt job can
// never re-send.
export const outboxKey = (cuid, batchId) =>
  `paraai:interest:outbox:${interestCandidateHash(cuid)}:${String(batchId || "").trim()}`;

export function appendJournal(state, event, detail = {}) {
  const at = new Date().toISOString();
  return {
    ...state,
    updatedAt: at,
    journal: [...(state?.journal || []), { at, event: String(event || "updated"), ...detail }].slice(-200),
  };
}

/* ---------------------------------------------------------------- snapshots */

export async function getSnapshot(candidateUserId, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", snapKey(candidateUserId)]), null);
}

export async function putSnapshot(candidateUserId, statuses, { kvImpl = kv, seeded = false } = {}) {
  const prior = await getSnapshot(candidateUserId, { kvImpl });
  const next = {
    version: 1,
    candidateUserId,
    statuses: statuses && typeof statuses === "object" ? statuses : {},
    seededAt: prior?.seededAt || (seeded ? new Date().toISOString() : null),
    revision: Number(prior?.revision || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  await kvImpl(["SET", snapKey(candidateUserId), JSON.stringify(next), "EX", SNAP_TTL_SECONDS]);
  await kvImpl(["SADD", INDEX_KEY, interestCandidateHash(candidateUserId)]);
  return next;
}

/**
 * The whole detection rule, isolated and pure so it is testable without KV.
 *
 * Acts ONLY on PENDING -> APPLIED_TO_ROLE. A candidate seen for the first time
 * is seeded and never acted on, which is what makes arming forward-only.
 */
export function diffInterest(prior, current) {
  const priorStatuses = prior?.statuses || null;
  const seen = Boolean(prior);
  const newlyInterested = [];
  const declined = [];
  for (const [roleId, status] of Object.entries(current || {})) {
    const before = priorStatuses ? priorStatuses[roleId] : undefined;
    if (status === "APPLIED_TO_ROLE" && seen && before && before !== "APPLIED_TO_ROLE") {
      newlyInterested.push(roleId);
    }
    if (status === "NOT_INTERESTED" && seen && before && before !== "NOT_INTERESTED") {
      declined.push(roleId);
    }
  }
  return { firstSight: !seen, newlyInterested, declined };
}

/* --------------------------------------------------------------------- jobs */

export async function getJob(candidateUserId, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", jobKey(candidateUserId)]), null);
}

export async function saveJob(job, { kvImpl = kv } = {}) {
  if (!job?.candidateUserId) throw new Error("job.candidateUserId required");
  const next = { ...job, updatedAt: new Date().toISOString() };
  await kvImpl(["SET", jobKey(job.candidateUserId), JSON.stringify(next), "EX", JOB_TTL_SECONDS]);
  await kvImpl([
    next.stage === "done" ? "SREM" : "SADD",
    JOB_INDEX_KEY,
    interestCandidateHash(job.candidateUserId),
  ]);
  return next;
}

export async function createJob(candidateUserId, seed = {}, { kvImpl = kv } = {}) {
  const now = new Date().toISOString();
  const job = appendJournal({
    version: 1,
    candidateUserId,
    batchId: seed.batchId || randomUUID(),
    stage: "detected",
    roles: seed.roles || [],
    stopped: null,
    emailed: null,
    submissions: {},
    createdAt: now,
    journal: [],
    ...seed,
  }, "detected", { roles: (seed.roles || []).length });
  return saveJob(job, { kvImpl });
}

export async function listPendingJobs(limit = 100, { kvImpl = kv } = {}) {
  const hashes = (await kvImpl(["SMEMBERS", JOB_INDEX_KEY])) || [];
  const out = [];
  for (const hash of hashes.slice(0, Math.max(1, Number(limit) || 100))) {
    const job = parse(
      await kvImpl(["GET", `paraai:interest:job:${hash}`]),
      null,
    );
    if (job && job.stage !== "done") out.push(job);
    else await kvImpl(["SREM", JOB_INDEX_KEY, hash]);
  }
  return out;
}

/* ------------------------------------------------------------------- claims */

/**
 * Permanent per-(candidate, role) submission claim.
 *
 * The stored attempt id is a fencing token. Every later state change must
 * present it, which prevents a stale worker from overwriting the winner's
 * outcome after losing a race. Claims are intentionally never released:
 * once an external mutation may have started, recovery is read-only.
 */
export async function claimSubmission(candidateUserId, roleId, detail = {}, { kvImpl = kv } = {}) {
  const claim = {
    version: 2,
    claimedAt: new Date().toISOString(),
    attemptId: randomUUID(),
    state: "claimed",
    ...detail,
  };
  const payload = JSON.stringify(claim);
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if raw then return {0, raw} end
    redis.call('SET', KEYS[1], ARGV[1], 'NX')
    return {1, ARGV[1]}
  `;
  const result = await kvImpl([
    "EVAL", script, 1, claimKey(candidateUserId, roleId), payload,
  ]);
  const code = Number(result?.[0]);
  const stored = parse(result?.[1], null);
  if (![0, 1].includes(code) || !stored?.attemptId) {
    throw new Error("interest submission claim failed");
  }
  return {
    status: code === 1 ? "claimed" : "existing",
    claim: stored,
  };
}

export async function getSubmissionClaim(candidateUserId, roleId, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", claimKey(candidateUserId, roleId)]), null);
}

function submissionClaimError(code, claim = null) {
  const errors = new Map([
    [-1, ["SUBMISSION_CLAIM_NOT_FOUND", "interest submission claim not found"]],
    [-2, ["SUBMISSION_CLAIM_CONFLICT", "interest submission attempt does not own claim"]],
    [-3, ["SUBMISSION_ATTEMPT_NOT_STARTED", "interest submission attempt has not started"]],
    [-4, ["SUBMISSION_OUTCOME_CONFLICT", "interest submission outcome cannot change terminal state"]],
  ]);
  const [errorCode, message] = errors.get(Number(code)) || [
    "SUBMISSION_CLAIM_UPDATE_FAILED",
    "interest submission claim update failed",
  ];
  const error = new Error(message);
  error.code = errorCode;
  error.claim = claim;
  return error;
}

export async function startSubmissionAttempt(
  candidateUserId,
  roleId,
  attemptId,
  { kvImpl = kv } = {},
) {
  const attempt = String(attemptId || "").trim();
  if (!attempt) throw new Error("attemptId required");
  const startedAt = new Date().toISOString();
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return {-1, ''} end
    local claim = cjson.decode(raw)
    if claim.attemptId ~= ARGV[1] then return {-2, raw} end
    if claim.attemptStartedAt then return {2, raw} end
    claim.attemptStartedAt = ARGV[2]
    claim.state = 'attempt_started'
    local next = cjson.encode(claim)
    redis.call('SET', KEYS[1], next)
    return {1, next}
  `;
  const result = await kvImpl([
    "EVAL", script, 1, claimKey(candidateUserId, roleId), attempt, startedAt,
  ]);
  const code = Number(result?.[0]);
  const claim = parse(result?.[1], null);
  if (code < 0 || ![1, 2].includes(code) || !claim) throw submissionClaimError(code, claim);
  return {
    status: code === 1 ? "started" : "already_started",
    claim,
  };
}

export async function recordSubmissionPrepared(
  candidateUserId,
  roleId,
  attemptId,
  candidateToApprovedRoleId,
  { kvImpl = kv } = {},
) {
  const attempt = String(attemptId || "").trim();
  const preparedId = String(candidateToApprovedRoleId || "").trim();
  if (!attempt) throw new Error("attemptId required");
  if (!preparedId) throw new Error("candidateToApprovedRoleId required");
  const preparedAt = new Date().toISOString();
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return {-1, ''} end
    local claim = cjson.decode(raw)
    if claim.attemptId ~= ARGV[1] then return {-2, raw} end
    if not claim.attemptStartedAt then return {-3, raw} end
    if claim.candidateToApprovedRoleId then
      if claim.candidateToApprovedRoleId == ARGV[2] then return {2, raw} end
      return {-4, raw}
    end
    if claim.outcome then return {-4, raw} end
    claim.candidateToApprovedRoleId = ARGV[2]
    claim.preparedAt = ARGV[3]
    claim.state = 'prepared'
    local next = cjson.encode(claim)
    redis.call('SET', KEYS[1], next)
    return {1, next}
  `;
  const result = await kvImpl([
    "EVAL", script, 1, claimKey(candidateUserId, roleId),
    attempt, preparedId, preparedAt,
  ]);
  const code = Number(result?.[0]);
  const claim = parse(result?.[1], null);
  if (code < 0 || ![1, 2].includes(code) || !claim) throw submissionClaimError(code, claim);
  return {
    status: code === 1 ? "prepared" : "already_prepared",
    claim,
  };
}

const SUBMISSION_OUTCOMES = new Set([
  "contract_unconfirmed",
  "submission_unknown",
  "accepted",
  "verified",
]);

export async function recordSubmissionOutcome(
  candidateUserId,
  roleId,
  outcome,
  { attemptId, detail = "", kvImpl = kv } = {},
) {
  const attempt = String(attemptId || "").trim();
  const nextOutcome = String(outcome || "").trim();
  if (!attempt) throw new Error("attemptId required");
  if (!SUBMISSION_OUTCOMES.has(nextOutcome)) throw new Error("valid submission outcome required");
  const outcomeAt = new Date().toISOString();
  const safeDetail = String(detail || "").slice(0, 240);
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return {-1, ''} end
    local claim = cjson.decode(raw)
    if claim.attemptId ~= ARGV[1] then return {-2, raw} end
    if not claim.attemptStartedAt then return {-3, raw} end
    local current = claim.outcome
    local nextOutcome = ARGV[2]
    if current == nextOutcome then return {2, raw} end
    local advanced = nextOutcome == 'verified'
      and (current == 'accepted' or current == 'submission_unknown')
    if current and not advanced then return {-4, raw} end
    claim.outcome = nextOutcome
    claim.outcomeAt = ARGV[3]
    claim.state = nextOutcome
    if ARGV[4] ~= '' then claim.detail = ARGV[4] end
    local next = cjson.encode(claim)
    redis.call('SET', KEYS[1], next)
    return {advanced and 3 or 1, next}
  `;
  const result = await kvImpl([
    "EVAL", script, 1, claimKey(candidateUserId, roleId),
    attempt, nextOutcome, outcomeAt, safeDetail,
  ]);
  const code = Number(result?.[0]);
  const claim = parse(result?.[1], null);
  if (code < 0 || ![1, 2, 3].includes(code) || !claim) {
    throw submissionClaimError(code, claim);
  }
  return {
    status: code === 1 ? "recorded" : code === 2 ? "existing" : "advanced",
    claim,
  };
}

/* ------------------------------------------------------------------- outbox */

export async function claimEmail(candidateUserId, batchId, detail = {}, { kvImpl = kv } = {}) {
  const payload = JSON.stringify({ claimedAt: new Date().toISOString(), ...detail });
  const res = await kvImpl(["SET", outboxKey(candidateUserId, batchId), payload, "NX"]);
  return res === "OK" || res === true;
}

export async function confirmEmail(candidateUserId, batchId, detail = {}, { kvImpl = kv } = {}) {
  const prior = parse(await kvImpl(["GET", outboxKey(candidateUserId, batchId)]), {}) || {};
  const next = { ...prior, deliveredAt: new Date().toISOString(), ...detail };
  await kvImpl(["SET", outboxKey(candidateUserId, batchId), JSON.stringify(next)]);
  return next;
}

export async function getEmailClaim(candidateUserId, batchId, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", outboxKey(candidateUserId, batchId)]), null);
}

/* -------------------------------------------------------------------- locks */

export async function acquireLock(candidateUserId, { kvImpl = kv, ttlSeconds = LOCK_TTL_SECONDS } = {}) {
  const token = randomUUID();
  const res = await kvImpl(["SET", lockKey(candidateUserId), token, "NX", "EX", ttlSeconds]);
  return res === "OK" || res === true ? token : null;
}

export async function releaseLock(candidateUserId, token, { kvImpl = kv } = {}) {
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  return Number(await kvImpl([
    "EVAL", script, 1, lockKey(candidateUserId), String(token || ""),
  ])) === 1;
}

/* ------------------------------------------------------------------- review */

export async function recordReview(candidateUserId, reasons, detail = {}, { kvImpl = kv } = {}) {
  const prior = parse(await kvImpl(["GET", reviewKey(candidateUserId)]), null);
  const merged = [...new Set([...(prior?.reasons || []), ...(Array.isArray(reasons) ? reasons : [reasons])])];
  const card = {
    version: 1,
    candidateUserId,
    reasons: merged,
    state: "needs_review",
    createdAt: prior?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...detail,
  };
  await kvImpl(["SET", reviewKey(candidateUserId), JSON.stringify(card), "EX", REVIEW_TTL_SECONDS]);
  await kvImpl(["SADD", REVIEW_INDEX_KEY, interestCandidateHash(candidateUserId)]);
  return card;
}

export async function resolveReview(candidateUserId, { kvImpl = kv } = {}) {
  await kvImpl(["DEL", reviewKey(candidateUserId)]);
  await kvImpl(["SREM", REVIEW_INDEX_KEY, interestCandidateHash(candidateUserId)]);
}

export async function listReviews(limit = 200, { kvImpl = kv } = {}) {
  const hashes = (await kvImpl(["SMEMBERS", REVIEW_INDEX_KEY])) || [];
  const out = [];
  for (const h of hashes.slice(0, limit)) {
    const card = parse(await kvImpl(["GET", `paraai:interest:review:${h}`]), null);
    if (card) out.push(card);
  }
  return out;
}

/* -------------------------------------------------------------------- sweep */

export async function getSweepState({ kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", SWEEP_KEY]), null);
}

export async function recordSweep(result, { kvImpl = kv } = {}) {
  const next = { version: 1, ...result, at: new Date().toISOString() };
  await kvImpl(["SET", SWEEP_KEY, JSON.stringify(next)]);
  return next;
}

export { kv as interestKv };
