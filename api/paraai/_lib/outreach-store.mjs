import { createHash, randomUUID } from "node:crypto";

const INDEX_KEY = "paraai:outreach:index";
const STATE_TTL_SECONDS = 730 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 150;
const POLL_LOCK_KEY = "paraai:outreach:poll-lock";
const EXCEPTION_INDEX_KEY = "paraai:outreach:exception:index";
const EXCEPTION_TTL_SECONDS = 730 * 24 * 60 * 60;
const KV_URL = String(
  process.env.PARAAI_OUTREACH_KV_REST_API_URL
  || process.env.KV_REST_API_URL
  || "",
).replace(/\/+$/, "");
const KV_TOKEN = process.env.PARAAI_OUTREACH_KV_REST_API_TOKEN
  || process.env.KV_REST_API_TOKEN
  || "";

const parse = (value, fallback = null) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

export const storeConfigured = () => Boolean(KV_URL && KV_TOKEN);

async function request(path, body) {
  if (!storeConfigured()) {
    const error = new Error("Para AI outreach state store not configured");
    error.code = "OUTREACH_NOT_CONFIGURED";
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
    const error = new Error(`outreach state store HTTP ${response.status}: ${detail}`);
    error.code = "OUTREACH_STORE_REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
  return parsed;
}

async function kv(args) {
  const body = await request("", args);
  if (body?.error) {
    const error = new Error(String(body.error));
    error.code = "OUTREACH_STORE_COMMAND_FAILED";
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
      error.code = "OUTREACH_STORE_COMMAND_FAILED";
      throw error;
    }
    return item?.result ?? null;
  });
}

export async function probeOutreachStore({ kvImpl = kv } = {}) {
  const nonce = randomUUID();
  const key = `paraai:outreach:canary:${nonce}`;
  const value = `v1:${nonce}`;
  const set = await kvImpl(["SET", key, value, "EX", 60]);
  const read = await kvImpl(["GET", key]);
  const removed = await kvImpl(["DEL", key]);
  if (set !== "OK" || read !== value || Number(removed) !== 1) {
    const error = new Error("outreach state-store canary did not read back");
    error.code = "OUTREACH_STORE_CANARY_FAILED";
    throw error;
  }
  return { ok: true, write: true, read: true, cleanup: true };
}

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
const exceptionHash = (requestId) => createHash("sha256")
  .update("paraai-outreach-exception")
  .update("\0")
  .update(String(requestId || "").trim())
  .digest("hex");
const exceptionKey = (requestId) => `paraai:outreach:exception:${exceptionHash(requestId)}`;
const exceptionAlertKey = (requestId) =>
  `paraai:outreach:exception-alert:${exceptionHash(requestId)}`;

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

export async function recordOutreachException(
  {
    request,
    code = "OUTREACH_FAILED",
    discovery = null,
  },
  {
    kvImpl = kv,
    pipelineImpl = pipeline,
  } = {},
) {
  if (!request?.id) throw new Error("request id required");
  const now = new Date().toISOString();
  const key = exceptionKey(request.id);
  const previous = parse(await kvImpl(["GET", key]), null);
  const record = {
    version: 1,
    requestId: String(request.id),
    candidateUserId: String(request.candidateUserId || ""),
    candidateName: String(request.candidateName || ""),
    roleName: String(request.roleName || ""),
    companyName: String(request.companyName || ""),
    code: String(code || "OUTREACH_FAILED"),
    status: "open",
    firstSeenAt: previous?.firstSeenAt || now,
    lastSeenAt: now,
    attempts: Number(previous?.attempts || 0) + 1,
    discovery: discovery ? {
      confidence: String(discovery.confidence || "unresolved"),
      gmailEmails: Array.isArray(discovery.gmailEmails) ? discovery.gmailEmails : [],
      calendarEmails: Array.isArray(discovery.calendarEmails) ? discovery.calendarEmails : [],
      suggestedEmails: Array.isArray(discovery.suggestedEmails)
        ? discovery.suggestedEmails
        : [],
      gmailError: discovery.gmailError || null,
      calendarError: discovery.calendarError || null,
    } : null,
    resolvedAt: null,
  };
  await pipelineImpl([
    ["SET", key, JSON.stringify(record), "EX", EXCEPTION_TTL_SECONDS],
    ["ZADD", EXCEPTION_INDEX_KEY, String(Date.parse(now)), exceptionHash(request.id)],
  ]);
  return record;
}

export async function resolveOutreachException(
  requestId,
  {
    resolution = "email_available",
    kvImpl = kv,
  } = {},
) {
  if (!String(requestId || "").trim()) return null;
  const key = exceptionKey(requestId);
  const previous = parse(await kvImpl(["GET", key]), null);
  if (!previous || previous.status === "resolved") return previous;
  const now = new Date().toISOString();
  const record = {
    ...previous,
    status: "resolved",
    resolution: String(resolution),
    resolvedAt: now,
    lastSeenAt: now,
  };
  await kvImpl(["SET", key, JSON.stringify(record), "EX", EXCEPTION_TTL_SECONDS]);
  return record;
}

export async function listOutreachExceptions(
  limit = 200,
  {
    includeResolved = false,
    kvImpl = kv,
    pipelineImpl = pipeline,
  } = {},
) {
  const capped = Math.max(1, Math.min(1000, Number(limit) || 200));
  const ids = await kvImpl(["ZREVRANGE", EXCEPTION_INDEX_KEY, 0, capped - 1]);
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = await pipelineImpl(
    ids.map((id) => ["GET", `paraai:outreach:exception:${id}`]),
  );
  return rows
    .map((row) => parse(row, null))
    .filter((row) => row && (includeResolved || row.status === "open"));
}

export async function claimOutreachExceptionAlert(
  requestId,
  {
    ttlSeconds = 24 * 60 * 60,
    kvImpl = kv,
  } = {},
) {
  const result = await kvImpl([
    "SET",
    exceptionAlertKey(requestId),
    new Date().toISOString(),
    "NX",
    "EX",
    Math.max(60, Number(ttlSeconds) || 24 * 60 * 60),
  ]);
  return result === "OK";
}

export async function releaseOutreachExceptionAlert(
  requestId,
  {
    kvImpl = kv,
  } = {},
) {
  return Number(await kvImpl(["DEL", exceptionAlertKey(requestId)])) > 0;
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
