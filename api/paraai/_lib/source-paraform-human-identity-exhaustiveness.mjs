// Hard-dark proof that the complete Paraform Human source universe is exactly
// represented by one durable identity work item per unique candidate user.
//
// This module performs no I/O and exposes no private identifiers. It accepts
// two complete, byte-semantics-stable passes made by the private signed page
// client plus an already-finalized identity observation work index. It proves
// cursor exhaustiveness, full source stability, and exact work-index equality.
//
// It does not collect identity, pin an artifact, activate source authority,
// import the capture coordinator, curate a role, enroll outreach, or write to
// Paraform.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  SOURCE_PARAFORM_HUMAN_PAGE_CLIENT_VERSION,
  SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
  assertPrivateParaformHumanSourcePageResult,
} from "./source-paraform-human-page-client.mjs";
import {
  SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
  SOURCE_IDENTITY_POINT_READ_PROCEDURE,
  validateIdentityObservationRun,
  validateIdentityObservationWork,
} from "./source-identity-artifact-store.mjs";

export const SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_VERSION =
  "paraform-human-identity-exhaustiveness-v1";
export const SOURCE_PARAFORM_HUMAN_IDENTITY_REQUIRED_PASS_COUNT = 2;
export const SOURCE_PARAFORM_HUMAN_IDENTITY_MAX_PAGES = 100_000;

const WORK_ITEM_DIGEST_DOMAIN =
  "phase4-paraform-human-identity-work-item-v1";
const SOURCE_PASS_DIGEST_DOMAIN =
  "phase4-paraform-human-source-pass-v1";
const IDENTITY_UNIVERSE_DIGEST_DOMAIN =
  "phase4-paraform-human-identity-universe-v1";
const IDENTITY_WORK_SET_DIGEST_DOMAIN =
  "phase4-paraform-human-identity-work-set-v1";
const PROOF_DIGEST_DOMAIN =
  "phase4-paraform-human-identity-exhaustiveness-proof-v1";
const CONTRACT_PINS_DIGEST_DOMAIN =
  "phase4-paraform-human-identity-exhaustiveness-contract-pins-v1";
const DIGEST = /^[a-f0-9]{64}$/u;
const INPUT_KEYS = Object.freeze([
  "passes",
  "run",
  "works",
]);
const PASS_KEYS = Object.freeze([
  "passNumber",
  "reads",
]);
const READ_KEYS = Object.freeze([
  "request",
  "page",
]);
const REQUEST_KEYS = Object.freeze([
  "boundaryAt",
  "checkpoint",
]);
const CHECKPOINT_KEYS = Object.freeze([
  "version",
  "boundaryAt",
  "cursor",
]);
const RUN_KEYS = Object.freeze([
  "version",
  "policyVersion",
  "kind",
  "status",
  "runKeyDigest",
  "runNonceDigest",
  "decisionBoundaryAtMs",
  "contractPinsDigest",
  "workKeyDigests",
  "workManifestDigest",
  "workManifestCount",
  "createdAtMs",
  "updatedAtMs",
  "revision",
  "sealedArtifactDigest",
  "sealedHeadRecordDigest",
]);
const WORK_KEYS = Object.freeze([
  "version",
  "policyVersion",
  "kind",
  "status",
  "workKeyDigest",
  "runKeyDigest",
  "runNonceDigest",
  "decisionBoundaryAtMs",
  "contractPinsDigest",
  "workItemDigest",
  "privateWorkReference",
  "createdAtMs",
  "updatedAtMs",
  "revision",
  "activeClaim",
  "readOne",
  "readTwo",
  "resolutionDigest",
  "terminalReason",
]);

export class SourceParaformHumanIdentityExhaustivenessError
  extends Error {
  constructor(
    code =
      "SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_INVALID",
  ) {
    super(code);
    this.name =
      "SourceParaformHumanIdentityExhaustivenessError";
    this.code = code;
  }
}

