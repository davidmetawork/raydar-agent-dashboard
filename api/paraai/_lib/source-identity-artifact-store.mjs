// Private, hard-dark Phase 4 identity observation and alias artifact store.
//
// This module persists the first of two exact identity point-read
// observations before a second read is allowed. Redis TIME owns all durable
// timestamps, every mutable transition compares the complete raw record, and
// only a server-issued one-shot claim can checkpoint a provider result.
//
// Resolved observations can be sealed into immutable, content-addressed,
// digest-only pages. The sealed head and every page are read back byte for
// byte before the artifact is reported. Raw/private work references exist
// only in unsealed work records and never enter a sealed artifact or aggregate
// status.
//
// Nothing in this module activates source authority, signs a receipt, imports
// the capture coordinator, curates a role, enrolls outreach, or writes to
// Paraform.

import {
  createHash,
  randomBytes,
} from "node:crypto";

export const SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION =
  "phase4-source-identity-artifact-store-v1";
export const SOURCE_IDENTITY_TWO_READ_MAX_INTERVAL_MS = 120_000;
export const SOURCE_IDENTITY_READ_CLAIM_LEASE_MS = 60_000;
export const SOURCE_IDENTITY_PRIVATE_WORK_TTL_MS =
  24 * 60 * 60 * 1_000;
export const SOURCE_IDENTITY_ALIAS_PAGE_SIZE = 100;
export const SOURCE_IDENTITY_POINT_READ_PROCEDURE =
  "candidateUser.getCandidateUserById";
export const SOURCE_IDENTITY_UNRESOLVED_REASONS =
  Object.freeze([
    "identity_point_read_failed",
    "identity_point_response_invalid",
    "identity_point_unstable",
  ]);
export const SOURCE_IDENTITY_INTERNAL_UNRESOLVED_REASONS =
  Object.freeze([
    "identity_read_claim_abandoned",
    "two_read_interval_expired",
  ]);

const RUN_RECORD_VERSION = 1;
const WORK_RECORD_VERSION = 1;
const ARTIFACT_HEAD_VERSION = 1;
const ARTIFACT_PAGE_VERSION = 1;
const REDIS_CLOCK_SKEW_MS = 5_000;
const MAX_PRIVATE_REFERENCE_LENGTH = 512;
const MAX_REASON_LENGTH = 80;
const DIGEST = /^[a-f0-9]{64}$/u;
const REASON = new RegExp(
  `^[a-z0-9_]{1,${MAX_REASON_LENGTH}}$`,
  "u",
);
const CURSOR = DIGEST;

const RUN_KEY_PREFIX =
  "paraai:phase4:identity-artifact:run:v1:";
const WORK_KEY_PREFIX =
  "paraai:phase4:identity-artifact:work:v1:";
const HEAD_KEY_PREFIX =
  "paraai:phase4:identity-artifact:head:v1:";
const PAGE_KEY_PREFIX =
  "paraai:phase4:identity-artifact:page:v1:";

const ISSUED_READ_CLAIMS = new WeakMap();

export class SourceIdentityArtifactStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "SourceIdentityArtifactStoreError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new SourceIdentityArtifactStoreError(code, message);
}

function invariant(condition, code, message = code) {
  if (!condition) fail(code, message);
}

function object(value, field) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, code, field) {
  const actual = Object.keys(object(value, field)).sort();
  const required = [...expected].sort();
  invariant(
    canonicalJson(actual) === canonicalJson(required),
    code,
    `${field} has an unexpected shape`,
  );
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical values must be finite");
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
  throw new TypeError("canonical values must be JSON-safe");
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function rawDigest(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function rawSha1(raw) {
  return createHash("sha1").update(raw).digest("hex");
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

function digest(value, field) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(
      `${field} must be a lowercase sha256 digest`,
    );
  }
  return value;
}

function optionalDigest(value, field) {
  return value == null ? null : digest(value, field);
}

function nonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `${field} must be a non-negative safe integer`,
    );
  }
  return value;
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `${field} must be a positive safe integer`,
    );
  }
  return value;
}

function privateReference(value, field) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_PRIVATE_REFERENCE_LENGTH
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(
      `${field} must be a bounded exact private reference`,
    );
  }
  return value;
}

function reason(value, field) {
  if (typeof value !== "string" || !REASON.test(value)) {
    throw new TypeError(`${field} must be a safe reason code`);
  }
  return value;
}

function nullableCursor(value, field) {
  if (value === null) return null;
  if (typeof value !== "string" || !CURSOR.test(value)) {
    throw new TypeError(`${field} must be an opaque cursor`);
  }
  return value;
}

function runKeyDigestFor({
  runNonceDigest,
  decisionBoundaryAtMs,
  contractPinsDigest,
}) {
  return semanticDigest(
    "phase4-source-identity-observation-run-key-v1",
    {
      runNonceDigest,
      decisionBoundaryAtMs,
      contractPinsDigest,
    },
  );
}

function workKeyDigestFor({
  runKeyDigest,
  workItemDigest,
}) {
  return semanticDigest(
    "phase4-source-identity-observation-work-key-v1",
    {
      runKeyDigest,
      workItemDigest,
    },
  );
}

function workManifestDigestFor({
  runNonceDigest,
  decisionBoundaryAtMs,
  contractPinsDigest,
  workKeyDigests,
}) {
  return semanticDigest(
    "phase4-source-identity-work-manifest-v1",
    {
      runNonceDigest,
      decisionBoundaryAtMs,
      contractPinsDigest,
      workKeyDigests,
    },
  );
}

function observationEvidenceDigest(evidence) {
  return semanticDigest(
    "phase4-source-identity-two-read-observation-v1",
    evidence,
  );
}

function resolvedObservationDigest(record, evidence) {
  return semanticDigest(
    "phase4-source-identity-two-read-resolution-v1",
    {
      runNonceDigest: record.runNonceDigest,
      decisionBoundaryAtMs: record.decisionBoundaryAtMs,
      contractPinsDigest: record.contractPinsDigest,
      workItemDigest: record.workItemDigest,
      ...evidence,
    },
  );
}

function canonicalEvidence(value, field = "identity evidence") {
  const raw = object(value, field);
  exactKeys(
    raw,
    [
      "identityPointReadProcedure",
      "identityNormalizedInputDigest",
      "candidateUserAliasDigest",
      "canonicalCandidateDigest",
      "identityPointRecordDigest",
      "identityPointRecordRevisionDigest",
    ],
    "SOURCE_IDENTITY_EVIDENCE_SHAPE_INVALID",
    field,
  );
  invariant(
    raw.identityPointReadProcedure
      === SOURCE_IDENTITY_POINT_READ_PROCEDURE,
    "SOURCE_IDENTITY_PROCEDURE_INVALID",
    `${field} did not use the pinned identity point read`,
  );
  const evidence = {
    identityPointReadProcedure:
      raw.identityPointReadProcedure,
    identityNormalizedInputDigest: digest(
      raw.identityNormalizedInputDigest,
      `${field}.identityNormalizedInputDigest`,
    ),
    candidateUserAliasDigest: digest(
      raw.candidateUserAliasDigest,
      `${field}.candidateUserAliasDigest`,
    ),
    canonicalCandidateDigest: digest(
      raw.canonicalCandidateDigest,
      `${field}.canonicalCandidateDigest`,
    ),
    identityPointRecordDigest: digest(
      raw.identityPointRecordDigest,
      `${field}.identityPointRecordDigest`,
    ),
    identityPointRecordRevisionDigest: digest(
      raw.identityPointRecordRevisionDigest,
      `${field}.identityPointRecordRevisionDigest`,
    ),
  };
  invariant(
    evidence.candidateUserAliasDigest
      !== evidence.canonicalCandidateDigest,
    "SOURCE_IDENTITY_DIGEST_DOMAIN_INVALID",
    `${field} identifier digests are not domain-separated`,
  );
  return deepFreeze(evidence);
}

function checkpointEvidence(value, field) {
  if (value === null) return null;
  const raw = object(value, field);
  exactKeys(
    raw,
    [
      "identityPointReadProcedure",
      "identityNormalizedInputDigest",
      "candidateUserAliasDigest",
      "canonicalCandidateDigest",
      "identityPointRecordDigest",
      "identityPointRecordRevisionDigest",
      "evidenceDigest",
      "claimNonceDigest",
      "persistedAtMs",
    ],
    "SOURCE_IDENTITY_CHECKPOINT_SHAPE_INVALID",
    field,
  );
  const evidence = canonicalEvidence({
    identityPointReadProcedure:
      raw.identityPointReadProcedure,
    identityNormalizedInputDigest:
      raw.identityNormalizedInputDigest,
    candidateUserAliasDigest:
      raw.candidateUserAliasDigest,
    canonicalCandidateDigest:
      raw.canonicalCandidateDigest,
    identityPointRecordDigest:
      raw.identityPointRecordDigest,
    identityPointRecordRevisionDigest:
      raw.identityPointRecordRevisionDigest,
  }, field);
  invariant(
    digest(raw.evidenceDigest, `${field}.evidenceDigest`)
      === observationEvidenceDigest(evidence),
    "SOURCE_IDENTITY_EVIDENCE_DIGEST_INVALID",
    `${field} digest does not match its evidence`,
  );
  return {
    ...evidence,
    evidenceDigest: raw.evidenceDigest,
    claimNonceDigest: digest(
      raw.claimNonceDigest,
      `${field}.claimNonceDigest`,
    ),
    persistedAtMs: nonNegativeSafeInteger(
      raw.persistedAtMs,
      `${field}.persistedAtMs`,
    ),
  };
}

function activeClaim(value, field) {
  if (value === null) return null;
  const raw = object(value, field);
  exactKeys(
    raw,
    [
      "readNumber",
      "claimNonceDigest",
      "claimedAtMs",
      "validUntilMs",
    ],
    "SOURCE_IDENTITY_ACTIVE_CLAIM_INVALID",
    field,
  );
  invariant(
    raw.readNumber === 1 || raw.readNumber === 2,
    "SOURCE_IDENTITY_ACTIVE_CLAIM_INVALID",
  );
  const claim = {
    readNumber: raw.readNumber,
    claimNonceDigest: digest(
      raw.claimNonceDigest,
      `${field}.claimNonceDigest`,
    ),
    claimedAtMs: nonNegativeSafeInteger(
      raw.claimedAtMs,
      `${field}.claimedAtMs`,
    ),
    validUntilMs: nonNegativeSafeInteger(
      raw.validUntilMs,
      `${field}.validUntilMs`,
    ),
  };
  invariant(
    claim.validUntilMs - claim.claimedAtMs
      === SOURCE_IDENTITY_READ_CLAIM_LEASE_MS,
    "SOURCE_IDENTITY_ACTIVE_CLAIM_INVALID",
  );
  return claim;
}

function evidenceOnly(checkpoint) {
  if (!checkpoint) return null;
  return deepFreeze({
    identityPointReadProcedure:
      checkpoint.identityPointReadProcedure,
    identityNormalizedInputDigest:
      checkpoint.identityNormalizedInputDigest,
    candidateUserAliasDigest:
      checkpoint.candidateUserAliasDigest,
    canonicalCandidateDigest:
      checkpoint.canonicalCandidateDigest,
    identityPointRecordDigest:
      checkpoint.identityPointRecordDigest,
    identityPointRecordRevisionDigest:
      checkpoint.identityPointRecordRevisionDigest,
  });
}

