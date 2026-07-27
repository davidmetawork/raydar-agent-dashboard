// Exact consumer-side protocol for the private Calls classifier capsule.
//
// This module intentionally mirrors the deployed Calls v2 wire contract
// without importing producer code. It performs no environment read, network
// I/O, durable write, source transition, identity resolution, or release
// decision.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

export const SOURCE_RECALL_CLASSIFIER_CAPSULE_PROTOCOL_VERSION =
  "recall-classifier-capsule-consumer-protocol-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_VERSION =
  "paraai-recall-classifier-capsule-request-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_VERSION =
  "paraai-recall-classifier-capsule-response-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_VERSION =
  "recall-calls-classifier-capsule-v2";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_VERSION =
  "paraai-recall-classifier-capsule-receipt-v1";
export const SOURCE_RECALL_CLASSIFIER_POINT_PROOF_VERSION =
  "paraai-recall-classifier-point-proof-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_BODY_BYTES =
  32 * 1024;
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_RESPONSE_BYTES =
  32 * 1024;
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_TTL_MS =
  24 * 60 * 60 * 1_000;

export const SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_DIGEST_DOMAIN =
  "paraai-recall-classifier-capsule-request-bytes-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_BINDING_DIGEST_DOMAIN =
  "paraai-recall-classifier-point-binding-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_PROOF_DIGEST_DOMAIN =
  "paraai-recall-classifier-point-proof-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_CONTEXT_DIGEST_DOMAIN =
  "paraai-recall-classifier-capsule-context-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_RESERVATION_DIGEST_DOMAIN =
  "paraai-recall-classifier-capsule-reservation-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_ENDED_AT_DIGEST_DOMAIN =
  "paraai-recall-classifier-ended-at-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_OUTPUT_DIGEST_DOMAIN =
  "paraai-recall-classifier-output-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_DIGEST_DOMAIN =
  "paraai-recall-classifier-capsule-v2";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_SIGNATURE_DOMAIN =
  "paraai-recall-classifier-capsule-receipt-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_DIGEST_DOMAIN =
  "paraai-recall-classifier-capsule-receipt-bytes-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_DIGEST_DOMAIN =
  "paraai-recall-classifier-capsule-response-bytes-v1";

const DIGEST = /^[a-f0-9]{64}$/u;
const ED25519_SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const SOURCE = "recall";
const MAX_TIMESTAMP_MS = Number.MAX_SAFE_INTEGER;

const REQUEST_KEYS = Object.freeze([
  "version",
  "pointReservationId",
  "pointContextDigest",
  "pointReadNumber",
  "pointRequestDigest",
  "decisionBoundaryAt",
  "pointProof",
]);
const POINT_PROOF_KEYS = Object.freeze([
  "version",
  "observationStatus",
  "workKeyDigest",
  "contractPinsDigest",
  "workItemDigest",
  "resolutionDigest",
  "pointCompletedAtMs",
  "pointTransportReceiptDigest",
  "pointEvidenceDigest",
  "sourceNormalizedInputDigest",
  "sourceRecordDigest",
  "sourceRecordRevisionDigest",
  "sourceReferenceDigest",
  "sourceProvenanceDigest",
  "sourceStatusAtBoundaryDigest",
  "decisionBoundaryDigest",
]);
const CAPSULE_KEYS = Object.freeze([
  "version",
  "source",
  "pointBindingDigest",
  "pointProofDigest",
  "pointResponseDigest",
  "decisionBoundaryDigest",
  "callEndedAt",
  "callEndedAtBasis",
  "callEndedAtDigest",
  "classifierArtifactDigest",
  "classifierDeploymentDigest",
  "classifierRuntimeConfigDigest",
  "classifierPolicyDigest",
  "classifierInputDigest",
  "transcriptEvidenceDigest",
  "presenceEvidenceDigest",
  "vapiEvidenceDigest",
  "mediaEvidenceDigest",
  "vapiAssociationStatus",
  "callsVerdict",
  "classification",
  "classificationBasis",
  "classifierOutputDigest",
  "classifiedAtMs",
]);
const CLASSIFIER_PIN_KEYS = Object.freeze([
  "classifierArtifactDigest",
  "classifierDeploymentDigest",
  "classifierRuntimeConfigDigest",
  "classifierPolicyDigest",
]);
const UNSIGNED_RECEIPT_KEYS = Object.freeze([
  "version",
  "keyId",
  "reservationId",
  "contextDigest",
  "readNumber",
  "requestDigest",
  "pointResponseDigest",
  "capsuleDigest",
  "issuedAtMs",
  "expiresAtMs",
]);
const RECEIPT_KEYS = Object.freeze([
  ...UNSIGNED_RECEIPT_KEYS,
  "signature",
]);
const RESPONSE_KEYS = Object.freeze([
  "version",
  "reservationId",
  "contextDigest",
  "readNumber",
  "requestDigest",
  "capsule",
  "receipt",
]);

