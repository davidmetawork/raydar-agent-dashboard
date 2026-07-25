// Durable, single-writer Para AI job journal in the dashboard's existing
// Upstash/Vercel KV. Candidate PII lives only in the private runtime store.

import { createHash, randomUUID } from "node:crypto";

const KV_URL = String(process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";
const INDEX_KEY = "paraai:index";
const JOB_TTL_SECONDS = 180 * 24 * 60 * 60;
const JOB_LOCK_TTL_SECONDS = 150;
const LEGACY_JOB_LOCK_TTL_SECONDS = 330;
const LEGACY_JOB_LOCK_STALE_AFTER_SECONDS = 120;
const AUTO_EVENT_TTL_SECONDS = 14 * 24 * 60 * 60;
const AUTO_META_TTL_SECONDS = JOB_TTL_SECONDS;
const AUTO_LEASE_MS = 150_000;
const AUTO_DUE_KEY = "paraai:auto:due";
const AUTO_LEASES_KEY = "paraai:auto:leases";
const AUTO_META_PREFIX = "paraai:auto:meta:";
const RESUME_WAITING_KEY = "paraai:resume-waiting";
const RESUME_BACKFILL_ANCHOR_KEY =
  "paraai:resume-backfill-anchor:v1";
const RESUME_ASK_PREFIX = "paraai:resume-ask:v2:";
const RESUME_SATISFACTION_PREFIX = "paraai:resume-satisfied:v1:";
const RESUME_CURRENT_CHAIN_PREFIX = "paraai:resume-current-chain:v1:";
const RESUME_ATTACHED_SIGNAL_PREFIX = "paraai:resume-attached-signal:";
const RESUME_ATTACHED_SIGNAL_TTL_SECONDS = 15 * 60;
const PHASE2_FIRST_TEN_CANARY_KEY =
  "paraai:phase2:first-ten-canary:v1";
const PHASE2_FIRST_TEN_CANARY_MAX_JOBS = 10;
const PHASE2_FIRST_TEN_CANARY_INDEX_LIMIT = 500;
const PHASE2_FIRST_TEN_CANARY_LEASE_MS = 150_000;
const PHASE2_REMAINDER_KEY =
  "paraai:phase2:remainder-release:v1";
const PHASE2_REMAINDER_BATCH_MAX = 5;
const PHASE2_REMAINDER_LEASE_MS = 150_000;
const PHASE2_REMAINDER_QUEUE_TOTAL_LIMIT = 200;
const PHASE2_REMAINDER_QUEUE_DUE_LIMIT = 10;
const PHASE2_REMAINDER_QUEUE_LEASED_LIMIT = 5;
const jobKey = (id) => `paraai:job:${id}`;
const lockKey = (id) => `paraai:lock:${id}`;
const alertKey = (key) => `paraai:alert:${key}`;
const autoLeaseKey = (id) => `paraai:auto:lease:${id}`;
const autoMetaKey = (id) => `${AUTO_META_PREFIX}${id}`;
const autoEventKey = (id) => `paraai:auto:event:${storeHash("auto-event", id)}`;
const submissionClaimKey = (candidateUserId) => `paraai:submit-claim:${storeHash("candidate", candidateUserId)}`;
const resumeAskKey = (candidateUserId, chainId) => {
  const value = String(candidateUserId || "").trim();
  if (!value) throw new Error("candidateUserId required");
  const chain = requireResumeChaseChainId(chainId);
  return `${RESUME_ASK_PREFIX}${storeHash("paraai-candidate-v1", value)}:${chain}`;
};
const resumeSatisfactionKey = (candidateUserId) => {
  const value = String(candidateUserId || "").trim();
  if (!value) throw new Error("candidateUserId required");
  return `${RESUME_SATISFACTION_PREFIX}${storeHash("paraai-candidate-v1", value)}`;
};
const resumeCurrentChainKey = (candidateUserId) => {
  const value = String(candidateUserId || "").trim();
  if (!value) throw new Error("candidateUserId required");
  return `${RESUME_CURRENT_CHAIN_PREFIX}${storeHash("paraai-candidate-v1", value)}`;
};
const resumeAttachedSignalKey = (candidateUserId) => {
  const value = String(candidateUserId || "").trim();
  if (!value) throw new Error("candidateUserId required");
  return `${RESUME_ATTACHED_SIGNAL_PREFIX}${storeHash("paraai-candidate-v1", value)}`;
};

export const storeConfigured = () => Boolean(KV_URL && KV_TOKEN);

export async function getOrCreateResumeBackfillAnchor(
  { now = Date.now() } = {},
  { kvImpl = kv } = {},
) {
  const milliseconds = Number(now);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("valid backfill anchor timestamp required");
  }
  const proposed = JSON.stringify({
    version: 1,
    anchorAt: new Date(milliseconds).toISOString(),
  });
  const script = `
    local existing = redis.call('GET', KEYS[1])
    if existing then return existing end
    redis.call('SET', KEYS[1], ARGV[1])
    return ARGV[1]
  `;
  const raw = await kvImpl([
    "EVAL",
    script,
    1,
    RESUME_BACKFILL_ANCHOR_KEY,
    proposed,
  ]);
  const record = parse(raw, null);
  if (
    record?.version !== 1
    || !Number.isFinite(Date.parse(String(record?.anchorAt || "")))
  ) {
    throw new Error("durable backfill anchor is invalid");
  }
  return {
    version: 1,
    anchorAt: new Date(Date.parse(record.anchorAt)).toISOString(),
  };
}

async function request(path, body) {
  if (!storeConfigured()) throw new Error("Para AI state store not configured");
  const response = await fetch(`${KV_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
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
    const error = new Error(`state store HTTP ${response.status}: ${detail}`);
    error.code = "STATE_STORE_REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
  return parsed;
}

export async function kv(args) {
  const body = await request("", args);
  if (body?.error) throw new Error(body.error);
  return body?.result ?? null;
}

export async function pipeline(commands) {
  if (!commands.length) return [];
  const body = await request("/pipeline", commands);
  return body.map((item) => {
    if (item?.error) throw new Error(item.error);
    return item?.result ?? null;
  });
}

const parse = (raw, fallback = null) => {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};

function storeHash(namespace, value) {
  return createHash("sha256")
    .update(String(namespace || "value"))
    .update("\0")
    .update(String(value || ""))
    .digest("hex");
}

function validStoreId(value) {
  return /^[A-Za-z0-9_-]{8,100}$/.test(String(value || ""));
}

function requireStoreId(value, label = "job id") {
  const id = String(value || "").trim();
  if (!validStoreId(id)) throw new Error(`valid ${label} required`);
  return id;
}

function epochMs(value, fallback = Date.now()) {
  if (value == null || value === "") return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function hashedCandidateClaimKey(candidateUserId) {
  const value = String(candidateUserId || "").trim();
  if (!value) throw new Error("candidateUserId required");
  return submissionClaimKey(value);
}

export function hashedResumeCandidateId(candidateUserId) {
  const value = String(candidateUserId || "").trim();
  if (!value) throw new Error("candidateUserId required");
  return storeHash("paraai-candidate-v1", value);
}

function requireResumeChaseChainId(value) {
  const chainId = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(chainId)) {
    throw new Error("valid resume chase chain id required");
  }
  return chainId;
}

function canonicalResumeChaseAnchor(value) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) {
    throw new Error("valid resume chase chain anchor required");
  }
  return new Date(parsed).toISOString();
}

function canonicalResumeChaseCallEndedAt(value) {
  if (value == null || value === "") return "";
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) {
    throw new Error("valid resume chase call end required");
  }
  return new Date(parsed).toISOString();
}

export function resumeChaseChainId(jobId, chainAnchorAt) {
  const id = requireStoreId(jobId);
  const anchorAt = canonicalResumeChaseAnchor(chainAnchorAt);
  return storeHash(
    "resume-chase-chain-v1",
    `${id}\0${anchorAt}`,
  );
}

function resumeChaseScope({
  jobId,
  chainId,
  chainAnchorAt,
  chainCallEndedAt = "",
} = {}) {
  const id = requireStoreId(jobId);
  const anchorAt = canonicalResumeChaseAnchor(chainAnchorAt);
  const expectedChainId = resumeChaseChainId(id, anchorAt);
  const selectedChainId = requireResumeChaseChainId(chainId);
  if (selectedChainId !== expectedChainId) {
    throw new Error("resume chase chain id mismatch");
  }
  return {
    jobId: id,
    chainId: selectedChainId,
    chainAnchorAt: anchorAt,
    chainCallEndedAt: canonicalResumeChaseCallEndedAt(chainCallEndedAt),
  };
}

export function hashedResumeAskKey(candidateUserId, chainId) {
  return resumeAskKey(candidateUserId, chainId);
}

export function hashedResumeSatisfactionKey(candidateUserId) {
  return resumeSatisfactionKey(candidateUserId);
}

export function hashedResumeCurrentChainKey(candidateUserId) {
  return resumeCurrentChainKey(candidateUserId);
}

export async function recordResumeAttachedSignal(
  candidateUserId,
  {
    eventId,
    receivedAt = new Date().toISOString(),
    ttlSeconds = RESUME_ATTACHED_SIGNAL_TTL_SECONDS,
  } = {},
  { kvImpl = kv } = {},
) {
  const candidateHash = hashedResumeCandidateId(candidateUserId);
  const eventHash = storeHash(
    "resume-attached-event-v1",
    String(eventId || "").trim(),
  );
  const parsedAt = Date.parse(String(receivedAt || ""));
  if (!String(eventId || "").trim() || !Number.isFinite(parsedAt)) {
    throw new Error("valid resume attached signal required");
  }
  const ttl = Math.max(
    60,
    Math.min(60 * 60, Math.floor(Number(ttlSeconds) || RESUME_ATTACHED_SIGNAL_TTL_SECONDS)),
  );
  const record = {
    version: 1,
    candidateHash,
    eventHash,
    receivedAt: new Date(parsedAt).toISOString(),
  };
  await kvImpl([
    "SET",
    resumeAttachedSignalKey(candidateUserId),
    JSON.stringify(record),
    "EX",
    String(ttl),
  ]);
  return record;
}

export async function getRecentResumeAttachedSignal(
  candidateUserId,
  {
    now = Date.now(),
    maxAgeMs = RESUME_ATTACHED_SIGNAL_TTL_SECONDS * 1000,
  } = {},
  { kvImpl = kv } = {},
) {
  const record = parse(
    await kvImpl(["GET", resumeAttachedSignalKey(candidateUserId)]),
    null,
  );
  const receivedAt = Date.parse(String(record?.receivedAt || ""));
  const current = Number(now);
  const maximumAge = Math.max(
    1_000,
    Math.min(60 * 60_000, Number(maxAgeMs) || RESUME_ATTACHED_SIGNAL_TTL_SECONDS * 1000),
  );
  if (
    record?.candidateHash !== hashedResumeCandidateId(candidateUserId)
    || !Number.isFinite(receivedAt)
    || !Number.isFinite(current)
    || receivedAt > current + 60_000
    || current - receivedAt > maximumAge
  ) {
    return null;
  }
  return record;
}

export function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function hashSubmissionPayload(payload) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function phase2CanaryManifestDigest(botIds = []) {
  const ids = Array.isArray(botIds)
    ? botIds.map((id) => String(id || ""))
    : [];
  return createHash("sha256")
    .update(JSON.stringify(ids))
    .digest("hex");
}

function phase2CanaryManifestMatches(record) {
  return Boolean(
    Array.isArray(record?.botIds)
    && /^[a-f0-9]{64}$/u.test(String(record?.manifestDigest || ""))
    && phase2CanaryManifestDigest(record.botIds)
      === String(record.manifestDigest),
  );
}

function phase2RemainderManifestValue({
  canaryManifestDigest,
  snapshotFingerprint,
  commonAnchorAt,
  entries,
} = {}) {
  return {
    version: 1,
    canaryManifestDigest: String(canaryManifestDigest || ""),
    snapshotFingerprint: String(snapshotFingerprint || ""),
    commonAnchorAt: String(commonAnchorAt || ""),
    entries: (Array.isArray(entries) ? entries : []).map((entry) => ({
      id: String(entry?.id || ""),
      revision: Number(entry?.revision),
      resumeReady: entry?.resumeReady === true,
    })),
  };
}

export function phase2RemainderManifestDigest(value = {}) {
  return createHash("sha256")
    .update(stableStringify(phase2RemainderManifestValue(value)))
    .digest("hex");
}

export function phase2RemainderAttestationDigest(value = {}) {
  return createHash("sha256")
    .update(stableStringify({
      version: 1,
      canaryManifestDigest: String(value?.canaryManifestDigest || ""),
      snapshotFingerprint: String(value?.snapshotFingerprint || ""),
      commonAnchorAt: String(value?.commonAnchorAt || ""),
      verified: value?.verified === true,
      selected: Number(value?.selected),
      authorized: Number(value?.authorized),
      preferencesRouted: Number(value?.preferencesRouted),
      payloadHashVerified: Number(value?.payloadHashVerified),
      submitAttemptStarted: Number(value?.submitAttemptStarted),
      submitAccepted: Number(value?.submitAccepted),
      talentNetworkVisible: Number(value?.talentNetworkVisible),
      preexistingVisible: Number(value?.preexistingVisible),
      waitingForResume: Number(value?.waitingForResume),
      needsReview: Number(value?.needsReview),
      errors: Number(value?.errors),
      missing: Number(value?.missing),
      authorizedDelta: Number(value?.authorizedDelta),
      releaseFenceIntact: value?.releaseFenceIntact === true,
    }))
    .digest("hex");
}

function phase2RemainderManifestMatches(record) {
  return Boolean(
    /^[a-f0-9]{64}$/u.test(String(record?.manifestDigest || ""))
    && phase2RemainderManifestDigest({
      canaryManifestDigest: record?.canaryManifestDigest,
      snapshotFingerprint: record?.snapshotFingerprint,
      commonAnchorAt: record?.commonAnchorAt,
      entries: record?.entries,
    }) === String(record.manifestDigest),
  );
}

function phase2RemainderAttestationMatches(record) {
  return Boolean(
    record?.canaryVerification
    && typeof record.canaryVerification === "object"
    && /^[a-f0-9]{64}$/u.test(
      String(record?.canaryVerificationDigest || ""),
    )
    && phase2RemainderAttestationDigest(record.canaryVerification)
      === String(record.canaryVerificationDigest),
  );
}

export function submissionOutcomeTransition(current, next) {
  const before = current == null || current === "" ? null : String(current);
  const after = String(next || "");
  if (!new Set(["accepted", "unknown", "rejected", "confirmed"]).has(after)) return "invalid";
  if (before === after) return "existing";
  if (before == null) return "finished";
  if (after === "confirmed" && new Set(["accepted", "unknown"]).has(before)) return "advanced";
  return "conflict";
}

const compactFailureText = (value, limit) => String(value || "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, limit);

export function normalizeFailureRecord(value) {
  if (!value || typeof value !== "object") return null;
  const code = compactFailureText(value.code || "AUTO_PROCESS_FAILED", 100);
  const message = compactFailureText(value.message || value.detail || code, 300);
  const step = compactFailureText(value.step || "process", 100);
  return {
    code: code || "AUTO_PROCESS_FAILED",
    message: message || code || "automation step failed",
    step: step || "process",
  };
}

export function transition(job, state, details = {}) {
  const at = new Date().toISOString();
  const {
    journalDetail,
    journalFailure,
    ...persistentDetails
  } = details && typeof details === "object" ? details : {};
  const failure = normalizeFailureRecord(journalFailure);
  return {
    ...job,
    ...persistentDetails,
    state,
    updatedAt: at,
    journal: [
      ...(job?.journal || []),
      {
        state,
        at,
        ...(journalDetail ? { detail: journalDetail } : {}),
        ...(failure || {}),
      },
    ].slice(-100),
  };
}

export async function getJob(id) {
  return parse(await kv(["GET", jobKey(id)]), null);
}

export async function createJob(job, { kvImpl = kv } = {}) {
  const now = job.createdAt || new Date().toISOString();
  const value = { ...job, id: job.id, revision: 0, createdAt: now, updatedAt: job.updatedAt || now };
  const script = `
    local existing = redis.call('GET', KEYS[1])
    if existing then
      redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
      redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -501)
      local current = cjson.decode(existing)
      if current.state == 'waiting_for_resume' then
        redis.call('SADD', KEYS[3], ARGV[4])
      else
        redis.call('SREM', KEYS[3], ARGV[4])
      end
      return {0, existing}
    end
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
    redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -501)
    if ARGV[5] == 'waiting_for_resume' then
      redis.call('SADD', KEYS[3], ARGV[4])
    else
      redis.call('SREM', KEYS[3], ARGV[4])
    end
    return {1, ARGV[1]}
  `;
  const result = await kvImpl([
    "EVAL", script, 3, jobKey(value.id), INDEX_KEY, RESUME_WAITING_KEY,
    JSON.stringify(value), String(JOB_TTL_SECONDS),
    String(Date.parse(value.updatedAt) || Date.now()), value.id, String(value.state || ""),
  ]);
  return parse(Array.isArray(result) ? result[1] : null, value);
}

export async function saveJob(job, expectedRevision, { kvImpl = kv } = {}) {
  const next = { ...job, revision: Number(expectedRevision) + 1, updatedAt: new Date().toISOString() };
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return -1 end
    local current = cjson.decode(raw)
    if tonumber(current.revision or 0) ~= tonumber(ARGV[1]) then return 0 end
    redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
    redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
    redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -501)
    if ARGV[6] == 'waiting_for_resume' then
      redis.call('SADD', KEYS[3], ARGV[5])
    else
      redis.call('SREM', KEYS[3], ARGV[5])
    end
    return 1
  `;
  const result = await kvImpl([
    "EVAL", script, 3, jobKey(job.id), INDEX_KEY, RESUME_WAITING_KEY,
    String(expectedRevision), JSON.stringify(next), String(JOB_TTL_SECONDS),
    String(Date.parse(next.updatedAt) || Date.now()), next.id, String(next.state || ""),
  ]);
  if (Number(result) === 0) {
    const error = new Error("job changed; refresh and retry");
    error.code = "REVISION_CONFLICT";
    throw error;
  }
  if (Number(result) !== 1) throw new Error("job no longer exists");
  return next;
}

