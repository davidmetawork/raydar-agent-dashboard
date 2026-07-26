// Dark Phase 4 Curated List client contract.
//
// This module deliberately performs no network, environment, store, queue, or
// pipeline work. It models the currently observed Paraform bundle contract and
// keeps mutation authorization impossible until a reviewed, versioned live
// capture attestation is pinned in this file.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  CURATED_ADD_ATTEMPT_LIMIT_MAX,
  curatedWriteReconciliationDecision,
  planCuratedAdds,
} from "./phase3-shadow-policy.mjs";

export const PHASE4_CURATION_CONTRACT_VERSION =
  "phase4-curation-contract-v2";
export const PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION = 2;
export const PHASE4_CURATION_OBSERVATION_VERSION = 2;

export const PHASE4_MATCH_READ_PROCEDURE =
  "candidateMatching.getRankedRolesForCandidate";
export const PHASE4_CURATED_LIST_READ_PROCEDURE =
  "curatedRoleList.getCandidateCuratedRoleList";
export const PHASE4_CURATED_LIST_ADD_PROCEDURE =
  "curatedRoleList.addRolesToCuratedList";
export const PHASE4_NOTIFICATION_SETTINGS_READ_PROCEDURE =
  "candidateUser.getCandidateNotificationSettings";
// This is a store-owned source-generation observation, not a Paraform RPC.
// No producer is implemented in this dark module.
export const PHASE4_CANDIDATE_IDENTITY_PROCEDURE =
  "raydar.sourceGeneration.getCandidateIdentity";

export const PHASE4_CURATED_LIST_ADD_TYPE = "candidate";
export const PHASE4_CURATED_LIST_ADD_SOURCE = "ADD_TO_ROLES";
export const PHASE4_ROLE_ADDED_NOTIFICATION_TYPE =
  "CURATED_LIST_ROLE_ADDED";

export const PHASE4_NOTIFICATION_PROOF_MAX_AGE_MS = 5 * 60_000;
export const PHASE4_OBSERVATION_PROOF_MAX_AGE_MS = 15 * 60_000;
export const PHASE4_CAPTURE_EMAIL_SILENCE_MIN_MS = 48 * 60 * 60_000;
export const PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX =
  CURATED_ADD_ATTEMPT_LIMIT_MAX;

export const PHASE4_CURATED_LIST_ADD_INPUT_KEYS = Object.freeze([
  "candidate_id",
  "candidate_user_id",
  "role_ids",
  "source",
  "type",
]);
export const PHASE4_CURATED_LIST_READ_INPUT_KEYS = Object.freeze([
  "candidate_id",
]);
export const PHASE4_NOTIFICATION_SETTINGS_INPUT_KEYS = Object.freeze([
  "candidate_user_id",
]);
export const PHASE4_CURATED_LIST_ADD_RESPONSE_KEYS = Object.freeze([
  "curated_role_list_id",
  "message",
  "success",
]);

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
const SAFE_TOKEN_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const MAX_CURATED_ROLE_IDS = 250;
// Security provenance is deliberately non-reflective. A symbol/property brand
// can be forged by a Proxy get trap or copied from an invalid object. These
// closure-owned registries accept only the exact object minted here, and all
// downstream decisions consume the immutable private record rather than the
// caller-visible object.
const matchProofRegistry = new WeakMap();
const readbackProofRegistry = new WeakMap();
const identityProofRegistry = new WeakMap();
const notificationProofRegistry = new WeakMap();
const writePlanRegistry = new WeakMap();
const writeAuthorizationRegistry = new WeakMap();
const authorizedRequestRegistry = new WeakMap();
const mutationOutcomeRegistry = new WeakMap();
const replanRequirementRegistry = new WeakMap();
const globalWriteAuthorityRegistry = new WeakMap();
const captureEvidenceVerificationRegistry = new WeakMap();
const consumedReplanRequirements = new WeakSet();
const consumedGlobalWriteAuthorities = new WeakSet();
const consumedWriteAuthorizations = new WeakSet();
const completedAuthorizedRequests = new WeakSet();
const reconciledMutationOutcomes = new WeakSet();

const CAPTURE_TOP_LEVEL_KEYS = Object.freeze([
  "addContract",
  "behavior",
  "captureSource",
  "capturedAt",
  "cleanup",
  "contractVersion",
  "emailSilence",
  "evidenceDigests",
  "implementationDigest",
  "notificationContract",
  "observedThroughAt",
  "readbackContract",
  "semanticDigest",
  "status",
  "version",
]);
const CAPTURE_EVIDENCE_DIGEST_KEYS = Object.freeze([
  "addResponse",
  "cleanup",
  "duplicateAfterReadback",
  "duplicateBeforeReadback",
  "duplicateMutationOutcome",
  "identityBinding",
  "implicitCreateAfterReadback",
  "implicitCreateBeforeReadback",
  "implicitCreateMutationOutcome",
  "mailboxSilence",
  "notificationAfter",
  "notificationBefore",
]);
const CAPTURE_ADD_CONTRACT_KEYS = Object.freeze([
  "inputKeys",
  "method",
  "procedure",
  "responseKeys",
  "sourceValue",
  "typeValue",
]);
const CAPTURE_READ_CONTRACT_KEYS = Object.freeze([
  "candidateScoped",
  "inputKeys",
  "method",
  "nullOrObject",
  "procedure",
  "roleIdPath",
]);
const CAPTURE_NOTIFICATION_CONTRACT_KEYS = Object.freeze([
  "inputKeys",
  "method",
  "notificationType",
  "procedure",
]);
const CAPTURE_BEHAVIOR_KEYS = Object.freeze([
  "duplicateDidNotDuplicate",
  "duplicateReaddObserved",
  "implicitCreateObserved",
  "listIdentityStable",
  "readbackLatencyMs",
]);
const CAPTURE_EMAIL_SILENCE_KEYS = Object.freeze([
  "candidateFacingEmailCount",
  "controlledRecipient",
  "notificationTypeDisabled",
  "observedForMs",
]);
const CAPTURE_CLEANUP_KEYS = Object.freeze([
  "disposableEmptyListResidualRecorded",
  "notificationSettingsUnchanged",
  "roleSetRestored",
]);
const OBSERVATION_KEYS = Object.freeze([
  "authoritative",
  "complete",
  "input",
  "observedAt",
  "procedure",
  "response",
  "responseDigest",
  "scopeDigest",
  "sourceCasRevision",
  "sourceGenerationDigest",
  "version",
]);

// The capture is intentionally not yet pinned. A later reviewed capture change
// must replace this placeholder with the complete attestation and its semantic
// digest before this module can mint a write authorization.
export const PHASE4_CURATED_LIST_CAPTURE_ATTESTATION = Object.freeze({
  version: PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
  contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
  status: "uncaptured",
  semanticDigest: null,
});

export const PHASE4_PINNED_CAPTURE_ATTESTATION_DIGEST = null;
export const PHASE4_PINNED_CURATION_IMPLEMENTATION_DIGEST = null;

function isObject(value) {
  return value !== null && typeof value === "object";
}

function rejectProxy(value, field = "value") {
  if (isObject(value) && nodeTypes.isProxy(value)) {
    throw new TypeError(`${field} must not be a Proxy`);
  }
}

function ownDataDescriptors(value, field) {
  rejectProxy(value, field);
  if (!isObject(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(descriptors).length !== 0) {
    throw new TypeError(`${field} must not contain symbol properties`);
  }
  return descriptors;
}

function snapshotPlainData(value, field = "value", seen = new WeakSet()) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "undefined"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (!isObject(value)) {
    throw new TypeError(`${field} must contain only plain JSON data`);
  }
  rejectProxy(value, field);
  if (seen.has(value)) {
    throw new TypeError(`${field} must not be cyclic`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`${field} must be a plain array`);
      }
      const descriptors = ownDataDescriptors(value, field);
      const lengthDescriptor = descriptors.length;
      if (
        !lengthDescriptor
        || !Object.hasOwn(lengthDescriptor, "value")
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
      ) {
        throw new TypeError(`${field} has an invalid length`);
      }
      const allowedKeys = new Set(["length"]);
      const result = [];
      for (let index = 0; index < lengthDescriptor.value; index++) {
        const key = String(index);
        allowedKeys.add(key);
        const descriptor = descriptors[key];
        if (
          !descriptor
          || !Object.hasOwn(descriptor, "value")
          || descriptor.enumerable !== true
        ) {
          throw new TypeError(`${field} must be a dense data array`);
        }
        result.push(snapshotPlainData(
          descriptor.value,
          `${field}[${index}]`,
          seen,
        ));
      }
      if (
        Object.keys(descriptors).some((key) => !allowedKeys.has(key))
      ) {
        throw new TypeError(`${field} must not have extra properties`);
      }
      return Object.freeze(result);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${field} must be a plain object`);
    }
    const descriptors = ownDataDescriptors(value, field);
    const result = Object.create(null);
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (
        !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
      ) {
        throw new TypeError(`${field}.${key} must be a data property`);
      }
      result[key] = snapshotPlainData(
        descriptor.value,
        `${field}.${key}`,
        seen,
      );
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}

function shallowArgumentSnapshot(value, keys, field = "arguments") {
  if (value === undefined) return Object.freeze({});
  rejectProxy(value, field);
  const record = plainRecord(value);
  if (!record) {
    throw new TypeError(`${field} must be a plain object`);
  }
  const descriptors = ownDataDescriptors(record, field);
  const snapshot = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor) continue;
    if (
      !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      throw new TypeError(`${field}.${key} must be a data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function registeredData(registry, value) {
  if (!isObject(value) || nodeTypes.isProxy(value)) return null;
  return registry.get(value) || null;
}

function registerArtifact(registry, publicValue, privateValue) {
  const artifact = Object.freeze(publicValue);
  registry.set(artifact, Object.freeze(privateValue));
  return artifact;
}

function frozenArray(value) {
  return Object.freeze([...value]);
}

function plainRecord(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value
    : null;
}

function hasExactKeys(value, expectedKeys) {
  const record = plainRecord(value);
  if (!record) return false;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
  );
}

function sameStringArray(value, expected) {
  return (
    Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index])
  );
}

function canonicalIso(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString() === value ? value : null;
}

function boundedId(value) {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value)
    ? value
    : null;
}

function lowercaseDigest(value) {
  return typeof value === "string" && DIGEST_PATTERN.test(value)
    ? value
    : null;
}

