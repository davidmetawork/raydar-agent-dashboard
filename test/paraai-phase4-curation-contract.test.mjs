import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  PHASE4_CAPTURE_EMAIL_SILENCE_MIN_MS,
  PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
  PHASE4_CURATION_CONTRACT_VERSION,
  PHASE4_CURATION_OBSERVATION_VERSION,
  PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX,
  PHASE4_CURATED_LIST_ADD_INPUT_KEYS,
  PHASE4_CURATED_LIST_ADD_PROCEDURE,
  PHASE4_CURATED_LIST_ADD_RESPONSE_KEYS,
  PHASE4_CURATED_LIST_ADD_SOURCE,
  PHASE4_CURATED_LIST_ADD_TYPE,
  PHASE4_CURATED_LIST_READ_INPUT_KEYS,
  PHASE4_CURATED_LIST_READ_PROCEDURE,
  PHASE4_MATCH_READ_PROCEDURE,
  PHASE4_NOTIFICATION_PROOF_MAX_AGE_MS,
  PHASE4_NOTIFICATION_SETTINGS_INPUT_KEYS,
  PHASE4_NOTIFICATION_SETTINGS_READ_PROCEDURE,
  PHASE4_ROLE_ADDED_NOTIFICATION_TYPE,
  buildAuthorizedPhase4CuratedListAddRequest,
  currentPhase4CuratedListCaptureDecision,
  exactPhase4PostAddCuratedMatchCount,
  normalizePhase4CuratedListReadback,
  normalizePhase4NotificationSafetyProof,
  normalizePhase4RankedMatchObservation,
  phase4CurationContractSummary,
  phase4CuratedListCaptureSemanticDigest,
  phase4CuratedListMutationOutcome,
  phase4CuratedListWriteAuthorization,
  phase4DuplicateReaddReadbackDecision,
  planPhase4CuratedListWrite,
  reconcilePhase4CuratedListWrite,
  validatePhase4CuratedListCaptureAttestation,
} from "../api/paraai/_lib/phase4-curation-contract.mjs";

const CANDIDATE_ID = "candidate-contract-a";
const OTHER_CANDIDATE_ID = "candidate-contract-b";
const CANDIDATE_USER_ID = "candidate-user-contract-a";
const OTHER_CANDIDATE_USER_ID = "candidate-user-contract-b";
const RECRUITER_USER_ID = "recruiter-contract-a";
const SCOPE_DIGEST = "a".repeat(64);
const RESPONSE_DIGEST = "b".repeat(64);
const SECOND_RESPONSE_DIGEST = "c".repeat(64);
const MATCH_AT = "2026-07-26T00:00:00.000Z";
const PRE_READ_AT = "2026-07-26T00:01:00.000Z";
const MUTATION_AT = "2026-07-26T00:02:00.000Z";
const POST_READ_AT = "2026-07-26T00:03:00.000Z";
const DUPLICATE_AT = "2026-07-26T00:04:00.000Z";
const DUPLICATE_READ_AT = "2026-07-26T00:05:00.000Z";

function observation({
  procedure,
  input,
  response,
  observedAt = MATCH_AT,
  responseDigest = RESPONSE_DIGEST,
  authoritative = true,
  complete = true,
  version = PHASE4_CURATION_OBSERVATION_VERSION,
} = {}) {
  return {
    version,
    procedure,
    input,
    response,
    observedAt,
    responseDigest,
    authoritative,
    complete,
  };
}

function rankedObservation({
  candidateId = CANDIDATE_ID,
  recruiterUserId = RECRUITER_USER_ID,
  roles = [
    {
      roleId: "role-recommended",
      endorsed: true,
      suggested: false,
      score: 0.71,
    },
    {
      roleId: "role-possible",
      endorsed: false,
      suggested: true,
      score: 0.94,
    },
  ],
  status = "ranked",
  ...overrides
} = {}) {
  return observation({
    procedure: PHASE4_MATCH_READ_PROCEDURE,
    input: {
      candidate_id: candidateId,
      recruiter_user_id: recruiterUserId,
    },
    response: { status, roles },
    ...overrides,
  });
}

function rankedProof(options = {}) {
  const candidateId = options.candidateId || CANDIDATE_ID;
  const recruiterUserId =
    options.recruiterUserId || RECRUITER_USER_ID;
  return normalizePhase4RankedMatchObservation(
    rankedObservation(options),
    { candidateId, recruiterUserId },
  );
}

function curatedListResponse({
  candidateId = CANDIDATE_ID,
  candidateUserId = CANDIDATE_USER_ID,
  listId = "curated-list-contract-a",
  roleIds = [],
  extra = {},
} = {}) {
  return {
    id: listId,
    candidate_id: candidateId,
    candidate_user_id: candidateUserId,
    roles: roleIds.map((id) => ({ id })),
    ...extra,
  };
}

function readbackObservation({
  candidateId = CANDIDATE_ID,
  candidateUserId = CANDIDATE_USER_ID,
  exists = true,
  listId = "curated-list-contract-a",
  roleIds = [],
  observedAt = PRE_READ_AT,
  responseDigest = RESPONSE_DIGEST,
  response,
  ...overrides
} = {}) {
  const exactResponse = response !== undefined
    ? response
    : exists
      ? curatedListResponse({
        candidateId,
        candidateUserId,
        listId,
        roleIds,
      })
      : null;
  return observation({
    procedure: PHASE4_CURATED_LIST_READ_PROCEDURE,
    input: { candidate_id: candidateId },
    response: exactResponse,
    observedAt,
    responseDigest,
    ...overrides,
  });
}