export async function listJobs(limit = 200) {
  const capped = Math.max(1, Math.min(500, Number(limit) || 200));
  const ids = await kv(["ZREVRANGE", INDEX_KEY, 0, capped - 1]);
  if (!Array.isArray(ids) || !ids.length) return [];
  const values = await pipeline(ids.map((id) => ["GET", jobKey(id)]));
  return values.map((value) => parse(value, null)).filter(Boolean);
}

export async function getCompletePhase2CanarySnapshot(
  {
    maxExclusive = PHASE2_FIRST_TEN_CANARY_INDEX_LIMIT,
  } = {},
  {
    kvImpl = kv,
  } = {},
) {
  const maximum = Math.max(
    1,
    Math.min(
      PHASE2_FIRST_TEN_CANARY_INDEX_LIMIT,
      Math.floor(Number(maxExclusive) || PHASE2_FIRST_TEN_CANARY_INDEX_LIMIT),
    ),
  );
  const script = `
    local total = tonumber(redis.call('ZCARD', KEYS[1]) or 0)
    if total >= tonumber(ARGV[1]) then
      return {0, tostring(total)}
    end
    local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
    if #ids ~= total then
      return {-1, tostring(total), tostring(#ids)}
    end
    local rows = {}
    local fingerprintParts = {}
    for _, id in ipairs(ids) do
      local raw = redis.call('GET', ARGV[2] .. id)
      if not raw then
        return {-2, tostring(total), tostring(#ids)}
      end
      local job = cjson.decode(raw)
      if tostring(job.id or '') ~= tostring(id) then
        return {-3, tostring(total), tostring(#ids)}
      end
      table.insert(fingerprintParts, id)
      table.insert(
        fingerprintParts,
        tostring(tonumber(job.revision or 0))
      )
      table.insert(rows, id)
      table.insert(rows, raw)
    end
    local result = {
      1,
      tostring(total),
      redis.sha1hex(table.concat(fingerprintParts, '\\n'))
    }
    for _, row in ipairs(rows) do
      table.insert(result, row)
    end
    return result
  `;
  const result = await kvImpl([
    "EVAL",
    script,
    1,
    INDEX_KEY,
    String(maximum),
    "paraai:job:",
  ]);
  const code = Number(result?.[0]);
  const total = Number(result?.[1]);
  if (code !== 1 || !Number.isInteger(total) || total < 0) {
    const error = new Error(
      code === 0
        ? "phase 2 canary index is at the completeness limit"
        : "phase 2 canary snapshot is incomplete",
    );
    error.code = code === 0
      ? "PHASE2_CANARY_INDEX_LIMIT"
      : "PHASE2_CANARY_SNAPSHOT_INCOMPLETE";
    throw error;
  }
  const fingerprint = String(result?.[2] || "");
  if (
    !/^[a-f0-9]{40}$/u.test(fingerprint)
    || !Array.isArray(result)
    || result.length !== 3 + total * 2
  ) {
    const error = new Error("phase 2 canary snapshot is incomplete");
    error.code = "PHASE2_CANARY_SNAPSHOT_INCOMPLETE";
    throw error;
  }
  const jobs = [];
  for (let index = 0; index < total; index++) {
    const indexedId = String(result[3 + index * 2] || "");
    const job = parse(result[4 + index * 2], null);
    if (
      !validStoreId(indexedId)
      || !job
      || String(job.id || "") !== indexedId
    ) {
      const error = new Error("phase 2 canary snapshot is incomplete");
      error.code = "PHASE2_CANARY_SNAPSHOT_INCOMPLETE";
      throw error;
    }
    jobs.push(job);
  }
  return {
    complete: true,
    total,
    fingerprint,
    jobs,
  };
}

export async function getPhase2FirstTenCanary(
  {
    kvImpl = kv,
  } = {},
) {
  const record = parse(
    await kvImpl(["GET", PHASE2_FIRST_TEN_CANARY_KEY]),
    null,
  );
  if (!record) return null;
  if (
    record?.version !== 1
    || !["planned", "committing", "complete"].includes(
      String(record?.status || ""),
    )
    || !/^[a-f0-9]{64}$/u.test(String(record?.manifestDigest || ""))
    || !Array.isArray(record?.botIds)
    || record.botIds.length !== Number(record?.count)
    || record.botIds.length !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || record.botIds.some((id) => !validStoreId(id))
    || new Set(record.botIds).size !== record.botIds.length
    || !phase2CanaryManifestMatches(record)
    || !Array.isArray(record?.revisions)
    || record.revisions.length !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || record.revisions.some((revision) => (
      !Number.isInteger(Number(revision)) || Number(revision) < 0
    ))
    || !/^[a-f0-9]{40}$/u.test(String(record?.snapshotFingerprint || ""))
    || record?.attachProof !== true
    || !Number.isInteger(Number(record?.authorizedBackfillCountAtPlan))
    || Number(record.authorizedBackfillCountAtPlan) < 0
    || Number(record.authorizedBackfillCountAtPlan)
      > Number(record.snapshotTotal)
  ) {
    const error = new Error("phase 2 canary record is invalid");
    error.code = "PHASE2_CANARY_RECORD_INVALID";
    throw error;
  }
  return record;
}

export async function createPhase2FirstTenCanaryPlan(
  {
    entries = [],
    manifestDigest,
    snapshotFingerprint,
    snapshotTotal,
    eligibleCount,
    authorizedBackfillCount,
    attachProof = false,
    now = Date.now(),
  } = {},
  {
    kvImpl = kv,
  } = {},
) {
  const rows = Array.isArray(entries) ? entries : [];
  if (rows.length !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS) {
    throw new Error("phase 2 canary requires exactly ten jobs");
  }
  const ids = rows.map((entry) => requireStoreId(entry?.id));
  if (new Set(ids).size !== ids.length) {
    throw new Error("phase 2 canary manifest contains duplicate jobs");
  }
  const revisions = rows.map((entry) => Number(entry?.revision));
  if (revisions.some((revision) => !Number.isInteger(revision) || revision < 0)) {
    throw new Error("phase 2 canary manifest requires job revisions");
  }
  const digest = String(manifestDigest || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("phase 2 canary manifest digest is invalid");
  }
  if (digest !== phase2CanaryManifestDigest(ids)) {
    const error = new Error(
      "phase 2 canary manifest digest does not attest the ordered jobs",
    );
    error.code = "PHASE2_CANARY_DIGEST_MISMATCH";
    throw error;
  }
  const fingerprint = String(snapshotFingerprint || "").toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(fingerprint)) {
    throw new Error("phase 2 canary snapshot fingerprint is invalid");
  }
  const total = Number(snapshotTotal);
  const eligible = Number(eligibleCount);
  const authorizedAtPlan = Number(authorizedBackfillCount);
  if (
    !Number.isInteger(total)
    || total < 0
    || total >= PHASE2_FIRST_TEN_CANARY_INDEX_LIMIT
    || !Number.isInteger(eligible)
    || eligible < rows.length
    || eligible > total
    || !Number.isInteger(authorizedAtPlan)
    || authorizedAtPlan < 0
    || authorizedAtPlan > total
    || attachProof !== true
  ) {
    throw new Error("phase 2 canary snapshot counts are invalid");
  }
  const current = epochMs(now);
  const proposed = {
    version: 1,
    status: "planned",
    manifestDigest: digest,
    count: ids.length,
    botIds: ids,
    revisions,
    snapshotComplete: true,
    snapshotTotal: total,
    snapshotFingerprint: fingerprint,
    eligibleCount: eligible,
    authorizedBackfillCountAtPlan: authorizedAtPlan,
    attachProof: true,
    plannedAt: new Date(current).toISOString(),
    result: null,
  };
  const script = `
    local existingRaw = redis.call('GET', KEYS[1])
    if existingRaw then
      return {2, existingRaw}
    end

    local total = tonumber(redis.call('ZCARD', KEYS[2]) or 0)
    if total >= tonumber(ARGV[1]) or total ~= tonumber(ARGV[2]) then
      return {-1, tostring(total)}
    end
    local ids = redis.call('ZRANGE', KEYS[2], 0, -1)
    if #ids ~= total then
      return {-2, tostring(total)}
    end
    local fingerprintParts = {}
    for _, id in ipairs(ids) do
      local raw = redis.call('GET', ARGV[4] .. id)
      if not raw then return {-2, tostring(total)} end
      local job = cjson.decode(raw)
      if tostring(job.id or '') ~= tostring(id) then
        return {-2, tostring(total)}
      end
      table.insert(fingerprintParts, id)
      table.insert(
        fingerprintParts,
        tostring(tonumber(job.revision or 0))
      )
    end
    if redis.sha1hex(table.concat(fingerprintParts, '\\n')) ~= ARGV[3] then
      return {-3, tostring(total)}
    end

    local seenCandidates = {}
    for rowIndex = 1, tonumber(ARGV[5]) do
      local argumentIndex = 6 + ((rowIndex - 1) * 2)
      local expectedId = ARGV[argumentIndex]
      local expectedRevision = tonumber(ARGV[argumentIndex + 1])
      local raw = redis.call('GET', ARGV[4] .. expectedId)
      if not raw or not redis.call('ZSCORE', KEYS[2], expectedId) then
        return {-4, tostring(rowIndex)}
      end
      local job = cjson.decode(raw)
      local automation = job.automation or {}
      local resumeWait = automation.resumeWait or {}
      local identity = job.identity or {}
      local candidateId = string.match(
        tostring(identity.candidateUserId or ''),
        '^%s*(.-)%s*$'
      )
      if tostring(job.id or '') ~= expectedId
        or tonumber(job.revision or 0) ~= expectedRevision
        or tostring(automation.mode or '') ~= 'backfill_only'
        or tostring(resumeWait.source or '') == 'authorized_backfill'
        or tostring(automation.backfillBatchEntryAt or '') ~= ''
        or candidateId == ''
        or seenCandidates[candidateId] then
        return {-4, tostring(rowIndex)}
      end
      seenCandidates[candidateId] = true
    end
    local proposed = ARGV[6 + (tonumber(ARGV[5]) * 2)]
    local stored = redis.call('SET', KEYS[1], proposed, 'NX')
    if not stored then
      return {2, redis.call('GET', KEYS[1])}
    end
    return {1, proposed}
  `;
  const argumentsList = [
    String(PHASE2_FIRST_TEN_CANARY_INDEX_LIMIT),
    String(total),
    fingerprint,
    "paraai:job:",
    String(rows.length),
    ...rows.flatMap((entry, index) => [
      ids[index],
      String(revisions[index]),
    ]),
    JSON.stringify(proposed),
  ];
  const result = await kvImpl([
    "EVAL",
    script,
    2,
    PHASE2_FIRST_TEN_CANARY_KEY,
    INDEX_KEY,
    ...argumentsList,
  ]);
  const code = Number(result?.[0]);
  if ([-1, -2, -3, -4].includes(code)) {
    const error = new Error(
      "phase 2 canary snapshot changed before plan creation",
    );
    error.code = "PHASE2_CANARY_SNAPSHOT_CHANGED";
    throw error;
  }
  if (![1, 2].includes(code)) {
    const error = new Error("phase 2 canary plan creation failed");
    error.code = "PHASE2_CANARY_PLAN_FAILED";
    throw error;
  }
  const record = parse(result?.[1], null);
  if (
    !record
    || !["planned", "committing", "complete"].includes(
      String(record.status || ""),
    )
    || !Array.isArray(record.botIds)
    || record.botIds.length !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || record.botIds.some((id) => !validStoreId(id))
    || new Set(record.botIds).size !== record.botIds.length
    || !phase2CanaryManifestMatches(record)
    || !Array.isArray(record.revisions)
    || record.revisions.length !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || record.revisions.some((revision) => (
      !Number.isInteger(Number(revision)) || Number(revision) < 0
    ))
    || !/^[a-f0-9]{40}$/u.test(String(record.snapshotFingerprint || ""))
    || !/^[a-f0-9]{64}$/u.test(String(record.manifestDigest || ""))
    || record.attachProof !== true
    || !Number.isInteger(Number(record.authorizedBackfillCountAtPlan))
    || Number(record.authorizedBackfillCountAtPlan) < 0
    || Number(record.authorizedBackfillCountAtPlan)
      > Number(record.snapshotTotal)
  ) {
    const error = new Error("phase 2 canary plan is invalid");
    error.code = "PHASE2_CANARY_RECORD_INVALID";
    throw error;
  }
  return {
    created: code === 1,
    existing: code === 2,
    record,
  };
}

export async function claimPhase2FirstTenCanaryCommit(
  {
    manifestDigest,
    now = Date.now(),
    leaseMs = PHASE2_FIRST_TEN_CANARY_LEASE_MS,
    ownerToken = randomUUID(),
  } = {},
  {
    kvImpl = kv,
  } = {},
) {
  const digest = String(manifestDigest || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("phase 2 canary manifest digest is invalid");
  }
  const current = epochMs(now);
  const leaseUntil = current + Math.max(
    1_000,
    Math.min(
      10 * 60_000,
      Number(leaseMs) || PHASE2_FIRST_TEN_CANARY_LEASE_MS,
    ),
  );
  const token = String(ownerToken || randomUUID());
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return {0, ''} end
    local record = cjson.decode(raw)
    if tostring(record.manifestDigest or '') ~= ARGV[1] then
      return {-1, raw}
    end
    if record.status == 'complete' then return {2, raw} end
    if record.status == 'committing'
      and tonumber(record.leaseUntil or 0) > tonumber(ARGV[2]) then
      return {3, raw}
    end
    if record.status ~= 'planned' and record.status ~= 'committing' then
      return {-2, raw}
    end
    if tonumber(redis.call('ZCARD', KEYS[2]) or 0) >= tonumber(ARGV[7]) then
      return {-4, raw}
    end
    for rowIndex = 1, #record.botIds do
      local id = tostring(record.botIds[rowIndex] or '')
      local expectedRevision = tonumber(record.revisions[rowIndex] or -1)
      if not redis.call('ZSCORE', KEYS[2], id) then return {-4, raw} end
      local jobRaw = redis.call('GET', ARGV[6] .. id)
      if not jobRaw then return {-3, raw} end
      local job = cjson.decode(jobRaw)
      local automation = job.automation or {}
      local resumeWait = automation.resumeWait or {}
      local sameManifest = (
        tostring(automation.canaryManifestDigest or '')
          == tostring(record.manifestDigest or '')
        and (
          tostring(automation.mode or '') == 'authorized_backfill'
          or tostring(resumeWait.source or '') == 'authorized_backfill'
          or tostring(automation.backfillBatchEntryAt or '') ~= ''
        )
      )
      local unchanged = (
        tonumber(job.revision or -1) == expectedRevision
        and tostring(automation.mode or '') == 'backfill_only'
        and tostring(resumeWait.source or '') ~= 'authorized_backfill'
        and tostring(automation.backfillBatchEntryAt or '') == ''
        and tostring(automation.canaryManifestDigest or '') == ''
      )
      if not sameManifest and not unchanged then return {-3, raw} end
    end
    local recovered = record.status == 'committing'
    record.status = 'committing'
    record.ownerToken = ARGV[3]
    record.leaseUntil = tonumber(ARGV[4])
    record.commitStartedAt = record.commitStartedAt or ARGV[5]
    if recovered then record.recoveredAt = ARGV[5] end
    local claimed = cjson.encode(record)
    redis.call('SET', KEYS[1], claimed)
    return {recovered and 4 or 1, claimed}
  `;
  const result = await kvImpl([
    "EVAL",
    script,
    2,
    PHASE2_FIRST_TEN_CANARY_KEY,
    INDEX_KEY,
    digest,
    String(current),
    token,
    String(leaseUntil),
    new Date(current).toISOString(),
    "paraai:job:",
    String(PHASE2_FIRST_TEN_CANARY_INDEX_LIMIT),
  ]);
  const code = Number(result?.[0]);
  if (code === 0) {
    const error = new Error("phase 2 canary plan is required");
    error.code = "PHASE2_CANARY_PLAN_REQUIRED";
    throw error;
  }
  if (code === -1) {
    const error = new Error("phase 2 canary digest does not match");
    error.code = "PHASE2_CANARY_DIGEST_MISMATCH";
    throw error;
  }
  if (code === -2 || ![1, 2, 3, 4].includes(code)) {
    const error = new Error("phase 2 canary commit claim failed");
    error.code = code === -3
      ? "PHASE2_CANARY_JOB_CHANGED"
      : code === -4
        ? "PHASE2_CANARY_SNAPSHOT_CHANGED"
        : "PHASE2_CANARY_COMMIT_CLAIM_FAILED";
    throw error;
  }
  const record = parse(result?.[1], null);
  if (
    !record
    || !["committing", "complete"].includes(String(record.status || ""))
    || !Array.isArray(record.botIds)
    || record.botIds.length !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || record.botIds.some((id) => !validStoreId(id))
    || new Set(record.botIds).size !== record.botIds.length
    || !phase2CanaryManifestMatches(record)
    || !Array.isArray(record.revisions)
    || record.revisions.length !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || !/^[a-f0-9]{40}$/u.test(String(record.snapshotFingerprint || ""))
    || record.manifestDigest !== digest
  ) {
    const error = new Error("phase 2 canary commit claim is invalid");
    error.code = "PHASE2_CANARY_RECORD_INVALID";
    throw error;
  }
  return {
    acquired: [1, 4].includes(code),
    recovered: code === 4,
    busy: code === 3,
    complete: code === 2,
    ownerToken: [1, 4].includes(code) ? token : null,
    record,
  };
}

export async function completePhase2FirstTenCanary(
  {
    ownerToken,
    manifestDigest,
    result,
    now = Date.now(),
  } = {},
  {
    kvImpl = kv,
  } = {},
) {
  const token = String(ownerToken || "");
  const digest = String(manifestDigest || "").toLowerCase();
  if (!token || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("phase 2 canary completion authority is invalid");
  }
  const summary = {
    attempted: Math.max(0, Math.floor(Number(result?.attempted) || 0)),
    enqueued: Math.max(0, Math.floor(Number(result?.enqueued) || 0)),
    duplicate: Math.max(0, Math.floor(Number(result?.duplicate) || 0)),
    failed: Math.max(0, Math.floor(Number(result?.failed) || 0)),
  };
  if (
    summary.attempted !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || summary.enqueued + summary.duplicate + summary.failed
      !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
  ) {
    throw new Error("phase 2 canary completion summary is invalid");
  }
  const completedAt = new Date(epochMs(now)).toISOString();
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return {0, ''} end
    local record = cjson.decode(raw)
    if record.status == 'complete' then return {2, raw} end
    if record.status ~= 'committing'
      or tostring(record.ownerToken or '') ~= ARGV[1]
      or tostring(record.manifestDigest or '') ~= ARGV[2] then
      return {-1, raw}
    end
    local summary = cjson.decode(ARGV[4])
    local retryable = tonumber(summary.failed or 0) > 0
    record.status = retryable and 'planned' or 'complete'
    if retryable then
      record.lastFailedAt = ARGV[3]
      record.commitAttempts = tonumber(record.commitAttempts or 0) + 1
    else
      record.completedAt = ARGV[3]
    end
    record.result = cjson.decode(ARGV[4])
    record.ownerToken = nil
    record.leaseUntil = nil
    local completed = cjson.encode(record)
    redis.call('SET', KEYS[1], completed)
    return {retryable and 3 or 1, completed}
  `;
  const completed = await kvImpl([
    "EVAL",
    script,
    1,
    PHASE2_FIRST_TEN_CANARY_KEY,
    token,
    digest,
    completedAt,
    JSON.stringify(summary),
  ]);
  const code = Number(completed?.[0]);
  if (![1, 2, 3].includes(code)) {
    const error = new Error("phase 2 canary completion conflict");
    error.code = "PHASE2_CANARY_COMPLETION_CONFLICT";
    throw error;
  }
  const record = parse(completed?.[1], null);
  if (
    !record
    || !["planned", "complete"].includes(String(record.status || ""))
  ) {
    const error = new Error("phase 2 canary completion is invalid");
    error.code = "PHASE2_CANARY_RECORD_INVALID";
    throw error;
  }
  return record;
}

