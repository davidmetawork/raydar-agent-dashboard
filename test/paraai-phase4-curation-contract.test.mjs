import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  PHASE4_CANDIDATE_IDENTITY_PROCEDURE,
  PHASE4_CAPTURE_EMAIL_SILENCE_MIN_MS,
  PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
  PHASE4_CURATION_CONTRACT_VERSION,
  PHASE4_CURATION_OBSERVATION_VERSION,
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
  PHASE4_OBSERVATION_PROOF_MAX_AGE_MS,
  PHASE4_PINNED_CAPTURE_ATTESTATION_DIGEST,
  PHASE4_PINNED_CURATION_IMPLEMENTATION_DIGEST,
  PHASE4_ROLE_ADDED_NOTIFICATION_TYPE,
  buildAuthorizedPhase4CuratedListAddRequest,
  classifyPhase4CuratedListAddResponse,
  currentPhase4CuratedListCaptureDecision,
  exactPhase4PostAddCuratedMatchCount,
  normalizePhase4CandidateIdentityObservation,
  normalizePhase4CuratedListReadback,
  normalizePhase4NotificationSafetyProof,
  normalizePhase4RankedMatchObservation,
  phase4CurationContractSummary,
  phase4CurationObservationResponseDigest,
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
const OTHER_SCOPE_DIGEST = "b".repeat(64);
const SOURCE_GENERATION_DIGEST = "c".repeat(64);
const OTHER_SOURCE_GENERATION_DIGEST = "d".repeat(64);
const IMPLEMENTATION_DIGEST = "e".repeat(64);
const SOURCE_CAS_REVISION = 17;
const MATCH_AT = "2026-07-26T00:00:00.000Z";
const IDENTITY_AT = "2026-07-26T00:00:30.000Z";
const PRE_READ_AT = "2026-07-26T00:01:00.000Z";
const PLAN_AT = "2026-07-26T00:02:00.000Z";
const NOTIFICATION_AT = "2026-07-26T00:02:30.000Z";
const AUTH_AT = "2026-07-26T00:03:00.000Z";
const MUTATION_AT = "2026-07-26T00:04:00.000Z";
const POST_READ_AT = "2026-07-26T00:05:00.000Z";
const COUNT_AT = "2026-07-26T00:06:00.000Z";
const CAPTURED_AT = "2026-07-26T00:00:00.000Z";
const CAPTURE_OBSERVED_THROUGH_AT = "2026-07-28T00:00:00.000Z";
let authorizedContractCopyNumber = 0;

const CONTEXT = Object.freeze({
  scopeDigest: SCOPE_DIGEST,
  sourceGenerationDigest: SOURCE_GENERATION_DIGEST,
  sourceCasRevision: SOURCE_CAS_REVISION,
});

function observation({
  procedure,
  input,
  response,
  observedAt = MATCH_AT,
  responseDigest,
  authoritative = true,
  complete = true,
  version = PHASE4_CURATION_OBSERVATION_VERSION,
  scopeDigest = SCOPE_DIGEST,
  sourceGenerationDigest = SOURCE_GENERATION_DIGEST,
  sourceCasRevision = SOURCE_CAS_REVISION,
  extra = {},
} = {}) {
  return {
    version,
    procedure,
    input,
    response,
    observedAt,
    responseDigest: responseDigest === undefined
      ? phase4CurationObservationResponseDigest(procedure, response)
      : responseDigest,
    authoritative,
    complete,
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    ...extra,
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
  observedAt = MATCH_AT,
  ...overrides
} = {}) {
  return observation({
    procedure: PHASE4_MATCH_READ_PROCEDURE,
    input: {
      candidate_id: candidateId,
      recruiter_user_id: recruiterUserId,
    },
    response: { status, roles },
    observedAt,
    ...overrides,
  });
}

function rankedProof({
  candidateId = CANDIDATE_ID,
  recruiterUserId = RECRUITER_USER_ID,
  trustedNow = PLAN_AT,
  ...options
} = {}) {
  const exactObservation = rankedObservation({
    candidateId,
    recruiterUserId,
    ...options,
  });
  return normalizePhase4RankedMatchObservation(exactObservation, {
    candidateId,
    recruiterUserId,
    scopeDigest: exactObservation.scopeDigest,
    sourceGenerationDigest: exactObservation.sourceGenerationDigest,
    sourceCasRevision: exactObservation.sourceCasRevision,
    trustedNow,
  });
}

function curatedListResponse({
  candidateId = CANDIDATE_ID,
  candidateUserId = CANDIDATE_USER_ID,
  listId = "curated-list-contract-a",
  roleIds = [],
} = {}) {
  return {
    id: listId,
    candidate_id: candidateId,
    candidate_user_id: candidateUserId,
    roles: roleIds.map((id) => ({ id })),
  };
}

function readbackObservation({
  candidateId = CANDIDATE_ID,
  candidateUserId = CANDIDATE_USER_ID,
  exists = true,
  listId = "curated-list-contract-a",
  roleIds = [],
  observedAt = PRE_READ_AT,
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
    ...overrides,
  });
}

function readbackProof({
  candidateId = CANDIDATE_ID,
  candidateUserId = CANDIDATE_USER_ID,
  trustedNow = PLAN_AT,
  ...options
} = {}) {
  const exactObservation = readbackObservation({
    candidateId,
    candidateUserId,
    ...options,
  });
  return normalizePhase4CuratedListReadback(exactObservation, {
    candidateId,
    candidateUserId,
    scopeDigest: exactObservation.scopeDigest,
    sourceGenerationDigest: exactObservation.sourceGenerationDigest,
    sourceCasRevision: exactObservation.sourceCasRevision,
    trustedNow,
  });
}

function identityObservation({
  candidateId = CANDIDATE_ID,
  candidateUserId = CANDIDATE_USER_ID,
  observedAt = IDENTITY_AT,
  ...overrides
} = {}) {
  return observation({
    procedure: PHASE4_CANDIDATE_IDENTITY_PROCEDURE,
    input: { candidate_id: candidateId },
    response: {
      candidate_id: candidateId,
      candidate_user_id: candidateUserId,
    },
    observedAt,
    ...overrides,
  });
}

function identityProof({
  candidateId = CANDIDATE_ID,
  candidateUserId = CANDIDATE_USER_ID,
  trustedNow = PLAN_AT,
  ...options
} = {}) {
  const exactObservation = identityObservation({
    candidateId,
    candidateUserId,
    ...options,
  });
  return normalizePhase4CandidateIdentityObservation(exactObservation, {
    candidateId,
    candidateUserId,
    scopeDigest: exactObservation.scopeDigest,
    sourceGenerationDigest: exactObservation.sourceGenerationDigest,
    sourceCasRevision: exactObservation.sourceCasRevision,
    trustedNow,
  });
}

function notificationObservation({
  candidateUserId = CANDIDATE_USER_ID,
  notificationTypes = [],
  observedAt = NOTIFICATION_AT,
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
    ...overrides,
  });
}

function notificationProof({
  candidateUserId = CANDIDATE_USER_ID,
  trustedNow = AUTH_AT,
  ...options
} = {}) {
  const exactObservation = notificationObservation({
    candidateUserId,
    ...options,
  });
  return normalizePhase4NotificationSafetyProof(exactObservation, {
    candidateUserId,
    decisionAt: trustedNow,
    scopeDigest: exactObservation.scopeDigest,
    sourceGenerationDigest: exactObservation.sourceGenerationDigest,
    sourceCasRevision: exactObservation.sourceCasRevision,
    trustedNow,
  });
}

function curationPlan({
  matchRoles,
  existingRoleIds = [],
  preExists = true,
  candidateId = CANDIDATE_ID,
  candidateUserId = CANDIDATE_USER_ID,
  scopeDigest = SCOPE_DIGEST,
  sourceGenerationDigest = SOURCE_GENERATION_DIGEST,
  sourceCasRevision = SOURCE_CAS_REVISION,
  trustedNow = PLAN_AT,
} = {}) {
  const proofOptions = {
    candidateId,
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow,
  };
  const matchProof = rankedProof({
    ...proofOptions,
    roles: matchRoles,
  });
  const preReadback = readbackProof({
    ...proofOptions,
    candidateUserId,
    exists: preExists,
    roleIds: existingRoleIds,
  });
  return planPhase4CuratedListWrite({
    scopeDigest,
    sourceGenerationDigest,
    sourceCasRevision,
    trustedNow,
    candidateId,
    candidateUserId,
    matchProof,
    preReadback,
    identityProof: preExists
      ? null
      : identityProof({
        ...proofOptions,
        candidateUserId,
      }),
  });
}

