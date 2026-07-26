// Pure, hard-dark candidate-user identity point projection.
//
// This module performs no source read and owns no durable state. It accepts
// the private result of the pinned candidate-user point read, rejects
// ambiguous identity shapes, and returns either the minimal private
// two-identifier projection or digest-only evidence. Nothing here can mint a
// receipt, activate source authority, curate, enroll, or write to Paraform.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  SOURCE_IDENTITY_POINT_READ_PROCEDURES,
} from "./source-watermark.mjs";

export const SOURCE_IDENTITY_POINT_COLLECTOR_VERSION =
  "candidate-user-identity-point-v1";

const CANDIDATE_USER_ALIAS_KEYS = Object.freeze([
  "id",
  "candidate_user_id",
  "candidateUserId",
]);
const CANDIDATE_USER_WRAPPER_KEYS = Object.freeze([
  "candidate_user",
  "candidateUser",
  "item",
]);

export class SourceIdentityPointCollectorError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceIdentityPointCollectorError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceIdentityPointCollectorError(code);
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
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail("SOURCE_IDENTITY_POINT_SYMBOL_INVALID");
  }
  const snapshot = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value",
      )
      || descriptor.enumerable !== true
    ) {
      fail("SOURCE_IDENTITY_POINT_ACCESSOR_INVALID");
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function exactIdentifier(value, code) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code);
  }
  return value;
}

function deepFreeze(value) {
  if (
    value
    && typeof value === "object"
    && !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical digest values must be finite");
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
  throw new TypeError("canonical digest values must be JSON-safe");
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function candidateUserRecord(raw) {
  const root = plainRecordSnapshot(
    raw,
    "SOURCE_IDENTITY_POINT_RECORD_INVALID",
  );
  const wrappers = CANDIDATE_USER_WRAPPER_KEYS.filter(
    (key) => Object.prototype.hasOwnProperty.call(root, key),
  );
  if (wrappers.length > 1) {
    fail("SOURCE_IDENTITY_POINT_WRAPPER_AMBIGUOUS");
  }
  if (wrappers.length === 0) return root;
  if (CANDIDATE_USER_ALIAS_KEYS.some(
    (key) => Object.prototype.hasOwnProperty.call(root, key),
  )) {
    fail("SOURCE_IDENTITY_POINT_WRAPPER_AMBIGUOUS");
  }
  return plainRecordSnapshot(
    root[wrappers[0]],
    "SOURCE_IDENTITY_POINT_WRAPPER_INVALID",
  );
}

export function candidateUserIdentityPointReadInput(
  candidateUserId,
) {
  return deepFreeze({
    candidate_user_id: exactIdentifier(
      candidateUserId,
      "SOURCE_IDENTITY_POINT_INPUT_INVALID",
    ),
  });
}

export function normalizeCandidateUserIdentityPointRecord(
  raw,
  options = {},
) {
  const normalizedOptions = plainRecordSnapshot(
    options,
    "SOURCE_IDENTITY_POINT_OPTIONS_INVALID",
  );
  if (
    Object.keys(normalizedOptions).length !== 1
    || !Object.prototype.hasOwnProperty.call(
      normalizedOptions,
      "expectedCandidateUserId",
    )
  ) {
    fail("SOURCE_IDENTITY_POINT_OPTIONS_INVALID");
  }
  const expected = exactIdentifier(
    normalizedOptions.expectedCandidateUserId,
    "SOURCE_IDENTITY_POINT_EXPECTED_ID_INVALID",
  );
  const record = candidateUserRecord(raw);
  const aliases = CANDIDATE_USER_ALIAS_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(
      record,
      key,
    ))
    .map((key) => exactIdentifier(
      record[key],
      "SOURCE_IDENTITY_POINT_ALIAS_INVALID",
    ));
  if (aliases.length === 0) {
    fail("SOURCE_IDENTITY_POINT_ALIAS_MISSING");
  }
  const uniqueAliases = new Set(aliases);
  if (uniqueAliases.size !== 1) {
    fail("SOURCE_IDENTITY_POINT_ALIAS_CONFLICT");
  }
  const candidateUserId = aliases[0];
  if (candidateUserId !== expected) {
    fail("SOURCE_IDENTITY_POINT_EXPECTED_ID_MISMATCH");
  }
  if (
    !Object.prototype.hasOwnProperty.call(record, "candidate")
  ) {
    fail("SOURCE_IDENTITY_POINT_CANDIDATE_MISSING");
  }
  const candidate = plainRecordSnapshot(
    record.candidate,
    "SOURCE_IDENTITY_POINT_CANDIDATE_INVALID",
  );
  if (!Object.prototype.hasOwnProperty.call(candidate, "id")) {
    fail("SOURCE_IDENTITY_POINT_CANDIDATE_ID_MISSING");
  }
  const globalCandidateId = exactIdentifier(
    candidate.id,
    "SOURCE_IDENTITY_POINT_CANDIDATE_ID_INVALID",
  );
  return deepFreeze({
    candidateUserId,
    globalCandidateId,
  });
}

export function candidateUserIdentityPointEvidence(
  raw,
  options = {},
) {
  const projection =
    normalizeCandidateUserIdentityPointRecord(raw, options);
  const candidateUserAliasDigest = semanticDigest(
    "phase4-candidate-user-alias-v1",
    projection.candidateUserId,
  );
  const canonicalCandidateDigest = semanticDigest(
    "phase4-canonical-candidate-v1",
    projection.globalCandidateId,
  );
  const mapping = {
    candidateUserAliasDigest,
    canonicalCandidateDigest,
  };
  const normalizedInput =
    candidateUserIdentityPointReadInput(
      projection.candidateUserId,
    );
  return deepFreeze({
    identityPointReadProcedure:
      SOURCE_IDENTITY_POINT_READ_PROCEDURES
        .candidateUserIdentity,
    identityNormalizedInputDigest: semanticDigest(
      "phase4-candidate-user-identity-point-input-v1",
      normalizedInput,
    ),
    candidateUserAliasDigest,
    canonicalCandidateDigest,
    identityPointRecordDigest: semanticDigest(
      "phase4-candidate-user-identity-point-record-v1",
      mapping,
    ),
    identityPointRecordRevisionDigest: semanticDigest(
      "phase4-candidate-user-identity-point-semantic-revision-v1",
      mapping,
    ),
  });
}