function validPhase2RemainderRecord(record) {
  const entries = Array.isArray(record?.entries) ? record.entries : null;
  const verification = record?.canaryVerification;
  const status = String(record?.status || "");
  if (
    record?.version !== 1
    || !["armed", "running", "complete", "paused"].includes(status)
    || !/^[a-f0-9]{64}$/u.test(String(record?.canaryManifestDigest || ""))
    || !/^[a-f0-9]{64}$/u.test(String(record?.manifestDigest || ""))
    || !/^[a-f0-9]{40}$/u.test(String(record?.snapshotFingerprint || ""))
    || !Number.isFinite(Date.parse(String(record?.commonAnchorAt || "")))
    || !entries
    || entries.length !== Number(record?.count)
    || entries.length >= PHASE2_FIRST_TEN_CANARY_INDEX_LIMIT
    || entries.some((entry) => (
      !validStoreId(entry?.id)
      || !Number.isInteger(Number(entry?.revision))
      || Number(entry.revision) < 0
      || typeof entry?.resumeReady !== "boolean"
      || !["pending", "claimed", "authorized", "review"].includes(
        String(entry?.status || ""),
      )
      || !Number.isInteger(Number(entry?.attempts))
      || Number(entry.attempts) < 0
      || (
        ["claimed", "authorized", "review"].includes(
          String(entry?.status || ""),
        )
        && Number(entry.attempts) < 1
      )
    ))
    || new Set(entries.map((entry) => entry.id)).size !== entries.length
    || !phase2RemainderManifestMatches(record)
    || !phase2RemainderAttestationMatches(record)
    || verification?.verified !== true
    || verification?.canaryManifestDigest !== record.canaryManifestDigest
    || verification?.snapshotFingerprint !== record.snapshotFingerprint
    || verification?.commonAnchorAt !== record.commonAnchorAt
    || Number(verification?.selected) !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || Number(verification?.authorized) !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || Number(verification?.preferencesRouted)
      !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || Number(verification?.payloadHashVerified)
      !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || Number(verification?.submitAttemptStarted)
      !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || Number(verification?.submitAccepted)
      !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || Number(verification?.talentNetworkVisible)
      !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || Number(verification?.preexistingVisible) !== 0
    || Number(verification?.waitingForResume) !== 0
    || Number(verification?.needsReview) !== 0
    || Number(verification?.errors) !== 0
    || Number(verification?.missing) !== 0
    || Number(verification?.authorizedDelta)
      !== PHASE2_FIRST_TEN_CANARY_MAX_JOBS
    || verification?.releaseFenceIntact !== true
    || !Number.isInteger(Number(record?.snapshotTotal))
    || Number(record.snapshotTotal) < entries.length
    || Number(record.snapshotTotal) >= PHASE2_FIRST_TEN_CANARY_INDEX_LIMIT
    || !Number.isInteger(Number(record?.excludedReviewCount))
    || Number(record.excludedReviewCount) < 0
    || Number(record?.resumeReadyCount)
      !== entries.filter((entry) => entry.resumeReady).length
    || Number(record?.resumeMissingCount)
      !== entries.filter((entry) => !entry.resumeReady).length
    || !Number.isInteger(Number(record?.batchOrdinal))
    || Number(record.batchOrdinal) < 0
  ) return false;
  const lease = record?.lease;
  const claimed = entries.filter((entry) => entry.status === "claimed");
  const pending = entries.filter((entry) => entry.status === "pending");
  if (
    (status === "armed" && (
      entries.length < 1
      || entries.some((entry) => entry.status !== "pending")
      || Number(record.batchOrdinal) !== 0
      || lease != null
    ))
    || (status === "running" && !pending.length && !claimed.length)
    || (status === "complete" && (
      entries.some((entry) => !["authorized", "review"].includes(entry.status))
      || lease != null
    ))
    || (status === "paused" && (claimed.length || lease != null))
    || (lease != null && status !== "running")
  ) return false;
  if (lease == null) {
    return claimed.length === 0;
  }
  if (
    typeof lease !== "object"
    || !String(lease.token || "")
    || !Number.isFinite(Number(lease.until))
    || !Array.isArray(lease.indexes)
    || lease.indexes.length < 1
    || lease.indexes.length > PHASE2_REMAINDER_BATCH_MAX
    || new Set(lease.indexes.map(Number)).size !== lease.indexes.length
    || lease.indexes.some((index) => (
      !Number.isInteger(Number(index))
      || Number(index) < 1
      || Number(index) > entries.length
      || entries[Number(index) - 1]?.status !== "claimed"
    ))
  ) return false;
  return entries.every((entry, index) => (
    entry.status !== "claimed"
    || lease.indexes.map(Number).includes(index + 1)
  ));
}

export async function getPhase2RemainderRelease(
  {
    kvImpl = kv,
  } = {},
) {
  const record = parse(await kvImpl(["GET", PHASE2_REMAINDER_KEY]), null);
  if (!record) return null;
  if (!validPhase2RemainderRecord(record)) {
    const error = new Error("phase 2 remainder release record is invalid");
    error.code = "PHASE2_REMAINDER_RECORD_INVALID";
    throw error;
  }
  return record;
}

export async function createPhase2RemainderPlan(
  {
    entries = [],
    manifestDigest,
    canaryManifestDigest,
    canaryVerification,
    canaryVerificationDigest,
    snapshotFingerprint,
    snapshotTotal,
    commonAnchorAt,
    excludedReviewCount = 0,
    now = Date.now(),
  } = {},
  {
    kvImpl = kv,
  } = {},
) {
  const rows = (Array.isArray(entries) ? entries : []).map((entry) => ({
    id: requireStoreId(entry?.id),
    revision: Number(entry?.revision),
    resumeReady: entry?.resumeReady === true,
    status: "pending",
    attempts: 0,
  }));
  if (
    rows.length >= PHASE2_FIRST_TEN_CANARY_INDEX_LIMIT
    || new Set(rows.map((entry) => entry.id)).size !== rows.length
    || rows.some((entry) => (
      !Number.isInteger(entry.revision) || entry.revision < 0
    ))
  ) {
    throw new Error("phase 2 remainder manifest entries are invalid");
  }
  const canaryDigest = String(canaryManifestDigest || "").toLowerCase();
  const releaseDigest = String(manifestDigest || "").toLowerCase();
  const attestationDigest =
    String(canaryVerificationDigest || "").toLowerCase();
  const fingerprint = String(snapshotFingerprint || "").toLowerCase();
  const anchorMs = Date.parse(String(commonAnchorAt || ""));
  if (!Number.isFinite(anchorMs)) {
    const error = new Error("phase 2 remainder anchor is invalid");
    error.code = "PHASE2_REMAINDER_ANCHOR_INVALID";
    throw error;
  }
  const anchor = new Date(anchorMs).toISOString();
  if (
    !/^[a-f0-9]{64}$/u.test(canaryDigest)
    || !/^[a-f0-9]{64}$/u.test(releaseDigest)
    || !/^[a-f0-9]{64}$/u.test(attestationDigest)
    || !/^[a-f0-9]{40}$/u.test(fingerprint)
    || releaseDigest !== phase2RemainderManifestDigest({
      canaryManifestDigest: canaryDigest,
      snapshotFingerprint: fingerprint,
      commonAnchorAt: anchor,
      entries: rows,
    })
    || attestationDigest !== phase2RemainderAttestationDigest(
      canaryVerification,
    )
  ) {
    const error = new Error("phase 2 remainder digest is invalid");
    error.code = "PHASE2_REMAINDER_DIGEST_MISMATCH";
    throw error;
  }
  const total = Number(snapshotTotal);
  const excluded = Number(excludedReviewCount);
  if (
    !Number.isInteger(total)
    || total < rows.length
    || total >= PHASE2_FIRST_TEN_CANARY_INDEX_LIMIT
    || !Number.isInteger(excluded)
    || excluded < 0
  ) {
    throw new Error("phase 2 remainder snapshot counts are invalid");
  }
  const current = epochMs(now);
  const proposed = {
    version: 1,
    status: rows.length ? "armed" : "complete",
    canaryManifestDigest: canaryDigest,
    canaryVerification: { ...canaryVerification },
    canaryVerificationDigest: attestationDigest,
    manifestDigest: releaseDigest,
    snapshotFingerprint: fingerprint,
    snapshotTotal: total,
    commonAnchorAt: anchor,
    count: rows.length,
    entries: rows,
    resumeReadyCount: rows.filter((entry) => entry.resumeReady).length,
    resumeMissingCount: rows.filter((entry) => !entry.resumeReady).length,
    excludedReviewCount: excluded,
    batchOrdinal: 0,
    armedAt: new Date(current).toISOString(),
    ...(rows.length ? {} : {
      completedAt: new Date(current).toISOString(),
    }),
  };
  if (!validPhase2RemainderRecord(proposed)) {
    const error = new Error("phase 2 remainder plan is invalid");
    error.code = "PHASE2_REMAINDER_RECORD_INVALID";
    throw error;
  }
  const script = `
    local function stringValue(value)
      if value == nil or value == cjson.null then return '' end
      return tostring(value)
    end
    local existingRaw = redis.call('GET', KEYS[1])
    if existingRaw then return {2, existingRaw} end
    local canaryRaw = redis.call('GET', KEYS[2])
    if not canaryRaw then return {-1, ''} end
    local canary = cjson.decode(canaryRaw)
    local canaryResult = type(canary.result) == 'table'
      and canary.result or {}
    local canaryBotIds = type(canary.botIds) == 'table'
      and canary.botIds or {}
    if canary.status ~= 'complete'
      or stringValue(canary.manifestDigest) ~= ARGV[5]
      or tonumber(canary.count or 0) ~= 10
      or #canaryBotIds ~= 10
      or tonumber(canaryResult.attempted or 0) ~= 10
      or tonumber(canaryResult.failed or -1) ~= 0
      or (
        tonumber(canaryResult.enqueued or 0)
        + tonumber(canaryResult.duplicate or 0)
      ) ~= 10 then
      return {-1, canaryRaw}
    end
    local total = tonumber(redis.call('ZCARD', KEYS[3]) or 0)
    if total >= tonumber(ARGV[1]) or total ~= tonumber(ARGV[2]) then
      return {-2, tostring(total)}
    end
    local ids = redis.call('ZRANGE', KEYS[3], 0, -1)
    if #ids ~= total then return {-2, tostring(total)} end
    local fingerprintParts = {}
    for _, id in ipairs(ids) do
      local raw = redis.call('GET', ARGV[4] .. id)
      if not raw then return {-2, tostring(total)} end
      local job = cjson.decode(raw)
      if tostring(job.id or '') ~= tostring(id) then
        return {-2, tostring(total)}
      end
      table.insert(fingerprintParts, id)
      table.insert(
        fingerprintParts,
        tostring(tonumber(job.revision or 0))
      )
    end
    if redis.sha1hex(table.concat(fingerprintParts, '\\n')) ~= ARGV[3] then
      return {-2, tostring(total)}
    end
    local canaryIds = {}
    for _, id in ipairs(canaryBotIds) do
      canaryIds[tostring(id)] = true
    end
    for rowIndex = 1, tonumber(ARGV[7]) do
      local argumentIndex = 8 + ((rowIndex - 1) * 2)
      local expectedId = ARGV[argumentIndex]
      local expectedRevision = tonumber(ARGV[argumentIndex + 1])
      if canaryIds[expectedId]
        or not redis.call('ZSCORE', KEYS[3], expectedId) then
        return {-3, tostring(rowIndex)}
      end
      local raw = redis.call('GET', ARGV[4] .. expectedId)
      if not raw then return {-3, tostring(rowIndex)} end
      local job = cjson.decode(raw)
      local automation = type(job.automation) == 'table'
        and job.automation or {}
      local resumeWait = type(automation.resumeWait) == 'table'
        and automation.resumeWait or {}
      if stringValue(job.id) ~= expectedId
        or tonumber(job.revision or -1) ~= expectedRevision
        or stringValue(automation.mode) ~= 'backfill_only'
        or stringValue(resumeWait.source) == 'authorized_backfill'
        or stringValue(automation.backfillBatchEntryAt) ~= ''
        or stringValue(automation.canaryManifestDigest) ~= ''
        or stringValue(automation.remainderManifestDigest) ~= '' then
        return {-3, tostring(rowIndex)}
      end
    end
    local proposed = ARGV[8 + (tonumber(ARGV[7]) * 2)]
    local stored = redis.call('SET', KEYS[1], proposed, 'NX')
    if not stored then return {2, redis.call('GET', KEYS[1])} end
    return {1, proposed}
  `;
  const result = await kvImpl([
    "EVAL",
    script,
    3,
    PHASE2_REMAINDER_KEY,
    PHASE2_FIRST_TEN_CANARY_KEY,
    INDEX_KEY,
    String(PHASE2_FIRST_TEN_CANARY_INDEX_LIMIT),
    String(total),
    fingerprint,
    "paraai:job:",
    canaryDigest,
    releaseDigest,
    String(rows.length),
    ...rows.flatMap((entry) => [
      entry.id,
      String(entry.revision),
    ]),
    JSON.stringify(proposed),
  ]);
  const code = Number(result?.[0]);
  if (code === -1) {
    const error = new Error("phase 2 canary is not release-eligible");
    error.code = "PHASE2_REMAINDER_CANARY_NOT_VERIFIED";
    throw error;
  }
  if ([-2, -3].includes(code)) {
    const error = new Error(
      "phase 2 remainder snapshot changed before arm",
    );
    error.code = "PHASE2_REMAINDER_SNAPSHOT_CHANGED";
    throw error;
  }
  if (![1, 2].includes(code)) {
    const error = new Error("phase 2 remainder arm failed");
    error.code = "PHASE2_REMAINDER_ARM_FAILED";
    throw error;
  }
  const record = parse(result?.[1], null);
  if (!validPhase2RemainderRecord(record)) {
    const error = new Error("phase 2 remainder record is invalid");
    error.code = "PHASE2_REMAINDER_RECORD_INVALID";
    throw error;
  }
  if (
    record.canaryManifestDigest !== canaryDigest
    || record.manifestDigest !== releaseDigest
  ) {
    const error = new Error("phase 2 remainder manifest conflicts");
    error.code = "PHASE2_REMAINDER_MANIFEST_CONFLICT";
    throw error;
  }
  return {
    created: code === 1,
    existing: code === 2,
    record,
  };
}

