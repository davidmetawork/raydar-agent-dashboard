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
const HANDOFF_INDEX_KEY = "paraai:interest:handoff:index";
const POST_CALL_OUTBOX_INDEX_KEY = "paraai:interest:post-call-outbox:index";
const SNAP_TTL_SECONDS = 730 * 24 * 60 * 60;
const JOB_TTL_SECONDS = 180 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 150;
const REVIEW_TTL_SECONDS = 730 * 24 * 60 * 60;
const HANDOFF_TTL_SECONDS = 730 * 24 * 60 * 60;
const POST_CALL_OUTBOX_TTL_SECONDS = 730 * 24 * 60 * 60;
const TERMINAL_JOB_STAGES = new Set(["done", "awaiting_human_submission"]);

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

async function kvPipeline(commands) {
  if (!commands.length) return [];
  const body = await request("/pipeline", commands);
  if (!Array.isArray(body)) throw new Error("interest state store pipeline failed");
  return body.map((item) => {
    if (item?.error) throw new Error(String(item.error));
    return item?.result ?? null;
  });
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
const handoffBatchHash = (batchId) => {
  const value = String(batchId || "").trim();
  if (!value || value.length > 200) throw new Error("batchId required");
  return createHash("sha256")
    .update("paraai-interest-handoff-batch")
    .update("\0")
    .update(value)
    .digest("hex");
};
const handoffIndexMember = (cuid, batchId) =>
  `${interestCandidateHash(cuid)}:${handoffBatchHash(batchId)}`;
const handoffKeyFromMember = (member) =>
  `paraai:interest:handoff:${String(member || "")}`;
const handoffKey = (cuid, batchId) =>
  handoffKeyFromMember(handoffIndexMember(cuid, batchId));

function postCallIdentifier(value, field, maximum = 256) {
  const selected = String(value || "").trim();
  if (
    !selected
    || selected.length > maximum
    || !/^[A-Za-z0-9._-]+$/u.test(selected)
  ) {
    const error = new Error(`${field} invalid`);
    error.code = "POST_CALL_INTEREST_ID_INVALID";
    throw error;
  }
  return selected;
}

function postCallInstant(value) {
  const selected = String(value || "").trim();
  const milliseconds = Date.parse(selected);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== selected
  ) {
    const error = new Error("occurredAt invalid");
    error.code = "POST_CALL_INTEREST_OCCURRED_AT_INVALID";
    throw error;
  }
  return selected;
}

export function postCallInterestEventKey(candidateUserId, batchId, roleId) {
  return [
    "curated-interest",
    postCallIdentifier(candidateUserId, "candidateUserId"),
    postCallIdentifier(batchId, "batchId", 200),
    postCallIdentifier(roleId, "roleId"),
  ].join(":");
}

function postCallOutboxHash(eventKey) {
  return createHash("sha256")
    .update("paraai-post-call-interest-outbox")
    .update("\0")
    .update(eventKey)
    .digest("hex");
}

const postCallOutboxKeyFromHash = (hash) =>
  `paraai:interest:post-call-outbox:${String(hash || "")}`;

function postCallOutboxKey(eventKey) {
  return postCallOutboxKeyFromHash(postCallOutboxHash(eventKey));
}

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