function evidenceMatches(left, right) {
  return canonicalJson(evidenceOnly(left))
    === canonicalJson(evidenceOnly(right));
}

export function validateIdentityObservationRun(value) {
  const raw = object(value, "identity observation run");
  exactKeys(
    raw,
    [
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
    ],
    "SOURCE_IDENTITY_RUN_SHAPE_INVALID",
    "identity observation run",
  );
  invariant(
    raw.version === RUN_RECORD_VERSION
      && raw.policyVersion
        === SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION
      && raw.kind === "identity_observation_run_dark",
    "SOURCE_IDENTITY_RUN_VERSION_INVALID",
  );
  invariant(
    ["collecting", "work_set_complete", "sealed"].includes(
      raw.status,
    ),
    "SOURCE_IDENTITY_RUN_STATUS_INVALID",
  );
  const record = {
    version: raw.version,
    policyVersion: raw.policyVersion,
    kind: raw.kind,
    status: raw.status,
    runKeyDigest: digest(
      raw.runKeyDigest,
      "identity observation run.runKeyDigest",
    ),
    runNonceDigest: digest(
      raw.runNonceDigest,
      "identity observation run.runNonceDigest",
    ),
    decisionBoundaryAtMs: nonNegativeSafeInteger(
      raw.decisionBoundaryAtMs,
      "identity observation run.decisionBoundaryAtMs",
    ),
    contractPinsDigest: digest(
      raw.contractPinsDigest,
      "identity observation run.contractPinsDigest",
    ),
    workKeyDigests: [],
    workManifestDigest: optionalDigest(
      raw.workManifestDigest,
      "identity observation run.workManifestDigest",
    ),
    workManifestCount: raw.workManifestCount == null
      ? null
      : nonNegativeSafeInteger(
        raw.workManifestCount,
        "identity observation run.workManifestCount",
      ),
    createdAtMs: nonNegativeSafeInteger(
      raw.createdAtMs,
      "identity observation run.createdAtMs",
    ),
    updatedAtMs: nonNegativeSafeInteger(
      raw.updatedAtMs,
      "identity observation run.updatedAtMs",
    ),
    revision: nonNegativeSafeInteger(
      raw.revision,
      "identity observation run.revision",
    ),
    sealedArtifactDigest: optionalDigest(
      raw.sealedArtifactDigest,
      "identity observation run.sealedArtifactDigest",
    ),
    sealedHeadRecordDigest: optionalDigest(
      raw.sealedHeadRecordDigest,
      "identity observation run.sealedHeadRecordDigest",
    ),
  };
  invariant(
    Array.isArray(raw.workKeyDigests),
    "SOURCE_IDENTITY_RUN_WORK_INDEX_INVALID",
  );
  record.workKeyDigests = raw.workKeyDigests.map(
    (value, index) => digest(
      value,
      `identity observation run.workKeyDigests[${index}]`,
    ),
  );
  invariant(
    new Set(record.workKeyDigests).size
      === record.workKeyDigests.length
      && canonicalJson(record.workKeyDigests)
        === canonicalJson([...record.workKeyDigests].sort()),
    "SOURCE_IDENTITY_RUN_WORK_INDEX_INVALID",
    "identity work index must be unique and sorted",
  );
  invariant(
    record.runKeyDigest === runKeyDigestFor(record),
    "SOURCE_IDENTITY_RUN_KEY_INVALID",
  );
  invariant(
    record.decisionBoundaryAtMs <= record.createdAtMs
      && record.createdAtMs <= record.updatedAtMs,
    "SOURCE_IDENTITY_RUN_TIME_INVALID",
  );
  invariant(
    raw.status === "collecting"
      ? record.workManifestDigest === null
        && record.workManifestCount === null
      : record.workManifestDigest
          === workManifestDigestFor(record)
        && record.workManifestCount
          === record.workKeyDigests.length,
    "SOURCE_IDENTITY_WORK_MANIFEST_INVALID",
  );
  invariant(
    raw.status === "sealed"
      ? record.sealedArtifactDigest !== null
        && record.sealedHeadRecordDigest !== null
      : record.sealedArtifactDigest === null
        && record.sealedHeadRecordDigest === null,
    "SOURCE_IDENTITY_RUN_SEAL_INVALID",
  );
  return deepFreeze(record);
}

export function validateIdentityObservationWork(value) {
  const raw = object(value, "identity observation work");
  exactKeys(
    raw,
    [
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
    ],
    "SOURCE_IDENTITY_WORK_SHAPE_INVALID",
    "identity observation work",
  );
  invariant(
    raw.version === WORK_RECORD_VERSION
      && raw.policyVersion
        === SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION
      && raw.kind === "identity_observation_work_dark",
    "SOURCE_IDENTITY_WORK_VERSION_INVALID",
  );
  invariant(
    [
      "awaiting_read_1",
      "claimed_read_1",
      "awaiting_read_2",
      "claimed_read_2",
      "resolved",
      "unresolved",
      "conflict",
    ].includes(raw.status),
    "SOURCE_IDENTITY_WORK_STATUS_INVALID",
  );
  const record = {
    version: raw.version,
    policyVersion: raw.policyVersion,
    kind: raw.kind,
    status: raw.status,
    workKeyDigest: digest(
      raw.workKeyDigest,
      "identity observation work.workKeyDigest",
    ),
    runKeyDigest: digest(
      raw.runKeyDigest,
      "identity observation work.runKeyDigest",
    ),
    runNonceDigest: digest(
      raw.runNonceDigest,
      "identity observation work.runNonceDigest",
    ),
    decisionBoundaryAtMs: nonNegativeSafeInteger(
      raw.decisionBoundaryAtMs,
      "identity observation work.decisionBoundaryAtMs",
    ),
    contractPinsDigest: digest(
      raw.contractPinsDigest,
      "identity observation work.contractPinsDigest",
    ),
    workItemDigest: digest(
      raw.workItemDigest,
      "identity observation work.workItemDigest",
    ),
    privateWorkReference: privateReference(
      raw.privateWorkReference,
      "identity observation work.privateWorkReference",
    ),
    createdAtMs: nonNegativeSafeInteger(
      raw.createdAtMs,
      "identity observation work.createdAtMs",
    ),
    updatedAtMs: nonNegativeSafeInteger(
      raw.updatedAtMs,
      "identity observation work.updatedAtMs",
    ),
    revision: nonNegativeSafeInteger(
      raw.revision,
      "identity observation work.revision",
    ),
    activeClaim: activeClaim(
      raw.activeClaim,
      "identity observation work.activeClaim",
    ),
    readOne: checkpointEvidence(
      raw.readOne,
      "identity observation work.readOne",
    ),
    readTwo: checkpointEvidence(
      raw.readTwo,
      "identity observation work.readTwo",
    ),
    resolutionDigest: optionalDigest(
      raw.resolutionDigest,
      "identity observation work.resolutionDigest",
    ),
    terminalReason: raw.terminalReason == null
      ? null
      : reason(
        raw.terminalReason,
        "identity observation work.terminalReason",
      ),
  };
  invariant(
    record.runKeyDigest === runKeyDigestFor(record)
      && record.workKeyDigest === workKeyDigestFor(record),
    "SOURCE_IDENTITY_WORK_KEY_INVALID",
  );
  invariant(
    record.decisionBoundaryAtMs <= record.createdAtMs
      && record.createdAtMs <= record.updatedAtMs,
    "SOURCE_IDENTITY_WORK_TIME_INVALID",
  );
  if (record.readOne) {
    invariant(
      record.readOne.persistedAtMs >= record.createdAtMs
        && record.readOne.persistedAtMs <= record.updatedAtMs,
      "SOURCE_IDENTITY_WORK_TIME_INVALID",
    );
  }
  if (record.readTwo) {
    invariant(
      record.readOne !== null
        && record.readTwo.persistedAtMs
          >= record.readOne.persistedAtMs
        && record.readTwo.persistedAtMs <= record.updatedAtMs,
      "SOURCE_IDENTITY_WORK_TIME_INVALID",
    );
  }
  if (record.activeClaim) {
    invariant(
      record.activeClaim.claimedAtMs >= record.createdAtMs
        && record.activeClaim.claimedAtMs === record.updatedAtMs,
      "SOURCE_IDENTITY_WORK_TIME_INVALID",
    );
  }
  if (record.status === "awaiting_read_1") {
    invariant(
      record.activeClaim === null
        && record.readOne === null
        && record.readTwo === null
        && record.resolutionDigest === null
        && record.terminalReason === null,
      "SOURCE_IDENTITY_WORK_STATE_INVALID",
    );
  }
  if (record.status === "claimed_read_1") {
    invariant(
      record.activeClaim?.readNumber === 1
        && record.readOne === null
        && record.readTwo === null
        && record.resolutionDigest === null
        && record.terminalReason === null,
      "SOURCE_IDENTITY_WORK_STATE_INVALID",
    );
  }
  if (record.status === "awaiting_read_2") {
    invariant(
      record.activeClaim === null
        && record.readOne !== null
        && record.readTwo === null
        && record.resolutionDigest === null
        && record.terminalReason === null,
      "SOURCE_IDENTITY_WORK_STATE_INVALID",
    );
  }
  if (record.status === "claimed_read_2") {
    invariant(
      record.activeClaim?.readNumber === 2
        && record.readOne !== null
        && record.readTwo === null
        && record.resolutionDigest === null
        && record.terminalReason === null,
      "SOURCE_IDENTITY_WORK_STATE_INVALID",
    );
  }
  if (record.status === "resolved") {
    invariant(
      record.activeClaim === null
        && record.readOne !== null
        && record.readTwo !== null
        && evidenceMatches(record.readOne, record.readTwo)
        && record.readTwo.persistedAtMs
          - record.readOne.persistedAtMs
          <= SOURCE_IDENTITY_TWO_READ_MAX_INTERVAL_MS
        && record.resolutionDigest
          === resolvedObservationDigest(
            record,
            evidenceOnly(record.readOne),
          )
        && record.terminalReason === null,
      "SOURCE_IDENTITY_WORK_RESOLUTION_INVALID",
    );
  }
  if (record.status === "conflict") {
    invariant(
      record.activeClaim === null
        && record.readOne !== null
        && record.readTwo !== null
        && record.resolutionDigest === null
        && [
          "two_read_evidence_mismatch",
          "two_read_interval_exceeded",
        ].includes(record.terminalReason),
      "SOURCE_IDENTITY_WORK_CONFLICT_INVALID",
    );
  }
  if (record.status === "unresolved") {
    invariant(
      record.activeClaim === null
        && record.readTwo === null
        && record.resolutionDigest === null
        && [
          ...SOURCE_IDENTITY_UNRESOLVED_REASONS,
          ...SOURCE_IDENTITY_INTERNAL_UNRESOLVED_REASONS,
        ].includes(record.terminalReason),
      "SOURCE_IDENTITY_WORK_UNRESOLVED_INVALID",
    );
  }
  return deepFreeze(record);
}

