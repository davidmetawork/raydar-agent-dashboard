// Durable server-owned Paraform Human identity lifecycle adapter.
//
// The caller supplies only an exact dark mode. The existing Phase 4 capture
// journal owns the common Redis-time boundary and opaque run nonce. Durable
// identity-run state selects exactly one child phase:
//   - absent/collecting: exhaustive proof orchestration and retention
//   - finalized/sealed: at most one collect/seal/bind step
//
// This adapter is intentionally not imported by the worker or a route. It
// mints no pin or authority and returns only digest/count state.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  ensureDarkSourceCaptureRun,
  validateDarkSourceCaptureRecord,
} from "./source-capture-store.mjs";
import {
  SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
  readIdentityObservationRun,
  validateIdentityObservationRun,
} from "./source-identity-artifact-store.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_CONTRACT_PINS_DIGEST,
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_VERSION,
} from "./source-paraform-human-identity-artifact-binding.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_VERSION,
} from "./source-paraform-human-identity-artifact-binding-runtime.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_VERSION,
  runParaformHumanIdentityCollectorBindingRuntime,
} from "./source-paraform-human-identity-collector-binding-runtime.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
} from "./source-paraform-human-identity-exhaustiveness.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_VERSION,
  runParaformHumanIdentityProofRuntime,
} from "./source-paraform-human-identity-proof-runtime.mjs";

export const
  SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_VERSION =
    "paraform-human-identity-lifecycle-journal-v1";
export const
  SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_TICK_MODE =
    "paraform-human-identity-lifecycle-tick";

const DIGEST = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const INPUT_KEYS = Object.freeze(["mode"]);
const DEPENDENCY_KEYS = Object.freeze([
  "ensureCaptureJournalImpl",
  "readIdentityRunImpl",
  "runCollectorBindingImpl",
  "runProofImpl",
]);
const SNAPSHOT_KEYS = Object.freeze([
  "record",
  "raw",
  "rawSha1",
  "redisNowMs",
]);
const PROOF_RESULT_KEYS = Object.freeze([
  "version",
  "boundaryAt",
  "runKeyDigest",
  "proofDigest",
  "recordRevisionSha1",
  "retainedAtMs",
  "proofCreated",
  "proofDuplicate",
  "passCount",
  "pageCount",
  "scannedCount",
  "sourceReferenceCount",
  "humanReferenceCount",
  "nonHumanReferenceCount",
  "identityWorkCount",
  "identityWorkSetFinalized",
  "durableProofAvailable",
  "stablePassesProven",
  "cursorExhaustivenessProven",
  "workIndexEqualityProven",
  "upstreamExhaustivenessProven",
  "operational",
  "pinnable",
  "identityCollectorPinned",
  "identityArtifactPinned",
  "sourceAuthorityAvailable",
  "activationAvailable",
  "writeAuthorityAvailable",
]);
const COLLECTOR_PENDING_KEYS = Object.freeze([
  "coordinatorRuntimeVersion",
  "status",
  "boundaryAt",
  "identityRunKeyDigest",
  "exhaustivenessProofDigest",
  "exhaustivenessProofRecordRevisionSha1",
  "workManifestDigest",
  "workManifestCount",
  "terminalWorkCount",
  "resolvedWorkCount",
  "unresolvedWorkCount",
  "conflictWorkCount",
  "collectorStepAttempted",
  "retainedExhaustivenessProofAvailable",
  "identityWorkSetFinalized",
  "identityWorkSetTerminal",
  "terminalIdentityArtifactBound",
  "upstreamExhaustivenessProven",
  "operational",
  "pinnable",
  "identityCollectorPinned",
  "identityArtifactPinned",
  "sourceAuthorityAvailable",
  "activationAvailable",
  "writeAuthorityAvailable",
]);
const COLLECTOR_BOUND_KEYS = Object.freeze([
  "coordinatorRuntimeVersion",
  "status",
  "collectorStepAttempted",
  "terminalWorkCount",
  "runtimeVersion",
  "version",
  "policyVersion",
  "boundaryAt",
  "contractPinsDigest",
  "identityRunKeyDigest",
  "exhaustivenessProofDigest",
  "exhaustivenessProofRecordRevisionSha1",
  "workManifestDigest",
  "workManifestCount",
  "terminalWorkSetDigest",
  "sealedArtifactDigest",
  "sealedHeadRecordDigest",
  "pageCount",
  "resolvedEntryCount",
  "unresolvedWorkCount",
  "conflictWorkCount",
  "retainedExhaustivenessProofAvailable",
  "identityWorkSetFinalized",
  "identityWorkSetTerminal",
  "terminalIdentityArtifactBound",
  "upstreamExhaustivenessProven",
  "operational",
  "pinnable",
  "identityCollectorPinned",
  "identityArtifactPinned",
  "sourceAuthorityAvailable",
  "activationAvailable",
  "writeAuthorityAvailable",
  "bindingDigest",
]);