function strictUniqueIds(value, field) {
  let snapshot;
  try {
    snapshot = snapshotPlainData(value, field);
  } catch {
    throw new TypeError(`${field} must be a plain data array`);
  }
  if (!Array.isArray(snapshot)) {
    throw new TypeError(`${field} must be an array`);
  }
  if (snapshot.length > MAX_CURATED_ROLE_IDS) {
    throw new RangeError(
      `${field} cannot exceed ${MAX_CURATED_ROLE_IDS} entries`,
    );
  }
  const ids = [];
  const seen = new Set();
  for (const raw of snapshot) {
    const id = boundedId(raw);
    if (!id) {
      throw new TypeError(`${field} must contain only safe bounded ids`);
    }
    if (seen.has(id)) {
      throw new TypeError(`${field} must not contain duplicate ids`);
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function strictNotificationTypes(value) {
  let snapshot;
  try {
    snapshot = snapshotPlainData(value, "notification_types");
  } catch {
    throw new TypeError(
      "notification_types must be a bounded plain data array",
    );
  }
  if (!Array.isArray(snapshot) || snapshot.length > 250) {
    throw new TypeError(
      "notification_types must be a bounded array",
    );
  }
  const types = [];
  const seen = new Set();
  for (const raw of snapshot) {
    if (typeof raw !== "string" || !SAFE_TOKEN_PATTERN.test(raw)) {
      throw new TypeError(
        "notification_types must contain only safe enum tokens",
      );
    }
    if (seen.has(raw)) {
      throw new TypeError(
        "notification_types must not contain duplicate values",
      );
    }
    seen.add(raw);
    types.push(raw);
  }
  return types;
}

function strictPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function exactScopeContext({
  scopeDigest,
  sourceGenerationDigest,
  sourceCasRevision,
  trustedNow,
} = {}) {
  const exactTrustedNow = canonicalIso(trustedNow);
  if (
    !lowercaseDigest(scopeDigest)
    || !lowercaseDigest(sourceGenerationDigest)
    || !Number.isSafeInteger(sourceCasRevision)
    || sourceCasRevision < 1
    || !exactTrustedNow
  ) {
    return null;
  }
  return Object.freeze({
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow: exactTrustedNow,
  });
}

function sameScope(left, right) {
  return Boolean(
    left
    && right
    && left.scopeDigest === right.scopeDigest
    && left.sourceGenerationDigest === right.sourceGenerationDigest
    && left.sourceCasRevision === right.sourceCasRevision
  );
}

function observationFreshAt(observedAt, trustedNow, maxAgeMs) {
  const observed = canonicalIso(observedAt);
  const now = canonicalIso(trustedNow);
  if (!observed || !now) return false;
  const ageMs = Date.parse(now) - Date.parse(observed);
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function proofScopeFields(context) {
  return {
    scopeDigest: context?.scopeDigest || null,
    sourceGenerationDigest: context?.sourceGenerationDigest || null,
    sourceCasRevision: context?.sourceCasRevision || null,
  };
}

function invalidMatchProof(errorCode) {
  return Object.freeze({
    valid: false,
    authoritative: false,
    complete: false,
    errorCode,
    observedAt: null,
    responseDigest: null,
    candidateId: null,
    recruiterUserId: null,
    recommendedRoleIds: Object.freeze([]),
    possibleRoleIds: Object.freeze([]),
    targetRoleIds: Object.freeze([]),
    recommendedCount: 0,
    possibleCount: 0,
    targetCount: 0,
    scopeDigest: null,
    sourceGenerationDigest: null,
    sourceCasRevision: null,
  });
}

function invalidReadbackProof(errorCode) {
  return Object.freeze({
    valid: false,
    authoritative: false,
    complete: false,
    errorCode,
    observedAt: null,
    responseDigest: null,
    candidateId: null,
    candidateUserId: null,
    exists: false,
    implicitCreateRequired: false,
    listId: null,
    roleIds: Object.freeze([]),
    roleCount: 0,
    scopeDigest: null,
    sourceGenerationDigest: null,
    sourceCasRevision: null,
  });
}

function invalidIdentityProof(errorCode) {
  return Object.freeze({
    valid: false,
    authoritative: false,
    complete: false,
    errorCode,
    observedAt: null,
    responseDigest: null,
    candidateId: null,
    candidateUserId: null,
    scopeDigest: null,
    sourceGenerationDigest: null,
    sourceCasRevision: null,
  });
}

function invalidNotificationProof(errorCode) {
  return Object.freeze({
    valid: false,
    authoritative: false,
    complete: false,
    safe: false,
    errorCode,
    observedAt: null,
    responseDigest: null,
    candidateUserId: null,
    notificationTypes: Object.freeze([]),
    roleAddedNotificationEnabled: null,
    scopeDigest: null,
    sourceGenerationDigest: null,
    sourceCasRevision: null,
  });
}

function expectedCaptureResponseKeys(value) {
  return sameStringArray(
    value,
    PHASE4_CURATED_LIST_ADD_RESPONSE_KEYS,
  );
}

function canonicalJsonValue(value, { omitSemanticDigest = false } = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalJsonValue(
      item,
      { omitSemanticDigest },
    ));
  }
  const record = plainRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => !(omitSemanticDigest && key === "semanticDigest"))
      .map((key) => [
        key,
        canonicalJsonValue(record[key], { omitSemanticDigest }),
      ]),
  );
}

function canonicalDigest(value, options) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value, options)))
    .digest("hex");
}

function selectedDataValues(
  value,
  keys,
  {
    field = "value",
    exact = false,
    optional = [],
  } = {},
) {
  rejectProxy(value, field);
  const record = plainRecord(value);
  if (!record) {
    throw new TypeError(`${field} must be a plain object`);
  }
  const descriptors = ownDataDescriptors(record, field);
  const optionalKeys = new Set(optional);
  if (
    exact
    && (
      Object.keys(descriptors).length !== keys.length
      || keys.some((key) => !Object.hasOwn(descriptors, key))
    )
  ) {
    throw new TypeError(`${field} has an invalid shape`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor) {
      if (optionalKeys.has(key)) continue;
      throw new TypeError(`${field}.${key} is required`);
    }
    if (
      !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      throw new TypeError(`${field}.${key} must be a data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function denseArrayDataValues(value, field) {
  rejectProxy(value, field);
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${field} must be a plain array`);
  }
  const descriptors = ownDataDescriptors(value, field);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError(`${field} has an invalid length`);
  }
  const allowedKeys = new Set(["length"]);
  const result = [];
  for (let index = 0; index < length; index++) {
    const key = String(index);
    allowedKeys.add(key);
    const descriptor = descriptors[key];
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      throw new TypeError(`${field} must be a dense data array`);
    }
    result.push(descriptor.value);
  }
  if (Object.keys(descriptors).some((key) => !allowedKeys.has(key))) {
    throw new TypeError(`${field} must not have extra properties`);
  }
  return result;
}

function snapshotObservationResponse(procedure, response) {
  if (procedure === PHASE4_MATCH_READ_PROCEDURE) {
    const raw = selectedDataValues(response, ["roles", "status"], {
      field: "match response",
      exact: true,
    });
    const roles = denseArrayDataValues(raw.roles, "match response.roles")
      .map((role, index) => {
        const item = selectedDataValues(
          role,
          ["endorsed", "roleId", "suggested"],
          { field: `match response.roles[${index}]` },
        );
        return Object.freeze({
          endorsed: snapshotPlainData(
            item.endorsed,
            `match response.roles[${index}].endorsed`,
          ),
          roleId: snapshotPlainData(
            item.roleId,
            `match response.roles[${index}].roleId`,
          ),
          suggested: snapshotPlainData(
            item.suggested,
            `match response.roles[${index}].suggested`,
          ),
        });
      });
    return Object.freeze({
      roles: Object.freeze(roles),
      status: snapshotPlainData(raw.status, "match response.status"),
    });
  }
  if (procedure === PHASE4_CURATED_LIST_READ_PROCEDURE) {
    if (response === null) return null;
    const raw = selectedDataValues(
      response,
      ["candidate_id", "candidate_user_id", "id", "roles"],
      { field: "Curated List response" },
    );
    const roles = denseArrayDataValues(
      raw.roles,
      "Curated List response.roles",
    ).map((role, index) => {
      const item = selectedDataValues(role, ["id"], {
        field: `Curated List response.roles[${index}]`,
      });
      return Object.freeze({
        id: snapshotPlainData(
          item.id,
          `Curated List response.roles[${index}].id`,
        ),
      });
    });
    return Object.freeze({
      candidate_id: snapshotPlainData(
        raw.candidate_id,
        "Curated List response.candidate_id",
      ),
      candidate_user_id: snapshotPlainData(
        raw.candidate_user_id,
        "Curated List response.candidate_user_id",
      ),
      id: snapshotPlainData(raw.id, "Curated List response.id"),
      roles: Object.freeze(roles),
    });
  }
  if (procedure === PHASE4_NOTIFICATION_SETTINGS_READ_PROCEDURE) {
    const raw = selectedDataValues(response, ["notification_types"], {
      field: "notification response",
    });
    return Object.freeze({
      notification_types: snapshotPlainData(
        raw.notification_types,
        "notification response.notification_types",
      ),
    });
  }
  if (procedure === PHASE4_CANDIDATE_IDENTITY_PROCEDURE) {
    const raw = selectedDataValues(
      response,
      ["candidate_id", "candidate_user_id"],
      { field: "identity response", exact: true },
    );
    return Object.freeze({
      candidate_id: snapshotPlainData(
        raw.candidate_id,
        "identity response.candidate_id",
      ),
      candidate_user_id: snapshotPlainData(
        raw.candidate_user_id,
        "identity response.candidate_user_id",
      ),
    });
  }
  return snapshotPlainData(response, "response");
}

function snapshotObservation(observation, expectedProcedure) {
  const raw = selectedDataValues(observation, OBSERVATION_KEYS, {
    field: "observation",
    exact: true,
  });
  return Object.freeze({
    version: snapshotPlainData(raw.version, "observation.version"),
    procedure: snapshotPlainData(
      raw.procedure,
      "observation.procedure",
    ),
    input: snapshotPlainData(raw.input, "observation.input"),
    response: snapshotObservationResponse(
      expectedProcedure,
      raw.response,
    ),
    observedAt: snapshotPlainData(
      raw.observedAt,
      "observation.observedAt",
    ),
    responseDigest: snapshotPlainData(
      raw.responseDigest,
      "observation.responseDigest",
    ),
    authoritative: snapshotPlainData(
      raw.authoritative,
      "observation.authoritative",
    ),
    complete: snapshotPlainData(
      raw.complete,
      "observation.complete",
    ),
    scopeDigest: snapshotPlainData(
      raw.scopeDigest,
      "observation.scopeDigest",
    ),
    sourceGenerationDigest: snapshotPlainData(
      raw.sourceGenerationDigest,
      "observation.sourceGenerationDigest",
    ),
    sourceCasRevision: snapshotPlainData(
      raw.sourceCasRevision,
      "observation.sourceCasRevision",
    ),
  });
}

/**
 * Compute the procedure-specific canonical digest used by source observations.
 * Match display fields (including score) are deliberately outside the semantic
 * contract and are never read.
 */