function initialRun(input) {
  const normalized = canonicalRunInput(input);
  return {
    version: RUN_RECORD_VERSION,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    kind: "identity_observation_run_dark",
    status: "collecting",
    runKeyDigest: runKeyDigestFor(normalized),
    ...normalized,
    workKeyDigests: [],
    workManifestDigest: null,
    workManifestCount: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    revision: 0,
    sealedArtifactDigest: null,
    sealedHeadRecordDigest: null,
  };
}

function canonicalRunInput(value) {
  const raw = object(value, "identity observation run input");
  exactKeys(
    raw,
    [
      "runNonceDigest",
      "decisionBoundaryAtMs",
      "contractPinsDigest",
    ],
    "SOURCE_IDENTITY_RUN_INPUT_INVALID",
    "identity observation run input",
  );
  return {
    runNonceDigest: digest(
      raw.runNonceDigest,
      "identity observation run input.runNonceDigest",
    ),
    decisionBoundaryAtMs: nonNegativeSafeInteger(
      raw.decisionBoundaryAtMs,
      "identity observation run input.decisionBoundaryAtMs",
    ),
    contractPinsDigest: digest(
      raw.contractPinsDigest,
      "identity observation run input.contractPinsDigest",
    ),
  };
}

function canonicalCreateWorkInput(value) {
  const raw = object(value, "identity observation work input");
  exactKeys(
    raw,
    [
      "runNonceDigest",
      "decisionBoundaryAtMs",
      "contractPinsDigest",
      "workItemDigest",
      "privateWorkReference",
    ],
    "SOURCE_IDENTITY_WORK_INPUT_INVALID",
    "identity observation work input",
  );
  return {
    ...canonicalRunInput({
      runNonceDigest: raw.runNonceDigest,
      decisionBoundaryAtMs: raw.decisionBoundaryAtMs,
      contractPinsDigest: raw.contractPinsDigest,
    }),
    workItemDigest: digest(
      raw.workItemDigest,
      "identity observation work input.workItemDigest",
    ),
    privateWorkReference: privateReference(
      raw.privateWorkReference,
      "identity observation work input.privateWorkReference",
    ),
  };
}

function initialWork(input) {
  const runKeyDigest = runKeyDigestFor(input);
  return {
    version: WORK_RECORD_VERSION,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    kind: "identity_observation_work_dark",
    status: "awaiting_read_1",
    workKeyDigest: workKeyDigestFor({
      runKeyDigest,
      workItemDigest: input.workItemDigest,
    }),
    runKeyDigest,
    runNonceDigest: input.runNonceDigest,
    decisionBoundaryAtMs: input.decisionBoundaryAtMs,
    contractPinsDigest: input.contractPinsDigest,
    workItemDigest: input.workItemDigest,
    privateWorkReference: input.privateWorkReference,
    createdAtMs: 0,
    updatedAtMs: 0,
    revision: 0,
    activeClaim: null,
    readOne: null,
    readTwo: null,
    resolutionDigest: null,
    terminalReason: null,
  };
}

function kvConfiguration() {
  const url = String(
    process.env.PARAAI_SOURCE_IDENTITY_KV_REST_API_URL
    || "",
  ).replace(/\/+$/u, "");
  const token =
    process.env.PARAAI_SOURCE_IDENTITY_KV_REST_API_TOKEN
    || "";
  return {
    url,
    token,
    partial: Boolean(url) !== Boolean(token),
  };
}

export function sourceIdentityArtifactStoreConfigured() {
  const { url, token, partial } = kvConfiguration();
  return Boolean(!partial && url && token);
}

async function kv(command) {
  const { url, token, partial } = kvConfiguration();
  invariant(
    !partial,
    "SOURCE_IDENTITY_ARTIFACT_STORE_CONFIGURATION_INVALID",
  );
  invariant(
    url && token,
    "SOURCE_IDENTITY_ARTIFACT_STORE_UNAVAILABLE",
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8_000),
  });
  let body = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  invariant(
    response.ok && !body?.error,
    "SOURCE_IDENTITY_ARTIFACT_STORE_REQUEST_FAILED",
  );
  return body?.result ?? null;
}

function redisTime(result, offset, field) {
  invariant(
    Array.isArray(result)
      && /^\d+$/u.test(String(result[offset] || ""))
      && /^\d+$/u.test(String(result[offset + 1] || "")),
    "SOURCE_IDENTITY_REDIS_TIME_INVALID",
    `${field} did not return Redis TIME`,
  );
  const nowMs =
    Number(result[offset]) * 1_000
    + Math.floor(Number(result[offset + 1]) / 1_000);
  invariant(
    Number.isSafeInteger(nowMs) && nowMs >= 0,
    "SOURCE_IDENTITY_REDIS_TIME_INVALID",
  );
  return nowMs;
}

function parseJson(raw, code, field) {
  try {
    return JSON.parse(raw);
  } catch {
    fail(code, `${field} is malformed`);
  }
}

function parsedRunSnapshot(raw, nowMs) {
  const record = validateIdentityObservationRun(
    parseJson(
      raw,
      "SOURCE_IDENTITY_RUN_DURABLE_STATE_MALFORMED",
      "identity observation run",
    ),
  );
  invariant(
    record.updatedAtMs <= nowMs + REDIS_CLOCK_SKEW_MS,
    "SOURCE_IDENTITY_RUN_DURABLE_STATE_MALFORMED",
  );
  return deepFreeze({
    record,
    raw,
    rawSha1: rawSha1(raw),
    redisNowMs: nowMs,
  });
}

function parsedWorkSnapshot(raw, nowMs) {
  const record = validateIdentityObservationWork(
    parseJson(
      raw,
      "SOURCE_IDENTITY_WORK_DURABLE_STATE_MALFORMED",
      "identity observation work",
    ),
  );
  invariant(
    record.updatedAtMs <= nowMs + REDIS_CLOCK_SKEW_MS,
    "SOURCE_IDENTITY_WORK_DURABLE_STATE_MALFORMED",
  );
  return deepFreeze({
    record,
    raw,
    rawSha1: rawSha1(raw),
    redisNowMs: nowMs,
  });
}

const ENSURE_RUN_LUA = `
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local proposedOk, proposed = pcall(cjson.decode, ARGV[1])
  if not proposedOk or type(proposed) ~= 'table' then
    return {-9, '', redisTime[1], redisTime[2]}
  end
  local currentRaw = redis.call('GET', KEYS[1])
  if currentRaw then
    return {0, currentRaw, redisTime[1], redisTime[2]}
  end
  proposed.createdAtMs = nowMs
  proposed.updatedAtMs = nowMs
  local encoded = cjson.encode(proposed)
  redis.call('SET', KEYS[1], encoded)
  return {1, encoded, redisTime[1], redisTime[2]}
`;

const READ_ONE_LUA = `
  local redisTime = redis.call('TIME')
  return {
    redis.call('GET', KEYS[1]) or '',
    redisTime[1],
    redisTime[2]
  }
`;

const CREATE_WORK_LUA = `
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local runRaw = redis.call('GET', KEYS[1])
  if not runRaw then
    return {-4, '', '', redisTime[1], redisTime[2]}
  end
  if runRaw ~= ARGV[1] then
    return {-3, runRaw, '', redisTime[1], redisTime[2]}
  end
  local runOk, run = pcall(cjson.decode, runRaw)
  local workOk, work = pcall(cjson.decode, ARGV[2])
  if not runOk or not workOk
    or type(run) ~= 'table' or type(work) ~= 'table'
    or run.status ~= 'collecting'
    or work.runKeyDigest ~= run.runKeyDigest
    or work.runNonceDigest ~= run.runNonceDigest
    or work.decisionBoundaryAtMs ~= run.decisionBoundaryAtMs
    or work.contractPinsDigest ~= run.contractPinsDigest
    or work.workKeyDigest ~= ARGV[3] then
    return {-9, runRaw, '', redisTime[1], redisTime[2]}
  end
  local currentWork = redis.call('GET', KEYS[2])
  local indexed = false
  for index = 1, #run.workKeyDigests do
    if run.workKeyDigests[index] == ARGV[3] then
      indexed = true
    end
  end
  if indexed and not currentWork then
    return {-5, runRaw, '', redisTime[1], redisTime[2]}
  end
  if currentWork and not indexed then
    return {-8, runRaw, currentWork, redisTime[1], redisTime[2]}
  end
  if currentWork then
    return {0, runRaw, currentWork, redisTime[1], redisTime[2]}
  end
  work.createdAtMs = nowMs
  work.updatedAtMs = nowMs
  local encodedWork = cjson.encode(work)
  redis.call('SET', KEYS[2], encodedWork, 'PX', ARGV[4])
  table.insert(run.workKeyDigests, ARGV[3])
  table.sort(run.workKeyDigests)
  run.updatedAtMs = nowMs
  run.revision = run.revision + 1
  local encodedRun = cjson.encode(run)
  redis.call('SET', KEYS[1], encodedRun)
  return {1, encodedRun, encodedWork, redisTime[1], redisTime[2]}
`;

const FINALIZE_WORK_SET_LUA = `
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local currentRaw = redis.call('GET', KEYS[1])
  if not currentRaw then
    return {-4, '', redisTime[1], redisTime[2]}
  end
  if currentRaw ~= ARGV[1] then
    return {-3, currentRaw, redisTime[1], redisTime[2]}
  end
  local currentOk, current = pcall(cjson.decode, currentRaw)
  if not currentOk or type(current) ~= 'table'
    or current.status ~= 'collecting'
    or tonumber(ARGV[3]) ~= #current.workKeyDigests
    or #KEYS - 1 ~= #current.workKeyDigests then
    return {-7, currentRaw, redisTime[1], redisTime[2]}
  end
  for index = 2, #KEYS do
    local workRaw = redis.call('GET', KEYS[index])
    if not workRaw then
      return {-5, currentRaw, redisTime[1], redisTime[2]}
    end
    local workOk, work = pcall(cjson.decode, workRaw)
    local expectedWorkKey = current.workKeyDigests[index - 1]
    if not workOk or type(work) ~= 'table'
      or work.workKeyDigest ~= expectedWorkKey
      or work.runKeyDigest ~= current.runKeyDigest
      or work.runNonceDigest ~= current.runNonceDigest
      or work.decisionBoundaryAtMs
        ~= current.decisionBoundaryAtMs
      or work.contractPinsDigest
        ~= current.contractPinsDigest then
      return {-8, currentRaw, redisTime[1], redisTime[2]}
    end
  end
  current.status = 'work_set_complete'
  current.workManifestDigest = ARGV[2]
  current.workManifestCount = tonumber(ARGV[3])
  current.updatedAtMs = nowMs
  current.revision = current.revision + 1
  local encoded = cjson.encode(current)
  redis.call('SET', KEYS[1], encoded)
  return {1, encoded, redisTime[1], redisTime[2]}
`;

