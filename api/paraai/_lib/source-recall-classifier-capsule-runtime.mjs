// Hard-dark composition for a server-selected, two-read signed capsule
// lattice.
//
// The only input is an opaque one-shot capability issued from a fully
// validated stable point snapshot. This runtime has no production importer and
// cannot accept or derive caller-controlled identifiers, limits, retries,
// digests, boundaries, deployment selectors, or force controls.

import { types as nodeTypes } from "node:util";

import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_FINAL_READ_MIN_BUDGET_MS,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_PAIR_MIN_BUDGET_MS,
  consumeSourceRecallClassifierCapsuleCapability,
} from "./source-recall-classifier-capsule-capability.mjs";
import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_VERSION,
  readPrivateRecallClassifierCapsule,
  sourceRecallClassifierCapsuleClientConfigured,
} from "./source-recall-classifier-capsule-client.mjs";
import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_VERIFIER_VERSION,
} from "./source-recall-classifier-capsule-verifier.mjs";

export const SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_VERSION =
  "recall-classifier-capsule-runtime-dark-v1";

const DEPENDENCY_KEYS = Object.freeze([
  "clientConfiguredImpl",
  "nowImpl",
  "readPrivateRecallClassifierCapsuleImpl",
]);
const VERIFIED_RESULT_KEYS = Object.freeze([
  "version",
  "verifiedAtMs",
  "signatureVerified",
  "pinsVerified",
  "keyId",
  "responseDigest",
  "receiptDigest",
  "response",
  "operational",
  "sourceFactsAvailable",
  "successClassificationAvailable",
  "candidateIdentityResolutionAvailable",
  "pinnable",
  "authorityAvailable",
]);
const DIGEST = /^[a-f0-9]{64}$/u;
const stableRuntimeResults = new WeakMap();
const issuedSuccessEvidenceCapabilities = new WeakMap();

export class SourceRecallClassifierCapsuleRuntimeError
  extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallClassifierCapsuleRuntimeError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallClassifierCapsuleRuntimeError(code);
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

function dependencies(value) {
  if (value === undefined) {
    return Object.freeze({
      clientConfiguredImpl:
        sourceRecallClassifierCapsuleClientConfigured,
      evidenceEligible: true,
      nowImpl: () => Date.now(),
      readPrivateRecallClassifierCapsuleImpl:
        readPrivateRecallClassifierCapsule,
    });
  }
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_TEST_DEPENDENCIES_INVALID";
  const raw = plainRecordSnapshot(value, code);
  exactKeys(raw, DEPENDENCY_KEYS, code);
  for (const key of DEPENDENCY_KEYS) {
    if (typeof raw[key] !== "function") fail(code);
  }
  return Object.freeze({
    ...raw,
    evidenceEligible: false,
  });
}

function exactNowMs(value) {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value <= 0
  ) {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_CLOCK_INVALID");
  }
  return value;
}

function verifiedRead(value, selection, index) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_RESULT_INVALID";
  const raw = plainRecordSnapshot(value, code);
  exactKeys(raw, VERIFIED_RESULT_KEYS, code);
  const response = plainRecordSnapshot(raw.response, code);
  const capsule = plainRecordSnapshot(response.capsule, code);
  const receipt = plainRecordSnapshot(response.receipt, code);
  if (
    raw.version
      !== SOURCE_RECALL_CLASSIFIER_CAPSULE_VERIFIER_VERSION
    || raw.signatureVerified !== true
    || raw.pinsVerified !== true
    || raw.operational !== false
    || raw.sourceFactsAvailable !== false
    || raw.successClassificationAvailable !== false
    || raw.candidateIdentityResolutionAvailable !== false
    || raw.pinnable !== false
    || raw.authorityAvailable !== false
    || !Number.isSafeInteger(raw.verifiedAtMs)
    || raw.verifiedAtMs < selection.issuedFromRedisAtMs
    || raw.verifiedAtMs >= selection.notAfterMs
    || typeof raw.keyId !== "string"
    || !DIGEST.test(raw.keyId)
    || typeof raw.responseDigest !== "string"
    || !DIGEST.test(raw.responseDigest)
    || typeof raw.receiptDigest !== "string"
    || !DIGEST.test(raw.receiptDigest)
    || response.requestDigest
      !== selection.requestDigests[index]
    || capsule.pointProofDigest
      !== selection.pointProofDigests[index]
    || capsule.pointBindingDigest
      !== selection.pointBindingDigests[index]
    || response.readNumber !== index + 1
    || receipt.readNumber !== index + 1
    || receipt.keyId !== raw.keyId
  ) {
    fail(code);
  }
  return deepFreeze({ ...raw });
}