function readbackProof(options = {}) {
  const candidateId = options.candidateId || CANDIDATE_ID;
  const candidateUserId =
    options.candidateUserId || CANDIDATE_USER_ID;
  return normalizePhase4CuratedListReadback(
    readbackObservation(options),
    { candidateId, candidateUserId },
  );
}

function notificationObservation({
  candidateUserId = CANDIDATE_USER_ID,
  notificationTypes = [],
  observedAt = MUTATION_AT,
  response,
  ...overrides
} = {}) {
  return observation({
    procedure: PHASE4_NOTIFICATION_SETTINGS_READ_PROCEDURE,
    input: { candidate_user_id: candidateUserId },
    response: response === undefined
      ? { notification_types: notificationTypes }
      : response,
    observedAt,
    responseDigest: SECOND_RESPONSE_DIGEST,
    ...overrides,
  });
}

function notificationProof({
  decisionAt = POST_READ_AT,
  candidateUserId = CANDIDATE_USER_ID,
  ...options
} = {}) {
  return normalizePhase4NotificationSafetyProof(
    notificationObservation({ candidateUserId, ...options }),
    { candidateUserId, decisionAt },
  );
}

function curationPlan({
  matchRoles,
  existingRoleIds = [],
  preExists = true,
  candidateId = CANDIDATE_ID,
  candidateUserId = CANDIDATE_USER_ID,
} = {}) {
  const matchProof = rankedProof({
    candidateId,
    roles: matchRoles,
  });
  const preReadback = readbackProof({
    candidateId,
    candidateUserId,
    exists: preExists,
    roleIds: existingRoleIds,
  });
  return planPhase4CuratedListWrite({
    scopeDigest: SCOPE_DIGEST,
    candidateId,
    candidateUserId,
    matchProof,
    preReadback,
  });
}

function captureAttestationBase() {
  return {
    version: PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    status: "verified",
    semanticDigest: null,
    captureSource: "authenticated_paraform_ui",
    capturedAt: "2026-07-26T00:00:00.000Z",
    observedThroughAt: "2026-07-28T00:00:00.000Z",
    addContract: {
      procedure: PHASE4_CURATED_LIST_ADD_PROCEDURE,
      method: "mutation",
      inputKeys: [...PHASE4_CURATED_LIST_ADD_INPUT_KEYS],
      responseKeys: [
        "curated_role_list_id",
        "message",
        "success",
      ],
      typeValue: PHASE4_CURATED_LIST_ADD_TYPE,
      sourceValue: PHASE4_CURATED_LIST_ADD_SOURCE,
    },
    readbackContract: {
      procedure: PHASE4_CURATED_LIST_READ_PROCEDURE,
      method: "query",
      inputKeys: [...PHASE4_CURATED_LIST_READ_INPUT_KEYS],
      candidateScoped: true,
      nullOrObject: true,
      roleIdPath: "roles[].id",
    },
    notificationContract: {
      procedure: PHASE4_NOTIFICATION_SETTINGS_READ_PROCEDURE,
      method: "query",
      inputKeys: [...PHASE4_NOTIFICATION_SETTINGS_INPUT_KEYS],
      notificationType: PHASE4_ROLE_ADDED_NOTIFICATION_TYPE,
    },
    behavior: {
      implicitCreateObserved: true,
      duplicateReaddObserved: true,
      duplicateDidNotDuplicate: true,
      listIdentityStable: true,
      readbackLatencyMs: 1_250,
    },
    emailSilence: {
      controlledRecipient: true,
      notificationTypeDisabled: true,
      candidateFacingEmailCount: 0,
      observedForMs: PHASE4_CAPTURE_EMAIL_SILENCE_MIN_MS,
    },
    cleanup: {
      roleSetRestored: true,
      notificationSettingsUnchanged: true,
      disposableEmptyListResidualRecorded: false,
    },
  };
}

function sealCapture(value = captureAttestationBase()) {
  const capture = structuredClone(value);
  capture.semanticDigest =
    phase4CuratedListCaptureSemanticDigest(capture);
  return capture;
}

test("capture attestation is semantic-digest bound and production stays dark", () => {
  const capture = sealCapture();
  assert.match(capture.semanticDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    validatePhase4CuratedListCaptureAttestation(capture, {
      expectedSemanticDigest: capture.semanticDigest,
    }),
    {
      valid: true,
      reasons: [],
      version: PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
      contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    },
  );

  const drifted = structuredClone(capture);
  drifted.behavior.readbackLatencyMs++;
  const driftDecision = validatePhase4CuratedListCaptureAttestation(
    drifted,
    { expectedSemanticDigest: capture.semanticDigest },
  );
  assert.equal(driftDecision.valid, false);
  assert.equal(
    driftDecision.reasons.includes("capture_attestation_digest_invalid"),
    true,
  );

  const current = currentPhase4CuratedListCaptureDecision();
  assert.equal(current.valid, false);
  assert.equal(
    current.reasons.includes("capture_attestation_unpinned"),
    true,
  );
  assert.deepEqual(phase4CurationContractSummary(), {
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    captureAttestationVersion:
      PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
    capturePinned: false,
    mutationAuthorizationAvailable: false,
    notificationFenceRequired: true,
    roleAddedNotificationType: PHASE4_ROLE_ADDED_NOTIFICATION_TYPE,
  });
});