export function phase4CurationObservationResponseDigest(
  procedure,
  response,
) {
  return canonicalDigest(snapshotObservationResponse(procedure, response));
}

/**
 * Bind every semantic capture field except the digest field itself. Object-key
 * order is irrelevant; array order remains part of the captured contract.
 */
export function phase4CuratedListCaptureSemanticDigest(value) {
  const snapshot = snapshotPlainData(value, "capture attestation");
  if (!plainRecord(snapshot)) {
    throw new TypeError("capture attestation must be an object");
  }
  return canonicalDigest(snapshot, { omitSemanticDigest: true });
}

/**
 * Validate a hypothetical completed capture attestation against a digest
 * supplied by trusted code. This helper cannot authorize a write; production
 * authorization uses only the code-owned pinned attestation below.
 */
export function validatePhase4CuratedListCaptureAttestation(
  rawValue,
  {
    expectedSemanticDigest = null,
    expectedImplementationDigest = null,
    trustedNow = null,
  } = {},
) {
  const reasons = [];
  let value = null;
  try {
    const snapshot = snapshotPlainData(
      rawValue,
      "capture attestation",
    );
    value = plainRecord(snapshot) ? snapshot : null;
  } catch {
    value = null;
  }
  const trustedNowIso = canonicalIso(trustedNow);
  if (!lowercaseDigest(expectedSemanticDigest)) {
    reasons.push("capture_attestation_unpinned");
  }
  if (!lowercaseDigest(expectedImplementationDigest)) {
    reasons.push("capture_implementation_unpinned");
  }
  if (!trustedNowIso) {
    reasons.push("capture_trusted_time_invalid");
  }
  if (!hasExactKeys(value, CAPTURE_TOP_LEVEL_KEYS)) {
    reasons.push("capture_attestation_shape_invalid");
  } else {
    if (
      value.version !== PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION
      || value.contractVersion !== PHASE4_CURATION_CONTRACT_VERSION
      || value.status !== "verified"
      || value.captureSource !== "authenticated_paraform_ui"
    ) {
      reasons.push("capture_attestation_identity_invalid");
    }
    if (
      !lowercaseDigest(value.semanticDigest)
      || value.semanticDigest !== expectedSemanticDigest
      || value.semanticDigest
        !== canonicalDigest(value, { omitSemanticDigest: true })
    ) {
      reasons.push("capture_attestation_digest_invalid");
    }
    if (
      !lowercaseDigest(value.implementationDigest)
      || value.implementationDigest !== expectedImplementationDigest
    ) {
      reasons.push("capture_implementation_digest_invalid");
    }
    if (
      !hasExactKeys(
        value.evidenceDigests,
        CAPTURE_EVIDENCE_DIGEST_KEYS,
      )
      || CAPTURE_EVIDENCE_DIGEST_KEYS.some(
        (key) => !lowercaseDigest(value.evidenceDigests?.[key]),
      )
    ) {
      reasons.push("capture_evidence_digests_invalid");
    }
    const capturedAt = canonicalIso(value.capturedAt);
    const observedThroughAt = canonicalIso(value.observedThroughAt);
    if (
      !capturedAt
      || !observedThroughAt
      || Date.parse(observedThroughAt) < Date.parse(capturedAt)
      || (
        trustedNowIso
        && (
          Date.parse(capturedAt) > Date.parse(trustedNowIso)
          || Date.parse(observedThroughAt) > Date.parse(trustedNowIso)
        )
      )
    ) {
      reasons.push("capture_attestation_time_invalid");
    }

    if (!hasExactKeys(value.addContract, CAPTURE_ADD_CONTRACT_KEYS)) {
      reasons.push("capture_add_contract_shape_invalid");
    } else if (
      value.addContract.procedure !== PHASE4_CURATED_LIST_ADD_PROCEDURE
      || value.addContract.method !== "mutation"
      || value.addContract.typeValue !== PHASE4_CURATED_LIST_ADD_TYPE
      || value.addContract.sourceValue !== PHASE4_CURATED_LIST_ADD_SOURCE
      || !sameStringArray(
        value.addContract.inputKeys,
        PHASE4_CURATED_LIST_ADD_INPUT_KEYS,
      )
      || !expectedCaptureResponseKeys(value.addContract.responseKeys)
    ) {
      reasons.push("capture_add_contract_invalid");
    }

    if (!hasExactKeys(
      value.readbackContract,
      CAPTURE_READ_CONTRACT_KEYS,
    )) {
      reasons.push("capture_readback_contract_shape_invalid");
    } else if (
      value.readbackContract.procedure
        !== PHASE4_CURATED_LIST_READ_PROCEDURE
      || value.readbackContract.method !== "query"
      || value.readbackContract.candidateScoped !== true
      || value.readbackContract.nullOrObject !== true
      || value.readbackContract.roleIdPath !== "roles[].id"
      || !sameStringArray(
        value.readbackContract.inputKeys,
        PHASE4_CURATED_LIST_READ_INPUT_KEYS,
      )
    ) {
      reasons.push("capture_readback_contract_invalid");
    }

    if (!hasExactKeys(
      value.notificationContract,
      CAPTURE_NOTIFICATION_CONTRACT_KEYS,
    )) {
      reasons.push("capture_notification_contract_shape_invalid");
    } else if (
      value.notificationContract.procedure
        !== PHASE4_NOTIFICATION_SETTINGS_READ_PROCEDURE
      || value.notificationContract.method !== "query"
      || value.notificationContract.notificationType
        !== PHASE4_ROLE_ADDED_NOTIFICATION_TYPE
      || !sameStringArray(
        value.notificationContract.inputKeys,
        PHASE4_NOTIFICATION_SETTINGS_INPUT_KEYS,
      )
    ) {
      reasons.push("capture_notification_contract_invalid");
    }

    if (!hasExactKeys(value.behavior, CAPTURE_BEHAVIOR_KEYS)) {
      reasons.push("capture_behavior_shape_invalid");
    } else if (
      value.behavior.implicitCreateObserved !== true
      || value.behavior.duplicateReaddObserved !== true
      || value.behavior.duplicateDidNotDuplicate !== true
      || value.behavior.listIdentityStable !== true
      || !Number.isInteger(value.behavior.readbackLatencyMs)
      || value.behavior.readbackLatencyMs < 0
    ) {
      reasons.push("capture_behavior_invalid");
    }

    if (!hasExactKeys(value.emailSilence, CAPTURE_EMAIL_SILENCE_KEYS)) {
      reasons.push("capture_email_silence_shape_invalid");
    } else if (
      value.emailSilence.controlledRecipient !== true
      || value.emailSilence.notificationTypeDisabled !== true
      || value.emailSilence.candidateFacingEmailCount !== 0
      || !Number.isInteger(value.emailSilence.observedForMs)
      || value.emailSilence.observedForMs
        < PHASE4_CAPTURE_EMAIL_SILENCE_MIN_MS
      || (
        capturedAt
        && observedThroughAt
        && Date.parse(observedThroughAt) - Date.parse(capturedAt)
          !== value.emailSilence.observedForMs
      )
    ) {
      reasons.push("capture_email_silence_invalid");
    }

    if (!hasExactKeys(value.cleanup, CAPTURE_CLEANUP_KEYS)) {
      reasons.push("capture_cleanup_shape_invalid");
    } else if (
      value.cleanup.roleSetRestored !== true
      || value.cleanup.notificationSettingsUnchanged !== true
      || typeof value.cleanup.disposableEmptyListResidualRecorded
        !== "boolean"
    ) {
      reasons.push("capture_cleanup_invalid");
    }
  }

  return Object.freeze({
    valid: reasons.length === 0,
    reasons: frozenArray(reasons),
    version: value?.version ===
      PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION
      ? value.version
      : null,
    contractVersion: value?.contractVersion ===
      PHASE4_CURATION_CONTRACT_VERSION
      ? value.contractVersion
      : null,
  });
}

export function currentPhase4CuratedListCaptureDecision({
  trustedNow = new Date().toISOString(),
} = {}) {
  return validatePhase4CuratedListCaptureAttestation(
    PHASE4_CURATED_LIST_CAPTURE_ATTESTATION,
    {
      expectedSemanticDigest:
        PHASE4_PINNED_CAPTURE_ATTESTATION_DIGEST,
      expectedImplementationDigest:
        PHASE4_PINNED_CURATION_IMPLEMENTATION_DIGEST,
      trustedNow,
    },
  );
}

/**
 * Collapse the expected add response into the only reconciliation states the
 * policy accepts. Transport failure and any response-shape drift are both
 * unknown. This pure classifier is intentionally unbranded: its result can be
 * inspected and capture-tested, but cannot be passed to reconciliation.
 */
export function classifyPhase4CuratedListAddResponse(rawArguments = {}) {
  let args;
  try {
    args = shallowArgumentSnapshot(
      rawArguments,
      ["responseReceived", "response"],
      "add-response arguments",
    );
  } catch {
    return Object.freeze({
      outcome: "unknown",
      responseContractValid: false,
      accepted: false,
      rejected: false,
      externalWriteMayHaveLanded: true,
      curatedRoleListId: null,
      responseDigest: null,
      errorCode: "mutation_response_shape_invalid",
    });
  }
  const responseReceived = args.responseReceived;
  const response = Object.hasOwn(args, "response")
    ? args.response
    : null;
  if (responseReceived !== true) {
    return Object.freeze({
      outcome: "unknown",
      responseContractValid: false,
      accepted: false,
      rejected: false,
      externalWriteMayHaveLanded: true,
      curatedRoleListId: null,
      responseDigest: null,
      errorCode: "mutation_response_unknown",
    });
  }
  let responseSnapshot;
  let responseDigest;
  try {
    responseSnapshot = snapshotPlainData(
      response,
      "Curated List add response",
    );
    responseDigest = canonicalDigest(responseSnapshot);
  } catch {
    return Object.freeze({
      outcome: "unknown",
      responseContractValid: false,
      accepted: false,
      rejected: false,
      externalWriteMayHaveLanded: true,
      curatedRoleListId: null,
      responseDigest: null,
      errorCode: "mutation_response_shape_invalid",
    });
  }
  const record = plainRecord(responseSnapshot);
  if (!record) {
    return Object.freeze({
      outcome: "unknown",
      responseContractValid: false,
      accepted: false,
      rejected: false,
      externalWriteMayHaveLanded: true,
      curatedRoleListId: null,
      responseDigest,
      errorCode: "mutation_response_shape_invalid",
    });
  }
  const keys = Object.keys(record).sort();
  const allowed = new Set(PHASE4_CURATED_LIST_ADD_RESPONSE_KEYS);
  const exactAllowedKeys = (
    keys.every((key) => allowed.has(key))
    && Object.hasOwn(record, "success")
  );
  const messageValid = (
    !Object.hasOwn(record, "message")
    || record.message == null
    || (
      typeof record.message === "string"
      && record.message.length <= 512
    )
  );
  const listId = Object.hasOwn(record, "curated_role_list_id")
    ? boundedId(record.curated_role_list_id)
    : null;
  const listIdAbsent = (
    !Object.hasOwn(record, "curated_role_list_id")
    || record.curated_role_list_id == null
  );
  if (
    !exactAllowedKeys
    || typeof record.success !== "boolean"
    || !messageValid
    || (
      record.success === true
      && !listId
    )
    || (
      record.success === false
      && !listIdAbsent
    )
  ) {
    return Object.freeze({
      outcome: "unknown",
      responseContractValid: false,
      accepted: false,
      rejected: false,
      externalWriteMayHaveLanded: true,
      curatedRoleListId: null,
      responseDigest,
      errorCode: "mutation_response_shape_invalid",
    });
  }
  return Object.freeze({
    outcome: record.success ? "accepted" : "rejected",
    responseContractValid: true,
    accepted: record.success,
    rejected: !record.success,
    externalWriteMayHaveLanded: false,
    curatedRoleListId: record.success ? listId : null,
    responseDigest,
    errorCode: record.success ? null : "mutation_rejected",
  });
}

