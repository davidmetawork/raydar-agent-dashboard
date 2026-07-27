// Private, hard-dark retention for one verified Recall classification pair.
//
// The only write input is the projector's opaque one-shot capability. The
// store owns the key, exact record, keyed provenance seal, absolute expiry,
// and atomic persistence transition. Its persistence adapter must linearize
// with Redis TIME and can never renew the upstream point-observation deadline.
//
// This is the per-point retention boundary for a future classified manifest.
// It does not claim complete reference coverage, source facts, identity,
// source/Q37 authority, curation, enrollment, outreach, or any candidate-
// facing write.

import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  types as nodeTypes,
} from "node:util";

import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_VERSION,
  sourceRecallClassifierCapsuleReceiptDigest,
  sourceRecallClassifierCapsuleResponseDigest,
} from "./source-recall-classifier-capsule-protocol.mjs";
import {
  createSourceRecallClassifiedEvidencePersistenceAdapter,
  sourceRecallClassifiedEvidencePersistenceConfigured,
} from "./source-recall-classified-evidence-persistence-adapter.mjs";
import {
  SOURCE_RECALL_CLASSIFIED_MANIFEST_SEED_VERSION,
  consumeSourceRecallClassifiedManifestSeedCapability,
} from "./source-recall-point-observation-manifest-store.mjs";
import {
  SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_HANDOFF_VERSION,
  SOURCE_RECALL_SUCCESS_EVIDENCE_DIGEST_DOMAIN,
  SOURCE_RECALL_SUCCESS_EVIDENCE_PROJECTOR_VERSION,
  SOURCE_RECALL_SUCCESS_EVIDENCE_VERSION,
  consumeSourceRecallClassifiedManifestEvidenceCapability,
} from "./source-recall-success-evidence-projector.mjs";

export const SOURCE_RECALL_CLASSIFIED_EVIDENCE_STORE_VERSION =
  "recall-classified-evidence-store-dark-v1";
export const SOURCE_RECALL_CLASSIFIED_EVIDENCE_RECORD_VERSION = 1;
export const SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_VERSION =
  "recall-classified-evidence-hmac-sha256-v1";
export const SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_ENV =
  "PARAAI_SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_SECRET";

const SOURCE = "recall";
const MAX_RAW_BYTES = 256 * 1_024;
const DIGEST = /^[a-f0-9]{64}$/u;
const KEY_PREFIX =
  "paraai:phase4:recall-classified-evidence:v1:work:";