const CALLS_VERDICTS = new Set([
  "success",
  "recorded",
  "audio_fail",
  "joined_silent",
  "incomplete",
  "no_show",
  "pending",
  "unknown",
]);
const CLASSIFICATIONS = new Set([
  "success",
  "failure",
  "unavailable",
]);
const CLASSIFICATION_BASES = new Set([
  "transcript_two_way",
  "transcript_agent_audio_failure",
  "transcript_incomplete",
  "transcript_joined_silent",
  "vapi_answers",
  "presence_recorded",
  "recall_empty_room",
  "presence_empty_room",
  "transcript_empty_room",
  "vapi_silence",
  "media_recorded",
  "processing",
]);
const CALL_ENDED_AT_BASES = new Set([
  "recording_completed_at",
  "join_at_plus_duration",
  "unavailable",
]);
const VAPI_ASSOCIATION_STATUSES = new Set([
  "not_used",
  "exact",
  "unproven",
]);
const VAPI_BASES = new Set([
  "vapi_answers",
  "vapi_silence",
]);
const VERDICT_FOR_BASIS = new Map([
  ["transcript_two_way", "success"],
  ["transcript_agent_audio_failure", "audio_fail"],
  ["transcript_incomplete", "incomplete"],
  ["transcript_joined_silent", "joined_silent"],
  ["vapi_answers", "success"],
  ["presence_recorded", "recorded"],
  ["recall_empty_room", "no_show"],
  ["presence_empty_room", "no_show"],
  ["transcript_empty_room", "no_show"],
  ["vapi_silence", "no_show"],
  ["media_recorded", "recorded"],
  ["processing", "pending"],
]);

export class SourceRecallClassifierCapsuleProtocolError
  extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallClassifierCapsuleProtocolError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallClassifierCapsuleProtocolError(code);
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

function exactKeys(record, expected, code) {
  const actual = Object.keys(record).sort();
  const selected = [...expected].sort();
  if (
    actual.length !== selected.length
    || actual.some(
      (key, index) => key !== selected[index],
    )
  ) {
    fail(code);
  }
}

function exactDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
  return value;
}

function exactReadNumber(value, code) {
  if (![1, 2].includes(value)) fail(code);
  return value;
}

function timestampMs(value, code) {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value <= 0
    || value > MAX_TIMESTAMP_MS
  ) {
    fail(code);
  }
  return value;
}

function canonicalTimestamp(value, code) {
  if (
    typeof value !== "string"
    || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u
      .test(value)
  ) {
    fail(code);
  }
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value
  ) {
    fail(code);
  }
  return value;
}

function digest(domain, body) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(body, "utf8")
    .digest("hex");
}

