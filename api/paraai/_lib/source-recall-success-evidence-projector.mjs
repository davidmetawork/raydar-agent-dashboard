// No-I/O, hard-dark projector for one already verified stable Recall/Calls
// classifier pair.
//
// Its only input is an opaque one-shot capability issued by the classifier
// runtime. The resulting envelope retains the exact source-point and signed
// classifier bindings needed by a future durable manifest while deliberately
// excluding signed bodies, source records, references, identity, and every
// release/write authority.
//
// A separate one-shot projector-to-store handoff starts from that same
// upstream capability and carries private provenance directly. A returned
// evidence envelope, its digest, or any reconstructed clone can never mint
// store provenance.

import { createHash } from "node:crypto";

import {
  consumeSourceRecallSuccessEvidenceCapability,
} from "./source-recall-classifier-capsule-runtime.mjs";

export const SOURCE_RECALL_SUCCESS_EVIDENCE_PROJECTOR_VERSION =
  "recall-success-evidence-projector-dark-v1";
export const SOURCE_RECALL_SUCCESS_EVIDENCE_VERSION =
  "recall-success-evidence-dark-v1";
export const SOURCE_RECALL_SUCCESS_EVIDENCE_DIGEST_DOMAIN =
  "phase4-recall-success-evidence-v1";
export const SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_HANDOFF_VERSION =
  "recall-classified-manifest-evidence-handoff-dark-v1";

const DIGEST = /^[a-f0-9]{64}$/u;
const COMPLETE_CLASSIFICATIONS = new Set([
  "failure",
  "success",
]);
const CLASSIFICATIONS = new Set([
  ...COMPLETE_CLASSIFICATIONS,
  "unavailable",
]);
const SHARED_POINT_PROOF_FIELDS = Object.freeze([
  "contractPinsDigest",
  "decisionBoundaryDigest",
  "observationStatus",
  "pointEvidenceDigest",
  "resolutionDigest",
  "sourceNormalizedInputDigest",
  "sourceProvenanceDigest",
  "sourceRecordDigest",
  "sourceRecordRevisionDigest",
  "sourceReferenceDigest",
  "sourceStatusAtBoundaryDigest",
  "version",
  "workItemDigest",
  "workKeyDigest",
]);
const SHARED_CAPSULE_FIELDS = Object.freeze([
  "callEndedAt",
  "callEndedAtBasis",
  "callEndedAtDigest",
  "callsVerdict",
  "classification",
  "classificationBasis",
  "classifierArtifactDigest",
  "classifierDeploymentDigest",
  "classifierOutputDigest",
  "classifierPolicyDigest",
  "classifierRuntimeConfigDigest",
  "decisionBoundaryDigest",
  "mediaEvidenceDigest",
  "presenceEvidenceDigest",
  "source",
  "transcriptEvidenceDigest",
  "vapiAssociationStatus",
  "vapiEvidenceDigest",
  "version",
]);
const issuedClassifiedManifestEvidenceCapabilities =
  new WeakMap();

export class SourceRecallSuccessEvidenceProjectorError
  extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallSuccessEvidenceProjectorError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallSuccessEvidenceProjectorError(code);
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
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function semanticDigest(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function exactDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
  return value;
}

function exactDigestPair(value, code) {
  if (!Array.isArray(value) || value.length !== 2) {
    fail(code);
  }
  return value.map((item) => exactDigest(item, code));
}

function exactTimestampMs(value, code) {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value <= 0
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
  const timestampMs = Date.parse(value);
  if (
    !Number.isFinite(timestampMs)
    || new Date(timestampMs).toISOString() !== value
  ) {
    fail(code);
  }
  return value;
}

function sharedPairValue(first, second, field, code) {
  if (first[field] !== second[field]) fail(code);
  return first[field];
}

