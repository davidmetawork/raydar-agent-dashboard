// Immutable dashboard retention for signed Human Intro Calendar revisions.
//
// Each opaque source/event revision has exactly one record. Redis TIME owns
// the durable acknowledgement time and one Lua transition performs the
// create/readback. This store deliberately has no index, enumeration, mutable
// head, outcome, source-authority, or activation surface.

import {
  createHash,
} from "node:crypto";

import {
  kv,
  storeConfigured,
} from "./store.mjs";

export const HUMAN_INTRO_CALENDAR_RECEIPT_RETENTION_VERSION =
  "human-intro-calendar-receipt-retention-v1";

const RETENTION_PREFIX =
  "paraai:human-intro-calendar-receipt:v1:";
const DIGEST = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._:-]{0,79}$/u;
const RECEIPT_KEYS = Object.freeze([
  "createdAt",
  "eventRevision",
  "intakeEventId",
  "keyId",
  "observedAt",
  "payloadDigest",
  "scheduledEnd",
  "scheduledStart",
  "signature",
  "source",
  "sourceId",
  "status",
  "updatedAt",
  "version",
].sort());
const INPUT_KEYS = Object.freeze([
  "approvedKeyCommitmentDigest",
  "eventRevision",
  "jobId",
  "receipt",
  "receiptDigest",
  "sourceId",
].sort());
const RECORD_KEYS = Object.freeze([
  ...INPUT_KEYS,
  "retainedAtMs",
  "version",
].sort());

export class HumanIntroCalendarReceiptStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "HumanIntroCalendarReceiptStoreError";
    this.code = code;
  }
}

function fail(code) {
  throw new HumanIntroCalendarReceiptStoreError(code);
}

function plainRecord(value, expectedKeys, code) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    fail(code);
  }
  const keys = Object.keys(value).sort();
  if (
    Reflect.ownKeys(value).some((key) => typeof key !== "string")
    || keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
  ) {
    fail(code);
  }
  const copy = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.prototype.hasOwnProperty.call(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

function digest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(code);
  return value;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical values must be finite");
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
  throw new TypeError("canonical values must be JSON-safe");
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function receiptDigest(receipt) {
  return semanticDigest(
    "phase4-human-intro-calendar-receipt-digest-v1",
    receipt,
  );
}

function receiptKey(sourceId, eventRevision) {
  return `${RETENTION_PREFIX}${digest(
    sourceId,
    "HUMAN_INTRO_CALENDAR_RECEIPT_STORE_SOURCE_INVALID",
  )}:${digest(
    eventRevision,
    "HUMAN_INTRO_CALENDAR_RECEIPT_STORE_REVISION_INVALID",
  )}`;
}

function normalizeReceipt(value) {
  const receipt = plainRecord(
    value,
    RECEIPT_KEYS,
    "HUMAN_INTRO_CALENDAR_RECEIPT_STORE_RECEIPT_INVALID",
  );
  if (
    receipt.version !== "human-intro-calendar-observation-v1"
    || receipt.source !== "google_calendar"
    || !KEY_ID.test(String(receipt.keyId || ""))
    || !["confirmed", "cancelled"].includes(receipt.status)
  ) {
    fail("HUMAN_INTRO_CALENDAR_RECEIPT_STORE_RECEIPT_INVALID");
  }
  for (const field of [
    "sourceId",
    "intakeEventId",
    "payloadDigest",
    "eventRevision",
    "signature",
  ]) {
    digest(
      receipt[field],
      "HUMAN_INTRO_CALENDAR_RECEIPT_STORE_RECEIPT_INVALID",
    );
  }
  for (const field of [
    "createdAt",
    "updatedAt",
    "scheduledStart",
    "scheduledEnd",
    "observedAt",
  ]) {
    const milliseconds = Date.parse(String(receipt[field] || ""));
    if (
      !Number.isFinite(milliseconds)
      || new Date(milliseconds).toISOString() !== receipt[field]
    ) {
      fail("HUMAN_INTRO_CALENDAR_RECEIPT_STORE_RECEIPT_INVALID");
    }
  }
  return receipt;
}

function normalizeInput(value) {
  const input = plainRecord(
    value,
    INPUT_KEYS,
    "HUMAN_INTRO_CALENDAR_RECEIPT_STORE_INPUT_INVALID",
  );
  const sourceId = digest(
    input.sourceId,
    "HUMAN_INTRO_CALENDAR_RECEIPT_STORE_INPUT_INVALID",
  );
  const eventRevision = digest(
    input.eventRevision,
    "HUMAN_INTRO_CALENDAR_RECEIPT_STORE_INPUT_INVALID",
  );
  const selectedReceiptDigest = digest(
    input.receiptDigest,
    "HUMAN_INTRO_CALENDAR_RECEIPT_STORE_INPUT_INVALID",
  );
  const approvedKeyCommitmentDigest = digest(
    input.approvedKeyCommitmentDigest,
    "HUMAN_INTRO_CALENDAR_RECEIPT_STORE_INPUT_INVALID",
  );
  const receipt = normalizeReceipt(input.receipt);
  if (
    input.jobId !== `hi-${sourceId}`
    || receipt.sourceId !== sourceId
    || receipt.eventRevision !== eventRevision
    || receiptDigest(receipt) !== selectedReceiptDigest
  ) {
    fail("HUMAN_INTRO_CALENDAR_RECEIPT_STORE_CONTINUITY_INVALID");
  }
  return {
    version:
      HUMAN_INTRO_CALENDAR_RECEIPT_RETENTION_VERSION,
    jobId: input.jobId,
    sourceId,
    eventRevision,
    receiptDigest: selectedReceiptDigest,
    approvedKeyCommitmentDigest,
    receipt,
  };
}

function normalizeStoredRecord(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("HUMAN_INTRO_CALENDAR_RECEIPT_STORE_RECORD_INVALID");
  }
  const record = plainRecord(
    parsed,
    RECORD_KEYS,
    "HUMAN_INTRO_CALENDAR_RECEIPT_STORE_RECORD_INVALID",
  );
  const normalized = normalizeInput({
    approvedKeyCommitmentDigest:
      record.approvedKeyCommitmentDigest,
    eventRevision: record.eventRevision,
    jobId: record.jobId,
    receipt: record.receipt,
    receiptDigest: record.receiptDigest,
    sourceId: record.sourceId,
  });
  if (
    record.version
      !== HUMAN_INTRO_CALENDAR_RECEIPT_RETENTION_VERSION
    || !Number.isSafeInteger(record.retainedAtMs)
    || record.retainedAtMs < 0
  ) {
    fail("HUMAN_INTRO_CALENDAR_RECEIPT_STORE_RECORD_INVALID");
  }
  return Object.freeze({
    ...normalized,
    retainedAtMs: record.retainedAtMs,
  });
}