function normalizedPointProof(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_PROOF_INVALID";
  const raw = plainRecordSnapshot(value, code);
  exactKeys(raw, POINT_PROOF_KEYS, code);
  const proof = {
    version: raw.version,
    observationStatus: raw.observationStatus,
    workKeyDigest: exactDigest(raw.workKeyDigest, code),
    contractPinsDigest:
      exactDigest(raw.contractPinsDigest, code),
    workItemDigest: exactDigest(raw.workItemDigest, code),
    resolutionDigest: exactDigest(raw.resolutionDigest, code),
    pointCompletedAtMs:
      timestampMs(raw.pointCompletedAtMs, code),
    pointTransportReceiptDigest:
      exactDigest(raw.pointTransportReceiptDigest, code),
    pointEvidenceDigest:
      exactDigest(raw.pointEvidenceDigest, code),
    sourceNormalizedInputDigest:
      exactDigest(raw.sourceNormalizedInputDigest, code),
    sourceRecordDigest:
      exactDigest(raw.sourceRecordDigest, code),
    sourceRecordRevisionDigest:
      exactDigest(raw.sourceRecordRevisionDigest, code),
    sourceReferenceDigest:
      exactDigest(raw.sourceReferenceDigest, code),
    sourceProvenanceDigest:
      exactDigest(raw.sourceProvenanceDigest, code),
    sourceStatusAtBoundaryDigest:
      exactDigest(raw.sourceStatusAtBoundaryDigest, code),
    decisionBoundaryDigest:
      exactDigest(raw.decisionBoundaryDigest, code),
  };
  if (
    proof.version
      !== SOURCE_RECALL_CLASSIFIER_POINT_PROOF_VERSION
    || proof.observationStatus !== "stable"
  ) {
    fail(code);
  }
  return deepFreeze(proof);
}

function requestWireValue(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_INVALID";
  const raw = plainRecordSnapshot(value, code);
  exactKeys(raw, REQUEST_KEYS, code);
  const request = {
    version: raw.version,
    pointReservationId:
      exactDigest(raw.pointReservationId, code),
    pointContextDigest:
      exactDigest(raw.pointContextDigest, code),
    pointReadNumber:
      exactReadNumber(raw.pointReadNumber, code),
    pointRequestDigest:
      exactDigest(raw.pointRequestDigest, code),
    decisionBoundaryAt:
      canonicalTimestamp(raw.decisionBoundaryAt, code),
    pointProof: normalizedPointProof(raw.pointProof),
  };
  if (
    request.version
      !== SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_VERSION
    || request.pointProof.pointCompletedAtMs
      < Date.parse(request.decisionBoundaryAt)
  ) {
    fail(code);
  }
  return deepFreeze(request);
}

export function sourceRecallClassifierPointProofDigest(
  pointProof,
) {
  const normalized = normalizedPointProof(pointProof);
  return digest(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_PROOF_DIGEST_DOMAIN,
    JSON.stringify(normalized),
  );
}

export function sourceRecallClassifierPointBindingDigest(
  request,
) {
  const normalized = requestWireValue(request);
  return digest(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_BINDING_DIGEST_DOMAIN,
    JSON.stringify({
      pointReservationId: normalized.pointReservationId,
      pointContextDigest: normalized.pointContextDigest,
      pointReadNumber: normalized.pointReadNumber,
      pointRequestDigest: normalized.pointRequestDigest,
    }),
  );
}

export function sourceRecallClassifierCapsuleRequestDigest(
  rawBody,
) {
  if (
    typeof rawBody !== "string"
    || Buffer.byteLength(rawBody, "utf8")
      > SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_BODY_BYTES
  ) {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_INVALID");
  }
  return digest(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_DIGEST_DOMAIN,
    rawBody,
  );
}

export function prepareSourceRecallClassifierCapsuleRequest(
  value,
) {
  const request = requestWireValue(value);
  const rawBody = JSON.stringify(request);
  if (
    Buffer.byteLength(rawBody, "utf8")
      > SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_BODY_BYTES
  ) {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_INVALID");
  }
  return deepFreeze({
    ...request,
    requestDigest:
      sourceRecallClassifierCapsuleRequestDigest(rawBody),
    pointBindingDigest:
      sourceRecallClassifierPointBindingDigest(request),
    pointProofDigest:
      sourceRecallClassifierPointProofDigest(
        request.pointProof,
      ),
    rawBody,
  });
}

