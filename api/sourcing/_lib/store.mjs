// Durable orchestration state in the existing Raydar Upstash/Vercel KV store.
// Candidate profiles remain in Paraform; run snapshots contain only the fields
// needed to render a review queue and audit the decisions made there.

import { randomUUID } from "node:crypto";

const KV_URL = (process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";
const PREFIX = "sourcing:v1";
const RUN_TTL_SECONDS = 180 * 24 * 60 * 60;

export const storeConfigured = () => Boolean(KV_URL && KV_TOKEN);
const roleKey = (roleId) => `${PREFIX}:role:${roleId}`;
const roleRunsKey = (roleId) => `${PREFIX}:role:${roleId}:runs`;
const runKey = (runId) => `${PREFIX}:run:${runId}`;
const filedKey = (roleId) => `${PREFIX}:role:${roleId}:filed`;
const sourceCacheKey = (key) => `${PREFIX}:source:${key}`;
const roleReadWindowKey = `${PREFIX}:paraform-role-read:window`;
const mutationLockKey = (scope, id) => `${PREFIX}:lock:${scope}:${id}`;

async function request(path, body) {
  if (!storeConfigured()) throw new Error("sourcing state store not configured");
  const response = await fetch(`${KV_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`state store HTTP ${response.status}`);
  return response.json();
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

const parse = (value, fallback = null) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

export async function getRoleState(roleId) {
  return parse(await kv(["GET", roleKey(roleId)]), null);
}

export async function saveRoleState(roleId, state) {
  const next = { ...state, roleId, updatedAt: new Date().toISOString() };
  await kv(["SET", roleKey(roleId), JSON.stringify(next)]);
  return next;
}

export async function createRun(run) {
  const key = runKey(run.id);
  const created = await kv(["SET", key, JSON.stringify(run), "NX", "EX", RUN_TTL_SECONDS]);
  if (created !== "OK") throw new Error("run id already exists");
  await pipeline([
    ["ZADD", roleRunsKey(run.roleId), Date.parse(run.createdAt) || Date.now(), run.id],
    ["ZREMRANGEBYRANK", roleRunsKey(run.roleId), 0, -51],
  ]);
  return run;
}

export async function getRun(runId) {
  return parse(await kv(["GET", runKey(runId)]), null);
}

// Optimistic compare-and-set prevents two fast labels from silently replacing
// each other when they land on different serverless instances.
export async function saveRun(run, expectedRevision) {
  const next = { ...run, revision: Number(expectedRevision) + 1, updatedAt: new Date().toISOString() };
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return -1 end
    local current = cjson.decode(raw)
    if tonumber(current.revision or 0) ~= tonumber(ARGV[1]) then return 0 end
    redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
    return 1
  `;
  const result = await kv(["EVAL", script, 1, runKey(run.id), String(expectedRevision), JSON.stringify(next), String(RUN_TTL_SECONDS)]);
  if (Number(result) === 0) {
    const error = new Error("run changed; refresh and retry");
    error.code = "REVISION_CONFLICT";
    throw error;
  }
  if (Number(result) !== 1) throw new Error("run no longer exists");
  return next;
}

// Proposal approval changes both the run audit log and the role's active
// rubric. Commit them in one Redis script so neither half can exist alone.
export async function saveRunAndRoleState(run, expectedRevision, roleId, state) {
  const now = new Date().toISOString();
  const nextRun = { ...run, revision: Number(expectedRevision) + 1, updatedAt: now };
  const nextRole = { ...state, roleId, updatedAt: now };
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return -1 end
    local current = cjson.decode(raw)
    if tonumber(current.revision or 0) ~= tonumber(ARGV[1]) then return 0 end
    redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
    redis.call('SET', KEYS[2], ARGV[4])
    return 1
  `;
  const result = await kv([
    "EVAL", script, 2, runKey(run.id), roleKey(roleId), String(expectedRevision),
    JSON.stringify(nextRun), String(RUN_TTL_SECONDS), JSON.stringify(nextRole),
  ]);
  if (Number(result) === 0) {
    const error = new Error("run changed; refresh and retry");
    error.code = "REVISION_CONFLICT";
    throw error;
  }
  if (Number(result) !== 1) throw new Error("run no longer exists");
  return { run: nextRun, roleState: nextRole };
}

async function acquireMutationLock(scope, id, ttlSeconds = 330) {
  const token = randomUUID();
  const result = await kv([
    "SET", mutationLockKey(scope, id), token, "NX", "EX", Math.max(30, ttlSeconds),
  ]);
  return result === "OK" ? token : null;
}

async function releaseMutationLock(scope, id, token) {
  if (!token) return false;
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  return Number(await kv(["EVAL", script, 1, mutationLockKey(scope, id), token])) === 1;
}

export const acquireRunLock = (runId, ttlSeconds) => acquireMutationLock("run", runId, ttlSeconds);
export const releaseRunLock = (runId, token) => releaseMutationLock("run", runId, token);
export const acquireRoleLock = (roleId, ttlSeconds) => acquireMutationLock("role", roleId, ttlSeconds);
export const releaseRoleLock = (roleId, token) => releaseMutationLock("role", roleId, token);

export async function listRuns(roleId, limit = 10) {
  const ids = await kv(["ZREVRANGE", roleRunsKey(roleId), 0, Math.max(0, Math.min(49, limit - 1))]);
  if (!Array.isArray(ids) || !ids.length) return [];
  const values = await pipeline(ids.map((id) => ["GET", runKey(id)]));
  return values.map((value) => parse(value, null)).filter(Boolean);
}

export function filedCandidateIdsFromRuns(runs = []) {
  return [...new Set(runs.flatMap((run) => (run?.candidates || [])
    .filter((candidate) => candidate?.projectStatus === "filed")
    .map((candidate) => candidate.candidateId)
    .filter(Boolean)))];
}

// Search reruns should reconsider profiles that did not pass the agent's rubric.
// Only people already written to the review project are excluded. Every read
// reconciles against retained run history, retiring the old `:seen` set without
// risking a duplicate if a prior filed-set update was interrupted.
export async function filedCandidateIds(roleId) {
  const [values, history] = await Promise.all([
    kv(["SMEMBERS", filedKey(roleId)]),
    listRuns(roleId, 50),
  ]);
  const current = Array.isArray(values) ? values.filter(Boolean) : [];
  const backfill = filedCandidateIdsFromRuns(history);
  const missing = backfill.filter((id) => !current.includes(id));
  if (missing.length) await kv(["SADD", filedKey(roleId), ...missing]);
  return [...new Set([...current, ...backfill])];
}

export async function markCandidatesFiled(roleId, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length) await kv(["SADD", filedKey(roleId), ...unique]);
}

export async function getSourceCache(key) {
  return parse(await kv(["GET", sourceCacheKey(key)]), null);
}

export async function setSourceCache(key, value, ttlSeconds = 600) {
  await kv(["SET", sourceCacheKey(key), JSON.stringify(value), "EX", Math.max(60, ttlSeconds)]);
  return value;
}

// Paraform sanctioned the role-data build at no more than two GETs per minute.
// This rolling-window gate is global across serverless instances and is consumed
// only on cache misses, immediately before the vendor request.
export async function takeRoleReadSlot(now = Date.now()) {
  const script = `
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
    if tonumber(redis.call('ZCARD', KEYS[1])) >= 2 then return 0 end
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
    redis.call('EXPIRE', KEYS[1], 120)
    return 1
  `;
  const cutoff = now - 60000;
  const member = `${now}:${Math.random().toString(36).slice(2)}`;
  return Number(await kv(["EVAL", script, 1, roleReadWindowKey, String(cutoff), String(now), member])) === 1;
}