export async function claimPhase2RemainderBatch(
  {
    now = Date.now(),
    batchSize = 1,
    ownerToken = randomUUID(),
    leaseMs = PHASE2_REMAINDER_LEASE_MS,
  } = {},
  {
    kvImpl = kv,
  } = {},
) {
  const current = epochMs(now);
  const cappedBatch = Math.max(
    1,
    Math.min(PHASE2_REMAINDER_BATCH_MAX, Number(batchSize) || 1),
  );
  const token = String(ownerToken || randomUUID());
  const leaseUntil = current + Math.max(
    30_000,
    Math.min(10 * 60_000, Number(leaseMs) || PHASE2_REMAINDER_LEASE_MS),
  );
  const script = `
    redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[1])
    local queued = tonumber(redis.call('ZCARD', KEYS[2]) or 0)
    local due = tonumber(
      redis.call('ZCOUNT', KEYS[2], '-inf', ARGV[1]) or 0
    )
    local leased = tonumber(redis.call('ZCARD', KEYS[3]) or 0)
    local raw = redis.call('GET', KEYS[1])
    if not raw then
      return {
        0,
        '',
        tostring(queued),
        tostring(due),
        tostring(leased)
      }
    end
    local record = cjson.decode(raw)
    if record.status == 'complete' then
      return {
        2,
        raw,
        tostring(queued),
        tostring(due),
        tostring(leased)
      }
    end
    if record.status == 'paused' then
      return {
        7,
        raw,
        tostring(queued),
        tostring(due),
        tostring(leased)
      }
    end
    local available = tonumber(ARGV[6]) - queued
    available = math.min(available, tonumber(ARGV[7]) - due)
    available = math.min(available, tonumber(ARGV[8]) - leased)
    if record.lease and record.lease ~= cjson.null then
      local storedUntil = 0
      if type(record.lease['until']) == 'number'
        or type(record.lease['until']) == 'string' then
        storedUntil = tonumber(record.lease['until']) or 0
      end
      if storedUntil > tonumber(ARGV[1]) then
        return {
          3,
          raw,
          tostring(queued),
          tostring(due),
          tostring(leased)
        }
      end
      local indexes = type(record.lease.indexes) == 'table'
        and record.lease.indexes or {}
      local entries = type(record.entries) == 'table'
        and record.entries or {}
      local expected = {}
      local mismatch = type(record.entries) ~= 'table'
        or #indexes < 1
        or #indexes > 5
      for _, index in ipairs(indexes) do
        local numericIndex = nil
        if type(index) == 'number' or type(index) == 'string' then
          numericIndex = tonumber(index)
        end
        local entry = numericIndex and entries[numericIndex] or nil
        if not numericIndex
          or numericIndex < 1
          or numericIndex > #entries
          or numericIndex % 1 ~= 0
          or not entry
          or entry.status ~= 'claimed'
          or expected[numericIndex] then
          mismatch = true
        elseif numericIndex then
          expected[numericIndex] = true
        end
      end
      for index, entry in ipairs(entries) do
        if entry.status == 'claimed' and not expected[index] then
          mismatch = true
        end
      end
      if mismatch then
        for _, entry in ipairs(entries) do
          if entry.status == 'claimed' then
            entry.status = 'review'
            entry.lastError = 'lease_entry_mismatch'
            entry.reviewedAt = ARGV[5]
          end
        end
        record.lease = nil
        record.status = 'paused'
        record.pauseReason = 'lease_entry_mismatch'
        record.pausedAt = ARGV[5]
        local paused = cjson.encode(record)
        redis.call('SET', KEYS[1], paused)
        return {
          7,
          paused,
          tostring(queued),
          tostring(due),
          tostring(leased)
        }
      end
      local recoveryCeiling = false
      for _, index in ipairs(indexes) do
        local entry = entries[tonumber(index)]
        if tonumber(entry.attempts or 0) >= 3 then
          recoveryCeiling = true
        end
      end
      if recoveryCeiling then
        for _, entry in ipairs(entries) do
          if entry.status == 'claimed' then
            entry.status = 'pending'
            entry.lastError = 'release_retry_ceiling'
            entry.lastAt = ARGV[5]
          end
        end
        record.lease = nil
        record.status = 'paused'
        record.pauseReason = 'release_retry_ceiling'
        record.pausedAt = ARGV[5]
        local paused = cjson.encode(record)
        redis.call('SET', KEYS[1], paused)
        return {
          7,
          paused,
          tostring(queued),
          tostring(due),
          tostring(leased)
        }
      end
      if available < #indexes then
        return {
          5,
          raw,
          tostring(queued),
          tostring(due),
          tostring(leased)
        }
      end
      for _, index in ipairs(indexes) do
        local entry = entries[tonumber(index)]
        entry.attempts = tonumber(entry.attempts or 0) + 1
        entry.lastRecoveredAt = ARGV[5]
      end
      record.lease.token = ARGV[3]
      record.lease['until'] = tonumber(ARGV[4])
      record.lease.recoveredAt = ARGV[5]
      local recovered = cjson.encode(record)
      redis.call('SET', KEYS[1], recovered)
      return {
        4,
        recovered,
        tostring(queued),
        tostring(due),
        tostring(leased)
      }
    end

    local capacity = math.min(tonumber(ARGV[2]), available)
    if capacity < 1 then
      return {
        5,
        raw,
        tostring(queued),
        tostring(due),
        tostring(leased)
      }
    end
    local indexes = {}
    for index, entry in ipairs(record.entries or {}) do
      if #indexes >= capacity then break end
      if entry.status == 'pending' then
        entry.status = 'claimed'
        entry.attempts = tonumber(entry.attempts or 0) + 1
        entry.claimedAt = ARGV[5]
        table.insert(indexes, index)
      end
    end
    if #indexes == 0 then
      record.status = 'complete'
      record.completedAt = ARGV[5]
      local completed = cjson.encode(record)
      redis.call('SET', KEYS[1], completed)
      return {
        2,
        completed,
        tostring(queued),
        tostring(due),
        tostring(leased)
      }
    end
    record.status = 'running'
    record.batchOrdinal = tonumber(record.batchOrdinal or 0) + 1
    record.lease = {
      token = ARGV[3],
      ['until'] = tonumber(ARGV[4]),
      indexes = indexes,
      batchOrdinal = record.batchOrdinal,
      claimedAt = ARGV[5]
    }
    local claimed = cjson.encode(record)
    redis.call('SET', KEYS[1], claimed)
    return {
      1,
      claimed,
      tostring(queued),
      tostring(due),
      tostring(leased)
    }
  `;
  const result = await kvImpl([
    "EVAL",
    script,
    3,
    PHASE2_REMAINDER_KEY,
    AUTO_DUE_KEY,
    AUTO_LEASES_KEY,
    String(current),
    String(cappedBatch),
    token,
    String(leaseUntil),
    new Date(current).toISOString(),
    String(PHASE2_REMAINDER_QUEUE_TOTAL_LIMIT),
    String(PHASE2_REMAINDER_QUEUE_DUE_LIMIT),
    String(PHASE2_REMAINDER_QUEUE_LEASED_LIMIT),
  ]);
  const code = Number(result?.[0]);
  const record = parse(result?.[1], null);
  const queue = {
    queued: Math.max(0, Number(result?.[2]) || 0),
    due: Math.max(0, Number(result?.[3]) || 0),
    leased: Math.max(0, Number(result?.[4]) || 0),
    totalLimit: PHASE2_REMAINDER_QUEUE_TOTAL_LIMIT,
    dueLimit: PHASE2_REMAINDER_QUEUE_DUE_LIMIT,
    leasedLimit: PHASE2_REMAINDER_QUEUE_LEASED_LIMIT,
  };
  if (code === 0) {
    return {
      claimed: false,
      status: "not_armed",
      record: null,
      entries: [],
      queue,
    };
  }
  if (![1, 2, 3, 4, 5, 7].includes(code) || !record) {
    const error = new Error("phase 2 remainder batch claim failed");
    error.code = "PHASE2_REMAINDER_CLAIM_FAILED";
    throw error;
  }
  if (!validPhase2RemainderRecord(record)) {
    const error = new Error("phase 2 remainder record is invalid");
    error.code = "PHASE2_REMAINDER_RECORD_INVALID";
    throw error;
  }
  const indexes = code === 1 || code === 4
    ? record.lease.indexes.map(Number)
    : [];
  return {
    claimed: [1, 4].includes(code),
    recovered: code === 4,
    busy: code === 3,
    saturated: code === 5,
    complete: code === 2,
    paused: code === 7,
    status: code === 2
      ? "complete"
      : code === 3
        ? "busy"
        : code === 5
          ? "waiting_for_capacity"
          : code === 7
            ? "paused"
            : "running",
    ownerToken: [1, 4].includes(code) ? token : null,
    record,
    entries: indexes.map((index) => ({
      index: index - 1,
      id: record.entries[index - 1].id,
      revision: Number(record.entries[index - 1].revision),
      resumeReady: record.entries[index - 1].resumeReady === true,
    })),
    queue,
  };
}