/**
 * Bind a pure add-response classification to the exact authorized request and
 * trusted observation time. Only the exact registered result can be
 * reconciled.
 */
export function phase4CuratedListMutationOutcome(rawArguments = {}) {
  let args;
  try {
    args = shallowArgumentSnapshot(
      rawArguments,
      [
        "request",
        "responseReceived",
        "response",
        "observedAt",
        "trustedNow",
      ],
      "mutation-outcome arguments",
    );
  } catch {
    throw new TypeError(
      "mutation outcome requires the exact registered request and trusted time",
    );
  }
  const request = args.request;
  const requestData = registeredData(
    authorizedRequestRegistry,
    request,
  );
  const context = exactScopeContext({
    ...proofScopeFields(requestData),
    trustedNow: args.trustedNow,
  });
  const observedAtIso = canonicalIso(args.observedAt);
  if (
    !requestData
    || !context
    || completedAuthorizedRequests.has(request)
    || requestData.contractVersion
      !== PHASE4_CURATION_CONTRACT_VERSION
    || requestData.requestDigest
      !== canonicalDigest({
        contractVersion: requestData.contractVersion,
        ...proofScopeFields(requestData),
        planSemanticDigest: requestData.planSemanticDigest,
        attemptNumber: requestData.attemptNumber,
        maxAttempts: requestData.maxAttempts,
        captureSemanticDigest: requestData.captureSemanticDigest,
        captureImplementationDigest:
          requestData.captureImplementationDigest,
        executionAt: requestData.executionAt,
        procedure: requestData.procedure,
        method: requestData.method,
        input: requestData.input,
      })
    || !observedAtIso
    || !observationFreshAt(
      observedAtIso,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    || Date.parse(observedAtIso) < Date.parse(requestData.executionAt)
    || Date.parse(context.trustedNow)
      > Date.parse(requestData.authorityExpiresAt)
  ) {
    throw new TypeError(
      "mutation outcome requires the exact registered request and trusted time",
    );
  }
  const classification = classifyPhase4CuratedListAddResponse({
    responseReceived: args.responseReceived,
    response: Object.hasOwn(args, "response") ? args.response : null,
  });
  completedAuthorizedRequests.add(request);
  const planData = requestData.planData;
  const base = {
    ...proofScopeFields(requestData),
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    request,
    requestDigest: requestData.requestDigest,
    observedAt: observedAtIso,
  };
  if (
    classification.accepted
    && planData.existingListId
    && classification.curatedRoleListId !== planData.existingListId
  ) {
    const fields = {
      ...base,
      outcome: "unknown",
      responseContractValid: false,
      accepted: false,
      rejected: false,
      externalWriteMayHaveLanded: true,
      curatedRoleListId: null,
      responseDigest: classification.responseDigest,
      errorCode: "mutation_list_identity_mismatch",
    };
    return registerArtifact(
      mutationOutcomeRegistry,
      { ...fields },
      {
        ...fields,
        requestData,
        planData,
      },
    );
  }
  const fields = {
    ...base,
    ...classification,
  };
  return registerArtifact(
    mutationOutcomeRegistry,
    { ...fields },
    {
      ...fields,
      requestData,
      planData,
    },
  );
}

function observationContractError(
  observation,
  context,
  expectedProcedure,
  expectedInputKeys,
) {
  if (!context) return "expected_context_invalid";
  if (!hasExactKeys(observation, OBSERVATION_KEYS)) {
    return "observation_shape_invalid";
  }
  if (
    observation.version !== PHASE4_CURATION_OBSERVATION_VERSION
    || observation.procedure !== expectedProcedure
    || observation.authoritative !== true
    || observation.complete !== true
    || !hasExactKeys(observation.input, expectedInputKeys)
    || !sameScope(observation, context)
    || !observationFreshAt(
      observation.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    || !lowercaseDigest(observation.responseDigest)
  ) {
    return "observation_contract_invalid";
  }
  let responseDigest;
  try {
    responseDigest = phase4CurationObservationResponseDigest(
      expectedProcedure,
      observation.response,
    );
  } catch {
    return "response_digest_invalid";
  }
  return responseDigest === observation.responseDigest
    ? null
    : "response_digest_invalid";
}

/**
 * Normalize the exact captured ranked-match response for Phase 4 curation.
 * Role score, rank, and display fields are never read. Both tier flags must be
 * booleans and exactly one must be true.
 */
export function normalizePhase4RankedMatchObservation(
  observation,
  {
    candidateId,
    recruiterUserId,
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow,
  } = {},
) {
  const expectedCandidateId = boundedId(candidateId);
  const expectedRecruiterUserId = boundedId(recruiterUserId);
  const context = exactScopeContext({
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow,
  });
  if (!expectedCandidateId || !expectedRecruiterUserId) {
    return invalidMatchProof("expected_identity_invalid");
  }
  try {
    observation = snapshotObservation(
      observation,
      PHASE4_MATCH_READ_PROCEDURE,
    );
  } catch {
    return invalidMatchProof("observation_shape_invalid");
  }
  const contractError = observationContractError(
    observation,
    context,
    PHASE4_MATCH_READ_PROCEDURE,
    [
      "candidate_id",
      "recruiter_user_id",
    ],
  );
  if (
    contractError
    || observation.input.candidate_id !== expectedCandidateId
    || observation.input.recruiter_user_id !== expectedRecruiterUserId
  ) {
    return invalidMatchProof(contractError || "observation_contract_invalid");
  }
  const response = plainRecord(observation.response);
  if (
    !response
    || !hasExactKeys(response, ["roles", "status"])
    || response.status !== "ranked"
    || !Array.isArray(response.roles)
    || response.roles.length > MAX_CURATED_ROLE_IDS
  ) {
    return invalidMatchProof("response_shape_invalid");
  }

  const recommendedRoleIds = [];
  const possibleRoleIds = [];
  const targetRoleIds = [];
  const seen = new Set();
  for (const role of response.roles) {
    if (!plainRecord(role)) {
      return invalidMatchProof("role_shape_invalid");
    }
    const roleId = boundedId(role.roleId);
    if (!roleId || seen.has(roleId)) {
      return invalidMatchProof(
        roleId ? "role_id_duplicate" : "role_id_invalid",
      );
    }
    if (
      typeof role.endorsed !== "boolean"
      || typeof role.suggested !== "boolean"
      || role.endorsed === role.suggested
    ) {
      return invalidMatchProof("tier_xor_invalid");
    }
    seen.add(roleId);
    targetRoleIds.push(roleId);
    if (role.endorsed) recommendedRoleIds.push(roleId);
    else possibleRoleIds.push(roleId);
  }

  const fields = {
    valid: true,
    authoritative: true,
    complete: true,
    errorCode: null,
    observedAt: observation.observedAt,
    responseDigest: observation.responseDigest,
    candidateId: expectedCandidateId,
    recruiterUserId: expectedRecruiterUserId,
    recommendedRoleIds: frozenArray(recommendedRoleIds),
    possibleRoleIds: frozenArray(possibleRoleIds),
    targetRoleIds: frozenArray(targetRoleIds),
    recommendedCount: recommendedRoleIds.length,
    possibleCount: possibleRoleIds.length,
    targetCount: targetRoleIds.length,
    ...proofScopeFields(context),
  };
  return registerArtifact(
    matchProofRegistry,
    { ...fields },
    { ...fields },
  );
}

/**
 * Normalize a candidate-scoped Curated List query. A null response is an
 * authoritative absence and models the implicit-create path. A present list
 * must bind both the candidate and candidate-user identities and expose exact,
 * unique role ids through roles[].id.
 */
export function normalizePhase4CuratedListReadback(
  observation,
  {
    candidateId,
    candidateUserId,
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow,
  } = {},
) {
  const expectedCandidateId = boundedId(candidateId);
  const expectedCandidateUserId = boundedId(candidateUserId);
  const context = exactScopeContext({
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow,
  });
  if (!expectedCandidateId || !expectedCandidateUserId) {
    return invalidReadbackProof("expected_identity_invalid");
  }
  try {
    observation = snapshotObservation(
      observation,
      PHASE4_CURATED_LIST_READ_PROCEDURE,
    );
  } catch {
    return invalidReadbackProof("observation_shape_invalid");
  }
  const contractError = observationContractError(
    observation,
    context,
    PHASE4_CURATED_LIST_READ_PROCEDURE,
    PHASE4_CURATED_LIST_READ_INPUT_KEYS,
  );
  if (
    contractError
    || observation.input.candidate_id !== expectedCandidateId
  ) {
    return invalidReadbackProof(
      contractError || "observation_contract_invalid",
    );
  }

  if (observation.response === null) {
    const fields = {
      valid: true,
      authoritative: true,
      complete: true,
      errorCode: null,
      observedAt: observation.observedAt,
      responseDigest: observation.responseDigest,
      candidateId: expectedCandidateId,
      // A null candidate-scoped Paraform response cannot establish the
      // candidate-user identifier. Planning the implicit-create path therefore
      // requires a separately registered source-generation identity proof.
      candidateUserId: null,
      exists: false,
      implicitCreateRequired: true,
      listId: null,
      roleIds: Object.freeze([]),
      roleCount: 0,
      ...proofScopeFields(context),
    };
    return registerArtifact(
      readbackProofRegistry,
      { ...fields },
      { ...fields },
    );
  }

  const response = plainRecord(observation.response);
  if (
    !response
    || !Object.hasOwn(response, "id")
    || !Object.hasOwn(response, "candidate_id")
    || !Object.hasOwn(response, "candidate_user_id")
    || !Object.hasOwn(response, "roles")
    || boundedId(response.id) == null
    || response.candidate_id !== expectedCandidateId
    || response.candidate_user_id !== expectedCandidateUserId
    || !Array.isArray(response.roles)
    || response.roles.length > MAX_CURATED_ROLE_IDS
  ) {
    return invalidReadbackProof("response_scope_invalid");
  }
  let roleIds;
  try {
    roleIds = strictUniqueIds(
      response.roles.map((role) => (
        plainRecord(role) ? role.id : null
      )),
      "curated roles",
    );
  } catch {
    return invalidReadbackProof("response_roles_invalid");
  }

  const fields = {
    valid: true,
    authoritative: true,
    complete: true,
    errorCode: null,
    observedAt: observation.observedAt,
    responseDigest: observation.responseDigest,
    candidateId: expectedCandidateId,
    candidateUserId: expectedCandidateUserId,
    exists: true,
    implicitCreateRequired: false,
    listId: response.id,
    roleIds: frozenArray(roleIds),
    roleCount: roleIds.length,
    ...proofScopeFields(context),
  };
  return registerArtifact(
    readbackProofRegistry,
    { ...fields },
    { ...fields },
  );
}

/**
 * Bind the two Paraform candidate identifiers to the exact source generation.
 * A future store adapter must produce this authoritative observation. It is
 * mandatory before a null readback may be interpreted as implicit creation.
 */
export function normalizePhase4CandidateIdentityObservation(
  observation,
  {
    candidateId,
    candidateUserId,
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow,
  } = {},
) {
  const expectedCandidateId = boundedId(candidateId);
  const expectedCandidateUserId = boundedId(candidateUserId);
  const context = exactScopeContext({
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow,
  });
  if (!expectedCandidateId || !expectedCandidateUserId) {
    return invalidIdentityProof("expected_identity_invalid");
  }
  try {
    observation = snapshotObservation(
      observation,
      PHASE4_CANDIDATE_IDENTITY_PROCEDURE,
    );
  } catch {
    return invalidIdentityProof("observation_shape_invalid");
  }
  const contractError = observationContractError(
    observation,
    context,
    PHASE4_CANDIDATE_IDENTITY_PROCEDURE,
    ["candidate_id"],
  );
  if (
    contractError
    || observation.input.candidate_id !== expectedCandidateId
  ) {
    return invalidIdentityProof(
      contractError || "observation_contract_invalid",
    );
  }
  const response = plainRecord(observation.response);
  if (
    !hasExactKeys(response, ["candidate_id", "candidate_user_id"])
    || response.candidate_id !== expectedCandidateId
    || response.candidate_user_id !== expectedCandidateUserId
  ) {
    return invalidIdentityProof("response_identity_invalid");
  }
  const fields = {
    valid: true,
    authoritative: true,
    complete: true,
    errorCode: null,
    observedAt: observation.observedAt,
    responseDigest: observation.responseDigest,
    candidateId: expectedCandidateId,
    candidateUserId: expectedCandidateUserId,
    ...proofScopeFields(context),
  };
  return registerArtifact(
    identityProofRegistry,
    { ...fields },
    { ...fields },
  );
}

/**
 * Normalize the per-candidate notification setting immediately before a
 * Curated List write. Missing, stale, incomplete, cross-candidate, or enabled
 * role-added notification state is never safe.
 */
export function normalizePhase4NotificationSafetyProof(
  observation,
  {
    candidateUserId,
    decisionAt,
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow,
  } = {},
) {
  const expectedCandidateUserId = boundedId(candidateUserId);
  const decisionAtIso = canonicalIso(decisionAt);
  const context = exactScopeContext({
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow,
  });
  if (
    !expectedCandidateUserId
    || !decisionAtIso
    || !context
    || decisionAtIso !== context.trustedNow
  ) {
    return invalidNotificationProof("expected_context_invalid");
  }
  try {
    observation = snapshotObservation(
      observation,
      PHASE4_NOTIFICATION_SETTINGS_READ_PROCEDURE,
    );
  } catch {
    return invalidNotificationProof("observation_shape_invalid");
  }
  const contractError = observationContractError(
    observation,
    context,
    PHASE4_NOTIFICATION_SETTINGS_READ_PROCEDURE,
    PHASE4_NOTIFICATION_SETTINGS_INPUT_KEYS,
  );
  const observedAt = canonicalIso(observation?.observedAt);
  if (
    contractError
    || observation.input.candidate_user_id !== expectedCandidateUserId
  ) {
    return invalidNotificationProof(
      contractError || "observation_contract_invalid",
    );
  }
  const ageMs = Date.parse(decisionAtIso) - Date.parse(observedAt);
  if (
    ageMs < 0
    || ageMs > PHASE4_NOTIFICATION_PROOF_MAX_AGE_MS
  ) {
    return invalidNotificationProof("notification_proof_stale");
  }
  const response = plainRecord(observation.response);
  if (!response || !Object.hasOwn(response, "notification_types")) {
    return invalidNotificationProof("response_shape_invalid");
  }
  let notificationTypes;
  try {
    notificationTypes = strictNotificationTypes(
      response.notification_types,
    );
  } catch {
    return invalidNotificationProof("notification_types_invalid");
  }
  const roleAddedNotificationEnabled = notificationTypes.includes(
    PHASE4_ROLE_ADDED_NOTIFICATION_TYPE,
  );

  const fields = {
    valid: true,
    authoritative: true,
    complete: true,
    safe: !roleAddedNotificationEnabled,
    errorCode: roleAddedNotificationEnabled
      ? "candidate_role_added_email_enabled"
      : null,
    observedAt,
    responseDigest: observation.responseDigest,
    candidateUserId: expectedCandidateUserId,
    notificationTypes: frozenArray(notificationTypes),
    roleAddedNotificationEnabled,
    ...proofScopeFields(context),
  };
  return registerArtifact(
    notificationProofRegistry,
    { ...fields },
    { ...fields },
  );
}

/**
 * Build the exact expected missing-only candidate add input. This is a plan,
 * not a mutation authorization; the code-owned capture attestation remains
 * unpinned and no authorized request can currently be created.
 */
export function planPhase4CuratedListWrite(rawArguments = {}) {
  const args = shallowArgumentSnapshot(
    rawArguments,
    [
      "scopeDigest",
      "sourceGenerationDigest",
      "sourceCasRevision",
      "trustedNow",
      "candidateId",
      "candidateUserId",
      "matchProof",
      "preReadback",
      "identityProof",
      "replanRequirement",
      "maxAttempts",
    ],
    "write-plan arguments",
  );
  const {
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow,
    candidateId,
    candidateUserId,
    matchProof,
    preReadback,
  } = args;
  const identityProof = Object.hasOwn(args, "identityProof")
    ? args.identityProof
    : null;
  const replanRequirement = Object.hasOwn(args, "replanRequirement")
    ? args.replanRequirement
    : null;
  const requestedMaxAttempts = Object.hasOwn(args, "maxAttempts")
    ? args.maxAttempts
    : PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX;
  const context = exactScopeContext({
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow,
  });
  if (!context) {
    throw new TypeError(
      "scope and source generation context must be exact and current",
    );
  }
  const exactCandidateId = boundedId(candidateId);
  const exactCandidateUserId = boundedId(candidateUserId);
  if (!exactCandidateId || !exactCandidateUserId) {
    throw new TypeError("candidate identities must be safe bounded ids");
  }
  const matchData = registeredData(matchProofRegistry, matchProof);
  const readbackData = registeredData(
    readbackProofRegistry,
    preReadback,
  );
  const identityData = registeredData(
    identityProofRegistry,
    identityProof,
  );
  const replanData = registeredData(
    replanRequirementRegistry,
    replanRequirement,
  );
  if (
    replanRequirement === null
    && (
      !Number.isSafeInteger(requestedMaxAttempts)
      || requestedMaxAttempts < 1
      || requestedMaxAttempts > PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX
    )
  ) {
    throw new RangeError(
      `maxAttempts must be between 1 and ${PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX}`,
    );
  }
  if (
    !matchData
    || matchData.valid !== true
    || matchData.candidateId !== exactCandidateId
    || !sameScope(matchData, context)
  ) {
    throw new TypeError("matchProof must be an exact candidate match proof");
  }
  if (
    !readbackData
    || readbackData.valid !== true
    || readbackData.candidateId !== exactCandidateId
    || !sameScope(readbackData, context)
    || (
      readbackData.exists === true
      && readbackData.candidateUserId !== exactCandidateUserId
    )
    || (
      readbackData.exists === false
      && readbackData.candidateUserId !== null
    )
  ) {
    throw new TypeError(
      "preReadback must be an exact candidate Curated List proof",
    );
  }
  if (
    Date.parse(matchData.observedAt) > Date.parse(readbackData.observedAt)
    || !observationFreshAt(
      matchData.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    || !observationFreshAt(
      readbackData.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
  ) {
    throw new TypeError("match/readback proof ordering is invalid");
  }
  if (readbackData.exists === false) {
    if (
      !identityData
      || identityData.valid !== true
      || identityData.candidateId !== exactCandidateId
      || identityData.candidateUserId !== exactCandidateUserId
      || !sameScope(identityData, context)
      || Date.parse(identityData.observedAt)
        > Date.parse(readbackData.observedAt)
      || !observationFreshAt(
        identityData.observedAt,
        context.trustedNow,
        PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
      )
    ) {
      throw new TypeError(
        "null readback requires an authoritative same-scope identity proof",
      );
    }
  } else if (
    identityProof !== null
    && (
      !identityData
      || identityData.valid !== true
      || identityData.candidateId !== exactCandidateId
      || identityData.candidateUserId !== exactCandidateUserId
      || !sameScope(identityData, context)
    )
  ) {
    throw new TypeError("identityProof is invalid");
  }
  if (
    replanRequirement !== null
    && (
      !replanData
      || consumedReplanRequirements.has(replanRequirement)
      || !sameScope(replanData, context)
      || replanData.candidateId !== exactCandidateId
      || replanData.candidateUserId !== exactCandidateUserId
      || replanData.postReadback !== preReadback
      || replanData.postReadbackData !== readbackData
      || replanData.postReadbackDigest
        !== readbackData.responseDigest
      || registeredData(
        writePlanRegistry,
        replanData.priorPlan,
      ) !== replanData.priorPlanData
      || registeredData(
        authorizedRequestRegistry,
        replanData.priorRequest,
      ) !== replanData.priorRequestData
      || registeredData(
        mutationOutcomeRegistry,
        replanData.priorOutcome,
      ) !== replanData.priorOutcomeData
      || replanData.priorRequestData.planData
        !== replanData.priorPlanData
      || replanData.priorOutcomeData.requestData
        !== replanData.priorRequestData
      || !observationFreshAt(
        replanData.issuedAt,
        context.trustedNow,
        PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
      )
      || !Number.isSafeInteger(replanData.completedAttemptCount)
      || !Number.isSafeInteger(replanData.nextAttemptNumber)
      || !Number.isSafeInteger(replanData.maxAttempts)
      || replanData.completedAttemptCount < 1
      || replanData.nextAttemptNumber
        !== replanData.completedAttemptCount + 1
      || replanData.nextAttemptNumber > replanData.maxAttempts
      || replanData.maxAttempts
        > PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX
      || (
        Object.hasOwn(args, "maxAttempts")
        && requestedMaxAttempts !== replanData.maxAttempts
      )
      || replanData.requirementDigest !== canonicalDigest({
        contractVersion: replanData.contractVersion,
        ...proofScopeFields(replanData),
        candidateId: replanData.candidateId,
        candidateUserId: replanData.candidateUserId,
        priorPlanSemanticDigest:
          replanData.priorPlanSemanticDigest,
        mutationRequestDigest:
          replanData.mutationRequestDigest,
        mutationResponseDigest:
          replanData.mutationResponseDigest,
        postReadbackDigest:
          replanData.postReadbackDigest,
        targetRoleIds: replanData.targetRoleIds,
        missingRoleIds: replanData.missingRoleIds,
        completedAttemptCount:
          replanData.completedAttemptCount,
        nextAttemptNumber: replanData.nextAttemptNumber,
        maxAttempts: replanData.maxAttempts,
        issuedAt: replanData.issuedAt,
      })
    )
  ) {
    throw new TypeError("replanRequirement is invalid");
  }
  const policyPlan = planCuratedAdds({
    scopeDigest,
    recommendedRoleIds: matchData.recommendedRoleIds,
    possibleRoleIds: matchData.possibleRoleIds,
    curatedRoleIds: readbackData.roleIds,
  });
  if (policyPlan.tierOverlapRoleIds.length !== 0) {
    throw new TypeError("tier proof must be mutually exclusive");
  }
  if (
    replanRequirement !== null
    && (
      !sameStringArray(
        replanData.targetRoleIds,
        policyPlan.targetRoleIds,
      )
      || !sameStringArray(
        replanData.missingRoleIds,
        policyPlan.missingRoleIds,
      )
    )
  ) {
    throw new TypeError(
      "replanRequirement does not match the fresh missing-only plan",
    );
  }
  const plannedInput = policyPlan.missingCount === 0
    ? null
    : Object.freeze({
      type: PHASE4_CURATED_LIST_ADD_TYPE,
      candidate_id: exactCandidateId,
      candidate_user_id: exactCandidateUserId,
      role_ids: frozenArray(policyPlan.missingRoleIds),
      source: PHASE4_CURATED_LIST_ADD_SOURCE,
    });

  const semanticFields = {
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    ...proofScopeFields(context),
    candidateId: exactCandidateId,
    candidateUserId: exactCandidateUserId,
    identityResponseDigest: identityData?.responseDigest || null,
    matchResponseDigest: matchData.responseDigest,
    preReadbackResponseDigest: readbackData.responseDigest,
    replanRequirementDigest:
      replanData?.requirementDigest || null,
    attemptNumber: replanData?.nextAttemptNumber || 1,
    maxAttempts: replanData?.maxAttempts || requestedMaxAttempts,
    plannedAt: context.trustedNow,
    plannedInput,
  };
  const planSemanticDigest = canonicalDigest(semanticFields);
  const fields = {
    ...proofScopeFields(context),
    candidateId: exactCandidateId,
    candidateUserId: exactCandidateUserId,
    matchProof,
    preReadback,
    identityProof,
    replanRequirement,
    policyPlan,
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    plannedAt: context.trustedNow,
    planSemanticDigest,
    captureAttestationVersion:
      PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
    implicitCreateExpected: readbackData.exists === false,
    listExistedBefore: readbackData.exists === true,
    existingListId: readbackData.listId,
    attemptNumber: semanticFields.attemptNumber,
    maxAttempts: semanticFields.maxAttempts,
    plannedInput,
    missingRoleIds: frozenArray(policyPlan.missingRoleIds),
    missingCount: policyPlan.missingCount,
    targetRoleIds: frozenArray(policyPlan.targetRoleIds),
    targetCount: policyPlan.targetCount,
    noMutationRequired: policyPlan.missingCount === 0,
  };
  const artifact = registerArtifact(
    writePlanRegistry,
    { ...fields },
    {
      ...fields,
      matchData,
      readbackData,
      identityData,
      replanData,
    },
  );
  if (replanRequirement !== null) {
    consumedReplanRequirements.add(replanRequirement);
  }
  return artifact;
}

function expectedWritePlanSemanticDigest(planData) {
  return canonicalDigest({
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    ...proofScopeFields(planData),
    candidateId: planData.candidateId,
    candidateUserId: planData.candidateUserId,
    identityResponseDigest:
      planData.identityData?.responseDigest || null,
    matchResponseDigest: planData.matchData.responseDigest,
    preReadbackResponseDigest: planData.readbackData.responseDigest,
    replanRequirementDigest:
      planData.replanData?.requirementDigest || null,
    attemptNumber: planData.attemptNumber,
    maxAttempts: planData.maxAttempts,
    plannedAt: planData.plannedAt,
    plannedInput: planData.plannedInput,
  });
}

function privateWritePlanLineageValid(plan, planData) {
  if (
    !planData
    || registeredData(writePlanRegistry, plan) !== planData
    || registeredData(
      matchProofRegistry,
      planData.matchProof,
    ) !== planData.matchData
    || registeredData(
      readbackProofRegistry,
      planData.preReadback,
    ) !== planData.readbackData
    || (
      planData.identityProof === null
        ? planData.identityData !== null
        : registeredData(
          identityProofRegistry,
          planData.identityProof,
        ) !== planData.identityData
    )
    || planData.contractVersion !== PHASE4_CURATION_CONTRACT_VERSION
    || planData.planSemanticDigest
      !== expectedWritePlanSemanticDigest(planData)
  ) {
    return false;
  }
  if (planData.replanRequirement === null) {
    return (
      planData.replanData === null
      && planData.attemptNumber === 1
      && Number.isSafeInteger(planData.maxAttempts)
      && planData.maxAttempts >= 1
      && planData.maxAttempts
        <= PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX
    );
  }
  const requirementData = registeredData(
    replanRequirementRegistry,
    planData.replanRequirement,
  );
  return Boolean(
    requirementData
    && requirementData === planData.replanData
    && planData.attemptNumber === requirementData.nextAttemptNumber
    && planData.maxAttempts === requirementData.maxAttempts
    && requirementData.nextAttemptNumber
      === requirementData.completedAttemptCount + 1
    && requirementData.postReadback === planData.preReadback
  );
}

/**
 * Evaluate the complete phase-local write fence. Because the code-owned capture
 * attestation is still unpinned, this function cannot currently return an
 * authorization token even when the candidate notification proof is safe.
 */
export function phase4CuratedListWriteAuthorization(rawArguments = {}) {
  let args;
  try {
    args = shallowArgumentSnapshot(
      rawArguments,
      [
        "plan",
        "notificationProof",
        "trustedNow",
        "globalWriteAuthority",
      ],
      "write-authorization arguments",
    );
  } catch {
    args = Object.freeze({});
  }
  const plan = args.plan;
  const notificationProof = args.notificationProof;
  const globalWriteAuthority = Object.hasOwn(
    args,
    "globalWriteAuthority",
  )
    ? args.globalWriteAuthority
    : null;
  const planData = registeredData(writePlanRegistry, plan);
  const notificationData = registeredData(
    notificationProofRegistry,
    notificationProof,
  );
  const authorityData = registeredData(
    globalWriteAuthorityRegistry,
    globalWriteAuthority,
  );
  const reasons = [];
  const decisionAtIso = canonicalIso(args.trustedNow);
  const validPlan = privateWritePlanLineageValid(plan, planData);
  const captureDecision = currentPhase4CuratedListCaptureDecision({
    trustedNow: decisionAtIso,
  });
  if (!validPlan) reasons.push("write_plan_invalid");
  if (!decisionAtIso) reasons.push("decision_time_invalid");
  if (
    validPlan
    && (
      !decisionAtIso
      || !observationFreshAt(
        planData.plannedAt,
        decisionAtIso,
        PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
      )
    )
  ) {
    reasons.push("write_plan_stale");
  }
  const captureVerification = authorityData
    ? authorityData.captureEvidenceVerification
    : null;
  const captureVerificationData = registeredData(
    captureEvidenceVerificationRegistry,
    captureVerification,
  );
  if (
    !authorityData
    || consumedGlobalWriteAuthorities.has(globalWriteAuthority)
    || !validPlan
    || authorityData.plan !== plan
    || authorityData.planData !== planData
    || !sameScope(authorityData, planData)
    || authorityData.planSemanticDigest
      !== planData.planSemanticDigest
    || authorityData.contractVersion
      !== PHASE4_CURATION_CONTRACT_VERSION
    || authorityData.sourceCasRevision !== planData?.sourceCasRevision
    || authorityData.attemptNumber !== planData?.attemptNumber
    || authorityData.maxAttempts !== planData?.maxAttempts
  ) {
    // No producer exists until a store-backed, single-use compare-and-set
    // authority is implemented and reviewed.
    reasons.push("global_write_authority_unavailable");
  }
  if (
    !authorityData
    || !decisionAtIso
    || authorityData.serverTrustedNow !== decisionAtIso
    || canonicalIso(authorityData.issuedAt) === null
    || canonicalIso(authorityData.expiresAt) === null
    || Date.parse(decisionAtIso) < Date.parse(authorityData.issuedAt)
    || Date.parse(decisionAtIso) > Date.parse(authorityData.expiresAt)
  ) {
    reasons.push("server_time_authority_unavailable");
  }
  if (
    !captureVerificationData
    || captureVerificationData.evidenceRecomputed !== true
    || captureVerificationData.implementationDerivedFromBuild !== true
    || captureVerificationData.contractVersion
      !== PHASE4_CURATION_CONTRACT_VERSION
    || !lowercaseDigest(
      captureVerificationData.captureSemanticDigest,
    )
    || !lowercaseDigest(
      captureVerificationData.implementationDigest,
    )
    || captureVerificationData.captureSemanticDigest
      !== PHASE4_PINNED_CAPTURE_ATTESTATION_DIGEST
    || captureVerificationData.implementationDigest
      !== PHASE4_PINNED_CURATION_IMPLEMENTATION_DIGEST
  ) {
    reasons.push("capture_evidence_verification_unavailable");
  }
  if (!captureDecision.valid) {
    reasons.push(...captureDecision.reasons);
  }
  if (validPlan && planData.noMutationRequired) {
    reasons.push("no_mutation_required");
  }
  if (
    !notificationData
    || notificationData.valid !== true
    || !validPlan
    || notificationData.candidateUserId !== planData.candidateUserId
    || !sameScope(notificationData, planData)
  ) {
    reasons.push("notification_proof_invalid");
  } else {
    if (notificationData.safe !== true) {
      reasons.push("candidate_role_added_email_enabled");
    }
    if (decisionAtIso) {
      const ageMs =
        Date.parse(decisionAtIso) - Date.parse(notificationData.observedAt);
      if (
        ageMs < 0
        || ageMs > PHASE4_NOTIFICATION_PROOF_MAX_AGE_MS
      ) {
        reasons.push("notification_proof_stale");
      }
      if (
        Date.parse(notificationData.observedAt)
        < Date.parse(planData.plannedAt)
      ) {
        reasons.push("notification_proof_precedes_plan");
      }
    }
  }
  const uniqueReasons = [...new Set(reasons)];
  const allowed = uniqueReasons.length === 0;
  const authorization = allowed
    ? (() => {
      const fields = {
        allowed: true,
        plan,
        ...proofScopeFields(planData),
        contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
        planSemanticDigest: planData.planSemanticDigest,
        attemptNumber: planData.attemptNumber,
        maxAttempts: planData.maxAttempts,
        captureSemanticDigest:
          captureVerificationData.captureSemanticDigest,
        captureImplementationDigest:
          captureVerificationData.implementationDigest,
        captureAttestationVersion:
          PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
        decisionAt: decisionAtIso,
        notificationObservedAt: notificationData.observedAt,
        notificationResponseDigest: notificationData.responseDigest,
        expiresAt: new Date(
          Math.min(
            Date.parse(notificationData.observedAt)
              + PHASE4_NOTIFICATION_PROOF_MAX_AGE_MS,
            Date.parse(authorityData.expiresAt),
          ),
        ).toISOString(),
      };
      return registerArtifact(
        writeAuthorizationRegistry,
        { ...fields },
        {
          ...fields,
          planData,
          notificationData,
          globalWriteAuthority,
          authorityData,
          captureVerification,
          captureVerificationData,
        },
      );
    })()
    : null;

  return Object.freeze({
    allowed,
    reasons: frozenArray(uniqueReasons),
    captureAttestationValid: captureDecision.valid,
    notificationSafe:
      notificationData?.valid === true
      && notificationData.safe === true,
    authorization,
  });
}

export function buildAuthorizedPhase4CuratedListAddRequest(
  rawArguments = {},
) {
  let args;
  try {
    args = shallowArgumentSnapshot(
      rawArguments,
      [
        "plan",
        "authorization",
        "executionAt",
        "scopeDigest",
        "sourceGenerationDigest",
        "sourceCasRevision",
        "trustedNow",
      ],
      "authorized-request arguments",
    );
  } catch {
    throw new Error("PHASE4_CURATED_LIST_WRITE_NOT_AUTHORIZED");
  }
  const plan = args.plan;
  const authorization = args.authorization;
  const planData = registeredData(writePlanRegistry, plan);
  const authorizationData = registeredData(
    writeAuthorizationRegistry,
    authorization,
  );
  const executionAtIso = canonicalIso(args.executionAt);
  const context = exactScopeContext({
    scopeDigest: args.scopeDigest,
    sourceGenerationDigest: args.sourceGenerationDigest,
    sourceCasRevision: args.sourceCasRevision,
    trustedNow: args.trustedNow,
  });
  const authority = authorizationData?.globalWriteAuthority || null;
  const authorityData = registeredData(
    globalWriteAuthorityRegistry,
    authority,
  );
  const captureVerification =
    authorizationData?.captureVerification || null;
  const captureVerificationData = registeredData(
    captureEvidenceVerificationRegistry,
    captureVerification,
  );
  const captureDecision = currentPhase4CuratedListCaptureDecision({
    trustedNow: executionAtIso,
  });
  if (
    !privateWritePlanLineageValid(plan, planData)
    || !authorizationData
    || consumedWriteAuthorizations.has(authorization)
    || authorizationData.allowed !== true
    || authorizationData.plan !== plan
    || authorizationData.planData !== planData
    || authorizationData.planSemanticDigest
      !== planData.planSemanticDigest
    || authorizationData.attemptNumber !== planData.attemptNumber
    || authorizationData.maxAttempts !== planData.maxAttempts
    || authorizationData.contractVersion
      !== PHASE4_CURATION_CONTRACT_VERSION
    || !lowercaseDigest(authorizationData.captureSemanticDigest)
    || !lowercaseDigest(
      authorizationData.captureImplementationDigest,
    )
    || authorizationData.captureSemanticDigest
      !== PHASE4_PINNED_CAPTURE_ATTESTATION_DIGEST
    || authorizationData.captureImplementationDigest
      !== PHASE4_PINNED_CURATION_IMPLEMENTATION_DIGEST
    || !captureDecision.valid
    || !captureVerificationData
    || captureVerificationData
      !== authorizationData.captureVerificationData
    || captureVerificationData.evidenceRecomputed !== true
    || captureVerificationData.implementationDerivedFromBuild !== true
    || captureVerificationData.captureSemanticDigest
      !== authorizationData.captureSemanticDigest
    || captureVerificationData.implementationDigest
      !== authorizationData.captureImplementationDigest
    || !authorityData
    || authorityData !== authorizationData.authorityData
    || consumedGlobalWriteAuthorities.has(authority)
    || authorityData.plan !== plan
    || authorityData.planData !== planData
    || authorityData.planSemanticDigest
      !== planData.planSemanticDigest
    || authorityData.sourceCasRevision !== planData.sourceCasRevision
    || authorityData.attemptNumber !== planData.attemptNumber
    || authorityData.maxAttempts !== planData.maxAttempts
    || authorityData.serverTrustedNow !== executionAtIso
    || executionAtIso !== authorizationData.decisionAt
    || !sameScope(authorizationData, planData)
    || !sameScope(authorityData, planData)
    || !context
    || !sameScope(context, planData)
    || !planData.plannedInput
    || !executionAtIso
    || executionAtIso !== context.trustedNow
    || Date.parse(executionAtIso)
      > Date.parse(authorizationData.expiresAt)
    || Date.parse(executionAtIso) < Date.parse(authorityData.issuedAt)
    || Date.parse(executionAtIso) > Date.parse(authorityData.expiresAt)
  ) {
    throw new Error("PHASE4_CURATED_LIST_WRITE_NOT_AUTHORIZED");
  }
  const input = Object.freeze({
    ...planData.plannedInput,
    role_ids: frozenArray(planData.plannedInput.role_ids),
  });
  const requestDigest = canonicalDigest({
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    ...proofScopeFields(context),
    planSemanticDigest: planData.planSemanticDigest,
    attemptNumber: planData.attemptNumber,
    maxAttempts: planData.maxAttempts,
    captureSemanticDigest: authorizationData.captureSemanticDigest,
    captureImplementationDigest:
      authorizationData.captureImplementationDigest,
    executionAt: executionAtIso,
    procedure: PHASE4_CURATED_LIST_ADD_PROCEDURE,
    method: "mutation",
    input,
  });
  const fields = {
    ...proofScopeFields(context),
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    plan,
    planSemanticDigest: planData.planSemanticDigest,
    attemptNumber: planData.attemptNumber,
    maxAttempts: planData.maxAttempts,
    captureSemanticDigest: authorizationData.captureSemanticDigest,
    captureImplementationDigest:
      authorizationData.captureImplementationDigest,
    executionAt: executionAtIso,
    requestDigest,
    procedure: PHASE4_CURATED_LIST_ADD_PROCEDURE,
    method: "mutation",
    input,
  };
  const request = registerArtifact(
    authorizedRequestRegistry,
    { ...fields },
    {
      ...fields,
      planData,
      authorization,
      authorizationData,
      authority,
      authorityData,
      captureVerification,
      captureVerificationData,
      authorityExpiresAt: authorityData.expiresAt,
    },
  );
  consumedWriteAuthorizations.add(authorization);
  consumedGlobalWriteAuthorities.add(authority);
  return request;
}

/**
 * Reconcile one mutation attempt. Missing or malformed readback always means
 * readback-only. An authoritative partial readback can plan only the exact
 * missing subset, and exhaustion blocks enrollment.
 */
export function reconcilePhase4CuratedListWrite(rawArguments = {}) {
  const args = shallowArgumentSnapshot(
    rawArguments,
    [
      "plan",
      "mutationOutcome",
      "postReadback",
      "attemptCount",
      "maxAttempts",
      "trustedNow",
    ],
    "reconciliation arguments",
  );
  const plan = args.plan;
  const mutationOutcome = args.mutationOutcome;
  const postReadback = Object.hasOwn(args, "postReadback")
    ? args.postReadback
    : null;
  const attemptCount = args.attemptCount;
  const maxAttempts = Object.hasOwn(args, "maxAttempts")
    ? args.maxAttempts
    : PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX;
  const planData = registeredData(writePlanRegistry, plan);
  const outcomeData = registeredData(
    mutationOutcomeRegistry,
    mutationOutcome,
  );
  const request = outcomeData?.request || null;
  const requestData = registeredData(
    authorizedRequestRegistry,
    request,
  );
  const postReadbackData = registeredData(
    readbackProofRegistry,
    postReadback,
  );
  if (
    !privateWritePlanLineageValid(plan, planData)
    || planData.noMutationRequired
  ) {
    throw new TypeError("plan must require a Curated List mutation");
  }
  strictPositiveInteger(attemptCount, "attemptCount");
  strictPositiveInteger(maxAttempts, "maxAttempts");
  const context = exactScopeContext({
    ...proofScopeFields(planData),
    trustedNow: args.trustedNow,
  });
  if (
    !context
    || !outcomeData
    || !requestData
    || reconciledMutationOutcomes.has(mutationOutcome)
    || outcomeData.requestData !== requestData
    || requestData.plan !== plan
    || requestData.planData !== planData
    || outcomeData.requestDigest !== requestData.requestDigest
    || outcomeData.contractVersion
      !== PHASE4_CURATION_CONTRACT_VERSION
    || !sameScope(outcomeData, planData)
    || !sameScope(requestData, planData)
    || !observationFreshAt(
      outcomeData.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    || Date.parse(requestData.executionAt)
      < Date.parse(planData.readbackData.observedAt)
    || Date.parse(outcomeData.observedAt)
      < Date.parse(requestData.executionAt)
  ) {
    throw new TypeError(
      "mutationOutcome must be the exact registered same-scope attempt outcome",
    );
  }
  if (maxAttempts > PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX) {
    throw new RangeError(
      `maxAttempts cannot exceed ${PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX}`,
    );
  }
  if (attemptCount > maxAttempts) {
    throw new RangeError("attemptCount cannot exceed maxAttempts");
  }
  if (
    attemptCount !== planData.attemptNumber
    || (
      planData.maxAttempts !== null
      && maxAttempts !== planData.maxAttempts
    )
  ) {
    throw new RangeError(
      "attemptCount and maxAttempts must strictly advance the plan lineage",
    );
  }

  const readbackValid = (
    postReadbackData?.valid === true
    && postReadbackData.candidateId === planData.candidateId
    && postReadbackData.candidateUserId === planData.candidateUserId
    && postReadbackData.exists === true
    && sameScope(postReadbackData, planData)
    && observationFreshAt(
      postReadbackData.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    && Date.parse(postReadbackData.observedAt)
      >= Date.parse(outcomeData.observedAt)
    && (
      !planData.existingListId
      || postReadbackData.listId === planData.existingListId
    )
    && (
      !outcomeData.curatedRoleListId
      || postReadbackData.listId === outcomeData.curatedRoleListId
    )
  );
  const policyDecision = curatedWriteReconciliationDecision({
    plan: planData.policyPlan,
    mutationOutcome: outcomeData.outcome,
    readbackState: readbackValid ? "authoritative" : "not_run",
    curatedRoleIds: readbackValid ? postReadbackData.roleIds : [],
    attemptCount,
    maxAttempts,
  });
  const replanRequirement =
    policyDecision.action === "plan_missing_only"
      ? (() => {
        const fields = {
          contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
          ...proofScopeFields(context),
          candidateId: planData.candidateId,
          candidateUserId: planData.candidateUserId,
          priorPlanSemanticDigest: planData.planSemanticDigest,
          mutationRequestDigest: outcomeData.requestDigest,
          mutationResponseDigest: outcomeData.responseDigest,
          postReadbackDigest: postReadbackData.responseDigest,
          targetRoleIds: frozenArray(policyDecision.targetRoleIds),
          missingRoleIds: frozenArray(policyDecision.missingRoleIds),
          completedAttemptCount: attemptCount,
          nextAttemptNumber: attemptCount + 1,
          maxAttempts,
          issuedAt: context.trustedNow,
        };
        const publicFields = {
          ...fields,
          requirementDigest: canonicalDigest(fields),
        };
        return registerArtifact(
          replanRequirementRegistry,
          { ...publicFields },
          {
            ...publicFields,
            priorPlan: plan,
            priorPlanData: planData,
            priorRequest: request,
            priorRequestData: requestData,
            priorOutcome: mutationOutcome,
            priorOutcomeData: outcomeData,
            postReadback,
            postReadbackData,
          },
        );
      })()
      : null;
  const implicitCreateObserved = Boolean(
    readbackValid
    && planData.readbackData.exists === false
    && postReadbackData.exists === true
    && postReadbackData.listId === outcomeData.curatedRoleListId
  );
  if (!policyDecision.readbackOnly) {
    reconciledMutationOutcomes.add(mutationOutcome);
  }

  return Object.freeze({
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    ...proofScopeFields(context),
    action: policyDecision.action,
    readbackOnly: policyDecision.readbackOnly,
    readbackValid,
    externalWriteMayHaveLanded:
      policyDecision.externalWriteMayHaveLanded,
    retryOriginalSetAllowed: false,
    missingOnlyPlanAllowed: policyDecision.missingOnlyPlanAllowed,
    enrollmentBlocked: policyDecision.enrollmentBlocked,
    attemptCount: policyDecision.attemptCount,
    maxAttempts: policyDecision.maxAttempts,
    attemptsRemaining: policyDecision.attemptsRemaining,
    mutationRequestDigest: outcomeData.requestDigest,
    mutationResponseDigest: outcomeData.responseDigest,
    mutationCuratedRoleListId:
      outcomeData.curatedRoleListId,
    missingRoleIds: frozenArray(policyDecision.missingRoleIds),
    missingCount: policyDecision.missingCount,
    verifiedCount: policyDecision.verifiedCount,
    replanRequired: replanRequirement !== null,
    replanRequirement,
    implicitCreateExpected: planData.implicitCreateExpected,
    implicitCreateObserved,
  });
}

function duplicateFailure(reason) {
  return Object.freeze({
    verified: false,
    reason,
    listIdentityStable: false,
    roleSetStable: false,
    targetsPresent: false,
    duplicateRoleCount: 0,
  });
}

/**
 * Prove that the deliberate capture re-add did not duplicate or replace list
 * membership. The proof is deliberately unreachable until the store-backed
 * authority can mint an authorized request: two unchanged readbacks alone are
 * not evidence that a duplicate mutation was actually attempted.
 */
export function phase4DuplicateReaddReadbackDecision(rawArguments = {}) {
  let args;
  try {
    args = shallowArgumentSnapshot(
      rawArguments,
      [
        "firstReadback",
        "authorizedRequest",
        "mutationOutcome",
        "duplicateReadback",
        "targetRoleIds",
        "trustedNow",
      ],
      "duplicate-readback arguments",
    );
  } catch {
    return duplicateFailure("duplicate_evidence_chain_invalid");
  }
  const {
    firstReadback,
    authorizedRequest,
    mutationOutcome,
    duplicateReadback,
    targetRoleIds,
    trustedNow,
  } = args;
  let targets;
  try {
    targets = strictUniqueIds(targetRoleIds, "targetRoleIds");
  } catch {
    return duplicateFailure("target_roles_invalid");
  }
  if (targets.length === 0) {
    return duplicateFailure("target_roles_empty");
  }
  const firstData = registeredData(
    readbackProofRegistry,
    firstReadback,
  );
  const requestData = registeredData(
    authorizedRequestRegistry,
    authorizedRequest,
  );
  const outcomeData = registeredData(
    mutationOutcomeRegistry,
    mutationOutcome,
  );
  const duplicateData = registeredData(
    readbackProofRegistry,
    duplicateReadback,
  );
  const context = exactScopeContext({
    ...proofScopeFields(firstData),
    trustedNow,
  });
  if (
    !context
    || firstData?.valid !== true
    || firstData.exists !== true
    || duplicateData?.valid !== true
    || duplicateData.exists !== true
    || !requestData
    || !outcomeData
    || outcomeData.request !== authorizedRequest
    || outcomeData.requestData !== requestData
    || outcomeData.requestDigest !== requestData.requestDigest
    || outcomeData.outcome !== "accepted"
    || outcomeData.responseContractValid !== true
    || outcomeData.curatedRoleListId !== firstData.listId
    || !sameScope(firstData, context)
    || !sameScope(requestData, context)
    || !sameScope(outcomeData, context)
    || !sameScope(duplicateData, context)
    || firstData.candidateId
      !== requestData.planData.candidateId
    || firstData.candidateUserId
      !== requestData.planData.candidateUserId
    || duplicateData.candidateId !== firstData.candidateId
    || duplicateData.candidateUserId
      !== firstData.candidateUserId
    || firstData.listId !== duplicateData.listId
    || !sameStringArray(requestData.input.role_ids, targets)
    || Date.parse(requestData.executionAt)
      < Date.parse(firstData.observedAt)
    || Date.parse(outcomeData.observedAt)
      < Date.parse(requestData.executionAt)
    || Date.parse(duplicateData.observedAt)
      < Date.parse(outcomeData.observedAt)
    || !observationFreshAt(
      firstData.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    || !observationFreshAt(
      duplicateData.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
  ) {
    return duplicateFailure("duplicate_evidence_chain_invalid");
  }
  const first = new Set(firstData.roleIds);
  const duplicate = new Set(duplicateData.roleIds);
  const roleSetStable = (
    first.size === duplicate.size
    && [...first].every((id) => duplicate.has(id))
  );
  const targetsPresent = targets.every((id) => duplicate.has(id));
  return Object.freeze({
    verified: roleSetStable && targetsPresent,
    reason: roleSetStable && targetsPresent
      ? null
      : "duplicate_readd_changed_role_set",
    listIdentityStable: true,
    roleSetStable,
    targetsPresent,
    duplicateRoleCount: duplicateData.roleCount,
  });
}

/**
 * Count only authoritative Recommended/Possible roles present in the post-add
 * list. Unrelated list roles never inflate the sequence-driving count.
 */
export function exactPhase4PostAddCuratedMatchCount(rawArguments = {}) {
  const args = shallowArgumentSnapshot(
    rawArguments,
    ["matchProof", "postReadback", "trustedNow"],
    "post-add count arguments",
  );
  const matchData = registeredData(
    matchProofRegistry,
    args.matchProof,
  );
  const readbackData = registeredData(
    readbackProofRegistry,
    args.postReadback,
  );
  const context = exactScopeContext({
    ...proofScopeFields(matchData),
    trustedNow: args.trustedNow,
  });
  if (
    !context
    || matchData?.valid !== true
    || readbackData?.valid !== true
    || readbackData.exists !== true
    || readbackData.candidateId !== matchData.candidateId
    || !sameScope(readbackData, matchData)
    || !observationFreshAt(
      matchData.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    || !observationFreshAt(
      readbackData.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    || Date.parse(readbackData.observedAt)
      < Date.parse(matchData.observedAt)
  ) {
    throw new TypeError(
      "exact match and candidate Curated List proofs are required",
    );
  }
  const present = new Set(readbackData.roleIds);
  const recommendedRoleIds = matchData.recommendedRoleIds
    .filter((id) => present.has(id));
  const possibleRoleIds = matchData.possibleRoleIds
    .filter((id) => present.has(id));
  const presentTargetRoleIds = matchData.targetRoleIds
    .filter((id) => present.has(id));
  const missingTargetRoleIds = matchData.targetRoleIds
    .filter((id) => !present.has(id));
  const targetSet = new Set(matchData.targetRoleIds);
  const unrelatedRoleCount = readbackData.roleIds
    .filter((id) => !targetSet.has(id)).length;

  return Object.freeze({
    authoritative: true,
    complete: missingTargetRoleIds.length === 0,
    enrollmentBlocked: missingTargetRoleIds.length !== 0,
    recommendedRoleIds: frozenArray(recommendedRoleIds),
    possibleRoleIds: frozenArray(possibleRoleIds),
    presentTargetRoleIds: frozenArray(presentTargetRoleIds),
    missingTargetRoleIds: frozenArray(missingTargetRoleIds),
    recommendedCount: recommendedRoleIds.length,
    possibleCount: possibleRoleIds.length,
    matchCount: presentTargetRoleIds.length,
    expectedMatchCount: matchData.targetCount,
    listRoleCount: readbackData.roleCount,
    unrelatedRoleCount,
  });
}

export function phase4CurationContractSummary() {
  const capture = currentPhase4CuratedListCaptureDecision();
  return Object.freeze({
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    captureAttestationVersion:
      PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
    capturePinned: capture.valid,
    // The source-store compare-and-set authority has intentionally not been
    // implemented. A future pinned capture alone must not open the write path.
    mutationAuthorizationAvailable: false,
    globalWriteAuthorityMinterAvailable: false,
    notificationFenceRequired: true,
    roleAddedNotificationType:
      PHASE4_ROLE_ADDED_NOTIFICATION_TYPE,
  });
}