test("capture attestation rejects contract, behavior, email, and cleanup drift", () => {
  const cases = [
    {
      reason: "capture_attestation_shape_invalid",
      mutate: (value) => {
        value.unreviewed = true;
      },
    },
    {
      reason: "capture_attestation_identity_invalid",
      mutate: (value) => {
        value.status = "almost_verified";
      },
    },
    {
      reason: "capture_attestation_time_invalid",
      mutate: (value) => {
        value.observedThroughAt = "2026-07-25T23:59:59.000Z";
      },
    },
    {
      reason: "capture_add_contract_invalid",
      mutate: (value) => {
        value.addContract.sourceValue = "CALLER_SUPPLIED_SOURCE";
      },
    },
    {
      reason: "capture_add_contract_invalid",
      mutate: (value) => {
        value.addContract.inputKeys.reverse();
      },
    },
    {
      reason: "capture_readback_contract_invalid",
      mutate: (value) => {
        value.readbackContract.procedure =
          "curatedRoleList.getCuratedRoleIds";
      },
    },
    {
      reason: "capture_notification_contract_invalid",
      mutate: (value) => {
        value.notificationContract.notificationType =
          "SOME_OTHER_NOTIFICATION";
      },
    },
    {
      reason: "capture_behavior_invalid",
      mutate: (value) => {
        value.behavior.implicitCreateObserved = false;
      },
    },
    {
      reason: "capture_behavior_invalid",
      mutate: (value) => {
        value.behavior.duplicateDidNotDuplicate = false;
      },
    },
    {
      reason: "capture_email_silence_invalid",
      mutate: (value) => {
        value.emailSilence.observedForMs =
          PHASE4_CAPTURE_EMAIL_SILENCE_MIN_MS - 1;
      },
    },
    {
      reason: "capture_email_silence_invalid",
      mutate: (value) => {
        value.emailSilence.candidateFacingEmailCount = 1;
      },
    },
    {
      reason: "capture_email_silence_invalid",
      mutate: (value) => {
        value.emailSilence.controlledRecipient = false;
      },
    },
    {
      reason: "capture_cleanup_invalid",
      mutate: (value) => {
        value.cleanup.roleSetRestored = false;
      },
    },
  ];

  for (const { reason, mutate } of cases) {
    const value = captureAttestationBase();
    mutate(value);
    const sealed = sealCapture(value);
    const decision = validatePhase4CuratedListCaptureAttestation(
      sealed,
      { expectedSemanticDigest: sealed.semanticDigest },
    );
    assert.equal(decision.valid, false, reason);
    assert.equal(decision.reasons.includes(reason), true, reason);
  }

  const valid = sealCapture();
  assert.equal(
    validatePhase4CuratedListCaptureAttestation(valid).reasons.includes(
      "capture_attestation_unpinned",
    ),
    true,
  );
  assert.equal(
    validatePhase4CuratedListCaptureAttestation(valid, {
      expectedSemanticDigest: "A".repeat(64),
    }).valid,
    false,
  );
});

test("ranked match proof unions exact tier flags and never reads score", () => {
  let scoreReads = 0;
  const scoreGuardedRecommended = Object.defineProperty(
    {
      roleId: "role-rec",
      endorsed: true,
      suggested: false,
      rank: 4,
    },
    "score",
    {
      enumerable: true,
      get() {
        scoreReads++;
        throw new Error("score must never be read");
      },
    },
  );
  const scoreGuardedPossible = Object.defineProperty(
    {
      roleId: "role-poss",
      endorsed: false,
      suggested: true,
      rank: 0,
    },
    "score",
    {
      enumerable: true,
      get() {
        scoreReads++;
        throw new Error("score must never be read");
      },
    },
  );
  const proof = rankedProof({
    roles: [scoreGuardedRecommended, scoreGuardedPossible],
  });

  assert.equal(proof.valid, true);
  assert.deepEqual(proof.recommendedRoleIds, ["role-rec"]);
  assert.deepEqual(proof.possibleRoleIds, ["role-poss"]);
  assert.deepEqual(proof.targetRoleIds, ["role-rec", "role-poss"]);
  assert.equal(proof.targetCount, 2);
  assert.equal(scoreReads, 0);
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(Object.isFrozen(proof.targetRoleIds), true);
});

test("add response classifier accepts only the captured response contract", () => {
  assert.deepEqual(PHASE4_CURATED_LIST_ADD_RESPONSE_KEYS, [
    "curated_role_list_id",
    "message",
    "success",
  ]);
  assert.deepEqual(phase4CuratedListMutationOutcome({
    responseReceived: true,
    response: {
      success: true,
      message: "Roles added",
      curated_role_list_id: "curated-list-contract-a",
    },
  }), {
    outcome: "accepted",
    responseContractValid: true,
    accepted: true,
    rejected: false,
    externalWriteMayHaveLanded: false,
    curatedRoleListId: "curated-list-contract-a",
    errorCode: null,
  });
  assert.deepEqual(phase4CuratedListMutationOutcome({
    responseReceived: true,
    response: {
      success: false,
      message: "Rejected",
    },
  }), {
    outcome: "rejected",
    responseContractValid: true,
    accepted: false,
    rejected: true,
    externalWriteMayHaveLanded: false,
    curatedRoleListId: null,
    errorCode: "mutation_rejected",
  });
});

