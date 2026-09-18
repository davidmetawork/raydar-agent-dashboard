const SCHEMA_VERSION = 1;
const PARAFORM_HOSTS = new Set(["www.paraform.com", "paraform.com", "api.paraform.com"]);
const COLLECTOR_ORIGIN = "https://raydar-paraform-traffic.david183940.chatgpt.site";
const COLLECTOR_PATH = "/api/ingest";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const HEARTBEAT_STATES = new Set(["active", "paused", "idle", "unknown"]);
const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
const PROCEDURE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// The collector's D1 transaction uses several statements per event. Thirty-two
// stays below its forty-event admission ceiling with headroom for bookkeeping.
const MAX_QUEUE_EVENTS = 160;
const MAX_BATCH_EVENTS = 32;
const MAX_FLUSH_ROUNDS = 2;
const FLUSH_BUDGET_MS = 5_000;
const MAX_ENDPOINT_LENGTH = 120;
const MAX_INSPECTION_BYTES = 64 * 1024;
const INSPECTION_TIMEOUT_MS = 150;
const COLLECTOR_TIMEOUT_MS = 2_500;
const AUTO_FLUSH_DELAY_MS = 250;
const MAX_RETRY_AFTER_SECONDS = 7 * 24 * 60 * 60;

const REST_ALIASES = new Map([
  ["/api/user", "rest.user"],
  ["/api/auth/session", "rest.auth_session"],
  ["/api/resumeUpload/signedURL", "rest.resume_signed_url"],
  ["/api/rest/candidates/profileInfo", "rest.candidate_profile_info"],
]);

function randomUuid() {
  return globalThis.crypto?.randomUUID?.() ?? null;
}

function validUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function readNow(now) {
  try {
    const value = Number(now());
    return Number.isFinite(value) ? Math.trunc(value) : null;
  } catch {
    return null;
  }
}

function cleanSourceId(value) {
  const sourceId = String(value ?? "").trim();
  return SOURCE_RE.test(sourceId) ? sourceId : null;
}

function collectorConfig(env, explicitSourceId) {
  // A shared helper can have a safe code default, but the owning deployment's
  // explicit environment label must win so one helper is not misattributed.
  const sourceId = cleanSourceId(env?.PARAFORM_TELEMETRY_SOURCE ?? explicitSourceId);
  const url = String(env?.PARAFORM_TELEMETRY_URL ?? "").trim();
  const sourceToken = String(env?.PARAFORM_TELEMETRY_TOKEN ?? "").trim();
  const dispatchToken = String(env?.PARAFORM_TELEMETRY_DISPATCH_TOKEN ?? "").trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.origin !== COLLECTOR_ORIGIN
    || parsed.pathname !== COLLECTOR_PATH
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.username !== ""
    || parsed.password !== ""
    || !sourceId
    || !sourceToken
    || !dispatchToken
  ) return null;
  return { url: parsed.toString(), sourceId, sourceToken, dispatchToken };
}

function requestFacts(input, init) {
  try {
    const rawUrl = typeof input === "string" || input instanceof URL
      ? String(input)
      : input?.url;
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !PARAFORM_HOSTS.has(url.hostname)) return null;
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    if (!METHODS.has(method)) return null;

    const prefix = "/api/trpc/";
    let endpoint = REST_ALIASES.get(url.pathname) ?? "rest.unknown";
    let trpc = false;
    if (url.pathname.startsWith(prefix)) {
      let procedure = "";
      try {
        procedure = decodeURIComponent(url.pathname.slice(prefix.length));
      } catch {
        procedure = "";
      }
      if (procedure.length <= MAX_ENDPOINT_LENGTH && PROCEDURE_RE.test(procedure)) endpoint = procedure;
      else if (procedure.includes(",")) endpoint = "trpc.batch";
      else endpoint = "trpc.unknown";
      trpc = true;
    }
    return { method, endpoint, trpc };
  } catch {
    return null;
  }
}

function retryAfterSeconds(response, nowMs) {
  let value;
  try {
    value = response?.headers?.get?.("retry-after");
  } catch {
    return null;
  }
  if (value == null || String(value).trim() === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric >= 0 && numeric <= MAX_RETRY_AFTER_SECONDS ? numeric : null;
  }
  const at = Date.parse(String(value));
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, (at - nowMs) / 1000);
  return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : null;
}

function transportErrorClass(error) {
  const name = String(error?.name ?? "").toLowerCase();
  const code = String(error?.code ?? "").toLowerCase();
  return name.includes("timeout")
    || name === "aborterror"
    || code === "etimedout"
    || code === "abort_err"
    ? "timeout"
    : "network";
}

