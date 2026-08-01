// Hard-dark Paraform Human identity collector/seal/binding composition.
//
// One server-owned boundary/run nonce selects a finalized identity run and
// its retained exhaustive work proof. At most one store-owned work item is
// handed to the existing two-read collector. The immutable alias artifact is
// prepared only after every work item is terminal, then the separate read-only
// proof/artifact binding is evaluated.
//
// This module has no route, scheduler, worker, pin, source-authority, or
// write-authority surface. It returns digest/count-only state.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
  prepareIdentityAliasArtifact,
  readIdentityObservationRun,
  readIdentityObservationWork,
  validateIdentityObservationRun,
  validateIdentityObservationWork,
} from "./source-identity-artifact-store.mjs";
import {
  collectCandidateUserIdentityTwoRead,
} from "./source-identity-two-read-collector.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_CONTRACT_PINS_DIGEST,
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_VERSION,
} from "./source-paraform-human-identity-artifact-binding.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_VERSION,
  readParaformHumanIdentityArtifactBinding,
} from "./source-paraform-human-identity-artifact-binding-runtime.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
} from "./source-paraform-human-identity-exhaustiveness.mjs";
import {
  readParaformHumanIdentityExhaustivenessProof,
  validateSourceParaformHumanIdentityProofRecord,
} from "./source-paraform-human-identity-proof-store.mjs";

export const
  SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_VERSION =
    "paraform-human-identity-collector-binding-runtime-v1";

const DIGEST = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const INPUT_KEYS = Object.freeze([
  "boundaryAt",
  "runNonceDigest",
]);
const DEPENDENCY_KEYS = Object.freeze([
  "collectWorkImpl",
  "prepareArtifactImpl",
  "readBindingImpl",
  "readProofImpl",
  "readRunImpl",
  "readWorkImpl",
]);
const RUN_SNAPSHOT_KEYS = Object.freeze([
  "record",
  "raw",
  "rawSha1",
  "redisNowMs",
]);
const WORK_SNAPSHOT_KEYS = RUN_SNAPSHOT_KEYS;
const PROOF_READ_KEYS = Object.freeze([
  "version",
  "policyVersion",
  "kind",
  "runKeyDigest",
  "proof",
  "retainedAtMs",
  "proofDigest",
  "recordRevisionSha1",
  "operational",
  "pinnable",
  "sourceAuthorityAvailable",
  "activationAvailable",
  "writeAuthorityAvailable",
]);
const PREPARED_ARTIFACT_KEYS = Object.freeze([
  "sealedArtifactDigest",
  "headRecordDigest",
  "pageCount",
  "resolvedEntryCount",
  "unresolvedWorkCount",
  "conflictWorkCount",
  "operational",
  "pinnable",
  "upstreamExhaustivenessProven",
  "activationAvailable",
  "writeAuthorityAvailable",
  "runStatus",
]);
const BINDING_KEYS = Object.freeze([
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
const TERMINAL_WORK_STATUSES = new Set([
  "resolved",
  "unresolved",
  "conflict",
]);

export class
SourceParaformHumanIdentityCollectorBindingRuntimeError
  extends Error {
  constructor(code) {
    super(code);
    this.name =
      "SourceParaformHumanIdentityCollectorBindingRuntimeError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceParaformHumanIdentityCollectorBindingRuntimeError(
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
  const record = Object.create(null);
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
    record[key] = descriptor.value;
  }
  return record;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(
        "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED",
      );
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
  fail(
    "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED",
  );
}

function digest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
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

function timestamp(value, code) {
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

function input(value) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_INPUT_INVALID";
  const selected = exactRecord(value, INPUT_KEYS, code);
  const boundaryAt = timestamp(selected.boundaryAt, code);
  return Object.freeze({
    boundaryAt,
    runNonceDigest: digest(selected.runNonceDigest, code),
    decisionBoundaryAtMs: Date.parse(boundaryAt),
    contractPinsDigest:
      SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
  });
}

function dependencies(value) {
  if (value === undefined) {
    return Object.freeze({
      collectWorkImpl:
        collectCandidateUserIdentityTwoRead,
      prepareArtifactImpl: prepareIdentityAliasArtifact,
      readBindingImpl:
        readParaformHumanIdentityArtifactBinding,
      readProofImpl:
        readParaformHumanIdentityExhaustivenessProof,
      readRunImpl: readIdentityObservationRun,
      readWorkImpl: readIdentityObservationWork,
    });
  }
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_DEPENDENCIES_INVALID";
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
      "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED",
    );
  }
}