function normalizedPreparedRequest(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_INVALID";
  const raw = plainRecordSnapshot(value, code);
  exactKeys(
    raw,
    [
      ...REQUEST_KEYS,
      "requestDigest",
      "pointBindingDigest",
      "pointProofDigest",
      "rawBody",
    ],
    code,
  );
  const request = requestWireValue(
    Object.fromEntries(
      REQUEST_KEYS.map((key) => [key, raw[key]]),
    ),
  );
  const rawBody = JSON.stringify(request);
  const normalized = {
    ...request,
    requestDigest: exactDigest(raw.requestDigest, code),
    pointBindingDigest:
      exactDigest(raw.pointBindingDigest, code),
    pointProofDigest:
      exactDigest(raw.pointProofDigest, code),
    rawBody,
  };
  if (
    raw.rawBody !== rawBody
    || normalized.requestDigest
      !== sourceRecallClassifierCapsuleRequestDigest(rawBody)
    || normalized.pointBindingDigest
      !== sourceRecallClassifierPointBindingDigest(request)
    || normalized.pointProofDigest
      !== sourceRecallClassifierPointProofDigest(
        request.pointProof,
      )
  ) {
    fail(code);
  }
  return deepFreeze(normalized);
}

function normalizedClassifierPins(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_PINS_INVALID";
  const raw = plainRecordSnapshot(value, code);
  exactKeys(raw, CLASSIFIER_PIN_KEYS, code);
  return deepFreeze({
    classifierArtifactDigest:
      exactDigest(raw.classifierArtifactDigest, code),
    classifierDeploymentDigest:
      exactDigest(raw.classifierDeploymentDigest, code),
    classifierRuntimeConfigDigest:
      exactDigest(
        raw.classifierRuntimeConfigDigest,
        code,
      ),
    classifierPolicyDigest:
      exactDigest(raw.classifierPolicyDigest, code),
  });
}

export function sourceRecallClassifierCapsuleContextDigest(
  request,
  classifierPins,
) {
  const normalizedRequest =
    normalizedPreparedRequest(request);
  const pins = normalizedClassifierPins(classifierPins);
  return digest(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_CONTEXT_DIGEST_DOMAIN,
    JSON.stringify({
      requestDigest: normalizedRequest.requestDigest,
      ...pins,
    }),
  );
}

export function sourceRecallClassifierCapsuleReservationId(
  request,
  contextDigest,
) {
  const normalizedRequest =
    normalizedPreparedRequest(request);
  const selectedContext = exactDigest(
    contextDigest,
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_RESERVATION_INVALID",
  );
  return digest(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_RESERVATION_DIGEST_DOMAIN,
    JSON.stringify({
      pointReservationId:
        normalizedRequest.pointReservationId,
      pointReadNumber: normalizedRequest.pointReadNumber,
      contextDigest: selectedContext,
    }),
  );
}

function expectedClassification(classificationBasis) {
  if (classificationBasis === "transcript_two_way") {
    return "success";
  }
  if (
    classificationBasis
      === "transcript_agent_audio_failure"
    || classificationBasis === "transcript_incomplete"
  ) {
    return "failure";
  }
  return "unavailable";
}

function outputMaterial(value) {
  return {
    vapiAssociationStatus: value.vapiAssociationStatus,
    callsVerdict: value.callsVerdict,
    classification: value.classification,
    classificationBasis: value.classificationBasis,
  };
}

