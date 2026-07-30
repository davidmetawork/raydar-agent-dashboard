// Private hard-dark orchestration for Paraform Human identity exhaustiveness.
//
// The only input is a server-owned run context: one common decision boundary
// and one opaque run nonce digest. Pass one derives the complete candidate-user
// work universe. The existing identity store idempotently owns and finalizes
// that exact work index. Pass two must be fully stable, the pure proof must
// establish exact equality, and only then can the immutable digest-only proof
// store retain the result.
//
// This module has no route, worker, scheduler, coordinator import, pin,
// activation, source authority, curation, enrollment, or vendor write path.

import { types as nodeTypes } from "node:util";

import {
  createIdentityObservationWork,
  ensureIdentityObservationRun,
  finalizeIdentityObservationWorkSet,
  readIdentityObservationWork,
  validateIdentityObservationRun,
  validateIdentityObservationWork,
} from "./source-identity-artifact-store.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
  SOURCE_PARAFORM_HUMAN_IDENTITY_MAX_PAGES,
  paraformHumanIdentityWorkItem,
  proveParaformHumanIdentityExhaustiveness,
  validateParaformHumanIdentityExhaustivenessProof,
} from "./source-paraform-human-identity-exhaustiveness.mjs";
import {
  assertPrivateParaformHumanSourcePageResult,
  readPrivateParaformHumanSourcePage,
} from "./source-paraform-human-page-client.mjs";
import {
  retainParaformHumanIdentityExhaustivenessProof,
} from "./source-paraform-human-identity-proof-store.mjs";

export const
  SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_VERSION =
    "paraform-human-identity-proof-runtime-v1";

const DIGEST = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const INPUT_KEYS = Object.freeze([
  "boundaryAt",
  "runNonceDigest",
]);
const DEPENDENCY_KEYS = Object.freeze([
  "createIdentityObservationWorkImpl",
  "ensureIdentityObservationRunImpl",
  "finalizeIdentityObservationWorkSetImpl",
  "readIdentityObservationWorkImpl",
  "readPrivateParaformHumanSourcePageImpl",
  "retainProofImpl",
]);
const SNAPSHOT_KEYS = Object.freeze([
  "record",
  "raw",
  "rawSha1",
  "redisNowMs",
]);
const RETENTION_KEYS = Object.freeze([
  "created",
  "duplicate",
  "runKeyDigest",
  "proofDigest",
  "retainedAtMs",
  "recordRevisionSha1",
  "proof",
  "operational",
  "pinnable",
  "sourceAuthorityAvailable",
  "activationAvailable",
  "writeAuthorityAvailable",
]);

export class SourceParaformHumanIdentityProofRuntimeError
  extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceParaformHumanIdentityProofRuntimeError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceParaformHumanIdentityProofRuntimeError(code);
}

function sameKeys(actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length
    && left.every((key, index) => key === right[index]);
}

function plainRecord(value, expectedKeys, code) {
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
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!sameKeys(Object.keys(descriptors), expectedKeys)) {
    fail(code);
  }
  const result = Object.create(null);
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
      fail(code);
    }
    result[key] = descriptor.value;
  }
  return result;
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
    !Number.isSafeInteger(parsed)
    || parsed < 0
    || new Date(parsed).toISOString() !== value
  ) {
    fail(code);
  }
  return value;
}

function digest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
  return value;
}

function normalizedInput(value) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_INPUT_INVALID";
  const input = plainRecord(value, INPUT_KEYS, code);
  const boundaryAt = canonicalTimestamp(
    input.boundaryAt,
    code,
  );
  return Object.freeze({
    boundaryAt,
    decisionBoundaryAtMs: Date.parse(boundaryAt),
    runNonceDigest: digest(input.runNonceDigest, code),
    contractPinsDigest:
      SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
  });
}

function dependencies(value) {
  if (value === undefined) {
    return Object.freeze({
      createIdentityObservationWorkImpl:
        createIdentityObservationWork,
      ensureIdentityObservationRunImpl:
        ensureIdentityObservationRun,
      finalizeIdentityObservationWorkSetImpl:
        finalizeIdentityObservationWorkSet,
      readIdentityObservationWorkImpl:
        readIdentityObservationWork,
      readPrivateParaformHumanSourcePageImpl:
        readPrivateParaformHumanSourcePage,
      retainProofImpl:
        retainParaformHumanIdentityExhaustivenessProof,
    });
  }
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_DEPENDENCIES_INVALID";
  const selected = plainRecord(value, DEPENDENCY_KEYS, code);
  for (const key of DEPENDENCY_KEYS) {
    if (typeof selected[key] !== "function") fail(code);
  }
  return Object.freeze(selected);
}