function stablePointProofPair(selection) {
  const firstRequest = selection.requestValues[0];
  const secondRequest = selection.requestValues[1];
  const firstProof = firstRequest?.pointProof;
  const secondProof = secondRequest?.pointProof;
  const stableProofFields = [
    "version",
    "observationStatus",
    "workKeyDigest",
    "contractPinsDigest",
    "workItemDigest",
    "resolutionDigest",
    "pointEvidenceDigest",
    "sourceNormalizedInputDigest",
    "sourceRecordDigest",
    "sourceRecordRevisionDigest",
    "sourceReferenceDigest",
    "sourceProvenanceDigest",
    "sourceStatusAtBoundaryDigest",
    "decisionBoundaryDigest",
  ];
  return (
    firstRequest?.pointReadNumber === 1
    && secondRequest?.pointReadNumber === 2
    && firstRequest.decisionBoundaryAt
      === secondRequest.decisionBoundaryAt
    && firstRequest.pointReservationId
      !== secondRequest.pointReservationId
    && firstProof.pointCompletedAtMs
      <= secondProof.pointCompletedAtMs
    && firstProof.pointTransportReceiptDigest
      !== secondProof.pointTransportReceiptDigest
    && stableProofFields.every(
      (key) => firstProof[key] === secondProof[key],
    )
  );
}

function stablePair(first, second, selection) {
  const firstCapsule = first.response.capsule;
  const secondCapsule = second.response.capsule;
  const stableFields = [
    "decisionBoundaryDigest",
    "callEndedAt",
    "callEndedAtBasis",
    "callEndedAtDigest",
    "classifierArtifactDigest",
    "classifierDeploymentDigest",
    "classifierRuntimeConfigDigest",
    "classifierPolicyDigest",
    "transcriptEvidenceDigest",
    "presenceEvidenceDigest",
    "vapiEvidenceDigest",
    "mediaEvidenceDigest",
    "vapiAssociationStatus",
    "callsVerdict",
    "classification",
    "classificationBasis",
    "classifierOutputDigest",
  ];
  return (
    stablePointProofPair(selection)
    && first.keyId === second.keyId
    && first.response.reservationId
      !== second.response.reservationId
    && first.response.readNumber === 1
    && second.response.readNumber === 2
    && firstCapsule.classifierInputDigest
      !== secondCapsule.classifierInputDigest
    && stableFields.every(
      (key) => firstCapsule[key] === secondCapsule[key],
    )
  );
}