test("transport uncertainty and add-response drift always classify unknown", () => {
  const unknowns = [
    {
      responseReceived: false,
      response: {
        success: true,
        curated_role_list_id: "untrusted-after-timeout",
      },
    },
    {
      responseReceived: true,
      response: {
        success: true,
      },
    },
    {
      responseReceived: true,
      response: {
        success: false,
        curated_role_list_id: "contradictory-list-id",
      },
    },
    {
      responseReceived: true,
      response: {
        success: true,
        curated_role_list_id: "curated-list-contract-a",
        unexpected: true,
      },
    },
    {
      responseReceived: true,
      response: {
        success: "true",
        curated_role_list_id: "curated-list-contract-a",
      },
    },
    {
      responseReceived: true,
      response: null,
    },
  ];
  for (const input of unknowns) {
    const decision = phase4CuratedListMutationOutcome(input);
    assert.equal(decision.outcome, "unknown");
    assert.equal(decision.responseContractValid, false);
    assert.equal(decision.externalWriteMayHaveLanded, true);
    assert.equal(decision.curatedRoleListId, null);
  }
});

test("ranked match proof rejects ambiguous tiers, malformed ids, and loose envelopes", () => {
  for (const role of [
    { roleId: "role-a", endorsed: true, suggested: true },
    { roleId: "role-a", endorsed: false, suggested: false },
    { roleId: "role-a", endorsed: 1, suggested: false },
    { roleId: "role a", endorsed: true, suggested: false },
  ]) {
    assert.equal(rankedProof({ roles: [role] }).valid, false);
  }
  assert.equal(rankedProof({
    roles: [
      { roleId: "role-a", endorsed: true, suggested: false },
      { roleId: "role-a", endorsed: false, suggested: true },
    ],
  }).errorCode, "role_id_duplicate");
  assert.equal(rankedProof({ status: "RANKED" }).valid, false);
  assert.equal(rankedProof({ status: "pending" }).valid, false);

  const extraTopLevel = rankedObservation();
  extraTopLevel.response.total = 2;
  assert.equal(
    normalizePhase4RankedMatchObservation(extraTopLevel, {
      candidateId: CANDIDATE_ID,
      recruiterUserId: RECRUITER_USER_ID,
    }).valid,
    false,
  );
  const looseInput = rankedObservation();
  looseInput.input.limit = 10;
  assert.equal(
    normalizePhase4RankedMatchObservation(looseInput, {
      candidateId: CANDIDATE_ID,
      recruiterUserId: RECRUITER_USER_ID,
    }).valid,
    false,
  );
  assert.equal(
    normalizePhase4RankedMatchObservation(rankedObservation(), {
      candidateId: OTHER_CANDIDATE_ID,
      recruiterUserId: RECRUITER_USER_ID,
    }).valid,
    false,
  );
});

test("candidate-scoped readback models null as implicit creation", () => {
  const absent = readbackProof({ exists: false });
  assert.equal(absent.valid, true);
  assert.equal(absent.exists, false);
  assert.equal(absent.implicitCreateRequired, true);
  assert.equal(absent.listId, null);
  assert.deepEqual(absent.roleIds, []);

  const present = readbackProof({
    roleIds: ["prior-role", "target-role"],
    response: curatedListResponse({
      roleIds: ["prior-role", "target-role"],
      extra: { harmless_display_field: "ignored" },
    }),
  });
  assert.equal(present.valid, true);
  assert.equal(present.exists, true);
  assert.equal(present.implicitCreateRequired, false);
  assert.deepEqual(present.roleIds, ["prior-role", "target-role"]);
  assert.equal(present.roleCount, 2);
});

test("candidate-scoped readback fails closed on scope and role ambiguity", () => {
  const invalidResponses = [
    curatedListResponse({ candidateId: OTHER_CANDIDATE_ID }),
    curatedListResponse({ candidateUserId: OTHER_CANDIDATE_USER_ID }),
    {
      id: "curated-list-contract-a",
      candidate_id: CANDIDATE_ID,
      candidate_user_id: CANDIDATE_USER_ID,
      roles: [{ roleId: "wrong-role-key" }],
    },
    curatedListResponse({ roleIds: ["duplicate-role", "duplicate-role"] }),
  ];
  for (const response of invalidResponses) {
    assert.equal(readbackProof({ response }).valid, false);
  }

  const agencyWideProcedure = readbackObservation();
  agencyWideProcedure.procedure = "curatedRoleList.getCuratedRoleIds";
  assert.equal(
    normalizePhase4CuratedListReadback(agencyWideProcedure, {
      candidateId: CANDIDATE_ID,
      candidateUserId: CANDIDATE_USER_ID,
    }).valid,
    false,
  );
  const looseInput = readbackObservation();
  looseInput.input.candidate_user_id = CANDIDATE_USER_ID;
  assert.equal(
    normalizePhase4CuratedListReadback(looseInput, {
      candidateId: CANDIDATE_ID,
      candidateUserId: CANDIDATE_USER_ID,
    }).valid,
    false,
  );
  assert.equal(readbackProof({
    responseDigest: "not-a-digest",
  }).valid, false);
  assert.equal(readbackProof({
    observedAt: "2026-07-26 00:01:00Z",
  }).valid, false);
});