function fail(
  code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_INVALID",
) {
  throw new SourceParaformHumanIdentityExhaustivenessError(code);
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
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
  fail();
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function sameKeys(actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length
    && left.every((key, index) => key === right[index]);
}

function plainRecordSnapshot(value, expectedKeys) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    fail();
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype
    && prototype !== null
  ) {
    fail();
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!sameKeys(Object.keys(descriptors), expectedKeys)) fail();
  const snapshot = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      !descriptor
      || !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value",
      )
      || descriptor.enumerable !== true
    ) {
      fail();
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function denseArraySnapshot(value) {
  if (
    !Array.isArray(value)
    || nodeTypes.isProxy(value)
    || Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor
    || !Object.prototype.hasOwnProperty.call(
      lengthDescriptor,
      "value",
    )
    || lengthDescriptor.value !== value.length
  ) {
    fail();
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
      fail();
    }
    result.push(descriptor.value);
  }
  if (
    Object.keys(descriptors).length !== result.length + 1
  ) {
    fail();
  }
  return result;
}

function safeJsonSnapshot(value, depth = 0) {
  if (depth > 32) fail();
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (Array.isArray(value)) {
    return denseArraySnapshot(value).map(
      (item) => safeJsonSnapshot(item, depth + 1),
    );
  }
  if (
    !value
    || typeof value !== "object"
    || nodeTypes.isProxy(value)
  ) {
    fail();
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype
    && prototype !== null
  ) {
    fail();
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      fail();
    }
    result[key] = safeJsonSnapshot(
      descriptor.value,
      depth + 1,
    );
  }
  return result;
}

function canonicalTimestamp(value) {
  if (
    typeof value !== "string"
    || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u
      .test(value)
  ) {
    fail();
  }
  const parsed = Date.parse(value);
  if (
    !Number.isSafeInteger(parsed)
    || new Date(parsed).toISOString() !== value
  ) {
    fail();
  }
  return value;
}

function canonicalCheckpoint(value, boundaryAt) {
  if (value === null) return null;
  const checkpoint = plainRecordSnapshot(
    value,
    CHECKPOINT_KEYS,
  );
  if (
    checkpoint.version !== SOURCE_PARAFORM_HUMAN_PAGE_VERSION
    || canonicalTimestamp(checkpoint.boundaryAt) !== boundaryAt
    || !Number.isSafeInteger(checkpoint.cursor)
    || checkpoint.cursor < 1
  ) {
    fail();
  }
  return {
    version: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    boundaryAt,
    cursor: checkpoint.cursor,
  };
}

function canonicalRequest(value) {
  const request = plainRecordSnapshot(value, REQUEST_KEYS);
  const boundaryAt = canonicalTimestamp(request.boundaryAt);
  return {
    boundaryAt,
    checkpoint: canonicalCheckpoint(
      request.checkpoint,
      boundaryAt,
    ),
  };
}

function exactJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function candidateUserId(value) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_WORK_ITEM_INVALID",
    );
  }
  return value;
}

export function paraformHumanIdentityWorkItem(
  rawCandidateUserId,
) {
  const normalizedCandidateUserId = candidateUserId(
    rawCandidateUserId,
  );
  return Object.freeze({
    privateWorkReference: normalizedCandidateUserId,
    workItemDigest: semanticDigest(
      WORK_ITEM_DIGEST_DOMAIN,
      { candidateUserId: normalizedCandidateUserId },
    ),
  });
}

const CONTRACT_PINS = Object.freeze({
  version:
    SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_VERSION,
  privatePageClientVersion:
    SOURCE_PARAFORM_HUMAN_PAGE_CLIENT_VERSION,
  privatePageVersion: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
  identityArtifactStorePolicyVersion:
    SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
  identityPointReadProcedure:
    SOURCE_IDENTITY_POINT_READ_PROCEDURE,
  requiredPassCount:
    SOURCE_PARAFORM_HUMAN_IDENTITY_REQUIRED_PASS_COUNT,
  maximumPageCount:
    SOURCE_PARAFORM_HUMAN_IDENTITY_MAX_PAGES,
  humanPlatform: "PHONE",
  humanRecordingProvider: "TWILIO",
  workItemDigestDomain: WORK_ITEM_DIGEST_DOMAIN,
  sourcePassDigestDomain: SOURCE_PASS_DIGEST_DOMAIN,
  identityUniverseDigestDomain:
    IDENTITY_UNIVERSE_DIGEST_DOMAIN,
  identityWorkSetDigestDomain:
    IDENTITY_WORK_SET_DIGEST_DOMAIN,
  proofDigestDomain: PROOF_DIGEST_DOMAIN,
});

