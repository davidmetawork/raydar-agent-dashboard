// Dedicated Redis REST adapter for hard-dark Recall classified evidence.
//
// One Lua transition owns Redis TIME, clock-regression rejection, exact
// absolute expiry, SET NX, and lost-response recovery. It has a disjoint
// namespace and configuration from the reference and point-observation
// stores. There is no generic KV fallback.

import {
  TextDecoder,
  types as nodeTypes,
} from "node:util";

export const
SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_ADAPTER_VERSION =
  "recall-classified-evidence-persistence-adapter-dark-v1";
export const
SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_URL_ENV =
  "PARAAI_SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_URL";
export const
SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_TOKEN_ENV =
  "PARAAI_SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_TOKEN";

const REQUEST_TIMEOUT_MS = 8_000;
const RECORD_MAX_BYTES = 256 * 1_024;
const WIRE_MAX_BYTES = 384 * 1_024;
const KEY = /^paraai:phase4:recall-classified-evidence:v1:work:[a-f0-9]{64}$/u;
const OPTION_KEYS = new Set([
  "fetchImpl",
  "signalFactory",
  "token",
  "url",
]);

export class SourceRecallClassifiedEvidencePersistenceError
  extends Error {
  constructor(code) {
    super(code);
    this.name =
      "SourceRecallClassifiedEvidencePersistenceError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallClassifiedEvidencePersistenceError(
    code,
  );
}

function deepFreeze(value) {
  if (
    value
    && typeof value === "object"
    && !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function plainRecordSnapshot(value, code) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    fail(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype
    && prototype !== null
  ) {
    fail(code);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(code);
  }
  const snapshot = Object.create(null);
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value",
      )
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactRecord(value, keys, code) {
  const record = plainRecordSnapshot(value, code);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some(
      (key, index) => key !== expected[index],
    )
  ) {
    fail(code);
  }
  return record;
}

function exactTimestamp(value, code) {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value <= 0
  ) {
    fail(code);
  }
  return value;
}

function configurationFromEnvironment() {
  return {
    url: String(
      process.env[
        SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_URL_ENV
      ] || "",
    ),
    token: String(
      process.env[
        SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_TOKEN_ENV
      ] || "",
    ),
  };
}

function canonicalConfiguration(urlValue, tokenValue) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_CONFIGURATION_INVALID";
  const url = typeof urlValue === "string"
    ? urlValue.replace(/\/+$/u, "")
    : "";
  const token = typeof tokenValue === "string"
    ? tokenValue
    : "";
  if (Boolean(url) !== Boolean(token)) fail(code);
  if (!url && !token) {
    fail("SOURCE_RECALL_CLASSIFIED_EVIDENCE_UNAVAILABLE");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(code);
  }
  if (
    parsed.protocol !== "https:"
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    fail(code);
  }
  return Object.freeze({ token, url });
}

export function sourceRecallClassifiedEvidencePersistenceConfigured() {
  const { url, token } = configurationFromEnvironment();
  if (!url || !token || Boolean(url) !== Boolean(token)) {
    return false;
  }
  try {
    canonicalConfiguration(url, token);
    return true;
  } catch {
    return false;
  }
}

function options(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_CONFIGURATION_INVALID";
  if (value === undefined) return Object.create(null);
  const selected = plainRecordSnapshot(value, code);
  if (
    Object.keys(selected).some(
      (key) => !OPTION_KEYS.has(key),
    )
  ) {
    fail(code);
  }
  return selected;
}

function responseHeader(headers, name) {
  if (typeof headers?.get === "function") {
    return String(headers.get(name) || "");
  }
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) {
      return value.length === 1 ? String(value[0] || "") : "";
    }
    return String(value || "");
  }
  return "";
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The stable adapter error remains the only observable result.
  }
}