test("notification proof is fresh, candidate-bound, and fail-closed", () => {
  const safe = notificationProof();
  assert.equal(safe.valid, true);
  assert.equal(safe.safe, true);
  assert.equal(safe.roleAddedNotificationEnabled, false);

  const enabled = notificationProof({
    notificationTypes: [
      "SOME_OTHER_NOTIFICATION",
      PHASE4_ROLE_ADDED_NOTIFICATION_TYPE,
    ],
  });
  assert.equal(enabled.valid, true);
  assert.equal(enabled.safe, false);
  assert.equal(
    enabled.errorCode,
    "candidate_role_added_email_enabled",
  );

  const boundaryObservedAt = new Date(
    Date.parse(POST_READ_AT) - PHASE4_NOTIFICATION_PROOF_MAX_AGE_MS,
  ).toISOString();
  assert.equal(notificationProof({
    observedAt: boundaryObservedAt,
  }).safe, true);
  assert.equal(notificationProof({
    observedAt: new Date(
      Date.parse(boundaryObservedAt) - 1,
    ).toISOString(),
  }).valid, false);
  assert.equal(notificationProof({
    observedAt: new Date(Date.parse(POST_READ_AT) + 1).toISOString(),
  }).valid, false);
});

test("notification proof rejects missing, malformed, stale, and cross-user state", () => {
  assert.equal(notificationProof({
    response: {},
  }).valid, false);
  assert.equal(notificationProof({
    response: { notification_types: null },
  }).valid, false);
  assert.equal(notificationProof({
    notificationTypes: ["DUPLICATE", "DUPLICATE"],
  }).valid, false);
  assert.equal(notificationProof({
    notificationTypes: ["lowercase-is-not-an-enum"],
  }).valid, false);

  const crossUser = notificationObservation({
    candidateUserId: OTHER_CANDIDATE_USER_ID,
  });
  assert.equal(
    normalizePhase4NotificationSafetyProof(crossUser, {
      candidateUserId: CANDIDATE_USER_ID,
      decisionAt: POST_READ_AT,
    }).valid,
    false,
  );
  const incomplete = notificationObservation({ complete: false });
  assert.equal(
    normalizePhase4NotificationSafetyProof(incomplete, {
      candidateUserId: CANDIDATE_USER_ID,
      decisionAt: POST_READ_AT,
    }).valid,
    false,
  );
  const looseInput = notificationObservation();
  looseInput.input.limit = 1;
  assert.equal(
    normalizePhase4NotificationSafetyProof(looseInput, {
      candidateUserId: CANDIDATE_USER_ID,
      decisionAt: POST_READ_AT,
    }).valid,
    false,
  );
});

test("write plan uses the exact missing-only add envelope for both tiers", () => {
  const plan = curationPlan({ existingRoleIds: ["role-possible"] });
  assert.equal(plan.noMutationRequired, false);
  assert.deepEqual(plan.missingRoleIds, ["role-recommended"]);
  assert.deepEqual(plan.plannedInput, {
    type: PHASE4_CURATED_LIST_ADD_TYPE,
    candidate_id: CANDIDATE_ID,
    candidate_user_id: CANDIDATE_USER_ID,
    role_ids: ["role-recommended"],
    source: PHASE4_CURATED_LIST_ADD_SOURCE,
  });
  assert.deepEqual(
    Object.keys(plan.plannedInput).sort(),
    [...PHASE4_CURATED_LIST_ADD_INPUT_KEYS].sort(),
  );
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.plannedInput), true);
  assert.equal(Object.isFrozen(plan.plannedInput.role_ids), true);

  const implicitCreate = curationPlan({ preExists: false });
  assert.equal(implicitCreate.implicitCreateExpected, true);
  assert.equal(implicitCreate.listExistedBefore, false);
  assert.deepEqual(
    implicitCreate.plannedInput.role_ids,
    ["role-recommended", "role-possible"],
  );

  const alreadyComplete = curationPlan({
    existingRoleIds: ["role-recommended", "role-possible", "unrelated"],
  });
  assert.equal(alreadyComplete.noMutationRequired, true);
  assert.equal(alreadyComplete.missingCount, 0);
  assert.equal(alreadyComplete.plannedInput, null);
});

test("write planning rejects proof substitution and invalid scope", () => {
  const matchProof = rankedProof();
  const preReadback = readbackProof();
  assert.throws(
    () => planPhase4CuratedListWrite({
      scopeDigest: "A".repeat(64),
      candidateId: CANDIDATE_ID,
      candidateUserId: CANDIDATE_USER_ID,
      matchProof,
      preReadback,
    }),
    /scopeDigest/,
  );
  assert.throws(
    () => planPhase4CuratedListWrite({
      scopeDigest: SCOPE_DIGEST,
      candidateId: OTHER_CANDIDATE_ID,
      candidateUserId: CANDIDATE_USER_ID,
      matchProof,
      preReadback,
    }),
    /matchProof/,
  );
  assert.throws(
    () => planPhase4CuratedListWrite({
      scopeDigest: SCOPE_DIGEST,
      candidateId: CANDIDATE_ID,
      candidateUserId: OTHER_CANDIDATE_USER_ID,
      matchProof,
      preReadback,
    }),
    /preReadback/,
  );
});