export function sourceRecallClassifierOutputDigest(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_OUTPUT_INVALID";
  const raw = plainRecordSnapshot(value, code);
  exactKeys(
    raw,
    [
      "vapiAssociationStatus",
      "callsVerdict",
      "classification",
      "classificationBasis",
    ],
    code,
  );
  if (
    !VAPI_ASSOCIATION_STATUSES.has(
      raw.vapiAssociationStatus,
    )
    || !CALLS_VERDICTS.has(raw.callsVerdict)
    || !CLASSIFICATIONS.has(raw.classification)
    || !CLASSIFICATION_BASES.has(raw.classificationBasis)
    || (
      VAPI_BASES.has(raw.classificationBasis)
        ? !["exact", "unproven"].includes(
          raw.vapiAssociationStatus,
        )
        : raw.vapiAssociationStatus !== "not_used"
    )
    || VERDICT_FOR_BASIS.get(raw.classificationBasis)
      !== raw.callsVerdict
    || raw.classification
      !== expectedClassification(raw.classificationBasis)
  ) {
    fail(code);
  }
  return digest(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_OUTPUT_DIGEST_DOMAIN,
    JSON.stringify(outputMaterial(raw)),
  );
}

export function sourceRecallClassifierEndedAtDigest({
  sourceRecordDigest,
  callEndedAt,
  callEndedAtBasis,
} = {}) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_ENDED_AT_INVALID";
  const recordDigest = exactDigest(sourceRecordDigest, code);
  const selectedEndedAt = callEndedAt === null
    ? null
    : canonicalTimestamp(callEndedAt, code);
  if (
    !CALL_ENDED_AT_BASES.has(callEndedAtBasis)
    || (
      selectedEndedAt === null
        ? callEndedAtBasis !== "unavailable"
        : callEndedAtBasis === "unavailable"
    )
  ) {
    fail(code);
  }
  return digest(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_ENDED_AT_DIGEST_DOMAIN,
    JSON.stringify({
      sourceRecordDigest: recordDigest,
      callEndedAt: selectedEndedAt,
      callEndedAtBasis,
    }),
  );
}

function normalizedCapsule(value, request) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_INVALID";
  const raw = plainRecordSnapshot(value, code);
  exactKeys(raw, CAPSULE_KEYS, code);
  const capsule = {
    version: raw.version,
    source: raw.source,
    pointBindingDigest:
      exactDigest(raw.pointBindingDigest, code),
    pointProofDigest:
      exactDigest(raw.pointProofDigest, code),
    pointResponseDigest:
      exactDigest(raw.pointResponseDigest, code),
    decisionBoundaryDigest:
      exactDigest(raw.decisionBoundaryDigest, code),
    callEndedAt: raw.callEndedAt === null
      ? null
      : canonicalTimestamp(raw.callEndedAt, code),
    callEndedAtBasis: raw.callEndedAtBasis,
    callEndedAtDigest:
      exactDigest(raw.callEndedAtDigest, code),
    classifierArtifactDigest:
      exactDigest(raw.classifierArtifactDigest, code),
    classifierDeploymentDigest:
      exactDigest(raw.classifierDeploymentDigest, code),
    classifierRuntimeConfigDigest:
      exactDigest(
        raw.classifierRuntimeConfigDigest,
        code,
      ),
    classifierPolicyDigest:
      exactDigest(raw.classifierPolicyDigest, code),
    classifierInputDigest:
      exactDigest(raw.classifierInputDigest, code),
    transcriptEvidenceDigest:
      exactDigest(raw.transcriptEvidenceDigest, code),
    presenceEvidenceDigest:
      exactDigest(raw.presenceEvidenceDigest, code),
    vapiEvidenceDigest:
      exactDigest(raw.vapiEvidenceDigest, code),
    mediaEvidenceDigest:
      exactDigest(raw.mediaEvidenceDigest, code),
    vapiAssociationStatus: raw.vapiAssociationStatus,
    callsVerdict: raw.callsVerdict,
    classification: raw.classification,
    classificationBasis: raw.classificationBasis,
    classifierOutputDigest:
      exactDigest(raw.classifierOutputDigest, code),
    classifiedAtMs: timestampMs(raw.classifiedAtMs, code),
  };
  const output = outputMaterial(capsule);
  if (
    capsule.version !== SOURCE_RECALL_CLASSIFIER_CAPSULE_VERSION
    || capsule.source !== SOURCE
    || capsule.pointBindingDigest
      !== request.pointBindingDigest
    || capsule.pointProofDigest !== request.pointProofDigest
    || capsule.decisionBoundaryDigest
      !== request.pointProof.decisionBoundaryDigest
    || (
      capsule.callEndedAt !== null
      && Date.parse(capsule.callEndedAt)
        > Date.parse(request.decisionBoundaryAt)
    )
    || capsule.callEndedAtDigest
      !== sourceRecallClassifierEndedAtDigest({
        sourceRecordDigest:
          request.pointProof.sourceRecordDigest,
        callEndedAt: capsule.callEndedAt,
        callEndedAtBasis: capsule.callEndedAtBasis,
      })
    || capsule.classifiedAtMs
      < request.pointProof.pointCompletedAtMs
    || capsule.classifierOutputDigest
      !== sourceRecallClassifierOutputDigest(output)
  ) {
    fail(code);
  }
  return deepFreeze(capsule);
}

