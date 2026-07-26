// Dark Phase 4 Curated List client contract.
//
// This module deliberately performs no network, environment, store, queue, or
// pipeline work. It models the currently observed Paraform bundle contract and
// keeps mutation authorization impossible until a reviewed, versioned live
// capture attestation is pinned in this file.

import { createHash } from "node:crypto";

import {
  CURATED_ADD_ATTEMPT_LIMIT_MAX,
  curatedWriteReconciliationDecision,
  planCuratedAdds,
} from "./phase3-shadow-policy.mjs";

export const PHASE4_CURATION_CONTRACT_VERSION =
  "phase4-curation-contract-v1";
export const PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION = 1;
export const PHASE4_CURATION_OBSERVATION_VERSION = 1;

export const PHASE4_MATCH_READ_PROCEDURE =
  "candidateMatching.getRankedRolesForCandidate";
export const PHASE4_CURATED_LIST_READ_PROCEDURE =
  "curatedRoleList.getCandidateCuratedRoleList";
export const PHASE4_CURATED_LIST_ADD_PROCEDURE =
  "curatedRoleList.addRolesToCuratedList";
export const PHASE4_NOTIFICATION_SETTINGS_READ_PROCEDURE =
  "candidateUser.getCandidateNotificationSettings";

export const PHASE4_CURATED_LIST_ADD_TYPE = "candidate";
export const PHASE4_CURATED_LIST_ADD_SOURCE = "ADD_TO_ROLES";
export const PHASE4_ROLE_ADDED_NOTIFICATION_TYPE =
  "CURATED_LIST_ROLE_ADDED";

export const PHASE4_NOTIFICATION_PROOF_MAX_AGE_MS = 5 * 60_000;
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
const MATCH_PROOF = Symbol("phase4-match-proof");
const READBACK_PROOF = Symbol("phase4-readback-proof");
const NOTIFICATION_PROOF = Symbol("phase4-notification-proof");
const WRITE_PLAN = Symbol("phase4-write-plan");
const WRITE_AUTHORIZATION = Symbol("phase4-write-authorization");

const CAPTURE_TOP_LEVEL_KEYS = Object.freeze([
  "addContract",
  "behavior",
  "captureSource",
  "capturedAt",
  "cleanup",
  "contractVersion",
  "emailSilence",
  "notificationContract",
  "observedThroughAt",
  "readbackContract",
  "semanticDigest",
  "status",
  "version",
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

function frozenArray(value) {
  return Object.freeze([...value]);
}

function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
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
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  if (value.length > MAX_CURATED_ROLE_IDS) {
    throw new RangeError(
      `${field} cannot exceed ${MAX_CURATED_ROLE_IDS} entries`,
    );
  }
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
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
  if (!Array.isArray(value) || value.length > 250) {
    throw new TypeError(
      "notification_types must be a bounded array",
    );
  }
  const types = [];
  const seen = new Set();
  for (const raw of value) {
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

function invalidMatchProof(errorCode) {
  return Object.freeze({
    [MATCH_PROOF]: true,
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
  });
}

function invalidReadbackProof(errorCode) {
  return Object.freeze({
    [READBACK_PROOF]: true,
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
  });
}

function invalidNotificationProof(errorCode) {
  return Object.freeze({
    [NOTIFICATION_PROOF]: true,
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
  });
}

function expectedCaptureResponseKeys(value) {
  return sameStringArray(
    value,
    PHASE4_CURATED_LIST_ADD_RESPONSE_KEYS,
  );
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalJsonValue(item));
  }
  const record = plainRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => key !== "semanticDigest")
      .map((key) => [key, canonicalJsonValue(record[key])]),
  );
}

/**
 * Bind every semantic capture field except the digest field itself. Object-key
 * order is irrelevant; array order remains part of the captured contract.
 */
export function phase4CuratedListCaptureSemanticDigest(value) {
  if (!plainRecord(value)) {
    throw new TypeError("capture attestation must be an object");
  }
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest("hex");
}

/**
 * Validate a hypothetical completed capture attestation against a digest
 * supplied by trusted code. This helper cannot authorize a write; production
 * authorization uses only the code-owned pinned attestation below.
 */