test("unpinned capture prevents authorization and request fabrication", () => {
  const plan = curationPlan();
  const safeNotification = notificationProof();
  const decision = phase4CuratedListWriteAuthorization({
    plan,
    notificationProof: safeNotification,
    decisionAt: POST_READ_AT,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.authorization, null);
  assert.equal(decision.captureAttestationValid, false);
  assert.equal(decision.notificationSafe, true);
  assert.equal(
    decision.reasons.includes("capture_attestation_unpinned"),
    true,
  );

  assert.throws(
    () => buildAuthorizedPhase4CuratedListAddRequest({
      plan,
      authorization: {
        allowed: true,
        plan,
        decisionAt: POST_READ_AT,
        expiresAt: DUPLICATE_READ_AT,
      },
      executionAt: DUPLICATE_AT,
    }),
    /PHASE4_CURATED_LIST_WRITE_NOT_AUTHORIZED/,
  );
  assert.throws(
    () => buildAuthorizedPhase4CuratedListAddRequest({
      plan,
      authorization: null,
      executionAt: DUPLICATE_AT,
    }),
    /PHASE4_CURATED_LIST_WRITE_NOT_AUTHORIZED/,
  );
});

test("enabled or stale notification state adds an independent write fence", () => {
  const plan = curationPlan();
  const enabledDecision = phase4CuratedListWriteAuthorization({
    plan,
    notificationProof: notificationProof({
      notificationTypes: [PHASE4_ROLE_ADDED_NOTIFICATION_TYPE],
    }),
    decisionAt: POST_READ_AT,
  });
  assert.equal(enabledDecision.allowed, false);
  assert.equal(
    enabledDecision.reasons.includes(
      "candidate_role_added_email_enabled",
    ),
    true,
  );

  const onceFresh = normalizePhase4NotificationSafetyProof(
    notificationObservation({
      observedAt: MUTATION_AT,
    }),
    {
      candidateUserId: CANDIDATE_USER_ID,
      decisionAt: POST_READ_AT,
    },
  );
  const lateDecisionAt = new Date(
    Date.parse(MUTATION_AT)
      + PHASE4_NOTIFICATION_PROOF_MAX_AGE_MS
      + 1,
  ).toISOString();
  const staleDecision = phase4CuratedListWriteAuthorization({
    plan,
    notificationProof: onceFresh,
    decisionAt: lateDecisionAt,
  });
  assert.equal(staleDecision.allowed, false);
  assert.equal(
    staleDecision.reasons.includes("notification_proof_stale"),
    true,
  );
});

test("unknown write outcome performs readback only until authoritative evidence", () => {
  const plan = curationPlan();
  const withoutReadback = reconcilePhase4CuratedListWrite({
    plan,
    mutationOutcome: "unknown",
    mutationAttemptedAt: MUTATION_AT,
    attemptCount: 1,
    maxAttempts: 3,
  });
  assert.equal(withoutReadback.action, "readback_only");
  assert.equal(withoutReadback.readbackOnly, true);
  assert.equal(withoutReadback.externalWriteMayHaveLanded, true);
  assert.equal(withoutReadback.retryOriginalSetAllowed, false);
  assert.equal(withoutReadback.nextPlannedInput, null);

  const staleReadback = readbackProof({
    roleIds: ["role-recommended", "role-possible"],
    observedAt: PRE_READ_AT,
  });
  const staleDecision = reconcilePhase4CuratedListWrite({
    plan,
    mutationOutcome: "unknown",
    postReadback: staleReadback,
    mutationAttemptedAt: MUTATION_AT,
    attemptCount: 1,
    maxAttempts: 3,
  });
  assert.equal(staleDecision.readbackValid, false);
  assert.equal(staleDecision.action, "readback_only");
});

test("authoritative reconciliation verifies full state or plans only missing roles", () => {
  const plan = curationPlan();
  const fullReadback = readbackProof({
    roleIds: [
      "role-recommended",
      "role-possible",
      "unrelated-prior-role",
    ],
    observedAt: POST_READ_AT,
    responseDigest: SECOND_RESPONSE_DIGEST,
  });
  const verified = reconcilePhase4CuratedListWrite({
    plan,
    mutationOutcome: "accepted",
    postReadback: fullReadback,
    mutationAttemptedAt: MUTATION_AT,
    attemptCount: 1,
    maxAttempts: 3,
  });
  assert.equal(verified.action, "verified");
  assert.equal(verified.enrollmentBlocked, false);
  assert.equal(verified.verifiedCount, 2);
  assert.equal(verified.nextPlannedInput, null);

  const partialReadback = readbackProof({
    roleIds: ["role-recommended", "unrelated-prior-role"],
    observedAt: POST_READ_AT,
    responseDigest: SECOND_RESPONSE_DIGEST,
  });
  const partial = reconcilePhase4CuratedListWrite({
    plan,
    mutationOutcome: "unknown",
    postReadback: partialReadback,
    mutationAttemptedAt: MUTATION_AT,
    attemptCount: 1,
    maxAttempts: 3,
  });
  assert.equal(partial.action, "plan_missing_only");
  assert.equal(partial.missingOnlyPlanAllowed, true);
  assert.equal(partial.retryOriginalSetAllowed, false);
  assert.deepEqual(partial.missingRoleIds, ["role-possible"]);
  assert.deepEqual(partial.nextPlannedInput, {
    type: PHASE4_CURATED_LIST_ADD_TYPE,
    candidate_id: CANDIDATE_ID,
    candidate_user_id: CANDIDATE_USER_ID,
    role_ids: ["role-possible"],
    source: PHASE4_CURATED_LIST_ADD_SOURCE,
  });
});

test("partial exhaustion and rejection block rather than understating count", () => {
  const plan = curationPlan();
  const partialReadback = readbackProof({
    roleIds: ["role-recommended"],
    observedAt: POST_READ_AT,
    responseDigest: SECOND_RESPONSE_DIGEST,
  });
  const exhausted = reconcilePhase4CuratedListWrite({
    plan,
    mutationOutcome: "unknown",
    postReadback: partialReadback,
    mutationAttemptedAt: MUTATION_AT,
    attemptCount: 3,
    maxAttempts: 3,
  });
  assert.equal(exhausted.action, "review_exhausted");
  assert.equal(exhausted.enrollmentBlocked, true);
  assert.equal(exhausted.nextPlannedInput, null);
  assert.equal(exhausted.attemptsRemaining, 0);

  const rejected = reconcilePhase4CuratedListWrite({
    plan,
    mutationOutcome: "rejected",
    postReadback: partialReadback,
    mutationAttemptedAt: MUTATION_AT,
    attemptCount: 1,
    maxAttempts: 3,
  });
  assert.equal(rejected.action, "review");
  assert.equal(rejected.enrollmentBlocked, true);
  assert.equal(rejected.nextPlannedInput, null);

  assert.throws(
    () => reconcilePhase4CuratedListWrite({
      plan,
      mutationOutcome: "unknown",
      mutationAttemptedAt: MATCH_AT,
      attemptCount: 1,
      maxAttempts: 3,
    }),
    /mutationAttemptedAt/,
  );
  assert.throws(
    () => reconcilePhase4CuratedListWrite({
      plan,
      mutationOutcome: "unknown",
      mutationAttemptedAt: MUTATION_AT,
      attemptCount: 1,
      maxAttempts: PHASE4_CURATED_ADD_ATTEMPT_LIMIT_MAX + 1,
    }),
    /cannot exceed/,
  );
});

test("null-to-object reconciliation records implicit creation only after the write", () => {
  const plan = curationPlan({ preExists: false });
  const createdReadback = readbackProof({
    roleIds: ["role-recommended", "role-possible"],
    observedAt: POST_READ_AT,
    responseDigest: SECOND_RESPONSE_DIGEST,
  });
  const created = reconcilePhase4CuratedListWrite({
    plan,
    mutationOutcome: "accepted",
    postReadback: createdReadback,
    mutationAttemptedAt: MUTATION_AT,
    attemptCount: 1,
    maxAttempts: 3,
  });
  assert.equal(created.action, "verified");
  assert.equal(created.implicitCreateExpected, true);
  assert.equal(created.implicitCreateObserved, true);

  const stillAbsent = reconcilePhase4CuratedListWrite({
    plan,
    mutationOutcome: "unknown",
    postReadback: readbackProof({
      exists: false,
      observedAt: POST_READ_AT,
      responseDigest: SECOND_RESPONSE_DIGEST,
    }),
    mutationAttemptedAt: MUTATION_AT,
    attemptCount: 1,
    maxAttempts: 3,
  });
  assert.equal(stillAbsent.implicitCreateObserved, false);
  assert.equal(stillAbsent.action, "plan_missing_only");
});

test("duplicate re-add proof requires stable list identity and role set", () => {
  const first = readbackProof({
    roleIds: ["role-recommended", "role-possible", "unrelated"],
    observedAt: POST_READ_AT,
  });
  const duplicate = readbackProof({
    roleIds: ["unrelated", "role-possible", "role-recommended"],
    observedAt: DUPLICATE_READ_AT,
    responseDigest: SECOND_RESPONSE_DIGEST,
  });
  const verified = phase4DuplicateReaddReadbackDecision({
    firstReadback: first,
    duplicateReadback: duplicate,
    duplicateAttemptedAt: DUPLICATE_AT,
    targetRoleIds: ["role-recommended", "role-possible"],
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.roleSetStable, true);
  assert.equal(verified.listIdentityStable, true);
  assert.equal(verified.targetsPresent, true);

  const changed = phase4DuplicateReaddReadbackDecision({
    firstReadback: first,
    duplicateReadback: readbackProof({
      roleIds: [
        "role-recommended",
        "role-possible",
        "unrelated",
        "duplicated-role",
      ],
      observedAt: DUPLICATE_READ_AT,
    }),
    duplicateAttemptedAt: DUPLICATE_AT,
    targetRoleIds: ["role-recommended", "role-possible"],
  });
  assert.equal(changed.verified, false);
  assert.equal(changed.roleSetStable, false);
});

test("duplicate re-add proof rejects stale, cross-list, and cross-candidate evidence", () => {
  const first = readbackProof({
    roleIds: ["role-recommended"],
    observedAt: POST_READ_AT,
  });
  const differentList = readbackProof({
    listId: "curated-list-contract-b",
    roleIds: ["role-recommended"],
    observedAt: DUPLICATE_READ_AT,
  });
  assert.equal(phase4DuplicateReaddReadbackDecision({
    firstReadback: first,
    duplicateReadback: differentList,
    duplicateAttemptedAt: DUPLICATE_AT,
    targetRoleIds: ["role-recommended"],
  }).verified, false);

  const crossCandidate = readbackProof({
    candidateId: OTHER_CANDIDATE_ID,
    candidateUserId: OTHER_CANDIDATE_USER_ID,
    roleIds: ["role-recommended"],
    observedAt: DUPLICATE_READ_AT,
  });
  assert.equal(phase4DuplicateReaddReadbackDecision({
    firstReadback: first,
    duplicateReadback: crossCandidate,
    duplicateAttemptedAt: DUPLICATE_AT,
    targetRoleIds: ["role-recommended"],
  }).verified, false);

  assert.equal(phase4DuplicateReaddReadbackDecision({
    firstReadback: first,
    duplicateReadback: readbackProof({
      roleIds: ["role-recommended"],
      observedAt: DUPLICATE_AT,
    }),
    duplicateAttemptedAt: DUPLICATE_READ_AT,
    targetRoleIds: ["role-recommended"],
  }).verified, false);
});

test("exact post-add count includes prior target roles and excludes unrelated roles", () => {
  const matchProof = rankedProof({
    roles: [
      {
        roleId: "recommended-prior",
        endorsed: true,
        suggested: false,
      },
      {
        roleId: "possible-new",
        endorsed: false,
        suggested: true,
      },
      {
        roleId: "possible-prior",
        endorsed: false,
        suggested: true,
      },
    ],
  });
  const postReadback = readbackProof({
    roleIds: [
      "unrelated-one",
      "possible-prior",
      "recommended-prior",
      "possible-new",
      "unrelated-two",
    ],
    observedAt: POST_READ_AT,
  });
  const count = exactPhase4PostAddCuratedMatchCount({
    matchProof,
    postReadback,
  });
  assert.equal(count.complete, true);
  assert.equal(count.enrollmentBlocked, false);
  assert.equal(count.recommendedCount, 1);
  assert.equal(count.possibleCount, 2);
  assert.equal(count.matchCount, 3);
  assert.equal(count.expectedMatchCount, 3);
  assert.equal(count.listRoleCount, 5);
  assert.equal(count.unrelatedRoleCount, 2);
  assert.deepEqual(count.missingTargetRoleIds, []);
});

test("exact post-add count blocks partial, stale, and cross-candidate evidence", () => {
  const matchProof = rankedProof();
  const partial = exactPhase4PostAddCuratedMatchCount({
    matchProof,
    postReadback: readbackProof({
      roleIds: ["role-recommended", "unrelated"],
      observedAt: POST_READ_AT,
    }),
  });
  assert.equal(partial.complete, false);
  assert.equal(partial.enrollmentBlocked, true);
  assert.equal(partial.matchCount, 1);
  assert.deepEqual(partial.missingTargetRoleIds, ["role-possible"]);

  assert.throws(
    () => exactPhase4PostAddCuratedMatchCount({
      matchProof,
      postReadback: readbackProof({
        roleIds: ["role-recommended", "role-possible"],
        observedAt: "2026-07-25T23:59:59.999Z",
      }),
    }),
    /exact match/,
  );
  assert.throws(
    () => exactPhase4PostAddCuratedMatchCount({
      matchProof,
      postReadback: readbackProof({
        candidateId: OTHER_CANDIDATE_ID,
        candidateUserId: OTHER_CANDIDATE_USER_ID,
        roleIds: ["role-recommended", "role-possible"],
        observedAt: POST_READ_AT,
      }),
    }),
    /exact match/,
  );
});

async function productionModuleFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await productionModuleFiles(resolved));
    } else if (/\.(?:mjs|js)$/u.test(entry.name)) {
      files.push(resolved);
    }
  }
  return files;
}

test("Phase 4 contract remains dark and has no production caller or side effect", async () => {
  const modulePath = fileURLToPath(new URL(
    "../api/paraai/_lib/phase4-curation-contract.mjs",
    import.meta.url,
  ));
  const apiDirectory = fileURLToPath(new URL(
    "../api/paraai/",
    import.meta.url,
  ));
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /\bprocess\.env\b/u);
  assert.doesNotMatch(source, /\btrpc(?:Get|Post)\b/u);
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*(?:pipeline|store|queue|client)\.mjs["']/u,
  );

  const productionFiles = await productionModuleFiles(apiDirectory);
  for (const file of productionFiles) {
    if (file === modulePath) continue;
    const otherSource = await readFile(file, "utf8");
    assert.equal(
      otherSource.includes("phase4-curation-contract.mjs"),
      false,
      `${file} must not call the dark Phase 4 module`,
    );
  }
});
