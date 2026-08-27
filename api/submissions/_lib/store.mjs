// Private durable state for the Monitor Submissions tab.
//
// Candidate identifiers are hashed in key names. Row payloads remain in the
// same private Upstash store as Para AI and are served only after Monitor
// Google-session auth. The rows snapshot is a cache; the per-pair ledger is the
// durable record of operator decisions and verified Paraform outcomes.
import { createHash, randomUUID } from "node:crypto";

const ROWS_KEY = "sub:rows:v1";
const EXTERNAL_SOURCES_KEY = "sub:sources:external:v1";
const SYNC_LOCK_KEY = "sub:sync-lock:v1";
const ROWS_TTL_SECONDS = 7 * 24 * 60 * 60;
const LEDGER_TTL_SECONDS = Math.max(
  365 * 24 * 60 * 60,
  Number(process.env.SUBMISSIONS_LEDGER_TTL_SECONDS) || 3 * 365 * 24 * 60 * 60,
);
const ROW_LOCK_TTL_SECONDS = 5 * 60;
const KV_URL = String(
  process.env.PARAAI_INTEREST_KV_REST_API_URL
  || process.env.KV_REST_API_URL
  || "",
).replace(/\/+$/, "");
const KV_TOKEN = process.env.PARAAI_INTEREST_KV_REST_API_TOKEN
  || process.env.KV_REST_API_TOKEN
  || "";

const parse = (value, fallback = null) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

export const storeConfigured = () => Boolean(KV_URL && KV_TOKEN);

export function rowHash(candidateUserId, roleId) {
  return createHash("sha256")
    .update(`raydar-submissions-v1\0${String(candidateUserId || "")}\0${String(roleId || "")}`)
    .digest("hex");
}

export const ledgerKey = (candidateUserId, roleId) =>
  `sub:ledger:v1:${rowHash(candidateUserId, roleId)}`;
export const rowLockKey = (candidateUserId, roleId) =>
  `sub:row-lock:v1:${rowHash(candidateUserId, roleId)}`;