const CLAIM_READ_LUA = `
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local currentRaw = redis.call('GET', KEYS[1])
  if not currentRaw then
    return {-4, '', redisTime[1], redisTime[2]}
  end
  if currentRaw ~= ARGV[1] then
    return {-3, currentRaw, redisTime[1], redisTime[2]}
  end
  local currentOk, current = pcall(cjson.decode, currentRaw)
  local readNumber = tonumber(ARGV[3])
  if not currentOk or type(current) ~= 'table'
    or (readNumber ~= 1 and readNumber ~= 2)
    or (
      readNumber == 1
      and current.status ~= 'awaiting_read_1'
    ) or (
      readNumber == 2
      and current.status ~= 'awaiting_read_2'
    ) then
    return {-7, currentRaw, redisTime[1], redisTime[2]}
  end
  current.status = readNumber == 1
    and 'claimed_read_1' or 'claimed_read_2'
  current.activeClaim = {
    readNumber = readNumber,
    claimNonceDigest = ARGV[2],
    claimedAtMs = nowMs,
    validUntilMs = nowMs + tonumber(ARGV[4])
  }
  current.updatedAtMs = nowMs
  current.revision = current.revision + 1
  local encoded = cjson.encode(current)
  redis.call('SET', KEYS[1], encoded, 'KEEPTTL')
  return {1, encoded, redisTime[1], redisTime[2]}
`;

const CHECKPOINT_READ_LUA = `
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local currentRaw = redis.call('GET', KEYS[1])
  if not currentRaw then
    return {-4, '', redisTime[1], redisTime[2]}
  end
  if currentRaw ~= ARGV[1] then
    return {-3, currentRaw, redisTime[1], redisTime[2]}
  end
  local currentOk, current = pcall(cjson.decode, currentRaw)
  local evidenceOk, evidence = pcall(cjson.decode, ARGV[2])
  local readNumber = tonumber(ARGV[4])
  if not currentOk or not evidenceOk
    or type(current) ~= 'table'
    or type(evidence) ~= 'table'
    or type(ARGV[3]) ~= 'string'
    or (readNumber ~= 1 and readNumber ~= 2) then
    return {-9, currentRaw, redisTime[1], redisTime[2]}
  end
  evidence.claimNonceDigest = ARGV[3]
  evidence.persistedAtMs = nowMs
  if readNumber == 1 then
    if current.status ~= 'claimed_read_1'
      or current.readOne ~= cjson.null
      or type(current.activeClaim) ~= 'table'
      or current.activeClaim.readNumber ~= 1
      or current.activeClaim.claimNonceDigest ~= ARGV[3]
      or nowMs > tonumber(current.activeClaim.validUntilMs) then
      return {-7, currentRaw, redisTime[1], redisTime[2]}
    end
    current.readOne = evidence
    current.status = 'awaiting_read_2'
    current.activeClaim = cjson.null
  else
    if current.status ~= 'claimed_read_2'
      or type(current.readOne) ~= 'table'
      or current.readTwo ~= cjson.null
      or type(current.activeClaim) ~= 'table'
      or current.activeClaim.readNumber ~= 2
      or current.activeClaim.claimNonceDigest ~= ARGV[3]
      or nowMs > tonumber(current.activeClaim.validUntilMs) then
      return {-7, currentRaw, redisTime[1], redisTime[2]}
    end
    current.readTwo = evidence
    current.activeClaim = cjson.null
    local withinInterval =
      nowMs >= tonumber(current.readOne.persistedAtMs)
      and nowMs - tonumber(current.readOne.persistedAtMs)
        <= tonumber(ARGV[5])
    local same = (
      current.readOne.identityPointReadProcedure
        == evidence.identityPointReadProcedure
      and current.readOne.identityNormalizedInputDigest
        == evidence.identityNormalizedInputDigest
      and current.readOne.candidateUserAliasDigest
        == evidence.candidateUserAliasDigest
      and current.readOne.canonicalCandidateDigest
        == evidence.canonicalCandidateDigest
      and current.readOne.identityPointRecordDigest
        == evidence.identityPointRecordDigest
      and current.readOne.identityPointRecordRevisionDigest
        == evidence.identityPointRecordRevisionDigest
      and current.readOne.evidenceDigest
        == evidence.evidenceDigest
    )
    if not withinInterval then
      current.status = 'conflict'
      current.terminalReason = 'two_read_interval_exceeded'
    elseif not same then
      current.status = 'conflict'
      current.terminalReason = 'two_read_evidence_mismatch'
    else
      current.status = 'resolved'
      current.resolutionDigest = ARGV[6]
    end
  end
  current.updatedAtMs = nowMs
  current.revision = current.revision + 1
  local encoded = cjson.encode(current)
  redis.call('SET', KEYS[1], encoded, 'KEEPTTL')
  return {1, encoded, redisTime[1], redisTime[2]}
`;

const CLOSE_UNRESOLVED_LUA = `
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local currentRaw = redis.call('GET', KEYS[1])
  if not currentRaw then
    return {-4, '', redisTime[1], redisTime[2]}
  end
  if currentRaw ~= ARGV[1] then
    return {-3, currentRaw, redisTime[1], redisTime[2]}
  end
  local currentOk, current = pcall(cjson.decode, currentRaw)
  if not currentOk or type(current) ~= 'table'
    or (current.status ~= 'awaiting_read_1'
      and current.status ~= 'claimed_read_1'
      and current.status ~= 'awaiting_read_2'
      and current.status ~= 'claimed_read_2') then
    return {-7, currentRaw, redisTime[1], redisTime[2]}
  end
  current.status = 'unresolved'
  current.activeClaim = cjson.null
  current.terminalReason = ARGV[2]
  current.updatedAtMs = nowMs
  current.revision = current.revision + 1
  local encoded = cjson.encode(current)
  redis.call('SET', KEYS[1], encoded, 'KEEPTTL')
  return {1, encoded, redisTime[1], redisTime[2]}
`;

const READ_WORK_SET_LUA = `
  local redisTime = redis.call('TIME')
  local runRaw = redis.call('GET', KEYS[1])
  if not runRaw or runRaw ~= ARGV[1] then
    return {-3, redisTime[1], redisTime[2]}
  end
  local result = {1, redisTime[1], redisTime[2]}
  for index = 2, #KEYS do
    local raw = redis.call('GET', KEYS[index])
    if not raw then
      return {-4, redisTime[1], redisTime[2]}
    end
    table.insert(result, raw)
  end
  return result
`;

const SEAL_ARTIFACT_LUA = `
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local runRaw = redis.call('GET', KEYS[1])
  if not runRaw then
    return {-4, '', '', redisTime[1], redisTime[2]}
  end
  if runRaw ~= ARGV[1] then
    return {-3, runRaw, '', redisTime[1], redisTime[2]}
  end
  local runOk, run = pcall(cjson.decode, runRaw)
  local headOk, head = pcall(cjson.decode, ARGV[2])
  if not runOk or not headOk
    or type(run) ~= 'table' or type(head) ~= 'table'
    or run.status ~= 'work_set_complete'
    or head.sealedArtifactDigest ~= ARGV[3]
    or head.runNonceDigest ~= run.runNonceDigest
    or head.decisionBoundaryAtMs ~= run.decisionBoundaryAtMs
    or head.contractPinsDigest ~= run.contractPinsDigest
    or head.workManifestDigest ~= run.workManifestDigest
    or head.workManifestCount ~= run.workManifestCount then
    return {-9, runRaw, '', redisTime[1], redisTime[2]}
  end
  local immutableCount = tonumber(ARGV[4])
  local workCount = tonumber(ARGV[6])
  if workCount ~= run.workManifestCount
    or immutableCount ~= #KEYS - 1 - workCount
    or immutableCount < 2 then
    return {-9, runRaw, '', redisTime[1], redisTime[2]}
  end
  for index = 2, workCount + 1 do
    local expectedWorkRaw = ARGV[index + 5]
    local currentWorkRaw = redis.call('GET', KEYS[index])
    if not currentWorkRaw or currentWorkRaw ~= expectedWorkRaw then
      return {-10, runRaw, currentWorkRaw or '',
        redisTime[1], redisTime[2]}
    end
  end
  for index = workCount + 2, #KEYS do
    local proposedRaw = ARGV[index + 5]
    local existing = redis.call('GET', KEYS[index])
    if existing and existing ~= proposedRaw then
      return {-6, runRaw, existing, redisTime[1], redisTime[2]}
    end
  end
  for index = workCount + 2, #KEYS do
    local proposedRaw = ARGV[index + 5]
    redis.call('SETNX', KEYS[index], proposedRaw)
    local readback = redis.call('GET', KEYS[index])
    if readback ~= proposedRaw then
      return {-5, runRaw, readback or '', redisTime[1], redisTime[2]}
    end
  end
  run.status = 'sealed'
  run.sealedArtifactDigest = ARGV[3]
  run.sealedHeadRecordDigest = ARGV[5]
  run.updatedAtMs = nowMs
  run.revision = run.revision + 1
  local encodedRun = cjson.encode(run)
  redis.call('SET', KEYS[1], encodedRun)
  return {1, encodedRun, ARGV[2], redisTime[1], redisTime[2]}
`;

export async function ensureIdentityObservationRun(input) {
  const proposed = initialRun(input);
  const result = await kv([
    "EVAL",
    ENSURE_RUN_LUA,
    1,
    `${RUN_KEY_PREFIX}${proposed.runKeyDigest}`,
    JSON.stringify(proposed),
  ]);
  invariant(
    Array.isArray(result) && [0, 1].includes(Number(result[0])),
    "SOURCE_IDENTITY_RUN_DURABLE_STATE_MALFORMED",
  );
  const nowMs = redisTime(
    result,
    2,
    "identity observation run ensure",
  );
  return parsedRunSnapshot(result[1], nowMs);
}

export async function readIdentityObservationRun(input) {
  const normalized = canonicalRunInput(input);
  const runKeyDigest = runKeyDigestFor(normalized);
  const result = await kv([
    "EVAL",
    READ_ONE_LUA,
    1,
    `${RUN_KEY_PREFIX}${runKeyDigest}`,
  ]);
  invariant(
    Array.isArray(result),
    "SOURCE_IDENTITY_RUN_DURABLE_STATE_MALFORMED",
  );
  const nowMs = redisTime(
    result,
    1,
    "identity observation run read",
  );
  if (!result[0]) {
    return deepFreeze({
      record: null,
      raw: null,
      rawSha1: null,
      redisNowMs: nowMs,
    });
  }
  return parsedRunSnapshot(result[0], nowMs);
}

export async function createIdentityObservationWork(input) {
  const normalized = canonicalCreateWorkInput(input);
  const proposed = initialWork(normalized);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const run = await ensureIdentityObservationRun({
      runNonceDigest: normalized.runNonceDigest,
      decisionBoundaryAtMs: normalized.decisionBoundaryAtMs,
      contractPinsDigest: normalized.contractPinsDigest,
    });
    invariant(
      run.record.status === "collecting",
      "SOURCE_IDENTITY_RUN_ALREADY_SEALED",
    );
    const result = await kv([
      "EVAL",
      CREATE_WORK_LUA,
      2,
      `${RUN_KEY_PREFIX}${proposed.runKeyDigest}`,
      `${WORK_KEY_PREFIX}${proposed.workKeyDigest}`,
      run.raw,
      JSON.stringify(proposed),
      proposed.workKeyDigest,
      String(SOURCE_IDENTITY_PRIVATE_WORK_TTL_MS),
    ]);
    invariant(
      Array.isArray(result),
      "SOURCE_IDENTITY_WORK_DURABLE_STATE_MALFORMED",
    );
    if (Number(result[0]) === -3) continue;
    if (Number(result[0]) === -5) {
      fail(
        "SOURCE_IDENTITY_PRIVATE_WORK_STATE_LOST",
        "indexed private identity work expired before sealing",
      );
    }
    if (Number(result[0]) === -8) {
      fail(
        "SOURCE_IDENTITY_WORK_INDEX_MISMATCH",
        "private identity work exists outside its run index",
      );
    }
    invariant(
      [0, 1].includes(Number(result[0])),
      "SOURCE_IDENTITY_WORK_DURABLE_STATE_MALFORMED",
    );
    const nowMs = redisTime(
      result,
      3,
      "identity observation work create",
    );
    const snapshot = parsedWorkSnapshot(result[2], nowMs);
    invariant(
      snapshot.record.workKeyDigest === proposed.workKeyDigest
        && snapshot.record.runKeyDigest === proposed.runKeyDigest
        && snapshot.record.workItemDigest
          === proposed.workItemDigest
        && snapshot.record.privateWorkReference
          === proposed.privateWorkReference,
      "SOURCE_IDENTITY_WORK_IDEMPOTENCY_CONFLICT",
    );
    return snapshot;
  }
  fail(
    "SOURCE_IDENTITY_WORK_CREATE_CONFLICT",
    "identity work index changed during creation",
  );
}