export async function listInterestSnapshots(
  candidateUserIds,
  { pipelineImpl = kvPipeline } = {},
) {
  const ids = [...new Set((Array.isArray(candidateUserIds) ? candidateUserIds : [])
    .map((value) => String(value || "").trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const values = await pipelineImpl(ids.map((id) => ["GET", snapKey(id)]));
  return new Map(ids.map((id, index) => [id, parse(values[index], null)]));
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

/* ------------------------------------------------------- post-call outbox */

function normalizePostCallInterestEvent({
  candidateUserId,
  batchId,
  roleId,
  occurredAt,
} = {}) {
  const candidate = postCallIdentifier(candidateUserId, "candidateUserId");
  const batch = postCallIdentifier(batchId, "batchId", 200);
  const role = postCallIdentifier(roleId, "roleId");
  return Object.freeze({
    eventKey: postCallInterestEventKey(candidate, batch, role),
    candidateUserId: candidate,
    batchId: batch,
    roleId: role,
    occurredAt: postCallInstant(occurredAt),
  });
}

/**
 * Persist one PENDING -> APPLIED_TO_ROLE transition before its source snapshot
 * advances. The KV key and index member are hashes; the record contains only
 * opaque Paraform ids and no candidate contact data.
 */
export async function recordPostCallInterestEvent(input, { kvImpl = kv } = {}) {
  const event = normalizePostCallInterestEvent(input);
  const key = postCallOutboxKey(event.eventKey);
  const now = new Date().toISOString();
  const pending = {
    version: 1,
    state: "pending",
    ...event,
    attempts: 0,
    lastAttemptAt: null,
    lastErrorCode: null,
    deliveredAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const created = await kvImpl([
    "SET",
    key,
    JSON.stringify(pending),
    "NX",
    "EX",
    POST_CALL_OUTBOX_TTL_SECONDS,
  ]);
  const stored = created === "OK" || created === true
    ? pending
    : parse(await kvImpl(["GET", key]), null);
  if (
    !stored
    || stored.version !== 1
    || stored.eventKey !== event.eventKey
    || stored.candidateUserId !== event.candidateUserId
    || stored.batchId !== event.batchId
    || stored.roleId !== event.roleId
    || !["pending", "delivered"].includes(stored.state)
  ) {
    const error = new Error("post-call interest outbox conflict");
    error.code = "POST_CALL_INTEREST_OUTBOX_CONFLICT";
    throw error;
  }
  // The first durable occurrence timestamp wins. Retries reuse that exact body,
  // even when a source sweep reaches the same transition at a later wall clock.
  postCallInstant(stored.occurredAt);
  if (stored.state === "pending") {
    await kvImpl([
      "SADD",
      POST_CALL_OUTBOX_INDEX_KEY,
      postCallOutboxHash(event.eventKey),
    ]);
  }
  return Object.freeze({ created: created === "OK" || created === true, record: stored });
}

export async function listPendingPostCallInterestEvents(
  limit = 50,
  { kvImpl = kv } = {},
) {
  const selectedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const hashes = (await kvImpl(["SMEMBERS", POST_CALL_OUTBOX_INDEX_KEY])) || [];
  const pending = [];
  for (const hash of hashes.slice(0, selectedLimit)) {
    if (!/^[a-f0-9]{64}$/u.test(String(hash || ""))) {
      await kvImpl(["SREM", POST_CALL_OUTBOX_INDEX_KEY, hash]);
      continue;
    }
    const record = parse(
      await kvImpl(["GET", postCallOutboxKeyFromHash(hash)]),
      null,
    );
    if (
      record?.state === "pending"
      && postCallOutboxHash(String(record.eventKey || "")) === hash
    ) {
      pending.push(record);
    } else {
      await kvImpl(["SREM", POST_CALL_OUTBOX_INDEX_KEY, hash]);
    }
  }
  return pending;
}

export async function settlePostCallInterestEvent(
  eventKey,
  {
    delivered,
    responseEventKey = null,
    statusCode = null,
    errorCode = null,
  } = {},
  { kvImpl = kv } = {},
) {
  const selectedEventKey = String(eventKey || "").trim();
  const key = postCallOutboxKey(selectedEventKey);
  const current = parse(await kvImpl(["GET", key]), null);
  if (
    !current
    || current.eventKey !== selectedEventKey
    || !["pending", "delivered"].includes(current.state)
  ) {
    const error = new Error("post-call interest outbox record missing");
    error.code = "POST_CALL_INTEREST_OUTBOX_MISSING";
    throw error;
  }
  if (delivered === true && responseEventKey !== selectedEventKey) {
    const error = new Error("post-call interest delivery identity mismatch");
    error.code = "POST_CALL_INTEREST_DELIVERY_MISMATCH";
    throw error;
  }
  if (current.state === "delivered") return current;
  const now = new Date().toISOString();
  const next = {
    ...current,
    state: delivered === true ? "delivered" : "pending",
    attempts: Math.max(0, Number(current.attempts) || 0) + 1,
    lastAttemptAt: now,
    lastErrorCode: delivered === true
      ? null
      : String(errorCode || "POST_CALL_INTEREST_DELIVERY_FAILED").slice(0, 120),
    deliveredAt: delivered === true ? now : null,
    statusCode: Number.isInteger(statusCode) ? statusCode : null,
    updatedAt: now,
  };
  const written = await kvImpl([
    "SET",
    key,
    JSON.stringify(next),
    "XX",
    "EX",
    POST_CALL_OUTBOX_TTL_SECONDS,
  ]);
  if (written !== "OK" && written !== true) {
    const error = new Error("post-call interest outbox settlement failed");
    error.code = "POST_CALL_INTEREST_OUTBOX_SETTLEMENT_FAILED";
    throw error;
  }
  if (next.state === "delivered") {
    await kvImpl([
      "SREM",
      POST_CALL_OUTBOX_INDEX_KEY,
      postCallOutboxHash(selectedEventKey),
    ]);
  }
  return next;
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
    TERMINAL_JOB_STAGES.has(next.stage) ? "SREM" : "SADD",
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
    if (job && !TERMINAL_JOB_STAGES.has(job.stage)) out.push(job);
    else await kvImpl(["SREM", JOB_INDEX_KEY, hash]);
  }
  return out;
}

/* ----------------------------------------------------------------- handoff */

const boundedStrings = (values, limit = 100) => [...new Set(
  (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean),
)].slice(0, limit);
const boundedReasonCodes = (values, limit = 100) => [...new Set(
  boundedStrings(values, limit)
    .map((value) => value.toLowerCase())
    .filter((value) => /^[a-z][a-z0-9._:-]{0,127}$/u.test(value)),
)];

/**
 * Minimal durable terminal record. It preserves one organic transition after
 * the per-candidate processing slot is replaced, without copying candidate
 * contact data, transcript evidence, generated prose, or provider payloads.
 */
export function projectInterestHandoff(candidateUserId, job = {}, reasons = []) {
  const batchId = String(job?.batchId || "").trim();
  handoffBatchHash(batchId);
  const submissions = (Array.isArray(job?.submissions) ? job.submissions : [])
    .map((submission) => ({
      roleId: String(submission?.roleId || "").trim(),
      stage: String(submission?.stage || "").trim() || null,
      blockers: boundedReasonCodes(submission?.blockers, 50),
    }))
    .filter((submission) => submission.roleId)
    .slice(0, 100);
  const selectedReasons = boundedReasonCodes(reasons, 100);
  const human = selectedReasons.includes("human_submission_required");
  const shadow = selectedReasons.includes("shadow_would_submit");
  return {
    version: 1,
    state: "open",
    candidateUserId: String(candidateUserId || "").trim(),
    candidateId: String(job?.candidateId || "").trim() || null,
    batchId,
    mode: human
      ? "human_submission_required"
      : shadow
        ? "shadow_observation"
        : "manual_review",
    reasons: selectedReasons,
    roles: boundedStrings(job?.roles, 100),
    submissions,
    stopped: {
      paused: Math.max(0, Number(job?.stopped?.paused) || 0),
      alreadyPaused: Math.max(0, Number(job?.stopped?.alreadyPaused) || 0),
    },
    emailed: {
      sent: job?.emailed?.sent === true,
      skipped: String(job?.emailed?.skipped || "").trim() || null,
      canary: job?.emailed?.canary === true,
    },
    rolloutPhase: String(job?.rolloutPhase || "").trim() || null,
    createdAt: job?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function recordInterestHandoff(
  candidateUserId,
  job,
  reasons,
  { kvImpl = kv } = {},
) {
  const projected = projectInterestHandoff(candidateUserId, job, reasons);
  if (!projected.candidateUserId) throw new Error("candidateUserId required");
  const key = handoffKey(projected.candidateUserId, projected.batchId);
  const created = await kvImpl([
    "SET",
    key,
    JSON.stringify(projected),
    "NX",
    "EX",
    HANDOFF_TTL_SECONDS,
  ]);
  const stored = created === "OK" || created === true
    ? projected
    : parse(await kvImpl(["GET", key]), null);
  if (
    !stored
    || stored.candidateUserId !== projected.candidateUserId
    || stored.batchId !== projected.batchId
    || ![undefined, "open", "resolved"].includes(stored.state)
  ) {
    const error = new Error("interest handoff archive conflict");
    error.code = "INTEREST_HANDOFF_CONFLICT";
    throw error;
  }
  // Resolution is a permanent tombstone. A stale worker may retry after the
  // human has cleared a card, but can never resurrect that exact batch.
  if (stored.state === "resolved") return stored;
  await kvImpl([
    "SADD",
    HANDOFF_INDEX_KEY,
    handoffIndexMember(projected.candidateUserId, projected.batchId),
  ]);
  return stored;
}

export async function listInterestHandoffRecords(
  limit = 200,
  { kvImpl = kv } = {},
) {
  const members = (await kvImpl(["SMEMBERS", HANDOFF_INDEX_KEY])) || [];
  const out = [];
  for (const member of members) {
    if (!/^[a-f0-9]{64}:[a-f0-9]{64}$/u.test(String(member || ""))) {
      await kvImpl(["SREM", HANDOFF_INDEX_KEY, member]);
      continue;
    }
    const record = parse(
      await kvImpl(["GET", handoffKeyFromMember(member)]),
      null,
    );
    if (
      record?.candidateUserId
      && record?.batchId
      && [undefined, "open"].includes(record.state)
    ) {
      out.push(record);
    } else {
      await kvImpl(["SREM", HANDOFF_INDEX_KEY, member]);
    }
  }
  return out
    .sort((left, right) => (
      (Date.parse(right?.updatedAt || "") || 0)
      - (Date.parse(left?.updatedAt || "") || 0)
    ))
    .slice(0, Math.max(1, Number(limit) || 200));
}

export async function resolveInterestHandoff(
  candidateUserId,
  batchId,
  { kvImpl = kv } = {},
) {
  const member = handoffIndexMember(candidateUserId, batchId);
  const key = handoffKeyFromMember(member);
  const prior = parse(await kvImpl(["GET", key]), null);
  if (
    !prior
    || prior.candidateUserId !== String(candidateUserId || "").trim()
    || prior.batchId !== String(batchId || "").trim()
    || prior.state === "resolved"
  ) {
    await kvImpl(["SREM", HANDOFF_INDEX_KEY, member]);
    return false;
  }
  const tombstone = {
    version: 1,
    state: "resolved",
    candidateUserId: prior.candidateUserId,
    batchId: prior.batchId,
    resolvedAt: new Date().toISOString(),
  };
  await kvImpl([
    "SET",
    key,
    JSON.stringify(tombstone),
    "EX",
    HANDOFF_TTL_SECONDS,
  ]);
  await kvImpl(["SREM", HANDOFF_INDEX_KEY, member]);
  return true;
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

/**
 * Atomically create the permanent claim and mark its sole mutation attempt as
 * started. The executor calls this immediately before Paraform's prepare write,
 * removing the crash window between separate claim/start operations.
 */
export async function claimSubmissionAttempt(
  candidateUserId,
  roleId,
  detail = {},
  { kvImpl = kv } = {},
) {
  const claimedAt = new Date().toISOString();
  const claim = {
    version: 2,
    claimedAt,
    attemptId: randomUUID(),
    attemptStartedAt: claimedAt,
    state: "attempt_started",
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
    throw new Error("interest submission attempt claim failed");
  }
  return {
    status: code === 1 ? "started" : "existing",
    claim: stored,
  };
}

export async function getSubmissionClaim(candidateUserId, roleId, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", claimKey(candidateUserId, roleId)]), null);
}

/**
 * Human recovery for this tab's own Path B claim. The caller must first prove
 * from live Paraform reads that no application landed. The atomic delete here
 * then checks the exact attempt fencing token and lane; worker-owned or
 * verified claims can never be released through this function.
 */
export async function releaseSubmissionClaim(
  candidateUserId,
  roleId,
  attemptId,
  { lane = "submissions", kvImpl = kv } = {},
) {
  const attempt = String(attemptId || "").trim();
  const expectedLane = String(lane || "").trim();
  if (!attempt || !expectedLane) throw new Error("attemptId and lane required");
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return {0, ''} end
    local claim = cjson.decode(raw)
    if claim.attemptId ~= ARGV[1] then return {-1, raw} end
    if claim.lane ~= ARGV[2] then return {-2, raw} end
    if claim.outcome == 'accepted' or claim.outcome == 'verified' then return {-3, raw} end
    redis.call('DEL', KEYS[1])
    return {1, raw}
  `;
  const result = await kvImpl([
    "EVAL", script, 1, claimKey(candidateUserId, roleId), attempt, expectedLane,
  ]);
  const code = Number(result?.[0]);
  if (code === 0) return { released: false, reason: "not_found", claim: null };
  const claim = parse(result?.[1], null);
  if (code === 1) return { released: true, reason: null, claim };
  const error = new Error(code === -1
    ? "interest submission attempt does not own claim"
    : code === -2
      ? "interest submission claim belongs to another lane"
      : "verified interest submission claim cannot be released");
  error.code = code === -1
    ? "SUBMISSION_CLAIM_CONFLICT"
    : code === -2
      ? "SUBMISSION_CLAIM_LANE_CONFLICT"
      : "SUBMISSION_CLAIM_TERMINAL";
  error.claim = claim;
  throw error;
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