function inspectRateLimitSignal(value, depth = 0, budget = { remaining: 32 }) {
  if (budget.remaining-- <= 0 || depth > 4 || value == null) return false;
  if (typeof value === "number") return value === 429;
  if (typeof value === "string") {
    return value === "429" || /too many requests|rate[_ -]?limit/iu.test(value);
  }
  if (typeof value !== "object") return false;
  for (const key of ["code", "httpStatus", "status", "message"]) {
    if (Object.hasOwn(value, key) && inspectRateLimitSignal(value[key], depth + 1, budget)) {
      return true;
    }
  }
  if (Object.hasOwn(value, "data") && inspectRateLimitSignal(value.data, depth + 1, budget)) {
    return true;
  }
  return Object.hasOwn(value, "json")
    && inspectRateLimitSignal(value.json, depth + 1, budget);
}

function inspectAuthSignal(value, depth = 0, budget = { remaining: 32 }) {
  if (budget.remaining-- <= 0 || depth > 4 || value == null) return false;
  if (typeof value === "number") return value === 401 || value === 403;
  if (typeof value === "string") {
    return value === "401"
      || value === "403"
      || /^(?:unauthorized|forbidden|auth_access)$/iu.test(value.trim());
  }
  if (typeof value !== "object") return false;
  for (const key of ["code", "httpStatus", "status", "message"]) {
    if (Object.hasOwn(value, key) && inspectAuthSignal(value[key], depth + 1, budget)) {
      return true;
    }
  }
  if (Object.hasOwn(value, "data") && inspectAuthSignal(value.data, depth + 1, budget)) {
    return true;
  }
  return Object.hasOwn(value, "json")
    && inspectAuthSignal(value.json, depth + 1, budget);
}

function bodyRetryAfterSeconds(value, depth = 0, budget = { remaining: 24 }) {
  if (budget.remaining-- <= 0 || depth > 4 || value == null || typeof value !== "object") {
    return null;
  }
  for (const key of ["retryAfterSeconds", "retry_after_seconds", "retryAfter", "retry_after"]) {
    if (!Object.hasOwn(value, key)) continue;
    const numeric = Number(value[key]);
    if (
      Number.isFinite(numeric)
      && numeric >= 0
      && numeric <= MAX_RETRY_AFTER_SECONDS
    ) return numeric;
  }
  for (const key of ["data", "json"]) {
    const nested = bodyRetryAfterSeconds(value[key], depth + 1, budget);
    if (nested != null) return nested;
  }
  return null;
}

async function boundedResponseText(response) {
  let clone;
  try {
    const contentLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_INSPECTION_BYTES) {
      return { state: "too_large" };
    }
    clone = response.clone();
  } catch {
    return { state: "unavailable" };
  }
  if (!clone.body?.getReader) return { state: "unavailable" };

  const reader = clone.body.getReader();
  const readPromise = (async () => {
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_INSPECTION_BYTES) {
          try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ }
          return { state: "too_large" };
        }
        chunks.push(value);
      }
    } catch {
      return { state: "unavailable" };
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { state: "complete", text: new TextDecoder().decode(bytes) };
  })();
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ }
      resolve({ state: "timeout" });
    }, INSPECTION_TIMEOUT_MS);
    timer.unref?.();
  });
  const result = await Promise.race([readPromise, timeoutPromise]);
  clearTimeout(timer);
  return result;
}