function captureAttestationBase() {
  return {
    version: PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    status: "verified",
    semanticDigest: null,
    implementationDigest: IMPLEMENTATION_DIGEST,
    evidenceDigests: {
      addResponse: "0".repeat(64),
      cleanup: "1".repeat(64),
      duplicateAfterReadback: "2".repeat(64),
      duplicateBeforeReadback: "3".repeat(64),
      duplicateMutationOutcome: "4".repeat(64),
      identityBinding: "5".repeat(64),
      implicitCreateAfterReadback: "6".repeat(64),
      implicitCreateBeforeReadback: "7".repeat(64),
      implicitCreateMutationOutcome: "8".repeat(64),
      mailboxSilence: "9".repeat(64),
      notificationAfter: "a".repeat(64),
      notificationBefore: "b".repeat(64),
    },
    captureSource: "authenticated_paraform_ui",
    capturedAt: CAPTURED_AT,
    observedThroughAt: CAPTURE_OBSERVED_THROUGH_AT,
    addContract: {
      procedure: PHASE4_CURATED_LIST_ADD_PROCEDURE,
      method: "mutation",
      inputKeys: [...PHASE4_CURATED_LIST_ADD_INPUT_KEYS],
      responseKeys: [...PHASE4_CURATED_LIST_ADD_RESPONSE_KEYS],
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

async function loadAuthorizedContractTestCopy() {
  const modulePath = fileURLToPath(new URL(
    "../api/paraai/_lib/phase4-curation-contract.mjs",
    import.meta.url,
  ));
  const policyUrl = new URL(
    "../api/paraai/_lib/phase3-shadow-policy.mjs",
    import.meta.url,
  ).href;
  const captureBase = captureAttestationBase();
  captureBase.capturedAt = "2026-07-23T00:00:00.000Z";
  captureBase.observedThroughAt = "2026-07-25T00:00:00.000Z";
  const capture = sealCapture(captureBase);
  let source = await readFile(modulePath, "utf8");
  source = source.replace(
    "\"./phase3-shadow-policy.mjs\"",
    JSON.stringify(policyUrl),
  );
  source = source.replace(
    /export const PHASE4_CURATED_LIST_CAPTURE_ATTESTATION = Object\.freeze\(\{[\s\S]*?export const PHASE4_PINNED_CURATION_IMPLEMENTATION_DIGEST = null;/u,
    [
      "export const PHASE4_CURATED_LIST_CAPTURE_ATTESTATION =",
      `  Object.freeze(${JSON.stringify(capture)});`,
      "export const PHASE4_PINNED_CAPTURE_ATTESTATION_DIGEST =",
      `  ${JSON.stringify(capture.semanticDigest)};`,
      "export const PHASE4_PINNED_CURATION_IMPLEMENTATION_DIGEST =",
      `  ${JSON.stringify(IMPLEMENTATION_DIGEST)};`,
    ].join("\n"),
  );
  source = source.replace(
    "const reconciledMutationOutcomes = new WeakSet();",
    `const reconciledMutationOutcomes = new WeakSet();

export function __mintTestStoreAuthority({
  plan,
  serverTrustedNow,
  expiresAt,
} = {}) {
  const planData = writePlanRegistry.get(plan);
  if (!planData) throw new TypeError("registered plan required");
  const captureEvidenceVerification = Object.freeze({});
  const captureVerificationData = Object.freeze({
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    captureSemanticDigest: PHASE4_PINNED_CAPTURE_ATTESTATION_DIGEST,
    implementationDigest: PHASE4_PINNED_CURATION_IMPLEMENTATION_DIGEST,
    evidenceRecomputed: true,
    implementationDerivedFromBuild: true,
  });
  captureEvidenceVerificationRegistry.set(
    captureEvidenceVerification,
    captureVerificationData,
  );
  const authority = Object.freeze({});
  globalWriteAuthorityRegistry.set(authority, Object.freeze({
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    ...proofScopeFields(planData),
    plan,
    planData,
    planSemanticDigest: planData.planSemanticDigest,
    lineageDigest: planData.lineageDigest,
    sourceCasRevision: planData.sourceCasRevision,
    serverTrustedNow,
    issuedAt: serverTrustedNow,
    expiresAt,
    attemptNumber: planData.attemptNumber,
    maxAttempts: planData.maxAttempts,
    captureEvidenceVerification,
  }));
  return authority;
}

export function __mintTestExecutionAuthorization({
  plan,
  notificationProof,
  executionAt,
  expiresAt,
} = {}) {
  const planData = writePlanRegistry.get(plan);
  const notificationData = notificationProofRegistry.get(
    notificationProof,
  );
  if (!planData || !notificationData) {
    throw new TypeError("registered plan and notification proof required");
  }
  const globalWriteAuthority = __mintTestStoreAuthority({
    plan,
    serverTrustedNow: executionAt,
    expiresAt,
  });
  const authorityData = globalWriteAuthorityRegistry.get(
    globalWriteAuthority,
  );
  const captureVerification =
    authorityData.captureEvidenceVerification;
  const captureVerificationData =
    captureEvidenceVerificationRegistry.get(captureVerification);
  const fields = {
    allowed: true,
    plan,
    ...proofScopeFields(planData),
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    planSemanticDigest: planData.planSemanticDigest,
    lineageDigest: planData.lineageDigest,
    attemptNumber: planData.attemptNumber,
    maxAttempts: planData.maxAttempts,
    captureSemanticDigest:
      captureVerificationData.captureSemanticDigest,
    captureImplementationDigest:
      captureVerificationData.implementationDigest,
    captureAttestationVersion:
      PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
    decisionAt: executionAt,
    notificationObservedAt: notificationData.observedAt,
    notificationResponseDigest: notificationData.responseDigest,
    expiresAt,
  };
  return registerArtifact(
    writeAuthorizationRegistry,
    { ...fields },
    {
      ...fields,
      planData,
      notificationProof,
      notificationData,
      globalWriteAuthority,
      authorityData,
      captureVerification,
      captureVerificationData,
    },
  );
}`,
  );
  assert.notEqual(
    source.includes("__mintTestStoreAuthority"),
    false,
    "test authority injection must be present only in the isolated copy",
  );
  authorizedContractCopyNumber += 1;
  return import([
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`,
    `#authorized-contract-copy-${authorizedContractCopyNumber}`,
  ].join(""));
}

test("completed capture validation binds evidence, implementation, and time", () => {
  const capture = sealCapture();
  const decision = validatePhase4CuratedListCaptureAttestation(capture, {
    expectedSemanticDigest: capture.semanticDigest,
    expectedImplementationDigest: IMPLEMENTATION_DIGEST,
    trustedNow: CAPTURE_OBSERVED_THROUGH_AT,
  });
  assert.deepEqual(decision, {
    valid: true,
    reasons: [],
    version: PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
  });

  for (const mutate of [
    (value) => {
      value.evidenceDigests.mailboxSilence = "f".repeat(64);
    },
    (value) => {
      value.implementationDigest = "f".repeat(64);
    },
    (value) => {
      value.emailSilence.observedForMs++;
    },
  ]) {
    const drifted = structuredClone(capture);
    mutate(drifted);
    assert.equal(
      validatePhase4CuratedListCaptureAttestation(drifted, {
        expectedSemanticDigest: capture.semanticDigest,
        expectedImplementationDigest: IMPLEMENTATION_DIGEST,
        trustedNow: CAPTURE_OBSERVED_THROUGH_AT,
      }).valid,
      false,
    );
  }
});

test("capture validation rejects caller pins, future windows, and loose evidence", () => {
  const capture = sealCapture();
  assert.equal(
    validatePhase4CuratedListCaptureAttestation(capture, {
      expectedSemanticDigest: capture.semanticDigest,
      expectedImplementationDigest: IMPLEMENTATION_DIGEST,
      trustedNow: "2026-07-27T23:59:59.999Z",
    }).reasons.includes("capture_attestation_time_invalid"),
    true,
  );
  assert.equal(
    validatePhase4CuratedListCaptureAttestation(capture, {
      expectedSemanticDigest: capture.semanticDigest,
      expectedImplementationDigest: "f".repeat(64),
      trustedNow: CAPTURE_OBSERVED_THROUGH_AT,
    }).reasons.includes("capture_implementation_digest_invalid"),
    true,
  );
  const missingEvidence = structuredClone(capture);
  delete missingEvidence.evidenceDigests.cleanup;
  missingEvidence.semanticDigest =
    phase4CuratedListCaptureSemanticDigest(missingEvidence);
  assert.equal(
    validatePhase4CuratedListCaptureAttestation(missingEvidence, {
      expectedSemanticDigest: missingEvidence.semanticDigest,
      expectedImplementationDigest: IMPLEMENTATION_DIGEST,
      trustedNow: CAPTURE_OBSERVED_THROUGH_AT,
    }).reasons.includes("capture_evidence_digests_invalid"),
    true,
  );
  assert.equal(
    validatePhase4CuratedListCaptureAttestation(capture, {
      trustedNow: CAPTURE_OBSERVED_THROUGH_AT,
    }).valid,
    false,
  );
});

test("production capture and implementation stay unpinned and writes stay dark", () => {
  assert.equal(PHASE4_PINNED_CAPTURE_ATTESTATION_DIGEST, null);
  assert.equal(PHASE4_PINNED_CURATION_IMPLEMENTATION_DIGEST, null);
  const current = currentPhase4CuratedListCaptureDecision({
    trustedNow: AUTH_AT,
  });
  assert.equal(current.valid, false);
  assert.equal(
    current.reasons.includes("capture_attestation_unpinned"),
    true,
  );
  assert.equal(
    current.reasons.includes("capture_implementation_unpinned"),
    true,
  );
  assert.deepEqual(phase4CurationContractSummary(), {
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    captureAttestationVersion:
      PHASE4_CURATION_CAPTURE_ATTESTATION_VERSION,
    capturePinned: false,
    mutationAuthorizationAvailable: false,
    globalWriteAuthorityMinterAvailable: false,
    notificationFenceRequired: true,
    roleAddedNotificationType: PHASE4_ROLE_ADDED_NOTIFICATION_TYPE,
  });
});

test("ranked match proof uses exact XOR tiers and never reads score", () => {
  let scoreReads = 0;
  const role = Object.defineProperty({
    roleId: "role-endorsed",
    endorsed: true,
    suggested: false,
  }, "score", {
    enumerable: true,
    get() {
      scoreReads++;
      throw new Error("score must never be read");
    },
  });
  const proof = rankedProof({ roles: [
    role,
    {
      roleId: "role-suggested",
      endorsed: false,
      suggested: true,
      score: 0.999,
    },
  ] });
  assert.equal(proof.valid, true);
  assert.deepEqual(proof.recommendedRoleIds, ["role-endorsed"]);
  assert.deepEqual(proof.possibleRoleIds, ["role-suggested"]);
  assert.deepEqual(proof.targetRoleIds, [
    "role-endorsed",
    "role-suggested",
  ]);
  assert.equal(scoreReads, 0);
});

test("ranked proof rejects tier ambiguity and response-digest substitution", () => {
  for (const role of [
    { roleId: "role-a", endorsed: true, suggested: true },
    { roleId: "role-a", endorsed: false, suggested: false },
    { roleId: "role-a", endorsed: 1, suggested: false },
  ]) {
    assert.equal(rankedProof({ roles: [role] }).valid, false);
  }
  assert.equal(rankedProof({
    roles: [
      { roleId: "role-a", endorsed: true, suggested: false },
      { roleId: "role-a", endorsed: false, suggested: true },
    ],
  }).errorCode, "role_id_duplicate");
  assert.equal(rankedProof({
    responseDigest: "f".repeat(64),
  }).errorCode, "response_digest_invalid");
  assert.equal(rankedProof({
    extra: { callerLimit: 1 },
  }).errorCode, "observation_shape_invalid");
});

test("proofs are bound to scope, source generation, CAS, and freshness", () => {
  const exact = rankedObservation();
  for (const expected of [
    {
      ...CONTEXT,
      scopeDigest: OTHER_SCOPE_DIGEST,
      trustedNow: PLAN_AT,
    },
    {
      ...CONTEXT,
      sourceGenerationDigest: OTHER_SOURCE_GENERATION_DIGEST,
      trustedNow: PLAN_AT,
    },
    {
      ...CONTEXT,
      sourceCasRevision: SOURCE_CAS_REVISION + 1,
      trustedNow: PLAN_AT,
    },
    {
      ...CONTEXT,
      trustedNow: new Date(
        Date.parse(MATCH_AT) + PHASE4_OBSERVATION_PROOF_MAX_AGE_MS + 1,
      ).toISOString(),
    },
  ]) {
    assert.equal(normalizePhase4RankedMatchObservation(exact, {
      candidateId: CANDIDATE_ID,
      recruiterUserId: RECRUITER_USER_ID,
      ...expected,
    }).valid, false);
  }
});

test("present readback binds both identities and canonical response digest", () => {
  const proof = readbackProof({
    roleIds: ["prior-role", "target-role"],
  });
  assert.equal(proof.valid, true);
  assert.equal(proof.exists, true);
  assert.equal(proof.candidateUserId, CANDIDATE_USER_ID);
  assert.deepEqual(proof.roleIds, ["prior-role", "target-role"]);

  assert.equal(readbackProof({
    response: curatedListResponse({
      candidateId: OTHER_CANDIDATE_ID,
    }),
  }).valid, false);
  assert.equal(readbackProof({
    response: curatedListResponse({
      candidateUserId: OTHER_CANDIDATE_USER_ID,
    }),
  }).valid, false);
  assert.equal(readbackProof({
    roleIds: ["duplicate", "duplicate"],
  }).valid, false);
  assert.equal(readbackProof({
    responseDigest: "f".repeat(64),
  }).errorCode, "response_digest_invalid");
});

test("null readback cannot assert candidate-user identity", () => {
  const absent = readbackProof({ exists: false });
  assert.equal(absent.valid, true);
  assert.equal(absent.exists, false);
  assert.equal(absent.candidateId, CANDIDATE_ID);
  assert.equal(absent.candidateUserId, null);
  assert.equal(absent.implicitCreateRequired, true);

  const matchProof = rankedProof();
  assert.throws(() => planPhase4CuratedListWrite({
    ...CONTEXT,
    trustedNow: PLAN_AT,
    candidateId: CANDIDATE_ID,
    candidateUserId: CANDIDATE_USER_ID,
    matchProof,
    preReadback: absent,
  }), /identity proof/u);
});

test("implicit-create planning requires authoritative identity binding", () => {
  const plan = curationPlan({ preExists: false });
  assert.equal(plan.implicitCreateExpected, true);
  assert.equal(plan.identityProof.valid, true);
  assert.equal(plan.identityProof.candidateUserId, CANDIDATE_USER_ID);

  const absent = readbackProof({ exists: false });
  assert.throws(() => planPhase4CuratedListWrite({
    ...CONTEXT,
    trustedNow: PLAN_AT,
    candidateId: CANDIDATE_ID,
    candidateUserId: CANDIDATE_USER_ID,
    matchProof: rankedProof(),
    preReadback: absent,
    identityProof: identityProof({
      candidateUserId: OTHER_CANDIDATE_USER_ID,
    }),
  }), /identity proof/u);
  assert.equal(identityProof({
    responseDigest: "f".repeat(64),
  }).valid, false);
});

test("notification proof is fresh, source-bound, and fail-closed", () => {
  const safe = notificationProof();
  assert.equal(safe.valid, true);
  assert.equal(safe.safe, true);

  const enabled = notificationProof({
    notificationTypes: [PHASE4_ROLE_ADDED_NOTIFICATION_TYPE],
  });
  assert.equal(enabled.valid, true);
  assert.equal(enabled.safe, false);
  assert.equal(
    enabled.errorCode,
    "candidate_role_added_email_enabled",
  );

  const boundary = new Date(
    Date.parse(AUTH_AT) - PHASE4_NOTIFICATION_PROOF_MAX_AGE_MS,
  ).toISOString();
  assert.equal(notificationProof({ observedAt: boundary }).safe, true);
  assert.equal(notificationProof({
    observedAt: new Date(Date.parse(boundary) - 1).toISOString(),
  }).valid, false);
  assert.equal(notificationProof({
    responseDigest: "f".repeat(64),
  }).valid, false);
  assert.equal(notificationProof({
    sourceCasRevision: SOURCE_CAS_REVISION + 1,
  }).valid, true);

  const crossCasObservation = notificationObservation({
    sourceCasRevision: SOURCE_CAS_REVISION + 1,
  });
  assert.equal(normalizePhase4NotificationSafetyProof(
    crossCasObservation,
    {
      ...CONTEXT,
      candidateUserId: CANDIDATE_USER_ID,
      decisionAt: AUTH_AT,
      trustedNow: AUTH_AT,
    },
  ).valid, false);
});

test("write plan is exact, missing-only, scope-bound, and ordered", () => {
  const plan = curationPlan({
    existingRoleIds: ["role-possible", "unrelated-role"],
  });
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
  assert.equal(plan.scopeDigest, SCOPE_DIGEST);
  assert.equal(plan.sourceGenerationDigest, SOURCE_GENERATION_DIGEST);
  assert.equal(plan.sourceCasRevision, SOURCE_CAS_REVISION);
  assert.match(plan.planSemanticDigest, /^[a-f0-9]{64}$/u);

  const alreadyComplete = curationPlan({
    existingRoleIds: [
      "role-recommended",
      "role-possible",
      "unrelated-role",
    ],
  });
  assert.equal(alreadyComplete.noMutationRequired, true);
  assert.equal(alreadyComplete.plannedInput, null);

  assert.throws(() => planPhase4CuratedListWrite({
    ...CONTEXT,
    trustedNow: PLAN_AT,
    candidateId: CANDIDATE_ID,
    candidateUserId: CANDIDATE_USER_ID,
    matchProof: rankedProof({ observedAt: PRE_READ_AT }),
    preReadback: readbackProof({ observedAt: MATCH_AT }),
  }), /ordering/u);
});

test("write planning rejects proof replay across scope, generation, and CAS", () => {
  const matchProof = rankedProof();
  const preReadback = readbackProof();
  for (const context of [
    { ...CONTEXT, scopeDigest: OTHER_SCOPE_DIGEST },
    {
      ...CONTEXT,
      sourceGenerationDigest: OTHER_SOURCE_GENERATION_DIGEST,
    },
    { ...CONTEXT, sourceCasRevision: SOURCE_CAS_REVISION + 1 },
  ]) {
    assert.throws(() => planPhase4CuratedListWrite({
      ...context,
      trustedNow: PLAN_AT,
      candidateId: CANDIDATE_ID,
      candidateUserId: CANDIDATE_USER_ID,
      matchProof,
      preReadback,
    }), /proof/u);
  }
  assert.throws(() => planPhase4CuratedListWrite({
    ...CONTEXT,
    trustedNow: "2026-07-26T00:20:00.000Z",
    candidateId: CANDIDATE_ID,
    candidateUserId: CANDIDATE_USER_ID,
    matchProof,
    preReadback,
  }), /ordering/u);
});

test("unpinned capture and absent authority independently deny writes", () => {
  const plan = curationPlan();
  const decision = phase4CuratedListWriteAuthorization({
    plan,
    notificationProof: notificationProof(),
    trustedNow: AUTH_AT,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.authorization, null);
  assert.equal(decision.notificationSafe, true);
  assert.equal(
    decision.reasons.includes("global_write_authority_unavailable"),
    true,
  );
  assert.equal(
    decision.reasons.includes("capture_attestation_unpinned"),
    true,
  );
  assert.equal(
    decision.reasons.includes("capture_implementation_unpinned"),
    true,
  );

  assert.throws(() => buildAuthorizedPhase4CuratedListAddRequest({
    plan,
    authorization: {
      allowed: true,
      plan,
      planSemanticDigest: plan.planSemanticDigest,
    },
    executionAt: MUTATION_AT,
    ...CONTEXT,
    trustedNow: MUTATION_AT,
  }), /NOT_AUTHORIZED/u);
});

test("authority and execution never extend private evidence freshness", async () => {
  const contract = await loadAuthorizedContractTestCopy();
  const makePlan = ({
    candidateId,
    candidateUserId,
    matchAt = "2026-07-26T00:00:00.000Z",
    identityAt = "2026-07-26T00:00:30.000Z",
    readAt = "2026-07-26T00:01:00.000Z",
    planAt = "2026-07-26T00:14:00.000Z",
  }) => {
    const exactMatchObservation = rankedObservation({
      candidateId,
      observedAt: matchAt,
    });
    const matchProof = contract.normalizePhase4RankedMatchObservation(
      exactMatchObservation,
      {
        candidateId,
        recruiterUserId: RECRUITER_USER_ID,
        ...CONTEXT,
        trustedNow: planAt,
      },
    );
    const exactIdentityObservation = identityObservation({
      candidateId,
      candidateUserId,
      observedAt: identityAt,
    });
    const exactIdentityProof =
      contract.normalizePhase4CandidateIdentityObservation(
        exactIdentityObservation,
        {
          candidateId,
          candidateUserId,
          ...CONTEXT,
          trustedNow: planAt,
        },
      );
    const exactReadbackObservation = readbackObservation({
      candidateId,
      candidateUserId,
      exists: false,
      observedAt: readAt,
    });
    const preReadback = contract.normalizePhase4CuratedListReadback(
      exactReadbackObservation,
      {
        candidateId,
        candidateUserId,
        ...CONTEXT,
        trustedNow: planAt,
      },
    );
    return contract.planPhase4CuratedListWrite({
      ...CONTEXT,
      trustedNow: planAt,
      candidateId,
      candidateUserId,
      matchProof,
      preReadback,
      identityProof: exactIdentityProof,
    });
  };
  const makeNotificationProof = ({
    candidateUserId,
    observedAt,
    trustedNow,
  }) => {
    const exactObservation = notificationObservation({
      candidateUserId,
      observedAt,
    });
    return contract.normalizePhase4NotificationSafetyProof(
      exactObservation,
      {
        candidateUserId,
        decisionAt: trustedNow,
        ...CONTEXT,
        trustedNow,
      },
    );
  };
  const decide = ({
    plan,
    candidateUserId,
    decisionAt,
    notificationAt,
    expiresAt,
  }) => {
    const authority = contract.__mintTestStoreAuthority({
      plan,
      serverTrustedNow: decisionAt,
      expiresAt,
    });
    return contract.phase4CuratedListWriteAuthorization({
      plan,
      notificationProof: makeNotificationProof({
        candidateUserId,
        observedAt: notificationAt,
        trustedNow: decisionAt,
      }),
      trustedNow: decisionAt,
      globalWriteAuthority: authority,
    });
  };

  const staleCandidateId = "candidate-evidence-stale";
  const staleCandidateUserId = "candidate-user-evidence-stale";
  const stalePlan = makePlan({
    candidateId: staleCandidateId,
    candidateUserId: staleCandidateUserId,
  });
  const staleDecision = decide({
    plan: stalePlan,
    candidateUserId: staleCandidateUserId,
    decisionAt: "2026-07-26T00:28:59.000Z",
    notificationAt: "2026-07-26T00:28:30.000Z",
    expiresAt: "2026-07-26T00:29:59.000Z",
  });
  assert.equal(staleDecision.allowed, false);
  assert.equal(
    staleDecision.reasons.includes("write_plan_stale"),
    false,
  );
  for (const reason of [
    "match_proof_stale",
    "readback_proof_stale",
    "identity_proof_stale",
  ]) {
    assert.equal(staleDecision.reasons.includes(reason), true);
  }

  const boundaryCandidateId = "candidate-evidence-boundary";
  const boundaryCandidateUserId = "candidate-user-evidence-boundary";
  const boundaryPlan = makePlan({
    candidateId: boundaryCandidateId,
    candidateUserId: boundaryCandidateUserId,
  });
  const boundaryDecision = decide({
    plan: boundaryPlan,
    candidateUserId: boundaryCandidateUserId,
    decisionAt: "2026-07-26T00:15:00.000Z",
    notificationAt: "2026-07-26T00:14:30.000Z",
    expiresAt: "2026-07-26T00:20:00.000Z",
  });
  assert.equal(boundaryDecision.allowed, true);
  assert.equal(
    boundaryDecision.authorization.expiresAt,
    "2026-07-26T00:15:00.000Z",
  );
  assert.doesNotThrow(() => (
    contract.buildAuthorizedPhase4CuratedListAddRequest({
      plan: boundaryPlan,
      authorization: boundaryDecision.authorization,
      executionAt: "2026-07-26T00:15:00.000Z",
      ...CONTEXT,
      trustedNow: "2026-07-26T00:15:00.000Z",
    })
  ));

  const afterBoundaryCandidateId = "candidate-evidence-over-boundary";
  const afterBoundaryCandidateUserId =
    "candidate-user-evidence-over-boundary";
  const afterBoundaryDecision = decide({
    plan: makePlan({
      candidateId: afterBoundaryCandidateId,
      candidateUserId: afterBoundaryCandidateUserId,
    }),
    candidateUserId: afterBoundaryCandidateUserId,
    decisionAt: "2026-07-26T00:15:00.001Z",
    notificationAt: "2026-07-26T00:14:30.000Z",
    expiresAt: "2026-07-26T00:20:00.000Z",
  });
  assert.equal(afterBoundaryDecision.allowed, false);
  assert.equal(
    afterBoundaryDecision.reasons.includes("match_proof_stale"),
    true,
  );

  const futureCandidateId = "candidate-evidence-future";
  const futureCandidateUserId = "candidate-user-evidence-future";
  const futureDecision = decide({
    plan: makePlan({
      candidateId: futureCandidateId,
      candidateUserId: futureCandidateUserId,
      planAt: "2026-07-26T00:02:00.000Z",
    }),
    candidateUserId: futureCandidateUserId,
    decisionAt: "2026-07-25T23:59:59.000Z",
    notificationAt: "2026-07-25T23:59:59.000Z",
    expiresAt: "2026-07-26T00:05:00.000Z",
  });
  assert.equal(futureDecision.allowed, false);
  for (const reason of [
    "write_plan_stale",
    "match_proof_stale",
    "readback_proof_stale",
    "identity_proof_stale",
  ]) {
    assert.equal(futureDecision.reasons.includes(reason), true);
  }

  const executionCandidateId = "candidate-execution-evidence-stale";
  const executionCandidateUserId =
    "candidate-user-execution-evidence-stale";
  const executionPlan = makePlan({
    candidateId: executionCandidateId,
    candidateUserId: executionCandidateUserId,
  });
  const executionNotification = makeNotificationProof({
    candidateUserId: executionCandidateUserId,
    observedAt: "2026-07-26T00:28:30.000Z",
    trustedNow: "2026-07-26T00:28:59.000Z",
  });
  const staleExecutionAuthorization =
    contract.__mintTestExecutionAuthorization({
      plan: executionPlan,
      notificationProof: executionNotification,
      executionAt: "2026-07-26T00:28:59.000Z",
      expiresAt: "2026-07-26T00:29:59.000Z",
    });
  assert.throws(() => (
    contract.buildAuthorizedPhase4CuratedListAddRequest({
      plan: executionPlan,
      authorization: staleExecutionAuthorization,
      executionAt: "2026-07-26T00:28:59.000Z",
      ...CONTEXT,
      trustedNow: "2026-07-26T00:28:59.000Z",
    })
  ), /NOT_AUTHORIZED/u);

  for (const [suffix, notificationAt] of [
    ["stale", "2026-07-26T00:00:00.000Z"],
    ["future", "2026-07-26T00:07:00.000Z"],
  ]) {
    const candidateId = `candidate-execution-notification-${suffix}`;
    const candidateUserId =
      `candidate-user-execution-notification-${suffix}`;
    const plan = makePlan({
      candidateId,
      candidateUserId,
      planAt: "2026-07-26T00:02:00.000Z",
    });
    const exactNotificationProof = makeNotificationProof({
      candidateUserId,
      observedAt: notificationAt,
      trustedNow: notificationAt,
    });
    const authorization =
      contract.__mintTestExecutionAuthorization({
        plan,
        notificationProof: exactNotificationProof,
        executionAt: "2026-07-26T00:06:00.000Z",
        expiresAt: "2026-07-26T00:08:00.000Z",
      });
    assert.throws(() => (
      contract.buildAuthorizedPhase4CuratedListAddRequest({
        plan,
        authorization,
        executionAt: "2026-07-26T00:06:00.000Z",
        ...CONTEXT,
        trustedNow: "2026-07-26T00:06:00.000Z",
      })
    ), /NOT_AUTHORIZED/u);
  }
});

test("Proxy brands, wrapped proofs, clones, and null pins stay untrusted", () => {
  const plan = curationPlan();
  const matchProof = rankedProof();
  const preReadback = readbackProof();
  const symbolLiar = (target) => new Proxy(target, {
    get(value, property, receiver) {
      if (typeof property === "symbol") return true;
      return Reflect.get(value, property, receiver);
    },
  });

  assert.equal(
    Reflect.ownKeys(rankedProof({
      roles: [{
        roleId: "invalid-tier",
        endorsed: true,
        suggested: true,
      }],
    })).some((key) => typeof key === "symbol"),
    false,
  );
  for (const forgedMatch of [
    symbolLiar(matchProof),
    { ...matchProof },
    symbolLiar({ ...matchProof }),
  ]) {
    assert.throws(() => planPhase4CuratedListWrite({
      ...CONTEXT,
      trustedNow: PLAN_AT,
      candidateId: CANDIDATE_ID,
      candidateUserId: CANDIDATE_USER_ID,
      matchProof: forgedMatch,
      preReadback,
    }), /exact candidate match proof/u);
  }
  for (const forgedReadback of [
    symbolLiar(preReadback),
    { ...preReadback },
  ]) {
    assert.throws(() => planPhase4CuratedListWrite({
      ...CONTEXT,
      trustedNow: PLAN_AT,
      candidateId: CANDIDATE_ID,
      candidateUserId: CANDIDATE_USER_ID,
      matchProof,
      preReadback: forgedReadback,
    }), /exact candidate Curated List proof/u);
  }

  const fakeGlobalAuthority = symbolLiar({
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    plan,
    planSemanticDigest: plan.planSemanticDigest,
    ...CONTEXT,
    serverTrustedNow: AUTH_AT,
  });
  const denied = phase4CuratedListWriteAuthorization({
    plan,
    notificationProof: notificationProof(),
    trustedNow: AUTH_AT,
    globalWriteAuthority: fakeGlobalAuthority,
  });
  assert.equal(denied.allowed, false);
  assert.equal(
    denied.reasons.includes("global_write_authority_unavailable"),
    true,
  );
  assert.equal(
    denied.reasons.includes("server_time_authority_unavailable"),
    true,
  );
  assert.equal(
    denied.reasons.includes(
      "capture_evidence_verification_unavailable",
    ),
    true,
  );

  const fakeAuthorization = symbolLiar({
    allowed: true,
    plan,
    planSemanticDigest: plan.planSemanticDigest,
    captureSemanticDigest: null,
    captureImplementationDigest: null,
    contractVersion: PHASE4_CURATION_CONTRACT_VERSION,
    decisionAt: AUTH_AT,
    expiresAt: MUTATION_AT,
    ...CONTEXT,
  });
  assert.throws(() => buildAuthorizedPhase4CuratedListAddRequest({
    plan,
    authorization: fakeAuthorization,
    executionAt: MUTATION_AT,
    ...CONTEXT,
    trustedNow: MUTATION_AT,
  }), /NOT_AUTHORIZED/u);

  const fakeRequest = symbolLiar({
    plan,
    requestDigest: "f".repeat(64),
    executionAt: MUTATION_AT,
    procedure: PHASE4_CURATED_LIST_ADD_PROCEDURE,
    method: "mutation",
    input: plan.plannedInput,
    ...CONTEXT,
  });
  assert.throws(() => phase4CuratedListMutationOutcome({
    request: fakeRequest,
    responseReceived: true,
    response: {
      success: true,
      curated_role_list_id: "curated-list-contract-a",
    },
    observedAt: POST_READ_AT,
    trustedNow: POST_READ_AT,
  }), /exact registered request/u);

  assert.throws(() => reconcilePhase4CuratedListWrite({
    plan,
    mutationOutcome: symbolLiar({
      request: fakeRequest,
      outcome: "accepted",
      observedAt: POST_READ_AT,
      ...CONTEXT,
    }),
    postReadback: readbackProof({
      observedAt: POST_READ_AT,
      trustedNow: COUNT_AT,
    }),
    attemptCount: 1,
    maxAttempts: 3,
    trustedNow: COUNT_AT,
  }), /exact registered/u);
});

test("semantic response fields are snapshotted once and accessors fail closed", () => {
  const stableResponse = {
    status: "ranked",
    roles: [{
      roleId: "role-stable",
      endorsed: true,
      suggested: false,
    }],
  };
  const stableDigest = phase4CurationObservationResponseDigest(
    PHASE4_MATCH_READ_PROCEDURE,
    stableResponse,
  );

  let rolesReads = 0;
  const changingRoles = {};
  Object.defineProperty(changingRoles, "status", {
    enumerable: true,
    value: "ranked",
  });
  Object.defineProperty(changingRoles, "roles", {
    enumerable: true,
    get() {
      rolesReads++;
      return stableResponse.roles;
    },
  });
  assert.equal(rankedProof({
    response: changingRoles,
    responseDigest: stableDigest,
  }).valid, false);
  assert.equal(rolesReads, 0);

  let elementReads = 0;
  const changingArray = [];
  Object.defineProperty(changingArray, "0", {
    enumerable: true,
    configurable: true,
    get() {
      elementReads++;
      return stableResponse.roles[0];
    },
  });
  changingArray.length = 1;
  assert.equal(rankedProof({
    response: { status: "ranked", roles: changingArray },
    responseDigest: stableDigest,
  }).valid, false);
  assert.equal(elementReads, 0);

  let tierReads = 0;
  const changingRole = {
    roleId: "role-stable",
    suggested: false,
  };
  Object.defineProperty(changingRole, "endorsed", {
    enumerable: true,
    get() {
      tierReads++;
      return tierReads === 1;
    },
  });
  assert.equal(rankedProof({
    response: { status: "ranked", roles: [changingRole] },
    responseDigest: stableDigest,
  }).valid, false);
  assert.equal(tierReads, 0);

  let successReads = 0;
  const changingMutationResponse = {
    curated_role_list_id: "curated-list-contract-a",
  };
  Object.defineProperty(changingMutationResponse, "success", {
    enumerable: true,
    get() {
      successReads++;
      return successReads === 1;
    },
  });
  const classified = classifyPhase4CuratedListAddResponse({
    responseReceived: true,
    response: changingMutationResponse,
  });
  assert.equal(classified.outcome, "unknown");
  assert.equal(classified.externalWriteMayHaveLanded, true);
  assert.equal(successReads, 0);

  assert.equal(normalizePhase4RankedMatchObservation(
    new Proxy(rankedObservation(), {}),
    {
      candidateId: CANDIDATE_ID,
      recruiterUserId: RECRUITER_USER_ID,
      ...CONTEXT,
      trustedNow: PLAN_AT,
    },
  ).valid, false);
});

test("mutation outcomes require the exact registered authorized request", () => {
  assert.throws(() => phase4CuratedListMutationOutcome({
    request: {
      procedure: PHASE4_CURATED_LIST_ADD_PROCEDURE,
      method: "mutation",
      input: curationPlan().plannedInput,
    },
    responseReceived: true,
    response: {
      success: true,
      curated_role_list_id: "curated-list-contract-a",
    },
    observedAt: POST_READ_AT,
    trustedNow: POST_READ_AT,
  }), /exact registered request/u);
  assert.throws(() => phase4CuratedListMutationOutcome({
    responseReceived: false,
    observedAt: POST_READ_AT,
    trustedNow: POST_READ_AT,
  }), /exact registered request/u);
});

test("pure add-response classification is strict and never grants authority", () => {
  assert.deepEqual(classifyPhase4CuratedListAddResponse({
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
    responseDigest: phase4CurationObservationResponseDigest(
      "unrecognized-procedure",
      {
        success: true,
        message: "Roles added",
        curated_role_list_id: "curated-list-contract-a",
      },
    ),
    errorCode: null,
  });
  assert.equal(classifyPhase4CuratedListAddResponse({
    responseReceived: true,
    response: {
      success: false,
      message: "Rejected",
    },
  }).outcome, "rejected");
  for (const input of [
    { responseReceived: false },
    {
      responseReceived: true,
      response: { success: true },
    },
    {
      responseReceived: true,
      response: {
        success: false,
        curated_role_list_id: "contradictory-list",
      },
    },
    {
      responseReceived: true,
      response: {
        success: true,
        curated_role_list_id: "curated-list-contract-a",
        extra: true,
      },
    },
  ]) {
    const classified = classifyPhase4CuratedListAddResponse(input);
    assert.equal(classified.outcome, "unknown");
    assert.equal(classified.externalWriteMayHaveLanded, true);
    assert.equal(classified.curatedRoleListId, null);
  }
  const cyclic = {
    success: true,
    curated_role_list_id: "curated-list-contract-a",
  };
  cyclic.self = cyclic;
  assert.equal(classifyPhase4CuratedListAddResponse({
    responseReceived: true,
    response: cyclic,
  }).outcome, "unknown");
});

test("reconciliation rejects naked outcome strings and executable retry input", async () => {
  const plan = curationPlan();
  for (const mutationOutcome of [
    "unknown",
    "accepted",
    classifyPhase4CuratedListAddResponse({
      responseReceived: true,
      response: {
        success: true,
        curated_role_list_id: "curated-list-contract-a",
      },
    }),
    classifyPhase4CuratedListAddResponse({
      responseReceived: false,
    }),
    {
      outcome: "unknown",
      externalWriteMayHaveLanded: true,
    },
  ]) {
    assert.throws(() => reconcilePhase4CuratedListWrite({
      plan,
      mutationOutcome,
      postReadback: readbackProof({
        roleIds: ["role-recommended"],
        observedAt: POST_READ_AT,
        trustedNow: COUNT_AT,
      }),
      attemptCount: 1,
      maxAttempts: 3,
      trustedNow: COUNT_AT,
    }), /exact registered/u);
  }

  const modulePath = fileURLToPath(new URL(
    "../api/paraai/_lib/phase4-curation-contract.mjs",
    import.meta.url,
  ));
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /\bnextPlannedInput\b/u);
  assert.match(source, /\breplanRequirement\b/u);
});

test("retry lineage advances exactly once and cannot reset attempts", async () => {
  const contract = await loadAuthorizedContractTestCopy();
  const normalizeMatch = (
    trustedNow,
    {
      recruiterUserId = RECRUITER_USER_ID,
      roles,
    } = {},
  ) => {
    const exactObservation = rankedObservation({
      recruiterUserId,
      ...(roles === undefined ? {} : { roles }),
    });
    return contract.normalizePhase4RankedMatchObservation(
      exactObservation,
      {
        candidateId: CANDIDATE_ID,
        recruiterUserId,
        ...CONTEXT,
        trustedNow,
      },
    );
  };
  const normalizeReadback = ({
    roleIds,
    observedAt,
    trustedNow,
  }) => {
    const exactObservation = readbackObservation({
      roleIds,
      observedAt,
    });
    return contract.normalizePhase4CuratedListReadback(
      exactObservation,
      {
        candidateId: CANDIDATE_ID,
        candidateUserId: CANDIDATE_USER_ID,
        ...CONTEXT,
        trustedNow,
      },
    );
  };
  const normalizeNotification = ({ observedAt, trustedNow }) => {
    const exactObservation = notificationObservation({ observedAt });
    return contract.normalizePhase4NotificationSafetyProof(
      exactObservation,
      {
        candidateUserId: CANDIDATE_USER_ID,
        decisionAt: trustedNow,
        ...CONTEXT,
        trustedNow,
      },
    );
  };
  const authorizationDecision = ({
    plan,
    decisionAt,
    expiresAt,
    observedAt,
  }) => {
    const authority = contract.__mintTestStoreAuthority({
      plan,
      serverTrustedNow: decisionAt,
      expiresAt,
    });
    const decision = contract.phase4CuratedListWriteAuthorization({
      plan,
      notificationProof: normalizeNotification({
        observedAt,
        trustedNow: decisionAt,
      }),
      trustedNow: decisionAt,
      globalWriteAuthority: authority,
    });
    return decision;
  };
  const authorize = ({ plan, decisionAt, expiresAt, observedAt }) => {
    const decision = authorizationDecision({
      plan,
      decisionAt,
      expiresAt,
      observedAt,
    });
    assert.equal(decision.allowed, true);
    return contract.buildAuthorizedPhase4CuratedListAddRequest({
      plan,
      authorization: decision.authorization,
      executionAt: decisionAt,
      ...CONTEXT,
      trustedNow: decisionAt,
    });
  };

  const matchProof = normalizeMatch(PLAN_AT);
  const initialReadback = normalizeReadback({
    roleIds: [],
    observedAt: PRE_READ_AT,
    trustedNow: PLAN_AT,
  });
  const firstPlan = contract.planPhase4CuratedListWrite({
    ...CONTEXT,
    trustedNow: PLAN_AT,
    candidateId: CANDIDATE_ID,
    candidateUserId: CANDIDATE_USER_ID,
    matchProof,
    preReadback: initialReadback,
    maxAttempts: 3,
  });
  assert.equal(firstPlan.attemptNumber, 1);
  assert.equal(firstPlan.maxAttempts, 3);
  const parallelRootPlan = contract.planPhase4CuratedListWrite({
    ...CONTEXT,
    trustedNow: PLAN_AT,
    candidateId: CANDIDATE_ID,
    candidateUserId: CANDIDATE_USER_ID,
    matchProof,
    preReadback: initialReadback,
    maxAttempts: 3,
  });
  const parallelAuthorization = authorizationDecision({
    plan: firstPlan,
    decisionAt: AUTH_AT,
    expiresAt: "2026-07-26T00:10:00.000Z",
    observedAt: NOTIFICATION_AT,
  });
  assert.equal(parallelAuthorization.allowed, true);
  const firstRequest = authorize({
    plan: firstPlan,
    decisionAt: AUTH_AT,
    expiresAt: "2026-07-26T00:10:00.000Z",
    observedAt: NOTIFICATION_AT,
  });
  assert.throws(() => (
    contract.buildAuthorizedPhase4CuratedListAddRequest({
      plan: firstPlan,
      authorization: parallelAuthorization.authorization,
      executionAt: AUTH_AT,
      ...CONTEXT,
      trustedNow: AUTH_AT,
    })
  ), /NOT_AUTHORIZED/u);
  for (const wrappedRequest of [
    new Proxy(firstRequest, {}),
    { ...firstRequest },
  ]) {
    assert.throws(() => contract.phase4CuratedListMutationOutcome({
      request: wrappedRequest,
      responseReceived: true,
      response: {
        success: true,
        curated_role_list_id: "curated-list-contract-a",
      },
      observedAt: MUTATION_AT,
      trustedNow: MUTATION_AT,
    }), /exact registered request/u);
  }
  const firstOutcome = contract.phase4CuratedListMutationOutcome({
    request: firstRequest,
    responseReceived: true,
    response: {
      success: true,
      curated_role_list_id: "curated-list-contract-a",
    },
    observedAt: MUTATION_AT,
    trustedNow: MUTATION_AT,
  });
  const firstPartialReadback = normalizeReadback({
    roleIds: ["role-recommended"],
    observedAt: POST_READ_AT,
    trustedNow: COUNT_AT,
  });
  const uncertainReconciliation =
    contract.reconcilePhase4CuratedListWrite({
      plan: firstPlan,
      mutationOutcome: firstOutcome,
      attemptCount: 1,
      maxAttempts: 3,
      trustedNow: COUNT_AT,
    });
  assert.equal(uncertainReconciliation.action, "readback_only");
  assert.throws(() => contract.planPhase4CuratedListWrite({
    ...CONTEXT,
    trustedNow: COUNT_AT,
    candidateId: CANDIDATE_ID,
    candidateUserId: CANDIDATE_USER_ID,
    matchProof,
    preReadback: firstPartialReadback,
    maxAttempts: 3,
  }), /active write lineage cannot mint a fresh root/u);
  const firstReconciliation =
    contract.reconcilePhase4CuratedListWrite({
      plan: firstPlan,
      mutationOutcome: firstOutcome,
      postReadback: firstPartialReadback,
      attemptCount: 1,
      maxAttempts: 3,
      trustedNow: COUNT_AT,
    });
  assert.equal(firstReconciliation.action, "plan_missing_only");
  assert.equal(
    firstReconciliation.replanRequirement.nextAttemptNumber,
    2,
  );
  assert.equal(
    firstReconciliation.replanRequirement.matchResponseDigest,
    matchProof.responseDigest,
  );
  assert.equal(
    firstReconciliation.replanRequirement.matchRecruiterUserId,
    RECRUITER_USER_ID,
  );
  assert.deepEqual(
    firstReconciliation.replanRequirement.recommendedRoleIds,
    ["role-recommended"],
  );
  assert.deepEqual(
    firstReconciliation.replanRequirement.possibleRoleIds,
    ["role-possible"],
  );
  const equivalentReplacementMatch = normalizeMatch(COUNT_AT);
  const changedReplacementMatch = normalizeMatch(COUNT_AT, {
    recruiterUserId: "recruiter-contract-b",
    roles: [
      {
        roleId: "role-recommended",
        endorsed: false,
        suggested: true,
      },
      {
        roleId: "role-possible",
        endorsed: false,
        suggested: true,
      },
    ],
  });
  assert.deepEqual(
    changedReplacementMatch.targetRoleIds,
    matchProof.targetRoleIds,
  );
  assert.deepEqual(
    changedReplacementMatch.targetRoleIds.filter(
      (roleId) => !firstPartialReadback.roleIds.includes(roleId),
    ),
    ["role-possible"],
  );
  assert.notEqual(
    changedReplacementMatch.responseDigest,
    matchProof.responseDigest,
  );
  assert.notEqual(
    changedReplacementMatch.recruiterUserId,
    matchProof.recruiterUserId,
  );
  assert.notDeepEqual(
    changedReplacementMatch.recommendedRoleIds,
    matchProof.recommendedRoleIds,
  );
  for (const replacementMatchProof of [
    equivalentReplacementMatch,
    changedReplacementMatch,
  ]) {
    assert.throws(() => contract.planPhase4CuratedListWrite({
      ...CONTEXT,
      trustedNow: COUNT_AT,
      candidateId: CANDIDATE_ID,
      candidateUserId: CANDIDATE_USER_ID,
      matchProof: replacementMatchProof,
      preReadback: firstPartialReadback,
      replanRequirement: firstReconciliation.replanRequirement,
    }), /replanRequirement is invalid/u);
  }
  for (const omittedMatchProof of [
    matchProof,
    normalizeMatch(COUNT_AT),
  ]) {
    assert.throws(() => contract.planPhase4CuratedListWrite({
      ...CONTEXT,
      trustedNow: COUNT_AT,
      candidateId: CANDIDATE_ID,
      candidateUserId: CANDIDATE_USER_ID,
      matchProof: omittedMatchProof,
      preReadback: firstPartialReadback,
      maxAttempts: 3,
    }), /exact next replanRequirement/u);
  }
  const forkAuthorityDecision = authorizationDecision({
    plan: parallelRootPlan,
    decisionAt: "2026-07-26T00:06:30.000Z",
    expiresAt: "2026-07-26T00:11:00.000Z",
    observedAt: "2026-07-26T00:06:15.000Z",
  });
  assert.equal(forkAuthorityDecision.allowed, false);
  assert.equal(
    forkAuthorityDecision.reasons.includes("write_plan_invalid"),
    true,
  );

  const secondPlan = contract.planPhase4CuratedListWrite({
    ...CONTEXT,
    trustedNow: COUNT_AT,
    candidateId: CANDIDATE_ID,
    candidateUserId: CANDIDATE_USER_ID,
    matchProof,
    preReadback: firstPartialReadback,
    replanRequirement: firstReconciliation.replanRequirement,
  });
  assert.equal(secondPlan.attemptNumber, 2);
  assert.equal(secondPlan.maxAttempts, 3);
  assert.deepEqual(secondPlan.missingRoleIds, ["role-possible"]);
  assert.throws(() => contract.planPhase4CuratedListWrite({
    ...CONTEXT,
    trustedNow: COUNT_AT,
    candidateId: CANDIDATE_ID,
    candidateUserId: CANDIDATE_USER_ID,
    matchProof,
    preReadback: firstPartialReadback,
    replanRequirement: firstReconciliation.replanRequirement,
  }), /replanRequirement is invalid/u);
  assert.throws(() => contract.planPhase4CuratedListWrite({
    ...CONTEXT,
    trustedNow: COUNT_AT,
    candidateId: CANDIDATE_ID,
    candidateUserId: CANDIDATE_USER_ID,
    matchProof,
    preReadback: firstPartialReadback,
    replanRequirement: {
      ...firstReconciliation.replanRequirement,
    },
  }), /replanRequirement is invalid/u);

  const secondRequest = authorize({
    plan: secondPlan,
    decisionAt: "2026-07-26T00:07:00.000Z",
    expiresAt: "2026-07-26T00:12:00.000Z",
    observedAt: "2026-07-26T00:06:30.000Z",
  });
  const secondOutcome = contract.phase4CuratedListMutationOutcome({
    request: secondRequest,
    responseReceived: true,
    response: {
      success: true,
      curated_role_list_id: "curated-list-contract-a",
    },
    observedAt: "2026-07-26T00:08:00.000Z",
    trustedNow: "2026-07-26T00:08:00.000Z",
  });
  const secondPartialReadback = normalizeReadback({
    roleIds: ["role-recommended"],
    observedAt: "2026-07-26T00:09:00.000Z",
    trustedNow: "2026-07-26T00:10:00.000Z",
  });
  for (const counters of [
    { attemptCount: 1, maxAttempts: 3 },
    { attemptCount: 2, maxAttempts: 4 },
  ]) {
    assert.throws(() => contract.reconcilePhase4CuratedListWrite({
      plan: secondPlan,
      mutationOutcome: secondOutcome,
      postReadback: secondPartialReadback,
      ...counters,
      trustedNow: "2026-07-26T00:10:00.000Z",
    }), /strictly advance/u);
  }
  const secondReconciliation =
    contract.reconcilePhase4CuratedListWrite({
      plan: secondPlan,
      mutationOutcome: secondOutcome,
      postReadback: secondPartialReadback,
      attemptCount: 2,
      maxAttempts: 3,
      trustedNow: "2026-07-26T00:10:00.000Z",
    });
  assert.equal(
    secondReconciliation.replanRequirement.nextAttemptNumber,
    3,
  );
  assert.throws(() => contract.reconcilePhase4CuratedListWrite({
    plan: secondPlan,
    mutationOutcome: secondOutcome,
    postReadback: secondPartialReadback,
    attemptCount: 2,
    maxAttempts: 3,
    trustedNow: "2026-07-26T00:10:00.000Z",
  }), /current write lineage/u);

  const thirdPlan = contract.planPhase4CuratedListWrite({
    ...CONTEXT,
    trustedNow: "2026-07-26T00:10:00.000Z",
    candidateId: CANDIDATE_ID,
    candidateUserId: CANDIDATE_USER_ID,
    matchProof,
    preReadback: secondPartialReadback,
    replanRequirement: secondReconciliation.replanRequirement,
  });
  assert.equal(thirdPlan.attemptNumber, 3);
  assert.equal(thirdPlan.maxAttempts, 3);
});

test("duplicate proof rejects empty targets and unchanged-readback fiction", () => {
  const first = readbackProof({
    roleIds: ["role-recommended"],
    observedAt: POST_READ_AT,
    trustedNow: COUNT_AT,
  });
  const duplicate = readbackProof({
    roleIds: ["role-recommended"],
    observedAt: COUNT_AT,
    trustedNow: COUNT_AT,
  });
  assert.equal(phase4DuplicateReaddReadbackDecision({
    firstReadback: first,
    duplicateReadback: duplicate,
    targetRoleIds: [],
    trustedNow: COUNT_AT,
  }).reason, "target_roles_empty");
  const unchangedReads = phase4DuplicateReaddReadbackDecision({
    firstReadback: first,
    authorizedRequest: {
      procedure: PHASE4_CURATED_LIST_ADD_PROCEDURE,
      method: "mutation",
      input: {
        candidate_id: CANDIDATE_ID,
        candidate_user_id: CANDIDATE_USER_ID,
        role_ids: ["role-recommended"],
        type: PHASE4_CURATED_LIST_ADD_TYPE,
        source: PHASE4_CURATED_LIST_ADD_SOURCE,
      },
    },
    mutationOutcome: {
      outcome: "accepted",
      curatedRoleListId: "curated-list-contract-a",
    },
    duplicateReadback: duplicate,
    targetRoleIds: ["role-recommended"],
    trustedNow: COUNT_AT,
  });
  assert.equal(unchangedReads.verified, false);
  assert.equal(
    unchangedReads.reason,
    "duplicate_evidence_chain_invalid",
  );
});

test("exact post-add count excludes unrelated roles and preserves tier semantics", () => {
  const matchProof = rankedProof({
    trustedNow: COUNT_AT,
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
    trustedNow: COUNT_AT,
    observedAt: POST_READ_AT,
    roleIds: [
      "unrelated-one",
      "possible-prior",
      "recommended-prior",
      "possible-new",
      "unrelated-two",
    ],
  });
  const count = exactPhase4PostAddCuratedMatchCount({
    matchProof,
    postReadback,
    trustedNow: COUNT_AT,
  });
  assert.equal(count.complete, true);
  assert.equal(count.recommendedCount, 1);
  assert.equal(count.possibleCount, 2);
  assert.equal(count.matchCount, 3);
  assert.equal(count.unrelatedRoleCount, 2);
});

test("post-add count rejects partial completion and cross-scope replay", () => {
  const matchProof = rankedProof({ trustedNow: COUNT_AT });
  const partial = exactPhase4PostAddCuratedMatchCount({
    matchProof,
    postReadback: readbackProof({
      trustedNow: COUNT_AT,
      observedAt: POST_READ_AT,
      roleIds: ["role-recommended", "unrelated"],
    }),
    trustedNow: COUNT_AT,
  });
  assert.equal(partial.complete, false);
  assert.equal(partial.enrollmentBlocked, true);
  assert.deepEqual(partial.missingTargetRoleIds, ["role-possible"]);

  assert.throws(() => exactPhase4PostAddCuratedMatchCount({
    matchProof,
    postReadback: readbackProof({
      trustedNow: COUNT_AT,
      observedAt: POST_READ_AT,
      roleIds: ["role-recommended", "role-possible"],
      scopeDigest: OTHER_SCOPE_DIGEST,
    }),
    trustedNow: COUNT_AT,
  }), /exact match/u);
  assert.throws(() => exactPhase4PostAddCuratedMatchCount({
    matchProof,
    postReadback: readbackProof({
      trustedNow: COUNT_AT,
      observedAt: POST_READ_AT,
      roleIds: ["role-recommended", "role-possible"],
    }),
    trustedNow: new Date(
      Date.parse(MATCH_AT) + PHASE4_OBSERVATION_PROOF_MAX_AGE_MS + 1,
    ).toISOString(),
  }), /exact match/u);
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

test("Phase 4 curation stays dark with no caller, I/O, or authority minter", async () => {
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
  assert.doesNotMatch(source, /\bSymbol\s*\(/u);
  assert.match(
    source,
    /const globalWriteAuthorityRegistry = new WeakMap\(\)/u,
  );
  assert.doesNotMatch(
    source,
    /export function .*?(?:authority|capture).*mint/iu,
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
