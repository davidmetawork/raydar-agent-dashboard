// Hard-dark production persistence adapter for the Recall reference protocol.
//
// This leaf is deliberately not imported by a route, worker, coordinator,
// health surface, release gate, or source tick. A future, separately reviewed
// runtime composition may inject the exact six-method object returned here
// into source-recall-reference-persistence-protocol.mjs.
//
// Large run/page values are first placed behind one short, non-renewable
// Redis-time writer lease. Every stage is read back byte-exactly before one
// small final EVAL may publish the logical run root. Visible private pages are
// immutable self-describing envelopes whose committed SHA-256/length metadata,
// Redis-native whole-body SHA-1 byte proof, and original PXAT are re-proved
// atomically. Private bodies never cross the Redis boundary during set proof
// and are never retained in a process cache. There are no transparent request
// retries.
//
// Redis TIME is cached for one EVAL, so its first value is the explicit
// linearization timestamp. The final writer preflights an additional fixed
// completion budget against every deadline and retention floor, performs all
// fallible proof work before mutation, then leaves only guarded SET/cleanup.
// Activation therefore requires a target-tier maximum-shape REST round trip
// comfortably below the 8-second client timeout and the EVAL itself below
// SOURCE_RECALL_REFERENCE_ATOMIC_SCRIPT_BUDGET_MS.

import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  types as nodeTypes,
} from "node:util";

import {
  SOURCE_RECALL_REFERENCE_ATOMIC_COMMIT_BUDGET_MS,
  SOURCE_RECALL_REFERENCE_MAX_PAGES,
  SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS,
  validateRecallReferenceRun,
} from "./source-recall-reference-persistence-protocol.mjs";

export const SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_VERSION =
  "recall-reference-persistence-adapter-dark-v1";
export const SOURCE_RECALL_REFERENCE_ATOMIC_PROOF_MAX_BYTES =
  4 * 1024 * 1024;
export const SOURCE_RECALL_REFERENCE_ATOMIC_SCRIPT_BUDGET_MS =
  SOURCE_RECALL_REFERENCE_ATOMIC_COMMIT_BUDGET_MS;
export const SOURCE_RECALL_REFERENCE_REQUEST_MAX_BYTES =
  9_000_000;

const REQUEST_TIMEOUT_MS = 8_000;
const RESPONSE_MAX_BYTES =
  SOURCE_RECALL_REFERENCE_REQUEST_MAX_BYTES;
const STAGE_LEASE_MS = 60_000;
const STAGE_PREFIX = "paraai:phase4:recall-reference:stage:v1:";
const WRITER_PREFIX = "paraai:phase4:recall-reference:writer:v1:";
const FENCE_PREFIX = "paraai:phase4:recall-reference:fence:v1:";
const RUN_STAGE_MAGIC = "RRRS1|";
const PAGE_ENVELOPE_MAGIC = "RRPG1|";
const DIGEST = /^[a-f0-9]{64}$/u;
const NATIVE_BYTE_PROOF_DIGEST = /^[a-f0-9]{40}$/u;
const RUN_KEY = new RegExp(
  "^paraai:phase4:recall-reference:run:v1:"
    + "([a-f0-9]{64})$",
  "u",
);
const HEAD_KEY = new RegExp(
  "^paraai:phase4:recall-reference:head:v1:"
    + "([a-f0-9]{64})$",
  "u",
);
const PAGE_KEY = new RegExp(
  "^paraai:phase4:recall-reference:page:v1:"
    + "([a-f0-9]{64}):([12]):([1-9][0-9]{0,2})$",
  "u",
);
const REQUIRED_PAGE_KEYS = Object.freeze([
  "expectedExpiresAtMs",
  "key",
  "minimumRemainingTtlMs",
  "nativeByteProofDigest",
  "rawDigest",
]);
const CAS_INPUT_KEYS = Object.freeze([
  "expectedRaw",
  "headKey",
  "headRaw",
  "key",
  "nextRaw",
  "notAfterMs",
  "notBeforeMs",
  "pageExpiresAtMs",
  "pageKey",
  "pageRaw",
  "pageTtlMs",
  "requiredPageSet",
  "requiredPageSetDigest",
]);
const VERIFY_INPUT_KEYS = Object.freeze([
  "expectedHeadRaw",
  "expectedRunRaw",
  "headKey",
  "requestDigest",
  "requiredPageSet",
  "requiredPageSetDigest",
  "runKey",
]);
const FACTORY_OPTION_KEYS = new Set([
  "fetchImpl",
  "token",
  "url",
]);

export class SourceRecallReferencePersistenceAdapterError
  extends Error {
  constructor(code) {
    super(code);
    this.name =
      "SourceRecallReferencePersistenceAdapterError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallReferencePersistenceAdapterError(code);
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
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
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
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail(code);
  }
  return record;
}

function denseArraySnapshot(value, code) {
  if (
    !Array.isArray(value)
    || nodeTypes.isProxy(value)
    || Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length;
  if (
    !length
    || !Object.prototype.hasOwnProperty.call(length, "value")
    || length.value !== value.length
  ) {
    fail(code);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor
      || !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value",
      )
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    result.push(descriptor.value);
  }
  const allowed = new Set([
    "length",
    ...result.map((_, index) => String(index)),
  ]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
    fail(code);
  }
  return result;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_INPUT_INVALID",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  fail(
    "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_INPUT_INVALID",
  );
}