async function classifyResponse(response, { endpoint, trpc, nowMs }) {
  const httpStatus = Number.isInteger(response?.status) ? response.status : null;
  const headerRetry = retryAfterSeconds(response, nowMs);
  if (httpStatus === 429) {
    return {
      outcome: "rate_limited",
      errorClass: "rate_limit",
      httpStatus,
      retryAfterSeconds: headerRetry,
    };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      outcome: "other_failure",
      errorClass: "auth_access",
      httpStatus,
      retryAfterSeconds: headerRetry,
    };
  }
  if (httpStatus == null || httpStatus < 200 || httpStatus >= 300) {
    return {
      outcome: "other_failure",
      errorClass: "http_error",
      httpStatus,
      retryAfterSeconds: headerRetry,
    };
  }
  const inspected = await boundedResponseText(response);
  if (inspected.state !== "complete") {
    return {
      outcome: "unverified",
      errorClass: "unverified",
      httpStatus,
      retryAfterSeconds: headerRetry,
    };
  }
  let body;
  try {
    if (inspected.text.trim() === "") {
      return {
        outcome: "unverified",
        errorClass: "unverified",
        httpStatus,
        retryAfterSeconds: headerRetry,
      };
    }
    body = JSON.parse(inspected.text);
  } catch {
    return {
      outcome: "other_failure",
      errorClass: "parse",
      httpStatus,
      retryAfterSeconds: headerRetry,
    };
  }
  const records = Array.isArray(body) ? body : [body];
  const errors = records.filter((record) => record?.error != null).map((record) => record.error);
  if (errors.some((error) => inspectRateLimitSignal(error))) {
    const bodyRetry = errors.map((error) => bodyRetryAfterSeconds(error)).find((value) => value != null);
    return {
      outcome: "rate_limited",
      errorClass: "rate_limit",
      httpStatus,
      retryAfterSeconds: bodyRetry ?? headerRetry,
    };
  }
  if (errors.length > 0) {
    if (errors.some((error) => inspectAuthSignal(error))) {
      return {
        outcome: "other_failure",
        errorClass: "auth_access",
        httpStatus,
        retryAfterSeconds: headerRetry,
      };
    }
    return {
      outcome: "other_failure",
      errorClass: "trpc_error",
      httpStatus,
      retryAfterSeconds: headerRetry,
    };
  }
  if (!trpc) {
    const verified = endpoint !== "rest.unknown" && body != null && typeof body === "object";
    return {
      outcome: verified ? "successful" : "unverified",
      errorClass: verified ? "none" : "unverified",
      httpStatus,
      retryAfterSeconds: headerRetry,
    };
  }
  const verified = records.length > 0
    && records.every((record) => record && typeof record === "object" && record.result != null);
  return {
    outcome: verified ? "successful" : "unverified",
    errorClass: verified ? "none" : "unverified",
    httpStatus,
    retryAfterSeconds: headerRetry,
  };
}

function finishedEvent(base, completedAt, classification) {
  return {
    ...base,
    phase: "finished",
    completedAt,
    outcome: classification.outcome,
    httpStatus: classification.httpStatus,
    errorClass: classification.errorClass,
    retryAfterSeconds: classification.retryAfterSeconds ?? null,
  };
}