function stableProvenance(value) {
  const code =
    "SOURCE_RECALL_SUCCESS_EVIDENCE_STABLE_PAIR_INVALID";
  if (
    value === null
    || typeof value !== "object"
    || !Object.isFrozen(value)
  ) {
    fail(code);
  }
  const { first, second, selection } = value;
  if (
    first === null
    || typeof first !== "object"
    || second === null
    || typeof second !== "object"
    || selection === null
    || typeof selection !== "object"
    || !Object.isFrozen(first)
    || !Object.isFrozen(second)
    || !Object.isFrozen(selection)
    || !Array.isArray(selection.requestValues)
    || selection.requestValues.length !== 2
  ) {
    fail(code);
  }
  const requests = selection.requestValues;
  const proofs = requests.map((request) => request?.pointProof);
  const capsules = [
    first.response?.capsule,
    second.response?.capsule,
  ];
  if (
    requests.some(
      (request) =>
        request === null
        || typeof request !== "object"
        || !Object.isFrozen(request),
    )
    || proofs.some(
      (proof) =>
        proof === null
        || typeof proof !== "object"
        || !Object.isFrozen(proof),
    )
    || capsules.some(
      (capsule) =>
        capsule === null
        || typeof capsule !== "object"
        || !Object.isFrozen(capsule),
    )
    || requests[0].pointReadNumber !== 1
    || requests[1].pointReadNumber !== 2
    || requests[0].decisionBoundaryAt
      !== requests[1].decisionBoundaryAt
    || first.response.readNumber !== 1
    || second.response.readNumber !== 2
    || first.keyId !== second.keyId
    || capsules[0].classifierInputDigest
      === capsules[1].classifierInputDigest
  ) {
    fail(code);
  }
  for (const field of SHARED_POINT_PROOF_FIELDS) {
    sharedPairValue(proofs[0], proofs[1], field, code);
  }
  for (const field of SHARED_CAPSULE_FIELDS) {
    sharedPairValue(capsules[0], capsules[1], field, code);
  }
  if (
    proofs[0].observationStatus !== "stable"
    || capsules[0].source !== "recall"
    || capsules[0].decisionBoundaryDigest
      !== proofs[0].decisionBoundaryDigest
    || capsules[1].decisionBoundaryDigest
      !== proofs[1].decisionBoundaryDigest
  ) {
    fail(code);
  }
  return { first, second, selection, requests, proofs, capsules };
}

function consumeStablePairCapability(
  capability,
) {
  try {
    return consumeSourceRecallSuccessEvidenceCapability(
      capability,
    );
  } catch {
    fail(
      "SOURCE_RECALL_SUCCESS_EVIDENCE_CAPABILITY_INVALID",
    );
  }
}