export const
  SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST =
    semanticDigest(CONTRACT_PINS_DIGEST_DOMAIN, CONTRACT_PINS);

function normalizePass(value, expectedPassNumber, issuedPages) {
  const pass = plainRecordSnapshot(value, PASS_KEYS);
  if (pass.passNumber !== expectedPassNumber) fail();
  const reads = denseArraySnapshot(pass.reads);
  if (
    reads.length < 1
    || reads.length > SOURCE_PARAFORM_HUMAN_IDENTITY_MAX_PAGES
  ) {
    fail();
  }
  let boundaryAt = null;
  let expectedCheckpoint = null;
  let priorScheduledAt = null;
  let scannedCount = 0;
  let outsideBoundaryCount = 0;
  let sourceReferenceCount = 0;
  let humanReferenceCount = 0;
  let nonHumanReferenceCount = 0;
  const sourceIds = new Set();
  const candidateUserIds = new Set();
  const digestReads = [];

  for (const [index, rawRead] of reads.entries()) {
    const read = plainRecordSnapshot(rawRead, READ_KEYS);
    const request = canonicalRequest(read.request);
    const page = assertPrivateParaformHumanSourcePageResult(
      read.page,
      read.request,
    );
    if (issuedPages.has(page)) fail();
    issuedPages.add(page);
    if (boundaryAt === null) boundaryAt = request.boundaryAt;
    if (
      request.boundaryAt !== boundaryAt
      || !exactJson(request.checkpoint, expectedCheckpoint)
      || page.boundaryAt !== boundaryAt
      || (
        index < reads.length - 1
          ? page.exhausted
          : !page.exhausted
      )
    ) {
      fail();
    }
    expectedCheckpoint = page.nextCheckpoint;
    scannedCount += page.scanned;
    outsideBoundaryCount += page.outsideBoundary;
    sourceReferenceCount += page.references.length;
    for (const reference of page.references) {
      if (
        sourceIds.has(reference.id)
        || (
          priorScheduledAt !== null
          && reference.scheduledAt > priorScheduledAt
        )
      ) {
        fail();
      }
      sourceIds.add(reference.id);
      priorScheduledAt = reference.scheduledAt;
      if (reference.humanCall) {
        if (
          reference.platform !== "PHONE"
          || reference.recordingProvider !== "TWILIO"
        ) {
          fail();
        }
        const identity = paraformHumanIdentityWorkItem(
          reference.candidateUserId,
        );
        candidateUserIds.add(identity.privateWorkReference);
        humanReferenceCount += 1;
      } else {
        nonHumanReferenceCount += 1;
      }
    }
    digestReads.push({
      request,
      page,
    });
  }
  if (expectedCheckpoint !== null) fail();
  const sortedCandidateUserIds = [...candidateUserIds].sort();
  return Object.freeze({
    boundaryAt,
    pageCount: reads.length,
    scannedCount,
    outsideBoundaryCount,
    sourceReferenceCount,
    humanReferenceCount,
    nonHumanReferenceCount,
    candidateUserIds: Object.freeze(sortedCandidateUserIds),
    sourcePassDigest: semanticDigest(
      SOURCE_PASS_DIGEST_DOMAIN,
      { reads: digestReads },
    ),
    identityUniverseDigest: semanticDigest(
      IDENTITY_UNIVERSE_DIGEST_DOMAIN,
      { candidateUserIds: sortedCandidateUserIds },
    ),
  });
}

function normalizedRun(value) {
  const raw = plainRecordSnapshot(
    safeJsonSnapshot(value),
    RUN_KEYS,
  );
  return validateIdentityObservationRun(raw);
}

function normalizedWorks(value) {
  return denseArraySnapshot(value).map((work) => {
    const raw = plainRecordSnapshot(
      safeJsonSnapshot(work),
      WORK_KEYS,
    );
    return validateIdentityObservationWork(raw);
  });
}