function createReporter({ config, telemetryFetchImpl, now, instanceId }) {
  const queue = [];
  let dropped = 0;
  let collectorFailures = 0;
  let flushPromise = null;
  let flushTimer = null;
  let heartbeatState = "unknown";

  const enabled = Boolean(config && instanceId && typeof telemetryFetchImpl === "function");

  function snapshot() {
    return Object.freeze({
      enabled,
      sourceId: config?.sourceId ?? null,
      instanceId: enabled ? instanceId : null,
      queued: queue.length,
      dropped,
      collectorFailures,
      heartbeatState,
    });
  }

  function scheduleFlush() {
    if (!enabled || flushTimer || flushPromise) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, AUTO_FLUSH_DELAY_MS);
  }

  function enqueue(event) {
    if (!enabled) return;
    while (queue.length >= MAX_QUEUE_EVENTS) {
      queue.shift();
      dropped += 1;
    }
    queue.push(event);
    scheduleFlush();
  }

  async function sendBatch(events, heartbeat, deadline) {
    let response;
    try {
      const sentAt = readNow(now);
      if (sentAt == null) return false;
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining <= 0) return false;
      const timeoutMs = Math.min(COLLECTOR_TIMEOUT_MS, remaining);
      const payload = {
        schemaVersion: SCHEMA_VERSION,
        sourceId: config.sourceId,
        instanceId,
        sentAt,
        events,
        heartbeat,
      };
      response = await telemetryFetchImpl(config.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.sourceToken}`,
          "content-type": "application/json",
          "OAI-Sites-Authorization": `Bearer ${config.dispatchToken}`,
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return false;
    }
    return Boolean(response?.ok);
  }

  async function sendBatchWithRetry(events, heartbeat, deadline) {
    let failures = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (Date.now() >= deadline) return { ok: false, failures };
      if (await sendBatch(events, heartbeat, deadline)) return { ok: true, failures };
      failures += 1;
    }
    return { ok: false, failures };
  }

  async function runFlush() {
    if (!enabled) return snapshot();
    const deadline = Date.now() + FLUSH_BUDGET_MS;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (queue.length === 0) {
      const result = await sendBatchWithRetry([], { state: heartbeatState, dropped }, deadline);
      collectorFailures += result.failures;
      return snapshot();
    }

    // A second bounded round catches outcomes queued while the first collector
    // POST is in flight. Anything arriving during round two remains queued and
    // is scheduled by flush()'s finalizer; explicit flush never waits forever.
    for (let round = 0; round < MAX_FLUSH_ROUNDS && queue.length > 0; round += 1) {
      const pending = queue.splice(0, MAX_QUEUE_EVENTS);
      const batches = [];
      for (let i = 0; i < pending.length; i += MAX_BATCH_EVENTS) {
        batches.push(pending.slice(i, i + MAX_BATCH_EVENTS));
      }
      const results = await Promise.all(batches.map((events) => sendBatchWithRetry(
        events,
        { state: heartbeatState, dropped },
        deadline,
      )));
      for (let i = 0; i < results.length; i += 1) {
        collectorFailures += results[i].failures;
        if (!results[i].ok) dropped += batches[i].length;
      }
      if (Date.now() >= deadline) break;
      await Promise.resolve();
    }
    if (queue.length > 0 && Date.now() >= deadline) {
      dropped += queue.length;
      queue.length = 0;
    }
    return snapshot();
  }

  function flush() {
    if (flushPromise) return flushPromise;
    flushPromise = runFlush()
      .catch(() => {
        collectorFailures += 1;
        return snapshot();
      })
      .finally(() => {
        flushPromise = null;
        if (queue.length > 0) scheduleFlush();
      });
    return flushPromise;
  }

  function heartbeat(state = "active") {
    if (HEARTBEAT_STATES.has(state)) heartbeatState = state;
    scheduleFlush();
    return flush();
  }

  return { enqueue, flush, heartbeat, snapshot };
}

/**
 * Wrap one fetch implementation without changing its provider semantics.
 * Every invocation against www.paraform.com is one attempt. The wrapper adds
 * no provider retries, never consumes the returned body, and never throws for
 * telemetry configuration, inspection, queuing, or collector failures.
 *
 * Automatic flush is best-effort. Serverless entrypoints should attach
 * `wrapped.flush()` to their lifecycle finalizer/waitUntil hook.
 */
export function createTelemetryFetch({
  fetchImpl = globalThis.fetch,
  sourceId,
  env = globalThis.process?.env ?? {},
  telemetryFetchImpl = globalThis.fetch,
  now = Date.now,
  uuidImpl = randomUuid,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const config = collectorConfig(env, sourceId);
  let instanceId = null;
  try { instanceId = uuidImpl(); } catch { instanceId = null; }
  if (!validUuid(instanceId)) instanceId = null;
  const reporter = createReporter({ config, telemetryFetchImpl, now, instanceId });

  const wrapped = async function telemetryFetch(input, init) {
    let facts = null;
    try { facts = reporter.snapshot().enabled ? requestFacts(input, init) : null; } catch { facts = null; }
    if (!facts) return fetchImpl(input, init);

    let id = null;
    try { id = uuidImpl(); } catch { id = null; }
    if (!validUuid(id)) return fetchImpl(input, init);
    const startedAt = readNow(now);
    if (startedAt == null) return fetchImpl(input, init);
    const base = {
      id,
      startedAt,
      method: facts.method,
      endpoint: facts.endpoint,
    };
    try {
      reporter.enqueue({ ...base, phase: "started" });
    } catch { /* provider call remains authoritative */ }

    let response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      try {
        const completedAt = readNow(now);
        if (completedAt != null) {
          reporter.enqueue(finishedEvent(base, completedAt, {
            outcome: "other_failure",
            errorClass: transportErrorClass(error),
            httpStatus: null,
            retryAfterSeconds: null,
          }));
        }
      } catch { /* preserve the exact provider error */ }
      throw error;
    }

    try {
      const classificationAt = readNow(now);
      if (classificationAt == null) return response;
      const classification = await classifyResponse(response, {
        endpoint: facts.endpoint,
        trpc: facts.trpc,
        nowMs: classificationAt,
      });
      const classifiedAt = readNow(now);
      if (classifiedAt != null) reporter.enqueue(finishedEvent(base, classifiedAt, classification));
    } catch {
      try {
        const completedAt = readNow(now);
        if (completedAt == null) return response;
        reporter.enqueue(finishedEvent(base, completedAt, {
          outcome: "unverified",
          errorClass: "unverified",
          httpStatus: Number.isInteger(response?.status) ? response.status : null,
          retryAfterSeconds: null,
        }));
      } catch { /* preserve provider response */ }
    }
    return response;
  };

  Object.defineProperties(wrapped, {
    flush: { value: reporter.flush, enumerable: false },
    heartbeat: { value: reporter.heartbeat, enumerable: false },
    snapshot: { value: reporter.snapshot, enumerable: false },
  });
  return wrapped;
}

export async function flushTelemetry(telemetryFetch) {
  return typeof telemetryFetch?.flush === "function"
    ? telemetryFetch.flush()
    : Object.freeze({ enabled: false, queued: 0, dropped: 0, collectorFailures: 0 });
}

export async function heartbeatTelemetry(telemetryFetch, state = "active") {
  return typeof telemetryFetch?.heartbeat === "function"
    ? telemetryFetch.heartbeat(state)
    : Object.freeze({ enabled: false, queued: 0, dropped: 0, collectorFailures: 0 });
}