export function validatePhase4CuratedListCaptureAttestation(
  value,
  { expectedSemanticDigest = null } = {},
) {
  const reasons = [];
  if (!lowercaseDigest(expectedSemanticDigest)) {
    reasons.push("capture_attestation_unpinned");
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
        !== phase4CuratedListCaptureSemanticDigest(value)
    ) {
      reasons.push("capture_attestation_digest_invalid");
    }
    const capturedAt = canonicalIso(value.capturedAt);
    const observedThroughAt = canonicalIso(value.observedThroughAt);
    if (
      !capturedAt
      || !observedThroughAt
      || Date.parse(observedThroughAt) < Date.parse(capturedAt)
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
          < PHASE4_CAPTURE_EMAIL_SILENCE_MIN_MS
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

export function currentPhase4CuratedListCaptureDecision() {
  return validatePhase4CuratedListCaptureAttestation(
    PHASE4_CURATED_LIST_CAPTURE_ATTESTATION,
    {
      expectedSemanticDigest:
        PHASE4_PINNED_CAPTURE_ATTESTATION_DIGEST,
    },
  );
}

/**
 * Collapse the expected add response into the only reconciliation states the
 * policy accepts. Transport failure and any response-shape drift are both
 * unknown: neither can authorize an original-set retry.
 */
export function phase4CuratedListMutationOutcome({
  responseReceived,
  response = null,
} = {}) {
  if (responseReceived !== true) {
    return Object.freeze({
      outcome: "unknown",
      responseContractValid: false,
      accepted: false,
      rejected: false,
      externalWriteMayHaveLanded: true,
      curatedRoleListId: null,
      errorCode: "mutation_response_unknown",
    });
  }
  const record = plainRecord(response);
  if (!record) {
    return Object.freeze({
      outcome: "unknown",
      responseContractValid: false,
      accepted: false,
      rejected: false,
      externalWriteMayHaveLanded: true,
      curatedRoleListId: null,
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
    errorCode: record.success ? null : "mutation_rejected",
  });
}

/**
 * Normalize the exact captured ranked-match response for Phase 4 curation.
 * Role score, rank, and display fields are never read. Both tier flags must be
 * booleans and exactly one must be true.
 */
export function normalizePhase4RankedMatchObservation(
  observation,
  { candidateId, recruiterUserId } = {},
) {
  const expectedCandidateId = boundedId(candidateId);
  const expectedRecruiterUserId = boundedId(recruiterUserId);
  if (!expectedCandidateId || !expectedRecruiterUserId) {
    return invalidMatchProof("expected_identity_invalid");
  }
  if (!hasExactKeys(observation, OBSERVATION_KEYS)) {
    return invalidMatchProof("observation_shape_invalid");
  }
  if (
    observation.version !== PHASE4_CURATION_OBSERVATION_VERSION
    || observation.procedure !== PHASE4_MATCH_READ_PROCEDURE
    || observation.authoritative !== true
    || observation.complete !== true
    || !canonicalIso(observation.observedAt)
    || !lowercaseDigest(observation.responseDigest)
    || !hasExactKeys(observation.input, [
      "candidate_id",
      "recruiter_user_id",
    ])
    || observation.input.candidate_id !== expectedCandidateId
    || observation.input.recruiter_user_id !== expectedRecruiterUserId
  ) {
    return invalidMatchProof("observation_contract_invalid");
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

  return Object.freeze({
    [MATCH_PROOF]: true,
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
  });
}

/**
 * Normalize a candidate-scoped Curated List query. A null response is an
 * authoritative absence and models the implicit-create path. A present list
 * must bind both the candidate and candidate-user identities and expose exact,
 * unique role ids through roles[].id.
 */
export function normalizePhase4CuratedListReadback(
  observation,
  { candidateId, candidateUserId } = {},
) {
  const expectedCandidateId = boundedId(candidateId);
  const expectedCandidateUserId = boundedId(candidateUserId);
  if (!expectedCandidateId || !expectedCandidateUserId) {
    return invalidReadbackProof("expected_identity_invalid");
  }
  if (!hasExactKeys(observation, OBSERVATION_KEYS)) {
    return invalidReadbackProof("observation_shape_invalid");
  }
  if (
    observation.version !== PHASE4_CURATION_OBSERVATION_VERSION
    || observation.procedure !== PHASE4_CURATED_LIST_READ_PROCEDURE
    || observation.authoritative !== true
    || observation.complete !== true
    || !canonicalIso(observation.observedAt)
    || !lowercaseDigest(observation.responseDigest)
    || !hasExactKeys(
      observation.input,
      PHASE4_CURATED_LIST_READ_INPUT_KEYS,
    )
    || observation.input.candidate_id !== expectedCandidateId
  ) {
    return invalidReadbackProof("observation_contract_invalid");
  }

  if (observation.response === null) {
    return Object.freeze({
      [READBACK_PROOF]: true,
      valid: true,
      authoritative: true,
      complete: true,
      errorCode: null,
      observedAt: observation.observedAt,
      responseDigest: observation.responseDigest,
      candidateId: expectedCandidateId,
      candidateUserId: expectedCandidateUserId,
      exists: false,
      implicitCreateRequired: true,
      listId: null,
      roleIds: Object.freeze([]),
      roleCount: 0,
    });
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

  return Object.freeze({
    [READBACK_PROOF]: true,
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
  });
}

/**
 * Normalize the per-candidate notification setting immediately before a
 * Curated List write. Missing, stale, incomplete, cross-candidate, or enabled
 * role-added notification state is never safe.
 */
export function normalizePhase4NotificationSafetyProof(
  observation,
  { candidateUserId, decisionAt } = {},
) {
  const expectedCandidateUserId = boundedId(candidateUserId);
  const decisionAtIso = canonicalIso(decisionAt);
  if (!expectedCandidateUserId || !decisionAtIso) {
    return invalidNotificationProof("expected_context_invalid");
  }
  if (!hasExactKeys(observation, OBSERVATION_KEYS)) {
    return invalidNotificationProof("observation_shape_invalid");
  }
  const observedAt = canonicalIso(observation.observedAt);
  if (
    observation.version !== PHASE4_CURATION_OBSERVATION_VERSION
    || observation.procedure
      !== PHASE4_NOTIFICATION_SETTINGS_READ_PROCEDURE
    || observation.authoritative !== true
    || observation.complete !== true
    || !observedAt
    || !lowercaseDigest(observation.responseDigest)
    || !hasExactKeys(
      observation.input,
      PHASE4_NOTIFICATION_SETTINGS_INPUT_KEYS,
    )
    || observation.input.candidate_user_id !== expectedCandidateUserId
  ) {
    return invalidNotificationProof("observation_contract_invalid");
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

  return Object.freeze({
    [NOTIFICATION_PROOF]: true,
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
  });
}

/**
 * Build the exact expected missing-only candidate add input. This is a plan,
 * not a mutation authorization; the code-owned capture attestation remains
 * unpinned and no authorized request can currently be created.
 */
export function planPhase4CuratedListWrite({
  scopeDigest,
  candidateId,
  candidateUserId,
  matchProof,
  preReadback,
} = {}) {
  if (!lowercaseDigest(scopeDigest)) {
    throw new TypeError("scopeDigest must be a lowercase sha256 digest");
  }
  const exactCandidateId = boundedId(candidateId);
  const exactCandidateUserId = boundedId(candidateUserId);
  if (!exactCandidateId || !exactCandidateUserId) {
    throw new TypeError("candidate identities must be safe bounded ids");
  }
  if (
    matchProof?.[MATCH_PROOF] !== true
    || matchProof.valid !== true
    || matchProof.candidateId !== exactCandidateId
  ) {
    throw new TypeError("matchProof must be an exact candidate match proof");
  }
  if (
    preReadback?.[READBACK_PROOF] !== true
    || preReadback.valid !== true
    || preReadback.candidateId !== exactCandidateId
    || preReadback.candidateUserId !== exactCandidateUserId
  ) {
    throw new TypeError(
      "preReadback must be an exact candidate Curated List proof",
    );
  }
  const policyPlan = planCuratedAdds({
    scopeDigest,
    recommendedRoleIds: matchProof.recommendedRoleIds,
    possibleRoleIds: matchProof.possibleRoleIds,
    curatedRoleIds: preReadback.roleIds,
  });
  if (policyPlan.tierOverlapRoleIds.length !== 0) {
    throw new TypeError("tier proof must be mutually exclusive");
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

  return Object.freeze({
    [WRITE_PLAN]: true,
    scopeDigest,
    candidateId: exactCandidateId,
    candidateUserId: exactCandidateUserId,
    matchProof,
    preReadback,
    policyPlan,
    captureAttestationVersion:
      PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
    implicitCreateExpected: preReadback.exists === false,
    listExistedBefore: preReadback.exists === true,
    existingListId: preReadback.listId,
    plannedInput,
    missingRoleIds: frozenArray(policyPlan.missingRoleIds),
    missingCount: policyPlan.missingCount,
    targetRoleIds: frozenArray(policyPlan.targetRoleIds),
    targetCount: policyPlan.targetCount,
    noMutationRequired: policyPlan.missingCount === 0,
  });
}

/**
 * Evaluate the complete phase-local write fence. Because the code-owned capture
 * attestation is still unpinned, this function cannot currently return an
 * authorization token even when the candidate notification proof is safe.
 */
export function phase4CuratedListWriteAuthorization({
  plan,
  notificationProof,
  decisionAt,
} = {}) {
  const reasons = [];
  const decisionAtIso = canonicalIso(decisionAt);
  const validPlan = plan?.[WRITE_PLAN] === true;
  const captureDecision = currentPhase4CuratedListCaptureDecision();
  if (!validPlan) reasons.push("write_plan_invalid");
  if (!decisionAtIso) reasons.push("decision_time_invalid");
  if (!captureDecision.valid) {
    reasons.push(...captureDecision.reasons);
  }
  if (validPlan && plan.noMutationRequired) {
    reasons.push("no_mutation_required");
  }
  if (
    notificationProof?.[NOTIFICATION_PROOF] !== true
    || notificationProof.valid !== true
    || !validPlan
    || notificationProof.candidateUserId !== plan.candidateUserId
  ) {
    reasons.push("notification_proof_invalid");
  } else {
    if (notificationProof.safe !== true) {
      reasons.push("candidate_role_added_email_enabled");
    }
    if (decisionAtIso) {
      const ageMs =
        Date.parse(decisionAtIso) - Date.parse(notificationProof.observedAt);
      if (
        ageMs < 0
        || ageMs > PHASE4_NOTIFICATION_PROOF_MAX_AGE_MS
      ) {
        reasons.push("notification_proof_stale");
      }
    }
  }
  const uniqueReasons = [...new Set(reasons)];
  const allowed = uniqueReasons.length === 0;
  const authorization = allowed
    ? Object.freeze({
      [WRITE_AUTHORIZATION]: true,
      allowed: true,
      plan,
      captureAttestationVersion:
        PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
      decisionAt: decisionAtIso,
      notificationObservedAt: notificationProof.observedAt,
      notificationResponseDigest: notificationProof.responseDigest,
      expiresAt: new Date(
        Date.parse(notificationProof.observedAt)
          + PHASE4_NOTIFICATION_PROOF_MAX_AGE_MS,
      ).toISOString(),
    })
    : null;

  return Object.freeze({
    allowed,
    reasons: frozenArray(uniqueReasons),
    captureAttestationValid: captureDecision.valid,
    notificationSafe:
      notificationProof?.[NOTIFICATION_PROOF] === true
      && notificationProof.valid === true
      && notificationProof.safe === true,
    authorization,
  });
}

export function buildAuthorizedPhase4CuratedListAddRequest({
  plan,
  authorization,
  executionAt,
} = {}) {
  const executionAtIso = canonicalIso(executionAt);
  if (
    plan?.[WRITE_PLAN] !== true
    || authorization?.[WRITE_AUTHORIZATION] !== true
    || authorization.allowed !== true
    || authorization.plan !== plan
    || !plan.plannedInput
    || !executionAtIso
    || Date.parse(executionAtIso) < Date.parse(authorization.decisionAt)
    || Date.parse(executionAtIso) > Date.parse(authorization.expiresAt)
  ) {
    throw new Error("PHASE4_CURATED_LIST_WRITE_NOT_AUTHORIZED");
  }
  return Object.freeze({
    procedure: PHASE4_CURATED_LIST_ADD_PROCEDURE,
    method: "mutation",
    input: plan.plannedInput,
  });
}

/**
 * Reconcile one mutation attempt. Missing or malformed readback always means
 * readback-only. An authoritative partial readback can plan only the exact
 * missing subset, and exhaustion blocks enrollment.
 */
export function reconcilePhase4CuratedListWrite({
  plan,
  mutationOutcome,
  postReadback = null,
  mutationAttemptedAt,
  attemptCount,
  maxAttempts = PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX,
} = {}) {
  if (plan?.[WRITE_PLAN] !== true || plan.noMutationRequired) {
    throw new TypeError("plan must require a Curated List mutation");
  }
  strictPositiveInteger(attemptCount, "attemptCount");
  strictPositiveInteger(maxAttempts, "maxAttempts");
  const mutationAttemptedAtIso = canonicalIso(mutationAttemptedAt);
  if (
    !mutationAttemptedAtIso
    || Date.parse(mutationAttemptedAtIso)
      < Date.parse(plan.preReadback.observedAt)
  ) {
    throw new TypeError(
      "mutationAttemptedAt must be at or after the pre-write readback",
    );
  }
  if (maxAttempts > PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX) {
    throw new RangeError(
      `maxAttempts cannot exceed ${PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX}`,
    );
  }

  const readbackValid = (
    postReadback?.[READBACK_PROOF] === true
    && postReadback.valid === true
    && postReadback.candidateId === plan.candidateId
    && postReadback.candidateUserId === plan.candidateUserId
    && Date.parse(postReadback.observedAt)
      >= Date.parse(mutationAttemptedAtIso)
  );
  const policyDecision = curatedWriteReconciliationDecision({
    plan: plan.policyPlan,
    mutationOutcome,
    readbackState: readbackValid ? "authoritative" : "not_run",
    curatedRoleIds: readbackValid ? postReadback.roleIds : [],
    attemptCount,
    maxAttempts,
  });
  const nextPlannedInput = policyDecision.action === "plan_missing_only"
    ? Object.freeze({
      type: PHASE4_CURATED_LIST_ADD_TYPE,
      candidate_id: plan.candidateId,
      candidate_user_id: plan.candidateUserId,
      role_ids: frozenArray(policyDecision.missingRoleIds),
      source: PHASE4_CURATED_LIST_ADD_SOURCE,
    })
    : null;
  const implicitCreateObserved = Boolean(
    readbackValid
    && plan.preReadback.exists === false
    && postReadback.exists === true,
  );

  return Object.freeze({
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
    mutationAttemptedAt: mutationAttemptedAtIso,
    missingRoleIds: frozenArray(policyDecision.missingRoleIds),
    missingCount: policyDecision.missingCount,
    verifiedCount: policyDecision.verifiedCount,
    nextPlannedInput,
    implicitCreateExpected: plan.implicitCreateExpected,
    implicitCreateObserved,
  });
}

/**
 * Prove that the deliberate capture re-add did not duplicate or replace list
 * membership. This is capture evidence only and never authorizes a mutation.
 */
export function phase4DuplicateReaddReadbackDecision({
  firstReadback,
  duplicateReadback,
  duplicateAttemptedAt,
  targetRoleIds,
} = {}) {
  const duplicateAttemptedAtIso = canonicalIso(duplicateAttemptedAt);
  let targets;
  try {
    targets = strictUniqueIds(targetRoleIds, "targetRoleIds");
  } catch {
    return Object.freeze({
      verified: false,
      reason: "target_roles_invalid",
    });
  }
  if (
    firstReadback?.[READBACK_PROOF] !== true
    || firstReadback.valid !== true
    || firstReadback.exists !== true
    || duplicateReadback?.[READBACK_PROOF] !== true
    || duplicateReadback.valid !== true
    || duplicateReadback.exists !== true
    || !duplicateAttemptedAtIso
    || firstReadback.candidateId !== duplicateReadback.candidateId
    || firstReadback.candidateUserId !== duplicateReadback.candidateUserId
    || firstReadback.listId !== duplicateReadback.listId
    || Date.parse(duplicateAttemptedAtIso)
      < Date.parse(firstReadback.observedAt)
    || Date.parse(duplicateReadback.observedAt)
      < Date.parse(duplicateAttemptedAtIso)
  ) {
    return Object.freeze({
      verified: false,
      reason: "readback_scope_invalid",
    });
  }
  const first = new Set(firstReadback.roleIds);
  const duplicate = new Set(duplicateReadback.roleIds);
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
    listIdentityStable: firstReadback.listId === duplicateReadback.listId,
    roleSetStable,
    targetsPresent,
    duplicateRoleCount: duplicateReadback.roleCount,
  });
}

/**
 * Count only authoritative Recommended/Possible roles present in the post-add
 * list. Unrelated list roles never inflate the sequence-driving count.
 */
export function exactPhase4PostAddCuratedMatchCount({
  matchProof,
  postReadback,
} = {}) {
  if (
    matchProof?.[MATCH_PROOF] !== true
    || matchProof.valid !== true
    || postReadback?.[READBACK_PROOF] !== true
    || postReadback.valid !== true
    || postReadback.candidateId !== matchProof.candidateId
    || Date.parse(postReadback.observedAt)
      < Date.parse(matchProof.observedAt)
  ) {
    throw new TypeError(
      "exact match and candidate Curated List proofs are required",
    );
  }
  const present = new Set(postReadback.roleIds);
  const recommendedRoleIds = matchProof.recommendedRoleIds
    .filter((id) => present.has(id));
  const possibleRoleIds = matchProof.possibleRoleIds
    .filter((id) => present.has(id));
  const presentTargetRoleIds = matchProof.targetRoleIds
    .filter((id) => present.has(id));
  const missingTargetRoleIds = matchProof.targetRoleIds
    .filter((id) => !present.has(id));
  const targetSet = new Set(matchProof.targetRoleIds);
  const unrelatedRoleCount = postReadback.roleIds
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
    expectedMatchCount: matchProof.targetCount,
    listRoleCount: postReadback.roleCount,
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
    mutationAuthorizationAvailable: capture.valid,
    notificationFenceRequired: true,
    roleAddedNotificationType:
      PHASE4_ROLE_ADDED_NOTIFICATION_TYPE,
  });
}
