// One-shot bridge from a validated stable Recall point observation to the
// private Calls classifier capsule request.
//
// Callers cannot provide a bot, read, reservation, digest, boundary, limit, or
// force control. The bridge accepts only the complete store snapshot, replays
// the observation store's full validator, issues one request for each distinct
// stable read, and issues an opaque in-process capability whose payload is
// held only in a WeakMap.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_TIMEOUT_MS,
} from "./source-recall-classifier-capsule-client.mjs";
import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_VERSION,
  SOURCE_RECALL_CLASSIFIER_POINT_PROOF_VERSION,
  prepareSourceRecallClassifierCapsuleRequest,
} from "./source-recall-classifier-capsule-protocol.mjs";
import {
  SOURCE_RECALL_POINT_OBSERVATION_READ_MIN_BUDGET_MS,
  recallPointObservationAggregateStatus,
} from "./source-recall-point-observation-store.mjs";

export const SOURCE_RECALL_CLASSIFIER_CAPSULE_CAPABILITY_VERSION =
  "recall-classifier-capsule-capability-v1";
export const
SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_RECEIPT_DIGEST_DOMAIN =
  "phase4-recall-classifier-point-transport-receipt-v1";
export const
SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_EVIDENCE_DIGEST_DOMAIN =
  "phase4-recall-classifier-point-evidence-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_PAIR_SAFETY_MS =
  5_000;
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_PAIR_MIN_BUDGET_MS =
  Math.max(
    SOURCE_RECALL_POINT_OBSERVATION_READ_MIN_BUDGET_MS,
    (2 * SOURCE_RECALL_CLASSIFIER_CAPSULE_TIMEOUT_MS)
      + SOURCE_RECALL_CLASSIFIER_CAPSULE_PAIR_SAFETY_MS,
  );
export const
SOURCE_RECALL_CLASSIFIER_CAPSULE_FINAL_READ_MIN_BUDGET_MS =
  SOURCE_RECALL_CLASSIFIER_CAPSULE_TIMEOUT_MS
    + SOURCE_RECALL_CLASSIFIER_CAPSULE_PAIR_SAFETY_MS;

const SNAPSHOT_KEYS = Object.freeze([
  "raw",
  "rawSha1",
  "record",
  "redisNowMs",
]);
const issuedCapabilities = new WeakMap();

export class SourceRecallClassifierCapsuleCapabilityError
  extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallClassifierCapsuleCapabilityError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallClassifierCapsuleCapabilityError(code);
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

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (
    typeof value === "number"
    && Number.isFinite(value)
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (
    value
    && typeof value === "object"
    && !nodeTypes.isProxy(value)
  ) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  fail(
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_SNAPSHOT_INVALID",
  );
}