export async function completePhase2RemainderBatch(
  {
    ownerToken,
    manifestDigest,
    outcomes = [],
    now = Date.now(),
  } = {},
  {
    kvImpl = kv,
  } = {},
) {
  const token = String(ownerToken || "");
  const digest = String(manifestDigest || "").toLowerCase();
  const rows = Array.isArray(outcomes) ? outcomes : [];
  if (
    !token
    || !/^[a-f0-9]{64}$/u.test(digest)
    || rows.length < 1
    || rows.length > PHASE2_REMAINDER_BATCH_MAX
    || new Set(rows.map((row) => Number(row?.index))).size !== rows.length
    || rows.some((row) => (
      !Number.isInteger(Number(row?.index))
      || Number(row.index) < 0
      || !["authorized", "review", "retry"].includes(String(row?.status || ""))
      || !/^[a-z0-9_]{0,80}$/u.test(String(row?.error || ""))
    ))
  ) {
    throw new Error("phase 2 remainder completion is invalid");
  }
  const normalized = rows.map((row) => ({
    index: Number(row.index) + 1,
    status: String(row.status),
    error: String(row.error || ""),
  }));
  const completedAt = new Date(epochMs(now)).toISOString();
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return {0, ''} end
    local record = cjson.decode(raw)
    if tostring(record.manifestDigest or '') ~= ARGV[1]
      or not record.lease
      or record.lease == cjson.null
      or tostring(record.lease.token or '') ~= ARGV[2] then
      return {-1, raw}
    end
    local outcomes = cjson.decode(ARGV[4])
    if #outcomes ~= #(record.lease.indexes or {}) then
      return {-1, raw}
    end
    local expected = {}
    for _, index in ipairs(record.lease.indexes or {}) do
      expected[tonumber(index)] = true
    end
    local sawRetry = false
    local pause = false
    for _, outcome in ipairs(outcomes) do
      local index = tonumber(outcome.index)
      if not expected[index] then return {-1, raw} end
      expected[index] = nil
      local entry = record.entries[index]
      if not entry or entry.status ~= 'claimed' then return {-1, raw} end
      entry.lastAt = ARGV[3]
      if outcome.status == 'authorized' then
        entry.status = 'authorized'
        entry.authorizedAt = ARGV[3]
        entry.lastError = nil
      elseif outcome.status == 'review' then
        entry.status = 'review'
        entry.reviewedAt = ARGV[3]
        entry.lastError = outcome.error
      else
        entry.status = 'pending'
        entry.lastError = outcome.error
        sawRetry = true
        if tonumber(entry.attempts or 0) >= 3 then pause = true end
      end
    end
    for _, present in pairs(expected) do
      if present then return {-1, raw} end
    end
    record.lease = nil
    if pause then
      record.status = 'paused'
      record.pauseReason = 'release_retry_ceiling'
      record.pausedAt = ARGV[3]
    else
      local pending = false
      for _, entry in ipairs(record.entries or {}) do
        if entry.status == 'pending' or entry.status == 'claimed' then
          pending = true
          break
        end
      end
      if pending then
        record.status = 'running'
      else
        record.status = 'complete'
        record.completedAt = ARGV[3]
      end
      if sawRetry then record.lastRetryAt = ARGV[3] end
    end
    local completed = cjson.encode(record)
    redis.call('SET', KEYS[1], completed)
    return {1, completed}
  `;
  const result = await kvImpl([
    "EVAL",
    script,
    1,
    PHASE2_REMAINDER_KEY,
    digest,
    token,
    completedAt,
    JSON.stringify(normalized),
  ]);
  if (Number(result?.[0]) !== 1) {
    const error = new Error("phase 2 remainder completion conflict");
    error.code = "PHASE2_REMAINDER_COMPLETION_CONFLICT";
    throw error;
  }
  const record = parse(result?.[1], null);
  if (!validPhase2RemainderRecord(record)) {
    const error = new Error("phase 2 remainder record is invalid");
    error.code = "PHASE2_REMAINDER_RECORD_INVALID";
    throw error;
  }
  return record;
}

export async function listWaitingResumeJobs(
  limit = 200,
  {
    kvImpl = kv,
    pipelineImpl = pipeline,
    withCompleteness = false,
  } = {},
) {
  const capped = Math.max(1, Math.min(500, Number(limit) || 200));
  const ids = await kvImpl(["SMEMBERS", RESUME_WAITING_KEY]);
  if (!Array.isArray(ids)) {
    return withCompleteness
      ? {
          jobs: [],
          complete: false,
          totalWaiting: null,
          scannedCount: 0,
        }
      : [];
  }
  if (!ids.length) {
    return withCompleteness
      ? {
          jobs: [],
          complete: true,
          totalWaiting: 0,
          scannedCount: 0,
        }
      : [];
  }
  const scannedIds = ids.slice(0, 1_000);
  const values = await pipelineImpl(
    scannedIds.map((id) => ["GET", jobKey(String(id))]),
  );
  const jobs = values.map((value) => parse(value, null));
  const staleIds = scannedIds
    .filter((_id, index) => jobs[index]?.state !== "waiting_for_resume")
    .map(String);
  if (staleIds.length) {
    const pruneScript = `
      local removed = 0
      for index = 2, #KEYS do
        local raw = redis.call('GET', KEYS[index])
        local waiting = false
        if raw then
          local ok, job = pcall(cjson.decode, raw)
          waiting = ok and job and job.state == 'waiting_for_resume'
        end
        if not waiting then
          removed = removed + redis.call('SREM', KEYS[1], ARGV[index - 1])
        end
      end
      return removed
    `;
    await kvImpl([
      "EVAL", pruneScript, staleIds.length + 1,
      RESUME_WAITING_KEY,
      ...staleIds.map((id) => jobKey(id)),
      ...staleIds,
    ]);
  }
  const waiting = jobs
    .filter((job) => job?.state === "waiting_for_resume")
    .sort((left, right) => {
      const leftAt = Date.parse(left?.automation?.resumeWait?.enteredAt || left?.updatedAt || "") || 0;
      const rightAt = Date.parse(right?.automation?.resumeWait?.enteredAt || right?.updatedAt || "") || 0;
      return leftAt - rightAt || String(left?.id || "").localeCompare(String(right?.id || ""));
    });
  const complete = ids.length <= scannedIds.length && waiting.length <= capped;
  const selected = waiting.slice(0, capped);
  return withCompleteness
    ? {
        jobs: selected,
        complete,
        totalWaiting: ids.length <= scannedIds.length
          ? waiting.length
          : null,
        scannedCount: scannedIds.length,
      }
    : selected;
}

function resumeAskEventHash(eventId) {
  const value = String(eventId || "").trim();
  if (!value) throw new Error("eventId required");
  return storeHash("resume-ask-event-v1", value);
}

function resumeAskTouch(touch) {
  const value = Number(touch);
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error("valid touch required");
  }
  return value;
}

function resumeAskTimestamp(value, fallback = new Date().toISOString()) {
  const parsed = Date.parse(String(value || fallback));
  if (!Number.isFinite(parsed)) throw new Error("valid timestamp required");
  return new Date(parsed).toISOString();
}

export async function activateResumeChaseGeneration(
  candidateUserId,
  {
    jobId,
    chainId,
    chainAnchorAt,
    chainCallEndedAt = "",
    activatedAt = new Date().toISOString(),
  } = {},
  { kvImpl = kv } = {},
) {
  const scope = resumeChaseScope({
    jobId,
    chainId,
    chainAnchorAt,
    chainCallEndedAt,
  });
  const candidateHash = hashedResumeCandidateId(candidateUserId);
  const record = {
    version: 1,
    candidateHash,
    chainId: scope.chainId,
    chainAnchorAt: scope.chainAnchorAt,
    callEndedAt: scope.chainCallEndedAt || null,
    jobHash: storeHash("resume-ask-job-v1", scope.jobId),
    activatedAt: resumeAskTimestamp(activatedAt),
    status: "active",
  };
  const script = `
    local proposedEncoded = ARGV[5]
    local rawJob = redis.call('GET', KEYS[2])
    if not rawJob then return {-2, ''} end
    local job = cjson.decode(rawJob)
    if job.state ~= 'waiting_for_resume'
      or not job.identity
      or tostring(job.identity.candidateUserId or '') ~= ARGV[4]
      or not job.automation
      or not job.automation.resumeWait
      or tostring(job.automation.resumeWait.enteredAt or '') ~= ARGV[2]
      or tostring(job.callEndedAt or '') ~= ARGV[3] then
      return {-2, ''}
    end
    local raw = redis.call('GET', KEYS[1])
    if raw then
      local current = cjson.decode(raw)
      if current.chainId == ARGV[1] then return {2, raw} end
      local currentAnchor = tostring(current.chainAnchorAt or '')
      local currentCallEndedAt = tostring(current.callEndedAt or '')
      if currentAnchor > ARGV[2]
        or (currentAnchor == ARGV[2]
          and currentCallEndedAt > ARGV[3])
        or (currentAnchor == ARGV[2]
          and currentCallEndedAt == ARGV[3]
          and tostring(current.chainId or '') > ARGV[1]) then
        return {-1, raw}
      end
      local proposed = cjson.decode(proposedEncoded)
      local currentTerminal = current.status == 'terminal'
        or tonumber(current.lastDeliveredTouch or 0) >= 3
        or (current.terminalAck
          and (current.terminalAck.outcome == 'delivered'
            or current.terminalAck.outcome == 'terminal_no_send'))
      if not currentTerminal then
        proposed.lastTouch = tonumber(current.lastTouch or 0)
        proposed.lastDeliveredTouch =
          tonumber(current.lastDeliveredTouch or 0)
        proposed.lastClaimedAt = current.lastClaimedAt
        proposed.lastSentAt = current.lastSentAt
        proposed.carriedFromChainId = current.chainId
        if current.pendingClaimLineage then
          proposed.pendingClaimLineage = current.pendingClaimLineage
        end
      else
        proposed.resetFromChainId = current.chainId
      end
      proposedEncoded = cjson.encode(proposed)
    end
    redis.call('SET', KEYS[1], proposedEncoded, 'EX', ARGV[6])
    return {1, proposedEncoded}
  `;
  const result = await kvImpl([
    "EVAL", script, 2,
    resumeCurrentChainKey(candidateUserId),
    jobKey(scope.jobId),
    scope.chainId,
    scope.chainAnchorAt,
    scope.chainCallEndedAt,
    String(candidateUserId).trim(),
    JSON.stringify(record),
    String(JOB_TTL_SECONDS),
  ]);
  const code = Number(result?.[0]);
  const current = parse(result?.[1], null);
  if (code === -2) {
    return {
      status: "chain_conflict",
      current: false,
      idempotent: false,
      record: null,
    };
  }
  if (![1, 2, -1].includes(code) || !current) {
    throw new Error("resume chase generation activation failed");
  }
  return {
    status: code === 1
      ? "activated"
      : code === 2
        ? "existing"
        : "superseded",
    current: code !== -1,
    idempotent: code === 2,
    record: current,
  };
}

export async function claimResumeAskSuppression(
  candidateUserId,
  {
    eventId,
    touch,
    jobId,
    chainId,
    chainAnchorAt,
    chainCallEndedAt = "",
    source = "resume_chase",
    claimedAt = new Date().toISOString(),
    dueAt = null,
  } = {},
  { kvImpl = kv } = {},
) {
  const candidateHash = hashedResumeCandidateId(candidateUserId);
  const scope = resumeChaseScope({
    jobId,
    chainId,
    chainAnchorAt,
    chainCallEndedAt,
  });
  const touchNumber = resumeAskTouch(touch);
  const eventHash = resumeAskEventHash(eventId);
  const claim = {
    eventHash,
    touch: touchNumber,
    source: String(source || "resume_chase").replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 80) || "resume_chase",
    claimedAt: resumeAskTimestamp(claimedAt),
    ...(dueAt ? { dueAt: resumeAskTimestamp(dueAt) } : {}),
    jobHash: storeHash("resume-ask-job-v1", scope.jobId),
  };
  const generation = {
    version: 1,
    candidateHash,
    chainId: scope.chainId,
    chainAnchorAt: scope.chainAnchorAt,
    callEndedAt: scope.chainCallEndedAt || null,
    jobHash: claim.jobHash,
    activatedAt: claim.claimedAt,
    status: "active",
  };
  const script = `
    local raw = redis.call('GET', KEYS[1])
    local record = nil
    if raw then
      local ok
      ok, record = pcall(cjson.decode, raw)
      if not ok then record = nil end
    end
    local nextClaim = cjson.decode(ARGV[3])
    local function pendingLineageMatches(value)
      local lineage = value and value.pendingClaimLineage or nil
      return lineage
        and tostring(lineage.eventHash or '') == nextClaim.eventHash
        and tonumber(lineage.touch or 0) == tonumber(ARGV[2])
        and tostring(lineage.originChainId or '') == ARGV[5]
    end
    local replayClaim = record
      and record.claims
      and record.claims[ARGV[2]]
      or nil
    if replayClaim
      and tostring(record.chainId or '') == ARGV[5]
      and replayClaim.eventHash == nextClaim.eventHash
      and replayClaim.deliveredAt then
      return {2, raw}
    end
    local rawJob = redis.call('GET', KEYS[2])
    if not rawJob then return {-3, ''} end
    local job = cjson.decode(rawJob)
    if job.state ~= 'waiting_for_resume' then return {-3, ''} end
    if not job.identity or tostring(job.identity.candidateUserId or '') ~= ARGV[8] then
      return {-4, ''}
    end
    if not job.automation or not job.automation.resumeWait
      or tostring(job.automation.resumeWait.enteredAt or '') ~= ARGV[6]
      or tostring(job.callEndedAt or '') ~= ARGV[7] then
      return {-6, ''}
    end
    local currentRaw = redis.call('GET', KEYS[4])
    local current = nil
    if currentRaw then
      current = cjson.decode(currentRaw)
      if current.chainId ~= ARGV[5] then
        local currentAnchor = tostring(current.chainAnchorAt or '')
        local currentCallEndedAt = tostring(current.callEndedAt or '')
        local currentIsNewer = currentAnchor > ARGV[6]
          or (currentAnchor == ARGV[6]
            and currentCallEndedAt > ARGV[7])
          or (currentAnchor == ARGV[6]
            and currentCallEndedAt == ARGV[7]
            and tostring(current.chainId or '') > ARGV[5])
        if currentIsNewer then
          if current.pendingClaimLineage
            and not pendingLineageMatches(current) then
            return {-11, currentRaw}
          end
          if not pendingLineageMatches(current) then
            return {-7, currentRaw}
          end
        else
          local proposed = cjson.decode(ARGV[9])
          local currentTerminal = current.status == 'terminal'
            or tonumber(current.lastDeliveredTouch or 0) >= 3
            or (current.terminalAck
              and (current.terminalAck.outcome == 'delivered'
                or current.terminalAck.outcome == 'terminal_no_send'))
          if not currentTerminal then
            proposed.lastTouch = tonumber(current.lastTouch or 0)
            proposed.lastDeliveredTouch =
              tonumber(current.lastDeliveredTouch or 0)
            proposed.lastClaimedAt = current.lastClaimedAt
            proposed.lastSentAt = current.lastSentAt
            proposed.carriedFromChainId = current.chainId
            if current.pendingClaimLineage then
              proposed.pendingClaimLineage = current.pendingClaimLineage
            end
          else
            proposed.resetFromChainId = current.chainId
          end
          current = proposed
          currentRaw = cjson.encode(current)
          redis.call('SET', KEYS[4], currentRaw, 'EX', ARGV[4])
        end
      end
    else
      current = cjson.decode(ARGV[9])
      currentRaw = ARGV[9]
      redis.call('SET', KEYS[4], currentRaw, 'EX', ARGV[4])
    end
    local terminal = job.automation.resumeWait.terminalAck
    local claimDeadline = tostring(
      job.automation.resumeWait.claimableThroughAt or ''
    )
    if claimDeadline == ''
      and terminal
      and terminal.status == 'awaiting_ack' then
      claimDeadline = tostring(terminal.opsDeadlineAt or '')
    end
    if claimDeadline ~= ''
      and nextClaim.claimedAt > claimDeadline then
      return {-8, ''}
    end
    local satisfactionRaw = redis.call('GET', KEYS[3])
    if satisfactionRaw then return {-5, satisfactionRaw} end
    if not record then
      record = {
        version = 2,
        candidateHash = ARGV[1],
        chainId = ARGV[5],
        chainAnchorAt = ARGV[6],
        status = 'active',
        stopped = false,
        claims = {}
      }
    end
    if record.stopped == true or record.status == 'stopped' then
      return {-1, cjson.encode(record)}
    end
    if not record.claims then record.claims = {} end
    local touchKey = ARGV[2]
    local existing = record.claims[touchKey]
    if existing then
      if existing.eventHash == nextClaim.eventHash then
        if existing.deliveredAt then
          return {2, cjson.encode(record)}
        end
        if pendingLineageMatches(current) then
          return {2, cjson.encode(record)}
        end
        if current.chainId == ARGV[5]
          and not current.pendingClaimLineage then
          current.pendingClaimLineage = {
            eventHash = nextClaim.eventHash,
            touch = tonumber(ARGV[2]),
            originChainId = ARGV[5]
          }
          currentRaw = cjson.encode(current)
          redis.call('SET', KEYS[4], currentRaw, 'EX', ARGV[4])
          return {2, cjson.encode(record)}
        end
        return {-11, currentRaw}
      end
      return {-2, cjson.encode(record)}
    end
    if current.pendingClaimLineage
      or tonumber(current.lastTouch or 0)
        > tonumber(current.lastDeliveredTouch or 0) then
      return {-11, currentRaw}
    end
    local carriedTouch = tonumber(current.lastTouch or 0)
    local requestedTouch = tonumber(ARGV[2])
    if carriedTouch >= 3 then
      return {-9, currentRaw}
    end
    if requestedTouch ~= carriedTouch + 1 then
      return {-10, currentRaw}
    end
    record.claims[touchKey] = nextClaim
    record.lastTouch = requestedTouch
    record.lastClaimedAt = nextClaim.claimedAt
    current.lastTouch = requestedTouch
    current.lastClaimedAt = nextClaim.claimedAt
    current.pendingClaimLineage = {
      eventHash = nextClaim.eventHash,
      touch = requestedTouch,
      originChainId = ARGV[5]
    }
    currentRaw = cjson.encode(current)
    local encoded = cjson.encode(record)
    redis.call('SET', KEYS[4], currentRaw, 'EX', ARGV[4])
    redis.call('SET', KEYS[1], encoded, 'EX', ARGV[4])
    return {1, encoded}
  `;
  const result = await kvImpl([
    "EVAL", script, 4,
    resumeAskKey(candidateUserId, scope.chainId),
    jobKey(scope.jobId),
    resumeSatisfactionKey(candidateUserId),
    resumeCurrentChainKey(candidateUserId),
    candidateHash, String(touchNumber), JSON.stringify(claim), String(JOB_TTL_SECONDS),
    scope.chainId, scope.chainAnchorAt, scope.chainCallEndedAt,
    String(candidateUserId).trim(), JSON.stringify(generation),
  ]);
  const code = Number(result?.[0]);
  const record = parse(result?.[1], null);
  if (code === -3) {
    return { status: "not_waiting", allowed: false, idempotent: false, record: null };
  }
  if (code === -4) {
    return { status: "candidate_conflict", allowed: false, idempotent: false, record: null };
  }
  if (code === -5) {
    return {
      status: "candidate_satisfied",
      allowed: false,
      idempotent: true,
      confirmed: false,
      record: null,
      candidateSatisfaction: record,
    };
  }
  if (code === -6) {
    return { status: "chain_conflict", allowed: false, idempotent: false, record: null };
  }
  if (code === -7) {
    return {
      status: "superseded",
      allowed: false,
      idempotent: false,
      record: null,
      currentGeneration: record,
    };
  }
  if (code === -8) {
    return {
      status: "deadline_elapsed",
      allowed: false,
      idempotent: false,
      record: null,
    };
  }
  if (code === -9) {
    return {
      status: "candidate_touch_cap",
      allowed: false,
      idempotent: true,
      confirmed: false,
      record: null,
      currentGeneration: record,
    };
  }
  if (code === -10) {
    return {
      status: "touch_sequence_conflict",
      allowed: false,
      idempotent: false,
      confirmed: false,
      record: null,
      currentGeneration: record,
    };
  }
  if (code === -11) {
    return {
      status: "pending_claim_conflict",
      allowed: false,
      idempotent: false,
      confirmed: false,
      record: null,
      currentGeneration: record,
    };
  }
  if (![1, 2, -1, -2].includes(code) || !record) {
    throw new Error("resume ask suppression claim failed");
  }
  const existingClaim = record?.claims?.[String(touchNumber)] || record?.claims?.[touchNumber] || null;
  const existingSent = Boolean(existingClaim?.deliveredAt);
  return {
    status: code === 1
      ? "claimed"
      : code === 2
        ? existingSent ? "sent" : "pending"
        : code === -1 ? "stopped" : "touch_conflict",
    // The deterministic event id is the owner token. An unconfirmed replay by
    // that same owner must recover permission after a lost HTTP response;
    // otherwise a committed remote claim can permanently strand an unsent
    // touch. A different event remains fenced, and a confirmed claim never
    // authorizes another delivery.
    allowed: code === 1 || (code === 2 && !existingSent),
    idempotent: code === 2,
    confirmed: existingSent,
    record,
  };
}

export async function confirmResumeAskSuppression(
  candidateUserId,
  {
    eventId,
    touch,
    jobId,
    chainId,
    chainAnchorAt,
    chainCallEndedAt = "",
    deliveredAt = new Date().toISOString(),
    deliveryDigest = "",
  } = {},
  { kvImpl = kv } = {},
) {
  const scope = resumeChaseScope({
    jobId,
    chainId,
    chainAnchorAt,
    chainCallEndedAt,
  });
  const touchNumber = resumeAskTouch(touch);
  const eventHash = resumeAskEventHash(eventId);
  const confirmation = {
    deliveredAt: resumeAskTimestamp(deliveredAt),
    ...(deliveryDigest
      ? { deliveryDigest: storeHash("resume-ask-delivery-v1", String(deliveryDigest)) }
      : {}),
  };
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return {-1, ''} end
    local record = cjson.decode(raw)
    local replayClaim = record.claims and record.claims[ARGV[1]] or nil
    if replayClaim
      and replayClaim.eventHash == ARGV[2]
      and replayClaim.deliveredAt
      and (tonumber(ARGV[1]) ~= 3
        or (record.terminalAck
          and record.terminalAck.eventHash == ARGV[2]
          and record.terminalAck.outcome == 'delivered')) then
      return {2, raw}
    end
    local rawJob = redis.call('GET', KEYS[2])
    if not rawJob then return {-4, raw} end
    local job = cjson.decode(rawJob)
    if job.state ~= 'waiting_for_resume'
      or not job.identity
      or tostring(job.identity.candidateUserId or '') ~= ARGV[8]
      or not job.automation
      or not job.automation.resumeWait
      or tostring(job.automation.resumeWait.enteredAt or '') ~= ARGV[6]
      or tostring(job.callEndedAt or '') ~= ARGV[7] then
      return {-4, raw}
    end
    local currentRaw = redis.call('GET', KEYS[3])
    if not currentRaw then return {-6, raw} end
    local current = cjson.decode(currentRaw)
    if not record.claims then return {-2, raw} end
    local claim = record.claims[ARGV[1]]
    if not claim then return {-2, raw} end
    if claim.eventHash ~= ARGV[2] then return {-3, raw} end
    local lineage = current.pendingClaimLineage
    local lineageMatches = lineage
      and tostring(lineage.eventHash or '') == ARGV[2]
      and tonumber(lineage.touch or 0) == tonumber(ARGV[1])
      and tostring(lineage.originChainId or '') == ARGV[5]
    if current.chainId ~= ARGV[5] then
      if not lineage then return {-6, raw} end
      if not lineageMatches then return {-7, raw} end
    end
    if lineage and not lineageMatches then return {-7, raw} end
    local confirmation = cjson.decode(ARGV[3])
    local function recordDelivered(deliveredAt)
      local touch = tonumber(ARGV[1])
      if current.pendingClaimLineage then
        current.pendingClaimLineage = nil
      end
      current.lastTouch = math.max(
        tonumber(current.lastTouch or 0),
        touch
      )
      if touch >= tonumber(current.lastDeliveredTouch or 0) then
        current.lastDeliveredTouch = touch
        current.lastSentAt = deliveredAt
      end
      if touch == 3 then
        current.status = 'terminal'
        current.terminalAt = deliveredAt
        current.terminalReason = 'three_touches_delivered'
        current.terminalAck = {
          touch = 3,
          eventHash = ARGV[2],
          outcome = 'delivered',
          acknowledgedAt = deliveredAt
        }
      end
      redis.call(
        'SET',
        KEYS[3],
        cjson.encode(current),
        'EX',
        ARGV[4]
      )
    end
    if record.terminalAck
      and (record.terminalAck.eventHash ~= ARGV[2]
        or record.terminalAck.outcome ~= 'delivered') then
      return {-5, raw}
    end
    if claim.deliveredAt then
      if tonumber(ARGV[1]) == 3 and not record.terminalAck then
        record.terminalAck = {
          touch = 3,
          eventHash = ARGV[2],
          outcome = 'delivered',
          acknowledgedAt = claim.deliveredAt
        }
        local repaired = cjson.encode(record)
        recordDelivered(claim.deliveredAt)
        redis.call('SET', KEYS[1], repaired, 'EX', ARGV[4])
        return {2, repaired}
      end
      recordDelivered(claim.deliveredAt)
      return {2, raw}
    end
    claim.deliveredAt = confirmation.deliveredAt
    if confirmation.deliveryDigest then claim.deliveryDigest = confirmation.deliveryDigest end
    record.claims[ARGV[1]] = claim
    record.lastTouch = tonumber(ARGV[1])
    record.lastDeliveredTouch = math.max(
      tonumber(record.lastDeliveredTouch or 0),
      tonumber(ARGV[1])
    )
    record.lastSentAt = confirmation.deliveredAt
    if tonumber(ARGV[1]) == 3 then
      record.terminalAck = {
        touch = 3,
        eventHash = ARGV[2],
        outcome = 'delivered',
        acknowledgedAt = confirmation.deliveredAt
      }
    end
    recordDelivered(confirmation.deliveredAt)
    local encoded = cjson.encode(record)
    redis.call('SET', KEYS[1], encoded, 'EX', ARGV[4])
    return {1, encoded}
  `;
  const result = await kvImpl([
    "EVAL", script, 3,
    resumeAskKey(candidateUserId, scope.chainId),
    jobKey(scope.jobId),
    resumeCurrentChainKey(candidateUserId),
    String(touchNumber), eventHash, JSON.stringify(confirmation), String(JOB_TTL_SECONDS),
    scope.chainId, scope.chainAnchorAt, scope.chainCallEndedAt,
    String(candidateUserId).trim(),
  ]);
  const code = Number(result?.[0]);
  const record = parse(result?.[1], null);
  if (code === -1) return { status: "missing", confirmed: false, idempotent: false, record: null };
  if (code === -2) return { status: "unclaimed", confirmed: false, idempotent: false, record };
  if (code === -3) return { status: "event_conflict", confirmed: false, idempotent: false, record };
  if (code === -4) return { status: "chain_conflict", confirmed: false, idempotent: false, record };
  if (code === -5) return { status: "terminal_conflict", confirmed: false, idempotent: false, record };
  if (code === -6) return { status: "superseded", confirmed: false, idempotent: false, record };
  if (code === -7) return { status: "pending_claim_conflict", confirmed: false, idempotent: false, record };
  if (![1, 2].includes(code) || !record) throw new Error("resume ask suppression confirmation failed");
  return {
    status: code === 1 ? "confirmed" : "existing",
    confirmed: true,
    idempotent: code === 2,
    record,
  };
}