// This is the explicit observed-index registration boundary. It accepts no
// caller-provided work IDs, count, or manifest digest: the store freezes and
// commits the exact sorted index it already owns. Artifact preparation is
// impossible before this transition. This does NOT prove equality with an
// exhaustive upstream universe. The separate Paraform Human runtime must
// durably retain that equality proof before any later pin review; this
// transition alone leaves every artifact hard-dark and unpinnable.
export async function finalizeIdentityObservationWorkSet(input) {
  const normalized = canonicalRunInput(input);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const run = await readIdentityObservationRun(normalized);
    invariant(
      run.record,
      "SOURCE_IDENTITY_RUN_NOT_FOUND",
    );
    if (
      ["work_set_complete", "sealed"].includes(
        run.record.status,
      )
    ) {
      return run;
    }
    const manifestDigest = workManifestDigestFor(
      run.record,
    );
    const workKeys = run.record.workKeyDigests.map(
      (workKey) => `${WORK_KEY_PREFIX}${workKey}`,
    );
    const result = await kv([
      "EVAL",
      FINALIZE_WORK_SET_LUA,
      1 + workKeys.length,
      `${RUN_KEY_PREFIX}${run.record.runKeyDigest}`,
      ...workKeys,
      run.raw,
      manifestDigest,
      String(run.record.workKeyDigests.length),
    ]);
    invariant(
      Array.isArray(result),
      "SOURCE_IDENTITY_WORK_MANIFEST_MALFORMED",
    );
    if (Number(result[0]) === -3) continue;
    if (Number(result[0]) === -5) {
      fail(
        "SOURCE_IDENTITY_PRIVATE_WORK_STATE_LOST",
        "indexed private identity work expired before finalization",
      );
    }
    if (Number(result[0]) === -8) {
      fail(
        "SOURCE_IDENTITY_WORK_INDEX_MISMATCH",
        "indexed private identity work is context-invalid",
      );
    }
    invariant(
      Number(result[0]) === 1,
      "SOURCE_IDENTITY_WORK_MANIFEST_MALFORMED",
    );
    return parsedRunSnapshot(
      result[1],
      redisTime(
        result,
        2,
        "identity work manifest finalize",
      ),
    );
  }
  fail(
    "SOURCE_IDENTITY_WORK_MANIFEST_CONFLICT",
    "identity work index changed during finalization",
  );
}

export async function readIdentityObservationWork({
  workKeyDigest,
}) {
  const keyDigest = digest(
    workKeyDigest,
    "identity observation work key",
  );
  const result = await kv([
    "EVAL",
    READ_ONE_LUA,
    1,
    `${WORK_KEY_PREFIX}${keyDigest}`,
  ]);
  invariant(
    Array.isArray(result),
    "SOURCE_IDENTITY_WORK_DURABLE_STATE_MALFORMED",
  );
  const nowMs = redisTime(
    result,
    1,
    "identity observation work read",
  );
  invariant(
    result[0],
    "SOURCE_IDENTITY_WORK_NOT_FOUND",
  );
  const snapshot = parsedWorkSnapshot(result[0], nowMs);
  invariant(
    snapshot.record.workKeyDigest === keyDigest,
    "SOURCE_IDENTITY_WORK_KEY_INVALID",
  );
  return snapshot;
}

function completeClaim(record) {
  return deepFreeze({
    status: "complete",
    workKeyDigest: record.workKeyDigest,
    outcome: record.status,
  });
}

function inProgressClaim(record) {
  return deepFreeze({
    status: "in_progress",
    workKeyDigest: record.workKeyDigest,
  });
}

async function closeUnresolvedSnapshot(snapshot, reasonCode) {
  const normalizedReason = reason(
    reasonCode,
    "identity observation unresolved reason",
  );
  const result = await kv([
    "EVAL",
    CLOSE_UNRESOLVED_LUA,
    1,
    `${WORK_KEY_PREFIX}${snapshot.record.workKeyDigest}`,
    snapshot.raw,
    normalizedReason,
  ]);
  invariant(
    Array.isArray(result),
    "SOURCE_IDENTITY_WORK_DURABLE_STATE_MALFORMED",
  );
  if (Number(result[0]) === -3) {
    return null;
  }
  invariant(
    Number(result[0]) === 1,
    "SOURCE_IDENTITY_WORK_DURABLE_STATE_MALFORMED",
  );
  return parsedWorkSnapshot(
    result[1],
    redisTime(result, 2, "identity unresolved checkpoint"),
  );
}

// The caller cannot select read one or read two. Durable state selects the
// next read, so a process restarted after read one resumes at read two. A
// terminal work item returns an explicit no-op and can never cause a third
// provider read.
async function claimIdentityObservationReadAttempt(
  workKeyDigest,
  attemptsRemaining,
) {
  let snapshot = await readIdentityObservationWork({
    workKeyDigest,
  });
  const { record } = snapshot;
  if (
    ["resolved", "unresolved", "conflict"].includes(
      record.status,
    )
  ) {
    return completeClaim(record);
  }
  if (
    ["claimed_read_1", "claimed_read_2"].includes(
      record.status,
    )
  ) {
    if (
      snapshot.redisNowMs <= record.activeClaim.validUntilMs
    ) {
      return inProgressClaim(record);
    }
    const closed = await closeUnresolvedSnapshot(
      snapshot,
      "identity_read_claim_abandoned",
    );
    if (closed) return completeClaim(closed.record);
    invariant(
      attemptsRemaining > 0,
      "SOURCE_IDENTITY_CLAIM_CONFLICT",
    );
    return claimIdentityObservationReadAttempt(
      workKeyDigest,
      attemptsRemaining - 1,
    );
  }
  if (
    record.status === "awaiting_read_2"
    && snapshot.redisNowMs
      - record.readOne.persistedAtMs
      > SOURCE_IDENTITY_TWO_READ_MAX_INTERVAL_MS
  ) {
    const closed = await closeUnresolvedSnapshot(
      snapshot,
      "two_read_interval_expired",
    );
    if (!closed) {
      snapshot = await readIdentityObservationWork({
        workKeyDigest,
      });
      invariant(
        attemptsRemaining > 0,
        "SOURCE_IDENTITY_CLAIM_CONFLICT",
      );
      return ["resolved", "unresolved", "conflict"].includes(
        snapshot.record.status,
      )
        ? completeClaim(snapshot.record)
        : claimIdentityObservationReadAttempt(
          workKeyDigest,
          attemptsRemaining - 1,
        );
    }
    return completeClaim(closed.record);
  }
  const readNumber =
    record.status === "awaiting_read_1" ? 1 : 2;
  const claimNonceDigest = randomBytes(32).toString("hex");
  const result = await kv([
    "EVAL",
    CLAIM_READ_LUA,
    1,
    `${WORK_KEY_PREFIX}${record.workKeyDigest}`,
    snapshot.raw,
    claimNonceDigest,
    String(readNumber),
    String(SOURCE_IDENTITY_READ_CLAIM_LEASE_MS),
  ]);
  invariant(
    Array.isArray(result),
    "SOURCE_IDENTITY_WORK_DURABLE_STATE_MALFORMED",
  );
  if (Number(result[0]) === -3) {
    invariant(
      attemptsRemaining > 0,
      "SOURCE_IDENTITY_CLAIM_CONFLICT",
    );
    return claimIdentityObservationReadAttempt(
      workKeyDigest,
      attemptsRemaining - 1,
    );
  }
  invariant(
    Number(result[0]) === 1,
    "SOURCE_IDENTITY_WORK_DURABLE_STATE_MALFORMED",
  );
  const claimedSnapshot = parsedWorkSnapshot(
    result[1],
    redisTime(result, 2, "identity read claim"),
  );
  invariant(
    claimedSnapshot.record.status
      === `claimed_read_${readNumber}`
      && claimedSnapshot.record.activeClaim.readNumber
        === readNumber
      && claimedSnapshot.record.activeClaim.claimNonceDigest
        === claimNonceDigest,
    "SOURCE_IDENTITY_CLAIM_DURABILITY_INVALID",
  );
  const claim = deepFreeze({
    status: "read_required",
    workKeyDigest: record.workKeyDigest,
    readNumber,
    privateWorkReference: record.privateWorkReference,
    runNonceDigest: record.runNonceDigest,
    decisionBoundaryAtMs: record.decisionBoundaryAtMs,
    contractPinsDigest: record.contractPinsDigest,
    workItemDigest: record.workItemDigest,
    claimNonceDigest,
    firstEvidence: readNumber === 2
      ? evidenceOnly(record.readOne)
      : null,
  });
  ISSUED_READ_CLAIMS.set(claim, {
    raw: claimedSnapshot.raw,
    record: claimedSnapshot.record,
  });
  return claim;
}

export async function claimIdentityObservationRead({
  workKeyDigest,
}) {
  const keyDigest = digest(
    workKeyDigest,
    "identity observation work key",
  );
  return claimIdentityObservationReadAttempt(keyDigest, 4);
}