function durableSnapshot(value, expectedKind) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED";
  const snapshot = exactRecord(
    value,
    expectedKind === "run"
      ? RUN_SNAPSHOT_KEYS
      : WORK_SNAPSHOT_KEYS,
    code,
  );
  if (
    typeof snapshot.raw !== "string"
    || typeof snapshot.rawSha1 !== "string"
    || !SHA1.test(snapshot.rawSha1)
    || createHash("sha1").update(snapshot.raw).digest("hex")
      !== snapshot.rawSha1
    || !Number.isSafeInteger(snapshot.redisNowMs)
    || snapshot.redisNowMs < 0
  ) {
    fail(code);
  }
  let parsed;
  let record;
  try {
    parsed = JSON.parse(snapshot.raw);
    record = expectedKind === "run"
      ? validateIdentityObservationRun(snapshot.record)
      : validateIdentityObservationWork(snapshot.record);
    const parsedRecord = expectedKind === "run"
      ? validateIdentityObservationRun(parsed)
      : validateIdentityObservationWork(parsed);
    if (canonicalJson(record) !== canonicalJson(parsedRecord)) {
      fail(code);
    }
  } catch {
    fail(code);
  }
  return record;
}

function runRecord(value, context) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED";
  const run = durableSnapshot(value, "run");
  if (
    !["work_set_complete", "sealed"].includes(run.status)
    || run.runNonceDigest !== context.runNonceDigest
    || run.decisionBoundaryAtMs
      !== context.decisionBoundaryAtMs
    || run.contractPinsDigest
      !== context.contractPinsDigest
  ) {
    fail(code);
  }
  return run;
}

function proofRead(value, run, context) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED";
  const read = exactRecord(value, PROOF_READ_KEYS, code);
  let record;
  try {
    record = validateSourceParaformHumanIdentityProofRecord({
      version: read.version,
      policyVersion: read.policyVersion,
      kind: read.kind,
      runKeyDigest: read.runKeyDigest,
      proof: read.proof,
      retainedAtMs: read.retainedAtMs,
    });
  } catch {
    fail(code);
  }
  if (
    record.runKeyDigest !== run.runKeyDigest
    || read.proofDigest !== record.proof.proofDigest
    || typeof read.recordRevisionSha1 !== "string"
    || !SHA1.test(read.recordRevisionSha1)
    || record.proof.boundaryAt !== context.boundaryAt
    || record.proof.contractPinsDigest
      !== run.contractPinsDigest
    || record.proof.workManifestDigest
      !== run.workManifestDigest
    || record.proof.workManifestCount
      !== run.workManifestCount
    || read.operational !== false
    || read.pinnable !== false
    || read.sourceAuthorityAvailable !== false
    || read.activationAvailable !== false
    || read.writeAuthorityAvailable !== false
  ) {
    fail(code);
  }
  return Object.freeze({
    proofDigest: record.proof.proofDigest,
    recordRevisionSha1: read.recordRevisionSha1,
  });
}

function workRecord(value, run, expectedWorkKeyDigest) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED";
  const work = durableSnapshot(value, "work");
  if (
    work.workKeyDigest !== expectedWorkKeyDigest
    || work.runKeyDigest !== run.runKeyDigest
    || work.runNonceDigest !== run.runNonceDigest
    || work.decisionBoundaryAtMs
      !== run.decisionBoundaryAtMs
    || work.contractPinsDigest
      !== run.contractPinsDigest
  ) {
    fail(code);
  }
  return work;
}

async function readWorkSet(run, selected) {
  const records = [];
  for (const workKeyDigest of run.workKeyDigests) {
    records.push(workRecord(
      await call(() => selected.readWorkImpl(
        Object.freeze({ workKeyDigest }),
      )),
      run,
      workKeyDigest,
    ));
  }
  return Object.freeze(records);
}