const RECORD_KEYS = Object.freeze([
  "authorityAvailable",
  "candidateFacingWriteAvailable",
  "candidateIdentityResolutionAvailable",
  "classificationEvidenceDigest",
  "curationAvailable",
  "durableAttestationAvailable",
  "durableProvenanceSealAvailable",
  "enrollmentAvailable",
  "evidence",
  "expiresAtMs",
  "globalReferenceSetCoverageAvailable",
  "kind",
  "manifestCompleteProofDigest",
  "manifestIssuedFromRedisAtMs",
  "manifestKeyDigest",
  "manifestMemberSetDigest",
  "manifestNotAfterMs",
  "manifestReferenceManifestDigest",
  "memberPageNumber",
  "memberReferenceDigest",
  "memberReferenceIdDigest",
  "memberReferenceOrdinal",
  "operational",
  "outreachAvailable",
  "pinnable",
  "policyVersion",
  "q37TransitionAvailable",
  "recordSeal",
  "referenceManifestCoverageComplete",
  "sealVersion",
  "settlementStatus",
  "signedResponseRetentionAvailable",
  "signedResponses",
  "source",
  "sourceFactsAvailable",
  "standaloneSignatureReverificationAvailable",
  "successClassificationAvailable",
  "transitionNotAfterMs",
  "upstreamIssuedFromRedisAtMs",
  "upstreamNotAfterMs",
  "version",
  "workItemDigest",
  "workKeyDigest",
]);
const UNSIGNED_RECORD_KEYS = Object.freeze(
  RECORD_KEYS.filter((key) => key !== "recordSeal"),
);
const EVIDENCE_KEYS = Object.freeze([
  "authorityAvailable",
  "callEndedAt",
  "callEndedAtBasis",
  "callEndedAtDigest",
  "callsVerdict",
  "candidateFacingWriteAvailable",
  "candidateIdentityResolutionAvailable",
  "classification",
  "classificationBasis",
  "classificationEvidenceDigest",
  "classificationProofComplete",
  "classifiedAtMs",
  "classifierArtifactDigest",
  "classifierCapsuleVersion",
  "classifierDeploymentDigest",
  "classifierInputDigests",
  "classifierOutputDigest",
  "classifierPolicyDigest",
  "classifierRuntimeConfigDigest",
  "classifierVerifiedAtMs",
  "contractPinsDigest",
  "curationAvailable",
  "decisionBoundaryAt",
  "decisionBoundaryDigest",
  "durableAttestationAvailable",
  "enrollmentAvailable",
  "globalReferenceSetCoverageAvailable",
  "keyId",
  "mediaEvidenceDigest",
  "operational",
  "outreachAvailable",
  "pinnable",
  "pointBindingDigests",
  "pointCompletedAtMs",
  "pointEvidenceDigest",
  "pointProofDigests",
  "pointResponseDigests",
  "pointTransportReceiptDigests",
  "presenceEvidenceDigest",
  "projectorVersion",
  "q37TransitionAvailable",
  "receiptDigests",
  "requestDigests",
  "resolutionDigest",
  "responseDigests",
  "signatureVerifiedAtProjection",
  "signedResponseRetentionAvailable",
  "source",
  "sourceFactsAvailable",
  "sourceNormalizedInputDigest",
  "sourceProvenanceDigest",
  "sourceRecordDigest",
  "sourceRecordRevisionDigest",
  "sourceReferenceDigest",
  "sourceStatusAtBoundaryDigest",
  "standaloneSignatureReverificationAvailable",
  "status",
  "successClassificationAvailable",
  "transcriptEvidenceDigest",
  "vapiAssociationStatus",
  "vapiEvidenceDigest",
  "version",
  "workItemDigest",
  "workKeyDigest",
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
const RECEIPT_KEYS = Object.freeze([
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
  "signature",
]);
const DIGEST_EVIDENCE_FIELDS = Object.freeze([
  "callEndedAtDigest",
  "classificationEvidenceDigest",
  "classifierArtifactDigest",
  "classifierDeploymentDigest",
  "classifierOutputDigest",
  "classifierPolicyDigest",
  "classifierRuntimeConfigDigest",
  "contractPinsDigest",
  "decisionBoundaryDigest",
  "keyId",
  "mediaEvidenceDigest",
  "pointEvidenceDigest",
  "presenceEvidenceDigest",
  "resolutionDigest",
  "sourceNormalizedInputDigest",
  "sourceProvenanceDigest",
  "sourceRecordDigest",
  "sourceRecordRevisionDigest",
  "sourceReferenceDigest",
  "sourceStatusAtBoundaryDigest",
  "transcriptEvidenceDigest",
  "vapiEvidenceDigest",
  "workItemDigest",
  "workKeyDigest",
]);
const DIGEST_PAIR_EVIDENCE_FIELDS = Object.freeze([
  "classifierInputDigests",
  "pointBindingDigests",
  "pointProofDigests",
  "pointResponseDigests",
  "pointTransportReceiptDigests",
  "receiptDigests",
  "requestDigests",
  "responseDigests",
]);
const FALSE_EVIDENCE_FLAGS = Object.freeze([
  "authorityAvailable",
  "candidateFacingWriteAvailable",
  "candidateIdentityResolutionAvailable",
  "curationAvailable",
  "durableAttestationAvailable",
  "enrollmentAvailable",
  "globalReferenceSetCoverageAvailable",
  "operational",
  "outreachAvailable",
  "pinnable",
  "q37TransitionAvailable",
  "signedResponseRetentionAvailable",
  "sourceFactsAvailable",
  "standaloneSignatureReverificationAvailable",
  "successClassificationAvailable",
]);
const FACTORY_KEYS = Object.freeze([
  "persistence",
  "sealSecret",
]);
const PERSISTENCE_METHODS = Object.freeze(["retain"]);
const MANIFEST_SEED_KEYS = Object.freeze([
  "completeProofDigest",
  "contractPinsDigest",
  "decisionBoundaryAtMs",
  "headPageSetDigest",
  "indexedManifestDigest",
  "issuedFromRedisAtMs",
  "manifestKeyDigest",
  "memberSetDigest",
  "members",
  "notAfterMs",
  "pageCount",
  "recallReferenceHeadEpochDigest",
  "recallReferenceHeadRecordDigest",
  "recallReferenceHeadRevisionDigest",
  "referenceCount",
  "referenceManifestDigest",
  "scannedCount",
  "settledReadsCompleted",
  "stablePassSemanticDigest",
  "version",
  "workKeyDigest",
]);
const MANIFEST_MEMBER_KEYS = Object.freeze([
  "outcome",
  "pageNumber",
  "readsCompleted",
  "referenceDigest",
  "referenceIdDigest",
  "referenceOrdinal",
  "resolutionDigest",
  "workItemDigest",
  "workKeyDigest",
]);

export class SourceRecallClassifiedEvidenceStoreError
  extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallClassifiedEvidenceStoreError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallClassifiedEvidenceStoreError(code);
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

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
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
  fail("SOURCE_RECALL_CLASSIFIED_EVIDENCE_RECORD_INVALID");
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

function exactDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
  return value;
}

function exactSafeTimestamp(value, code) {
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

function exactPair(value, item, code) {
  if (
    !Array.isArray(value)
    || value.length !== 2
    || Object.keys(value).length !== 2
  ) {
    fail(code);
  }
  return value.map((entry) => item(entry, code));
}

function semanticDigest(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function sealSecret(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_CONFIGURATION_INVALID";
  if (
    typeof value !== "string"
    || value.includes("\0")
  ) {
    fail(code);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 32 || bytes > 4_096) fail(code);
  return value;
}

export function sourceRecallClassifiedEvidenceStoreConfigured() {
  if (
    !sourceRecallClassifiedEvidencePersistenceConfigured()
  ) {
    return false;
  }
  try {
    sealSecret(
      String(
        process.env[
          SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_ENV
        ] || "",
      ),
    );
    return true;
  } catch {
    return false;
  }
}

function recordSeal(unsignedRecord, secret) {
  return createHmac("sha256", secret)
    .update(
      `${SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_VERSION}\0`,
      "utf8",
    )
    .update(canonicalJson(unsignedRecord), "utf8")
    .digest("hex");
}

function safeSealEqual(actual, expected) {
  if (!DIGEST.test(actual) || !DIGEST.test(expected)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  );
}

function canonicalEvidence(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PROVENANCE_INVALID";
  const evidence = exactRecord(value, EVIDENCE_KEYS, code);
  if (
    evidence.version !== SOURCE_RECALL_SUCCESS_EVIDENCE_VERSION
    || evidence.projectorVersion
      !== SOURCE_RECALL_SUCCESS_EVIDENCE_PROJECTOR_VERSION
    || evidence.source !== SOURCE
    || evidence.signatureVerifiedAtProjection !== true
    || typeof evidence.classificationProofComplete
      !== "boolean"
    || (
      evidence.classificationProofComplete
      !== ["success", "failure"].includes(
        evidence.classification,
      )
    )
    || evidence.status !== (
      evidence.classificationProofComplete
        ? "verified_complete_recall_classification_evidence_dark"
        : "verified_unavailable_recall_classification_evidence_dark"
    )
    || (
      !evidence.classificationProofComplete
      && evidence.classification !== "unavailable"
    )
    || (
      evidence.classificationProofComplete
      && evidence.callEndedAt === null
    )
    || FALSE_EVIDENCE_FLAGS.some(
      (key) => evidence[key] !== false,
    )
  ) {
    fail(code);
  }
  for (const field of DIGEST_EVIDENCE_FIELDS) {
    exactDigest(evidence[field], code);
  }
  for (const field of DIGEST_PAIR_EVIDENCE_FIELDS) {
    exactPair(evidence[field], exactDigest, code);
  }
  exactPair(
    evidence.pointCompletedAtMs,
    exactSafeTimestamp,
    code,
  );
  exactPair(
    evidence.classifiedAtMs,
    exactSafeTimestamp,
    code,
  );
  exactPair(
    evidence.classifierVerifiedAtMs,
    exactSafeTimestamp,
    code,
  );
  if (
    evidence.classifierInputDigests[0]
      === evidence.classifierInputDigests[1]
  ) {
    fail(code);
  }
  const {
    classificationEvidenceDigest,
    classifierVerifiedAtMs: _classifierVerifiedAtMs,
    ...classificationMaterial
  } = evidence;
  if (
    classificationEvidenceDigest !== semanticDigest(
      SOURCE_RECALL_SUCCESS_EVIDENCE_DIGEST_DOMAIN,
      classificationMaterial,
    )
  ) {
    fail(code);
  }
  return deepFreeze({ ...evidence });
}

function canonicalSignedResponse(
  value,
  index,
  evidence,
) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PROVENANCE_INVALID";
  const response = exactRecord(value, RESPONSE_KEYS, code);
  const capsule = exactRecord(
    response.capsule,
    CAPSULE_KEYS,
    code,
  );
  const receipt = exactRecord(
    response.receipt,
    RECEIPT_KEYS,
    code,
  );
  const readNumber = index + 1;
  if (
    response.version
      !== SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_VERSION
    || response.readNumber !== readNumber
    || receipt.version
      !== SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_VERSION
    || receipt.readNumber !== readNumber
    || capsule.version
      !== SOURCE_RECALL_CLASSIFIER_CAPSULE_VERSION
    || capsule.source !== SOURCE
    || response.requestDigest
      !== evidence.requestDigests[index]
    || capsule.pointProofDigest
      !== evidence.pointProofDigests[index]
    || capsule.pointBindingDigest
      !== evidence.pointBindingDigests[index]
    || capsule.pointResponseDigest
      !== evidence.pointResponseDigests[index]
    || capsule.classifierInputDigest
      !== evidence.classifierInputDigests[index]
    || capsule.classifiedAtMs
      !== evidence.classifiedAtMs[index]
    || receipt.keyId !== evidence.keyId
    || receipt.reservationId !== response.reservationId
    || receipt.contextDigest !== response.contextDigest
    || receipt.requestDigest !== response.requestDigest
    || receipt.pointResponseDigest
      !== capsule.pointResponseDigest
    || receipt.issuedAtMs < capsule.classifiedAtMs
  ) {
    fail(code);
  }
  for (const [capsuleField, evidenceField] of [
    ["callEndedAt", "callEndedAt"],
    ["callEndedAtBasis", "callEndedAtBasis"],
    ["callEndedAtDigest", "callEndedAtDigest"],
    ["callsVerdict", "callsVerdict"],
    ["classification", "classification"],
    ["classificationBasis", "classificationBasis"],
    ["classifierArtifactDigest", "classifierArtifactDigest"],
    [
      "classifierDeploymentDigest",
      "classifierDeploymentDigest",
    ],
    ["classifierOutputDigest", "classifierOutputDigest"],
    ["classifierPolicyDigest", "classifierPolicyDigest"],
    [
      "classifierRuntimeConfigDigest",
      "classifierRuntimeConfigDigest",
    ],
    ["decisionBoundaryDigest", "decisionBoundaryDigest"],
    ["mediaEvidenceDigest", "mediaEvidenceDigest"],
    ["presenceEvidenceDigest", "presenceEvidenceDigest"],
    ["transcriptEvidenceDigest", "transcriptEvidenceDigest"],
    ["vapiAssociationStatus", "vapiAssociationStatus"],
    ["vapiEvidenceDigest", "vapiEvidenceDigest"],
  ]) {
    if (capsule[capsuleField] !== evidence[evidenceField]) {
      fail(code);
    }
  }
  let responseDigest;
  let receiptDigest;
  const canonicalCapsule = Object.fromEntries(
    CAPSULE_KEYS.map((key) => [key, capsule[key]]),
  );
  const canonicalReceipt = Object.fromEntries(
    RECEIPT_KEYS.map((key) => [key, receipt[key]]),
  );
  const canonicalResponse = Object.fromEntries(
    RESPONSE_KEYS.map((key) => [
      key,
      key === "capsule"
        ? canonicalCapsule
        : key === "receipt"
          ? canonicalReceipt
          : response[key],
    ]),
  );
  try {
    responseDigest =
      sourceRecallClassifierCapsuleResponseDigest(
        JSON.stringify(canonicalResponse),
      );
    receiptDigest =
      sourceRecallClassifierCapsuleReceiptDigest(
        canonicalReceipt,
      );
  } catch {
    fail(code);
  }
  if (
    responseDigest !== evidence.responseDigests[index]
    || receiptDigest !== evidence.receiptDigests[index]
  ) {
    fail(code);
  }
  return deepFreeze(canonicalResponse);
}

function canonicalManifestSeed(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_INVALID";
  const seed = exactRecord(
    value,
    MANIFEST_SEED_KEYS,
    code,
  );
  if (
    seed.version
      !== SOURCE_RECALL_CLASSIFIED_MANIFEST_SEED_VERSION
  ) {
    fail(code);
  }
  const issuedFromRedisAtMs = exactSafeTimestamp(
    seed.issuedFromRedisAtMs,
    code,
  );
  const notAfterMs = exactSafeTimestamp(
    seed.notAfterMs,
    code,
  );
  if (issuedFromRedisAtMs >= notAfterMs) fail(code);
  for (const field of [
    "completeProofDigest",
    "contractPinsDigest",
    "headPageSetDigest",
    "indexedManifestDigest",
    "manifestKeyDigest",
    "memberSetDigest",
    "recallReferenceHeadEpochDigest",
    "recallReferenceHeadRecordDigest",
    "recallReferenceHeadRevisionDigest",
    "referenceManifestDigest",
    "stablePassSemanticDigest",
    "workKeyDigest",
  ]) {
    exactDigest(seed[field], code);
  }
  const pageCount = exactSafeTimestamp(
    seed.pageCount,
    code,
  );
  const scannedCount = exactNonnegativeInteger(
    seed.scannedCount,
    code,
  );
  const referenceCount = exactNonnegativeInteger(
    seed.referenceCount,
    code,
  );
  const settledReadsCompleted = exactNonnegativeInteger(
    seed.settledReadsCompleted,
    code,
  );
  exactSafeTimestamp(seed.decisionBoundaryAtMs, code);
  if (
    !Array.isArray(seed.members)
    || seed.members.length !== referenceCount
    || Object.keys(seed.members).length !== referenceCount
    || settledReadsCompleted !== referenceCount * 2
  ) {
    fail(code);
  }
  const workKeys = new Set();
  const referenceIds = new Set();
  const members = seed.members.map((value, index) => {
    const member = exactRecord(
      value,
      MANIFEST_MEMBER_KEYS,
      code,
    );
    for (const field of [
      "referenceDigest",
      "referenceIdDigest",
      "resolutionDigest",
      "workItemDigest",
      "workKeyDigest",
    ]) {
      exactDigest(member[field], code);
    }
    const pageNumber = exactSafeTimestamp(
      member.pageNumber,
      code,
    );
    const referenceOrdinal = exactNonnegativeInteger(
      member.referenceOrdinal,
      code,
    );
    if (
      pageNumber > pageCount
      || member.outcome !== "stable"
      || member.readsCompleted !== 2
      || workKeys.has(member.workKeyDigest)
      || referenceIds.has(member.referenceIdDigest)
      || (
        index > 0
        && (
          pageNumber
            < seed.members[index - 1].pageNumber
          || (
            pageNumber
              === seed.members[index - 1].pageNumber
            && referenceOrdinal
              !== seed.members[index - 1]
                .referenceOrdinal + 1
          )
        )
      )
      || (
        index === 0
        && referenceOrdinal !== 0
      )
      || (
        index > 0
        && pageNumber
          > seed.members[index - 1].pageNumber
        && referenceOrdinal !== 0
      )
    ) {
      fail(code);
    }
    workKeys.add(member.workKeyDigest);
    referenceIds.add(member.referenceIdDigest);
    return deepFreeze({ ...member });
  });
  if (
    semanticDigest(
      "phase4-recall-classified-manifest-members-v1",
      members,
    ) !== seed.memberSetDigest
  ) {
    fail(code);
  }
  return deepFreeze({
    ...seed,
    members,
  });
}

function canonicalProvenance(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PROVENANCE_INVALID";
  const provenance = exactRecord(
    value,
    [
      "evidence",
      "settlementStatus",
      "signedResponses",
      "upstreamIssuedFromRedisAtMs",
      "upstreamNotAfterMs",
      "version",
    ],
    code,
  );
  if (
    provenance.version
      !== SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_HANDOFF_VERSION
  ) {
    fail(code);
  }
  const evidence = canonicalEvidence(provenance.evidence);
  const settlementStatus =
    evidence.classificationProofComplete
      ? "terminal"
      : "unsettled";
  if (provenance.settlementStatus !== settlementStatus) {
    fail(code);
  }
  if (
    !Array.isArray(provenance.signedResponses)
    || provenance.signedResponses.length !== 2
    || Object.keys(provenance.signedResponses).length !== 2
  ) {
    fail(code);
  }
  const signedResponses =
    provenance.signedResponses.map(
      (response, index) =>
        canonicalSignedResponse(
          response,
          index,
          evidence,
        ),
    );
  const upstreamIssuedFromRedisAtMs =
    exactSafeTimestamp(
      provenance.upstreamIssuedFromRedisAtMs,
      code,
    );
  const upstreamNotAfterMs = exactSafeTimestamp(
    provenance.upstreamNotAfterMs,
    code,
  );
  if (
    upstreamIssuedFromRedisAtMs >= upstreamNotAfterMs
    || evidence.classifierVerifiedAtMs.some(
      (timestamp) =>
        timestamp < upstreamIssuedFromRedisAtMs
        || timestamp >= upstreamNotAfterMs,
    )
  ) {
    fail(code);
  }
  return deepFreeze({
    version: provenance.version,
    evidence,
    settlementStatus,
    signedResponses,
    upstreamIssuedFromRedisAtMs,
    upstreamNotAfterMs,
  });
}

function persistenceInterface(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_INVALID";
  const persistence = exactRecord(
    value,
    PERSISTENCE_METHODS,
    code,
  );
  for (const method of PERSISTENCE_METHODS) {
    if (typeof persistence[method] !== "function") {
      fail(code);
    }
  }
  return Object.freeze(persistence);
}

function retentionKey(manifestKeyDigest, workKeyDigest) {
  return `${KEY_PREFIX}${semanticDigest(
    "phase4-recall-classified-evidence-work-v1",
    {
      policyVersion:
        SOURCE_RECALL_CLASSIFIED_EVIDENCE_STORE_VERSION,
      manifestKeyDigest,
      workKeyDigest,
    },
  )}`;
}

function manifestMemberFor(seed, evidence) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_MEMBERSHIP_MISMATCH";
  if (
    seed.contractPinsDigest !== evidence.contractPinsDigest
    || new Date(seed.decisionBoundaryAtMs).toISOString()
      !== evidence.decisionBoundaryAt
  ) {
    fail(code);
  }
  const selected = seed.members.filter(
    (member) =>
      member.workKeyDigest === evidence.workKeyDigest,
  );
  if (
    selected.length !== 1
    || selected[0].workItemDigest
      !== evidence.workItemDigest
    || selected[0].resolutionDigest
      !== evidence.resolutionDigest
    || selected[0].outcome !== "stable"
    || selected[0].readsCompleted !== 2
  ) {
    fail(code);
  }
  return selected[0];
}

function unsignedRecord(seed, member, provenance) {
  const { evidence } = provenance;
  return {
    version:
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_RECORD_VERSION,
    policyVersion:
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_STORE_VERSION,
    kind: "recall_classified_evidence_dark",
    source: SOURCE,
    settlementStatus: provenance.settlementStatus,
    workKeyDigest: evidence.workKeyDigest,
    workItemDigest: evidence.workItemDigest,
    classificationEvidenceDigest:
      evidence.classificationEvidenceDigest,
    manifestKeyDigest: seed.manifestKeyDigest,
    manifestCompleteProofDigest:
      seed.completeProofDigest,
    manifestMemberSetDigest: seed.memberSetDigest,
    manifestReferenceManifestDigest:
      seed.referenceManifestDigest,
    manifestIssuedFromRedisAtMs:
      seed.issuedFromRedisAtMs,
    manifestNotAfterMs: seed.notAfterMs,
    memberPageNumber: member.pageNumber,
    memberReferenceOrdinal: member.referenceOrdinal,
    memberReferenceDigest: member.referenceDigest,
    memberReferenceIdDigest: member.referenceIdDigest,
    evidence,
    signedResponses: provenance.signedResponses,
    upstreamIssuedFromRedisAtMs:
      provenance.upstreamIssuedFromRedisAtMs,
    upstreamNotAfterMs: provenance.upstreamNotAfterMs,
    transitionNotAfterMs: Math.min(
      seed.notAfterMs,
      provenance.upstreamNotAfterMs,
      ...provenance.signedResponses.map(
        (response) => response.receipt.expiresAtMs,
      ),
    ),
    expiresAtMs: Math.min(
      seed.notAfterMs,
      provenance.upstreamNotAfterMs,
    ),
    sealVersion:
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_VERSION,
    signedResponseRetentionAvailable: true,
    durableProvenanceSealAvailable: true,
    standaloneSignatureReverificationAvailable: false,
    durableAttestationAvailable: false,
    referenceManifestCoverageComplete: false,
    operational: false,
    globalReferenceSetCoverageAvailable: false,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    q37TransitionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
    curationAvailable: false,
    enrollmentAvailable: false,
    outreachAvailable: false,
    candidateFacingWriteAvailable: false,
  };
}

function proposedRecord(seed, member, provenance, secret) {
  const unsigned = unsignedRecord(
    seed,
    member,
    provenance,
  );
  return deepFreeze({
    ...unsigned,
    recordSeal: recordSeal(unsigned, secret),
  });
}

function canonicalRecord(value, secret) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_RECORD_INVALID";
  const record = exactRecord(value, RECORD_KEYS, code);
  const unsigned = Object.fromEntries(
    UNSIGNED_RECORD_KEYS.map(
      (key) => [key, record[key]],
    ),
  );
  if (
    record.version
      !== SOURCE_RECALL_CLASSIFIED_EVIDENCE_RECORD_VERSION
    || record.policyVersion
      !== SOURCE_RECALL_CLASSIFIED_EVIDENCE_STORE_VERSION
    || record.kind !== "recall_classified_evidence_dark"
    || record.source !== SOURCE
    || record.sealVersion
      !== SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_VERSION
    || record.signedResponseRetentionAvailable !== true
    || record.durableProvenanceSealAvailable !== true
    || record.standaloneSignatureReverificationAvailable
      !== false
    || record.durableAttestationAvailable !== false
    || record.referenceManifestCoverageComplete !== false
    || [
      "operational",
      "globalReferenceSetCoverageAvailable",
      "sourceFactsAvailable",
      "successClassificationAvailable",
      "candidateIdentityResolutionAvailable",
      "q37TransitionAvailable",
      "pinnable",
      "authorityAvailable",
      "curationAvailable",
      "enrollmentAvailable",
      "outreachAvailable",
      "candidateFacingWriteAvailable",
    ].some((key) => record[key] !== false)
    || !safeSealEqual(
      record.recordSeal,
      recordSeal(unsigned, secret),
    )
  ) {
    fail(code);
  }
  for (const field of [
    "classificationEvidenceDigest",
    "manifestCompleteProofDigest",
    "manifestKeyDigest",
    "manifestMemberSetDigest",
    "manifestReferenceManifestDigest",
    "memberReferenceDigest",
    "memberReferenceIdDigest",
    "workItemDigest",
    "workKeyDigest",
  ]) {
    exactDigest(record[field], code);
  }
  const manifestIssuedFromRedisAtMs =
    exactSafeTimestamp(
      record.manifestIssuedFromRedisAtMs,
      code,
    );
  const manifestNotAfterMs = exactSafeTimestamp(
    record.manifestNotAfterMs,
    code,
  );
  const upstreamIssuedFromRedisAtMs =
    exactSafeTimestamp(
      record.upstreamIssuedFromRedisAtMs,
      code,
    );
  const upstreamNotAfterMs = exactSafeTimestamp(
    record.upstreamNotAfterMs,
    code,
  );
  const transitionNotAfterMs = exactSafeTimestamp(
    record.transitionNotAfterMs,
    code,
  );
  exactSafeTimestamp(record.memberPageNumber, code);
  exactNonnegativeInteger(
    record.memberReferenceOrdinal,
    code,
  );
  if (
    manifestIssuedFromRedisAtMs >= manifestNotAfterMs
    || upstreamIssuedFromRedisAtMs >= upstreamNotAfterMs
    || record.expiresAtMs !== Math.min(
      manifestNotAfterMs,
      upstreamNotAfterMs,
    )
    || transitionNotAfterMs > record.expiresAtMs
  ) {
    fail(code);
  }
  const provenance = canonicalProvenance({
    version:
      SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_HANDOFF_VERSION,
    evidence: record.evidence,
    settlementStatus: record.settlementStatus,
    signedResponses: record.signedResponses,
    upstreamIssuedFromRedisAtMs:
      record.upstreamIssuedFromRedisAtMs,
    upstreamNotAfterMs: record.upstreamNotAfterMs,
  });
  if (
    record.workKeyDigest
      !== provenance.evidence.workKeyDigest
    || record.workItemDigest
      !== provenance.evidence.workItemDigest
    || record.classificationEvidenceDigest
      !== provenance.evidence.classificationEvidenceDigest
    || record.transitionNotAfterMs !== Math.min(
      record.manifestNotAfterMs,
      record.upstreamNotAfterMs,
      ...provenance.signedResponses.map(
        (response) => response.receipt.expiresAtMs,
      ),
    )
  ) {
    fail(code);
  }
  return deepFreeze({
    ...record,
    evidence: provenance.evidence,
    signedResponses: provenance.signedResponses,
  });
}