function semanticDigest(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
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

function stableSelection(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_STABLE_POINT_REQUIRED";
  const snapshot = plainRecordSnapshot(value, code);
  exactKeys(snapshot, SNAPSHOT_KEYS, code);
  if (
    typeof snapshot.raw !== "string"
    || typeof snapshot.rawSha1 !== "string"
    || !/^[a-f0-9]{40}$/u.test(snapshot.rawSha1)
    || createHash("sha1")
      .update(snapshot.raw, "utf8")
      .digest("hex") !== snapshot.rawSha1
    || !Number.isSafeInteger(snapshot.redisNowMs)
    || snapshot.redisNowMs <= 0
  ) {
    fail(code);
  }
  let aggregate;
  try {
    aggregate = recallPointObservationAggregateStatus(
      value,
    );
  } catch {
    fail(code);
  }
  const record = plainRecordSnapshot(snapshot.record, code);
  if (
    canonicalJson(snapshot.record) !== snapshot.raw
    || aggregate.status !== "stable"
    || aggregate.stable !== 1
    || aggregate.readsCompleted !== 2
    || aggregate.operational !== false
    || aggregate.globalReferenceSetCoverageAvailable !== false
    || aggregate.sourceFactsAvailable !== false
    || aggregate.successClassificationAvailable !== false
    || aggregate.candidateIdentityResolutionAvailable !== false
    || aggregate.pinnable !== false
    || aggregate.authorityAvailable !== false
    || record.status !== "stable"
    || record.readOne === null
    || record.readTwo === null
    || record.resolutionDigest === null
    || record.updatedAtMs !== record.readTwo.completedAtMs
    || snapshot.redisNowMs < record.updatedAtMs
    || snapshot.redisNowMs >= record.expiresAtMs
    || record.expiresAtMs - snapshot.redisNowMs
      < SOURCE_RECALL_CLASSIFIER_CAPSULE_PAIR_MIN_BUDGET_MS
    || canonicalJson(record.readOne.evidence)
      !== canonicalJson(record.readTwo.evidence)
  ) {
    fail(code);
  }
  const firstEvidence = record.readOne.evidence;
  const secondEvidence = record.readTwo.evidence;
  const firstTransportReceipt =
    record.readOne.transportReceipt;
  const secondTransportReceipt =
    record.readTwo.transportReceipt;
  const decisionBoundaryAt =
    new Date(record.decisionBoundaryAtMs).toISOString();
  if (
    firstEvidence.source !== "recall"
    || secondEvidence.source !== "recall"
    || firstEvidence.successClassificationAvailable !== false
    || secondEvidence.successClassificationAvailable !== false
    || firstEvidence.candidateIdentityResolutionAvailable !== false
    || secondEvidence.candidateIdentityResolutionAvailable !== false
    || firstEvidence.pinnable !== false
    || secondEvidence.pinnable !== false
    || firstEvidence.decisionBoundaryDigest
      !== record.firstEvidence.decisionBoundaryDigest
    || secondEvidence.decisionBoundaryDigest
      !== record.firstEvidence.decisionBoundaryDigest
    || firstTransportReceipt.contextDigest
      !== record.contextDigest
    || secondTransportReceipt.contextDigest
      !== record.contextDigest
    || firstTransportReceipt.readNumber !== 1
    || secondTransportReceipt.readNumber !== 2
    || firstTransportReceipt.reservationId
      === secondTransportReceipt.reservationId
    || record.readOne.completedAtMs
      > record.readTwo.completedAtMs
  ) {
    fail(code);
  }
  function requestFor(read, evidence, transportReceipt) {
    return deepFreeze({
      version:
        SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_VERSION,
      pointReservationId: transportReceipt.reservationId,
      pointContextDigest: transportReceipt.contextDigest,
      pointReadNumber: transportReceipt.readNumber,
      pointRequestDigest: transportReceipt.requestDigest,
      decisionBoundaryAt,
      pointProof: {
        version:
          SOURCE_RECALL_CLASSIFIER_POINT_PROOF_VERSION,
        observationStatus: "stable",
        workKeyDigest: record.workKeyDigest,
        contractPinsDigest: record.contractPinsDigest,
        workItemDigest: record.workItemDigest,
        resolutionDigest: record.resolutionDigest,
        pointCompletedAtMs: read.completedAtMs,
        pointTransportReceiptDigest: semanticDigest(
          SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_RECEIPT_DIGEST_DOMAIN,
          transportReceipt,
        ),
        pointEvidenceDigest: semanticDigest(
          SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_EVIDENCE_DIGEST_DOMAIN,
          evidence,
        ),
        sourceNormalizedInputDigest:
          evidence.sourceNormalizedInputDigest,
        sourceRecordDigest: evidence.sourceRecordDigest,
        sourceRecordRevisionDigest:
          evidence.sourceRecordRevisionDigest,
        sourceReferenceDigest:
          evidence.sourceReferenceDigest,
        sourceProvenanceDigest:
          evidence.sourceProvenanceDigest,
        sourceStatusAtBoundaryDigest:
          evidence.sourceStatusAtBoundaryDigest,
        decisionBoundaryDigest:
          evidence.decisionBoundaryDigest,
      },
    });
  }
  const requestValues = deepFreeze([
    requestFor(
      record.readOne,
      firstEvidence,
      firstTransportReceipt,
    ),
    requestFor(
      record.readTwo,
      secondEvidence,
      secondTransportReceipt,
    ),
  ]);
  let preparedRequests;
  try {
    preparedRequests = requestValues.map(
      (requestValue) =>
        prepareSourceRecallClassifierCapsuleRequest(
          requestValue,
        ),
    );
  } catch {
    fail(code);
  }
  return deepFreeze({
    version:
      SOURCE_RECALL_CLASSIFIER_CAPSULE_CAPABILITY_VERSION,
    requestValues,
    requestDigests: preparedRequests.map(
      (request) => request.requestDigest,
    ),
    pointProofDigests: preparedRequests.map(
      (request) => request.pointProofDigest,
    ),
    pointBindingDigests: preparedRequests.map(
      (request) => request.pointBindingDigest,
    ),
    issuedFromRedisAtMs: snapshot.redisNowMs,
    notAfterMs: record.expiresAtMs,
  });
}

export function issueSourceRecallClassifierCapsuleCapability(
  stablePointSnapshot,
) {
  const selection = stableSelection(stablePointSnapshot);
  const capability = Object.freeze({});
  issuedCapabilities.set(capability, selection);
  return capability;
}

export function consumeSourceRecallClassifierCapsuleCapability(
  capability,
) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_CAPABILITY_INVALID";
  if (
    capability === null
    || typeof capability !== "object"
    || !Object.isFrozen(capability)
    || !issuedCapabilities.has(capability)
  ) {
    fail(code);
  }
  const selection = issuedCapabilities.get(capability);
  issuedCapabilities.delete(capability);
  return selection;
}
