// Durable state for Para AI expired-match actioning.
//
// Single writer: the api/paraai/expired.mjs endpoint family owns
// paraai:expired:*. Key segments are hashed so a key can never leak a
// submission-request or candidate identifier. Cross-lane write arbitration is
// NOT here — it lives in the neutral claim in request-claim.mjs.
import { createHash, randomUUID } from "node:crypto";

const INDEX_KEY = "paraai:expired:index";
const STATE_TTL_SECONDS = 730 * 24 * 60 * 60;
const POLL_LOCK_KEY = "paraai:expired:poll-lock";
const LAST_RUN_KEY = "paraai:expired:last-run";
const KV_URL = String(
  process.env.PARAAI_REPLY_KV_REST_API_URL
  || process.env.KV_REST_API_URL
  || "",
).replace(/\/+$/, "");
const KV_TOKEN = process.env.PARAAI_REPLY_KV_REST_API_TOKEN
  || process.env.KV_REST_API_TOKEN
  || "";

const parse = (value, fallback = null) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

export const storeConfigured = () => Boolean(KV_URL && KV_TOKEN);

export function expiredHash(value) {
  return createHash("sha256")
    .update(`paraai-expired-v1 ${String(value || "")}`)
    .digest("hex");
}

const stateKey = (requestId) => `paraai:expired:v1:${expiredHash(requestId)}`;
const dayCapKey = (day) => `paraai:expired:daycap:${day}`;