export async function checkpointIdentityObservationRead(
  claim,
  evidenceValue,
) {
  invariant(
    claim
      && typeof claim === "object"
      && ISSUED_READ_CLAIMS.has(claim),
    "SOURCE_IDENTITY_CLAIM_INVALID",
  );
  const issued = ISSUED_READ_CLAIMS.get(claim);
  ISSUED_READ_CLAIMS.delete(claim);
  const evidence = canonicalEvidence(evidenceValue);
  invariant(
    claim.workKeyDigest === issued.record.workKeyDigest
      && claim.runNonceDigest === issued.record.runNonceDigest
      && claim.decisionBoundaryAtMs
        === issued.record.decisionBoundaryAtMs
      && claim.contractPinsDigest
        === issued.record.contractPinsDigest
      && claim.workItemDigest === issued.record.workItemDigest
      && claim.privateWorkReference
        === issued.record.privateWorkReference
      && claim.readNumber
        === (
          issued.record.status === "claimed_read_1"
            ? 1
            : 2
        ),
    "SOURCE_IDENTITY_CLAIM_BINDING_INVALID",
  );
  const evidenceWithDigest = {
    ...evidence,
    evidenceDigest: observationEvidenceDigest(evidence),
  };
  const resolutionDigest = resolvedObservationDigest(
    issued.record,
    evidence,
  );
  const result = await kv([
    "EVAL",
    CHECKPOINT_READ_LUA,
    1,
    `${WORK_KEY_PREFIX}${issued.record.workKeyDigest}`,
    issued.raw,
    JSON.stringify(evidenceWithDigest),
    claim.claimNonceDigest,
    String(claim.readNumber),
    String(SOURCE_IDENTITY_TWO_READ_MAX_INTERVAL_MS),
    resolutionDigest,
  ]);
  invariant(
    Array.isArray(result),
    "SOURCE_IDENTITY_WORK_DURABLE_STATE_MALFORMED",
  );
  if (Number(result[0]) === -3) {
    fail(
      "SOURCE_IDENTITY_CHECKPOINT_CONFLICT",
      "identity work changed after its read claim",
    );
  }
  invariant(
    Number(result[0]) === 1,
    "SOURCE_IDENTITY_WORK_DURABLE_STATE_MALFORMED",
  );
  const snapshot = parsedWorkSnapshot(
    result[1],
    redisTime(result, 2, "identity read checkpoint"),
  );
  if (claim.readNumber === 1) {
    invariant(
      snapshot.record.status === "awaiting_read_2"
        && evidenceMatches(snapshot.record.readOne, evidence),
      "SOURCE_IDENTITY_FIRST_READ_NOT_PERSISTED",
    );
  } else {
    invariant(
      ["resolved", "conflict"].includes(
        snapshot.record.status,
      ),
      "SOURCE_IDENTITY_SECOND_READ_NOT_SETTLED",
    );
  }
  return snapshot;
}

export async function recordIdentityObservationUnresolved(
  claim,
  reasonCode,
) {
  invariant(
    claim
      && typeof claim === "object"
      && ISSUED_READ_CLAIMS.has(claim),
    "SOURCE_IDENTITY_CLAIM_INVALID",
  );
  invariant(
    SOURCE_IDENTITY_UNRESOLVED_REASONS.includes(reasonCode),
    "SOURCE_IDENTITY_UNRESOLVED_REASON_INVALID",
  );
  const issued = ISSUED_READ_CLAIMS.get(claim);
  ISSUED_READ_CLAIMS.delete(claim);
  const snapshot = await closeUnresolvedSnapshot({
    record: issued.record,
    raw: issued.raw,
  }, reasonCode);
  invariant(
    snapshot,
    "SOURCE_IDENTITY_CHECKPOINT_CONFLICT",
  );
  return snapshot;
}

function aliasEntry(record) {
  const evidence = evidenceOnly(record.readOne);
  return {
    candidateUserAliasDigest:
      evidence.candidateUserAliasDigest,
    canonicalCandidateDigest:
      evidence.canonicalCandidateDigest,
    identityPointReadProcedure:
      evidence.identityPointReadProcedure,
    identityNormalizedInputDigest:
      evidence.identityNormalizedInputDigest,
    identityPointRecordDigest:
      evidence.identityPointRecordDigest,
    identityPointRecordRevisionDigest:
      evidence.identityPointRecordRevisionDigest,
    workItemDigest: record.workItemDigest,
    resolutionDigest: record.resolutionDigest,
  };
}

function terminalWorkCommitment(record) {
  return semanticDigest(
    "phase4-source-identity-terminal-work-v1",
    {
      workKeyDigest: record.workKeyDigest,
      workItemDigest: record.workItemDigest,
      status: record.status,
      readOneEvidenceDigest:
        record.readOne?.evidenceDigest || null,
      readTwoEvidenceDigest:
        record.readTwo?.evidenceDigest || null,
      resolutionDigest: record.resolutionDigest,
      terminalReason: record.terminalReason,
    },
  );
}

function terminalWorkSetDigest(records) {
  return semanticDigest(
    "phase4-source-identity-terminal-work-set-v1",
    [...records]
      .sort((left, right) => (
        left.workKeyDigest.localeCompare(right.workKeyDigest)
      ))
      .map((record) => ({
        workKeyDigest: record.workKeyDigest,
        terminalWorkCommitment:
          terminalWorkCommitment(record),
      })),
  );
}

function ambiguousResolvedWorkKeys(records) {
  const aliasTargets = new Map();
  const canonicalTargets = new Map();
  for (const record of records) {
    if (record.status !== "resolved") continue;
    const evidence = evidenceOnly(record.readOne);
    const aliases = aliasTargets.get(
      evidence.candidateUserAliasDigest,
    ) || new Map();
    const aliasWorks = aliases.get(
      evidence.canonicalCandidateDigest,
    ) || [];
    aliasWorks.push(record.workKeyDigest);
    aliases.set(
      evidence.canonicalCandidateDigest,
      aliasWorks,
    );
    aliasTargets.set(
      evidence.candidateUserAliasDigest,
      aliases,
    );
    const canonicals = canonicalTargets.get(
      evidence.canonicalCandidateDigest,
    ) || new Map();
    const canonicalWorks = canonicals.get(
      evidence.candidateUserAliasDigest,
    ) || [];
    canonicalWorks.push(record.workKeyDigest);
    canonicals.set(
      evidence.candidateUserAliasDigest,
      canonicalWorks,
    );
    canonicalTargets.set(
      evidence.canonicalCandidateDigest,
      canonicals,
    );
  }
  const conflicted = new Set();
  for (const targets of [
    ...aliasTargets.values(),
    ...canonicalTargets.values(),
  ]) {
    for (const workKeys of targets.values()) {
      if (targets.size > 1 || workKeys.length > 1) {
        for (const workKey of workKeys) {
          conflicted.add(workKey);
        }
      }
    }
  }
  return conflicted;
}

function cursorFor(runKeyDigest, pageNumber) {
  return semanticDigest(
    "phase4-source-identity-alias-page-cursor-v1",
    { runKeyDigest, pageNumber },
  );
}

function pageSemanticDigest(entries) {
  return semanticDigest(
    "phase4-source-identity-alias-page-semantic-v1",
    entries,
  );
}

function artifactDigestFor(headMaterial) {
  return semanticDigest(
    "phase4-source-identity-alias-artifact-v1",
    headMaterial,
  );
}

function exactStoredRaw(record) {
  return JSON.stringify(record);
}

function artifactRecords(run, works) {
  const ambiguous = ambiguousResolvedWorkKeys(works);
  const entries = works
    .filter(
      (record) => (
        record.status === "resolved"
        && !ambiguous.has(record.workKeyDigest)
      ),
    )
    .map(aliasEntry)
    .sort((left, right) => (
      left.candidateUserAliasDigest.localeCompare(
        right.candidateUserAliasDigest,
      )
      || left.canonicalCandidateDigest.localeCompare(
        right.canonicalCandidateDigest,
      )
      || left.workItemDigest.localeCompare(
        right.workItemDigest,
      )
    ));
  const entryPages = [];
  for (
    let offset = 0;
    offset < entries.length;
    offset += SOURCE_IDENTITY_ALIAS_PAGE_SIZE
  ) {
    entryPages.push(
      entries.slice(
        offset,
        offset + SOURCE_IDENTITY_ALIAS_PAGE_SIZE,
      ),
    );
  }
  if (entryPages.length === 0) entryPages.push([]);
  const pageCount = entryPages.length;
  const pageRecords = entryPages.map((pageEntries, index) => {
    const pageNumber = index + 1;
    return {
      version: ARTIFACT_PAGE_VERSION,
      policyVersion:
        SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
      kind: "identity_alias_artifact_page_dark",
      runNonceDigest: run.runNonceDigest,
      decisionBoundaryAtMs: run.decisionBoundaryAtMs,
      contractPinsDigest: run.contractPinsDigest,
      pageNumber,
      pageSize: SOURCE_IDENTITY_ALIAS_PAGE_SIZE,
      cursorToken: pageNumber === 1
        ? null
        : cursorFor(run.runKeyDigest, pageNumber),
      nextCursorToken: pageNumber === pageCount
        ? null
        : cursorFor(run.runKeyDigest, pageNumber + 1),
      entryCount: pageEntries.length,
      entries: pageEntries,
    };
  });
  const pageRaws = pageRecords.map(exactStoredRaw);
  const pages = pageRecords.map((record, index) => ({
    pageNumber: record.pageNumber,
    cursorToken: record.cursorToken,
    nextCursorToken: record.nextCursorToken,
    entryCount: record.entryCount,
    pageRecordDigest: rawDigest(pageRaws[index]),
    pageSemanticDigest: pageSemanticDigest(record.entries),
  }));
  const unresolvedWorkCount = works.filter(
    (record) => record.status === "unresolved",
  ).length;
  const conflictWorkCount = works.filter(
    (record) => record.status === "conflict",
  ).length + ambiguous.size;
  const headMaterial = {
    version: ARTIFACT_HEAD_VERSION,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    kind: "identity_alias_artifact_head_dark",
    runNonceDigest: run.runNonceDigest,
    decisionBoundaryAtMs: run.decisionBoundaryAtMs,
    contractPinsDigest: run.contractPinsDigest,
    workManifestDigest: run.workManifestDigest,
    workManifestCount: run.workManifestCount,
    terminalWorkSetDigest: terminalWorkSetDigest(works),
    pageSize: SOURCE_IDENTITY_ALIAS_PAGE_SIZE,
    pageCount,
    resolvedEntryCount: entries.length,
    unresolvedWorkCount,
    conflictWorkCount,
    pages,
  };
  const sealedArtifactDigest = artifactDigestFor(
    headMaterial,
  );
  const headRecord = {
    version: headMaterial.version,
    policyVersion: headMaterial.policyVersion,
    kind: headMaterial.kind,
    runNonceDigest: headMaterial.runNonceDigest,
    decisionBoundaryAtMs:
      headMaterial.decisionBoundaryAtMs,
    contractPinsDigest: headMaterial.contractPinsDigest,
    sealedArtifactDigest,
    workManifestDigest: headMaterial.workManifestDigest,
    workManifestCount: headMaterial.workManifestCount,
    terminalWorkSetDigest:
      headMaterial.terminalWorkSetDigest,
    pageSize: headMaterial.pageSize,
    pageCount: headMaterial.pageCount,
    resolvedEntryCount: headMaterial.resolvedEntryCount,
    unresolvedWorkCount: headMaterial.unresolvedWorkCount,
    conflictWorkCount: headMaterial.conflictWorkCount,
    pages: headMaterial.pages,
  };
  const headRaw = exactStoredRaw(headRecord);
  return {
    sealedArtifactDigest,
    headRecordDigest: rawDigest(headRaw),
    headRecord,
    headRaw,
    pageRecords,
    pageRaws,
  };
}

