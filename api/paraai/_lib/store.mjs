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
const jobKey = (id) => `paraai:job:${id}`;
const lockKey = (id) => `paraai:lock:${id}`;
const alertKey = (key) => `paraai:alert:${key}`;
const autoLeaseKey = (id) => `paraai:auto:lease:${id}`;
const autoMetaKey = (id) => `${AUTO_META_PREFIX}${id}`;
const autoEventKey = (id) => `paraai:auto:event:${storeHash("auto-event", id)}`;
const submissionClaimKey = (candidateUserId) => `paraai:submit-claim:${storeHash("candidate", candidateUserId)}`;

export const storeConfigured = () => Boolean(KV_URL && KV_TOKEN);

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

export function transition(job, state, details = {}) {
  const at = new Date().toISOString();
  return {
    ...job,
    ...details,
    state,
    updatedAt: at,
    journal: [...(job?.journal || []), { state, at, ...(details?.journalDetail ? { detail: details.journalDetail } : {}) }].slice(-100),
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
      return {0, existing}
    end
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
    redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -501)
    return {1, ARGV[1]}
  `;
  const result = await kvImpl([
    "EVAL", script, 2, jobKey(value.id), INDEX_KEY,
    JSON.stringify(value), String(JOB_TTL_SECONDS),
    String(Date.parse(value.updatedAt) || Date.now()), value.id,
  ]);
  return parse(Array.isArray(result) ? result[1] : null, value);
}

export async function saveJob(job, expectedRevision) {
  const next = { ...job, revision: Number(expectedRevision) + 1, updatedAt: new Date().toISOString() };
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return -1 end
    local current = cjson.decode(raw)
    if tonumber(current.revision or 0) ~= tonumber(ARGV[1]) then return 0 end
    redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
    redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
    redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -501)
    return 1
  `;
  const result = await kv([
    "EVAL", script, 2, jobKey(job.id), INDEX_KEY,
    String(expectedRevision), JSON.stringify(next), String(JOB_TTL_SECONDS),
    String(Date.parse(next.updatedAt) || Date.now()), next.id,
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
  { source = "unknown", eventId = "", dueAt = null, now = Date.now() } = {},
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
        if old.source == 'authorized_backfill' then next.source = old.source end
        if old.enqueuedAt then next.enqueuedAt = old.enqueuedAt end
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
        local raw = redis.call('GET', ARGV[8] .. jobId)
        if raw then
          local ok, meta = pcall(cjson.decode, raw)
          if ok and meta then
            if meta.source then source = tostring(meta.source) end
            if meta.generation then generation = tostring(meta.generation) end
            if meta.attempts then attempts = tonumber(meta.attempts) or 0 end
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
  for (let i = 0; i + 5 < (Array.isArray(result) ? result.length : 0); i += 6) {
    rows.push({
      botId: String(result[i]),
      leaseToken: String(result[i + 1]),
      leaseUntil: Number(result[i + 2]),
      source: String(result[i + 3] || "unknown"),
      generation: String(result[i + 4] || ""),
      attempts: Number(result[i + 5]) || 0,
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
  { leaseToken = "", generation = "", delayMs = 0, dueAt = null, error = "", now = Date.now() } = {},
  { kvImpl = kv } = {},
) {
  const id = requireStoreId(botId, "bot id");
  if (!leaseToken) return { rescheduled: false, dueAt: null };
  const current = epochMs(now);
  const due = epochMs(dueAt, current + Math.max(0, Number(delayMs) || 0));
  const meta = JSON.stringify({
    lastError: String(error || "").slice(0, 240),
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