export async function ackResumeAskTerminal(
  candidateUserId,
  {
    eventId,
    touch,
    jobId,
    chainId,
    chainAnchorAt,
    chainCallEndedAt = "",
    outcome,
    acknowledgedAt = new Date().toISOString(),
    deliveryDigest = "",
  } = {},
  { kvImpl = kv } = {},
) {
  const scope = resumeChaseScope({
    jobId,
    chainId,
    chainAnchorAt,
    chainCallEndedAt,
  });
  const touchNumber = resumeAskTouch(touch);
  if (touchNumber !== 3) throw new Error("terminal acknowledgement requires touch 3");
  const selectedOutcome = String(outcome || "");
  if (!["delivered", "terminal_no_send"].includes(selectedOutcome)) {
    throw new Error("valid terminal acknowledgement outcome required");
  }
  const eventHash = resumeAskEventHash(eventId);
  const at = resumeAskTimestamp(acknowledgedAt);
  const digest = deliveryDigest
    ? storeHash("resume-ask-delivery-v1", String(deliveryDigest))
    : "";
  const script = `
    local function markCurrentTerminal(reason, terminalAt, terminalAck)
      local currentRaw = redis.call('GET', KEYS[3])
      if not currentRaw then return end
      local ok, current = pcall(cjson.decode, currentRaw)
      if not ok or current.chainId ~= ARGV[6] then return end
      current.status = 'terminal'
      current.terminalAt = terminalAt
      current.terminalReason = reason
      if terminalAck then current.terminalAck = terminalAck end
      redis.call(
        'SET',
        KEYS[3],
        cjson.encode(current),
        'EX',
        ARGV[11]
      )
    end
    local raw = redis.call('GET', KEYS[1])
    local record = nil
    if raw then
      local ok
      ok, record = pcall(cjson.decode, raw)
      if not ok then record = nil end
    end
    if record and record.terminalAck
      and record.terminalAck.eventHash == ARGV[2]
      and record.terminalAck.outcome == ARGV[3] then
      markCurrentTerminal(
        ARGV[3] == 'delivered'
          and 'three_touches_delivered'
          or 'terminal_no_send',
        record.terminalAck.acknowledgedAt or ARGV[4],
        record.terminalAck
      )
      return {2, cjson.encode(record)}
    end
    if record
      and (record.stopped == true or record.status == 'stopped')
      and ARGV[3] == 'terminal_no_send' then
      if not record.claims then record.claims = {} end
      local stoppedClaim = record.claims['3']
      if stoppedClaim and stoppedClaim.eventHash ~= ARGV[2] then
        return {-2, cjson.encode(record)}
      end
      if not stoppedClaim then
        record.claims['3'] = {
          eventHash = ARGV[2],
          touch = 3,
          source = 'terminal_no_send',
          claimedAt = ARGV[4],
          jobHash = ARGV[10]
        }
      end
      record.terminalAck = {
        touch = 3,
        eventHash = ARGV[2],
        outcome = 'terminal_no_send',
        acknowledgedAt = ARGV[4]
      }
      markCurrentTerminal(
        tostring(record.stopReason or 'terminal_no_send'),
        ARGV[4],
        record.terminalAck
      )
      local stoppedEncoded = cjson.encode(record)
      redis.call('SET', KEYS[1], stoppedEncoded, 'EX', ARGV[11])
      return {1, stoppedEncoded}
    end
    local rawJob = redis.call('GET', KEYS[2])
    if not rawJob then return {-4, ''} end
    local job = cjson.decode(rawJob)
    if job.state ~= 'waiting_for_resume'
      or not job.identity
      or tostring(job.identity.candidateUserId or '') ~= ARGV[9]
      or not job.automation
      or not job.automation.resumeWait
      or tostring(job.automation.resumeWait.enteredAt or '') ~= ARGV[7]
      or tostring(job.callEndedAt or '') ~= ARGV[8] then
      return {-4, ''}
    end
    local currentRaw = redis.call('GET', KEYS[3])
    if not currentRaw then return {-5, ''} end
    local current = cjson.decode(currentRaw)
    if current.chainId ~= ARGV[6] then return {-5, ''} end
    if not record then
      record = {
        version = 2,
        candidateHash = ARGV[1],
        chainId = ARGV[6],
        chainAnchorAt = ARGV[7],
        status = 'active',
        stopped = false,
        claims = {}
      }
    end
    if record.terminalAck then
      return {-3, cjson.encode(record)}
    end
    if not record.claims then record.claims = {} end
    local claim = record.claims['3']
    if ARGV[3] == 'delivered' then
      if not claim then return {-1, cjson.encode(record)} end
      if claim.eventHash ~= ARGV[2] then return {-2, cjson.encode(record)} end
      claim.deliveredAt = claim.deliveredAt or ARGV[4]
      if ARGV[5] ~= '' then claim.deliveryDigest = ARGV[5] end
      record.claims['3'] = claim
      record.lastTouch = 3
      record.lastSentAt = claim.deliveredAt
    else
      if claim and claim.eventHash ~= ARGV[2] then
        return {-2, cjson.encode(record)}
      end
      if not claim then
        claim = {
          eventHash = ARGV[2],
          touch = 3,
          source = 'terminal_no_send',
          claimedAt = ARGV[4],
          jobHash = ARGV[10]
        }
        record.claims['3'] = claim
      end
      record.status = 'stopped'
      record.stopped = true
      record.stoppedAt = ARGV[4]
      record.stopReason = 'terminal_no_send'
      record.stopScope = 'chain'
    end
    record.terminalAck = {
      touch = 3,
      eventHash = ARGV[2],
      outcome = ARGV[3],
      acknowledgedAt = ARGV[4]
    }
    if ARGV[3] == 'delivered' then
      current.lastTouch = math.max(
        tonumber(current.lastTouch or 0),
        3
      )
      current.lastDeliveredTouch = 3
      current.lastSentAt = record.lastSentAt or ARGV[4]
      redis.call(
        'SET',
        KEYS[3],
        cjson.encode(current),
        'EX',
        ARGV[11]
      )
    end
    markCurrentTerminal(
      ARGV[3] == 'delivered'
        and 'three_touches_delivered'
        or 'terminal_no_send',
      ARGV[4],
      record.terminalAck
    )
    local encoded = cjson.encode(record)
    redis.call('SET', KEYS[1], encoded, 'EX', ARGV[11])
    return {1, encoded}
  `;
  const result = await kvImpl([
    "EVAL", script, 3,
    resumeAskKey(candidateUserId, scope.chainId),
    jobKey(scope.jobId),
    resumeCurrentChainKey(candidateUserId),
    hashedResumeCandidateId(candidateUserId),
    eventHash,
    selectedOutcome,
    at,
    digest,
    scope.chainId,
    scope.chainAnchorAt,
    scope.chainCallEndedAt,
    String(candidateUserId).trim(),
    storeHash("resume-ask-job-v1", scope.jobId),
    String(JOB_TTL_SECONDS),
  ]);
  const code = Number(result?.[0]);
  const record = parse(result?.[1], null);
  if (code === -1) return { status: "unclaimed", acknowledged: false, idempotent: false, record };
  if (code === -2) return { status: "event_conflict", acknowledged: false, idempotent: false, record };
  if (code === -3) return { status: "terminal_conflict", acknowledged: false, idempotent: false, record };
  if (code === -4) return { status: "chain_conflict", acknowledged: false, idempotent: false, record };
  if (code === -5) return { status: "superseded", acknowledged: false, idempotent: false, record };
  if (![1, 2].includes(code) || !record) {
    throw new Error("resume ask terminal acknowledgement failed");
  }
  return {
    status: code === 1 ? "acknowledged" : "existing",
    acknowledged: true,
    idempotent: code === 2,
    outcome: selectedOutcome,
    record,
  };
}

export async function getResumeAskSuppression(
  candidateUserId,
  {
    chainId,
    kvImpl = kv,
  } = {},
) {
  const selectedChainId = requireResumeChaseChainId(chainId);
  const raw = await kvImpl([
    "MGET",
    resumeAskKey(candidateUserId, selectedChainId),
    resumeSatisfactionKey(candidateUserId),
    resumeCurrentChainKey(candidateUserId),
  ]);
  const chain = parse(Array.isArray(raw) ? raw[0] : null, null);
  const candidateSatisfaction = parse(
    Array.isArray(raw) ? raw[1] : null,
    null,
  );
  const currentGeneration = parse(
    Array.isArray(raw) ? raw[2] : null,
    null,
  );
  if (!chain && !candidateSatisfaction && !currentGeneration) return null;
  return {
    version: 2,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId: selectedChainId,
    chain,
    candidateSatisfaction,
    currentGeneration,
  };
}

const CANDIDATE_PERMANENT_RESUME_STOP_REASONS = new Set([
  "resume_attached",
  "resume_detected",
  "resume_received",
  "resume_received_review",
  "already_submitted",
  "submission_confirmed",
]);

export async function stopResumeAskSuppression(
  candidateUserId,
  {
    reason = "stopped",
    stoppedAt = new Date().toISOString(),
    jobId,
    chainId,
    chainAnchorAt,
    chainCallEndedAt = "",
  } = {},
  { kvImpl = kv } = {},
) {
  const scope = resumeChaseScope({
    jobId,
    chainId,
    chainAnchorAt,
    chainCallEndedAt,
  });
  const candidateHash = hashedResumeCandidateId(candidateUserId);
  const safeReason = String(reason || "stopped")
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, "_")
    .slice(0, 80) || "stopped";
  const at = resumeAskTimestamp(stoppedAt);
  const permanent = CANDIDATE_PERMANENT_RESUME_STOP_REASONS.has(safeReason);
  const script = `
    local function receiptReasonRank(reason)
      if reason == 'resume_received_review' then return 2 end
      if reason == 'resume_received' then return 1 end
      return 0
    end
    local function protectedSatisfiedReason(reason)
      return reason == 'resume_attached'
        or reason == 'resume_detected'
        or reason == 'already_submitted'
        or reason == 'submission_confirmed'
    end
    local function shouldUpgradeReceiptReason(existingReason, incomingReason)
      local incomingRank = receiptReasonRank(incomingReason)
      if incomingRank == 0 then return false end
      local existingRank = receiptReasonRank(existingReason)
      if existingRank > 0 then return incomingRank > existingRank end
      return not protectedSatisfiedReason(existingReason)
    end
    local function markCurrentTerminal(reason)
      local currentRaw = redis.call('GET', KEYS[4])
      if not currentRaw then return end
      local ok, current = pcall(cjson.decode, currentRaw)
      if not ok then return end
      if current.chainId ~= ARGV[5] then
        local lineage = current.pendingClaimLineage
        if lineage
          and tostring(lineage.originChainId or '') == ARGV[5] then
          current.pendingClaimLineage = nil
          current.lastTouch =
            tonumber(current.lastDeliveredTouch or 0)
          current.lastClaimedAt = current.lastSentAt
          redis.call(
            'SET',
            KEYS[4],
            cjson.encode(current),
            'EX',
            ARGV[9]
          )
        end
        return
      end
      current.status = 'terminal'
      current.terminalAt = ARGV[2]
      current.terminalReason = reason or ARGV[3]
      redis.call(
        'SET',
        KEYS[4],
        cjson.encode(current),
        'EX',
        ARGV[9]
      )
    end
    local function ensureCandidateSatisfaction()
      if ARGV[4] ~= '1' then return false end
      local satisfactionRaw = redis.call('GET', KEYS[3])
      if satisfactionRaw then
        local ok, satisfaction = pcall(cjson.decode, satisfactionRaw)
        if ok
          and satisfaction.reason == 'resume_received'
          and ARGV[3] == 'resume_received_review' then
          satisfaction.reason = ARGV[3]
          satisfaction.reasonUpdatedAt = ARGV[2]
          redis.call(
            'SET',
            KEYS[3],
            cjson.encode(satisfaction),
            'EX',
            ARGV[9]
          )
          return true
        end
        return false
      end
      local satisfaction = {
        version = 1,
        candidateHash = ARGV[1],
        satisfied = true,
        satisfiedAt = ARGV[2],
        reason = ARGV[3]
      }
      redis.call(
        'SET',
        KEYS[3],
        cjson.encode(satisfaction),
        'EX',
        ARGV[9]
      )
      return true
    end
    local function ensureCancellationAt(value)
      if ARGV[3] ~= 'cancelled' or value.cancellationAt then
        return false
      end
      if value.stopReason == 'cancelled' and value.stoppedAt then
        value.cancellationAt = value.stoppedAt
      else
        value.cancellationAt = ARGV[2]
      end
      return true
    end
    local raw = redis.call('GET', KEYS[1])
    local record = nil
    if raw then
      local ok
      ok, record = pcall(cjson.decode, raw)
      if not ok then record = nil end
    end
    if record
      and (record.stopped == true or record.status == 'stopped')
      and record.stopReason == ARGV[3] then
      local satisfactionChanged = ensureCandidateSatisfaction()
      local cancellationChanged = ensureCancellationAt(record)
      local encoded = cjson.encode(record)
      if cancellationChanged then
        redis.call('SET', KEYS[1], encoded, 'EX', ARGV[9])
      end
      markCurrentTerminal(record.stopReason)
      return {
        (satisfactionChanged or cancellationChanged) and 1 or 2,
        encoded
      }
    end
    local rawJob = redis.call('GET', KEYS[2])
    if not rawJob then return {-1, ''} end
    local job = cjson.decode(rawJob)
    if not job.identity
      or tostring(job.identity.candidateUserId or '') ~= ARGV[8]
      or not job.automation
      or not job.automation.resumeWait
      or tostring(job.automation.resumeWait.enteredAt or '') ~= ARGV[6]
      or tostring(job.callEndedAt or '') ~= ARGV[7] then
      return {-1, ''}
    end
    if not record then
      record = {
        version = 2,
        candidateHash = ARGV[1],
        chainId = ARGV[5],
        chainAnchorAt = ARGV[6],
        claims = {}
      }
    end
    local changed = false
    if not (record.stopped == true or record.status == 'stopped') then
      record.status = 'stopped'
      record.stopped = true
      record.stoppedAt = ARGV[2]
      record.stopReason = ARGV[3]
      record.stopScope = ARGV[4] == '1' and 'candidate' or 'chain'
      changed = true
    elseif shouldUpgradeReceiptReason(record.stopReason, ARGV[3]) then
      if record.stopReason == 'cancelled'
        and not record.cancellationAt then
        record.cancellationAt = record.stoppedAt or ARGV[2]
      end
      record.stopReason = ARGV[3]
      record.stopScope = 'candidate'
      record.reasonUpdatedAt = ARGV[2]
      changed = true
    end
    if ensureCancellationAt(record) then changed = true end
    if ensureCandidateSatisfaction() then changed = true end
    local encoded = cjson.encode(record)
    markCurrentTerminal(record.stopReason)
    redis.call('SET', KEYS[1], encoded, 'EX', ARGV[9])
    return {changed and 1 or 2, encoded}
  `;
  const result = await kvImpl([
    "EVAL", script, 4,
    resumeAskKey(candidateUserId, scope.chainId),
    jobKey(scope.jobId),
    resumeSatisfactionKey(candidateUserId),
    resumeCurrentChainKey(candidateUserId),
    candidateHash,
    at,
    safeReason,
    permanent ? "1" : "0",
    scope.chainId,
    scope.chainAnchorAt,
    scope.chainCallEndedAt,
    String(candidateUserId).trim(),
    String(JOB_TTL_SECONDS),
  ]);
  const code = Number(result?.[0]);
  const record = parse(result?.[1], null);
  if (code === -1) {
    return {
      status: "chain_conflict",
      stopped: false,
      idempotent: false,
      permanent,
      record: null,
    };
  }
  if (![1, 2].includes(code) || !record) throw new Error("resume ask suppression stop failed");
  return {
    status: code === 1 ? "stopped" : "existing",
    stopped: true,
    idempotent: code === 2,
    permanent,
    record,
  };
}

export function reclaimableLegacyJobLock(value, ttlSeconds, state) {
  const ttl = Number(ttlSeconds);
  return Boolean(
    value
    && !String(value).startsWith("v2:")
    && state === "ready_to_submit"
    && Number.isFinite(ttl)
    && ttl >= 0
    && ttl <= LEGACY_JOB_LOCK_TTL_SECONDS - LEGACY_JOB_LOCK_STALE_AFTER_SECONDS
  );
}

export async function acquireJobLock(id, { ttlSeconds = JOB_LOCK_TTL_SECONDS, reclaimLegacyReady = false } = {}) {
  const token = `v2:${randomUUID()}`;
  const ttl = Math.max(30, Number(ttlSeconds) || JOB_LOCK_TTL_SECONDS);
  const result = await kv(["SET", lockKey(id), token, "NX", "EX", ttl]);
  if (result === "OK") return token;
  if (!reclaimLegacyReady) return null;

  // Locks created before v2 survived for 330 seconds, while the function that
  // owned them could run for at most 120. Reclaim only that legacy shape, only
  // after the runtime ceiling, and only while the durable job is still safely
  // waiting for its first write. New v2 locks simply expire after 150 seconds.
  const [existing, remaining, rawJob] = await pipeline([
    ["GET", lockKey(id)],
    ["TTL", lockKey(id)],
    ["GET", jobKey(id)],
  ]);
  const job = parse(rawJob, null);
  if (!reclaimableLegacyJobLock(existing, remaining, job?.state)) return null;
  if (!(await releaseJobLock(id, existing))) return null;
  const retry = await kv(["SET", lockKey(id), token, "NX", "EX", ttl]);
  return retry === "OK" ? token : null;
}