export function sourceRecallClassifierCapsuleDigest(
  capsule,
  request,
) {
  const normalizedRequest =
    normalizedPreparedRequest(request);
  const normalized = normalizedCapsule(
    capsule,
    normalizedRequest,
  );
  return digest(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_DIGEST_DOMAIN,
    JSON.stringify(normalized),
  );
}

function unsignedReceiptValue(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_INVALID";
  const raw = plainRecordSnapshot(value, code);
  exactKeys(raw, UNSIGNED_RECEIPT_KEYS, code);
  const receipt = {
    version: raw.version,
    keyId: exactDigest(raw.keyId, code),
    reservationId: exactDigest(raw.reservationId, code),
    contextDigest: exactDigest(raw.contextDigest, code),
    readNumber: exactReadNumber(raw.readNumber, code),
    requestDigest: exactDigest(raw.requestDigest, code),
    pointResponseDigest:
      exactDigest(raw.pointResponseDigest, code),
    capsuleDigest: exactDigest(raw.capsuleDigest, code),
    issuedAtMs: timestampMs(raw.issuedAtMs, code),
    expiresAtMs: timestampMs(raw.expiresAtMs, code),
  };
  if (
    receipt.version
      !== SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_VERSION
    || receipt.expiresAtMs <= receipt.issuedAtMs
    || receipt.expiresAtMs - receipt.issuedAtMs
      > SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_TTL_MS
  ) {
    fail(code);
  }
  return deepFreeze(receipt);
}

export function
sourceRecallClassifierCapsuleReceiptSignatureBase(value) {
  const receipt = unsignedReceiptValue(value);
  return (
    `${SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_SIGNATURE_DOMAIN}\0`
    + JSON.stringify(receipt)
  );
}

function canonicalEd25519Signature(value, code) {
  if (
    typeof value !== "string"
    || !ED25519_SIGNATURE.test(value)
  ) {
    fail(code);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    fail(code);
  }
  if (
    bytes.length !== 64
    || bytes.toString("base64url") !== value
  ) {
    fail(code);
  }
  return value;
}

function normalizedReceipt(
  value,
  {
    request,
    response,
    capsule,
    capsuleDigest,
  },
) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_INVALID";
  const raw = plainRecordSnapshot(value, code);
  exactKeys(raw, RECEIPT_KEYS, code);
  const unsigned = unsignedReceiptValue(
    Object.fromEntries(
      UNSIGNED_RECEIPT_KEYS.map(
        (key) => [key, raw[key]],
      ),
    ),
  );
  const receipt = {
    ...unsigned,
    signature: canonicalEd25519Signature(
      raw.signature,
      code,
    ),
  };
  if (
    receipt.reservationId !== response.reservationId
    || receipt.contextDigest !== response.contextDigest
    || receipt.readNumber !== response.readNumber
    || receipt.readNumber !== request.pointReadNumber
    || receipt.requestDigest !== request.requestDigest
    || receipt.pointResponseDigest
      !== capsule.pointResponseDigest
    || receipt.capsuleDigest !== capsuleDigest
    || receipt.issuedAtMs < capsule.classifiedAtMs
  ) {
    fail(code);
  }
  return deepFreeze(receipt);
}