export class
SourceParaformHumanIdentityLifecycleJournalError
  extends Error {
  constructor(code) {
    super(code);
    this.name =
      "SourceParaformHumanIdentityLifecycleJournalError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceParaformHumanIdentityLifecycleJournalError(
    code,
  );
}

function sameKeys(actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length
    && left.every((key, index) => key === right[index]);
}

function exactRecord(value, expectedKeys, code) {
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

function digest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
  return value;
}

function sha1(value, code) {
  if (typeof value !== "string" || !SHA1.test(value)) {
    fail(code);
  }
  return value;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function request(value) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_INPUT_INVALID";
  const input = exactRecord(value, INPUT_KEYS, code);
  if (
    input.mode
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_TICK_MODE
  ) {
    fail(code);
  }
}

function dependencies(value) {
  if (value === undefined) {
    return Object.freeze({
      ensureCaptureJournalImpl: ensureDarkSourceCaptureRun,
      readIdentityRunImpl: readIdentityObservationRun,
      runCollectorBindingImpl:
        runParaformHumanIdentityCollectorBindingRuntime,
      runProofImpl: runParaformHumanIdentityProofRuntime,
    });
  }
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_DEPENDENCIES_INVALID";
  const selected = exactRecord(
    value,
    DEPENDENCY_KEYS,
    code,
  );
  for (const key of DEPENDENCY_KEYS) {
    if (typeof selected[key] !== "function") fail(code);
  }
  return Object.freeze(selected);
}

async function call(operation) {
  try {
    return await operation();
  } catch {
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED",
    );
  }
}

function snapshot(value, kind, allowMissing = false) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED";
  const selected = exactRecord(value, SNAPSHOT_KEYS, code);
  if (
    !Number.isSafeInteger(selected.redisNowMs)
    || selected.redisNowMs < 0
  ) {
    fail(code);
  }
  if (selected.raw === null) {
    if (
      !allowMissing
      || selected.record !== null
      || selected.rawSha1 !== null
    ) {
      fail(code);
    }
    return Object.freeze({
      record: null,
      rawSha1: null,
    });
  }
  if (
    typeof selected.raw !== "string"
    || createHash("sha1").update(selected.raw).digest("hex")
      !== sha1(selected.rawSha1, code)
  ) {
    fail(code);
  }
  let parsed;
  let record;
  try {
    parsed = JSON.parse(selected.raw);
    record = kind === "capture"
      ? validateDarkSourceCaptureRecord(parsed)
      : validateIdentityObservationRun(parsed);
  } catch {
    fail(code);
  }
  return Object.freeze({
    record,
    rawSha1: selected.rawSha1,
  });
}