export async function releaseJobLock(id, token) {
  if (!token) return false;
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  return Number(await kv(["EVAL", script, 1, lockKey(id), token])) === 1;
}

export async function takeAlertSlot(key, ttlSeconds = 12 * 60 * 60) {
  const result = await kv(["SET", alertKey(key), new Date().toISOString(), "NX", "EX", Math.max(60, ttlSeconds)]);
  return result === "OK";
}

export async function enqueueAutoJob(
  botId,
  {
    source = "unknown",
    eventId = "",
    dueAt = null,
    callEndedAt = null,
    now = Date.now(),
  } = {},
  { kvImpl = kv } = {},
) {
  const id = requireStoreId(botId, "bot id");
  const queuedAt = epochMs(now);
  const due = epochMs(dueAt, queuedAt);
  const dedupeId = String(eventId || randomUUID());
  const eventKey = autoEventKey(dedupeId);
  const eventValue = JSON.stringify({
    botId: id,
    source: String(source || "unknown").slice(0, 80),
    receivedAt: new Date(queuedAt).toISOString(),
  });
  const metaValue = JSON.stringify({
    source: String(source || "unknown").slice(0, 80),
    enqueuedAt: new Date(queuedAt).toISOString(),
    generation: randomUUID(),
    ...(callEndedAt ? { callEndedAt: new Date(epochMs(callEndedAt, queuedAt)).toISOString() } : {}),
  });
  const script = `
    local recorded = redis.call('SET', KEYS[2], ARGV[3], 'NX', 'EX', ARGV[4])
    local current = redis.call('ZSCORE', KEYS[1], ARGV[1])
    if not recorded then
      return {0, current or ''}
    end
    local next = cjson.decode(ARGV[5])
    local raw = redis.call('GET', KEYS[3])
    if raw then
      local ok, old = pcall(cjson.decode, raw)
      if ok and old then
        if old.source == 'authorized_backfill' and string.sub(tostring(next.source or ''), 1, 16) ~= 'resume_attached:' then
          next.source = old.source
        end
        if old.enqueuedAt then next.enqueuedAt = old.enqueuedAt end
        if old.lastFailure then next.lastFailure = old.lastFailure end
        if old.callEndedAt then next.callEndedAt = old.callEndedAt end
      end
    end
    redis.call('SET', KEYS[3], cjson.encode(next), 'EX', ARGV[7])
    local due = tonumber(ARGV[2])
    if (not current) or due < tonumber(current) then
      redis.call('ZADD', KEYS[1], due, ARGV[1])
      current = tostring(due)
    end
    return {1, current or tostring(due)}
  `;
  const result = await kvImpl([
    "EVAL", script, 3, AUTO_DUE_KEY, eventKey, autoMetaKey(id),
    id, String(due), eventValue, String(AUTO_EVENT_TTL_SECONDS),
    metaValue, String(source || "unknown"), String(AUTO_META_TTL_SECONDS),
  ]);
  const enqueued = Number(result?.[0]) === 1;
  const effectiveRaw = String(result?.[1] ?? "");
  const effectiveDue = effectiveRaw ? Number(effectiveRaw) : NaN;
  return {
    enqueued,
    duplicate: !enqueued,
    botId: id,
    dueAt: Number.isFinite(effectiveDue) ? effectiveDue : due,
  };
}

export async function authorizeAndEnqueuePhase2RemainderJob(
  job,
  expectedRevision,
  {
    source = "authorized_backfill",
    eventId = "",
    dueAt = null,
    callEndedAt = null,
    now = Date.now(),
    manifestDigest,
    ownerToken,
    entryIndex,
    commonAnchorAt,
  } = {},
  {
    kvImpl = kv,
  } = {},
) {
  const id = requireStoreId(job?.id, "bot id");
  const revision = Number(expectedRevision);
  const digest = String(manifestDigest || "").toLowerCase();
  const token = String(ownerToken || "");
  const index = Number(entryIndex);
  const anchorMs = Date.parse(String(commonAnchorAt || ""));
  if (
    !Number.isInteger(revision)
    || revision < 0
    || !/^[a-f0-9]{64}$/u.test(digest)
    || !token
    || !Number.isInteger(index)
    || index < 0
    || !Number.isFinite(anchorMs)
    || job?.automation?.mode !== "authorized_backfill"
    || job?.automation?.remainderManifestDigest !== digest
    || Date.parse(String(job?.automation?.backfillBatchEntryAt || ""))
      !== anchorMs
  ) {
    throw new Error("phase 2 remainder authorization is invalid");
  }
  const queuedAt = epochMs(now);
  const due = epochMs(dueAt, queuedAt);
  const next = {
    ...job,
    revision: revision + 1,
    updatedAt: new Date().toISOString(),
  };
  const dedupeId = String(eventId || randomUUID());
  const eventKey = autoEventKey(dedupeId);
  const eventValue = JSON.stringify({
    botId: id,
    source: String(source || "unknown").slice(0, 80),
    receivedAt: new Date(queuedAt).toISOString(),
  });
  const metaValue = JSON.stringify({
    source: String(source || "unknown").slice(0, 80),
    enqueuedAt: new Date(queuedAt).toISOString(),
    generation: randomUUID(),
    ...(callEndedAt ? {
      callEndedAt: new Date(
        epochMs(callEndedAt, queuedAt),
      ).toISOString(),
    } : {}),
  });
  const anchor = new Date(anchorMs).toISOString();
  const script = `
    local function stringValue(value)
      if value == nil or value == cjson.null then return '' end
      return tostring(value)
    end
    local releaseRaw = redis.call('GET', KEYS[7])
    if not releaseRaw then return {-1, '', ''} end
    local release = cjson.decode(releaseRaw)
    local lease = release.lease
    local entry = type(release.entries) == 'table'
      and release.entries[tonumber(ARGV[15])] or nil
    local inLease = false
    if lease and lease ~= cjson.null
      and type(lease.indexes) == 'table' then
      for _, leaseIndex in ipairs(lease.indexes) do
        if tonumber(leaseIndex) == tonumber(ARGV[15]) then
          inLease = true
        end
      end
    end
    if stringValue(release.status) ~= 'running'
      or stringValue(release.manifestDigest) ~= ARGV[13]
      or stringValue(release.commonAnchorAt) ~= ARGV[17]
      or not lease
      or lease == cjson.null
      or stringValue(lease.token) ~= ARGV[14]
      or tonumber(lease['until'] or 0) < tonumber(ARGV[16])
      or not inLease
      or not entry
      or stringValue(entry.id) ~= ARGV[5]
      or tonumber(entry.revision or -1) ~= tonumber(ARGV[1])
      or stringValue(entry.status) ~= 'claimed' then
      return {-1, '', ''}
    end

    local currentRaw = redis.call('GET', KEYS[1])
    if not currentRaw
      or not redis.call('ZSCORE', KEYS[2], ARGV[5]) then
      return {-3, '', ''}
    end
    local current = cjson.decode(currentRaw)
    local currentAutomation = type(current.automation) == 'table'
      and current.automation or {}
    if stringValue(current.id) ~= ARGV[5]
      or tonumber(current.revision or -1) ~= tonumber(ARGV[1])
      or stringValue(currentAutomation.mode) ~= 'backfill_only'
      or stringValue(currentAutomation.backfillBatchEntryAt) ~= ''
      or stringValue(currentAutomation.canaryManifestDigest) ~= ''
      or stringValue(currentAutomation.remainderManifestDigest) ~= '' then
      return {-3, '', ''}
    end

    local next = cjson.decode(ARGV[2])
    local nextAutomation = type(next.automation) == 'table'
      and next.automation or {}
    local nextResumeWait = type(nextAutomation.resumeWait) == 'table'
      and nextAutomation.resumeWait or {}
    if stringValue(next.id) ~= ARGV[5]
      or tonumber(next.revision or -1) ~= tonumber(ARGV[1]) + 1
      or stringValue(next.state) ~= ARGV[6]
      or stringValue(nextAutomation.mode) ~= 'authorized_backfill'
      or stringValue(nextAutomation.remainderManifestDigest) ~= ARGV[13]
      or stringValue(nextAutomation.canaryManifestDigest) ~= ''
      or stringValue(nextAutomation.backfillBatchEntryAt) ~= ARGV[17]
      or stringValue(nextResumeWait.source) ~= 'authorized_backfill'
      or stringValue(nextResumeWait.enteredAt) ~= ARGV[17] then
      return {-4, '', ''}
    end

    local currentDue = redis.call('ZSCORE', KEYS[4], ARGV[5])
    local eventExists = redis.call('EXISTS', KEYS[5]) == 1
    if eventExists then return {-3, '', currentDue or ''} end
    if redis.call('EXISTS', KEYS[9]) == 1
      or redis.call('EXISTS', KEYS[10]) == 1 then
      return {-5, '', currentDue or ''}
    end
    redis.call('ZREMRANGEBYSCORE', KEYS[8], '-inf', ARGV[16])
    local queued = tonumber(redis.call('ZCARD', KEYS[4]) or 0)
    local dueCount = tonumber(
      redis.call('ZCOUNT', KEYS[4], '-inf', ARGV[16]) or 0
    )
    local leased = tonumber(redis.call('ZCARD', KEYS[8]) or 0)
    local queuedDelta = currentDue and 0 or 1
    local dueDelta = 0
    if tonumber(ARGV[7]) <= tonumber(ARGV[16])
      and (
        not currentDue
        or tonumber(currentDue) > tonumber(ARGV[16])
      ) then
      dueDelta = 1
    end
    if queued + queuedDelta > tonumber(ARGV[18])
      or dueCount + dueDelta > tonumber(ARGV[19])
      or leased >= tonumber(ARGV[20]) then
      return {-2, '', currentDue or ''}
    end

    redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
    redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
    redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -501)
    if ARGV[6] == 'waiting_for_resume' then
      redis.call('SADD', KEYS[3], ARGV[5])
    else
      redis.call('SREM', KEYS[3], ARGV[5])
    end
    if not eventExists then
      redis.call(
        'SET',
        KEYS[5],
        ARGV[8],
        'NX',
        'EX',
        ARGV[9]
      )
    end
    local meta = cjson.decode(ARGV[10])
    local metaRaw = redis.call('GET', KEYS[6])
    if metaRaw then
      local ok, old = pcall(cjson.decode, metaRaw)
      if ok and old then
        if old.source == 'authorized_backfill'
          and string.sub(tostring(meta.source or ''), 1, 16)
            ~= 'resume_attached:' then
          meta.source = old.source
        end
        if old.enqueuedAt then meta.enqueuedAt = old.enqueuedAt end
        if old.lastFailure then meta.lastFailure = old.lastFailure end
        if old.callEndedAt then meta.callEndedAt = old.callEndedAt end
      end
    end
    redis.call(
      'SET',
      KEYS[6],
      cjson.encode(meta),
      'EX',
      ARGV[12]
    )
    local nextDue = tonumber(ARGV[7])
    if (not currentDue) or nextDue < tonumber(currentDue) then
      redis.call('ZADD', KEYS[4], nextDue, ARGV[5])
      currentDue = tostring(nextDue)
    end
    return {1, ARGV[2], currentDue or tostring(nextDue)}
  `;
  const result = await kvImpl([
    "EVAL",
    script,
    10,
    jobKey(id),
    INDEX_KEY,
    RESUME_WAITING_KEY,
    AUTO_DUE_KEY,
    eventKey,
    autoMetaKey(id),
    PHASE2_REMAINDER_KEY,
    AUTO_LEASES_KEY,
    autoLeaseKey(id),
    lockKey(id),
    String(revision),
    JSON.stringify(next),
    String(JOB_TTL_SECONDS),
    String(Date.parse(next.updatedAt) || queuedAt),
    id,
    String(next.state || ""),
    String(due),
    eventValue,
    String(AUTO_EVENT_TTL_SECONDS),
    metaValue,
    String(source || "unknown"),
    String(AUTO_META_TTL_SECONDS),
    digest,
    token,
    String(index + 1),
    String(queuedAt),
    anchor,
    String(PHASE2_REMAINDER_QUEUE_TOTAL_LIMIT),
    String(PHASE2_REMAINDER_QUEUE_DUE_LIMIT),
    String(PHASE2_REMAINDER_QUEUE_LEASED_LIMIT),
  ]);
  const code = Number(result?.[0]);
  if (code === -2) {
    return {
      admitted: false,
      job: null,
      queue: {
        enqueued: false,
        duplicate: false,
        botId: id,
        dueAt: due,
        error: "queue_capacity",
      },
    };
  }
  if (code === -1) {
    const error = new Error("phase 2 remainder queue lease changed");
    error.code = "PHASE2_REMAINDER_QUEUE_AUTHORITY_CHANGED";
    throw error;
  }
  if (code === -3) {
    const error = new Error("phase 2 remainder job changed");
    error.code = "PHASE2_REMAINDER_JOB_CHANGED";
    throw error;
  }
  if (code === -5) {
    const error = new Error("phase 2 remainder job is busy");
    error.code = "PHASE2_REMAINDER_JOB_BUSY";
    throw error;
  }
  if (code === -4 || ![1, 2].includes(code)) {
    const error = new Error("phase 2 remainder transition is invalid");
    error.code = "PHASE2_REMAINDER_TRANSITION_INVALID";
    throw error;
  }
  const stored = parse(result?.[1], null);
  if (
    !stored
    || stored.id !== id
    || Number(stored.revision) !== revision + 1
    || stored?.automation?.mode !== "authorized_backfill"
    || stored?.automation?.remainderManifestDigest !== digest
  ) {
    const error = new Error("phase 2 remainder transition is invalid");
    error.code = "PHASE2_REMAINDER_TRANSITION_INVALID";
    throw error;
  }
  const effectiveRaw = String(result?.[2] ?? "");
  const effectiveDue = effectiveRaw ? Number(effectiveRaw) : NaN;
  return {
    admitted: true,
    job: stored,
    queue: {
      enqueued: code === 1,
      duplicate: code === 2,
      botId: id,
      dueAt: Number.isFinite(effectiveDue) ? effectiveDue : due,
    },
  };
}

