// Immutable dashboard retention for signed Human Intro outcome attestations.
//
// Each opaque source/Calendar revision has exactly one outcome record.
// Redis TIME owns the durable acknowledgement time and one Lua transition
// performs create/readback. There is no index, enumeration, mutable head,
// identity resolution, source authority, or activation surface.

import {
  createHash,
} from "node:crypto";

import {
  kv,
  storeConfigured,
} from "./store.mjs";

export const HUMAN_INTRO_OUTCOME_RECEIPT_RETENTION_VERSION =
  "human-intro-outcome-receipt-retention-v1";

const RETENTION_PREFIX =
  "paraai:human-intro-outcome-receipt:v1:";
const DIGEST = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._:-]{0,79}$/u;
const CANONICAL_INSTANT =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const ATTESTATION_KEYS = Object.freeze([
  "attestedAt",
  "calendarEventRevision",
  "intakeEventId",
  "keyId",
  "occurredAt",
  "outcome",
  "payloadDigest",
  "signature",
  "source",
  "sourceId",
  "version",
].sort());
const INPUT_KEYS = Object.freeze([
  "approvedCalendarKeyCommitmentDigest",
  "approvedOutcomeKeyCommitmentDigest",
  "calendarEventRevision",
  "calendarReceiptDigest",
  "calendarRetentionRevisionSha1",
  "jobId",
  "outcomeAttestation",
  "outcomeReceiptDigest",
  "sourceId",
].sort());
const RECORD_KEYS = Object.freeze([
  ...INPUT_KEYS,
  "retainedAtMs",
  "version",
].sort());

export class HumanIntroOutcomeReceiptStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "HumanIntroOutcomeReceiptStoreError";
    this.code = code;
  }
}

