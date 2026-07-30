// Read-only hard-dark composition of a retained Paraform Human exhaustive
// work proof and an already-sealed terminal identity alias artifact.
//
// This runtime performs only exact durable reads. It does not run the identity
// collector, seal an artifact, persist the binding, mint a pin, activate
// source authority, or write to a vendor.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  readIdentityAliasArtifactHead,
  readIdentityObservationRun,
  validateIdentityObservationRun,
} from "./source-identity-artifact-store.mjs";
import {
  bindParaformHumanIdentityArtifact,
} from "./source-paraform-human-identity-artifact-binding.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
} from "./source-paraform-human-identity-exhaustiveness.mjs";
import {
  readParaformHumanIdentityExhaustivenessProof,
} from "./source-paraform-human-identity-proof-store.mjs";

export const
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_VERSION =
    "paraform-human-identity-artifact-binding-runtime-v1";

const DIGEST = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const INPUT_KEYS = Object.freeze([
  "boundaryAt",
  "runNonceDigest",
]);
const DEPENDENCY_KEYS = Object.freeze([
  "readHeadImpl",
  "readProofImpl",
  "readRunImpl",
]);
const RUN_SNAPSHOT_KEYS = Object.freeze([
  "record",
  "raw",
  "rawSha1",
  "redisNowMs",
]);
const HEAD_SNAPSHOT_KEYS = Object.freeze([
  "raw",
  "headRecordDigest",
  "record",
  "redisNowMs",
]);
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

export class
SourceParaformHumanIdentityArtifactBindingRuntimeError
  extends Error {
  constructor(code) {
    super(code);
    this.name =
      "SourceParaformHumanIdentityArtifactBindingRuntimeError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceParaformHumanIdentityArtifactBindingRuntimeError(
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

function digest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
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
    "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_INPUT_INVALID";
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
      readHeadImpl: readIdentityAliasArtifactHead,
      readProofImpl:
        readParaformHumanIdentityExhaustivenessProof,
      readRunImpl: readIdentityObservationRun,
    });
  }
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_DEPENDENCIES_INVALID";
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
      "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_FAILED",
    );
  }
}

function runRecord(value, context) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_FAILED";
  const snapshot = exactRecord(
    value,
    RUN_SNAPSHOT_KEYS,
    code,
  );
  let run;
  try {
    run = validateIdentityObservationRun(snapshot.record);
  } catch {
    fail(code);
  }
  if (
    run.status !== "sealed"
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

function proofRead(value, run) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_FAILED";
  const read = exactRecord(value, PROOF_READ_KEYS, code);
  if (
    read.runKeyDigest !== run.runKeyDigest
    || read.proofDigest !== read.proof?.proofDigest
    || typeof read.recordRevisionSha1 !== "string"
    || !SHA1.test(read.recordRevisionSha1)
    || read.operational !== false
    || read.pinnable !== false
    || read.sourceAuthorityAvailable !== false
    || read.activationAvailable !== false
    || read.writeAuthorityAvailable !== false
  ) {
    fail(code);
  }
  return Object.freeze({
    record: Object.freeze({
      version: read.version,
      policyVersion: read.policyVersion,
      kind: read.kind,
      runKeyDigest: read.runKeyDigest,
      proof: read.proof,
      retainedAtMs: read.retainedAtMs,
    }),
    recordRevisionSha1: read.recordRevisionSha1,
  });
}

function headRead(value) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_FAILED";
  const head = exactRecord(value, HEAD_SNAPSHOT_KEYS, code);
  if (
    typeof head.raw !== "string"
    || JSON.stringify(head.record) !== head.raw
    || createHash("sha256").update(head.raw).digest("hex")
      !== head.headRecordDigest
  ) {
    fail(code);
  }
  return head;
}

async function compose(value, testDependencies) {
  const context = input(value);
  const selected = dependencies(testDependencies);
  const storeContext = Object.freeze({
    runNonceDigest: context.runNonceDigest,
    decisionBoundaryAtMs: context.decisionBoundaryAtMs,
    contractPinsDigest: context.contractPinsDigest,
  });
  const run = runRecord(
    await call(() => selected.readRunImpl(storeContext)),
    context,
  );
  const retained = proofRead(
    await call(() => selected.readProofImpl({
      runKeyDigest: run.runKeyDigest,
    })),
    run,
  );
  const head = headRead(
    await call(() => selected.readHeadImpl({
      sealedArtifactDigest: run.sealedArtifactDigest,
      ...storeContext,
    })),
  );
  const binding = await call(async () => (
    bindParaformHumanIdentityArtifact({
      proofRecord: retained.record,
      proofRecordRevisionSha1:
        retained.recordRevisionSha1,
      run,
      headRecord: head.record,
      headRecordDigest: head.headRecordDigest,
    })
  ));
  return Object.freeze({
    runtimeVersion:
      SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_VERSION,
    ...binding,
  });
}

export async function
readParaformHumanIdentityArtifactBinding(
  value,
  testDependencies,
) {
  try {
    return await compose(value, testDependencies);
  } catch (error) {
    if (
      error
        instanceof SourceParaformHumanIdentityArtifactBindingRuntimeError
      && [
        "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_INPUT_INVALID",
        "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_DEPENDENCIES_INVALID",
      ].includes(error.code)
    ) {
      throw error;
    }
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_FAILED",
    );
  }
}