function rawDigest(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function rawSha1(raw) {
  return createHash("sha1").update(raw).digest("hex");
}

function exactNativeByteProofDigest(value, code) {
  if (
    typeof value !== "string"
    || !NATIVE_BYTE_PROOF_DIGEST.test(value)
  ) {
    fail(code);
  }
  return value;
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function persistenceKeyDigest(key) {
  return semanticDigest(
    "phase4-recall-reference-persistence-key-v1",
    key,
  );
}

function requiredPageSetDigest(requiredPageSet) {
  return semanticDigest(
    "phase4-recall-reference-required-page-set-v1",
    requiredPageSet,
  );
}

function artifactSetRequestDigest({
  runKey,
  expectedRunRaw,
  headKey,
  expectedHeadRaw,
  requiredPageSetDigest: pageSetDigest,
}) {
  return semanticDigest(
    "phase4-recall-reference-sealed-artifact-set-v1",
    {
      runKeyDigest: persistenceKeyDigest(runKey),
      runRawDigest: rawDigest(expectedRunRaw),
      headKeyDigest: persistenceKeyDigest(headKey),
      headRawDigest: rawDigest(expectedHeadRaw),
      requiredPageSetDigest: pageSetDigest,
    },
  );
}

function fixedHexLength(value, code) {
  const length = Buffer.byteLength(value, "utf8");
  if (!Number.isSafeInteger(length) || length < 1 || length > 0xffffffff) {
    fail(code);
  }
  return length.toString(16).padStart(8, "0");
}

function pageEnvelope(raw, code) {
  return (
    `${PAGE_ENVELOPE_MAGIC}${rawDigest(raw)}|`
    + `${fixedHexLength(raw, code)}|${raw}`
  );
}

function pageEnvelopeHeader(raw, code) {
  return (
    `${PAGE_ENVELOPE_MAGIC}${rawDigest(raw)}|`
    + `${fixedHexLength(raw, code)}|`
  );
}

function parsePageEnvelope(value, code) {
  exactString(value, code);
  const headerLength = PAGE_ENVELOPE_MAGIC.length + 64 + 1 + 8 + 1;
  if (
    value.length < headerLength
    || !value.startsWith(PAGE_ENVELOPE_MAGIC)
    || value[PAGE_ENVELOPE_MAGIC.length + 64] !== "|"
    || value[PAGE_ENVELOPE_MAGIC.length + 64 + 1 + 8] !== "|"
  ) {
    fail(code);
  }
  const digestStart = PAGE_ENVELOPE_MAGIC.length;
  const digest = value.slice(digestStart, digestStart + 64);
  const lengthStart = digestStart + 65;
  const lengthHex = value.slice(lengthStart, lengthStart + 8);
  if (!DIGEST.test(digest) || !/^[a-f0-9]{8}$/u.test(lengthHex)) {
    fail(code);
  }
  const raw = value.slice(headerLength);
  if (
    Buffer.byteLength(raw, "utf8") !== Number.parseInt(lengthHex, 16)
    || rawDigest(raw) !== digest
  ) {
    fail(code);
  }
  return Object.freeze({ raw, rawDigest: digest });
}

function runStageEnvelope(raw, fenceDigest, code) {
  return (
    `${RUN_STAGE_MAGIC}${fenceDigest}|${rawDigest(raw)}|`
    + `${fixedHexLength(raw, code)}|${raw}`
  );
}

function runStageHeader(raw, fenceDigest, code) {
  return (
    `${RUN_STAGE_MAGIC}${fenceDigest}|${rawDigest(raw)}|`
    + `${fixedHexLength(raw, code)}|`
  );
}

function optionalPersistenceKeyDigest(value) {
  return value === null ? null : persistenceKeyDigest(value);
}

function stageFenceDigest({
  expectedRaw,
  headKey,
  headRaw,
  key,
  nextRaw,
  notAfterMs,
  notBeforeMs,
  pageExpiresAtMs,
  pageKey,
  pageRaw,
  requiredPageSetDigest: pageSetDigest,
}) {
  return semanticDigest(
    "phase4-recall-reference-stage-fence-v1",
    {
      expectedRawDigest: rawDigest(expectedRaw),
      headKeyDigest: optionalPersistenceKeyDigest(headKey),
      headRawDigest: headRaw === null ? null : rawDigest(headRaw),
      nextRawDigest: rawDigest(nextRaw),
      notAfterMs,
      notBeforeMs,
      pageExpiresAtMs,
      pageKeyDigest: optionalPersistenceKeyDigest(pageKey),
      pageRawDigest: pageRaw === null ? null : rawDigest(pageRaw),
      requiredPageSetDigest: pageSetDigest,
      runKeyDigest: persistenceKeyDigest(key),
    },
  );
}

function privateStageKeys(workKeyDigest, nonce) {
  return Object.freeze({
    fenceKey: `${FENCE_PREFIX}${workKeyDigest}`,
    pageStageKey:
      `${STAGE_PREFIX}${workKeyDigest}:${nonce}:page`,
    runStageKey:
      `${STAGE_PREFIX}${workKeyDigest}:${nonce}:run`,
    writerKey: `${WRITER_PREFIX}${workKeyDigest}`,
  });
}

function safeInteger(value, code, {
  minimum = 0,
  nullable = false,
} = {}) {
  if (nullable && value === null) return null;
  if (
    !Number.isSafeInteger(value)
    || value < minimum
  ) {
    fail(code);
  }
  return value;
}

function exactString(value, code, {
  allowEmpty = false,
} = {}) {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
  ) {
    fail(code);
  }
  return value;
}

function exactDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
  return value;
}

function parsedCanonicalRaw(raw, code) {
  exactString(raw, code);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(code);
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || canonicalJson(parsed) !== raw
  ) {
    fail(code);
  }
  return parsed;
}

function runKey(value, code) {
  const key = exactString(value, code);
  const match = RUN_KEY.exec(key);
  if (!match) fail(code);
  return { key, workKeyDigest: match[1] };
}

function headKey(value, code) {
  const key = exactString(value, code);
  const match = HEAD_KEY.exec(key);
  if (!match) fail(code);
  return { key, workKeyDigest: match[1] };
}

function pageKey(value, code) {
  const key = exactString(value, code);
  const match = PAGE_KEY.exec(key);
  if (
    !match
    || Number(match[3]) > SOURCE_RECALL_REFERENCE_MAX_PAGES
  ) {
    fail(code);
  }
  return {
    key,
    workKeyDigest: match[1],
    passNumber: Number(match[2]),
    pageNumber: Number(match[3]),
  };
}

function canonicalRequiredPageSet(value, workKeyDigest, code) {
  const items = denseArraySnapshot(value, code);
  if (items.length > SOURCE_RECALL_REFERENCE_MAX_PAGES) {
    fail(code);
  }
  const seen = new Set();
  return items.map((item) => {
    const required = exactRecord(
      item,
      REQUIRED_PAGE_KEYS,
      code,
    );
    const selectedKey = pageKey(required.key, code);
    if (
      selectedKey.workKeyDigest !== workKeyDigest
      || selectedKey.passNumber !== 2
      || seen.has(selectedKey.key)
    ) {
      fail(code);
    }
    seen.add(selectedKey.key);
    return Object.freeze({
      expectedExpiresAtMs: safeInteger(
        required.expectedExpiresAtMs,
        code,
        { minimum: 1 },
      ),
      key: selectedKey.key,
      minimumRemainingTtlMs: safeInteger(
        required.minimumRemainingTtlMs,
        code,
        { minimum: 1 },
      ),
      nativeByteProofDigest: exactNativeByteProofDigest(
        required.nativeByteProofDigest,
        code,
      ),
      rawDigest: exactDigest(required.rawDigest, code),
    });
  });
}

function configurationFromEnvironment() {
  const rawUrl =
    process.env
      .PARAAI_SOURCE_RECALL_REFERENCE_KV_REST_API_URL
    || "";
  const token =
    process.env
      .PARAAI_SOURCE_RECALL_REFERENCE_KV_REST_API_TOKEN
    || "";
  return {
    url: String(rawUrl),
    token: String(token),
  };
}