function parseTransition(result, expected) {
  if (
    !Array.isArray(result)
    || result.length !== 3
    || ![1, 2].includes(Number(result[0]))
    || typeof result[1] !== "string"
    || typeof result[2] !== "string"
    || !SHA1.test(result[2])
    || createHash("sha1").update(result[1]).digest("hex")
      !== result[2]
  ) {
    fail("HUMAN_INTRO_CALENDAR_RECEIPT_STORE_READBACK_INVALID");
  }
  const record = normalizeStoredRecord(result[1]);
  if (
    record.jobId !== expected.jobId
    || record.sourceId !== expected.sourceId
    || record.eventRevision !== expected.eventRevision
    || record.receiptDigest !== expected.receiptDigest
    || record.approvedKeyCommitmentDigest
      !== expected.approvedKeyCommitmentDigest
    || canonicalJson(record.receipt)
      !== canonicalJson(expected.receipt)
  ) {
    fail("HUMAN_INTRO_CALENDAR_RECEIPT_STORE_CONFLICT");
  }
  return Object.freeze({
    created: Number(result[0]) === 1,
    duplicate: Number(result[0]) === 2,
    jobId: record.jobId,
    sourceId: record.sourceId,
    eventRevision: record.eventRevision,
    receiptDigest: record.receiptDigest,
    approvedKeyCommitmentDigest:
      record.approvedKeyCommitmentDigest,
    retainedAtMs: record.retainedAtMs,
    recordRevisionSha1: result[2],
    receipt: record.receipt,
  });
}

const RETAIN_LUA = `
  local existing = redis.call('GET', KEYS[1])
  if existing then
    return {2, existing, redis.sha1hex(existing)}
  end
  local redisTime = redis.call('TIME')
  local retainedAtMs =
    (tonumber(redisTime[1]) * 1000)
    + math.floor(tonumber(redisTime[2]) / 1000)
  local proposed = cjson.decode(ARGV[1])
  proposed.retainedAtMs = retainedAtMs
  local encoded = cjson.encode(proposed)
  redis.call('SET', KEYS[1], encoded, 'NX')
  local stored = redis.call('GET', KEYS[1])
  return {1, stored, redis.sha1hex(stored)}
`;

export function createHumanIntroCalendarReceiptStore({
  kvImpl = kv,
  configured = storeConfigured,
} = {}) {
  return Object.freeze({
    configured,
    async retain(input) {
      if (!configured()) {
        fail("HUMAN_INTRO_CALENDAR_RECEIPT_STORE_UNAVAILABLE");
      }
      const normalized = normalizeInput(input);
      const proposed = canonicalJson(normalized);
      let result;
      try {
        result = await kvImpl([
          "EVAL",
          RETAIN_LUA,
          "1",
          receiptKey(
            normalized.sourceId,
            normalized.eventRevision,
          ),
          proposed,
        ]);
      } catch (error) {
        if (error instanceof HumanIntroCalendarReceiptStoreError) {
          throw error;
        }
        fail("HUMAN_INTRO_CALENDAR_RECEIPT_STORE_UNAVAILABLE");
      }
      return parseTransition(result, normalized);
    },
    async read({ sourceId, eventRevision } = {}) {
      if (!configured()) {
        fail("HUMAN_INTRO_CALENDAR_RECEIPT_STORE_UNAVAILABLE");
      }
      let raw;
      try {
        raw = await kvImpl([
          "GET",
          receiptKey(sourceId, eventRevision),
        ]);
      } catch {
        fail("HUMAN_INTRO_CALENDAR_RECEIPT_STORE_UNAVAILABLE");
      }
      if (typeof raw !== "string") return null;
      const record = normalizeStoredRecord(raw);
      const recordRevisionSha1 =
        createHash("sha1").update(raw).digest("hex");
      return Object.freeze({
        ...record,
        recordRevisionSha1,
      });
    },
  });
}

const DEFAULT_STORE =
  createHumanIntroCalendarReceiptStore();

export const humanIntroCalendarReceiptStoreConfigured =
  DEFAULT_STORE.configured;
export const retainHumanIntroCalendarReceipt =
  DEFAULT_STORE.retain;
export const readHumanIntroCalendarReceipt =
  DEFAULT_STORE.read;