async function request(path, body) {
  if (!storeConfigured()) {
    const error = new Error("Para AI expired state store not configured");
    error.code = "EXPIRED_NOT_CONFIGURED";
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
    const error = new Error(`expired state store HTTP ${response.status}: ${detail}`);
    error.code = "EXPIRED_STORE_REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
  return parsed;
}

async function kv(args) {
  const body = await request("", args);
  if (body?.error) {
    const error = new Error(String(body.error));
    error.code = "EXPIRED_STORE_COMMAND_FAILED";
    throw error;
  }
  return body?.result ?? null;
}

async function pipeline(commands) {
  if (!commands.length) return [];
  const body = await request("/pipeline", commands);
  return body.map((item) => {
    if (item?.error) {
      const error = new Error(String(item.error));
      error.code = "EXPIRED_STORE_COMMAND_FAILED";
      throw error;
    }
    return item?.result ?? null;
  });
}

export async function probeExpiredStore({ kvImpl = kv } = {}) {
  const nonce = randomUUID();
  const key = `paraai:expired:canary:${nonce}`;
  await kvImpl(["SET", key, `v1:${nonce}`, "EX", "60"]);
  const seen = await kvImpl(["GET", key]);
  await kvImpl(["DEL", key]).catch(() => {});
  return seen === `v1:${nonce}`;
}

// Idempotent: on a race the EXISTING record comes back rather than an error, so
// two ticks that see the same expired row converge on one row.
export async function createExpiredRecord(record, { kvImpl = kv } = {}) {
  if (!record?.requestId) throw new Error("requestId required");
  const next = {
    ...record,
    revision: 1,
    createdAt: record.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const script = `
    local existing = redis.call('GET', KEYS[1])
    if existing then
      return {0, existing}
    end
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
    return {1, ARGV[1]}
  `;
  const result = await kvImpl([
    "EVAL", script, 2, stateKey(next.requestId), INDEX_KEY,
    JSON.stringify(next), String(STATE_TTL_SECONDS),
    String(Date.parse(next.updatedAt) || Date.now()),
    expiredHash(next.requestId),
  ]);
  return { created: Number(result?.[0]) === 1, record: parse(result?.[1], next) };
}

export async function saveExpiredRecord(record, expectedRevision, { kvImpl = kv } = {}) {
  if (!record?.requestId) throw new Error("requestId required");
  const next = {
    ...record,
    revision: Number(expectedRevision) + 1,
    updatedAt: new Date().toISOString(),
  };
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return -1 end
    local current = cjson.decode(raw)
    if tonumber(current.revision or 0) ~= tonumber(ARGV[1]) then return 0 end
    redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
    redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
    return 1
  `;
  const result = await kvImpl([
    "EVAL", script, 2, stateKey(next.requestId), INDEX_KEY,
    String(expectedRevision), JSON.stringify(next), String(STATE_TTL_SECONDS),
    String(Date.parse(next.updatedAt) || Date.now()),
    expiredHash(next.requestId),
  ]);
  if (Number(result) === 0) {
    const error = new Error("expired record changed; retry from a fresh read");
    error.code = "EXPIRED_REVISION_CONFLICT";
    throw error;
  }
  if (Number(result) !== 1) {
    const error = new Error("expired record no longer exists");
    error.code = "EXPIRED_RECORD_NOT_FOUND";
    throw error;
  }
  return next;
}

export async function readExpiredRecord(requestId, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", stateKey(requestId)]), null);
}

export async function listExpiredRecords(limit = 200, { kvImpl = kv, pipelineImpl = pipeline } = {}) {
  const capped = Math.max(1, Math.min(500, Number(limit) || 200));
  const hashes = await kvImpl(["ZREVRANGE", INDEX_KEY, "0", String(capped - 1)]);
  if (!Array.isArray(hashes) || !hashes.length) return [];
  const rows = await pipelineImpl(hashes.map((hash) => ["GET", `paraai:expired:v1:${hash}`]));
  return rows.map((row) => parse(row, null)).filter(Boolean);
}

// Dismissals land in front of hiring managers, so the daily ceiling is a hard
// counter rather than a per-tick batch bound: a backfill, a recovered outage and
// the organic tick all spend from the same budget.
export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export async function spendDailyDismissBudget(cap, { now = Date.now(), kvImpl = kv } = {}) {
  const day = utcDay(now);
  const used = Number(await kvImpl(["INCR", dayCapKey(day)])) || 0;
  if (used === 1) await kvImpl(["EXPIRE", dayCapKey(day), String(3 * 24 * 60 * 60)]).catch(() => {});
  if (used > Number(cap)) {
    await kvImpl(["DECR", dayCapKey(day)]).catch(() => {});
    return { granted: false, used: used - 1 };
  }
  return { granted: true, used };
}

export async function readDailyDismissSpend({ now = Date.now(), kvImpl = kv } = {}) {
  return Number(await kvImpl(["GET", dayCapKey(utcDay(now))])) || 0;
}

// Liveness for the staleness watchdog: a lane whose whole job is beating a
// deadline must never fail silently.
export async function markExpiredRun({ now = Date.now(), kvImpl = kv } = {}) {
  await kvImpl(["SET", LAST_RUN_KEY, JSON.stringify({ at: new Date(now).toISOString() })]);
  return true;
}

export async function readExpiredLastRun({ kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", LAST_RUN_KEY]), null);
}

export async function acquireExpiredPollSlot({ ttlSeconds = 3600, kvImpl = kv } = {}) {
  const token = `v1:${randomUUID()}`;
  const ttl = Math.max(60, Math.min(21_600, Math.floor(Number(ttlSeconds) || 3600)));
  const result = await kvImpl(["SET", POLL_LOCK_KEY, token, "NX", "EX", String(ttl)]);
  return result === "OK" || result === true ? token : null;
}

// NOTE: deliberately NOT released in a finally block. Unlike the reply lane's
// concurrency mutex, this slot IS the pacing mechanism — the expiry clock is
// day-granular, so the lane wakes about once an hour rather than on every
// five-second worker tick.
export async function releaseExpiredPollSlot(token, { kvImpl = kv } = {}) {
  if (!token) return false;
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  const result = await kvImpl(["EVAL", script, 1, POLL_LOCK_KEY, token]);
  return Number(result) === 1;
}

export { INDEX_KEY, STATE_TTL_SECONDS, POLL_LOCK_KEY, LAST_RUN_KEY };