async function boundedResponseText(response) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_FAILED";
  const contentLength = responseHeader(
    response?.headers,
    "content-length",
  );
  if (contentLength) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      fail(code);
    }
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared)
      || declared > WIRE_MAX_BYTES
    ) {
      fail(code);
    }
  }
  if (!response?.body) fail(code);
  const chunks = [];
  let size = 0;
  const append = (chunk) => {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    size += bytes.length;
    if (size > WIRE_MAX_BYTES) fail(code);
    chunks.push(bytes);
  };
  if (typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        append(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else if (
    typeof response.body[Symbol.asyncIterator] === "function"
  ) {
    for await (const chunk of response.body) {
      append(chunk);
    }
  } else {
    fail(code);
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(Buffer.concat(chunks, size));
  } catch {
    fail(code);
  }
}

function redisNowMs(result, offset, code) {
  if (
    !Array.isArray(result)
    || !/^(?:0|[1-9][0-9]*)$/u.test(
      String(result[offset] ?? ""),
    )
    || !/^[0-9]{1,6}$/u.test(
      String(result[offset + 1] ?? ""),
    )
  ) {
    fail(code);
  }
  const seconds = Number(result[offset]);
  const microseconds = Number(result[offset + 1]);
  if (
    !Number.isSafeInteger(seconds)
    || !Number.isSafeInteger(microseconds)
    || microseconds < 0
    || microseconds > 999_999
  ) {
    fail(code);
  }
  return exactTimestamp(
    seconds * 1_000 + Math.floor(microseconds / 1_000),
    code,
  );
}

const RETAIN_LUA = `
  -- recall_classified_evidence_retain_v1
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local issuedAtMs = tonumber(ARGV[2])
  local notAfterMs = tonumber(ARGV[3])
  local expiresAtMs = tonumber(ARGV[4])
  if not issuedAtMs
    or issuedAtMs ~= math.floor(issuedAtMs)
    or not notAfterMs
    or notAfterMs ~= math.floor(notAfterMs)
    or not expiresAtMs
    or expiresAtMs ~= math.floor(expiresAtMs)
    or issuedAtMs >= notAfterMs
    or notAfterMs > expiresAtMs
    or nowMs < issuedAtMs
    or nowMs >= notAfterMs
    or nowMs >= expiresAtMs then
    return {2, false, redisTime[1], redisTime[2], -2}
  end
  local current = redis.call('GET', KEYS[1])
  if current then
    return {
      0,
      current,
      redisTime[1],
      redisTime[2],
      redis.call('PEXPIRETIME', KEYS[1])
    }
  end
  local stored = redis.call(
    'SET',
    KEYS[1],
    ARGV[1],
    'NX',
    'PXAT',
    tostring(expiresAtMs)
  )
  if not stored then
    current = redis.call('GET', KEYS[1])
    return {
      0,
      current,
      redisTime[1],
      redisTime[2],
      redis.call('PEXPIRETIME', KEYS[1])
    }
  end
  return {
    1,
    ARGV[1],
    redisTime[1],
    redisTime[2],
    redis.call('PEXPIRETIME', KEYS[1])
  }
`;

export function createSourceRecallClassifiedEvidencePersistenceAdapter(
  value,
) {
  const selected = options(value);
  const environment = configurationFromEnvironment();
  const hasUrl = Object.prototype.hasOwnProperty.call(
    selected,
    "url",
  );
  const hasToken = Object.prototype.hasOwnProperty.call(
    selected,
    "token",
  );
  if (hasUrl !== hasToken) {
    fail(
      "SOURCE_RECALL_CLASSIFIED_EVIDENCE_CONFIGURATION_INVALID",
    );
  }
  const configuration = canonicalConfiguration(
    hasUrl ? selected.url : environment.url,
    hasToken ? selected.token : environment.token,
  );
  const fetchImpl = Object.prototype.hasOwnProperty.call(
    selected,
    "fetchImpl",
  )
    ? selected.fetchImpl
    : globalThis.fetch;
  const signalFactory =
    Object.prototype.hasOwnProperty.call(
      selected,
      "signalFactory",
    )
      ? selected.signalFactory
      : (timeoutMs) => AbortSignal.timeout(timeoutMs);
  if (
    typeof fetchImpl !== "function"
    || typeof signalFactory !== "function"
  ) {
    fail(
      "SOURCE_RECALL_CLASSIFIED_EVIDENCE_CONFIGURATION_INVALID",
    );
  }

  async function execute(command) {
    const code =
      "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_FAILED";
    const body = JSON.stringify(command);
    if (Buffer.byteLength(body, "utf8") > WIRE_MAX_BYTES) {
      fail(code);
    }
    let response;
    try {
      response = await fetchImpl(configuration.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${configuration.token}`,
          "content-type": "application/json",
        },
        body,
        cache: "no-store",
        redirect: "error",
        signal: signalFactory(REQUEST_TIMEOUT_MS),
      });
    } catch {
      fail(code);
    }
    try {
      if (
        !response
        || response.status !== 200
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu
          .test(
            responseHeader(
              response.headers,
              "content-type",
            ).trim(),
          )
      ) {
        fail(code);
      }
      const text = await boundedResponseText(response);
      const envelope = exactRecord(
        JSON.parse(text),
        ["result"],
        code,
      );
      return envelope.result;
    } catch {
      await cancelResponseBody(response);
      fail(code);
    }
  }

  return deepFreeze({
    async retain(inputValue) {
      const code =
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_INPUT_INVALID";
      const input = exactRecord(
        inputValue,
        [
          "issuedAtMs",
          "expiresAtMs",
          "key",
          "notAfterMs",
          "proposedRaw",
        ],
        code,
      );
      if (
        typeof input.key !== "string"
        || !KEY.test(input.key)
        || typeof input.proposedRaw !== "string"
        || input.proposedRaw.length === 0
        || Buffer.byteLength(input.proposedRaw, "utf8")
          > RECORD_MAX_BYTES
      ) {
        fail(code);
      }
      const issuedAtMs = exactTimestamp(
        input.issuedAtMs,
        code,
      );
      const notAfterMs = exactTimestamp(
        input.notAfterMs,
        code,
      );
      const expiresAtMs = exactTimestamp(
        input.expiresAtMs,
        code,
      );
      if (
        issuedAtMs >= notAfterMs
        || notAfterMs > expiresAtMs
      ) {
        fail(code);
      }
      const result = await execute([
        "EVAL",
        RETAIN_LUA,
        1,
        input.key,
        input.proposedRaw,
        String(issuedAtMs),
        String(notAfterMs),
        String(expiresAtMs),
      ]);
      if (
        !Array.isArray(result)
        || result.length !== 5
        || ![0, 1, 2].includes(result[0])
        || !(
          typeof result[1] === "string"
          || result[1] === null
        )
        || !Number.isSafeInteger(result[4])
        || (
          result[0] === 2
          && (
            result[1] !== null
            || result[4] !== -2
          )
        )
        || (
          result[0] !== 2
          && (
            typeof result[1] !== "string"
            || result[4] <= 0
          )
        )
      ) {
        fail(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
        );
      }
      const statusCode = result[0];
      return deepFreeze({
        status: statusCode === 1
          ? "created"
          : statusCode === 0
            ? "existing"
            : "expired",
        raw: typeof result[1] === "string"
          ? result[1]
          : null,
        redisNowMs: redisNowMs(
          result,
          2,
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
        ),
        expiresAtMs: result[4],
      });
    },
  });
}