function prove(value) {
  const input = plainRecordSnapshot(value, INPUT_KEYS);
  const passes = denseArraySnapshot(input.passes);
  if (
    passes.length
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_REQUIRED_PASS_COUNT
  ) {
    fail();
  }
  const issuedPages = new WeakSet();
  const first = normalizePass(passes[0], 1, issuedPages);
  const second = normalizePass(passes[1], 2, issuedPages);
  for (const key of [
    "boundaryAt",
    "pageCount",
    "scannedCount",
    "outsideBoundaryCount",
    "sourceReferenceCount",
    "humanReferenceCount",
    "nonHumanReferenceCount",
    "sourcePassDigest",
    "identityUniverseDigest",
  ]) {
    if (first[key] !== second[key]) fail();
  }
  if (
    !exactJson(
      first.candidateUserIds,
      second.candidateUserIds,
    )
  ) {
    fail();
  }

  const run = normalizedRun(input.run);
  const works = normalizedWorks(input.works);
  const boundaryAtMs = Date.parse(first.boundaryAt);
  if (
    !["work_set_complete", "sealed"].includes(run.status)
    || run.decisionBoundaryAtMs !== boundaryAtMs
    || run.contractPinsDigest
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST
    || run.workManifestCount
      !== first.candidateUserIds.length
    || works.length !== first.candidateUserIds.length
  ) {
    fail();
  }

  const workByReference = new Map();
  for (const work of works) {
    const expected = paraformHumanIdentityWorkItem(
      work.privateWorkReference,
    );
    if (
      workByReference.has(work.privateWorkReference)
      || work.runKeyDigest !== run.runKeyDigest
      || work.runNonceDigest !== run.runNonceDigest
      || work.decisionBoundaryAtMs
        !== run.decisionBoundaryAtMs
      || work.contractPinsDigest !== run.contractPinsDigest
      || work.workItemDigest !== expected.workItemDigest
    ) {
      fail();
    }
    workByReference.set(work.privateWorkReference, work);
  }
  for (const identity of first.candidateUserIds) {
    if (!workByReference.has(identity)) fail();
  }
  const workKeyDigests = works
    .map((work) => work.workKeyDigest)
    .sort();
  if (!exactJson(workKeyDigests, run.workKeyDigests)) fail();

  const identityWorkSetDigest = semanticDigest(
    IDENTITY_WORK_SET_DIGEST_DOMAIN,
    {
      workManifestDigest: run.workManifestDigest,
      works: works
        .map((work) => ({
          workItemDigest: work.workItemDigest,
          workKeyDigest: work.workKeyDigest,
        }))
        .sort((left, right) => (
          left.workKeyDigest < right.workKeyDigest
            ? -1
            : left.workKeyDigest > right.workKeyDigest
              ? 1
              : 0
        )),
    },
  );
  const proof = {
    version:
      SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_VERSION,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    privatePageClientVersion:
      SOURCE_PARAFORM_HUMAN_PAGE_CLIENT_VERSION,
    privatePageVersion: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    identityPointReadProcedure:
      SOURCE_IDENTITY_POINT_READ_PROCEDURE,
    boundaryAt: first.boundaryAt,
    contractPinsDigest:
      SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
    passCount:
      SOURCE_PARAFORM_HUMAN_IDENTITY_REQUIRED_PASS_COUNT,
    pageCount: first.pageCount,
    scannedCount: first.scannedCount,
    outsideBoundaryCount: first.outsideBoundaryCount,
    sourceReferenceCount: first.sourceReferenceCount,
    humanReferenceCount: first.humanReferenceCount,
    nonHumanReferenceCount: first.nonHumanReferenceCount,
    uniqueCandidateUserCount:
      first.candidateUserIds.length,
    sourcePassDigest: first.sourcePassDigest,
    identityUniverseDigest: first.identityUniverseDigest,
    workManifestDigest: run.workManifestDigest,
    workManifestCount: run.workManifestCount,
    identityWorkSetDigest,
    stablePassesProven: true,
    cursorExhaustivenessProven: true,
    workIndexEqualityProven: true,
    upstreamExhaustivenessProven: true,
    operational: false,
    pinnable: false,
    identityCollectorPinned: false,
    sourceAuthorityAvailable: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
  };
  return Object.freeze({
    ...proof,
    proofDigest: semanticDigest(PROOF_DIGEST_DOMAIN, proof),
  });
}

export function proveParaformHumanIdentityExhaustiveness(value) {
  try {
    return prove(value);
  } catch {
    fail();
  }
}