async function sanitizedCall(operation) {
  try {
    return await operation();
  } catch {
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_FAILED",
    );
  }
}

function snapshotRecord(value, validator) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_FAILED";
  const snapshot = plainRecord(value, SNAPSHOT_KEYS, code);
  try {
    return validator(snapshot.record);
  } catch {
    fail(code);
  }
}

function contextMatches(record, context) {
  return (
    record.runNonceDigest === context.runNonceDigest
    && record.decisionBoundaryAtMs
      === context.decisionBoundaryAtMs
    && record.contractPinsDigest
      === context.contractPinsDigest
  );
}

async function collectPass({
  boundaryAt,
  passNumber,
  readPage,
}) {
  const reads = [];
  const workItems = new Map();
  let checkpoint = null;
  for (
    let pageOrdinal = 0;
    pageOrdinal < SOURCE_PARAFORM_HUMAN_IDENTITY_MAX_PAGES;
    pageOrdinal += 1
  ) {
    const request = Object.freeze({
      boundaryAt,
      checkpoint,
    });
    const page = await sanitizedCall(
      () => readPage(request),
    );
    await sanitizedCall(async () => (
      assertPrivateParaformHumanSourcePageResult(
        page,
        request,
      )
    ));
    reads.push(Object.freeze({
      request,
      page,
    }));
    for (const reference of page.references) {
      if (!reference.humanCall) continue;
      const item = paraformHumanIdentityWorkItem(
        reference.candidateUserId,
      );
      workItems.set(item.privateWorkReference, item);
    }
    if (page.exhausted) {
      return Object.freeze({
        pass: Object.freeze({
          passNumber,
          reads: Object.freeze(reads),
        }),
        workItems: Object.freeze(
          [...workItems.values()].sort(
            (left, right) => (
              left.privateWorkReference
                < right.privateWorkReference
                ? -1
                : left.privateWorkReference
                    > right.privateWorkReference
                  ? 1
                  : 0
            ),
          ),
        ),
      });
    }
    checkpoint = page.nextCheckpoint;
  }
  fail(
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_FAILED",
  );
}

function runContext(context) {
  return Object.freeze({
    runNonceDigest: context.runNonceDigest,
    decisionBoundaryAtMs: context.decisionBoundaryAtMs,
    contractPinsDigest: context.contractPinsDigest,
  });
}

function workInput(context, item) {
  return Object.freeze({
    ...runContext(context),
    workItemDigest: item.workItemDigest,
    privateWorkReference: item.privateWorkReference,
  });
}

function normalizedRetention(value, run, proof) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_FAILED";
  const retention = plainRecord(value, RETENTION_KEYS, code);
  let readbackProof;
  try {
    readbackProof =
      validateParaformHumanIdentityExhaustivenessProof(
        retention.proof,
      );
  } catch {
    fail(code);
  }
  if (
    typeof retention.created !== "boolean"
    || typeof retention.duplicate !== "boolean"
    || retention.created === retention.duplicate
    || retention.runKeyDigest !== run.runKeyDigest
    || retention.proofDigest !== proof.proofDigest
    || readbackProof.proofDigest !== proof.proofDigest
    || !Number.isSafeInteger(retention.retainedAtMs)
    || retention.retainedAtMs < run.decisionBoundaryAtMs
    || typeof retention.recordRevisionSha1 !== "string"
    || !SHA1.test(retention.recordRevisionSha1)
    || retention.operational !== false
    || retention.pinnable !== false
    || retention.sourceAuthorityAvailable !== false
    || retention.activationAvailable !== false
    || retention.writeAuthorityAvailable !== false
  ) {
    fail(code);
  }
  return Object.freeze({
    ...retention,
    proof: readbackProof,
  });
}

