// Dedicated Redis REST adapter for hard-dark Recall classified evidence.
//
// Bounded Lua transitions own Redis TIME, clock-regression rejection,
// conservative absolute expiry, initialization, shortening-only CAS, and
// lost-response recovery. They have a disjoint namespace and configuration
// from the reference and point-observation stores. There is no generic KV
// fallback.

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
const REQUEST_MAX_BYTES = 9 * 1_024 * 1_024;
const RESPONSE_MAX_BYTES = 384 * 1_024;
const READ_MANY_RESPONSE_MAX_BYTES = 9 * 1_024 * 1_024;
const MAX_INITIALIZE_SHARDS = 1_000;
const MAX_MULTI_KEYS = 20;
// Managed Redis deployments can evaluate TIME and absolute expiry on nodes
// whose clocks differ by a few milliseconds. Expire the physical key one
// second before the signed logical deadline, then require the provider's
// observed PEXPIRETIME to remain at or below that logical deadline. This
// preserves the upstream upper bound without treating harmless early expiry
// as record corruption.
export const
SOURCE_RECALL_CLASSIFIED_EVIDENCE_EXPIRY_SAFETY_MARGIN_MS =
  1_000;
const WORK_KEY =
  /^paraai:phase4:recall-classified-evidence:v1:work:[a-f0-9]{64}$/u;
const MANIFEST_KEY =
  /^paraai:phase4:recall-classified-evidence:v1:manifest:\{[a-f0-9]{64}\}:index$/u;
const SHARD_KEY =
  /^paraai:phase4:recall-classified-evidence:v1:manifest:\{[a-f0-9]{64}\}:index:shard:(?:0|[1-9][0-9]{0,2})$/u;
const MANIFEST_HASH_TAG = /\{([a-f0-9]{64})\}/u;
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

function exactNonnegativeInteger(value, code) {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < 0
  ) {
    fail(code);
  }
  return value;
}

function adapterKey(value, code) {
  if (
    typeof value !== "string"
    || !(
      WORK_KEY.test(value)
      || MANIFEST_KEY.test(value)
      || SHARD_KEY.test(value)
    )
  ) {
    fail(code);
  }
  return value;
}