function persistenceResult(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID";
  const result = exactRecord(
    value,
    [
      "expiresAtMs",
      "raw",
      "redisNowMs",
      "status",
    ],
    code,
  );
  if (
    !["created", "existing", "expired"].includes(
      result.status,
    )
    || !(
      typeof result.raw === "string"
      || result.raw === null
    )
    || !Number.isSafeInteger(result.redisNowMs)
    || result.redisNowMs <= 0
    || !Number.isSafeInteger(result.expiresAtMs)
    || (
      result.status === "expired"
      && (
        result.raw !== null
        || result.expiresAtMs !== -2
      )
    )
    || (
      result.status !== "expired"
      && (
        typeof result.raw !== "string"
        || result.expiresAtMs <= 0
      )
    )
  ) {
    fail(code);
  }
  return result;
}

function parseRecord(
  raw,
  redisNowMs,
  expiresAtMs,
  secret,
) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_RECORD_INVALID";
  if (
    typeof raw !== "string"
    || raw.length === 0
    || Buffer.byteLength(raw, "utf8") > MAX_RAW_BYTES
  ) {
    fail(code);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(code);
  }
  const record = canonicalRecord(parsed, secret);
  if (
    canonicalJson(record) !== raw
    || expiresAtMs !== record.expiresAtMs
    || redisNowMs < record.upstreamIssuedFromRedisAtMs
    || redisNowMs < record.manifestIssuedFromRedisAtMs
    || redisNowMs
      < Math.max(...record.evidence.classifierVerifiedAtMs)
    || redisNowMs >= record.expiresAtMs
  ) {
    fail(code);
  }
  return record;
}