function canonicalHeadRecord(value) {
  const raw = object(value, "identity alias artifact head");
  exactKeys(
    raw,
    [
      "version",
      "policyVersion",
      "kind",
      "runNonceDigest",
      "decisionBoundaryAtMs",
      "contractPinsDigest",
      "sealedArtifactDigest",
      "workManifestDigest",
      "workManifestCount",
      "terminalWorkSetDigest",
      "pageSize",
      "pageCount",
      "resolvedEntryCount",
      "unresolvedWorkCount",
      "conflictWorkCount",
      "pages",
    ],
    "SOURCE_IDENTITY_ARTIFACT_HEAD_SHAPE_INVALID",
    "identity alias artifact head",
  );
  invariant(
    raw.version === ARTIFACT_HEAD_VERSION
      && raw.policyVersion
        === SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION
      && raw.kind === "identity_alias_artifact_head_dark"
      && raw.pageSize === SOURCE_IDENTITY_ALIAS_PAGE_SIZE,
    "SOURCE_IDENTITY_ARTIFACT_HEAD_VERSION_INVALID",
  );
  const record = {
    version: raw.version,
    policyVersion: raw.policyVersion,
    kind: raw.kind,
    runNonceDigest: digest(
      raw.runNonceDigest,
      "identity alias artifact head.runNonceDigest",
    ),
    decisionBoundaryAtMs: nonNegativeSafeInteger(
      raw.decisionBoundaryAtMs,
      "identity alias artifact head.decisionBoundaryAtMs",
    ),
    contractPinsDigest: digest(
      raw.contractPinsDigest,
      "identity alias artifact head.contractPinsDigest",
    ),
    sealedArtifactDigest: digest(
      raw.sealedArtifactDigest,
      "identity alias artifact head.sealedArtifactDigest",
    ),
    workManifestDigest: digest(
      raw.workManifestDigest,
      "identity alias artifact head.workManifestDigest",
    ),
    workManifestCount: nonNegativeSafeInteger(
      raw.workManifestCount,
      "identity alias artifact head.workManifestCount",
    ),
    terminalWorkSetDigest: digest(
      raw.terminalWorkSetDigest,
      "identity alias artifact head.terminalWorkSetDigest",
    ),
    pageSize: raw.pageSize,
    pageCount: positiveSafeInteger(
      raw.pageCount,
      "identity alias artifact head.pageCount",
    ),
    resolvedEntryCount: nonNegativeSafeInteger(
      raw.resolvedEntryCount,
      "identity alias artifact head.resolvedEntryCount",
    ),
    unresolvedWorkCount: nonNegativeSafeInteger(
      raw.unresolvedWorkCount,
      "identity alias artifact head.unresolvedWorkCount",
    ),
    conflictWorkCount: nonNegativeSafeInteger(
      raw.conflictWorkCount,
      "identity alias artifact head.conflictWorkCount",
    ),
    pages: [],
  };
  invariant(
    Array.isArray(raw.pages)
      && raw.pages.length === record.pageCount,
    "SOURCE_IDENTITY_ARTIFACT_HEAD_PAGES_INVALID",
  );
  record.pages = raw.pages.map((page, index) => {
    exactKeys(
      page,
      [
        "pageNumber",
        "cursorToken",
        "nextCursorToken",
        "entryCount",
        "pageRecordDigest",
        "pageSemanticDigest",
      ],
      "SOURCE_IDENTITY_ARTIFACT_HEAD_PAGE_INVALID",
      `identity alias artifact head.pages[${index}]`,
    );
    const pageNumber = positiveSafeInteger(
      page.pageNumber,
      `identity alias artifact head.pages[${index}].pageNumber`,
    );
    invariant(
      pageNumber === index + 1,
      "SOURCE_IDENTITY_ARTIFACT_HEAD_PAGE_INVALID",
    );
    return {
      pageNumber,
      cursorToken: nullableCursor(
        page.cursorToken,
        `identity alias artifact head.pages[${index}].cursorToken`,
      ),
      nextCursorToken: nullableCursor(
        page.nextCursorToken,
        `identity alias artifact head.pages[${index}].nextCursorToken`,
      ),
      entryCount: nonNegativeSafeInteger(
        page.entryCount,
        `identity alias artifact head.pages[${index}].entryCount`,
      ),
      pageRecordDigest: digest(
        page.pageRecordDigest,
        `identity alias artifact head.pages[${index}].pageRecordDigest`,
      ),
      pageSemanticDigest: digest(
        page.pageSemanticDigest,
        `identity alias artifact head.pages[${index}].pageSemanticDigest`,
      ),
    };
  });
  const runKeyDigest = runKeyDigestFor(record);
  for (let index = 0; index < record.pages.length; index += 1) {
    const page = record.pages[index];
    invariant(
      page.entryCount <= SOURCE_IDENTITY_ALIAS_PAGE_SIZE
        && page.cursorToken === (
          index === 0
            ? null
            : cursorFor(runKeyDigest, index + 1)
        )
        && page.nextCursorToken === (
          index === record.pages.length - 1
            ? null
            : cursorFor(runKeyDigest, index + 2)
        ),
      "SOURCE_IDENTITY_ARTIFACT_HEAD_PAGE_INVALID",
    );
  }
  invariant(
    record.pages.reduce(
      (total, page) => total + page.entryCount,
      0,
    ) === record.resolvedEntryCount
      && record.resolvedEntryCount
        + record.unresolvedWorkCount
        + record.conflictWorkCount
        === record.workManifestCount,
    "SOURCE_IDENTITY_ARTIFACT_HEAD_COUNTS_INVALID",
  );
  const {
    sealedArtifactDigest,
    ...headMaterial
  } = record;
  invariant(
    sealedArtifactDigest === artifactDigestFor(headMaterial),
    "SOURCE_IDENTITY_ARTIFACT_DIGEST_INVALID",
  );
  return deepFreeze(record);
}

function canonicalPageEntry(value, index) {
  const field = `identity alias artifact page.entries[${index}]`;
  const raw = object(value, field);
  exactKeys(
    raw,
    [
      "candidateUserAliasDigest",
      "canonicalCandidateDigest",
      "identityPointReadProcedure",
      "identityNormalizedInputDigest",
      "identityPointRecordDigest",
      "identityPointRecordRevisionDigest",
      "workItemDigest",
      "resolutionDigest",
    ],
    "SOURCE_IDENTITY_ARTIFACT_ENTRY_INVALID",
    field,
  );
  invariant(
    raw.identityPointReadProcedure
      === SOURCE_IDENTITY_POINT_READ_PROCEDURE,
    "SOURCE_IDENTITY_ARTIFACT_ENTRY_INVALID",
  );
  const entry = {
    candidateUserAliasDigest: digest(
      raw.candidateUserAliasDigest,
      `${field}.candidateUserAliasDigest`,
    ),
    canonicalCandidateDigest: digest(
      raw.canonicalCandidateDigest,
      `${field}.canonicalCandidateDigest`,
    ),
    identityPointReadProcedure:
      raw.identityPointReadProcedure,
    identityNormalizedInputDigest: digest(
      raw.identityNormalizedInputDigest,
      `${field}.identityNormalizedInputDigest`,
    ),
    identityPointRecordDigest: digest(
      raw.identityPointRecordDigest,
      `${field}.identityPointRecordDigest`,
    ),
    identityPointRecordRevisionDigest: digest(
      raw.identityPointRecordRevisionDigest,
      `${field}.identityPointRecordRevisionDigest`,
    ),
    workItemDigest: digest(
      raw.workItemDigest,
      `${field}.workItemDigest`,
    ),
    resolutionDigest: digest(
      raw.resolutionDigest,
      `${field}.resolutionDigest`,
    ),
  };
  invariant(
    entry.candidateUserAliasDigest
      !== entry.canonicalCandidateDigest,
    "SOURCE_IDENTITY_ARTIFACT_ENTRY_INVALID",
  );
  return entry;
}

function canonicalPageRecord(value) {
  const raw = object(value, "identity alias artifact page");
  exactKeys(
    raw,
    [
      "version",
      "policyVersion",
      "kind",
      "runNonceDigest",
      "decisionBoundaryAtMs",
      "contractPinsDigest",
      "pageNumber",
      "pageSize",
      "cursorToken",
      "nextCursorToken",
      "entryCount",
      "entries",
    ],
    "SOURCE_IDENTITY_ARTIFACT_PAGE_SHAPE_INVALID",
    "identity alias artifact page",
  );
  invariant(
    raw.version === ARTIFACT_PAGE_VERSION
      && raw.policyVersion
        === SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION
      && raw.kind === "identity_alias_artifact_page_dark"
      && raw.pageSize === SOURCE_IDENTITY_ALIAS_PAGE_SIZE,
    "SOURCE_IDENTITY_ARTIFACT_PAGE_VERSION_INVALID",
  );
  invariant(
    Array.isArray(raw.entries),
    "SOURCE_IDENTITY_ARTIFACT_PAGE_ENTRIES_INVALID",
  );
  const record = {
    version: raw.version,
    policyVersion: raw.policyVersion,
    kind: raw.kind,
    runNonceDigest: digest(
      raw.runNonceDigest,
      "identity alias artifact page.runNonceDigest",
    ),
    decisionBoundaryAtMs: nonNegativeSafeInteger(
      raw.decisionBoundaryAtMs,
      "identity alias artifact page.decisionBoundaryAtMs",
    ),
    contractPinsDigest: digest(
      raw.contractPinsDigest,
      "identity alias artifact page.contractPinsDigest",
    ),
    pageNumber: positiveSafeInteger(
      raw.pageNumber,
      "identity alias artifact page.pageNumber",
    ),
    pageSize: raw.pageSize,
    cursorToken: nullableCursor(
      raw.cursorToken,
      "identity alias artifact page.cursorToken",
    ),
    nextCursorToken: nullableCursor(
      raw.nextCursorToken,
      "identity alias artifact page.nextCursorToken",
    ),
    entryCount: nonNegativeSafeInteger(
      raw.entryCount,
      "identity alias artifact page.entryCount",
    ),
    entries: raw.entries.map(canonicalPageEntry),
  };
  invariant(
    record.entryCount === record.entries.length
      && record.entryCount <= SOURCE_IDENTITY_ALIAS_PAGE_SIZE,
    "SOURCE_IDENTITY_ARTIFACT_PAGE_ENTRIES_INVALID",
  );
  return deepFreeze(record);
}

async function readWorkSet(runSnapshot) {
  const keys = [
    `${RUN_KEY_PREFIX}${runSnapshot.record.runKeyDigest}`,
    ...runSnapshot.record.workKeyDigests.map(
      (workKey) => `${WORK_KEY_PREFIX}${workKey}`,
    ),
  ];
  const result = await kv([
    "EVAL",
    READ_WORK_SET_LUA,
    keys.length,
    ...keys,
    runSnapshot.raw,
  ]);
  invariant(
    Array.isArray(result) && Number(result[0]) === 1,
    "SOURCE_IDENTITY_WORK_SET_CONFLICT",
  );
  const nowMs = redisTime(
    result,
    1,
    "identity observation work-set read",
  );
  invariant(
    result.length === 3 + runSnapshot.record.workKeyDigests.length,
    "SOURCE_IDENTITY_WORK_SET_MALFORMED",
  );
  const snapshots = result.slice(3).map((raw, index) => {
    const snapshot = parsedWorkSnapshot(raw, nowMs);
    invariant(
      snapshot.record.workKeyDigest
        === runSnapshot.record.workKeyDigests[index]
        && snapshot.record.runKeyDigest
          === runSnapshot.record.runKeyDigest,
      "SOURCE_IDENTITY_WORK_SET_MALFORMED",
    );
    return snapshot;
  });
  return deepFreeze({
    records: snapshots.map((snapshot) => snapshot.record),
    raws: snapshots.map((snapshot) => snapshot.raw),
  });
}

function prepareInput(value) {
  return canonicalRunInput(value);
}

