// Pure hard-dark binding between one retained Paraform Human exhaustiveness
// proof and one terminal sealed candidate-user identity alias artifact.
//
// The binding proves that the immutable proof record, sealed run, and exact
// artifact head share one run context and one finalized work manifest. It
// emits only digests and counts. It cannot collect identity, persist a
// binding, pin an artifact, activate source authority, or write.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
  validateIdentityAliasArtifactHead,
  validateIdentityObservationRun,
} from "./source-identity-artifact-store.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_VERSION,
} from "./source-paraform-human-identity-exhaustiveness.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_POLICY_VERSION,
  validateSourceParaformHumanIdentityProofRecord,
} from "./source-paraform-human-identity-proof-store.mjs";

export const
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_VERSION =
    "paraform-human-identity-artifact-binding-v1";

const CONTRACT_PINS_DOMAIN =
  "phase4-paraform-human-identity-artifact-binding-contract-pins-v1";
const BINDING_DIGEST_DOMAIN =
  "phase4-paraform-human-identity-artifact-binding-v1";
const DIGEST = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const INPUT_KEYS = Object.freeze([
  "proofRecord",
  "proofRecordRevisionSha1",
  "run",
  "headRecord",
  "headRecordDigest",
]);

export class SourceParaformHumanIdentityArtifactBindingError
  extends Error {
  constructor(code) {
    super(code);
    this.name =
      "SourceParaformHumanIdentityArtifactBindingError";
    this.code = code;
  }
}

function fail() {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_INVALID";
  throw new SourceParaformHumanIdentityArtifactBindingError(code);
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

function exactRecord(value, expectedKeys) {
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
  if (Object.getOwnPropertySymbols(value).length !== 0) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!sameKeys(Object.keys(descriptors), expectedKeys)) fail();
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
      fail();
    }
    record[key] = descriptor.value;
  }
  return record;
}

function digest(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail();
  }
  return value;
}

function sha1(value) {
  if (typeof value !== "string" || !SHA1.test(value)) {
    fail();
  }
  return value;
}

const CONTRACT_PINS = Object.freeze({
  version:
    SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_VERSION,
  exhaustivenessProofVersion:
    SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_VERSION,
  exhaustivenessProofStorePolicyVersion:
    SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_POLICY_VERSION,
  identityArtifactStorePolicyVersion:
    SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
  bindingDigestDomain: BINDING_DIGEST_DOMAIN,
});

export const
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_CONTRACT_PINS_DIGEST =
    semanticDigest(CONTRACT_PINS_DOMAIN, CONTRACT_PINS);

function bind(value) {
  const input = exactRecord(value, INPUT_KEYS);
  let proofRecord;
  let run;
  let head;
  try {
    proofRecord =
      validateSourceParaformHumanIdentityProofRecord(
        input.proofRecord,
      );
    run = validateIdentityObservationRun(input.run);
    head = validateIdentityAliasArtifactHead(
      input.headRecord,
    );
  } catch {
    fail();
  }
  const proof = proofRecord.proof;
  const proofRecordRevisionSha1 = sha1(
    input.proofRecordRevisionSha1,
  );
  const headRecordDigest = digest(
    input.headRecordDigest,
  );
  const computedHeadRecordDigest = createHash("sha256")
    .update(JSON.stringify(head))
    .digest("hex");
  if (
    run.status !== "sealed"
    || proofRecord.runKeyDigest !== run.runKeyDigest
    || proof.boundaryAt
      !== new Date(run.decisionBoundaryAtMs).toISOString()
    || proof.contractPinsDigest !== run.contractPinsDigest
    || proof.workManifestDigest !== run.workManifestDigest
    || proof.workManifestCount !== run.workManifestCount
    || head.runNonceDigest !== run.runNonceDigest
    || head.decisionBoundaryAtMs
      !== run.decisionBoundaryAtMs
    || head.contractPinsDigest !== run.contractPinsDigest
    || head.workManifestDigest !== run.workManifestDigest
    || head.workManifestCount !== run.workManifestCount
    || head.sealedArtifactDigest
      !== run.sealedArtifactDigest
    || headRecordDigest !== run.sealedHeadRecordDigest
    || computedHeadRecordDigest !== headRecordDigest
  ) {
    fail();
  }
  const material = {
    version:
      SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_VERSION,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    boundaryAt: proof.boundaryAt,
    contractPinsDigest:
      SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_CONTRACT_PINS_DIGEST,
    identityRunKeyDigest: run.runKeyDigest,
    exhaustivenessProofDigest: proof.proofDigest,
    exhaustivenessProofRecordRevisionSha1:
      proofRecordRevisionSha1,
    workManifestDigest: run.workManifestDigest,
    workManifestCount: run.workManifestCount,
    terminalWorkSetDigest: head.terminalWorkSetDigest,
    sealedArtifactDigest: head.sealedArtifactDigest,
    sealedHeadRecordDigest: headRecordDigest,
    pageCount: head.pageCount,
    resolvedEntryCount: head.resolvedEntryCount,
    unresolvedWorkCount: head.unresolvedWorkCount,
    conflictWorkCount: head.conflictWorkCount,
    retainedExhaustivenessProofAvailable: true,
    identityWorkSetFinalized: true,
    identityWorkSetTerminal: true,
    terminalIdentityArtifactBound: true,
    upstreamExhaustivenessProven: true,
    operational: false,
    pinnable: false,
    identityCollectorPinned: false,
    identityArtifactPinned: false,
    sourceAuthorityAvailable: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
  };
  return Object.freeze({
    ...material,
    bindingDigest: semanticDigest(
      BINDING_DIGEST_DOMAIN,
      material,
    ),
  });
}

export function bindParaformHumanIdentityArtifact(value) {
  try {
    return bind(value);
  } catch {
    fail();
  }
}