function canonicalConfiguration(urlValue, tokenValue) {
  const code =
    "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_CONFIGURATION_INVALID";
  const rawUrl = typeof urlValue === "string"
    ? urlValue.replace(/\/+$/u, "")
    : "";
  const token = typeof tokenValue === "string"
    ? tokenValue
    : "";
  if (Boolean(rawUrl) !== Boolean(token)) fail(code);
  if (!rawUrl && !token) {
    fail(
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_UNAVAILABLE",
    );
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
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
  return Object.freeze({ url: rawUrl, token });
}

export function sourceRecallReferencePersistenceAdapterConfigured() {
  const { url, token } = configurationFromEnvironment();
  if (Boolean(url) !== Boolean(token)) return false;
  if (!url || !token) return false;
  try {
    canonicalConfiguration(url, token);
    return true;
  } catch {
    return false;
  }
}

function factoryOptions(value) {
  const code =
    "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_CONFIGURATION_INVALID";
  if (value === undefined) return Object.create(null);
  const options = plainRecordSnapshot(value, code);
  if (
    Object.keys(options).some(
      (key) => !FACTORY_OPTION_KEYS.has(key),
    )
  ) {
    fail(code);
  }
  return options;
}

function redisNowMs(result, offset) {
  const code =
    "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID";
  if (
    !Array.isArray(result)
    || !/^\d+$/u.test(String(result[offset] ?? ""))
    || !/^\d+$/u.test(String(result[offset + 1] ?? ""))
  ) {
    fail(code);
  }
  const seconds = Number(result[offset]);
  const microseconds = Number(result[offset + 1]);
  const nowMs =
    seconds * 1_000 + Math.floor(microseconds / 1_000);
  if (
    !Number.isSafeInteger(nowMs)
    || nowMs < 1
    || microseconds < 0
    || microseconds > 999_999
  ) {
    fail(code);
  }
  return nowMs;
}

async function boundedResponseText(response) {
  const code =
    "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID";
  const declared = response?.headers?.get?.("content-length");
  if (
    declared !== null
    && declared !== undefined
    && (
      !/^\d+$/u.test(String(declared))
      || Number(declared) > RESPONSE_MAX_BYTES
    )
  ) {
    try {
      await response?.body?.cancel?.();
    } catch {
      // The stable adapter error below is the only observable result.
    }
    fail(code);
  }
  if (
    !response
    || !response.body
    || typeof response.body.getReader !== "function"
  ) {
    fail(code);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks = [];
  let receivedBytes = 0;
  let completed = false;
  let cancellationAttempted = false;
  async function cancelReader() {
    if (cancellationAttempted) return;
    cancellationAttempted = true;
    try {
      await reader.cancel();
    } catch {
      // The stable adapter error remains authoritative.
    }
  }
  try {
    while (true) {
      const part = await reader.read();
      if (
        part === null
        || typeof part !== "object"
        || typeof part.done !== "boolean"
      ) {
        fail(code);
      }
      if (part.done) {
        completed = true;
        break;
      }
      if (!(part.value instanceof Uint8Array)) fail(code);
      receivedBytes += part.value.byteLength;
      if (receivedBytes > RESPONSE_MAX_BYTES) {
        await cancelReader();
        fail(code);
      }
      chunks.push(decoder.decode(part.value, {
        stream: true,
      }));
    }
    chunks.push(decoder.decode());
  } catch (error) {
    if (!completed) await cancelReader();
    if (
      error
        instanceof SourceRecallReferencePersistenceAdapterError
    ) {
      throw error;
    }
    fail(code);
  } finally {
    if (!completed) await cancelReader();
    try {
      reader.releaseLock();
    } catch {
      // A released/failed reader does not change the stable result.
    }
  }
  return chunks.join("");
}

const ENSURE_LUA = `
  -- recall_reference_ensure_v1
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local currentRaw = redis.call('GET', KEYS[1])
  if currentRaw then
    return {0, currentRaw, redisTime[1], redisTime[2]}
  end
  local nowText = string.format('%.0f', nowMs)
  local stamped, createdCount = string.gsub(
    ARGV[1],
    '"createdAtMs":0',
    '"createdAtMs":' .. nowText,
    1
  )
  local finalRaw, updatedCount = string.gsub(
    stamped,
    '"updatedAtMs":0',
    '"updatedAtMs":' .. nowText,
    1
  )
  if createdCount ~= 1 or updatedCount ~= 1 then
    return {-9, '', redisTime[1], redisTime[2]}
  end
  local decodedOk, decoded = pcall(cjson.decode, finalRaw)
  if not decodedOk
    or type(decoded) ~= 'table'
    or tonumber(decoded.createdAtMs) ~= nowMs
    or tonumber(decoded.updatedAtMs) ~= nowMs
    or tonumber(decoded.revision) ~= 0 then
    return {-9, '', redisTime[1], redisTime[2]}
  end
  redis.call('SET', KEYS[1], finalRaw)
  return {1, finalRaw, redisTime[1], redisTime[2]}
`;

const READ_ONE_LUA = `
  -- recall_reference_read_one_v1
  local redisTime = redis.call('TIME')
  return {
    redis.call('GET', KEYS[1]) or '',
    redisTime[1],
    redisTime[2]
  }
`;

const READ_PAGE_LUA = `
  -- recall_reference_read_page_v1
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local raw = redis.call('GET', KEYS[1])
  if not raw then
    return {'', '', redisTime[1], redisTime[2]}
  end
  local expiresAtMs = redis.call('PEXPIRETIME', KEYS[1])
  if expiresAtMs <= nowMs then
    return {'', '', redisTime[1], redisTime[2]}
  end
  return {
    raw,
    tostring(expiresAtMs),
    redisTime[1],
    redisTime[2]
  }
`;

const BEGIN_STAGE_LUA = `
  -- recall_reference_begin_stage_v2
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  if redis.call('GET', KEYS[1]) then
    return {0, '', '', '', redisTime[1], redisTime[2]}
  end
  local notAfterMs = tonumber(ARGV[3])
  if ARGV[3] ~= '' and nowMs >= notAfterMs then
    return {-2, '', '', '', redisTime[1], redisTime[2]}
  end
  local expiresAtMs = nowMs + tonumber(ARGV[5])
  if ARGV[3] ~= '' and expiresAtMs > notAfterMs then
    expiresAtMs = notAfterMs
  end
  if expiresAtMs
    <= nowMs
      + ${SOURCE_RECALL_REFERENCE_ATOMIC_SCRIPT_BUDGET_MS} then
    return {-2, '', '', '', redisTime[1], redisTime[2]}
  end
  local fence = redis.call('INCR', KEYS[2])
  local writerRaw = ARGV[1]
    .. '|' .. tostring(fence)
    .. '|' .. ARGV[2]
    .. '|' .. tostring(expiresAtMs)
  local writerStored = redis.call(
    'SET',
    KEYS[1],
    writerRaw,
    'NX',
    'PXAT',
    expiresAtMs
  )
  if not writerStored then
    return {0, '', '', '', redisTime[1], redisTime[2]}
  end
  local stageStored = redis.call(
    'SET',
    KEYS[3],
    ARGV[4],
    'NX',
    'PXAT',
    expiresAtMs
  )
  if not stageStored then
    if redis.call('GET', KEYS[1]) == writerRaw then
      redis.call('DEL', KEYS[1])
    end
    return {-9, '', '', '', redisTime[1], redisTime[2]}
  end
  return {
    1,
    tostring(fence),
    tostring(expiresAtMs),
    writerRaw,
    redisTime[1],
    redisTime[2]
  }
`;

const WRITE_STAGE_LUA = `
  -- recall_reference_write_stage_v2
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local expiresAtMs = tonumber(ARGV[2])
  if not expiresAtMs
    or nowMs >= expiresAtMs
    or redis.call('GET', KEYS[1]) ~= ARGV[1]
    or redis.call('PEXPIRETIME', KEYS[1]) ~= expiresAtMs then
    return {-2, redisTime[1], redisTime[2]}
  end
  local current = redis.call('GET', KEYS[2])
  if current then
    if current ~= ARGV[3]
      or redis.call('PEXPIRETIME', KEYS[2]) ~= expiresAtMs then
      return {-9, redisTime[1], redisTime[2]}
    end
    return {0, redisTime[1], redisTime[2]}
  end
  local stored = redis.call(
    'SET',
    KEYS[2],
    ARGV[3],
    'NX',
    'PXAT',
    expiresAtMs
  )
  if not stored
    or redis.call('GET', KEYS[2]) ~= ARGV[3]
    or redis.call('PEXPIRETIME', KEYS[2]) ~= expiresAtMs then
    return {-9, redisTime[1], redisTime[2]}
  end
  return {1, redisTime[1], redisTime[2]}
`;

const READ_STAGE_LUA = `
  -- recall_reference_read_stage_v2
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local expiresAtMs = tonumber(ARGV[2])
  if not expiresAtMs
    or nowMs >= expiresAtMs
    or redis.call('GET', KEYS[1]) ~= ARGV[1]
    or redis.call('PEXPIRETIME', KEYS[1]) ~= expiresAtMs then
    return {'', redisTime[1], redisTime[2]}
  end
  local raw = redis.call('GET', KEYS[2])
  if not raw
    or redis.call('PEXPIRETIME', KEYS[2]) ~= expiresAtMs then
    return {'', redisTime[1], redisTime[2]}
  end
  return {raw, redisTime[1], redisTime[2]}
`;

const FINAL_COMPARE_AND_SET_LUA = `
  -- recall_reference_final_cas_v2
  local completionBudgetMs =
    ${SOURCE_RECALL_REFERENCE_ATOMIC_SCRIPT_BUDGET_MS}
  local function isLowerHex(raw, expectedLength)
    return type(raw) == 'string'
      and string.len(raw) == expectedLength
      and string.match(raw, '^[0-9a-f]+$') ~= nil
  end

  local function isPageEnvelopeHeader(raw)
    return type(raw) == 'string'
      and string.len(raw) == 80
      and string.sub(raw, 1, 6) == 'RRPG1|'
      and isLowerHex(string.sub(raw, 7, 70), 64)
      and string.sub(raw, 71, 71) == '|'
      and isLowerHex(string.sub(raw, 72, 79), 8)
      and string.sub(raw, 80, 80) == '|'
  end

  local function setSucceeded(reply)
    return type(reply) == 'table' and reply.ok == 'OK'
  end

  local function cleanupStages()
    if redis.call('GET', KEYS[2]) == ARGV[2] then
      redis.call('DEL', KEYS[2], KEYS[3], KEYS[4])
    end
  end

  local function pageMetadataMatches(
    keyIndex,
    expectedPrefix,
    expectedNativeByteProof,
    expectedExpiry,
    minimumRemaining,
    nowMs,
    proposedRaw,
    proposedExpiry,
    proposedKeyIndex
  )
    local exists =
      redis.call('EXISTS', KEYS[keyIndex]) == 1
    local totalLength = redis.call('STRLEN', KEYS[keyIndex])
    if exists
      and (
        totalLength == 0
        or totalLength < 81
        or totalLength
          > 80 + ${SOURCE_RECALL_REFERENCE_ATOMIC_PROOF_MAX_BYTES}
      ) then
      return false
    end
    local prefix = totalLength > 0
      and redis.call(
        'GETRANGE',
        KEYS[keyIndex],
        0,
        string.len(expectedPrefix) - 1
      )
      or false
    local separator = totalLength > 0
      and redis.call('GETRANGE', KEYS[keyIndex], 79, 79)
      or false
    local lengthHex = totalLength > 0
      and redis.call('GETRANGE', KEYS[keyIndex], 71, 78)
      or false
    local nativeByteProof = totalLength > 0
      and redis.sha1hex(
        redis.call('GETRANGE', KEYS[keyIndex], 80, -1)
      )
      or false
    local expiry = totalLength > 0
      and redis.call('PEXPIRETIME', KEYS[keyIndex])
      or -2
    if not exists
      and keyIndex == proposedKeyIndex
      and proposedRaw then
      totalLength = string.len(proposedRaw)
      if totalLength < 81
        or totalLength
          > 80 + ${SOURCE_RECALL_REFERENCE_ATOMIC_PROOF_MAX_BYTES} then
        return false
      end
      prefix = string.sub(
        proposedRaw,
        1,
        string.len(expectedPrefix)
      )
      separator = string.sub(proposedRaw, 80, 80)
      lengthHex = string.sub(proposedRaw, 72, 79)
      nativeByteProof = redis.sha1hex(
        string.sub(proposedRaw, 81)
      )
      expiry = proposedExpiry
    end
    if totalLength == 0
      or prefix ~= expectedPrefix
      or separator ~= '|'
      or nativeByteProof ~= expectedNativeByteProof then
      return false
    end
    local rawLength = tonumber(lengthHex, 16)
    return rawLength
      and totalLength == 80 + rawLength
      and expiry == expectedExpiry
      and expiry - nowMs >= minimumRemaining
  end

  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  if #KEYS < 4 or #KEYS > 206 or #ARGV < 19 then
    return {-9, '', redisTime[1], redisTime[2]}
  end
  local seenKeyValues = {}
  for keyIndex = 1, #KEYS do
    if seenKeyValues[KEYS[keyIndex]] then
      return {-9, '', redisTime[1], redisTime[2]}
    end
    seenKeyValues[KEYS[keyIndex]] = true
  end
  local currentRaw = false
  if redis.call('STRLEN', KEYS[1]) == string.len(ARGV[1]) then
    currentRaw = redis.call('GET', KEYS[1])
  end
  if not currentRaw or currentRaw ~= ARGV[1] then
    cleanupStages()
    return {-1, '', redisTime[1], redisTime[2]}
  end
  local notAfterMs = tonumber(ARGV[8])
  if ARGV[8] ~= ''
    and (
      not notAfterMs
      or notAfterMs ~= math.floor(notAfterMs)
      or nowMs + completionBudgetMs >= notAfterMs
    ) then
    cleanupStages()
    return {-2, '', redisTime[1], redisTime[2]}
  end
  local notBeforeMs = tonumber(ARGV[19])
  if not notBeforeMs
    or notBeforeMs ~= math.floor(notBeforeMs)
    or notBeforeMs < 1
    or nowMs < notBeforeMs then
    cleanupStages()
    return {-9, '', redisTime[1], redisTime[2]}
  end
  local leaseExpiresAtMs = tonumber(ARGV[3])
  if not leaseExpiresAtMs
    or leaseExpiresAtMs ~= math.floor(leaseExpiresAtMs)
    or redis.call('GET', KEYS[2]) ~= ARGV[2]
    or redis.call('PEXPIRETIME', KEYS[2]) ~= leaseExpiresAtMs
    or redis.call('PEXPIRETIME', KEYS[3]) ~= leaseExpiresAtMs then
    cleanupStages()
    return {-9, '', redisTime[1], redisTime[2]}
  end
  if nowMs + completionBudgetMs >= leaseExpiresAtMs then
    cleanupStages()
    return {-3, '', redisTime[1], redisTime[2]}
  end
  local runStageLength = redis.call('STRLEN', KEYS[3])
  if runStageLength < 146
    or runStageLength
      > ${SOURCE_RECALL_REFERENCE_REQUEST_MAX_BYTES}
    or runStageLength ~= tonumber(ARGV[5]) then
    cleanupStages()
    return {-9, '', redisTime[1], redisTime[2]}
  end
  local runStage = redis.call('GET', KEYS[3])
  if not runStage
    or string.sub(runStage, 1, string.len(ARGV[4]))
      ~= ARGV[4]
    or redis.sha1hex(runStage) ~= ARGV[15] then
    cleanupStages()
    return {-9, '', redisTime[1], redisTime[2]}
  end
  local nextRaw = string.sub(runStage, string.len(ARGV[4]) + 1)

  local pageKeyIndex = tonumber(ARGV[11])
  local headKeyIndex = tonumber(ARGV[12])
  local requiredCount = tonumber(ARGV[14])
  if not pageKeyIndex
    or pageKeyIndex ~= math.floor(pageKeyIndex)
    or pageKeyIndex < 0
    or pageKeyIndex > #KEYS
    or pageKeyIndex > 0 and pageKeyIndex < 5
    or not headKeyIndex
    or headKeyIndex ~= math.floor(headKeyIndex)
    or headKeyIndex < 0
    or headKeyIndex > #KEYS
    or headKeyIndex > 0 and headKeyIndex < 5
    or pageKeyIndex > 0 and pageKeyIndex == headKeyIndex
    or not requiredCount
    or requiredCount ~= math.floor(requiredCount)
    or requiredCount < 0
    or requiredCount > 200
    or #ARGV ~= 19 + requiredCount * 5 then
    cleanupStages()
    return {-9, '', redisTime[1], redisTime[2]}
  end

  local pageStage = false
  local pageExpiresAtMs = tonumber(ARGV[9])
  local pageTtlMs = tonumber(ARGV[10])
  if pageKeyIndex > 0 then
    local pageStageLength = tonumber(ARGV[7])
    if not isPageEnvelopeHeader(ARGV[6])
      or not pageStageLength
      or pageStageLength ~= math.floor(pageStageLength)
      or pageStageLength < 81
      or pageStageLength
        > 80 + ${SOURCE_RECALL_REFERENCE_ATOMIC_PROOF_MAX_BYTES}
      or not pageExpiresAtMs
      or pageExpiresAtMs ~= math.floor(pageExpiresAtMs)
      or not pageTtlMs
      or pageTtlMs ~= math.floor(pageTtlMs)
      or pageTtlMs <= 0
      or not isLowerHex(ARGV[16], 40)
      or pageExpiresAtMs <= nowMs + completionBudgetMs
      or pageExpiresAtMs > nowMs + pageTtlMs
      or redis.call('PEXPIRETIME', KEYS[4])
        ~= leaseExpiresAtMs then
      cleanupStages()
      return {-9, '', redisTime[1], redisTime[2]}
    end
    if redis.call('STRLEN', KEYS[4]) ~= pageStageLength then
      cleanupStages()
      return {-9, '', redisTime[1], redisTime[2]}
    end
    pageStage = redis.call('GET', KEYS[4])
    if not pageStage
      or string.sub(pageStage, 1, string.len(ARGV[6]))
        ~= ARGV[6]
      or redis.sha1hex(pageStage) ~= ARGV[16] then
      cleanupStages()
      return {-9, '', redisTime[1], redisTime[2]}
    end
    if not isLowerHex(ARGV[18], 40)
      or not pageMetadataMatches(
        pageKeyIndex,
        ARGV[6],
        ARGV[18],
        pageExpiresAtMs,
        completionBudgetMs,
        nowMs,
        pageStage,
        pageExpiresAtMs,
        pageKeyIndex
      ) then
      cleanupStages()
      return {-9, '', redisTime[1], redisTime[2]}
    end
  elseif ARGV[6] ~= '' or ARGV[7] ~= ''
    or ARGV[9] ~= '' or ARGV[10] ~= ''
    or ARGV[16] ~= '' or ARGV[18] ~= '' then
    cleanupStages()
    return {-9, '', redisTime[1], redisTime[2]}
  end

  local currentHead = false
  if headKeyIndex > 0 then
    local headExists =
      redis.call('EXISTS', KEYS[headKeyIndex]) == 1
    if headExists
      and redis.call('STRLEN', KEYS[headKeyIndex])
        ~= string.len(ARGV[13]) then
      cleanupStages()
      return {-9, '', redisTime[1], redisTime[2]}
    end
    currentHead = headExists
      and redis.call('GET', KEYS[headKeyIndex])
      or false
    if headExists
      and (not currentHead or currentHead ~= ARGV[13]) then
      cleanupStages()
      return {-9, '', redisTime[1], redisTime[2]}
    end
  elseif ARGV[13] ~= '' then
    cleanupStages()
    return {-9, '', redisTime[1], redisTime[2]}
  end

  local usedKeyIndexes = {
    [1] = true,
    [2] = true,
    [3] = true,
    [4] = true
  }
  if pageKeyIndex > 0 then
    usedKeyIndexes[pageKeyIndex] = true
  end
  if headKeyIndex > 0 then
    usedKeyIndexes[headKeyIndex] = true
  end
  local argumentIndex = 20
  for index = 1, requiredCount do
    local requiredKeyIndex = tonumber(ARGV[argumentIndex])
    local expectedPrefix = ARGV[argumentIndex + 1]
    local expectedNativeByteProof =
      ARGV[argumentIndex + 2]
    local expectedExpiry = tonumber(ARGV[argumentIndex + 3])
    local minimumRemaining =
      tonumber(ARGV[argumentIndex + 4])
    argumentIndex = argumentIndex + 5
    if not requiredKeyIndex
      or requiredKeyIndex ~= math.floor(requiredKeyIndex)
      or requiredKeyIndex < 5
      or requiredKeyIndex > #KEYS
      or requiredKeyIndex == headKeyIndex
      or usedKeyIndexes[
        'required:' .. tostring(requiredKeyIndex)
      ]
      or string.len(expectedPrefix) ~= 71
      or string.sub(expectedPrefix, 1, 6) ~= 'RRPG1|'
      or string.sub(expectedPrefix, 71, 71) ~= '|'
      or not isLowerHex(
        string.sub(expectedPrefix, 7, 70),
        64
      )
      or not isLowerHex(expectedNativeByteProof, 40)
      or not expectedExpiry
      or expectedExpiry ~= math.floor(expectedExpiry)
      or not minimumRemaining
      or minimumRemaining ~= math.floor(minimumRemaining)
      or minimumRemaining < 1
      or not pageMetadataMatches(
        requiredKeyIndex,
        expectedPrefix,
        expectedNativeByteProof,
        expectedExpiry,
        minimumRemaining + completionBudgetMs,
        nowMs,
        pageStage,
        pageExpiresAtMs,
        pageKeyIndex
      ) then
      cleanupStages()
      return {-9, '', redisTime[1], redisTime[2]}
    end
    usedKeyIndexes[
      'required:' .. tostring(requiredKeyIndex)
    ] = true
    usedKeyIndexes[requiredKeyIndex] = true
  end
  for keyIndex = 1, #KEYS do
    if not usedKeyIndexes[keyIndex] then
      cleanupStages()
      return {-9, '', redisTime[1], redisTime[2]}
    end
  end

  local pageCreated = false
  if pageKeyIndex > 0
    and redis.call('EXISTS', KEYS[pageKeyIndex]) == 0 then
    local storedPage = redis.pcall(
      'SET',
      KEYS[pageKeyIndex],
      pageStage,
      'NX',
      'PXAT',
      pageExpiresAtMs
    )
    if not setSucceeded(storedPage) then
      cleanupStages()
      return {-9, '', redisTime[1], redisTime[2]}
    end
    pageCreated = true
  end
  local headCreated = false
  if headKeyIndex > 0 and not currentHead then
    local storedHead = redis.pcall(
      'SET',
      KEYS[headKeyIndex],
      ARGV[13],
      'NX'
    )
    if not setSucceeded(storedHead) then
      if pageCreated then redis.call('DEL', KEYS[pageKeyIndex]) end
      cleanupStages()
      return {-9, '', redisTime[1], redisTime[2]}
    end
    headCreated = true
  end

  local storedRun = redis.pcall('SET', KEYS[1], nextRaw)
  if not setSucceeded(storedRun) then
    if headCreated then redis.call('DEL', KEYS[headKeyIndex]) end
    if pageCreated then redis.call('DEL', KEYS[pageKeyIndex]) end
    cleanupStages()
    return {-9, '', redisTime[1], redisTime[2]}
  end
  redis.call('DEL', KEYS[2], KEYS[3], KEYS[4])
  return {1, ARGV[17], redisTime[1], redisTime[2]}
`;

const VERIFY_METADATA_SET_LUA = `
  -- recall_reference_verify_metadata_set_v2
  local function isLowerHex(raw, expectedLength)
    return type(raw) == 'string'
      and string.len(raw) == expectedLength
      and string.match(raw, '^[0-9a-f]+$') ~= nil
  end

  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local requiredCount = tonumber(ARGV[3])
  if #KEYS < 2
    or #KEYS > 202
    or #ARGV < 3
    or not requiredCount
    or requiredCount ~= math.floor(requiredCount)
    or requiredCount < 0
    or requiredCount > 200
    or requiredCount ~= #KEYS - 2
    or #ARGV ~= 3 + requiredCount * 4 then
    return {-9, redisTime[1], redisTime[2]}
  end
  local seenKeyValues = {}
  for keyIndex = 1, #KEYS do
    if seenKeyValues[KEYS[keyIndex]] then
      return {-9, redisTime[1], redisTime[2]}
    end
    seenKeyValues[KEYS[keyIndex]] = true
  end
  if redis.call('STRLEN', KEYS[1]) ~= string.len(ARGV[1])
    or redis.call('STRLEN', KEYS[2]) ~= string.len(ARGV[2])
    or redis.call('GET', KEYS[1]) ~= ARGV[1]
    or redis.call('GET', KEYS[2]) ~= ARGV[2] then
    return {0, redisTime[1], redisTime[2]}
  end
  local argumentIndex = 4
  for index = 1, requiredCount do
    local expectedPrefix = ARGV[argumentIndex]
    local expectedNativeByteProof =
      ARGV[argumentIndex + 1]
    local expectedExpiry =
      tonumber(ARGV[argumentIndex + 2])
    local minimumRemaining =
      tonumber(ARGV[argumentIndex + 3])
    argumentIndex = argumentIndex + 4
    local totalLength = redis.call(
      'STRLEN',
      KEYS[index + 2]
    )
    if totalLength < 81
      or totalLength
        > 80 + ${SOURCE_RECALL_REFERENCE_ATOMIC_PROOF_MAX_BYTES} then
      return {0, redisTime[1], redisTime[2]}
    end
    local prefix = totalLength > 0
      and redis.call(
        'GETRANGE',
        KEYS[index + 2],
        0,
        string.len(expectedPrefix) - 1
      )
      or false
    local separator = totalLength > 0
      and redis.call('GETRANGE', KEYS[index + 2], 79, 79)
      or false
    local lengthHex = totalLength > 0
      and redis.call('GETRANGE', KEYS[index + 2], 71, 78)
      or false
    local nativeByteProof = totalLength > 0
      and redis.sha1hex(
        redis.call('GETRANGE', KEYS[index + 2], 80, -1)
      )
      or false
    local expiry = totalLength > 0
      and redis.call('PEXPIRETIME', KEYS[index + 2])
      or -2
    if totalLength == 0
      or not expectedExpiry
      or expectedExpiry ~= math.floor(expectedExpiry)
      or not minimumRemaining
      or minimumRemaining ~= math.floor(minimumRemaining)
      or minimumRemaining < 1
      or string.len(expectedPrefix) ~= 71
      or string.sub(expectedPrefix, 1, 6) ~= 'RRPG1|'
      or string.sub(expectedPrefix, 71, 71) ~= '|'
      or not isLowerHex(
        string.sub(expectedPrefix, 7, 70),
        64
      )
      or not isLowerHex(expectedNativeByteProof, 40)
      or prefix ~= expectedPrefix
      or nativeByteProof ~= expectedNativeByteProof
      or separator ~= '|'
      or tonumber(lengthHex, 16) == nil
      or totalLength ~= 80 + tonumber(lengthHex, 16)
      or expiry ~= expectedExpiry
      or expiry - nowMs < minimumRemaining then
      return {0, redisTime[1], redisTime[2]}
    end
  end
  return {1, redisTime[1], redisTime[2]}
`;

export function createSourceRecallReferencePersistenceAdapter(
  value,
) {
  const options = factoryOptions(value);
  const environment = configurationFromEnvironment();
  const hasUrl = Object.prototype.hasOwnProperty.call(
    options,
    "url",
  );
  const hasToken = Object.prototype.hasOwnProperty.call(
    options,
    "token",
  );
  if (hasUrl !== hasToken) {
    fail(
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_CONFIGURATION_INVALID",
    );
  }
  const configuration = canonicalConfiguration(
    hasUrl ? options.url : environment.url,
    hasToken ? options.token : environment.token,
  );
  const fetchImpl = Object.prototype.hasOwnProperty.call(
    options,
    "fetchImpl",
  )
    ? options.fetchImpl
    : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    fail(
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_CONFIGURATION_INVALID",
    );
  }

  async function execute(command) {
    const body = JSON.stringify(command);
    if (
      Buffer.byteLength(body, "utf8")
        > SOURCE_RECALL_REFERENCE_REQUEST_MAX_BYTES
    ) {
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_REQUEST_TOO_LARGE",
      );
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_REQUEST_FAILED",
      );
    }
    if (response?.ok !== true || response?.status !== 200) {
      try {
        await response?.body?.cancel?.();
      } catch {
        // The stable request error below is the only observable result.
      }
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_REQUEST_FAILED",
      );
    }
    let text;
    try {
      text = await boundedResponseText(response);
    } catch (error) {
      if (
        error
          instanceof SourceRecallReferencePersistenceAdapterError
      ) {
        throw error;
      }
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      );
    }
    let bodyValue;
    try {
      bodyValue = JSON.parse(text);
    } catch {
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      );
    }
    const code =
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_REQUEST_FAILED";
    if (
      bodyValue === null
      || typeof bodyValue !== "object"
      || Array.isArray(bodyValue)
      || Object.keys(bodyValue).length !== 1
      || !Object.prototype.hasOwnProperty.call(
        bodyValue,
        "result",
      )
    ) {
      fail(code);
    }
    return bodyValue.result;
  }

  async function beginStage({
    keys,
    owner,
    fenceDigest,
    notAfterMs,
    runEnvelope,
  }) {
    const result = await execute([
      "EVAL",
      BEGIN_STAGE_LUA,
      3,
      keys.writerKey,
      keys.fenceKey,
      keys.runStageKey,
      owner,
      fenceDigest,
      notAfterMs === null ? "" : String(notAfterMs),
      runEnvelope,
      String(STAGE_LEASE_MS),
    ]);
    const nowMs = redisNowMs(result, 4);
    if (
      result.length !== 6
      || ![-2, 0, 1].includes(result[0])
      || typeof result[1] !== "string"
      || typeof result[2] !== "string"
      || typeof result[3] !== "string"
    ) {
      if (Array.isArray(result) && result[0] === -9) {
        fail(
          "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_STAGE_FAILED",
        );
      }
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      );
    }
    if (result[0] !== 1) {
      if (result[1] !== "") {
        fail(
          "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
        );
      }
      return Object.freeze({
        nowMs,
        status: result[0] === -2 ? "deadline_exceeded" : "busy",
      });
    }
    const fence = Number(result[1]);
    const expiresAtMs = Number(result[2]);
    if (
      !Number.isSafeInteger(fence)
      || fence < 1
      || !Number.isSafeInteger(expiresAtMs)
      || expiresAtMs <= nowMs
      || expiresAtMs - nowMs > STAGE_LEASE_MS
      || result[3].length === 0
    ) {
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      );
    }
    return Object.freeze({
      expiresAtMs,
      fence,
      nowMs,
      status: "staged",
      writerRaw: result[3],
    });
  }

  async function writeStage({
    expiresAtMs,
    key,
    raw,
    writerKey,
    writerRaw,
  }) {
    const result = await execute([
      "EVAL",
      WRITE_STAGE_LUA,
      2,
      writerKey,
      key,
      writerRaw,
      String(expiresAtMs),
      raw,
    ]);
    const nowMs = redisNowMs(result, 1);
    if (
      result.length !== 3
      || ![-2, 0, 1].includes(result[0])
    ) {
      if (Array.isArray(result) && result[0] === -9) {
        fail(
          "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_STAGE_FAILED",
        );
      }
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      );
    }
    if (result[0] === -2) {
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_STAGE_EXPIRED",
      );
    }
    return nowMs;
  }

  async function readStageExact({
    expectedRaw,
    expiresAtMs,
    key,
    writerKey,
    writerRaw,
  }) {
    const result = await execute([
      "EVAL",
      READ_STAGE_LUA,
      2,
      writerKey,
      key,
      writerRaw,
      String(expiresAtMs),
    ]);
    const nowMs = redisNowMs(result, 1);
    if (
      result.length !== 3
      || typeof result[0] !== "string"
      || result[0] !== expectedRaw
    ) {
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_STAGE_READBACK_FAILED",
      );
    }
    return nowMs;
  }

  async function ensure(valueInput) {
    const code =
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_INPUT_INVALID";
    const input = exactRecord(
      valueInput,
      ["key", "proposedRaw"],
      code,
    );
    const selectedKey = runKey(input.key, code);
    const proposed = parsedCanonicalRaw(input.proposedRaw, code);
    let validated;
    try {
      validated = validateRecallReferenceRun({
        ...proposed,
        createdAtMs: 1,
        updatedAtMs: 1,
      });
    } catch {
      fail(code);
    }
    if (
      validated.workKeyDigest !== selectedKey.workKeyDigest
      || proposed.createdAtMs !== 0
      || proposed.updatedAtMs !== 0
      || validated.revision !== 0
      || canonicalJson(proposed) !== input.proposedRaw
    ) {
      fail(code);
    }
    const result = await execute([
      "EVAL",
      ENSURE_LUA,
      1,
      selectedKey.key,
      input.proposedRaw,
    ]);
    const nowMs = redisNowMs(result, 2);
    if (
      result.length !== 4
      || ![0, 1].includes(result[0])
      || typeof result[1] !== "string"
      || result[1].length === 0
    ) {
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      );
    }
    return Object.freeze({
      status: result[0] === 1
        ? "created"
        : "existing",
      raw: result[1],
      redisNowMs: nowMs,
    });
  }

  async function readOne(valueInput, expectedKind) {
    const code =
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_INPUT_INVALID";
    const input = exactRecord(valueInput, ["key"], code);
    const selected = expectedKind === "run"
      ? runKey(input.key, code)
      : headKey(input.key, code);
    const result = await execute([
      "EVAL",
      READ_ONE_LUA,
      1,
      selected.key,
    ]);
    const nowMs = redisNowMs(result, 1);
    if (
      result.length !== 3
      || typeof result[0] !== "string"
    ) {
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      );
    }
    return Object.freeze({
      raw: result[0] || null,
      redisNowMs: nowMs,
    });
  }

  async function readPage(valueInput) {
    const code =
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_INPUT_INVALID";
    const input = exactRecord(valueInput, ["key"], code);
    const selected = pageKey(input.key, code);
    const result = await execute([
      "EVAL",
      READ_PAGE_LUA,
      1,
      selected.key,
    ]);
    const nowMs = redisNowMs(result, 2);
    if (
      result.length !== 4
      || typeof result[0] !== "string"
    ) {
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      );
    }
    if (!result[0]) {
      if (result[1] !== "") {
        fail(
          "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
        );
      }
      return Object.freeze({
        raw: null,
        redisNowMs: nowMs,
        remainingTtlMs: null,
      });
    }
    const expiresAtMs = Number(result[1]);
    const envelope = parsePageEnvelope(
      result[0],
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
    );
    if (
      !Number.isSafeInteger(expiresAtMs)
      || expiresAtMs <= nowMs
      || expiresAtMs - nowMs
        > SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS
      || Buffer.byteLength(envelope.raw, "utf8")
        > SOURCE_RECALL_REFERENCE_ATOMIC_PROOF_MAX_BYTES
    ) {
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      );
    }
    return Object.freeze({
      raw: envelope.raw,
      redisNowMs: nowMs,
      remainingTtlMs: expiresAtMs - nowMs,
    });
  }

  async function compareAndSet(valueInput) {
    const code =
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_INPUT_INVALID";
    const input = exactRecord(
      valueInput,
      CAS_INPUT_KEYS,
      code,
    );
    const selectedRun = runKey(input.key, code);
    const expectedRecord = parsedCanonicalRaw(
      input.expectedRaw,
      code,
    );
    const nextRecord = parsedCanonicalRaw(input.nextRaw, code);
    let validatedExpected;
    let validatedNext;
    try {
      validatedExpected =
        validateRecallReferenceRun(expectedRecord);
      validatedNext = validateRecallReferenceRun(nextRecord);
    } catch {
      fail(code);
    }
    if (
      validatedExpected.workKeyDigest
        !== selectedRun.workKeyDigest
      || validatedNext.workKeyDigest
        !== selectedRun.workKeyDigest
      || canonicalJson(validatedExpected) !== input.expectedRaw
      || canonicalJson(validatedNext) !== input.nextRaw
    ) {
      fail(code);
    }
    const requiredPageSet = canonicalRequiredPageSet(
      input.requiredPageSet,
      selectedRun.workKeyDigest,
      code,
    );
    const expectedPageSetDigest =
      requiredPageSetDigest(requiredPageSet);
    if (
      exactDigest(input.requiredPageSetDigest, code)
        !== expectedPageSetDigest
    ) {
      fail(code);
    }
    const notAfterMs = safeInteger(input.notAfterMs, code, {
      minimum: 1,
      nullable: true,
    });
    const notBeforeMs = safeInteger(
      input.notBeforeMs,
      code,
      { minimum: 1 },
    );

    const hasPage = input.pageKey !== null
      || input.pageRaw !== null
      || input.pageTtlMs !== null
      || input.pageExpiresAtMs !== null;
    if (
      hasPage
      && (
        input.pageKey === null
        || input.pageRaw === null
        || input.pageTtlMs === null
        || input.pageExpiresAtMs === null
      )
    ) {
      fail(code);
    }
    let selectedPage = null;
    if (hasPage) {
      selectedPage = pageKey(input.pageKey, code);
      if (
        selectedPage.workKeyDigest
          !== selectedRun.workKeyDigest
        || typeof input.pageRaw !== "string"
        || input.pageRaw.length === 0
        || safeInteger(input.pageTtlMs, code, {
          minimum: 1,
        }) !== SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS
      ) {
        fail(code);
      }
      if (
        Buffer.byteLength(input.pageRaw, "utf8")
          > SOURCE_RECALL_REFERENCE_ATOMIC_PROOF_MAX_BYTES
      ) {
        fail(
          "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_ATOMIC_PROOF_CAP_EXCEEDED",
        );
      }
      safeInteger(input.pageExpiresAtMs, code, {
        minimum: 1,
      });
    }

    const hasHead = input.headKey !== null
      || input.headRaw !== null;
    if (
      hasHead
      && (
        input.headKey === null
        || input.headRaw === null
      )
    ) {
      fail(code);
    }
    let selectedHead = null;
    if (hasHead) {
      selectedHead = headKey(input.headKey, code);
      if (
        selectedHead.workKeyDigest
          !== selectedRun.workKeyDigest
        || typeof input.headRaw !== "string"
        || input.headRaw.length === 0
      ) {
        fail(code);
      }
    }

    const fenceDigest = stageFenceDigest({
      expectedRaw: input.expectedRaw,
      headKey: selectedHead?.key ?? null,
      headRaw: input.headRaw,
      key: selectedRun.key,
      nextRaw: input.nextRaw,
      notAfterMs,
      notBeforeMs,
      pageExpiresAtMs: input.pageExpiresAtMs,
      pageKey: selectedPage?.key ?? null,
      pageRaw: input.pageRaw,
      requiredPageSetDigest: expectedPageSetDigest,
    });
    const owner = randomBytes(32).toString("hex");
    const stageKeys = privateStageKeys(
      selectedRun.workKeyDigest,
      owner,
    );
    const stagedRun = runStageEnvelope(
      input.nextRaw,
      fenceDigest,
      code,
    );
    const stage = await beginStage({
      keys: stageKeys,
      owner,
      fenceDigest,
      notAfterMs,
      runEnvelope: stagedRun,
    });
    if (stage.status !== "staged") {
      const current = await readOne({ key: selectedRun.key }, "run");
      const conflict = current.raw !== input.expectedRaw;
      return Object.freeze({
        headReceipt: null,
        pageReceipt: null,
        pageSetReceipt: null,
        status: stage.status === "busy" || conflict
          ? "conflict"
          : "deadline_exceeded",
        raw: current.raw,
        redisNowMs: Math.max(stage.nowMs, current.redisNowMs),
      });
    }
    await readStageExact({
      expectedRaw: stagedRun,
      expiresAtMs: stage.expiresAtMs,
      key: stageKeys.runStageKey,
      writerKey: stageKeys.writerKey,
      writerRaw: stage.writerRaw,
    });

    const stagedPage = selectedPage
      ? pageEnvelope(input.pageRaw, code)
      : null;
    if (stagedPage !== null) {
      await writeStage({
        expiresAtMs: stage.expiresAtMs,
        key: stageKeys.pageStageKey,
        raw: stagedPage,
        writerKey: stageKeys.writerKey,
        writerRaw: stage.writerRaw,
      });
      await readStageExact({
        expectedRaw: stagedPage,
        expiresAtMs: stage.expiresAtMs,
        key: stageKeys.pageStageKey,
        writerKey: stageKeys.writerKey,
        writerRaw: stage.writerRaw,
      });
    }

    const keys = [
      selectedRun.key,
      stageKeys.writerKey,
      stageKeys.runStageKey,
      stageKeys.pageStageKey,
    ];
    let pageKeyIndex = 0;
    if (selectedPage) {
      keys.push(selectedPage.key);
      pageKeyIndex = keys.length;
    }
    let headKeyIndex = 0;
    if (selectedHead) {
      keys.push(selectedHead.key);
      headKeyIndex = keys.length;
    }
    const requiredKeyIndexes = requiredPageSet.map(
      (required) => {
        let index = keys.indexOf(required.key);
        if (index === -1) {
          keys.push(required.key);
          index = keys.length - 1;
        }
        return index + 1;
      },
    );
    const args = [
      input.expectedRaw,
      stage.writerRaw,
      String(stage.expiresAtMs),
      runStageHeader(input.nextRaw, fenceDigest, code),
      String(Buffer.byteLength(stagedRun, "utf8")),
      stagedPage === null
        ? ""
        : pageEnvelopeHeader(input.pageRaw, code),
      stagedPage === null
        ? ""
        : String(Buffer.byteLength(stagedPage, "utf8")),
      notAfterMs === null ? "" : String(notAfterMs),
      input.pageExpiresAtMs === null
        ? ""
        : String(input.pageExpiresAtMs),
      input.pageTtlMs === null
        ? ""
        : String(input.pageTtlMs),
      String(pageKeyIndex),
      String(headKeyIndex),
      input.headRaw ?? "",
      String(requiredPageSet.length),
      rawSha1(stagedRun),
      stagedPage === null ? "" : rawSha1(stagedPage),
      rawDigest(input.nextRaw),
      stagedPage === null ? "" : rawSha1(input.pageRaw),
      String(notBeforeMs),
    ];
    for (
      let index = 0;
      index < requiredPageSet.length;
      index += 1
    ) {
      args.push(
        String(requiredKeyIndexes[index]),
        `${PAGE_ENVELOPE_MAGIC}`
          + `${requiredPageSet[index].rawDigest}|`,
        requiredPageSet[index].nativeByteProofDigest,
        String(
          requiredPageSet[index].expectedExpiresAtMs,
        ),
        String(
          requiredPageSet[index].minimumRemainingTtlMs,
        ),
      );
    }
    const result = await execute([
      "EVAL",
      FINAL_COMPARE_AND_SET_LUA,
      keys.length,
      ...keys,
      ...args,
    ]);
    const nowMs = redisNowMs(result, 2);
    if (
      result.length !== 4
      || ![-2, -1, 1].includes(result[0])
      || typeof result[1] !== "string"
    ) {
      if (
        Array.isArray(result)
        && [-9, -3].includes(result[0])
      ) {
        fail(
          "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_ATOMIC_PROOF_FAILED",
        );
      }
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      );
    }
    if (result[0] !== 1) {
      if (result[1] !== "") {
        fail(
          "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
        );
      }
      const conflictRead = result[0] === -1
        ? await readOne({ key: selectedRun.key }, "run")
        : null;
      return Object.freeze({
        headReceipt: null,
        pageReceipt: null,
        pageSetReceipt: null,
        status: result[0] === -1
          ? "conflict"
          : "deadline_exceeded",
        raw: conflictRead?.raw ?? input.expectedRaw,
        redisNowMs: Math.max(
          nowMs,
          conflictRead?.redisNowMs ?? nowMs,
        ),
      });
    }
    if (result[1] !== rawDigest(input.nextRaw)) {
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      );
    }
    return Object.freeze({
      headReceipt: selectedHead
        ? Object.freeze({
          keyDigest: persistenceKeyDigest(selectedHead.key),
          rawDigest: rawDigest(input.headRaw),
        })
        : null,
      pageReceipt: selectedPage
        ? Object.freeze({
          expiresAtMs: input.pageExpiresAtMs,
          keyDigest: persistenceKeyDigest(selectedPage.key),
          rawDigest: rawDigest(input.pageRaw),
          ttlMs: input.pageTtlMs,
        })
        : null,
      pageSetReceipt: requiredPageSet.length
        ? Object.freeze({
          count: requiredPageSet.length,
          requestDigest: expectedPageSetDigest,
          verifiedAtMs: nowMs,
        })
        : null,
      status: "stored",
      raw: input.nextRaw,
      redisNowMs: nowMs,
    });
  }

  async function verifyArtifactSet(valueInput) {
    const code =
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_INPUT_INVALID";
    const input = exactRecord(
      valueInput,
      VERIFY_INPUT_KEYS,
      code,
    );
    const selectedRun = runKey(input.runKey, code);
    const selectedHead = headKey(input.headKey, code);
    if (
      selectedHead.workKeyDigest
        !== selectedRun.workKeyDigest
    ) {
      fail(code);
    }
    parsedCanonicalRaw(input.expectedRunRaw, code);
    parsedCanonicalRaw(input.expectedHeadRaw, code);
    const requiredPageSet = canonicalRequiredPageSet(
      input.requiredPageSet,
      selectedRun.workKeyDigest,
      code,
    );
    const expectedPageSetDigest =
      requiredPageSetDigest(requiredPageSet);
    if (
      exactDigest(input.requiredPageSetDigest, code)
        !== expectedPageSetDigest
      || exactDigest(input.requestDigest, code)
        !== artifactSetRequestDigest({
          runKey: selectedRun.key,
          expectedRunRaw: input.expectedRunRaw,
          headKey: selectedHead.key,
          expectedHeadRaw: input.expectedHeadRaw,
          requiredPageSetDigest: expectedPageSetDigest,
        })
    ) {
      fail(code);
    }
    const args = [
      input.expectedRunRaw,
      input.expectedHeadRaw,
      String(requiredPageSet.length),
    ];
    for (
      let index = 0;
      index < requiredPageSet.length;
      index += 1
    ) {
      args.push(
        `${PAGE_ENVELOPE_MAGIC}`
          + `${requiredPageSet[index].rawDigest}|`,
        requiredPageSet[index].nativeByteProofDigest,
        String(
          requiredPageSet[index].expectedExpiresAtMs,
        ),
        String(
          requiredPageSet[index].minimumRemainingTtlMs,
        ),
      );
    }
    const result = await execute([
      "EVAL",
      VERIFY_METADATA_SET_LUA,
      2 + requiredPageSet.length,
      selectedRun.key,
      selectedHead.key,
      ...requiredPageSet.map((item) => item.key),
      ...args,
    ]);
    const nowMs = redisNowMs(result, 1);
    if (
      result.length !== 3
      || ![0, 1].includes(result[0])
    ) {
      if (
        Array.isArray(result)
        && result[0] === -9
      ) {
        fail(
          "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_ATOMIC_PROOF_FAILED",
        );
      }
      fail(
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      );
    }
    if (result[0] === 0) {
      return Object.freeze({
        artifactSetReceipt: null,
        status: "mismatch",
        redisNowMs: nowMs,
      });
    }
    return Object.freeze({
      artifactSetReceipt: Object.freeze({
        count: requiredPageSet.length,
        requestDigest: input.requestDigest,
        verifiedAtMs: nowMs,
      }),
      status: "verified",
      redisNowMs: nowMs,
    });
  }

  return Object.freeze({
    compareAndSet,
    ensure,
    readHead(valueInput) {
      return readOne(valueInput, "head");
    },
    readPage,
    readRun(valueInput) {
      return readOne(valueInput, "run");
    },
    verifyArtifactSet,
  });
}