function workCounts(records) {
  const count = (status) => records.filter(
    (record) => record.status === status,
  ).length;
  const resolvedWorkCount = count("resolved");
  const unresolvedWorkCount = count("unresolved");
  const conflictWorkCount = count("conflict");
  return Object.freeze({
    terminalWorkCount:
      resolvedWorkCount
      + unresolvedWorkCount
      + conflictWorkCount,
    resolvedWorkCount,
    unresolvedWorkCount,
    conflictWorkCount,
  });
}

function pendingResult({
  context,
  run,
  proof,
  records,
  collectorStepAttempted,
}) {
  const counts = workCounts(records);
  return Object.freeze({
    coordinatorRuntimeVersion:
      SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_VERSION,
    status: "identity_collection_step_checked_dark",
    boundaryAt: context.boundaryAt,
    identityRunKeyDigest: run.runKeyDigest,
    exhaustivenessProofDigest: proof.proofDigest,
    exhaustivenessProofRecordRevisionSha1:
      proof.recordRevisionSha1,
    workManifestDigest: run.workManifestDigest,
    workManifestCount: run.workManifestCount,
    terminalWorkCount: counts.terminalWorkCount,
    resolvedWorkCount: counts.resolvedWorkCount,
    unresolvedWorkCount: counts.unresolvedWorkCount,
    conflictWorkCount: counts.conflictWorkCount,
    collectorStepAttempted,
    retainedExhaustivenessProofAvailable: true,
    identityWorkSetFinalized: true,
    identityWorkSetTerminal: false,
    terminalIdentityArtifactBound: false,
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

function preparedArtifact(value, run, counts) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED";
  const artifact = exactRecord(
    value,
    PREPARED_ARTIFACT_KEYS,
    code,
  );
  positiveInteger(artifact.pageCount, code);
  for (const key of [
    "resolvedEntryCount",
    "unresolvedWorkCount",
    "conflictWorkCount",
  ]) {
    nonNegativeInteger(artifact[key], code);
  }
  digest(artifact.sealedArtifactDigest, code);
  digest(artifact.headRecordDigest, code);
  if (
    (
      counts !== null
      && (
        artifact.unresolvedWorkCount
          !== counts.unresolvedWorkCount
        || artifact.conflictWorkCount
          < counts.conflictWorkCount
        || artifact.resolvedEntryCount
          + artifact.conflictWorkCount
          !== counts.resolvedWorkCount
            + counts.conflictWorkCount
      )
    )
    || artifact.resolvedEntryCount
      + artifact.unresolvedWorkCount
      + artifact.conflictWorkCount
      !== run.workManifestCount
    || artifact.operational !== false
    || artifact.pinnable !== false
    || artifact.upstreamExhaustivenessProven !== false
    || artifact.activationAvailable !== false
    || artifact.writeAuthorityAvailable !== false
    || artifact.runStatus !== "sealed"
    || (
      run.status === "sealed"
      && (
        artifact.sealedArtifactDigest
          !== run.sealedArtifactDigest
        || artifact.headRecordDigest
          !== run.sealedHeadRecordDigest
      )
    )
  ) {
    fail(code);
  }
  return Object.freeze(artifact);
}

function bindingResult(value, context, run, proof, artifact) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED";
  const binding = exactRecord(value, BINDING_KEYS, code);
  positiveInteger(binding.pageCount, code);
  for (const key of [
    "workManifestCount",
    "resolvedEntryCount",
    "unresolvedWorkCount",
    "conflictWorkCount",
  ]) {
    nonNegativeInteger(binding[key], code);
  }
  for (const key of [
    "contractPinsDigest",
    "identityRunKeyDigest",
    "exhaustivenessProofDigest",
    "workManifestDigest",
    "terminalWorkSetDigest",
    "sealedArtifactDigest",
    "sealedHeadRecordDigest",
    "bindingDigest",
  ]) {
    digest(binding[key], code);
  }
  if (
    binding.runtimeVersion
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_VERSION
    || binding.version
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_VERSION
    || binding.policyVersion
      !== SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION
    || binding.boundaryAt !== context.boundaryAt
    || binding.contractPinsDigest
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_CONTRACT_PINS_DIGEST
    || binding.identityRunKeyDigest !== run.runKeyDigest
    || binding.exhaustivenessProofDigest
      !== proof.proofDigest
    || binding.exhaustivenessProofRecordRevisionSha1
      !== proof.recordRevisionSha1
    || binding.workManifestDigest
      !== run.workManifestDigest
    || binding.workManifestCount !== run.workManifestCount
    || binding.sealedArtifactDigest
      !== artifact.sealedArtifactDigest
    || binding.sealedHeadRecordDigest
      !== artifact.headRecordDigest
    || binding.pageCount !== artifact.pageCount
    || binding.resolvedEntryCount
      !== artifact.resolvedEntryCount
    || binding.unresolvedWorkCount
      !== artifact.unresolvedWorkCount
    || binding.conflictWorkCount
      !== artifact.conflictWorkCount
    || binding.retainedExhaustivenessProofAvailable !== true
    || binding.identityWorkSetFinalized !== true
    || binding.identityWorkSetTerminal !== true
    || binding.terminalIdentityArtifactBound !== true
    || binding.upstreamExhaustivenessProven !== true
    || binding.operational !== false
    || binding.pinnable !== false
    || binding.identityCollectorPinned !== false
    || binding.identityArtifactPinned !== false
    || binding.sourceAuthorityAvailable !== false
    || binding.activationAvailable !== false
    || binding.writeAuthorityAvailable !== false
  ) {
    fail(code);
  }
  return Object.freeze(binding);
}

async function run(value, testDependencies) {
  const context = input(value);
  const selected = dependencies(testDependencies);
  const storeContext = Object.freeze({
    runNonceDigest: context.runNonceDigest,
    decisionBoundaryAtMs: context.decisionBoundaryAtMs,
    contractPinsDigest: context.contractPinsDigest,
  });
  const runRecordBefore = runRecord(
    await call(() => selected.readRunImpl(storeContext)),
    context,
  );
  const proof = proofRead(
    await call(() => selected.readProofImpl({
      runKeyDigest: runRecordBefore.runKeyDigest,
    })),
    runRecordBefore,
    context,
  );

  let collectorStepAttempted = false;
  let records = Object.freeze([]);
  if (runRecordBefore.status !== "sealed") {
    records = await readWorkSet(runRecordBefore, selected);
    const selectedWork = records.find(
      (record) => !TERMINAL_WORK_STATUSES.has(record.status),
    );
    if (selectedWork) {
      collectorStepAttempted = true;
      const collected = await call(() => selected.collectWorkImpl(
        Object.freeze({
          workKeyDigest: selectedWork.workKeyDigest,
        }),
      ));
      if (collected !== undefined) {
        fail(
          "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED",
        );
      }
      records = await readWorkSet(runRecordBefore, selected);
    }
    const counts = workCounts(records);
    if (counts.terminalWorkCount !== runRecordBefore.workManifestCount) {
      return pendingResult({
        context,
        run: runRecordBefore,
        proof,
        records,
        collectorStepAttempted,
      });
    }
  }

  const counts = runRecordBefore.status === "sealed"
    ? null
    : workCounts(records);
  const artifact = preparedArtifact(
    await call(() => selected.prepareArtifactImpl(storeContext)),
    runRecordBefore,
    counts,
  );
  const binding = bindingResult(
    await call(() => selected.readBindingImpl(
      Object.freeze({
        boundaryAt: context.boundaryAt,
        runNonceDigest: context.runNonceDigest,
      }),
    )),
    context,
    runRecordBefore,
    proof,
    artifact,
  );
  return Object.freeze({
    coordinatorRuntimeVersion:
      SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_VERSION,
    status: "terminal_identity_artifact_bound_dark",
    collectorStepAttempted,
    terminalWorkCount:
      binding.resolvedEntryCount
      + binding.unresolvedWorkCount
      + binding.conflictWorkCount,
    ...binding,
  });
}

export async function
runParaformHumanIdentityCollectorBindingRuntime(
  value,
  testDependencies,
) {
  try {
    return await run(value, testDependencies);
  } catch (error) {
    if (
      error
        instanceof SourceParaformHumanIdentityCollectorBindingRuntimeError
      && [
        "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_INPUT_INVALID",
        "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_DEPENDENCIES_INVALID",
      ].includes(error.code)
    ) {
      throw error;
    }
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED",
    );
  }
}