function contextFromCapture(value) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED";
  const capture = snapshot(value, "capture");
  const paraformHuman = capture.record.sources.find(
    (source) => source.source === "paraform_human",
  );
  if (
    capture.record.status === "invalidated"
    || !["captured", "head_verified"].includes(
      paraformHuman?.status,
    )
  ) {
    fail(code);
  }
  return Object.freeze({
    boundaryAt: new Date(
      capture.record.decisionBoundaryAtMs,
    ).toISOString(),
    runNonceDigest: capture.record.runNonceDigest,
    captureStatus: capture.record.status,
    captureJournalRevisionSha1: capture.rawSha1,
  });
}

function identityStoreContext(context) {
  return Object.freeze({
    runNonceDigest: context.runNonceDigest,
    decisionBoundaryAtMs: Date.parse(context.boundaryAt),
    contractPinsDigest:
      SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
  });
}

function identityRun(value, context, allowMissing = false) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED";
  const selected = snapshot(value, "identity", allowMissing);
  if (selected.record === null) return null;
  if (
    selected.record.runNonceDigest !== context.runNonceDigest
    || selected.record.decisionBoundaryAtMs
      !== Date.parse(context.boundaryAt)
    || selected.record.contractPinsDigest
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST
  ) {
    fail(code);
  }
  return selected.record;
}

function falseReleaseFlags(value, code) {
  if (
    value.operational !== false
    || value.pinnable !== false
    || value.identityCollectorPinned !== false
    || value.identityArtifactPinned !== false
    || value.sourceAuthorityAvailable !== false
    || value.activationAvailable !== false
    || value.writeAuthorityAvailable !== false
  ) {
    fail(code);
  }
}

function proofResult(value, context, runAfter) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED";
  const result = exactRecord(
    value,
    PROOF_RESULT_KEYS,
    code,
  );
  for (const key of [
    "retainedAtMs",
    "passCount",
    "pageCount",
    "scannedCount",
    "sourceReferenceCount",
    "humanReferenceCount",
    "nonHumanReferenceCount",
    "identityWorkCount",
  ]) {
    nonNegativeInteger(result[key], code);
  }
  digest(result.proofDigest, code);
  sha1(result.recordRevisionSha1, code);
  if (
    result.version
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_VERSION
    || result.boundaryAt !== context.boundaryAt
    || digest(result.runKeyDigest, code)
      !== runAfter.runKeyDigest
    || result.retainedAtMs < Date.parse(context.boundaryAt)
    || typeof result.proofCreated !== "boolean"
    || typeof result.proofDuplicate !== "boolean"
    || result.proofCreated === result.proofDuplicate
    || result.identityWorkCount !== runAfter.workManifestCount
    || result.identityWorkSetFinalized !== true
    || result.durableProofAvailable !== true
    || result.stablePassesProven !== true
    || result.cursorExhaustivenessProven !== true
    || result.workIndexEqualityProven !== true
    || result.upstreamExhaustivenessProven !== true
    || runAfter.status !== "work_set_complete"
  ) {
    fail(code);
  }
  falseReleaseFlags(result, code);
  return Object.freeze({
    status: "identity_exhaustiveness_proof_retained_dark",
    identityRunKeyDigest: result.runKeyDigest,
    exhaustivenessProofDigest: result.proofDigest,
    exhaustivenessProofRecordRevisionSha1:
      result.recordRevisionSha1,
    workManifestDigest: runAfter.workManifestDigest,
    workManifestCount: runAfter.workManifestCount,
    terminalWorkCount: 0,
    collectorStepAttempted: false,
    retainedExhaustivenessProofAvailable: true,
    identityWorkSetFinalized: true,
    identityWorkSetTerminal: false,
    terminalIdentityArtifactBound: false,
    upstreamExhaustivenessProven: true,
  });
}