function fail(code) {
  throw new HumanIntroOutcomeReceiptStoreError(code);
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

function sha1(value, code) {
  if (typeof value !== "string" || !SHA1.test(value)) fail(code);
  return value;
}

function canonicalInstant(value, code) {
  if (
    typeof value !== "string"
    || !CANONICAL_INSTANT.test(value)
  ) {
    fail(code);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value
  ) {
    fail(code);
  }
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

function outcomeReceiptDigest(attestation) {
  return semanticDigest(
    "phase4-human-intro-outcome-receipt-digest-v1",
    attestation,
  );
}

function receiptKey(sourceId, calendarEventRevision) {
  return `${RETENTION_PREFIX}${digest(
    sourceId,
    "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_SOURCE_INVALID",
  )}:${digest(
    calendarEventRevision,
    "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_REVISION_INVALID",
  )}`;
}

function normalizeAttestation(value) {
  const attestation = plainRecord(
    value,
    ATTESTATION_KEYS,
    "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_ATTESTATION_INVALID",
  );
  if (
    attestation.version
      !== "human-intro-outcome-attestation-v1"
    || attestation.source
      !== "raydar_human_outcome_attestation"
    || !KEY_ID.test(String(attestation.keyId || ""))
    || !["completed", "no_show"].includes(attestation.outcome)
  ) {
    fail("HUMAN_INTRO_OUTCOME_RECEIPT_STORE_ATTESTATION_INVALID");
  }
  for (const field of [
    "sourceId",
    "intakeEventId",
    "payloadDigest",
    "calendarEventRevision",
    "signature",
  ]) {
    digest(
      attestation[field],
      "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_ATTESTATION_INVALID",
    );
  }
  canonicalInstant(
    attestation.attestedAt,
    "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_ATTESTATION_INVALID",
  );
  if (attestation.outcome === "completed") {
    canonicalInstant(
      attestation.occurredAt,
      "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_ATTESTATION_INVALID",
    );
  } else if (attestation.occurredAt !== null) {
    fail("HUMAN_INTRO_OUTCOME_RECEIPT_STORE_ATTESTATION_INVALID");
  }
  return attestation;
}

function normalizeInput(value) {
  const input = plainRecord(
    value,
    INPUT_KEYS,
    "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_INPUT_INVALID",
  );
  const sourceId = digest(
    input.sourceId,
    "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_INPUT_INVALID",
  );
  const calendarEventRevision = digest(
    input.calendarEventRevision,
    "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_INPUT_INVALID",
  );
  const calendarReceiptDigest = digest(
    input.calendarReceiptDigest,
    "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_INPUT_INVALID",
  );
  const selectedOutcomeReceiptDigest = digest(
    input.outcomeReceiptDigest,
    "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_INPUT_INVALID",
  );
  const approvedCalendarKeyCommitmentDigest = digest(
    input.approvedCalendarKeyCommitmentDigest,
    "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_INPUT_INVALID",
  );
  const approvedOutcomeKeyCommitmentDigest = digest(
    input.approvedOutcomeKeyCommitmentDigest,
    "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_INPUT_INVALID",
  );
  const calendarRetentionRevisionSha1 = sha1(
    input.calendarRetentionRevisionSha1,
    "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_INPUT_INVALID",
  );
  const outcomeAttestation =
    normalizeAttestation(input.outcomeAttestation);
  if (
    input.jobId !== `hi-${sourceId}`
    || outcomeAttestation.sourceId !== sourceId
    || outcomeAttestation.calendarEventRevision
      !== calendarEventRevision
    || outcomeReceiptDigest(outcomeAttestation)
      !== selectedOutcomeReceiptDigest
  ) {
    fail("HUMAN_INTRO_OUTCOME_RECEIPT_STORE_CONTINUITY_INVALID");
  }
  return {
    version:
      HUMAN_INTRO_OUTCOME_RECEIPT_RETENTION_VERSION,
    jobId: input.jobId,
    sourceId,
    calendarEventRevision,
    calendarReceiptDigest,
    calendarRetentionRevisionSha1,
    outcomeReceiptDigest: selectedOutcomeReceiptDigest,
    approvedCalendarKeyCommitmentDigest,
    approvedOutcomeKeyCommitmentDigest,
    outcomeAttestation,
  };
}

function normalizeStoredRecord(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("HUMAN_INTRO_OUTCOME_RECEIPT_STORE_RECORD_INVALID");
  }
  const record = plainRecord(
    parsed,
    RECORD_KEYS,
    "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_RECORD_INVALID",
  );
  const normalized = normalizeInput({
    approvedCalendarKeyCommitmentDigest:
      record.approvedCalendarKeyCommitmentDigest,
    approvedOutcomeKeyCommitmentDigest:
      record.approvedOutcomeKeyCommitmentDigest,
    calendarEventRevision: record.calendarEventRevision,
    calendarReceiptDigest: record.calendarReceiptDigest,
    calendarRetentionRevisionSha1:
      record.calendarRetentionRevisionSha1,
    jobId: record.jobId,
    outcomeAttestation: record.outcomeAttestation,
    outcomeReceiptDigest: record.outcomeReceiptDigest,
    sourceId: record.sourceId,
  });
  if (
    record.version
      !== HUMAN_INTRO_OUTCOME_RECEIPT_RETENTION_VERSION
    || !Number.isSafeInteger(record.retainedAtMs)
    || record.retainedAtMs < 0
  ) {
    fail("HUMAN_INTRO_OUTCOME_RECEIPT_STORE_RECORD_INVALID");
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
    fail("HUMAN_INTRO_OUTCOME_RECEIPT_STORE_READBACK_INVALID");
  }
  const record = normalizeStoredRecord(result[1]);
  if (
    record.jobId !== expected.jobId
    || record.sourceId !== expected.sourceId
    || record.calendarEventRevision
      !== expected.calendarEventRevision
    || record.calendarReceiptDigest
      !== expected.calendarReceiptDigest
    || record.calendarRetentionRevisionSha1
      !== expected.calendarRetentionRevisionSha1
    || record.outcomeReceiptDigest
      !== expected.outcomeReceiptDigest
    || record.approvedCalendarKeyCommitmentDigest
      !== expected.approvedCalendarKeyCommitmentDigest
    || record.approvedOutcomeKeyCommitmentDigest
      !== expected.approvedOutcomeKeyCommitmentDigest
    || canonicalJson(record.outcomeAttestation)
      !== canonicalJson(expected.outcomeAttestation)
  ) {
    fail("HUMAN_INTRO_OUTCOME_RECEIPT_STORE_CONFLICT");
  }
  return Object.freeze({
    created: Number(result[0]) === 1,
    duplicate: Number(result[0]) === 2,
    jobId: record.jobId,
    sourceId: record.sourceId,
    calendarEventRevision: record.calendarEventRevision,
    calendarReceiptDigest: record.calendarReceiptDigest,
    calendarRetentionRevisionSha1:
      record.calendarRetentionRevisionSha1,
    outcomeReceiptDigest: record.outcomeReceiptDigest,
    approvedCalendarKeyCommitmentDigest:
      record.approvedCalendarKeyCommitmentDigest,
    approvedOutcomeKeyCommitmentDigest:
      record.approvedOutcomeKeyCommitmentDigest,
    retainedAtMs: record.retainedAtMs,
    recordRevisionSha1: result[2],
    outcomeAttestation: record.outcomeAttestation,
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

export function createHumanIntroOutcomeReceiptStore({
  kvImpl = kv,
  configured = storeConfigured,
} = {}) {
  return Object.freeze({
    configured,
    async retain(input) {
      if (!configured()) {
        fail("HUMAN_INTRO_OUTCOME_RECEIPT_STORE_UNAVAILABLE");
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
            normalized.calendarEventRevision,
          ),
          proposed,
        ]);
      } catch (error) {
        if (error instanceof HumanIntroOutcomeReceiptStoreError) {
          throw error;
        }
        fail("HUMAN_INTRO_OUTCOME_RECEIPT_STORE_UNAVAILABLE");
      }
      return parseTransition(result, normalized);
    },
    async read({ sourceId, calendarEventRevision } = {}) {
      if (!configured()) {
        fail("HUMAN_INTRO_OUTCOME_RECEIPT_STORE_UNAVAILABLE");
      }
      let raw;
      try {
        raw = await kvImpl([
          "GET",
          receiptKey(sourceId, calendarEventRevision),
        ]);
      } catch {
        fail("HUMAN_INTRO_OUTCOME_RECEIPT_STORE_UNAVAILABLE");
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
  createHumanIntroOutcomeReceiptStore();

export const humanIntroOutcomeReceiptStoreConfigured =
  DEFAULT_STORE.configured;
export const retainHumanIntroOutcomeReceipt =
  DEFAULT_STORE.retain;
export const readHumanIntroOutcomeReceipt =
  DEFAULT_STORE.read;