async function run(value, testDependencies) {
  const context = normalizedInput(value);
  const selected = dependencies(testDependencies);
  const first = await collectPass({
    boundaryAt: context.boundaryAt,
    passNumber: 1,
    readPage:
      selected.readPrivateParaformHumanSourcePageImpl,
  });
  const storeContext = runContext(context);
  let runRecord = snapshotRecord(
    await sanitizedCall(
      () => selected.ensureIdentityObservationRunImpl(
        storeContext,
      ),
    ),
    validateIdentityObservationRun,
  );
  if (!contextMatches(runRecord, context)) {
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_FAILED",
    );
  }
  if (runRecord.status === "collecting") {
    for (const item of first.workItems) {
      const work = snapshotRecord(
        await sanitizedCall(
          () => selected.createIdentityObservationWorkImpl(
            workInput(context, item),
          ),
        ),
        validateIdentityObservationWork,
      );
      if (
        !contextMatches(work, context)
        || work.runKeyDigest !== runRecord.runKeyDigest
        || work.workItemDigest !== item.workItemDigest
        || work.privateWorkReference
          !== item.privateWorkReference
      ) {
        fail(
          "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_FAILED",
        );
      }
    }
  }
  runRecord = snapshotRecord(
    await sanitizedCall(
      () => selected.finalizeIdentityObservationWorkSetImpl(
        storeContext,
      ),
    ),
    validateIdentityObservationRun,
  );
  if (
    !contextMatches(runRecord, context)
    || !["work_set_complete", "sealed"].includes(
      runRecord.status,
    )
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_FAILED",
    );
  }
  const works = [];
  for (const workKeyDigest of runRecord.workKeyDigests) {
    const work = snapshotRecord(
      await sanitizedCall(
        () => selected.readIdentityObservationWorkImpl({
          workKeyDigest,
        }),
      ),
      validateIdentityObservationWork,
    );
    if (
      work.workKeyDigest !== workKeyDigest
      || work.runKeyDigest !== runRecord.runKeyDigest
      || !contextMatches(work, context)
    ) {
      fail(
        "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_FAILED",
      );
    }
    works.push(work);
  }
  const second = await collectPass({
    boundaryAt: context.boundaryAt,
    passNumber: 2,
    readPage:
      selected.readPrivateParaformHumanSourcePageImpl,
  });
  const proof = await sanitizedCall(async () => (
    proveParaformHumanIdentityExhaustiveness({
      passes: [first.pass, second.pass],
      run: runRecord,
      works,
    })
  ));
  const retention = normalizedRetention(
    await sanitizedCall(
      () => selected.retainProofImpl({
        runKeyDigest: runRecord.runKeyDigest,
        proof,
      }),
    ),
    runRecord,
    proof,
  );
  return Object.freeze({
    version:
      SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_VERSION,
    boundaryAt: proof.boundaryAt,
    runKeyDigest: runRecord.runKeyDigest,
    proofDigest: proof.proofDigest,
    recordRevisionSha1:
      retention.recordRevisionSha1,
    retainedAtMs: retention.retainedAtMs,
    proofCreated: retention.created,
    proofDuplicate: retention.duplicate,
    passCount: proof.passCount,
    pageCount: proof.pageCount,
    scannedCount: proof.scannedCount,
    sourceReferenceCount: proof.sourceReferenceCount,
    humanReferenceCount: proof.humanReferenceCount,
    nonHumanReferenceCount:
      proof.nonHumanReferenceCount,
    identityWorkCount: proof.workManifestCount,
    identityWorkSetFinalized: true,
    durableProofAvailable: true,
    stablePassesProven: true,
    cursorExhaustivenessProven: true,
    workIndexEqualityProven: true,
    upstreamExhaustivenessProven: true,
    operational: false,
    pinnable: false,
    identityCollectorPinned: false,
    identityArtifactPinned: false,
    sourceAuthorityAvailable: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
  });
}

export async function
runParaformHumanIdentityProofRuntime(
  value,
  testDependencies,
) {
  try {
    return await run(value, testDependencies);
  } catch (error) {
    if (
      error
        instanceof SourceParaformHumanIdentityProofRuntimeError
      && [
        "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_INPUT_INVALID",
        "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_DEPENDENCIES_INVALID",
      ].includes(error.code)
    ) {
      throw error;
    }
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_FAILED",
    );
  }
}