function manifestHashTag(value, code) {
  const match = MANIFEST_HASH_TAG.exec(value);
  if (match === null) fail(code);
  return match[1];
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

async function boundedResponseText(
  response,
  maxBytes = RESPONSE_MAX_BYTES,
) {
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
      || declared > maxBytes
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
    if (size > maxBytes) fail(code);
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

const INITIALIZE_MANIFEST_LUA = `
  -- recall_classified_evidence_manifest_initialize_v1
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
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
  for keyIndex = 2, #KEYS do
    if redis.call('EXISTS', KEYS[keyIndex]) == 1 then
      return {3, false, redisTime[1], redisTime[2], -2}
    end
  end
  local issuedAtMs = tonumber(ARGV[2])
  local notAfterMs = tonumber(ARGV[3])
  local expiresAtMs = tonumber(ARGV[4])
  local expirySafetyMarginMs = tonumber(ARGV[5])
  local storageExpiresAtMs = expiresAtMs
    and expirySafetyMarginMs
    and expiresAtMs - expirySafetyMarginMs
  if not issuedAtMs
    or issuedAtMs ~= math.floor(issuedAtMs)
    or not notAfterMs
    or notAfterMs ~= math.floor(notAfterMs)
    or not expiresAtMs
    or expiresAtMs ~= math.floor(expiresAtMs)
    or not expirySafetyMarginMs
    or expirySafetyMarginMs ~= math.floor(expirySafetyMarginMs)
    or expirySafetyMarginMs <= 0
    or not storageExpiresAtMs
    or storageExpiresAtMs ~= math.floor(storageExpiresAtMs)
    or issuedAtMs >= notAfterMs
    or notAfterMs > expiresAtMs
    or nowMs < issuedAtMs
    or nowMs >= notAfterMs
    or nowMs >= storageExpiresAtMs then
    return {2, false, redisTime[1], redisTime[2], -2}
  end
  for keyIndex = 2, #KEYS do
    local stored = redis.pcall(
      'SET',
      KEYS[keyIndex],
      ARGV[keyIndex + 4],
      'NX',
      'PXAT',
      tostring(storageExpiresAtMs)
    )
    if type(stored) == 'table' or not stored then
      for rollbackIndex = 2, keyIndex - 1 do
        redis.pcall('DEL', KEYS[rollbackIndex])
      end
      return {3, false, redisTime[1], redisTime[2], -2}
    end
  end
  local storedIndex = redis.pcall(
    'SET',
    KEYS[1],
    ARGV[1],
    'NX',
    'PXAT',
    tostring(storageExpiresAtMs)
  )
  if type(storedIndex) == 'table' or not storedIndex then
    for rollbackIndex = 2, #KEYS do
      redis.pcall('DEL', KEYS[rollbackIndex])
    end
    return {3, false, redisTime[1], redisTime[2], -2}
  end
  local observedExpiresAtMs =
    redis.call('PEXPIRETIME', KEYS[1])
  if observedExpiresAtMs <= nowMs
    or observedExpiresAtMs > expiresAtMs then
    for keyIndex = 1, #KEYS do
      redis.call('DEL', KEYS[keyIndex])
    end
    return {2, false, redisTime[1], redisTime[2], -2}
  end
  return {
    1,
    ARGV[1],
    redisTime[1],
    redisTime[2],
    observedExpiresAtMs
  }
`;

const READ_LUA = `
  -- recall_classified_evidence_read_v1
  local redisTime = redis.call('TIME')
  local current = redis.call('GET', KEYS[1])
  if not current then
    return {false, redisTime[1], redisTime[2], -2}
  end
  return {
    current,
    redisTime[1],
    redisTime[2],
    redis.call('PEXPIRETIME', KEYS[1])
  }
`;

const READ_MANY_LUA = `
  -- recall_classified_evidence_read_many_v1
  local redisTime = redis.call('TIME')
  local result = {redisTime[1], redisTime[2]}
  for keyIndex = 1, #KEYS do
    local current = redis.call('GET', KEYS[keyIndex])
    if current then
      table.insert(result, current)
      table.insert(
        result,
        redis.call('PEXPIRETIME', KEYS[keyIndex])
      )
    else
      table.insert(result, false)
      table.insert(result, -2)
    end
  end
  return result
`;

const CAS_LUA = `
  -- recall_classified_evidence_cas_v1
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local current = redis.call('GET', KEYS[1])
  local currentExpiry = redis.call('PEXPIRETIME', KEYS[1])
  local expectedExpiry = tonumber(ARGV[3])
  local nextExpiry = tonumber(ARGV[4])
  local notAfterMs = tonumber(ARGV[5])
  if not current or current ~= ARGV[1] then
    return {
      0,
      current,
      redisTime[1],
      redisTime[2],
      currentExpiry
    }
  end
  if not expectedExpiry
    or expectedExpiry ~= math.floor(expectedExpiry)
    or currentExpiry ~= expectedExpiry
    or not nextExpiry
    or nextExpiry ~= math.floor(nextExpiry)
    or nextExpiry > expectedExpiry
    or not notAfterMs
    or notAfterMs ~= math.floor(notAfterMs)
    or nowMs >= expectedExpiry
    or nowMs >= nextExpiry
    or nowMs >= notAfterMs then
    return {
      2,
      current,
      redisTime[1],
      redisTime[2],
      currentExpiry
    }
  end
  local stored = redis.call(
    'SET',
    KEYS[1],
    ARGV[2],
    'XX',
    'PXAT',
    tostring(nextExpiry)
  )
  if not stored then
    return {
      0,
      redis.call('GET', KEYS[1]),
      redisTime[1],
      redisTime[2],
      redis.call('PEXPIRETIME', KEYS[1])
    }
  end
  local observedExpiresAtMs =
    redis.call('PEXPIRETIME', KEYS[1])
  if observedExpiresAtMs <= nowMs
    or observedExpiresAtMs > nextExpiry
    or observedExpiresAtMs > notAfterMs then
    redis.call('DEL', KEYS[1])
    return {2, false, redisTime[1], redisTime[2], -2}
  end
  return {
    1,
    ARGV[2],
    redisTime[1],
    redisTime[2],
    observedExpiresAtMs
  }
`;

const RETAIN_LUA = `
  -- recall_classified_evidence_retain_v1
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local issuedAtMs = tonumber(ARGV[2])
  local notAfterMs = tonumber(ARGV[3])
  local expiresAtMs = tonumber(ARGV[4])
  local expirySafetyMarginMs = tonumber(ARGV[5])
  local storageExpiresAtMs = expiresAtMs
    and expirySafetyMarginMs
    and expiresAtMs - expirySafetyMarginMs
  if not issuedAtMs
    or issuedAtMs ~= math.floor(issuedAtMs)
    or not notAfterMs
    or notAfterMs ~= math.floor(notAfterMs)
    or not expiresAtMs
    or expiresAtMs ~= math.floor(expiresAtMs)
    or not expirySafetyMarginMs
    or expirySafetyMarginMs ~= math.floor(expirySafetyMarginMs)
    or expirySafetyMarginMs <= 0
    or not storageExpiresAtMs
    or storageExpiresAtMs ~= math.floor(storageExpiresAtMs)
    or issuedAtMs >= notAfterMs
    or notAfterMs > expiresAtMs
    or nowMs < issuedAtMs
    or nowMs >= notAfterMs
    or nowMs >= storageExpiresAtMs then
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
    tostring(storageExpiresAtMs)
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
  local observedExpiresAtMs =
    redis.call('PEXPIRETIME', KEYS[1])
  if observedExpiresAtMs <= nowMs
    or observedExpiresAtMs > expiresAtMs then
    redis.call('DEL', KEYS[1])
    return {2, false, redisTime[1], redisTime[2], -2}
  end
  return {
    1,
    ARGV[1],
    redisTime[1],
    redisTime[2],
    observedExpiresAtMs
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

  async function execute(
    command,
    responseMaxBytes = RESPONSE_MAX_BYTES,
  ) {
    const code =
      "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_FAILED";
    const body = JSON.stringify(command);
    if (
      Buffer.byteLength(body, "utf8")
        > REQUEST_MAX_BYTES
    ) {
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
      const text = await boundedResponseText(
        response,
        responseMaxBytes,
      );
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

  async function evaluate(
    script,
    keys,
    args = [],
    responseMaxBytes = RESPONSE_MAX_BYTES,
  ) {
    return execute([
      "EVAL",
      script,
      keys.length,
      ...keys,
      ...args.map(String),
    ], responseMaxBytes);
  }

  return deepFreeze({
    async initializeManifest(inputValue) {
      const code =
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_INPUT_INVALID";
      const input = exactRecord(
        inputValue,
        [
          "expiresAtMs",
          "index",
          "issuedAtMs",
          "notAfterMs",
          "shards",
        ],
        code,
      );
      const index = exactRecord(
        input.index,
        ["key", "proposedRaw"],
        code,
      );
      const indexKey = adapterKey(index.key, code);
      if (!MANIFEST_KEY.test(indexKey)) fail(code);
      if (
        typeof index.proposedRaw !== "string"
        || index.proposedRaw.length === 0
        || Buffer.byteLength(index.proposedRaw, "utf8")
          > RECORD_MAX_BYTES
        || !Array.isArray(input.shards)
        || input.shards.length > MAX_INITIALIZE_SHARDS
        || Object.keys(input.shards).length
          !== input.shards.length
      ) {
        fail(code);
      }
      const shardKeys = new Set();
      const shards = input.shards.map((value) => {
        const shard = exactRecord(
          value,
          ["key", "proposedRaw"],
          code,
        );
        const key = adapterKey(shard.key, code);
        if (
          !SHARD_KEY.test(key)
          || shardKeys.has(key)
          || typeof shard.proposedRaw !== "string"
          || shard.proposedRaw.length === 0
          || Buffer.byteLength(shard.proposedRaw, "utf8")
            > RECORD_MAX_BYTES
        ) {
          fail(code);
        }
        shardKeys.add(key);
        return shard;
      });
      const indexHashTag = manifestHashTag(
        indexKey,
        code,
      );
      if (
        shards.some(
          (shard) =>
            manifestHashTag(shard.key, code)
              !== indexHashTag,
        )
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
      const result = await evaluate(
        INITIALIZE_MANIFEST_LUA,
        [indexKey, ...shards.map((shard) => shard.key)],
        [
          index.proposedRaw,
          issuedAtMs,
          notAfterMs,
          expiresAtMs,
          SOURCE_RECALL_CLASSIFIED_EVIDENCE_EXPIRY_SAFETY_MARGIN_MS,
          ...shards.map((shard) => shard.proposedRaw),
        ],
      );
      if (
        !Array.isArray(result)
        || result.length !== 5
        || ![0, 1, 2, 3].includes(result[0])
        || !(
          typeof result[1] === "string"
          || result[1] === null
        )
        || !Number.isSafeInteger(result[4])
        || (
          [2, 3].includes(result[0])
          && (
            result[1] !== null
            || result[4] !== -2
          )
        )
        || (
          [0, 1].includes(result[0])
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
      const observedRedisNowMs = redisNowMs(
        result,
        2,
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
      );
      if (
        [0, 1].includes(result[0])
        && (
          result[4] <= observedRedisNowMs
          || result[4] > expiresAtMs
        )
      ) {
        fail(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
        );
      }
      return deepFreeze({
        status: result[0] === 1
          ? "created"
          : result[0] === 0
            ? "existing"
            : result[0] === 2
              ? "expired"
              : "conflict",
        raw: typeof result[1] === "string"
          ? result[1]
          : null,
        redisNowMs: observedRedisNowMs,
        expiresAtMs: result[4],
      });
    },
    async read(inputValue) {
      const code =
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_INPUT_INVALID";
      const input = exactRecord(
        inputValue,
        ["key"],
        code,
      );
      const result = await evaluate(
        READ_LUA,
        [adapterKey(input.key, code)],
      );
      if (
        !Array.isArray(result)
        || result.length !== 4
        || !(
          typeof result[0] === "string"
          || result[0] === null
        )
        || !Number.isSafeInteger(result[3])
        || (
          result[0] === null
          && result[3] !== -2
        )
        || (
          typeof result[0] === "string"
          && result[3] <= 0
        )
      ) {
        fail(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
        );
      }
      const observedRedisNowMs = redisNowMs(
        result,
        1,
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
      );
      if (
        typeof result[0] === "string"
        && result[3] <= observedRedisNowMs
      ) {
        fail(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
        );
      }
      return deepFreeze({
        raw: typeof result[0] === "string"
          ? result[0]
          : null,
        redisNowMs: observedRedisNowMs,
        expiresAtMs: result[3],
      });
    },
    async readMany(inputValue) {
      const code =
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_INPUT_INVALID";
      const input = exactRecord(
        inputValue,
        ["keys"],
        code,
      );
      if (
        !Array.isArray(input.keys)
        || input.keys.length < 1
        || input.keys.length > MAX_MULTI_KEYS
        || Object.keys(input.keys).length
          !== input.keys.length
      ) {
        fail(code);
      }
      const keys = input.keys.map(
        (key) => adapterKey(key, code),
      );
      if (new Set(keys).size !== keys.length) fail(code);
      const hashTags = keys.map(
        (key) => manifestHashTag(key, code),
      );
      if (
        hashTags.some(
          (hashTag) => hashTag !== hashTags[0],
        )
      ) {
        fail(code);
      }
      const result = await evaluate(
        READ_MANY_LUA,
        keys,
        [],
        READ_MANY_RESPONSE_MAX_BYTES,
      );
      if (
        !Array.isArray(result)
        || result.length !== 2 + keys.length * 2
      ) {
        fail(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
        );
      }
      const observedRedisNowMs = redisNowMs(
        result,
        0,
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
      );
      const records = keys.map((key, index) => {
        const raw = result[2 + index * 2];
        const expiresAtMs = result[3 + index * 2];
        if (
          !(
            typeof raw === "string"
            || raw === null
          )
          || !Number.isSafeInteger(expiresAtMs)
          || (
            raw === null
            && expiresAtMs !== -2
          )
          || (
            typeof raw === "string"
            && expiresAtMs <= observedRedisNowMs
          )
        ) {
          fail(
            "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
          );
        }
        return deepFreeze({
          key,
          raw: typeof raw === "string" ? raw : null,
          expiresAtMs,
        });
      });
      return deepFreeze({
        records,
        redisNowMs: observedRedisNowMs,
      });
    },
    async compareAndSet(inputValue) {
      const code =
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_INPUT_INVALID";
      const input = exactRecord(
        inputValue,
        [
          "expectedRaw",
          "expiresAtMs",
          "key",
          "nextExpiresAtMs",
          "nextRaw",
          "notAfterMs",
        ],
        code,
      );
      const key = adapterKey(input.key, code);
      for (const raw of [
        input.expectedRaw,
        input.nextRaw,
      ]) {
        if (
          typeof raw !== "string"
          || raw.length === 0
          || Buffer.byteLength(raw, "utf8")
            > RECORD_MAX_BYTES
        ) {
          fail(code);
        }
      }
      const expiresAtMs = exactTimestamp(
        input.expiresAtMs,
        code,
      );
      const nextExpiresAtMs = exactTimestamp(
        input.nextExpiresAtMs,
        code,
      );
      const notAfterMs = exactTimestamp(
        input.notAfterMs,
        code,
      );
      if (nextExpiresAtMs > expiresAtMs) fail(code);
      const result = await evaluate(
        CAS_LUA,
        [key],
        [
          input.expectedRaw,
          input.nextRaw,
          expiresAtMs,
          nextExpiresAtMs,
          notAfterMs,
        ],
      );
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
          result[0] === 0
          && (
            (
              result[1] === null
              && result[4] !== -2
            )
            || (
              typeof result[1] === "string"
              && result[4] <= 0
            )
          )
        )
        || (
          result[0] === 1
          && (
            typeof result[1] !== "string"
            || result[4] <= 0
            || result[4] > notAfterMs
          )
        )
        || (
          result[0] === 2
          && !(
            (
              typeof result[1] === "string"
              && result[4] > 0
            )
            || (
              result[1] === null
              && result[4] === -2
            )
          )
        )
      ) {
        fail(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
        );
      }
      const observedRedisNowMs = redisNowMs(
        result,
        2,
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
      );
      if (
        result[0] === 1
        && (
          result[4] <= observedRedisNowMs
          || result[4] > nextExpiresAtMs
        )
      ) {
        fail(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
        );
      }
      return deepFreeze({
        status: result[0] === 1
          ? "stored"
          : result[0] === 0
            ? "conflict"
            : "expired",
        raw: typeof result[1] === "string"
          ? result[1]
          : null,
        redisNowMs: observedRedisNowMs,
        expiresAtMs: result[4],
      });
    },
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
        || !WORK_KEY.test(input.key)
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
        String(
          SOURCE_RECALL_CLASSIFIED_EVIDENCE_EXPIRY_SAFETY_MARGIN_MS,
        ),
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
      const observedRedisNowMs = redisNowMs(
        result,
        2,
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
      );
      if (
        statusCode !== 2
        && (
          result[4] <= observedRedisNowMs
          || result[4] > expiresAtMs
        )
      ) {
        fail(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
        );
      }
      return deepFreeze({
        status: statusCode === 1
          ? "created"
          : statusCode === 0
            ? "existing"
            : "expired",
        raw: typeof result[1] === "string"
          ? result[1]
          : null,
        redisNowMs: observedRedisNowMs,
        expiresAtMs: result[4],
      });
    },
  });
}