function pairResult(
  first,
  second,
  selection,
  evidenceEligible,
) {
  const isStable = stablePair(first, second, selection);
  const capsule = first.response.capsule;
  const result = deepFreeze({
    version:
      SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_VERSION,
    clientVersion:
      SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_VERSION,
    status: isStable
      ? "verified_stable_signed_capsule_pair_dark"
      : "verified_conflicting_signed_capsule_pair_dark",
    pairStatus: isStable ? "stable" : "conflict",
    verifiedAtMs: Math.max(
      first.verifiedAtMs,
      second.verifiedAtMs,
    ),
    responseDigests: [
      first.responseDigest,
      second.responseDigest,
    ],
    receiptDigests: [
      first.receiptDigest,
      second.receiptDigest,
    ],
    keyId: first.keyId,
    classificationCandidate: isStable
      ? capsule.classification
      : "unavailable",
    classificationBasis: isStable
      ? capsule.classificationBasis
      : null,
    callsVerdict: isStable ? capsule.callsVerdict : null,
    callEndedAt: isStable ? capsule.callEndedAt : null,
    signedResponses: isStable
      ? [first.response, second.response]
      : [],
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
  if (isStable && evidenceEligible) {
    stableRuntimeResults.set(
      result,
      deepFreeze({ first, second, selection }),
    );
  }
  return result;
}

function unresolvedPairResult(
  verifiedReads,
  startedAtMs,
) {
  const successful = verifiedReads.filter(Boolean);
  return deepFreeze({
    version:
      SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_VERSION,
    clientVersion:
      SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_VERSION,
    status: "unresolved_signed_capsule_pair_dark",
    pairStatus: "unresolved",
    verifiedAtMs: successful.length === 0
      ? startedAtMs
      : Math.max(
        ...successful.map((read) => read.verifiedAtMs),
      ),
    responseDigests: verifiedReads.map(
      (read) => read?.responseDigest ?? null,
    ),
    receiptDigests: verifiedReads.map(
      (read) => read?.receiptDigest ?? null,
    ),
    keyId: successful.length === 2
      && successful[0].keyId === successful[1].keyId
      ? successful[0].keyId
      : null,
    classificationCandidate: "unavailable",
    classificationBasis: null,
    callsVerdict: null,
    callEndedAt: null,
    signedResponses: [],
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

export function issueSourceRecallSuccessEvidenceCapability(
  runtimeResult,
) {
  const code =
    "SOURCE_RECALL_SUCCESS_EVIDENCE_RUNTIME_RESULT_INVALID";
  if (
    runtimeResult === null
    || typeof runtimeResult !== "object"
    || nodeTypes.isProxy(runtimeResult)
    || !Object.isFrozen(runtimeResult)
    || !stableRuntimeResults.has(runtimeResult)
  ) {
    fail(code);
  }
  const stablePairProvenance =
    stableRuntimeResults.get(runtimeResult);
  stableRuntimeResults.delete(runtimeResult);
  const capability = Object.freeze({});
  issuedSuccessEvidenceCapabilities.set(
    capability,
    stablePairProvenance,
  );
  return capability;
}

export function consumeSourceRecallSuccessEvidenceCapability(
  capability,
) {
  const code =
    "SOURCE_RECALL_SUCCESS_EVIDENCE_CAPABILITY_INVALID";
  if (
    capability === null
    || typeof capability !== "object"
    || nodeTypes.isProxy(capability)
    || !Object.isFrozen(capability)
    || !issuedSuccessEvidenceCapabilities.has(capability)
  ) {
    fail(code);
  }
  const stablePairProvenance =
    issuedSuccessEvidenceCapabilities.get(capability);
  issuedSuccessEvidenceCapabilities.delete(capability);
  return stablePairProvenance;
}

export async function consumeStableRecallClassifierCapsule(
  capability,
  testDependencies,
) {
  const {
    clientConfiguredImpl,
    evidenceEligible,
    nowImpl,
    readPrivateRecallClassifierCapsuleImpl,
  } = dependencies(testDependencies);
  let clientConfigured = false;
  try {
    clientConfigured = clientConfiguredImpl() === true;
  } catch {
    clientConfigured = false;
  }
  if (!clientConfigured) {
    fail(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_NOT_CONFIGURED",
    );
  }
  let selection;
  try {
    selection =
      consumeSourceRecallClassifierCapsuleCapability(
        capability,
      );
  } catch {
    fail(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_CAPABILITY_INVALID",
    );
  }
  const startedAtMs = exactNowMs(nowImpl());
  if (
    startedAtMs < selection.issuedFromRedisAtMs
    || selection.notAfterMs - startedAtMs
      < SOURCE_RECALL_CLASSIFIER_CAPSULE_PAIR_MIN_BUDGET_MS
  ) {
    fail(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_CAPABILITY_EXPIRED",
    );
  }
  const verifiedReads = [];
  for (
    let index = 0;
    index < selection.requestValues.length;
    index += 1
  ) {
    if (index === 1) {
      const finalReadStartedAtMs = exactNowMs(nowImpl());
      if (
        finalReadStartedAtMs < startedAtMs
        || selection.notAfterMs - finalReadStartedAtMs
          < SOURCE_RECALL_CLASSIFIER_CAPSULE_FINAL_READ_MIN_BUDGET_MS
      ) {
        fail(
          "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_CAPABILITY_EXPIRED",
        );
      }
    }
    let verified;
    try {
      verified =
        await readPrivateRecallClassifierCapsuleImpl(
          selection.requestValues[index],
        );
    } catch {
      verifiedReads.push(null);
      continue;
    }
    verifiedReads.push(
      verifiedRead(verified, selection, index),
    );
  }
  if (
    verifiedReads.length !== 2
    || !stablePointProofPair(selection)
  ) {
    fail(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_RESULT_INVALID",
    );
  }
  if (verifiedReads.some((read) => read === null)) {
    return unresolvedPairResult(
      verifiedReads,
      startedAtMs,
    );
  }
  return pairResult(
    verifiedReads[0],
    verifiedReads[1],
    selection,
    evidenceEligible,
  );
}