export function sourceRecallClassifierCapsuleReceiptDigest(
  receipt,
) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_INVALID";
  const raw = plainRecordSnapshot(receipt, code);
  exactKeys(raw, RECEIPT_KEYS, code);
  const unsigned = unsignedReceiptValue(
    Object.fromEntries(
      UNSIGNED_RECEIPT_KEYS.map(
        (key) => [key, raw[key]],
      ),
    ),
  );
  const normalized = {
    ...unsigned,
    signature: canonicalEd25519Signature(
      raw.signature,
      code,
    ),
  };
  return digest(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_DIGEST_DOMAIN,
    JSON.stringify(normalized),
  );
}

export function sourceRecallClassifierCapsuleUnsignedReceipt(
  receipt,
) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_INVALID";
  const raw = plainRecordSnapshot(receipt, code);
  exactKeys(raw, RECEIPT_KEYS, code);
  return unsignedReceiptValue(
    Object.fromEntries(
      UNSIGNED_RECEIPT_KEYS.map(
        (key) => [key, raw[key]],
      ),
    ),
  );
}

function normalizedResponse(value, request) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_INVALID";
  const raw = plainRecordSnapshot(value, code);
  exactKeys(raw, RESPONSE_KEYS, code);
  const responseBinding = {
    reservationId: exactDigest(raw.reservationId, code),
    contextDigest: exactDigest(raw.contextDigest, code),
    readNumber: exactReadNumber(raw.readNumber, code),
  };
  if (
    raw.version
      !== SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_VERSION
    || raw.requestDigest !== request.requestDigest
    || responseBinding.readNumber !== request.pointReadNumber
  ) {
    fail(code);
  }
  const capsule = normalizedCapsule(raw.capsule, request);
  const expectedContextDigest =
    sourceRecallClassifierCapsuleContextDigest(
      request,
      Object.fromEntries(
        CLASSIFIER_PIN_KEYS.map(
          (key) => [key, capsule[key]],
        ),
      ),
    );
  const expectedReservationId =
    sourceRecallClassifierCapsuleReservationId(
      request,
      expectedContextDigest,
    );
  if (
    responseBinding.contextDigest !== expectedContextDigest
    || responseBinding.reservationId !== expectedReservationId
  ) {
    fail(code);
  }
  const capsuleDigest = digest(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_DIGEST_DOMAIN,
    JSON.stringify(capsule),
  );
  const response = {
    version:
      SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_VERSION,
    ...responseBinding,
    requestDigest: request.requestDigest,
    capsule,
    receipt: null,
  };
  response.receipt = normalizedReceipt(raw.receipt, {
    request,
    response,
    capsule,
    capsuleDigest,
  });
  return deepFreeze(response);
}

export function parseSourceRecallClassifierCapsuleResponse(
  responseBody,
  request,
) {
  if (
    typeof responseBody !== "string"
    || Buffer.byteLength(responseBody, "utf8")
      > SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_RESPONSE_BYTES
  ) {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_INVALID");
  }
  const normalizedRequest =
    normalizedPreparedRequest(request);
  let value;
  try {
    value = JSON.parse(responseBody);
  } catch {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_INVALID");
  }
  const response = normalizedResponse(
    value,
    normalizedRequest,
  );
  if (JSON.stringify(response) !== responseBody) {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_INVALID");
  }
  return response;
}

export function sourceRecallClassifierCapsuleResponseDigest(
  responseBody,
) {
  if (
    typeof responseBody !== "string"
    || Buffer.byteLength(responseBody, "utf8")
      > SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_RESPONSE_BYTES
  ) {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_INVALID");
  }
  return digest(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_DIGEST_DOMAIN,
    responseBody,
  );
}