export async function enqueuePhase2RemainderAutoJob(
  botId,
  {
    source = "authorized_backfill",
    eventId = "",
    dueAt = null,
    callEndedAt = null,
    now = Date.now(),
    manifestDigest,
    ownerToken,
    entryIndex,
    expectedJobRevision,
    commonAnchorAt,
  } = {},
  {
    kvImpl = kv,
  } = {},
) {
  const id = requireStoreId(botId, "bot id");
  const queuedAt = epochMs(now);
  const due = epochMs(dueAt, queuedAt);
  const digest = String(manifestDigest || "").toLowerCase();
  const token = String(ownerToken || "");
  const index = Number(entryIndex);
  const jobRevision = Number(expectedJobRevision);
  const anchorMs = Date.parse(String(commonAnchorAt || ""));
  if (
    !/^[a-f0-9]{64}$/u.test(digest)
    || !token
    || !Number.isInteger(index)
    || index < 0
    || !Number.isInteger(jobRevision)
    || jobRevision < 0
    || !Number.isFinite(anchorMs)
  ) {
    throw new Error("phase 2 remainder queue authority is invalid");
  }
  const dedupeId = String(eventId || randomUUID());
  const eventKey = autoEventKey(dedupeId);
  const eventValue = JSON.stringify({
    botId: id,
    source: String(source || "unknown").slice(0, 80),
    receivedAt: new Date(queuedAt).toISOString(),
  });
  const metaValue = JSON.stringify({
    source: String(source || "unknown").slice(0, 80),
    enqueuedAt: new Date(queuedAt).toISOString(),
    generation: randomUUID(),
    ...(callEndedAt ? {
      callEndedAt: new Date(
        epochMs(callEndedAt, queuedAt),
      ).toISOString(),
    } : {}),
  });
  const script = `
    local function stringValue(value)
      if value == nil or value == cjson.null then return '' end
      return tostring(value)
    end
    local releaseRaw = redis.call('GET', KEYS[4])
    if not releaseRaw then return {-1, ''} end
    local release = cjson.decode(releaseRaw)
    local lease = release.lease
    local entry = type(release.entries) == 'table'
      and release.entries[tonumber(ARGV[10])] or nil
    local inLease = false
    if lease and lease ~= cjson.null
      and type(lease.indexes) == 'table' then
      for _, leaseIndex in ipairs(lease.indexes) do
        if tonumber(leaseIndex) == tonumber(ARGV[10]) then
          inLease = true
        end
      end
    end
    if stringValue(release.status) ~= 'running'
      or stringValue(release.manifestDigest) ~= ARGV[8]
      or stringValue(release.commonAnchorAt) ~= ARGV[16]
      or not lease
      or lease == cjson.null
      or tostring(lease.token or '') ~= ARGV[9]
      or tonumber(lease['until'] or 0) < tonumber(ARGV[11])
      or not inLease
      or not entry
      or tostring(entry.id or '') ~= ARGV[1]
      or tostring(entry.status or '') ~= 'claimed' then
      return {-1, ''}
    end
    local jobRaw = redis.call('GET', KEYS[6])
    if not jobRaw then return {-1, ''} end
    local job = cjson.decode(jobRaw)
    local automation = type(job.automation) == 'table'
      and job.automation or {}
    if stringValue(job.id) ~= ARGV[1]
      or tonumber(job.revision or -1) ~= tonumber(ARGV[15])
      or stringValue(job.state) ~= 'ready_to_submit'
      or stringValue(automation.mode) ~= 'authorized_backfill'
      or stringValue(automation.remainderManifestDigest) ~= ARGV[8]
      or stringValue(automation.canaryManifestDigest) ~= ''
      or stringValue(automation.backfillBatchEntryAt) ~= ARGV[16] then
      return {-1, ''}
    end

    local current = redis.call('ZSCORE', KEYS[1], ARGV[1])
    local eventExists = redis.call('EXISTS', KEYS[2]) == 1
    if eventExists and current then
      return {0, current or ''}
    end
    redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', ARGV[11])
    local queued = tonumber(redis.call('ZCARD', KEYS[1]) or 0)
    local dueCount = tonumber(
      redis.call('ZCOUNT', KEYS[1], '-inf', ARGV[11]) or 0
    )
    local leased = tonumber(redis.call('ZCARD', KEYS[5]) or 0)
    local queuedDelta = current and 0 or 1
    local dueDelta = 0
    if tonumber(ARGV[2]) <= tonumber(ARGV[11])
      and (
        not current
        or tonumber(current) > tonumber(ARGV[11])
      ) then
      dueDelta = 1
    end
    if queued + queuedDelta > tonumber(ARGV[12])
      or dueCount + dueDelta > tonumber(ARGV[13])
      or leased >= tonumber(ARGV[14]) then
      return {-2, current or ''}
    end

    if not eventExists then
      local recorded = redis.call(
        'SET',
        KEYS[2],
        ARGV[3],
        'NX',
        'EX',
        ARGV[4]
      )
      if not recorded then return {0, current or ''} end
    end
    local next = cjson.decode(ARGV[5])
    local raw = redis.call('GET', KEYS[3])
    if raw then
      local ok, old = pcall(cjson.decode, raw)
      if ok and old then
        if old.source == 'authorized_backfill'
          and string.sub(tostring(next.source or ''), 1, 16)
            ~= 'resume_attached:' then
          next.source = old.source
        end
        if old.enqueuedAt then next.enqueuedAt = old.enqueuedAt end
        if old.lastFailure then next.lastFailure = old.lastFailure end
        if old.callEndedAt then next.callEndedAt = old.callEndedAt end
      end
    end
    redis.call(
      'SET',
      KEYS[3],
      cjson.encode(next),
      'EX',
      ARGV[7]
    )
    local nextDue = tonumber(ARGV[2])
    if (not current) or nextDue < tonumber(current) then
      redis.call('ZADD', KEYS[1], nextDue, ARGV[1])
      current = tostring(nextDue)
    end
    return {1, current or tostring(nextDue)}
  `;
  const result = await kvImpl([
    "EVAL",
    script,
    6,
    AUTO_DUE_KEY,
    eventKey,
    autoMetaKey(id),
    PHASE2_REMAINDER_KEY,
    AUTO_LEASES_KEY,
    jobKey(id),
    id,
    String(due),
    eventValue,
    String(AUTO_EVENT_TTL_SECONDS),
    metaValue,
    String(source || "unknown"),
    String(AUTO_META_TTL_SECONDS),
    digest,
    token,
    String(index + 1),
    String(queuedAt),
    String(PHASE2_REMAINDER_QUEUE_TOTAL_LIMIT),
    String(PHASE2_REMAINDER_QUEUE_DUE_LIMIT),
    String(PHASE2_REMAINDER_QUEUE_LEASED_LIMIT),
    String(jobRevision),
    new Date(anchorMs).toISOString(),
  ]);
  const code = Number(result?.[0]);
  if (code === -1) {
    const error = new Error("phase 2 remainder queue lease changed");
    error.code = "PHASE2_REMAINDER_QUEUE_AUTHORITY_CHANGED";
    throw error;
  }
  const effectiveRaw = String(result?.[1] ?? "");
  const effectiveDue = effectiveRaw ? Number(effectiveRaw) : NaN;
  if (code === -2) {
    return {
      enqueued: false,
      duplicate: false,
      botId: id,
      dueAt: Number.isFinite(effectiveDue) ? effectiveDue : due,
      error: "queue_capacity",
    };
  }
  if (![0, 1].includes(code)) {
    const error = new Error("phase 2 remainder queue failed");
    error.code = "PHASE2_REMAINDER_QUEUE_FAILED";
    throw error;
  }
  return {
    enqueued: code === 1,
    duplicate: code === 0,
    botId: id,
    dueAt: Number.isFinite(effectiveDue) ? effectiveDue : due,
  };
}

export async function claimDueAutoJobs(
  limit = 1,
  { leaseMs = AUTO_LEASE_MS, now = Date.now(), workerId = "worker" } = {},
  { kvImpl = kv } = {},
) {
  const capped = Math.max(1, Math.min(25, Number(limit) || 1));
  const claimedAt = epochMs(now);
  const leaseFor = Math.max(30_000, Math.min(15 * 60_000, Number(leaseMs) || AUTO_LEASE_MS));
  const leaseUntil = claimedAt + leaseFor;
  const tokenPrefix = `${String(workerId || "worker").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50) || "worker"}:${randomUUID()}`;
  const script = `
    local candidates = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
    local out = {}
    local claimed = 0
    for _, jobId in ipairs(candidates) do
      if claimed >= tonumber(ARGV[3]) then break end
      local leaseKey = ARGV[6] .. jobId
      if not redis.call('GET', leaseKey) then
        claimed = claimed + 1
        local source = 'unknown'
        local generation = ''
        local attempts = 0
        local callEndedAt = ''
        local raw = redis.call('GET', ARGV[8] .. jobId)
        if raw then
          local ok, meta = pcall(cjson.decode, raw)
          if ok and meta then
            if meta.source then source = tostring(meta.source) end
            if meta.generation then generation = tostring(meta.generation) end
            if meta.attempts then attempts = tonumber(meta.attempts) or 0 end
            if meta.callEndedAt then callEndedAt = tostring(meta.callEndedAt) end
          end
        end
        local token = ARGV[5] .. ':' .. tostring(claimed) .. ':' .. generation
        redis.call('SET', leaseKey, token, 'PX', ARGV[4])
        redis.call('ZADD', KEYS[1], ARGV[7], jobId)
        redis.call('ZADD', KEYS[2], ARGV[7], jobId)
        table.insert(out, jobId)
        table.insert(out, token)
        table.insert(out, ARGV[7])
        table.insert(out, source)
        table.insert(out, generation)
        table.insert(out, attempts)
        table.insert(out, callEndedAt)
      end
    end
    return out
  `;
  const scanLimit = Math.min(100, Math.max(capped, capped * 4));
  const result = await kvImpl([
    "EVAL", script, 2, AUTO_DUE_KEY, AUTO_LEASES_KEY,
    String(claimedAt), String(scanLimit), String(capped), String(leaseFor),
    tokenPrefix, "paraai:auto:lease:", String(leaseUntil), AUTO_META_PREFIX,
  ]);
  const rows = [];
  for (let i = 0; i + 6 < (Array.isArray(result) ? result.length : 0); i += 7) {
    rows.push({
      botId: String(result[i]),
      leaseToken: String(result[i + 1]),
      leaseUntil: Number(result[i + 2]),
      source: String(result[i + 3] || "unknown"),
      generation: String(result[i + 4] || ""),
      attempts: Number(result[i + 5]) || 0,
      callEndedAt: String(result[i + 6] || "") || null,
    });
  }
  return rows;
}

export async function completeAutoJob(botId, { leaseToken = "", generation = "" } = {}, { kvImpl = kv } = {}) {
  const id = requireStoreId(botId, "bot id");
  if (!leaseToken) return false;
  const script = `
    if redis.call('GET', KEYS[3]) ~= ARGV[2] then return 0 end
    local raw = redis.call('GET', KEYS[4])
    local currentGeneration = ''
    if raw then
      local ok, meta = pcall(cjson.decode, raw)
      if ok and meta and meta.generation then currentGeneration = tostring(meta.generation) end
    end
    if currentGeneration ~= ARGV[3] then
      redis.call('DEL', KEYS[3])
      redis.call('ZREM', KEYS[2], ARGV[1])
      return 2
    end
    redis.call('DEL', KEYS[3])
    redis.call('DEL', KEYS[4])
    redis.call('ZREM', KEYS[1], ARGV[1])
    redis.call('ZREM', KEYS[2], ARGV[1])
    return 1
  `;
  return Number(await kvImpl([
    "EVAL", script, 4, AUTO_DUE_KEY, AUTO_LEASES_KEY, autoLeaseKey(id), autoMetaKey(id),
    id, String(leaseToken), String(generation || ""),
  ])) === 1;
}

export async function rescheduleAutoJob(
  botId,
  {
    leaseToken = "",
    generation = "",
    delayMs = 0,
    dueAt = null,
    error = "",
    failure = null,
    now = Date.now(),
  } = {},
  { kvImpl = kv } = {},
) {
  const id = requireStoreId(botId, "bot id");
  if (!leaseToken) return { rescheduled: false, dueAt: null };
  const current = epochMs(now);
  const due = epochMs(dueAt, current + Math.max(0, Number(delayMs) || 0));
  const lastFailure = normalizeFailureRecord(failure);
  const meta = JSON.stringify({
    ...(error ? { lastError: String(error).slice(0, 240) } : {}),
    ...(lastFailure ? { lastFailure } : {}),
    lastAt: new Date(current).toISOString(),
    dueAt: new Date(due).toISOString(),
  });
  const script = `
    if redis.call('GET', KEYS[3]) ~= ARGV[2] then return 0 end
    local currentRaw = redis.call('GET', KEYS[4])
    local currentGeneration = ''
    if currentRaw then
      local currentOk, currentMeta = pcall(cjson.decode, currentRaw)
      if currentOk and currentMeta and currentMeta.generation then currentGeneration = tostring(currentMeta.generation) end
    end
    if currentGeneration ~= ARGV[6] then
      redis.call('DEL', KEYS[3])
      redis.call('ZREM', KEYS[2], ARGV[1])
      return 2
    end
    redis.call('DEL', KEYS[3])
    redis.call('ZREM', KEYS[2], ARGV[1])
    redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
    local attempts = 1
    local raw = redis.call('GET', KEYS[4])
    local old = nil
    if raw then
      local ok
      ok, old = pcall(cjson.decode, raw)
      if ok and old and old.attempts then attempts = tonumber(old.attempts) + 1 end
    end
    local next = cjson.decode(ARGV[4])
    next.attempts = attempts
    if old and old.source then next.source = old.source end
    if old and old.enqueuedAt then next.enqueuedAt = old.enqueuedAt end
    if old and old.generation then next.generation = old.generation end
    if old and old.lastFailure and not next.lastFailure then next.lastFailure = old.lastFailure end
    if old and old.callEndedAt then next.callEndedAt = old.callEndedAt end
    redis.call('SET', KEYS[4], cjson.encode(next), 'EX', ARGV[5])
    return 1
  `;
  const rescheduled = Number(await kvImpl([
    "EVAL", script, 4, AUTO_DUE_KEY, AUTO_LEASES_KEY, autoLeaseKey(id), autoMetaKey(id),
    id, String(leaseToken), String(due), meta, String(AUTO_META_TTL_SECONDS), String(generation || ""),
  ]));
  return {
    rescheduled: rescheduled === 1,
    superseded: rescheduled === 2,
    dueAt: rescheduled === 1 ? due : null,
  };
}

export async function getAutoQueueStats(
  { now = Date.now() } = {},
  { kvImpl = kv, pipelineImpl = pipeline } = {},
) {
  const current = epochMs(now);
  await kvImpl(["ZREMRANGEBYSCORE", AUTO_LEASES_KEY, "-inf", current]);
  const [queued, due, leased, next] = await pipelineImpl([
    ["ZCARD", AUTO_DUE_KEY],
    ["ZCOUNT", AUTO_DUE_KEY, "-inf", current],
    ["ZCARD", AUTO_LEASES_KEY],
    ["ZRANGE", AUTO_DUE_KEY, 0, 0, "WITHSCORES"],
  ]);
  const nextScore = Number(Array.isArray(next) ? next[1] : NaN);
  return {
    queued: Number(queued) || 0,
    due: Number(due) || 0,
    leased: Number(leased) || 0,
    nextDueAt: Number.isFinite(nextScore) ? nextScore : null,
  };
}

export async function claimSubmissionIntent(
  { candidateUserId, jobId, payloadHash, claimedAt = new Date().toISOString(), attemptId = randomUUID() } = {},
  { kvImpl = kv } = {},
) {
  const candidate = String(candidateUserId || "").trim();
  if (!candidate) throw new Error("candidateUserId required");
  const id = requireStoreId(jobId);
  const hash = String(payloadHash || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("valid payloadHash required");
  const intent = {
    version: 1,
    jobId: id,
    payloadHash: hash,
    attemptId: String(attemptId || randomUUID()),
    claimedAt: new Date(claimedAt).toISOString(),
  };
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if raw then
      local existing = cjson.decode(raw)
      if existing.jobId == ARGV[1] and existing.payloadHash == ARGV[2] then return {2, raw} end
      return {-1, raw}
    end
    redis.call('SET', KEYS[1], ARGV[3], 'NX')
    return {1, ARGV[3]}
  `;
  const result = await kvImpl([
    "EVAL", script, 1, submissionClaimKey(candidate),
    id, hash, JSON.stringify(intent),
  ]);
  const code = Number(result?.[0]);
  const stored = parse(result?.[1], null);
  if (code === -1) {
    const conflict = new Error("candidate submission is already claimed by another job or payload");
    conflict.code = "SUBMISSION_ALREADY_CLAIMED";
    conflict.intent = stored;
    throw conflict;
  }
  if (![1, 2].includes(code) || !stored) throw new Error("submission intent claim failed");
  return { status: code === 1 ? "claimed" : "existing", intent: stored };
}

export async function getSubmissionIntent(candidateUserId, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", hashedCandidateClaimKey(candidateUserId)]), null);
}

export async function startSubmissionAttempt(
  { candidateUserId, jobId, attemptId, startedAt = new Date().toISOString() } = {},
  { kvImpl = kv } = {},
) {
  const candidate = String(candidateUserId || "").trim();
  if (!candidate) throw new Error("candidateUserId required");
  const id = requireStoreId(jobId);
  const attempt = String(attemptId || "");
  if (!attempt) throw new Error("attemptId required");
  const at = new Date(startedAt).toISOString();
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return {-1, ''} end
    local intent = cjson.decode(raw)
    if intent.jobId ~= ARGV[1] or intent.attemptId ~= ARGV[2] then return {-2, raw} end
    if intent.attemptStartedAt then return {2, raw} end
    intent.attemptStartedAt = ARGV[3]
    local next = cjson.encode(intent)
    redis.call('SET', KEYS[1], next)
    return {1, next}
  `;
  const result = await kvImpl([
    "EVAL", script, 1, submissionClaimKey(candidate),
    id, attempt, at,
  ]);
  const code = Number(result?.[0]);
  const intent = parse(result?.[1], null);
  if (code === -1) {
    const error = new Error("submission intent not found");
    error.code = "SUBMISSION_INTENT_NOT_FOUND";
    throw error;
  }
  if (code === -2) {
    const error = new Error("submission attempt does not own candidate claim");
    error.code = "SUBMISSION_INTENT_CONFLICT";
    error.intent = intent;
    throw error;
  }
  if (![1, 2].includes(code) || !intent) throw new Error("submission attempt start failed");
  return { status: code === 1 ? "started" : "already_started", intent };
}

export async function finishSubmissionAttempt(
  {
    candidateUserId,
    jobId,
    attemptId,
    outcome,
    finishedAt = new Date().toISOString(),
    detail = "",
  } = {},
  { kvImpl = kv } = {},
) {
  const candidate = String(candidateUserId || "").trim();
  if (!candidate) throw new Error("candidateUserId required");
  const id = requireStoreId(jobId);
  const attempt = String(attemptId || "");
  if (!attempt) throw new Error("attemptId required");
  const nextOutcome = String(outcome || "");
  if (submissionOutcomeTransition(null, nextOutcome) === "invalid") throw new Error("valid submission outcome required");
  const at = new Date(finishedAt).toISOString();
  const safeDetail = String(detail || "").slice(0, 240);
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return {-1, ''} end
    local intent = cjson.decode(raw)
    if intent.jobId ~= ARGV[1] or intent.attemptId ~= ARGV[2] then return {-2, raw} end
    if not intent.attemptStartedAt then return {-3, raw} end
    local current = intent.outcome
    local next = ARGV[3]
    if current == next then return {2, raw} end
    local advanced = next == 'confirmed' and (current == 'accepted' or current == 'unknown')
    if current and not advanced then return {-4, raw} end
    intent.outcome = next
    intent.finishedAt = ARGV[4]
    if ARGV[5] ~= '' then intent.detail = ARGV[5] end
    local encoded = cjson.encode(intent)
    redis.call('SET', KEYS[1], encoded)
    return {advanced and 3 or 1, encoded}
  `;
  const result = await kvImpl([
    "EVAL", script, 1, submissionClaimKey(candidate),
    id, attempt, nextOutcome, at, safeDetail,
  ]);
  const code = Number(result?.[0]);
  const intent = parse(result?.[1], null);
  const failures = new Map([
    [-1, ["SUBMISSION_INTENT_NOT_FOUND", "submission intent not found"]],
    [-2, ["SUBMISSION_INTENT_CONFLICT", "submission attempt does not own candidate claim"]],
    [-3, ["SUBMISSION_ATTEMPT_NOT_STARTED", "submission attempt has not started"]],
    [-4, ["SUBMISSION_OUTCOME_CONFLICT", "submission outcome cannot move backward or change terminal state"]],
  ]);
  if (failures.has(code)) {
    const [errorCode, message] = failures.get(code);
    const error = new Error(message);
    error.code = errorCode;
    error.intent = intent;
    throw error;
  }
  if (![1, 2, 3].includes(code) || !intent) throw new Error("submission outcome update failed");
  return {
    status: code === 1 ? "finished" : code === 2 ? "existing" : "advanced",
    intent,
  };
}
