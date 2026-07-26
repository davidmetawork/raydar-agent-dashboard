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
const MATCH_PROOF = Symbol("phase4-match-proof");
const READBACK_PROOF = Symbol("phase4-readback-proof");
const IDENTITY_PROOF = Symbol("phase4-identity-proof");
const NOTIFICATION_PROOF = Symbol("phase4-notification-proof");
const WRITE_PLAN = Symbol("phase4-write-plan");
const WRITE_AUTHORIZATION = Symbol("phase4-write-authorization");
const AUTHORIZED_REQUEST = Symbol("phase4-authorized-request");
const MUTATION_OUTCOME = Symbol("phase4-mutation-outcome");
const REPLAN_REQUIREMENT = Symbol("phase4-replan-requirement");
const GLOBAL_WRITE_AUTHORITY = Symbol("phase4-global-write-authority");

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
    scopeDigest: null,
    sourceGenerationDigest: null,
    sourceCasRevision: null,
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
    scopeDigest: null,
    sourceGenerationDigest: null,
    sourceCasRevision: null,
  });
}

function invalidIdentityProof(errorCode) {
  return Object.freeze({
    [IDENTITY_PROOF]: true,
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

function canonicalObservationResponse(procedure, response) {
  if (procedure === PHASE4_MATCH_READ_PROCEDURE) {
    const record = plainRecord(response);
    return record
      ? {
        roles: Array.isArray(record.roles)
          ? record.roles.map((role) => {
            const item = plainRecord(role);
            return item
              ? {
                endorsed: item.endorsed,
                roleId: item.roleId,
                suggested: item.suggested,
              }
              : null;
          })
          : record.roles,
        status: record.status,
      }
      : response;
  }
  if (procedure === PHASE4_CURATED_LIST_READ_PROCEDURE) {
    if (response === null) return null;
    const record = plainRecord(response);
    return record
      ? {
        candidate_id: record.candidate_id,
        candidate_user_id: record.candidate_user_id,
        id: record.id,
        roles: Array.isArray(record.roles)
          ? record.roles.map((role) => {
            const item = plainRecord(role);
            return item ? { id: item.id } : null;
          })
          : record.roles,
      }
      : response;
  }
  if (procedure === PHASE4_NOTIFICATION_SETTINGS_READ_PROCEDURE) {
    const record = plainRecord(response);
    return record
      ? { notification_types: record.notification_types }
      : response;
  }
  if (procedure === PHASE4_CANDIDATE_IDENTITY_PROCEDURE) {
    const record = plainRecord(response);
    return record
      ? {
        candidate_id: record.candidate_id,
        candidate_user_id: record.candidate_user_id,
      }
      : response;
  }
  return response;
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
  return canonicalDigest(
    canonicalObservationResponse(procedure, response),
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
  return canonicalDigest(value, { omitSemanticDigest: true });
}

/**
 * Validate a hypothetical completed capture attestation against a digest
 * supplied by trusted code. This helper cannot authorize a write; production
 * authorization uses only the code-owned pinned attestation below.
 */
export function validatePhase4CuratedListCaptureAttestation(
  value,
  {
    expectedSemanticDigest = null,
    expectedImplementationDigest = null,
    trustedNow = null,
  } = {},
) {
  const reasons = [];
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
        !== phase4CuratedListCaptureSemanticDigest(value)
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
export function classifyPhase4CuratedListAddResponse({
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
      responseDigest: null,
      errorCode: "mutation_response_unknown",
    });
  }
  let responseDigest;
  try {
    responseDigest = canonicalDigest(response);
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
  const record = plainRecord(response);
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
 * trusted observation time. Only this private-brand result can be reconciled.
 */
export function phase4CuratedListMutationOutcome({
  request,
  responseReceived,
  response = null,
  observedAt,
  trustedNow,
} = {}) {
  const observedAtIso = canonicalIso(observedAt);
  const context = exactScopeContext({
    ...proofScopeFields(request),
    trustedNow,
  });
  const expectedRequestDigest = request?.[AUTHORIZED_REQUEST] === true
    ? canonicalDigest({
      contractVersion: request.contractVersion,
      ...proofScopeFields(request),
      planSemanticDigest: request.planSemanticDigest,
      captureSemanticDigest: request.captureSemanticDigest,
      captureImplementationDigest:
        request.captureImplementationDigest,
      executionAt: request.executionAt,
      procedure: request.procedure,
      method: request.method,
      input: request.input,
    })
    : null;
  if (
    request?.[AUTHORIZED_REQUEST] !== true
    || !context
    || request.contractVersion !== PHASE4_CURATION_CONTRACT_VERSION
    || request.requestDigest !== expectedRequestDigest
    || !observedAtIso
    || !observationFreshAt(
      observedAtIso,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    || Date.parse(observedAtIso) < Date.parse(request.executionAt)
  ) {
    throw new TypeError(
      "mutation outcome requires the exact branded request and trusted time",
    );
  }
  const classification = classifyPhase4CuratedListAddResponse({
    responseReceived,
    response,
  });
  const base = {
    [MUTATION_OUTCOME]: true,
    ...proofScopeFields(request),
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    request,
    requestDigest: request.requestDigest,
    observedAt: observedAtIso,
  };
  if (
    classification.accepted
    && request.plan.existingListId
    && classification.curatedRoleListId !== request.plan.existingListId
  ) {
    return Object.freeze({
      ...base,
      outcome: "unknown",
      responseContractValid: false,
      accepted: false,
      rejected: false,
      externalWriteMayHaveLanded: true,
      curatedRoleListId: null,
      responseDigest: classification.responseDigest,
      errorCode: "mutation_list_identity_mismatch",
    });
  }
  return Object.freeze({
    ...base,
    ...classification,
  });
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
    ...proofScopeFields(context),
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
    return Object.freeze({
      [READBACK_PROOF]: true,
      valid: true,
      authoritative: true,
      complete: true,
      errorCode: null,
      observedAt: observation.observedAt,
      responseDigest: observation.responseDigest,
      candidateId: expectedCandidateId,
      // A null candidate-scoped Paraform response cannot establish the
      // candidate-user identifier. Planning the implicit-create path therefore
      // requires a separately branded source-generation identity proof.
      candidateUserId: null,
      exists: false,
      implicitCreateRequired: true,
      listId: null,
      roleIds: Object.freeze([]),
      roleCount: 0,
      ...proofScopeFields(context),
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
    ...proofScopeFields(context),
  });
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
  return Object.freeze({
    [IDENTITY_PROOF]: true,
    valid: true,
    authoritative: true,
    complete: true,
    errorCode: null,
    observedAt: observation.observedAt,
    responseDigest: observation.responseDigest,
    candidateId: expectedCandidateId,
    candidateUserId: expectedCandidateUserId,
    ...proofScopeFields(context),
  });
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
    ...proofScopeFields(context),
  });
}

/**
 * Build the exact expected missing-only candidate add input. This is a plan,
 * not a mutation authorization; the code-owned capture attestation remains
 * unpinned and no authorized request can currently be created.
 */
export function planPhase4CuratedListWrite({
  scopeDigest,
  sourceGenerationDigest,
  sourceCasRevision,
  trustedNow,
  candidateId,
  candidateUserId,
  matchProof,
  preReadback,
  identityProof = null,
  replanRequirement = null,
} = {}) {
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
  if (
    matchProof?.[MATCH_PROOF] !== true
    || matchProof.valid !== true
    || matchProof.candidateId !== exactCandidateId
    || !sameScope(matchProof, context)
  ) {
    throw new TypeError("matchProof must be an exact candidate match proof");
  }
  if (
    preReadback?.[READBACK_PROOF] !== true
    || preReadback.valid !== true
    || preReadback.candidateId !== exactCandidateId
    || !sameScope(preReadback, context)
    || (
      preReadback.exists === true
      && preReadback.candidateUserId !== exactCandidateUserId
    )
    || (
      preReadback.exists === false
      && preReadback.candidateUserId !== null
    )
  ) {
    throw new TypeError(
      "preReadback must be an exact candidate Curated List proof",
    );
  }
  if (
    Date.parse(matchProof.observedAt) > Date.parse(preReadback.observedAt)
    || !observationFreshAt(
      matchProof.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    || !observationFreshAt(
      preReadback.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
  ) {
    throw new TypeError("match/readback proof ordering is invalid");
  }
  if (preReadback.exists === false) {
    if (
      identityProof?.[IDENTITY_PROOF] !== true
      || identityProof.valid !== true
      || identityProof.candidateId !== exactCandidateId
      || identityProof.candidateUserId !== exactCandidateUserId
      || !sameScope(identityProof, context)
      || Date.parse(identityProof.observedAt)
        > Date.parse(preReadback.observedAt)
      || !observationFreshAt(
        identityProof.observedAt,
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
      identityProof?.[IDENTITY_PROOF] !== true
      || identityProof.valid !== true
      || identityProof.candidateId !== exactCandidateId
      || identityProof.candidateUserId !== exactCandidateUserId
      || !sameScope(identityProof, context)
    )
  ) {
    throw new TypeError("identityProof is invalid");
  }
  if (
    replanRequirement !== null
    && (
      replanRequirement?.[REPLAN_REQUIREMENT] !== true
      || !sameScope(replanRequirement, context)
      || replanRequirement.candidateId !== exactCandidateId
      || replanRequirement.candidateUserId !== exactCandidateUserId
      || replanRequirement.postReadbackDigest
        !== preReadback.responseDigest
      || !observationFreshAt(
        replanRequirement.issuedAt,
        context.trustedNow,
        PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
      )
      || !Number.isSafeInteger(
        replanRequirement.completedAttemptCount,
      )
      || !Number.isSafeInteger(replanRequirement.maxAttempts)
      || replanRequirement.completedAttemptCount < 1
      || replanRequirement.completedAttemptCount
        >= replanRequirement.maxAttempts
      || replanRequirement.requirementDigest !== canonicalDigest({
        contractVersion: replanRequirement.contractVersion,
        ...proofScopeFields(replanRequirement),
        candidateId: replanRequirement.candidateId,
        candidateUserId: replanRequirement.candidateUserId,
        priorPlanSemanticDigest:
          replanRequirement.priorPlanSemanticDigest,
        mutationRequestDigest:
          replanRequirement.mutationRequestDigest,
        mutationResponseDigest:
          replanRequirement.mutationResponseDigest,
        postReadbackDigest:
          replanRequirement.postReadbackDigest,
        targetRoleIds: replanRequirement.targetRoleIds,
        missingRoleIds: replanRequirement.missingRoleIds,
        completedAttemptCount:
          replanRequirement.completedAttemptCount,
        maxAttempts: replanRequirement.maxAttempts,
        issuedAt: replanRequirement.issuedAt,
      })
    )
  ) {
    throw new TypeError("replanRequirement is invalid");
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
  if (
    replanRequirement !== null
    && (
      !sameStringArray(
        replanRequirement.targetRoleIds,
        policyPlan.targetRoleIds,
      )
      || !sameStringArray(
        replanRequirement.missingRoleIds,
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
    identityResponseDigest: identityProof?.responseDigest || null,
    matchResponseDigest: matchProof.responseDigest,
    preReadbackResponseDigest: preReadback.responseDigest,
    replanRequirementDigest:
      replanRequirement?.requirementDigest || null,
    plannedAt: context.trustedNow,
    plannedInput,
  };
  const planSemanticDigest = canonicalDigest(semanticFields);
  return Object.freeze({
    [WRITE_PLAN]: true,
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
  trustedNow,
  globalWriteAuthority = null,
} = {}) {
  const reasons = [];
  const decisionAtIso = canonicalIso(trustedNow);
  const validPlan = plan?.[WRITE_PLAN] === true;
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
        plan.plannedAt,
        decisionAtIso,
        PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
      )
    )
  ) {
    reasons.push("write_plan_stale");
  }
  if (
    globalWriteAuthority?.[GLOBAL_WRITE_AUTHORITY] !== true
    || !validPlan
    || !sameScope(globalWriteAuthority, plan)
    || globalWriteAuthority.planSemanticDigest
      !== plan.planSemanticDigest
    || globalWriteAuthority.contractVersion
      !== PHASE4_CURATION_CONTRACT_VERSION
  ) {
    // No producer for this private brand exists until the store-backed
    // compare-and-set authority is implemented and reviewed.
    reasons.push("global_write_authority_unavailable");
  }
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
    || !sameScope(notificationProof, plan)
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
      if (
        Date.parse(notificationProof.observedAt)
        < Date.parse(plan.plannedAt)
      ) {
        reasons.push("notification_proof_precedes_plan");
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
      ...proofScopeFields(plan),
      contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
      planSemanticDigest: plan.planSemanticDigest,
      captureSemanticDigest:
        PHASE4_PINNED_CAPTURE_ATTESTATION_DIGEST,
      captureImplementationDigest:
        PHASE4_PINNED_CURATION_IMPLEMENTATION_DIGEST,
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
  scopeDigest,
  sourceGenerationDigest,
  sourceCasRevision,
  trustedNow,
} = {}) {
  const executionAtIso = canonicalIso(executionAt);
  const context = exactScopeContext({
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow,
  });
  if (
    plan?.[WRITE_PLAN] !== true
    || authorization?.[WRITE_AUTHORIZATION] !== true
    || authorization.allowed !== true
    || authorization.plan !== plan
    || authorization.planSemanticDigest !== plan.planSemanticDigest
    || authorization.contractVersion
      !== PHASE4_CURATION_CONTRACT_VERSION
    || authorization.captureSemanticDigest
      !== PHASE4_PINNED_CAPTURE_ATTESTATION_DIGEST
    || authorization.captureImplementationDigest
      !== PHASE4_PINNED_CURATION_IMPLEMENTATION_DIGEST
    || !sameScope(authorization, plan)
    || !context
    || !sameScope(context, plan)
    || !plan.plannedInput
    || !executionAtIso
    || executionAtIso !== context.trustedNow
    || Date.parse(executionAtIso) < Date.parse(authorization.decisionAt)
    || Date.parse(executionAtIso) > Date.parse(authorization.expiresAt)
  ) {
    throw new Error("PHASE4_CURATED_LIST_WRITE_NOT_AUTHORIZED");
  }
  const input = Object.freeze({
    ...plan.plannedInput,
    role_ids: frozenArray(plan.plannedInput.role_ids),
  });
  const requestDigest = canonicalDigest({
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    ...proofScopeFields(context),
    planSemanticDigest: plan.planSemanticDigest,
    captureSemanticDigest: authorization.captureSemanticDigest,
    captureImplementationDigest:
      authorization.captureImplementationDigest,
    executionAt: executionAtIso,
    procedure: PHASE4_CURATED_LIST_ADD_PROCEDURE,
    method: "mutation",
    input,
  });
  return Object.freeze({
    [AUTHORIZED_REQUEST]: true,
    ...proofScopeFields(context),
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    plan,
    planSemanticDigest: plan.planSemanticDigest,
    captureSemanticDigest: authorization.captureSemanticDigest,
    captureImplementationDigest:
      authorization.captureImplementationDigest,
    executionAt: executionAtIso,
    requestDigest,
    procedure: PHASE4_CURATED_LIST_ADD_PROCEDURE,
    method: "mutation",
    input,
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
  attemptCount,
  maxAttempts = PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX,
  trustedNow,
} = {}) {
  if (plan?.[WRITE_PLAN] !== true || plan.noMutationRequired) {
    throw new TypeError("plan must require a Curated List mutation");
  }
  strictPositiveInteger(attemptCount, "attemptCount");
  strictPositiveInteger(maxAttempts, "maxAttempts");
  const context = exactScopeContext({
    ...proofScopeFields(plan),
    trustedNow,
  });
  if (
    !context
    || mutationOutcome?.[MUTATION_OUTCOME] !== true
    || mutationOutcome.request?.[AUTHORIZED_REQUEST] !== true
    || mutationOutcome.request.plan !== plan
    || mutationOutcome.requestDigest
      !== mutationOutcome.request.requestDigest
    || mutationOutcome.contractVersion
      !== PHASE4_CURATION_CONTRACT_VERSION
    || !sameScope(mutationOutcome, plan)
    || !sameScope(mutationOutcome.request, plan)
    || !observationFreshAt(
      mutationOutcome.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    || Date.parse(mutationOutcome.request.executionAt)
      < Date.parse(plan.preReadback.observedAt)
    || Date.parse(mutationOutcome.observedAt)
      < Date.parse(mutationOutcome.request.executionAt)
  ) {
    throw new TypeError(
      "mutationOutcome must be the exact branded same-scope attempt outcome",
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

  const readbackValid = (
    postReadback?.[READBACK_PROOF] === true
    && postReadback.valid === true
    && postReadback.candidateId === plan.candidateId
    && postReadback.candidateUserId === plan.candidateUserId
    && postReadback.exists === true
    && sameScope(postReadback, plan)
    && observationFreshAt(
      postReadback.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    && Date.parse(postReadback.observedAt)
      >= Date.parse(mutationOutcome.observedAt)
    && (
      !plan.existingListId
      || postReadback.listId === plan.existingListId
    )
    && (
      !mutationOutcome.curatedRoleListId
      || postReadback.listId === mutationOutcome.curatedRoleListId
    )
  );
  const policyDecision = curatedWriteReconciliationDecision({
    plan: plan.policyPlan,
    mutationOutcome: mutationOutcome.outcome,
    readbackState: readbackValid ? "authoritative" : "not_run",
    curatedRoleIds: readbackValid ? postReadback.roleIds : [],
    attemptCount,
    maxAttempts,
  });
  const replanRequirement =
    policyDecision.action === "plan_missing_only"
      ? (() => {
        const fields = {
          contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
          ...proofScopeFields(context),
          candidateId: plan.candidateId,
          candidateUserId: plan.candidateUserId,
          priorPlanSemanticDigest: plan.planSemanticDigest,
          mutationRequestDigest: mutationOutcome.requestDigest,
          mutationResponseDigest: mutationOutcome.responseDigest,
          postReadbackDigest: postReadback.responseDigest,
          targetRoleIds: frozenArray(policyDecision.targetRoleIds),
          missingRoleIds: frozenArray(policyDecision.missingRoleIds),
          completedAttemptCount: attemptCount,
          maxAttempts,
          issuedAt: context.trustedNow,
        };
        return Object.freeze({
          [REPLAN_REQUIREMENT]: true,
          ...fields,
          requirementDigest: canonicalDigest(fields),
        });
      })()
      : null;
  const implicitCreateObserved = Boolean(
    readbackValid
    && plan.preReadback.exists === false
    && postReadback.exists === true
    && postReadback.listId === mutationOutcome.curatedRoleListId
  );

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
    mutationRequestDigest: mutationOutcome.requestDigest,
    mutationResponseDigest: mutationOutcome.responseDigest,
    mutationCuratedRoleListId:
      mutationOutcome.curatedRoleListId,
    missingRoleIds: frozenArray(policyDecision.missingRoleIds),
    missingCount: policyDecision.missingCount,
    verifiedCount: policyDecision.verifiedCount,
    replanRequired: replanRequirement !== null,
    replanRequirement,
    implicitCreateExpected: plan.implicitCreateExpected,
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
export function phase4DuplicateReaddReadbackDecision({
  firstReadback,
  authorizedRequest,
  mutationOutcome,
  duplicateReadback,
  targetRoleIds,
  trustedNow,
} = {}) {
  let targets;
  try {
    targets = strictUniqueIds(targetRoleIds, "targetRoleIds");
  } catch {
    return duplicateFailure("target_roles_invalid");
  }
  if (targets.length === 0) {
    return duplicateFailure("target_roles_empty");
  }
  const context = exactScopeContext({
    ...proofScopeFields(firstReadback),
    trustedNow,
  });
  if (
    !context
    || firstReadback?.[READBACK_PROOF] !== true
    || firstReadback.valid !== true
    || firstReadback.exists !== true
    || duplicateReadback?.[READBACK_PROOF] !== true
    || duplicateReadback.valid !== true
    || duplicateReadback.exists !== true
    || authorizedRequest?.[AUTHORIZED_REQUEST] !== true
    || mutationOutcome?.[MUTATION_OUTCOME] !== true
    || mutationOutcome.request !== authorizedRequest
    || mutationOutcome.requestDigest !== authorizedRequest.requestDigest
    || mutationOutcome.outcome !== "accepted"
    || mutationOutcome.responseContractValid !== true
    || mutationOutcome.curatedRoleListId !== firstReadback.listId
    || !sameScope(firstReadback, context)
    || !sameScope(authorizedRequest, context)
    || !sameScope(mutationOutcome, context)
    || !sameScope(duplicateReadback, context)
    || firstReadback.candidateId
      !== authorizedRequest.plan.candidateId
    || firstReadback.candidateUserId
      !== authorizedRequest.plan.candidateUserId
    || duplicateReadback.candidateId !== firstReadback.candidateId
    || duplicateReadback.candidateUserId
      !== firstReadback.candidateUserId
    || firstReadback.listId !== duplicateReadback.listId
    || !sameStringArray(authorizedRequest.input.role_ids, targets)
    || Date.parse(authorizedRequest.executionAt)
      < Date.parse(firstReadback.observedAt)
    || Date.parse(mutationOutcome.observedAt)
      < Date.parse(authorizedRequest.executionAt)
    || Date.parse(duplicateReadback.observedAt)
      < Date.parse(mutationOutcome.observedAt)
    || !observationFreshAt(
      firstReadback.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    || !observationFreshAt(
      duplicateReadback.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
  ) {
    return duplicateFailure("duplicate_evidence_chain_invalid");
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
    listIdentityStable: true,
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
  trustedNow,
} = {}) {
  const context = exactScopeContext({
    ...proofScopeFields(matchProof),
    trustedNow,
  });
  if (
    !context
    || matchProof?.[MATCH_PROOF] !== true
    || matchProof.valid !== true
    || postReadback?.[READBACK_PROOF] !== true
    || postReadback.valid !== true
    || postReadback.exists !== true
    || postReadback.candidateId !== matchProof.candidateId
    || !sameScope(postReadback, matchProof)
    || !observationFreshAt(
      matchProof.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
    || !observationFreshAt(
      postReadback.observedAt,
      context.trustedNow,
      PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
    )
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
    // The source-store compare-and-set authority has intentionally not been
    // implemented. A future pinned capture alone must not open the write path.
    mutationAuthorizationAvailable: false,
    globalWriteAuthorityMinterAvailable: false,
    notificationFenceRequired: true,
    roleAddedNotificationType:
      PHASE4_ROLE_ADDED_NOTIFICATION_TYPE,
  });
}
