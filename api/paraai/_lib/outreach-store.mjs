import { createHash, randomUUID } from "node:crypto";

import { kv, pipeline, storeConfigured } from "./store.mjs";

const INDEX_KEY = "paraai:outreach:index";
const STATE_TTL_SECONDS = 730 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 150;
const POLL_LOCK_KEY = "paraai:outreach:poll-lock";

const parse = (value, fallback = null) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

export { storeConfigured };

export function outreachCandidateHash(candidateUserId) {
  const value = String(candidateUserId || "").trim();
  if (!value) throw new Error("candidateUserId required");
  return createHash("sha256")
    .update("paraai-outreach-candidate")
    .update("\0")
    .update(value)
    .digest("hex");
}
const stateKey = (candidateUserId) => `paraai:outreach:candidate:${outreachCandidateHash(candidateUserId)}`;
const lockKey = (candidateUserId) => `paraai:outreach:lock:${outreachCandidateHash(candidateUserId)}`;

export function appendOutreachJournal(state, event, detail = {}) {
  return {
    ...state,
    updatedAt: new Date().toISOString(),
    journal: [
      ...(state?.journal || []),
      { at: new Date().toISOString(), event: String(event || "updated"), ...detail },
    ].slice(-200),
  };
}

export async function getOutreachState(candidateUserId, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", stateKey(candidateUserId)]), null);
}

export async function createOutreachState(candidateUserId, seed = {}, { kvImpl = kv } = {}) {
  const now = new Date().toISOString();
  const state = {
    version: 1,
    candidateUserId: String(candidateUserId),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    matches: {},
    outbox: {},
    followup: null,
    journal: [{ at: now, event: "candidate_created" }],
    ...seed,
  };
  const script = `
    local existing = redis.call('GET', KEYS[1])
    if existing then
      redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
      return {0, existing}
    end
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
    return {1, ARGV[1]}
  `;
  const id = outreachCandidateHash(candidateUserId);
  const result = await kvImpl([
    "EVAL", script, 2, stateKey(candidateUserId), INDEX_KEY,
    JSON.stringify(state), String(STATE_TTL_SECONDS),
    String(Date.parse(now)), id,
  ]);
  return parse(result?.[1], state);
}

export async function saveOutreachState(state, expectedRevision, { kvImpl = kv } = {}) {
  if (!state?.candidateUserId) throw new Error("candidateUserId required");
  const next = {
    ...state,
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
    "EVAL", script, 2, stateKey(state.candidateUserId), INDEX_KEY,
    String(expectedRevision), JSON.stringify(next), String(STATE_TTL_SECONDS),
    String(Date.parse(next.updatedAt) || Date.now()),
    outreachCandidateHash(state.candidateUserId),
  ]);
  if (Number(result) === 0) {
    const error = new Error("outreach state changed; retry from a fresh read");
    error.code = "OUTREACH_REVISION_CONFLICT";
    throw error;
  }
  if (Number(result) !== 1) {
    const error = new Error("outreach state no longer exists");
    error.code = "OUTREACH_STATE_NOT_FOUND";
    throw error;
  }
  return next;
}

export async function listOutreachStates(limit = 500, {
  kvImpl = kv,
  pipelineImpl = pipeline,
} = {}) {
  const capped = Math.max(1, Math.min(1000, Number(limit) || 500));
  const ids = await kvImpl(["ZREVRANGE", INDEX_KEY, 0, capped - 1]);
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = await pipelineImpl(ids.map((id) => ["GET", `paraai:outreach:candidate:${id}`]));
  return rows.map((row) => parse(row, null)).filter(Boolean);
}

export async function acquireOutreachLock(candidateUserId, {
  ttlSeconds = LOCK_TTL_SECONDS,
  kvImpl = kv,
} = {}) {
  const token = `v1:${randomUUID()}`;
  const result = await kvImpl([
    "SET",
    lockKey(candidateUserId),
    token,
    "NX",
    "EX",
    Math.max(30, Math.min(300, Number(ttlSeconds) || LOCK_TTL_SECONDS)),
  ]);
  return result === "OK" ? token : null;
}

export async function releaseOutreachLock(candidateUserId, token, { kvImpl = kv } = {}) {
  if (!token) return false;
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  return Number(await kvImpl([
    "EVAL", script, 1, lockKey(candidateUserId), token,
  ])) === 1;
}

export async function acquireOutreachPollSlot({
  ttlSeconds = 45,
  kvImpl = kv,
} = {}) {
  const token = `v1:${randomUUID()}`;
  const result = await kvImpl([
    "SET",
    POLL_LOCK_KEY,
    token,
    "NX",
    "EX",
    Math.max(15, Math.min(300, Number(ttlSeconds) || 45)),
  ]);
  return result === "OK" ? token : null;
}

export async function releaseOutreachPollSlot(token, { kvImpl = kv } = {}) {
  if (!token) return false;
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  return Number(await kvImpl([
    "EVAL", script, 1, POLL_LOCK_KEY, token,
  ])) === 1;
}
