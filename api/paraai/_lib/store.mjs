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