function semanticallySameRecord(first, second) {
  const withoutVerifierClock = (record) => {
    const {
      manifestIssuedFromRedisAtMs:
        _manifestIssuedFromRedisAtMs,
      recordSeal: _recordSeal,
      ...retained
    } = record;
    const {
      classifierVerifiedAtMs: _classifierVerifiedAtMs,
      ...evidence
    } = retained.evidence;
    return {
      ...retained,
      evidence,
    };
  };
  return (
    canonicalJson(withoutVerifierClock(first))
      === canonicalJson(withoutVerifierClock(second))
  );
}

function aggregateFor(record, result) {
  return deepFreeze({
    status: record.settlementStatus === "terminal"
      ? "retained_terminal_dark"
      : "retained_unsettled_dark",
    created: result.status === "created",
    classification: record.evidence.classification,
    classificationProofComplete:
      record.evidence.classificationProofComplete,
    classificationEvidenceDigest:
      record.classificationEvidenceDigest,
    workKeyDigest: record.workKeyDigest,
    retainedAtRedisMs: result.redisNowMs,
    expiresAtMs: record.expiresAtMs,
    signedResponseRetentionAvailable: true,
    durableProvenanceSealAvailable: true,
    standaloneSignatureReverificationAvailable: false,
    durableAttestationAvailable: false,
    referenceManifestCoverageComplete: false,
    operational: false,
    globalReferenceSetCoverageAvailable: false,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    q37TransitionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
    curationAvailable: false,
    enrollmentAvailable: false,
    outreachAvailable: false,
    candidateFacingWriteAvailable: false,
  });
}