function prepareResult(head, runRecord) {
  return deepFreeze({
    sealedArtifactDigest: head.sealedArtifactDigest,
    headRecordDigest: head.headRecordDigest,
    pageCount: head.headRecord.pageCount,
    resolvedEntryCount: head.headRecord.resolvedEntryCount,
    unresolvedWorkCount:
      head.headRecord.unresolvedWorkCount,
    conflictWorkCount: head.headRecord.conflictWorkCount,
    operational: false,
    pinnable: false,
    upstreamExhaustivenessProven: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
    runStatus: runRecord.status,
  });
}

// Sealing is intentionally separate from the capture journal. The alias
// adapter must prepare this artifact before it begins journal pass one.
export async function prepareIdentityAliasArtifact(input) {
  const normalized = prepareInput(input);
  const run = await readIdentityObservationRun(normalized);
  invariant(
    run.record,
    "SOURCE_IDENTITY_RUN_NOT_FOUND",
  );
  if (run.record.status === "sealed") {
    const head = await readIdentityAliasArtifactHead({
      sealedArtifactDigest:
        run.record.sealedArtifactDigest,
      ...normalized,
    });
    invariant(
      head.headRecordDigest
        === run.record.sealedHeadRecordDigest,
      "SOURCE_IDENTITY_SEALED_HEAD_DRIFT",
    );
    return prepareResult({
      sealedArtifactDigest:
        run.record.sealedArtifactDigest,
      headRecordDigest: head.headRecordDigest,
      headRecord: head.record,
    }, run.record);
  }
  invariant(
    run.record.status === "work_set_complete",
    "SOURCE_IDENTITY_WORK_MANIFEST_NOT_FINALIZED",
  );
  const workSet = await readWorkSet(run);
  const works = workSet.records;
  invariant(
    works.every((record) => (
      ["resolved", "unresolved", "conflict"].includes(
        record.status,
      )
    )),
    "SOURCE_IDENTITY_WORK_SET_INCOMPLETE",
  );
  const artifact = artifactRecords(run.record, works);
  const immutableKeys = [
    `${HEAD_KEY_PREFIX}${artifact.sealedArtifactDigest}`,
    ...artifact.pageRecords.map(
      (_page, index) => (
        `${PAGE_KEY_PREFIX}${
          artifact.headRecord.pages[index].pageRecordDigest
        }`
      ),
    ),
  ];
  const immutableRaws = [
    artifact.headRaw,
    ...artifact.pageRaws,
  ];
  const workKeys = run.record.workKeyDigests.map(
    (workKey) => `${WORK_KEY_PREFIX}${workKey}`,
  );
  const result = await kv([
    "EVAL",
    SEAL_ARTIFACT_LUA,
    1 + workKeys.length + immutableKeys.length,
    `${RUN_KEY_PREFIX}${run.record.runKeyDigest}`,
    ...workKeys,
    ...immutableKeys,
    run.raw,
    artifact.headRaw,
    artifact.sealedArtifactDigest,
    String(immutableKeys.length),
    artifact.headRecordDigest,
    String(workKeys.length),
    ...workSet.raws,
    ...immutableRaws,
  ]);
  invariant(
    Array.isArray(result),
    "SOURCE_IDENTITY_ARTIFACT_SEAL_MALFORMED",
  );
  if (Number(result[0]) === -3) {
    fail(
      "SOURCE_IDENTITY_ARTIFACT_SEAL_CONFLICT",
      "identity run changed during artifact sealing",
    );
  }
  if (Number(result[0]) === -10) {
    fail(
      "SOURCE_IDENTITY_ARTIFACT_WORK_SET_DRIFT",
      "identity work changed during artifact sealing",
    );
  }
  invariant(
    Number(result[0]) === 1
      && result[2] === artifact.headRaw,
    "SOURCE_IDENTITY_ARTIFACT_EXACT_READBACK_FAILED",
  );
  const sealedRun = parsedRunSnapshot(
    result[1],
    redisTime(result, 3, "identity alias artifact seal"),
  );
  const readback = await readIdentityAliasArtifactHead({
    sealedArtifactDigest: artifact.sealedArtifactDigest,
    ...normalized,
  });
  invariant(
    readback.raw === artifact.headRaw
      && readback.headRecordDigest
        === artifact.headRecordDigest,
    "SOURCE_IDENTITY_ARTIFACT_EXACT_READBACK_FAILED",
  );
  return prepareResult(artifact, sealedRun.record);
}

function canonicalArtifactReadInput(value, includeCursor) {
  const raw = object(value, "identity alias artifact read input");
  exactKeys(
    raw,
    includeCursor
      ? [
        "sealedArtifactDigest",
        "runNonceDigest",
        "decisionBoundaryAtMs",
        "contractPinsDigest",
        "cursorToken",
      ]
      : [
        "sealedArtifactDigest",
        "runNonceDigest",
        "decisionBoundaryAtMs",
        "contractPinsDigest",
      ],
    "SOURCE_IDENTITY_ARTIFACT_READ_INPUT_INVALID",
    "identity alias artifact read input",
  );
  return {
    sealedArtifactDigest: digest(
      raw.sealedArtifactDigest,
      "identity alias artifact read input.sealedArtifactDigest",
    ),
    ...canonicalRunInput({
      runNonceDigest: raw.runNonceDigest,
      decisionBoundaryAtMs: raw.decisionBoundaryAtMs,
      contractPinsDigest: raw.contractPinsDigest,
    }),
    ...(includeCursor
      ? {
        cursorToken: nullableCursor(
          raw.cursorToken,
          "identity alias artifact read input.cursorToken",
        ),
      }
      : {}),
  };
}

export async function readIdentityAliasArtifactHead(input) {
  const normalized = canonicalArtifactReadInput(input, false);
  const result = await kv([
    "EVAL",
    READ_ONE_LUA,
    1,
    `${HEAD_KEY_PREFIX}${normalized.sealedArtifactDigest}`,
  ]);
  invariant(
    Array.isArray(result) && result[0],
    "SOURCE_IDENTITY_ARTIFACT_HEAD_NOT_FOUND",
  );
  const nowMs = redisTime(
    result,
    1,
    "identity alias artifact head read",
  );
  const raw = result[0];
  const record = canonicalHeadRecord(
    parseJson(
      raw,
      "SOURCE_IDENTITY_ARTIFACT_HEAD_MALFORMED",
      "identity alias artifact head",
    ),
  );
  invariant(
    JSON.stringify(record) === raw
      && record.sealedArtifactDigest
        === normalized.sealedArtifactDigest
      && record.runNonceDigest === normalized.runNonceDigest
      && record.decisionBoundaryAtMs
        === normalized.decisionBoundaryAtMs
      && record.contractPinsDigest
        === normalized.contractPinsDigest,
    "SOURCE_IDENTITY_ARTIFACT_HEAD_BINDING_INVALID",
  );
  return deepFreeze({
    raw,
    headRecordDigest: rawDigest(raw),
    record,
    redisNowMs: nowMs,
  });
}

export async function readIdentityAliasArtifactPage(input) {
  const normalized = canonicalArtifactReadInput(input, true);
  const head = await readIdentityAliasArtifactHead({
    sealedArtifactDigest: normalized.sealedArtifactDigest,
    runNonceDigest: normalized.runNonceDigest,
    decisionBoundaryAtMs: normalized.decisionBoundaryAtMs,
    contractPinsDigest: normalized.contractPinsDigest,
  });
  const descriptor = head.record.pages.find(
    (page) => page.cursorToken === normalized.cursorToken,
  );
  invariant(
    descriptor,
    "SOURCE_IDENTITY_ARTIFACT_CURSOR_INVALID",
  );
  const result = await kv([
    "EVAL",
    READ_ONE_LUA,
    1,
    `${PAGE_KEY_PREFIX}${descriptor.pageRecordDigest}`,
  ]);
  invariant(
    Array.isArray(result) && result[0],
    "SOURCE_IDENTITY_ARTIFACT_PAGE_NOT_FOUND",
  );
  const nowMs = redisTime(
    result,
    1,
    "identity alias artifact page read",
  );
  const raw = result[0];
  const record = canonicalPageRecord(
    parseJson(
      raw,
      "SOURCE_IDENTITY_ARTIFACT_PAGE_MALFORMED",
      "identity alias artifact page",
    ),
  );
  const pageRecordDigest = rawDigest(raw);
  invariant(
    JSON.stringify(record) === raw
      && pageRecordDigest === descriptor.pageRecordDigest
      && pageSemanticDigest(record.entries)
        === descriptor.pageSemanticDigest
      && record.runNonceDigest === normalized.runNonceDigest
      && record.decisionBoundaryAtMs
        === normalized.decisionBoundaryAtMs
      && record.contractPinsDigest
        === normalized.contractPinsDigest
      && record.pageNumber === descriptor.pageNumber
      && record.cursorToken === descriptor.cursorToken
      && record.nextCursorToken
        === descriptor.nextCursorToken
      && record.entryCount === descriptor.entryCount,
    "SOURCE_IDENTITY_ARTIFACT_PAGE_BINDING_INVALID",
  );
  return deepFreeze({
    raw,
    pageRecordDigest,
    pageSemanticDigest: descriptor.pageSemanticDigest,
    recordCount: record.entryCount,
    cursorToken: record.cursorToken,
    nextCursorToken: record.nextCursorToken,
    record,
    redisNowMs: nowMs,
  });
}

// Aggregate-only: no raw/private identifiers, opaque work keys, artifact
// digests, cursors, links, or response bodies are returned.
export function identityArtifactAggregateStatus({
  run = null,
  works = [],
} = {}) {
  const record = run == null
    ? null
    : validateIdentityObservationRun(
      run.record || run,
    );
  invariant(
    Array.isArray(works),
    "SOURCE_IDENTITY_AGGREGATE_INPUT_INVALID",
  );
  const normalizedWorks = works.map(
    (work) => validateIdentityObservationWork(
      work.record || work,
    ),
  );
  invariant(
    record
      ? normalizedWorks.every(
        (work) => work.runKeyDigest === record.runKeyDigest,
      )
        && new Set(normalizedWorks.map(
          (work) => work.workKeyDigest,
        )).size === normalizedWorks.length
        && canonicalJson(normalizedWorks
          .map((work) => work.workKeyDigest)
          .sort()) === canonicalJson(
          record.workKeyDigests,
        )
      : normalizedWorks.length === 0,
    "SOURCE_IDENTITY_AGGREGATE_INPUT_INVALID",
  );
  const count = (status) => normalizedWorks.filter(
    (work) => work.status === status,
  ).length;
  return deepFreeze({
    status: record?.status || "not_started",
    operational: false,
    pinnable: false,
    upstreamExhaustivenessProven: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
    curationAvailable: false,
    enrollmentAvailable: false,
    serverSelectedReads: true,
    fixedTwoReadInterval: true,
    fixedPageSize: SOURCE_IDENTITY_ALIAS_PAGE_SIZE,
    workCount: normalizedWorks.length,
    awaitingFirstReadCount: count("awaiting_read_1"),
    awaitingSecondReadCount: count("awaiting_read_2"),
    inProgressReadCount:
      count("claimed_read_1") + count("claimed_read_2"),
    resolvedCount: count("resolved"),
    unresolvedCount: count("unresolved"),
    conflictCount: count("conflict"),
  });
}