function projectStablePair(privatePair) {
  const {
    first,
    second,
    selection,
    requests,
    proofs,
    capsules,
  } = stableProvenance(privatePair);
  const proof = proofs[0];
  const capsule = capsules[0];
  const code =
    "SOURCE_RECALL_SUCCESS_EVIDENCE_STABLE_PAIR_INVALID";
  if (!CLASSIFICATIONS.has(capsule.classification)) {
    fail(code);
  }
  const classificationProofComplete =
    COMPLETE_CLASSIFICATIONS.has(capsule.classification);
  if (
    classificationProofComplete
    && capsule.callEndedAt === null
  ) {
    fail(
      "SOURCE_RECALL_SUCCESS_EVIDENCE_ENDED_AT_REQUIRED",
    );
  }
  const callEndedAt = capsule.callEndedAt === null
    ? null
    : canonicalTimestamp(capsule.callEndedAt, code);
  const unsignedEvidence = {
    version: SOURCE_RECALL_SUCCESS_EVIDENCE_VERSION,
    projectorVersion:
      SOURCE_RECALL_SUCCESS_EVIDENCE_PROJECTOR_VERSION,
    status: classificationProofComplete
      ? "verified_complete_recall_classification_evidence_dark"
      : "verified_unavailable_recall_classification_evidence_dark",
    source: "recall",
    classificationProofComplete,
    decisionBoundaryAt: canonicalTimestamp(
      requests[0].decisionBoundaryAt,
      code,
    ),
    decisionBoundaryDigest:
      exactDigest(proof.decisionBoundaryDigest, code),
    workKeyDigest: exactDigest(proof.workKeyDigest, code),
    contractPinsDigest:
      exactDigest(proof.contractPinsDigest, code),
    workItemDigest:
      exactDigest(proof.workItemDigest, code),
    resolutionDigest:
      exactDigest(proof.resolutionDigest, code),
    pointEvidenceDigest:
      exactDigest(proof.pointEvidenceDigest, code),
    sourceNormalizedInputDigest:
      exactDigest(proof.sourceNormalizedInputDigest, code),
    sourceRecordDigest:
      exactDigest(proof.sourceRecordDigest, code),
    sourceRecordRevisionDigest:
      exactDigest(proof.sourceRecordRevisionDigest, code),
    sourceReferenceDigest:
      exactDigest(proof.sourceReferenceDigest, code),
    sourceProvenanceDigest:
      exactDigest(proof.sourceProvenanceDigest, code),
    sourceStatusAtBoundaryDigest:
      exactDigest(proof.sourceStatusAtBoundaryDigest, code),
    classification: capsule.classification,
    classificationBasis: capsule.classificationBasis,
    callsVerdict: capsule.callsVerdict,
    callEndedAt,
    callEndedAtBasis: capsule.callEndedAtBasis,
    callEndedAtDigest:
      exactDigest(capsule.callEndedAtDigest, code),
    classifierCapsuleVersion: capsule.version,
    classifierArtifactDigest:
      exactDigest(capsule.classifierArtifactDigest, code),
    classifierDeploymentDigest:
      exactDigest(capsule.classifierDeploymentDigest, code),
    classifierRuntimeConfigDigest:
      exactDigest(
        capsule.classifierRuntimeConfigDigest,
        code,
      ),
    classifierPolicyDigest:
      exactDigest(capsule.classifierPolicyDigest, code),
    classifierOutputDigest:
      exactDigest(capsule.classifierOutputDigest, code),
    transcriptEvidenceDigest:
      exactDigest(capsule.transcriptEvidenceDigest, code),
    presenceEvidenceDigest:
      exactDigest(capsule.presenceEvidenceDigest, code),
    vapiEvidenceDigest:
      exactDigest(capsule.vapiEvidenceDigest, code),
    mediaEvidenceDigest:
      exactDigest(capsule.mediaEvidenceDigest, code),
    vapiAssociationStatus: capsule.vapiAssociationStatus,
    keyId: exactDigest(first.keyId, code),
    requestDigests:
      exactDigestPair(selection.requestDigests, code),
    responseDigests: [
      exactDigest(first.responseDigest, code),
      exactDigest(second.responseDigest, code),
    ],
    receiptDigests: [
      exactDigest(first.receiptDigest, code),
      exactDigest(second.receiptDigest, code),
    ],
    pointProofDigests:
      exactDigestPair(selection.pointProofDigests, code),
    pointBindingDigests:
      exactDigestPair(selection.pointBindingDigests, code),
    pointResponseDigests: capsules.map(
      (value) => exactDigest(
        value.pointResponseDigest,
        code,
      ),
    ),
    classifierInputDigests: capsules.map(
      (value) => exactDigest(
        value.classifierInputDigest,
        code,
      ),
    ),
    pointTransportReceiptDigests: proofs.map(
      (value) => exactDigest(
        value.pointTransportReceiptDigest,
        code,
      ),
    ),
    pointCompletedAtMs: proofs.map(
      (value) => exactTimestampMs(
        value.pointCompletedAtMs,
        code,
      ),
    ),
    classifiedAtMs: capsules.map(
      (value) => exactTimestampMs(
        value.classifiedAtMs,
        code,
      ),
    ),
    classifierVerifiedAtMs: [
      exactTimestampMs(first.verifiedAtMs, code),
      exactTimestampMs(second.verifiedAtMs, code),
    ],
    signatureVerifiedAtProjection: true,
    standaloneSignatureReverificationAvailable: false,
    signedResponseRetentionAvailable: false,
    durableAttestationAvailable: false,
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
  const {
    classifierVerifiedAtMs: _classifierVerifiedAtMs,
    ...classificationMaterial
  } = unsignedEvidence;
  return deepFreeze({
    ...unsignedEvidence,
    classificationEvidenceDigest: semanticDigest(
      SOURCE_RECALL_SUCCESS_EVIDENCE_DIGEST_DOMAIN,
      classificationMaterial,
    ),
  });
}

export function projectSourceRecallSuccessEvidence(
  capability,
) {
  return projectStablePair(
    consumeStablePairCapability(capability),
  );
}

export function projectSourceRecallClassifiedManifestEvidenceCapability(
  capability,
) {
  const privatePair =
    consumeStablePairCapability(capability);
  const evidence = projectStablePair(privatePair);
  const code =
    "SOURCE_RECALL_SUCCESS_EVIDENCE_STABLE_PAIR_INVALID";
  const upstreamIssuedFromRedisAtMs = exactTimestampMs(
    privatePair.selection.issuedFromRedisAtMs,
    code,
  );
  const upstreamNotAfterMs = exactTimestampMs(
    privatePair.selection.notAfterMs,
    code,
  );
  if (upstreamIssuedFromRedisAtMs >= upstreamNotAfterMs) {
    fail(code);
  }
  const storeCapability = Object.freeze({});
  issuedClassifiedManifestEvidenceCapabilities.set(
    storeCapability,
    deepFreeze({
      version:
        SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_HANDOFF_VERSION,
      evidence,
      settlementStatus:
        evidence.classificationProofComplete
          ? "terminal"
          : "unsettled",
      signedResponses: [
        privatePair.first.response,
        privatePair.second.response,
      ],
      upstreamIssuedFromRedisAtMs,
      upstreamNotAfterMs,
    }),
  );
  return storeCapability;
}

export function consumeSourceRecallClassifiedManifestEvidenceCapability(
  capability,
) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_CAPABILITY_INVALID";
  if (
    capability === null
    || typeof capability !== "object"
    || !issuedClassifiedManifestEvidenceCapabilities.has(
      capability,
    )
    || !Object.isFrozen(capability)
  ) {
    fail(code);
  }
  const provenance =
    issuedClassifiedManifestEvidenceCapabilities.get(
      capability,
    );
  issuedClassifiedManifestEvidenceCapabilities.delete(
    capability,
  );
  return provenance;
}