function collectorPendingResult(value, context, runAfter) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED";
  const result = exactRecord(
    value,
    COLLECTOR_PENDING_KEYS,
    code,
  );
  for (const key of [
    "workManifestCount",
    "terminalWorkCount",
    "resolvedWorkCount",
    "unresolvedWorkCount",
    "conflictWorkCount",
  ]) {
    nonNegativeInteger(result[key], code);
  }
  digest(result.exhaustivenessProofDigest, code);
  sha1(
    result.exhaustivenessProofRecordRevisionSha1,
    code,
  );
  if (
    result.coordinatorRuntimeVersion
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_VERSION
    || result.status !== "identity_collection_step_checked_dark"
    || result.boundaryAt !== context.boundaryAt
    || digest(result.identityRunKeyDigest, code)
      !== runAfter.runKeyDigest
    || result.workManifestDigest
      !== runAfter.workManifestDigest
    || result.workManifestCount
      !== runAfter.workManifestCount
    || result.terminalWorkCount
      !== result.resolvedWorkCount
        + result.unresolvedWorkCount
        + result.conflictWorkCount
    || result.terminalWorkCount >= result.workManifestCount
    || typeof result.collectorStepAttempted !== "boolean"
    || result.retainedExhaustivenessProofAvailable !== true
    || result.identityWorkSetFinalized !== true
    || result.identityWorkSetTerminal !== false
    || result.terminalIdentityArtifactBound !== false
    || result.upstreamExhaustivenessProven !== true
    || runAfter.status !== "work_set_complete"
  ) {
    fail(code);
  }
  falseReleaseFlags(result, code);
  return Object.freeze({
    status: result.status,
    identityRunKeyDigest: result.identityRunKeyDigest,
    exhaustivenessProofDigest:
      result.exhaustivenessProofDigest,
    exhaustivenessProofRecordRevisionSha1:
      result.exhaustivenessProofRecordRevisionSha1,
    workManifestDigest: result.workManifestDigest,
    workManifestCount: result.workManifestCount,
    terminalWorkCount: result.terminalWorkCount,
    collectorStepAttempted: result.collectorStepAttempted,
    retainedExhaustivenessProofAvailable: true,
    identityWorkSetFinalized: true,
    identityWorkSetTerminal: false,
    terminalIdentityArtifactBound: false,
    upstreamExhaustivenessProven: true,
  });
}

function collectorBoundResult(value, context, runAfter) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED";
  const result = exactRecord(
    value,
    COLLECTOR_BOUND_KEYS,
    code,
  );
  for (const key of [
    "workManifestCount",
    "terminalWorkCount",
    "resolvedEntryCount",
    "unresolvedWorkCount",
    "conflictWorkCount",
  ]) {
    nonNegativeInteger(result[key], code);
  }
  positiveInteger(result.pageCount, code);
  for (const key of [
    "contractPinsDigest",
    "exhaustivenessProofDigest",
    "workManifestDigest",
    "terminalWorkSetDigest",
    "sealedArtifactDigest",
    "sealedHeadRecordDigest",
    "bindingDigest",
  ]) {
    digest(result[key], code);
  }
  sha1(
    result.exhaustivenessProofRecordRevisionSha1,
    code,
  );
  if (
    result.coordinatorRuntimeVersion
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_VERSION
    || result.status
      !== "terminal_identity_artifact_bound_dark"
    || result.runtimeVersion
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_VERSION
    || result.version
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_VERSION
    || result.policyVersion
      !== SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION
    || result.boundaryAt !== context.boundaryAt
    || result.contractPinsDigest
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_CONTRACT_PINS_DIGEST
    || digest(result.identityRunKeyDigest, code)
      !== runAfter.runKeyDigest
    || result.workManifestDigest
      !== runAfter.workManifestDigest
    || result.workManifestCount
      !== runAfter.workManifestCount
    || result.terminalWorkCount
      !== result.resolvedEntryCount
        + result.unresolvedWorkCount
        + result.conflictWorkCount
    || result.terminalWorkCount !== result.workManifestCount
    || result.sealedArtifactDigest
      !== runAfter.sealedArtifactDigest
    || result.sealedHeadRecordDigest
      !== runAfter.sealedHeadRecordDigest
    || typeof result.collectorStepAttempted !== "boolean"
    || result.retainedExhaustivenessProofAvailable !== true
    || result.identityWorkSetFinalized !== true
    || result.identityWorkSetTerminal !== true
    || result.terminalIdentityArtifactBound !== true
    || result.upstreamExhaustivenessProven !== true
    || runAfter.status !== "sealed"
  ) {
    fail(code);
  }
  falseReleaseFlags(result, code);
  return Object.freeze({
    status: result.status,
    identityRunKeyDigest: result.identityRunKeyDigest,
    exhaustivenessProofDigest:
      result.exhaustivenessProofDigest,
    exhaustivenessProofRecordRevisionSha1:
      result.exhaustivenessProofRecordRevisionSha1,
    workManifestDigest: result.workManifestDigest,
    workManifestCount: result.workManifestCount,
    terminalWorkCount: result.terminalWorkCount,
    collectorStepAttempted: result.collectorStepAttempted,
    retainedExhaustivenessProofAvailable: true,
    identityWorkSetFinalized: true,
    identityWorkSetTerminal: true,
    terminalIdentityArtifactBound: true,
    upstreamExhaustivenessProven: true,
  });
}