export function createSourceRecallClassifiedEvidenceStore(
  options,
) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_STORE_OPTIONS_INVALID";
  const selected = exactRecord(options, FACTORY_KEYS, code);
  const persistence = persistenceInterface(
    selected.persistence,
  );
  const secret = sealSecret(selected.sealSecret);

  async function retainSourceRecallClassifiedEvidence(
    manifestCapability,
    evidenceCapability,
  ) {
    let consumedManifest;
    let consumedEvidence;
    let manifestInvalid = false;
    let evidenceInvalid = false;
    try {
      consumedManifest =
        consumeSourceRecallClassifiedManifestSeedCapability(
          manifestCapability,
        );
    } catch {
      manifestInvalid = true;
    }
    try {
      consumedEvidence =
        consumeSourceRecallClassifiedManifestEvidenceCapability(
          evidenceCapability,
        );
    } catch {
      evidenceInvalid = true;
    }
    if (manifestInvalid || evidenceInvalid) {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_CAPABILITY_INVALID",
      );
    }
    const seed = canonicalManifestSeed(consumedManifest);
    const provenance = canonicalProvenance(
      consumedEvidence,
    );
    const member = manifestMemberFor(
      seed,
      provenance.evidence,
    );
    const proposed = proposedRecord(
      seed,
      member,
      provenance,
      secret,
    );
    const proposedRaw = canonicalJson(proposed);
    if (
      Buffer.byteLength(proposedRaw, "utf8")
        > MAX_RAW_BYTES
    ) {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_RECORD_TOO_LARGE",
      );
    }
    let result;
    try {
      result = persistenceResult(
        await persistence.retain({
          key: retentionKey(
            proposed.manifestKeyDigest,
            proposed.workKeyDigest,
          ),
          proposedRaw,
          expiresAtMs: proposed.expiresAtMs,
          issuedAtMs: Math.max(
            proposed.manifestIssuedFromRedisAtMs,
            proposed.upstreamIssuedFromRedisAtMs,
            ...proposed.evidence.classifierVerifiedAtMs,
          ),
          notAfterMs: proposed.transitionNotAfterMs,
        }),
      );
    } catch (error) {
      if (
        error instanceof SourceRecallClassifiedEvidenceStoreError
      ) {
        throw error;
      }
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_FAILED",
      );
    }
    if (
      result.status === "expired"
      || result.redisNowMs
        < proposed.upstreamIssuedFromRedisAtMs
      || result.redisNowMs
        < proposed.manifestIssuedFromRedisAtMs
      || result.redisNowMs
        < Math.max(
          ...proposed.evidence.classifierVerifiedAtMs,
        )
      || result.redisNowMs
        >= proposed.transitionNotAfterMs
    ) {
      fail("SOURCE_RECALL_CLASSIFIED_EVIDENCE_EXPIRED");
    }
    if (
      result.expiresAtMs !== proposed.expiresAtMs
      || result.raw === null
    ) {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
      );
    }
    const retained = parseRecord(
      result.raw,
      result.redisNowMs,
      result.expiresAtMs,
      secret,
    );
    if (
      result.status === "created"
        ? result.raw !== proposedRaw
        : !semanticallySameRecord(retained, proposed)
    ) {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_BINDING_MISMATCH",
      );
    }
    return aggregateFor(retained, result);
  }

  return Object.freeze({
    retainSourceRecallClassifiedEvidence,
  });
}

let defaultStore = null;

function productionStore() {
  if (defaultStore === null) {
    defaultStore = createSourceRecallClassifiedEvidenceStore({
      persistence:
        createSourceRecallClassifiedEvidencePersistenceAdapter(),
      sealSecret: String(
        process.env[
          SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_ENV
        ] || "",
      ),
    });
  }
  return defaultStore;
}

export function retainSourceRecallClassifiedEvidence(
  manifestCapability,
  evidenceCapability,
) {
  return productionStore()
    .retainSourceRecallClassifiedEvidence(
      manifestCapability,
      evidenceCapability,
    );
}
