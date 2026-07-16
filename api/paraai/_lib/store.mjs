// Durable, single-writer Para AI job journal in the dashboard's existing
// Upstash/Vercel KV. Candidate PII lives only in the private runtime store.

import { randomUUID } from "node:crypto";

const KV_URL = String(process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";
const INDEX_KEY = "paraai:index";
const JOB_TTL_SECONDS = 180 * 24 * 60 * 60;
const JOB_LOCK_TTL_SECONDS = 150;
const LEGACY_JOB_LOCK_TTL_SECONDS = 330;
const LEGACY_JOB_LOCK_STALE_AFTER_SECONDS = 120;
const jobKey = (id) => `paraai:job:${id}`;
const lockKey = (id) => `paraai:lock:${id}`;
const alertKey = (key) => `paraai:alert:${key}`;

export const storeConfigured = () => Boolean(KV_URL && KV_TOKEN);

async function request(path, body) {
  if (!storeConfigured()) throw new Error("Para AI state store not configured");
  const response = await fetch(`${KV_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
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

const parse = (raw, fallback = null) => {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};

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

export async function createJob(job) {
  const now = job.createdAt || new Date().toISOString();
  const value = { ...job, id: job.id, revision: 0, createdAt: now, updatedAt: job.updatedAt || now };
  const created = await kv(["SET", jobKey(value.id), JSON.stringify(value), "NX", "EX", JOB_TTL_SECONDS]);
  if (created !== "OK") return getJob(value.id);
  await pipeline([
    ["ZADD", INDEX_KEY, Date.parse(value.updatedAt) || Date.now(), value.id],
    ["ZREMRANGEBYRANK", INDEX_KEY, 0, -501],
  ]);
  return value;
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