async function stableCaptureContext(selected, before) {
  const after = contextFromCapture(
    await call(() => selected.ensureCaptureJournalImpl()),
  );
  if (
    after.boundaryAt !== before.boundaryAt
    || after.runNonceDigest !== before.runNonceDigest
    || after.captureJournalRevisionSha1
      !== before.captureJournalRevisionSha1
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED",
    );
  }
}

function output(context, selected) {
  return Object.freeze({
    lifecycleJournalVersion:
      SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_VERSION,
    journalOwnedContext: true,
    captureJournalRevisionSha1:
      context.captureJournalRevisionSha1,
    boundaryAt: context.boundaryAt,
    ...selected,
    operational: false,
    pinnable: false,
    identityCollectorPinned: false,
    identityArtifactPinned: false,
    sourceAuthorityAvailable: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
  });
}

async function run(value, testDependencies) {
  request(value);
  const selected = dependencies(testDependencies);
  const context = contextFromCapture(
    await call(() => selected.ensureCaptureJournalImpl()),
  );
  const storeContext = identityStoreContext(context);
  const before = identityRun(
    await call(() => selected.readIdentityRunImpl(
      storeContext,
    )),
    context,
    true,
  );
  if (
    context.captureStatus !== "capturing"
    && before?.status !== "sealed"
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED",
    );
  }
  const childInput = Object.freeze({
    boundaryAt: context.boundaryAt,
    runNonceDigest: context.runNonceDigest,
  });
  if (before === null || before.status === "collecting") {
    const proof = await call(() => selected.runProofImpl(
      childInput,
    ));
    await stableCaptureContext(selected, context);
    const after = identityRun(
      await call(() => selected.readIdentityRunImpl(
        storeContext,
      )),
      context,
    );
    return output(
      context,
      proofResult(proof, context, after),
    );
  }
  const collector = await call(
    () => selected.runCollectorBindingImpl(childInput),
  );
  await stableCaptureContext(selected, context);
  const after = identityRun(
    await call(() => selected.readIdentityRunImpl(
      storeContext,
    )),
    context,
  );
  const projected = collector?.status
    === "identity_collection_step_checked_dark"
    ? collectorPendingResult(collector, context, after)
    : collectorBoundResult(collector, context, after);
  return output(context, projected);
}

export async function
runParaformHumanIdentityLifecycleJournal(
  value,
  testDependencies,
) {
  try {
    return await run(value, testDependencies);
  } catch (error) {
    if (
      error
        instanceof SourceParaformHumanIdentityLifecycleJournalError
      && [
        "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_INPUT_INVALID",
        "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_DEPENDENCIES_INVALID",
      ].includes(error.code)
    ) {
      throw error;
    }
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED",
    );
  }
}