async function request(path, body) {
  if (!storeConfigured()) {
    const error = new Error("Submissions state store not configured");
    error.code = "SUBMISSIONS_STORE_NOT_CONFIGURED";
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
  if (!response.ok || parsed?.error) {
    const detail = String(parsed?.error || parsed?.message || raw || "request rejected")
      .replace(/\s+/g, " ")
      .slice(0, 180);
    const error = new Error(`submissions store HTTP ${response.status}: ${detail}`);
    error.code = "SUBMISSIONS_STORE_REQUEST_FAILED";
    throw error;
  }
  return parsed?.result ?? null;
}

async function kv(args) {
  return request("", args);
}

async function pipeline(commands) {
  if (!commands.length) return [];
  const response = await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KV_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(8_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(body)) {
    const error = new Error(`submissions store pipeline HTTP ${response.status}`);
    error.code = "SUBMISSIONS_STORE_REQUEST_FAILED";
    throw error;
  }
  return body.map((item) => {
    if (item?.error) {
      const error = new Error(String(item.error));
      error.code = "SUBMISSIONS_STORE_COMMAND_FAILED";
      throw error;
    }
    return item?.result ?? null;
  });
}

export async function readRowsSnapshot({ kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", ROWS_KEY]), null);
}

export async function writeRowsSnapshot(snapshot, { kvImpl = kv } = {}) {
  const next = {
    version: 1,
    ...snapshot,
    generatedAt: snapshot?.generatedAt || new Date().toISOString(),
  };
  await kvImpl(["SET", ROWS_KEY, JSON.stringify(next), "EX", String(ROWS_TTL_SECONDS)]);
  return next;
}

export async function readExternalSources({ kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", EXTERNAL_SOURCES_KEY]), null);
}

export async function writeExternalSources(value, { kvImpl = kv } = {}) {
  const next = {
    version: 1,
    generatedAt: value?.generatedAt || new Date().toISOString(),
    interviewFollowups: Array.isArray(value?.interviewFollowups)
      ? value.interviewFollowups.slice(0, 2_000)
      : [],
    matchWatch: Array.isArray(value?.matchWatch) ? value.matchWatch.slice(0, 5_000) : [],
  };
  await kvImpl(["SET", EXTERNAL_SOURCES_KEY, JSON.stringify(next)]);
  return next;
}

export async function readLedger(candidateUserId, roleId, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", ledgerKey(candidateUserId, roleId)]), null);
}

export async function readLedgers(pairs, { pipelineImpl = pipeline } = {}) {
  if (!pairs.length) return new Map();
  const results = await pipelineImpl(
    pairs.map((pair) => ["GET", ledgerKey(pair.candidateUserId, pair.roleId)]),
  );
  return new Map(pairs.map((pair, index) => [
    rowHash(pair.candidateUserId, pair.roleId),
    parse(results[index], null),
  ]));
}

export async function appendLedgerEvent(
  candidateUserId,
  roleId,
  event,
  patch = {},
  { kvImpl = kv } = {},
) {
  if (!candidateUserId || !roleId) throw new Error("candidateUserId and roleId required");
  const at = new Date().toISOString();
  const safeEvent = {
    type: String(event || "unknown").slice(0, 80),
    at,
    by: String(patch.by || "system").slice(0, 160),
    detail: String(patch.detail || "").slice(0, 240) || null,
  };
  const safePatch = {
    ...patch,
    by: undefined,
    detail: undefined,
    updatedAt: at,
  };
  const script = `
    local raw = redis.call('GET', KEYS[1])
    local current = raw and cjson.decode(raw) or { version = 1, revision = 0, events = {} }
    local patch = cjson.decode(ARGV[1])
    for key, value in pairs(patch) do current[key] = value end
    current.revision = tonumber(current.revision or 0) + 1
    current.updatedAt = ARGV[2]
    current.events = current.events or {}
    table.insert(current.events, cjson.decode(ARGV[3]))
    while #current.events > 50 do table.remove(current.events, 1) end
    local encoded = cjson.encode(current)
    redis.call('SET', KEYS[1], encoded, 'EX', ARGV[4])
    return encoded
  `;
  const raw = await kvImpl([
    "EVAL", script, 1, ledgerKey(candidateUserId, roleId),
    JSON.stringify(safePatch), at, JSON.stringify(safeEvent), String(LEDGER_TTL_SECONDS),
  ]);
  return parse(raw, null);
}

export async function acquireRowLock(
  candidateUserId,
  roleId,
  { kvImpl = kv, ttlSeconds = ROW_LOCK_TTL_SECONDS } = {},
) {
  const token = `v1:${randomUUID()}`;
  const result = await kvImpl([
    "SET", rowLockKey(candidateUserId, roleId), token, "NX", "EX", String(ttlSeconds),
  ]);
  return result === "OK" || result === true ? token : null;
}

export async function releaseRowLock(candidateUserId, roleId, token, { kvImpl = kv } = {}) {
  if (!token) return false;
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  const result = await kvImpl([
    "EVAL", script, 1, rowLockKey(candidateUserId, roleId), token,
  ]);
  return Number(result) === 1;
}

export async function acquireSyncLock({ kvImpl = kv, ttlSeconds = 290 } = {}) {
  const token = `v1:${randomUUID()}`;
  const result = await kvImpl(["SET", SYNC_LOCK_KEY, token, "NX", "EX", String(ttlSeconds)]);
  return result === "OK" || result === true ? token : null;
}

export async function releaseSyncLock(token, { kvImpl = kv } = {}) {
  if (!token) return false;
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  return Number(await kvImpl(["EVAL", script, 1, SYNC_LOCK_KEY, token])) === 1;
}

export {
  EXTERNAL_SOURCES_KEY,
  LEDGER_TTL_SECONDS,
  ROWS_KEY,
  ROWS_TTL_SECONDS,
  kv as submissionsKv,
};
