import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  sign,
} from "node:crypto";
import {
  readdir,
  readFile,
} from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_CAPABILITY_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_FINAL_READ_MIN_BUDGET_MS,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_PAIR_MIN_BUDGET_MS,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_EVIDENCE_DIGEST_DOMAIN,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_RECEIPT_DIGEST_DOMAIN,
  SourceRecallClassifierCapsuleCapabilityError,
  consumeSourceRecallClassifierCapsuleCapability,
  issueSourceRecallClassifierCapsuleCapability,
} from "../api/paraai/_lib/source-recall-classifier-capsule-capability.mjs";
import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_SECRET_ENV,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_URL,
} from "../api/paraai/_lib/source-recall-classifier-capsule-client.mjs";
import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_VERSION,
  SOURCE_RECALL_CLASSIFIER_POINT_PROOF_VERSION,
  prepareSourceRecallClassifierCapsuleRequest,
  sourceRecallClassifierCapsuleContextDigest,
  sourceRecallClassifierCapsuleDigest,
  sourceRecallClassifierCapsuleReceiptDigest,
  sourceRecallClassifierCapsuleResponseDigest,
  sourceRecallClassifierCapsuleReceiptSignatureBase,
  sourceRecallClassifierCapsuleReservationId,
  sourceRecallClassifierEndedAtDigest,
  sourceRecallClassifierOutputDigest,
} from "../api/paraai/_lib/source-recall-classifier-capsule-protocol.mjs";
import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_KEY_ID_DOMAIN,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_ENVS,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_PUBLIC_KEY_ENV,
} from "../api/paraai/_lib/source-recall-classifier-capsule-verifier.mjs";
import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_VERSION,
  SourceRecallClassifierCapsuleRuntimeError,
  consumeStableRecallClassifierCapsule,
  issueSourceRecallSuccessEvidenceCapability,
} from "../api/paraai/_lib/source-recall-classifier-capsule-runtime.mjs";
import {
  SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_HANDOFF_VERSION,
  SOURCE_RECALL_SUCCESS_EVIDENCE_DIGEST_DOMAIN,
  SOURCE_RECALL_SUCCESS_EVIDENCE_PROJECTOR_VERSION,
  SOURCE_RECALL_SUCCESS_EVIDENCE_VERSION,
  SourceRecallSuccessEvidenceProjectorError,
  consumeSourceRecallClassifiedManifestEvidenceCapability,
  projectSourceRecallClassifiedManifestEvidenceCapability,
  projectSourceRecallSuccessEvidence,
} from "../api/paraai/_lib/source-recall-success-evidence-projector.mjs";
import {
  SourceRecallClassifiedEvidenceStoreError,
  createSourceRecallClassifiedEvidenceStore,
} from "../api/paraai/_lib/source-recall-classified-evidence-store.mjs";
import {
  createSourceRecallPointObservationManifestStore,
} from "../api/paraai/_lib/source-recall-point-observation-manifest-store.mjs";
import {
  createSourceRecallPointObservationManifestPointInterface,
  createSourceRecallPointObservationStore,
} from "../api/paraai/_lib/source-recall-point-observation-store.mjs";
import {
  SOURCE_RECALL_POINT_REQUEST_VERSION,
  SOURCE_RECALL_POINT_TRANSPORT_RECEIPT_VERSION,
} from "../api/paraai/_lib/source-recall-point-client.mjs";
import {
  recallSourcePointEvidence,
} from "../api/paraai/_lib/source-recall-point-collector.mjs";

const HOUR = 60 * 60 * 1_000;
const BOUNDARY = "2026-07-26T01:00:00.000Z";
const BOUNDARY_MS = Date.parse(BOUNDARY);
const PRODUCTION_TEST_SECRET =
  "runtime-production-path-test-secret-0123456789";
const PRODUCTION_TEST_PUBLIC_KEY_BASE64 =
  "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";
const PRODUCTION_TEST_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(
    "302e020100300506032b657004220420"
      + "9d61b19deffd5a60ba844af492ec2cc444"
      + "49c5697b326919703bac031cae7f60",
    "hex",
  ),
  format: "der",
  type: "pkcs8",
});
const PRODUCTION_TEST_KEY_ID = createHash("sha256")
  .update(
    `${SOURCE_RECALL_CLASSIFIER_CAPSULE_KEY_ID_DOMAIN}\0`,
    "utf8",
  )
  .update(
    Buffer.from(
      PRODUCTION_TEST_PUBLIC_KEY_BASE64,
      "base64",
    ),
  )
  .digest("hex");
const PRODUCTION_TEST_PINS = Object.freeze({
  classifierArtifactDigest:
    "1".repeat(64),
  classifierDeploymentDigest:
    "2".repeat(64),
  classifierRuntimeConfigDigest:
    "3".repeat(64),
  classifierPolicyDigest:
    "4".repeat(64),
});
const REFERENCE = Object.freeze({
  id: "synthetic-runtime-bot",
  joinAt: "2026-07-26T00:30:00.000Z",
  metadataSource: "paraform-auto",
  candidate: Object.freeze({
    fullName: "Synthetic Candidate",
    email: "synthetic@example.invalid",
    linkedin: "https://example.invalid/synthetic",
    paraformEventId: "synthetic-event",
  }),
});

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

function assertDeepFrozen(value, seen = new Set()) {
  if (
    value === null
    || typeof value !== "object"
    || seen.has(value)
  ) {
    return;
  }
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    assertDeepFrozen(child, seen);
  }
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function digest(label) {
  return createHash("sha256")
    .update(label, "utf8")
    .digest("hex");
}

function sha1(body) {
  return createHash("sha1")
    .update(body, "utf8")
    .digest("hex");
}

function semanticDigest(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function verifiedHead(nowMs) {
  const pageExpiresAtMs = nowMs + 20 * HOUR;
  const referenceCommitment = {
    referenceIdDigest: semanticDigest(
      "phase4-recall-reference-id-v1",
      REFERENCE.id,
    ),
    referenceDigest: semanticDigest(
      "phase4-recall-private-reference-v1",
      REFERENCE,
    ),
  };
  const record = {
    version: 1,
    policyVersion: "recall-reference-head-dark-v1",
    kind: "recall_reference_artifact_head_dark",
    source: "recall",
    clientVersion: "recall-private-page-client-v1",
    workKeyDigest: digest("page-work"),
    runNonceDigest: digest("page-run"),
    decisionBoundaryAtMs: BOUNDARY_MS,
    contractPinsDigest: digest("page-pins"),
    passCount: 2,
    pageCount: 1,
    scannedCount: 1,
    referenceCount: 1,
    referenceManifestDigest: semanticDigest(
      "phase4-recall-reference-manifest-v1",
      [referenceCommitment],
    ),
    stablePassSemanticDigest: digest("stable-pass"),
    pageManifests: [{
      cursorDigest: digest("page-cursor-null"),
      nextCursorDigest: digest("page-next-cursor-null"),
      pageExpiresAtMs,
      pageNativeByteProofDigest: "7".repeat(40),
      pageNumber: 1,
      pageRecordDigest: digest("page-record"),
      pageSemanticDigest: digest("page-semantic"),
      referenceCount: 1,
      scannedCount: 1,
    }],
    recallReferenceHeadEpochDigest: digest("head-epoch"),
    recallReferenceHeadRevisionDigest:
      digest("head-revision"),
    sealedAtMs: nowMs,
    pointReadAvailable: false,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
  };
  const raw = canonicalJson(record);
  return deepFreeze({
    raw,
    record,
    recallReferenceHeadEpochDigest:
      record.recallReferenceHeadEpochDigest,
    recallReferenceHeadRevisionDigest:
      record.recallReferenceHeadRevisionDigest,
    recallReferenceHeadRecordDigest: createHash("sha256")
      .update(raw, "utf8")
      .digest("hex"),
    redisNowMs: nowMs,
    pointReadAvailable: false,
    sourceFactsAvailable: false,
    pinnable: false,
    authorityAvailable: false,
  });
}

function verifiedPage(nowMs) {
  const head = verifiedHead(nowMs);
  return deepFreeze({
    record: {
      version: 1,
      policyVersion: "recall-reference-head-dark-v1",
      kind: "recall_private_reference_page_dark",
      source: "recall",
      clientVersion: "recall-private-page-client-v1",
      workKeyDigest: digest("page-work"),
      runNonceDigest: digest("page-run"),
      decisionBoundaryAtMs: BOUNDARY_MS,
      contractPinsDigest: digest("page-pins"),
      passNumber: 2,
      pageNumber: 1,
      cursor: null,
      nextCursor: null,
      pageExpiresAtMs: nowMs + 20 * HOUR,
      pageSemanticDigest: digest("page-semantic"),
      scannedCount: 1,
      referenceCount: 1,
      references: [REFERENCE],
    },
    pageKeyDigest: digest("page-key"),
    pageRecordDigest: digest("page-record"),
    pageNativeByteProofDigest: "7".repeat(40),
    recallReferenceHeadEpochDigest: digest("head-epoch"),
    recallReferenceHeadRevisionDigest:
      digest("head-revision"),
    recallReferenceHeadRecordDigest:
      head.recallReferenceHeadRecordDigest,
    redisNowMs: nowMs,
    remainingTtlMs: 20 * HOUR,
  });
}

function pointRaw(overrides = {}) {
  return deepFreeze({
    id: REFERENCE.id,
    bot_name: "Raydar Screener",
    join_at: "2026-07-26T00:30:00.000000000Z",
    metadata: {
      source: REFERENCE.metadataSource,
      candidate_full_name: REFERENCE.candidate.fullName,
      candidate_email: REFERENCE.candidate.email,
      candidate_linkedin: REFERENCE.candidate.linkedin,
      paraform_event_id:
        REFERENCE.candidate.paraformEventId,
    },
    status_changes: [
      {
        code: "done",
        created_at: "2026-07-26T00:59:00.000000000Z",
      },
    ],
    recordings: [],
    ...overrides,
  });
}

function fakePersistence(startMs) {
  let nowMs = startMs;
  const values = new Map();
  const expiries = new Map();
  const persistence = {
    async time() {
      return { redisNowMs: nowMs };
    },
    async ensure(input) {
      if (nowMs >= input.expiresAtMs) {
        return {
          status: "expired",
          raw: null,
          redisNowMs: nowMs,
          expiresAtMs: -2,
        };
      }
      if (values.has(input.key)) {
        return {
          status: "existing",
          raw: values.get(input.key),
          redisNowMs: nowMs,
          expiresAtMs: expiries.get(input.key),
        };
      }
      values.set(input.key, input.proposedRaw);
      expiries.set(input.key, input.expiresAtMs);
      return {
        status: "created",
        raw: input.proposedRaw,
        redisNowMs: nowMs,
        expiresAtMs: input.expiresAtMs,
      };
    },
    async read(input) {
      if (
        !values.has(input.key)
        || nowMs >= expiries.get(input.key)
      ) {
        values.delete(input.key);
        expiries.delete(input.key);
        return {
          raw: null,
          redisNowMs: nowMs,
          expiresAtMs: -2,
        };
      }
      return {
        raw: values.get(input.key),
        redisNowMs: nowMs,
        expiresAtMs: expiries.get(input.key),
      };
    },
    async compareAndSet(input) {
      const current = values.get(input.key);
      const expiresAtMs = expiries.get(input.key);
      if (current !== input.expectedRaw) {
        return {
          status: "conflict",
          raw: current ?? null,
          redisNowMs: nowMs,
          expiresAtMs: expiresAtMs ?? -2,
        };
      }
      if (
        nowMs >= input.notAfterMs
        || nowMs >= input.expiresAtMs
        || expiresAtMs !== input.expiresAtMs
      ) {
        return {
          status: "expired",
          raw: current,
          redisNowMs: nowMs,
          expiresAtMs: expiresAtMs ?? -2,
        };
      }
      values.set(input.key, input.nextRaw);
      return {
        status: "stored",
        raw: input.nextRaw,
        redisNowMs: nowMs,
        expiresAtMs,
      };
    },
  };
  return {
    persistence,
    values,
    get nowMs() {
      return nowMs;
    },
    advance(deltaMs) {
      nowMs += deltaMs;
    },
    setNow(nextNowMs) {
      nowMs = nextNowMs;
    },
  };
}

function fakeClassifiedPersistence(startMs) {
  let nowMs = startMs;
  let mode = "normal";
  const values = new Map();
  const expiries = new Map();
  const calls = [];
  const persistence = Object.freeze({
    async retain(input) {
      calls.push(input);
      if (
        nowMs < input.issuedAtMs
        || nowMs >= input.notAfterMs
        || nowMs >= input.expiresAtMs
      ) {
        return {
          status: "expired",
          raw: null,
          redisNowMs: nowMs,
          expiresAtMs: -2,
        };
      }
      if (
        values.has(input.key)
        && nowMs >= expiries.get(input.key)
      ) {
        values.delete(input.key);
        expiries.delete(input.key);
      }
      if (values.has(input.key)) {
        return {
          status: "existing",
          raw: values.get(input.key),
          redisNowMs: nowMs,
          expiresAtMs: expiries.get(input.key),
        };
      }
      values.set(input.key, input.proposedRaw);
      expiries.set(input.key, input.expiresAtMs);
      if (mode === "throw_after_store_once") {
        mode = "normal";
        throw new Error("private lost persistence response");
      }
      return {
        status: "created",
        raw: input.proposedRaw,
        redisNowMs: nowMs,
        expiresAtMs: input.expiresAtMs,
      };
    },
  });
  return {
    calls,
    expiries,
    persistence,
    values,
    setMode(value) {
      mode = value;
    },
    setNow(value) {
      nowMs = value;
    },
  };
}

async function observationForClaim(
  claim,
  raw = pointRaw(),
) {
  const request = {
    version: SOURCE_RECALL_POINT_REQUEST_VERSION,
    reservationId: claim.reservationId,
    contextDigest: claim.contextDigest,
    readNumber: claim.readNumber,
    botId: claim.expectedReference.id,
  };
  const requestDigest = createHash("sha256")
    .update(
      "paraai-recall-source-point-request-bytes-v1",
      "utf8",
    )
    .update("\0", "utf8")
    .update(JSON.stringify(request), "utf8")
    .digest("hex");
  const evidence = recallSourcePointEvidence(
    raw,
    deepFreeze({
      decisionBoundaryAt: BOUNDARY,
      expectedReference: claim.expectedReference,
    }),
  );
  return deepFreeze({
    evidence,
    transportReceipt: {
      version:
        SOURCE_RECALL_POINT_TRANSPORT_RECEIPT_VERSION,
      reservationId: claim.reservationId,
      contextDigest: claim.contextDigest,
      readNumber: claim.readNumber,
      requestDigest,
    },
  });
}

async function preparedHarness() {
  const startedAtMs = BOUNDARY_MS + HOUR;
  const fake = fakePersistence(startedAtMs);
  const store = createSourceRecallPointObservationStore({
    persistence: fake.persistence,
  });
  const initial =
    await store.prepareRecallPointObservationWork(
      verifiedPage(startedAtMs),
    );
  const work = deepFreeze({
    workKeyDigest: initial.record.workKeyDigest,
  });
  return { fake, initial, store, work };
}

async function checkpointNext(
  harness,
  raw = pointRaw(),
) {
  const claim =
    await harness.store.claimRecallPointObservationRead(
      harness.work,
    );
  assert.equal(claim.status, "read_required");
  harness.fake.advance(1_000);
  await harness.store.checkpointRecallPointObservationRead(
    claim,
    await observationForClaim(claim, raw),
  );
  return claim;
}

async function stableHarness(raw = pointRaw()) {
  const harness = await preparedHarness();
  await checkpointNext(harness, raw);
  await checkpointNext(harness, raw);
  const snapshot =
    await harness.store.readRecallPointObservationWork(
      harness.work,
    );
  assert.equal(snapshot.record.status, "stable");
  return { ...harness, snapshot };
}

async function classifiedManifestSeedForStableHarness(
  harness,
) {
  const pointObservation =
    createSourceRecallPointObservationManifestPointInterface({
      persistence: harness.fake.persistence,
    });
  const store =
    createSourceRecallPointObservationManifestStore({
      persistence: harness.fake.persistence,
      pointObservation,
    });
  const head = verifiedHead(BOUNDARY_MS + HOUR);
  const basePage = verifiedPage(BOUNDARY_MS + HOUR);
  const page = deepFreeze({
    ...basePage,
    redisNowMs: harness.fake.nowMs,
    remainingTtlMs:
      basePage.record.pageExpiresAtMs
        - harness.fake.nowMs,
  });
  const ensured =
    await store.ensureRecallPointObservationManifest(
      head,
    );
  const work = deepFreeze({
    manifestKeyDigest: ensured.record.manifestKeyDigest,
  });
  const pageClaim =
    await store.claimRecallPointObservationManifestStep(
      work,
    );
  if (pageClaim.status === "complete") {
    return store.issueSourceRecallClassifiedManifestSeed(
      pageClaim,
    );
  }
  assert.equal(pageClaim.status, "page_required");
  await store.checkpointRecallPointObservationManifestPage(
    pageClaim,
    page,
  );
  const observationClaim =
    await store.claimRecallPointObservationManifestStep(
      work,
    );
  assert.equal(
    observationClaim.status,
    "observation_required",
  );
  const prepared =
    await store.prepareRecallPointObservationManifestSelection(
      observationClaim,
      page,
    );
  assert.equal(
    prepared.workKeyDigest,
    harness.snapshot.record.workKeyDigest,
  );
  const checkpoint =
    await store.checkpointRecallPointObservationManifestWork(
      observationClaim,
    );
  assert.equal(checkpoint.status, "verifying_complete");
  const completion =
    await store.claimRecallPointObservationManifestStep(
      work,
    );
  assert.equal(completion.status, "complete");
  assert.equal(
    completion.aggregate.globalReferenceSetCoverageAvailable,
    true,
  );
  return store.issueSourceRecallClassifiedManifestSeed(
    completion,
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectCapabilityCode(code) {
  return (error) => {
    assert.equal(
      error instanceof
        SourceRecallClassifierCapsuleCapabilityError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

function expectRuntimeCode(code) {
  return (error) => {
    assert.equal(
      error instanceof
        SourceRecallClassifierCapsuleRuntimeError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

function expectProjectorCode(code) {
  return (error) => {
    assert.equal(
      error instanceof
        SourceRecallSuccessEvidenceProjectorError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

function expectClassifiedStoreCode(code) {
  return (error) => {
    assert.equal(
      error instanceof
        SourceRecallClassifiedEvidenceStoreError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

function runtimeDependencies(
  nowMs,
  readImpl,
  overrides = {},
) {
  return Object.freeze({
    clientConfiguredImpl: () => true,
    nowImpl: () => nowMs,
    readPrivateRecallClassifierCapsuleImpl: readImpl,
    ...overrides,
  });
}

function classificationOutput(
  classification = "success",
) {
  if (classification === "success") {
    return {
      callsVerdict: "success",
      classification: "success",
      classificationBasis: "transcript_two_way",
    };
  }
  if (classification === "failure") {
    return {
      callsVerdict: "incomplete",
      classification: "failure",
      classificationBasis: "transcript_incomplete",
    };
  }
  return {
    callsVerdict: "pending",
    classification: "unavailable",
    classificationBasis: "processing",
  };
}

function verifiedResult(
  requestValue,
  {
    classification = "success",
    verifiedAtMs,
    keyId = digest("classifier-key"),
    overrides = {},
  } = {},
) {
  const prepared =
    prepareSourceRecallClassifierCapsuleRequest(
      requestValue,
    );
  const output = classificationOutput(classification);
  const readNumber = requestValue.pointReadNumber;
  const capsule = {
    version: SOURCE_RECALL_CLASSIFIER_CAPSULE_VERSION,
    source: "recall",
    pointBindingDigest: prepared.pointBindingDigest,
    pointProofDigest: prepared.pointProofDigest,
    pointResponseDigest:
      digest(`point-response-${readNumber}`),
    decisionBoundaryDigest:
      requestValue.pointProof.decisionBoundaryDigest,
    callEndedAt: "2026-07-26T00:59:00.000Z",
    callEndedAtBasis: "recording_completed_at",
    callEndedAtDigest: digest("call-ended-at"),
    classifierArtifactDigest:
      digest("classifier-artifact"),
    classifierDeploymentDigest:
      digest("classifier-deployment"),
    classifierRuntimeConfigDigest:
      digest("classifier-runtime-config"),
    classifierPolicyDigest: digest("classifier-policy"),
    // The deployed producer binds this digest to each read's distinct
    // pointBindingDigest, pointProofDigest, and pointResponseDigest.
    // It is therefore authenticated per response but not cross-read stable.
    classifierInputDigest:
      digest(`classifier-input-${readNumber}`),
    transcriptEvidenceDigest:
      digest("transcript-evidence"),
    presenceEvidenceDigest: digest("presence-evidence"),
    vapiEvidenceDigest: digest("vapi-evidence"),
    mediaEvidenceDigest: digest("media-evidence"),
    vapiAssociationStatus: "not_used",
    ...output,
    classifierOutputDigest:
      digest(`classifier-output-${classification}`),
    classifiedAtMs:
      requestValue.pointProof.pointCompletedAtMs + 10,
  };
  const response = {
    version:
      SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_VERSION,
    reservationId:
      digest(`classifier-reservation-${readNumber}`),
    contextDigest:
      digest(`classifier-context-${readNumber}`),
    readNumber,
    requestDigest: prepared.requestDigest,
    capsule,
    receipt: {
      version:
        "paraai-recall-classifier-capsule-receipt-v1",
      keyId,
      reservationId:
        digest(`classifier-reservation-${readNumber}`),
      contextDigest:
        digest(`classifier-context-${readNumber}`),
      readNumber,
      requestDigest: prepared.requestDigest,
      pointResponseDigest: capsule.pointResponseDigest,
      capsuleDigest: digest(`capsule-${readNumber}`),
      issuedAtMs:
        requestValue.pointProof.pointCompletedAtMs + 20,
      expiresAtMs:
        requestValue.pointProof.pointCompletedAtMs + HOUR,
      signature: "A".repeat(86),
    },
  };
  return deepFreeze({
    version: "recall-classifier-capsule-verifier-v1",
    verifiedAtMs,
    signatureVerified: true,
    pinsVerified: true,
    keyId,
    responseDigest: digest(`response-${readNumber}`),
    receiptDigest: digest(`receipt-${readNumber}`),
    response,
    operational: false,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
    ...overrides,
  });
}

async function stableClassifierPair(
  snapshot,
  {
    classification = "success",
    mutate,
  } = {},
) {
  const nowMs = snapshot.redisNowMs + 1;
  let ordinal = 0;
  return consumeStableRecallClassifierCapsule(
    issueSourceRecallClassifierCapsuleCapability(snapshot),
    runtimeDependencies(nowMs, async (request) => {
      ordinal += 1;
      let value = verifiedResult(request, {
        classification,
        verifiedAtMs: nowMs + ordinal,
      });
      if (mutate) {
        value = clone(value);
        mutate(value, request);
        value = deepFreeze(value);
      }
      return value;
    }),
  );
}

function signedProductionResponse(
  requestValue,
  {
    callEndedAt =
      "2026-07-26T00:59:00.000Z",
    classification = "success",
  } = {},
) {
  const request =
    prepareSourceRecallClassifierCapsuleRequest(
      requestValue,
    );
  const output = classificationOutput(classification);
  const callEndedAtBasis = callEndedAt === null
    ? "unavailable"
    : "recording_completed_at";
  const capsule = {
    version: SOURCE_RECALL_CLASSIFIER_CAPSULE_VERSION,
    source: "recall",
    pointBindingDigest: request.pointBindingDigest,
    pointProofDigest: request.pointProofDigest,
    pointResponseDigest:
      digest(
        `production-point-response-${request.pointReadNumber}`,
      ),
    decisionBoundaryDigest:
      request.pointProof.decisionBoundaryDigest,
    callEndedAt,
    callEndedAtBasis,
    callEndedAtDigest:
      sourceRecallClassifierEndedAtDigest({
        sourceRecordDigest:
          request.pointProof.sourceRecordDigest,
        callEndedAt,
        callEndedAtBasis,
      }),
    ...PRODUCTION_TEST_PINS,
    classifierInputDigest:
      digest(
        `production-classifier-input-${request.pointReadNumber}`,
      ),
    transcriptEvidenceDigest:
      digest("production-transcript-evidence"),
    presenceEvidenceDigest:
      digest("production-presence-evidence"),
    vapiEvidenceDigest:
      digest("production-vapi-evidence"),
    mediaEvidenceDigest:
      digest("production-media-evidence"),
    vapiAssociationStatus: "not_used",
    ...output,
    classifierOutputDigest:
      sourceRecallClassifierOutputDigest({
        vapiAssociationStatus: "not_used",
        ...output,
      }),
    classifiedAtMs:
      request.pointProof.pointCompletedAtMs + 10,
  };
  const contextDigest =
    sourceRecallClassifierCapsuleContextDigest(
      request,
      PRODUCTION_TEST_PINS,
    );
  const reservationId =
    sourceRecallClassifierCapsuleReservationId(
      request,
      contextDigest,
    );
  const unsignedReceipt = {
    version:
      SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_VERSION,
    keyId: PRODUCTION_TEST_KEY_ID,
    reservationId,
    contextDigest,
    readNumber: request.pointReadNumber,
    requestDigest: request.requestDigest,
    pointResponseDigest: capsule.pointResponseDigest,
    capsuleDigest:
      sourceRecallClassifierCapsuleDigest(
        capsule,
        request,
      ),
    issuedAtMs: capsule.classifiedAtMs + 10,
    expiresAtMs: capsule.classifiedAtMs + HOUR,
  };
  const receipt = {
    ...unsignedReceipt,
    signature: sign(
      null,
      Buffer.from(
        sourceRecallClassifierCapsuleReceiptSignatureBase(
          unsignedReceipt,
        ),
        "utf8",
      ),
      PRODUCTION_TEST_PRIVATE_KEY,
    ).toString("base64url"),
  };
  return JSON.stringify({
    version:
      SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_VERSION,
    reservationId,
    contextDigest,
    readNumber: request.pointReadNumber,
    requestDigest: request.requestDigest,
    capsule,
    receipt,
  });
}

async function productionClassifierPair(
  snapshot,
  options = {},
) {
  const {
    clockOffsetMs = 1_000,
    ...responseOptions
  } = options;
  const environmentValues = {
    [SOURCE_RECALL_CLASSIFIER_CAPSULE_SECRET_ENV]:
      PRODUCTION_TEST_SECRET,
    [SOURCE_RECALL_CLASSIFIER_CAPSULE_PUBLIC_KEY_ENV]:
      PRODUCTION_TEST_PUBLIC_KEY_BASE64,
  };
  for (const [key, environmentName] of Object.entries(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_ENVS,
  )) {
    environmentValues[environmentName] =
      PRODUCTION_TEST_PINS[key];
  }
  const savedEnvironment = new Map(
    Object.keys(environmentValues).map(
      (key) => [key, process.env[key]],
    ),
  );
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  let nowMs = snapshot.redisNowMs + clockOffsetMs;
  try {
    for (const [key, value] of Object.entries(
      environmentValues,
    )) {
      process.env[key] = value;
    }
    Date.now = () => {
      nowMs += 1;
      return nowMs;
    };
    globalThis.fetch = async (url, request) => {
      assert.equal(url, SOURCE_RECALL_CLASSIFIER_CAPSULE_URL);
      assert.equal(request.method, "POST");
      const requestValue = JSON.parse(request.body);
      return new Response(
        signedProductionResponse(
          requestValue,
          responseOptions,
        ),
        {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type":
              "application/json; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        },
      );
    };
    return await consumeStableRecallClassifierCapsule(
      issueSourceRecallClassifierCapsuleCapability(
        snapshot,
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function assertHardDark(result) {
  for (const key of [
    "operational",
    "globalReferenceSetCoverageAvailable",
    "sourceFactsAvailable",
    "successClassificationAvailable",
    "candidateIdentityResolutionAvailable",
    "q37TransitionAvailable",
    "pinnable",
    "authorityAvailable",
    "curationAvailable",
    "enrollmentAvailable",
    "outreachAvailable",
    "candidateFacingWriteAvailable",
  ]) {
    assert.equal(result[key], false, key);
  }
  assertDeepFrozen(result);
}

test("a validated stable point issues one opaque, unforgeable, one-shot capability", async () => {
  const { snapshot } = await stableHarness();
  const capability =
    issueSourceRecallClassifierCapsuleCapability(snapshot);
  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_CAPABILITY_VERSION,
    "recall-classifier-capsule-capability-v1",
  );
  assert.equal(Object.isFrozen(capability), true);
  assert.deepEqual(Object.keys(capability), []);
  assert.equal(JSON.stringify(capability), "{}");
  assert.throws(
    () => consumeSourceRecallClassifierCapsuleCapability(
      Object.freeze({}),
    ),
    expectCapabilityCode(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_CAPABILITY_INVALID",
    ),
  );

  let calls = 0;
  const nowMs = snapshot.redisNowMs + 1;
  const result = await consumeStableRecallClassifierCapsule(
    capability,
    runtimeDependencies(nowMs, async (request) => {
      calls += 1;
      return verifiedResult(request, {
        verifiedAtMs: nowMs + calls,
      });
    }),
  );
  assert.equal(result.pairStatus, "stable");
  assert.equal(calls, 2);

  await assert.rejects(
    consumeStableRecallClassifierCapsule(
      capability,
      runtimeDependencies(nowMs, async () => {
        calls += 1;
      }),
    ),
    expectRuntimeCode(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_CAPABILITY_INVALID",
    ),
  );
  assert.equal(calls, 2);
});

test("the capability derives exact ordered read-one/read-two requests with no caller selector", async () => {
  const { snapshot } = await stableHarness();
  const observed = [];
  const nowMs = snapshot.redisNowMs + 1;
  const result = await consumeStableRecallClassifierCapsule(
    issueSourceRecallClassifierCapsuleCapability(snapshot),
    runtimeDependencies(nowMs, async (request) => {
      observed.push(request);
      return verifiedResult(request, {
        verifiedAtMs: nowMs + observed.length,
      });
    }),
  );

  assert.equal(result.pairStatus, "stable");
  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_VERSION,
    "recall-classifier-capsule-runtime-dark-v1",
  );
  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_VERSION,
    "recall-private-classifier-capsule-client-v1",
  );
  assert.equal(observed.length, 2);
  assert.deepEqual(
    observed.map((request) => request.pointReadNumber),
    [1, 2],
  );
  for (let index = 0; index < observed.length; index += 1) {
    const request = observed[index];
    const read = index === 0
      ? snapshot.record.readOne
      : snapshot.record.readTwo;
    assert.deepEqual(Object.keys(request), [
      "version",
      "pointReservationId",
      "pointContextDigest",
      "pointReadNumber",
      "pointRequestDigest",
      "decisionBoundaryAt",
      "pointProof",
    ]);
    assert.deepEqual(Object.keys(request.pointProof), [
      "version",
      "observationStatus",
      "workKeyDigest",
      "contractPinsDigest",
      "workItemDigest",
      "resolutionDigest",
      "pointCompletedAtMs",
      "pointTransportReceiptDigest",
      "pointEvidenceDigest",
      "sourceNormalizedInputDigest",
      "sourceRecordDigest",
      "sourceRecordRevisionDigest",
      "sourceReferenceDigest",
      "sourceProvenanceDigest",
      "sourceStatusAtBoundaryDigest",
      "decisionBoundaryDigest",
    ]);
    assert.equal(
      request.version,
      SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_VERSION,
    );
    assert.equal(
      request.pointReservationId,
      read.transportReceipt.reservationId,
    );
    assert.equal(
      request.pointContextDigest,
      read.transportReceipt.contextDigest,
    );
    assert.equal(
      request.pointRequestDigest,
      read.transportReceipt.requestDigest,
    );
    assert.equal(
      request.decisionBoundaryAt,
      new Date(
        snapshot.record.decisionBoundaryAtMs,
      ).toISOString(),
    );
    assert.equal(
      request.pointProof.version,
      SOURCE_RECALL_CLASSIFIER_POINT_PROOF_VERSION,
    );
    assert.equal(request.pointProof.observationStatus, "stable");
    assert.equal(
      request.pointProof.pointCompletedAtMs,
      read.completedAtMs,
    );
    assert.equal(
      request.pointProof.pointTransportReceiptDigest,
      semanticDigest(
        SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_RECEIPT_DIGEST_DOMAIN,
        read.transportReceipt,
      ),
    );
    assert.equal(
      request.pointProof.pointEvidenceDigest,
      semanticDigest(
        SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_EVIDENCE_DIGEST_DOMAIN,
        read.evidence,
      ),
    );
    for (const forbidden of [
      "botId",
      "candidateId",
      "cursor",
      "deployment",
      "digest",
      "force",
      "limit",
      "reservationId",
      "retry",
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          request,
          forbidden,
        ),
        false,
      );
    }
    assertDeepFrozen(request);
  }
});

test("the runtime makes exactly two sequential client calls and never retries", async () => {
  const { snapshot } = await stableHarness();
  const nowMs = snapshot.redisNowMs + 1;
  const events = [];
  let active = false;
  let ordinal = 0;
  await consumeStableRecallClassifierCapsule(
    issueSourceRecallClassifierCapsuleCapability(snapshot),
    runtimeDependencies(nowMs, async (request) => {
      ordinal += 1;
      assert.equal(active, false);
      active = true;
      events.push(`start-${request.pointReadNumber}`);
      await Promise.resolve();
      events.push(`end-${request.pointReadNumber}`);
      active = false;
      return verifiedResult(request, {
        verifiedAtMs: nowMs + ordinal,
      });
    }),
  );
  assert.deepEqual(events, [
    "start-1",
    "end-1",
    "start-2",
    "end-2",
  ]);

  const failedReads = [];
  const unresolved =
    await consumeStableRecallClassifierCapsule(
      issueSourceRecallClassifierCapsuleCapability(snapshot),
      runtimeDependencies(nowMs, async (request) => {
        failedReads.push(request.pointReadNumber);
        throw new Error("private transport detail");
      }),
    );
  assert.deepEqual(failedReads, [1, 2]);
  assert.equal(unresolved.pairStatus, "unresolved");
  assert.deepEqual(unresolved.signedResponses, []);
  assertHardDark(unresolved);
});

test("stable, conflicting, and unresolved pairs remain hard-dark", async (t) => {
  await t.test("stable success", async () => {
    const { snapshot } = await stableHarness();
    const nowMs = snapshot.redisNowMs + 1;
    let ordinal = 0;
    const result =
      await consumeStableRecallClassifierCapsule(
        issueSourceRecallClassifierCapsuleCapability(
          snapshot,
        ),
        runtimeDependencies(nowMs, async (request) => {
          ordinal += 1;
          return verifiedResult(request, {
            verifiedAtMs: nowMs + ordinal,
          });
        }),
      );
    assert.equal(
      result.status,
      "verified_stable_signed_capsule_pair_dark",
    );
    assert.equal(result.pairStatus, "stable");
    assert.equal(result.classificationCandidate, "success");
    assert.equal(
      result.classificationBasis,
      "transcript_two_way",
    );
    assert.equal(result.callsVerdict, "success");
    assert.equal(
      result.callEndedAt,
      "2026-07-26T00:59:00.000Z",
    );
    assert.equal(result.responseDigests.length, 2);
    assert.equal(result.receiptDigests.length, 2);
    assert.equal(result.signedResponses.length, 2);
    assert.notEqual(
      result.signedResponses[0].capsule
        .classifierInputDigest,
      result.signedResponses[1].capsule
        .classifierInputDigest,
    );
    assertHardDark(result);
  });

  await t.test("conflicting classifications", async () => {
    const { snapshot } = await stableHarness();
    const nowMs = snapshot.redisNowMs + 1;
    let ordinal = 0;
    const result =
      await consumeStableRecallClassifierCapsule(
        issueSourceRecallClassifierCapsuleCapability(
          snapshot,
        ),
        runtimeDependencies(nowMs, async (request) => {
          ordinal += 1;
          return verifiedResult(request, {
            classification:
              request.pointReadNumber === 1
                ? "success"
                : "failure",
            verifiedAtMs: nowMs + ordinal,
          });
        }),
      );
    assert.equal(
      result.status,
      "verified_conflicting_signed_capsule_pair_dark",
    );
    assert.equal(result.pairStatus, "conflict");
    assert.equal(
      result.classificationCandidate,
      "unavailable",
    );
    assert.equal(result.classificationBasis, null);
    assert.equal(result.callsVerdict, null);
    assert.equal(result.callEndedAt, null);
    assertHardDark(result);
  });

  for (const failedRead of [1, 2]) {
    await t.test(
      `client read ${failedRead} unavailable`,
      async () => {
        const { snapshot } = await stableHarness();
        const nowMs = snapshot.redisNowMs + 1;
        let ordinal = 0;
        const result =
          await consumeStableRecallClassifierCapsule(
            issueSourceRecallClassifierCapsuleCapability(
              snapshot,
            ),
            runtimeDependencies(nowMs, async (request) => {
              ordinal += 1;
              if (request.pointReadNumber === failedRead) {
                throw new Error("private read failure");
              }
              return verifiedResult(request, {
                verifiedAtMs: nowMs + ordinal,
              });
            }),
          );
        assert.equal(
          result.status,
          "unresolved_signed_capsule_pair_dark",
        );
        assert.equal(result.pairStatus, "unresolved");
        assert.equal(
          result.classificationCandidate,
          "unavailable",
        );
        assert.equal(result.classificationBasis, null);
        assert.equal(result.callsVerdict, null);
        assert.equal(result.callEndedAt, null);
        assert.deepEqual(result.signedResponses, []);
        assertHardDark(result);
      },
    );
  }
});

test("a signed unavailable pair never becomes success evidence or authority", async () => {
  const { snapshot } = await stableHarness();
  const nowMs = snapshot.redisNowMs + 1;
  let ordinal = 0;
  const result = await consumeStableRecallClassifierCapsule(
    issueSourceRecallClassifierCapsuleCapability(snapshot),
    runtimeDependencies(nowMs, async (request) => {
      ordinal += 1;
      return verifiedResult(request, {
        classification: "unavailable",
        verifiedAtMs: nowMs + ordinal,
      });
    }),
  );
  assert.equal(result.pairStatus, "stable");
  assert.equal(
    result.classificationCandidate,
    "unavailable",
  );
  assert.equal(result.classificationBasis, "processing");
  assert.equal(result.callsVerdict, "pending");
  assert.equal(result.successClassificationAvailable, false);
  assert.equal(result.sourceFactsAvailable, false);
  assert.equal(result.authorityAvailable, false);
  assertHardDark(result);
});

test("only an exact stable runtime result can issue one opaque, unforgeable, one-shot evidence capability", async (t) => {
  const { snapshot } = await stableHarness();
  const injectedResult =
    await stableClassifierPair(snapshot);
  assert.equal(injectedResult.pairStatus, "stable");
  assert.throws(
    () => issueSourceRecallSuccessEvidenceCapability(
      injectedResult,
    ),
    expectRuntimeCode(
      "SOURCE_RECALL_SUCCESS_EVIDENCE_RUNTIME_RESULT_INVALID",
    ),
  );
  const result =
    await productionClassifierPair(snapshot);

  for (const forged of [
    clone(result),
    deepFreeze(clone(result)),
    Object.freeze({}),
    null,
  ]) {
    assert.throws(
      () => issueSourceRecallSuccessEvidenceCapability(
        forged,
      ),
      expectRuntimeCode(
        "SOURCE_RECALL_SUCCESS_EVIDENCE_RUNTIME_RESULT_INVALID",
      ),
    );
  }

  const capability =
    issueSourceRecallSuccessEvidenceCapability(result);
  assert.equal(Object.isFrozen(capability), true);
  assert.deepEqual(Object.keys(capability), []);
  assert.equal(JSON.stringify(capability), "{}");
  assert.throws(
    () => issueSourceRecallSuccessEvidenceCapability(
      result,
    ),
    expectRuntimeCode(
      "SOURCE_RECALL_SUCCESS_EVIDENCE_RUNTIME_RESULT_INVALID",
    ),
  );
  assert.throws(
    () => projectSourceRecallSuccessEvidence(
      Object.freeze({}),
    ),
    expectProjectorCode(
      "SOURCE_RECALL_SUCCESS_EVIDENCE_CAPABILITY_INVALID",
    ),
  );

  const evidence =
    projectSourceRecallSuccessEvidence(capability);
  assert.equal(evidence.classificationProofComplete, true);
  assert.throws(
    () => projectSourceRecallSuccessEvidence(capability),
    expectProjectorCode(
      "SOURCE_RECALL_SUCCESS_EVIDENCE_CAPABILITY_INVALID",
    ),
  );

  await t.test("conflict cannot issue", async () => {
    const conflict = await stableClassifierPair(
      snapshot,
      {
        mutate(value, request) {
          if (request.pointReadNumber === 2) {
            value.response.capsule.classification =
              "failure";
          }
        },
      },
    );
    assert.equal(conflict.pairStatus, "conflict");
    assert.throws(
      () => issueSourceRecallSuccessEvidenceCapability(
        conflict,
      ),
      expectRuntimeCode(
        "SOURCE_RECALL_SUCCESS_EVIDENCE_RUNTIME_RESULT_INVALID",
      ),
    );
  });

  await t.test("unresolved cannot issue", async () => {
    const nowMs = snapshot.redisNowMs + 1;
    const unresolved =
      await consumeStableRecallClassifierCapsule(
        issueSourceRecallClassifierCapsuleCapability(
          snapshot,
        ),
        runtimeDependencies(nowMs, async () => {
          throw new Error("private transport detail");
        }),
      );
    assert.equal(unresolved.pairStatus, "unresolved");
    assert.throws(
      () => issueSourceRecallSuccessEvidenceCapability(
        unresolved,
      ),
      expectRuntimeCode(
        "SOURCE_RECALL_SUCCESS_EVIDENCE_RUNTIME_RESULT_INVALID",
      ),
    );
  });
});

test("the projector-to-store handoff starts only from verified runtime provenance and is one-shot across purposes", async (t) => {
  const { snapshot } = await stableHarness();
  assert.equal(
    SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_HANDOFF_VERSION,
    "recall-classified-manifest-evidence-handoff-dark-v1",
  );

  const publicPair =
    await productionClassifierPair(snapshot);
  const publicEvidence =
    projectSourceRecallSuccessEvidence(
      issueSourceRecallSuccessEvidenceCapability(publicPair),
    );
  for (const forged of [
    publicEvidence,
    clone(publicEvidence),
    deepFreeze(clone(publicEvidence)),
    structuredClone(publicEvidence),
    Object.freeze({
      classificationEvidenceDigest:
        publicEvidence.classificationEvidenceDigest,
    }),
    Object.freeze({}),
    new Proxy(Object.freeze({}), {}),
    null,
  ]) {
    assert.throws(
      () =>
        projectSourceRecallClassifiedManifestEvidenceCapability(
          forged,
        ),
      expectProjectorCode(
        "SOURCE_RECALL_SUCCESS_EVIDENCE_CAPABILITY_INVALID",
      ),
    );
    assert.throws(
      () =>
        consumeSourceRecallClassifiedManifestEvidenceCapability(
          forged,
        ),
      expectProjectorCode(
        "SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_CAPABILITY_INVALID",
      ),
    );
  }

  const crossPurposePair =
    await productionClassifierPair(snapshot);
  const upstreamCapability =
    issueSourceRecallSuccessEvidenceCapability(
      crossPurposePair,
    );
  assert.throws(
    () =>
      consumeSourceRecallClassifiedManifestEvidenceCapability(
        upstreamCapability,
      ),
    expectProjectorCode(
      "SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_CAPABILITY_INVALID",
    ),
  );
  const storeCapability =
    projectSourceRecallClassifiedManifestEvidenceCapability(
      upstreamCapability,
    );
  assert.equal(Object.isFrozen(storeCapability), true);
  assert.deepEqual(Object.keys(storeCapability), []);
  assert.equal(JSON.stringify(storeCapability), "{}");
  assert.throws(
    () => projectSourceRecallSuccessEvidence(
      storeCapability,
    ),
    expectProjectorCode(
      "SOURCE_RECALL_SUCCESS_EVIDENCE_CAPABILITY_INVALID",
    ),
  );
  assert.throws(
    () =>
      consumeSourceRecallClassifiedManifestEvidenceCapability(
        Object.freeze({ ...storeCapability }),
      ),
    expectProjectorCode(
      "SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_CAPABILITY_INVALID",
    ),
  );
  assert.throws(
    () =>
      consumeSourceRecallClassifiedManifestEvidenceCapability(
        structuredClone(storeCapability),
      ),
    expectProjectorCode(
      "SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_CAPABILITY_INVALID",
    ),
  );
  for (const retry of [
    () =>
      projectSourceRecallSuccessEvidence(
        upstreamCapability,
      ),
    () =>
      projectSourceRecallClassifiedManifestEvidenceCapability(
        upstreamCapability,
      ),
  ]) {
    assert.throws(
      retry,
      expectProjectorCode(
        "SOURCE_RECALL_SUCCESS_EVIDENCE_CAPABILITY_INVALID",
      ),
    );
  }

  const retained =
    consumeSourceRecallClassifiedManifestEvidenceCapability(
      storeCapability,
    );
  assert.equal(Object.isFrozen(retained), true);
  assertDeepFrozen(retained);
  assert.deepEqual(Object.keys(retained), [
    "version",
    "evidence",
    "settlementStatus",
    "signedResponses",
    "upstreamIssuedFromRedisAtMs",
    "upstreamNotAfterMs",
  ]);
  assert.equal(
    retained.version,
    SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_HANDOFF_VERSION,
  );
  assert.equal(retained.settlementStatus, "terminal");
  assert.equal(retained.evidence.classification, "success");
  assert.equal(
    retained.evidence.classificationEvidenceDigest,
    publicEvidence.classificationEvidenceDigest,
  );
  assert.deepEqual(
    retained.signedResponses,
    crossPurposePair.signedResponses,
  );
  assert.deepEqual(
    retained.signedResponses.map(
      (response) => Object.keys(response),
    ),
    Array.from({ length: 2 }, () => [
      "version",
      "reservationId",
      "contextDigest",
      "readNumber",
      "requestDigest",
      "capsule",
      "receipt",
    ]),
  );
  assert.deepEqual(
    retained.signedResponses.map(
      (response) => Object.keys(response.capsule),
    ),
    Array.from({ length: 2 }, () => [
      "version",
      "source",
      "pointBindingDigest",
      "pointProofDigest",
      "pointResponseDigest",
      "decisionBoundaryDigest",
      "callEndedAt",
      "callEndedAtBasis",
      "callEndedAtDigest",
      "classifierArtifactDigest",
      "classifierDeploymentDigest",
      "classifierRuntimeConfigDigest",
      "classifierPolicyDigest",
      "classifierInputDigest",
      "transcriptEvidenceDigest",
      "presenceEvidenceDigest",
      "vapiEvidenceDigest",
      "mediaEvidenceDigest",
      "vapiAssociationStatus",
      "callsVerdict",
      "classification",
      "classificationBasis",
      "classifierOutputDigest",
      "classifiedAtMs",
    ]),
  );
  assert.deepEqual(
    retained.signedResponses.map(
      (response) => Object.keys(response.receipt),
    ),
    Array.from({ length: 2 }, () => [
      "version",
      "keyId",
      "reservationId",
      "contextDigest",
      "readNumber",
      "requestDigest",
      "pointResponseDigest",
      "capsuleDigest",
      "issuedAtMs",
      "expiresAtMs",
      "signature",
    ]),
  );
  for (const [index, response] of
    retained.signedResponses.entries()) {
    assert.equal(response.readNumber, index + 1);
    assert.equal(response.receipt.readNumber, index + 1);
    assert.equal(
      response.requestDigest,
      retained.evidence.requestDigests[index],
    );
    assert.equal(
      response.capsule.pointProofDigest,
      retained.evidence.pointProofDigests[index],
    );
    assert.equal(
      response.capsule.pointBindingDigest,
      retained.evidence.pointBindingDigests[index],
    );
    assert.equal(
      response.capsule.pointResponseDigest,
      retained.evidence.pointResponseDigests[index],
    );
    assert.equal(
      response.capsule.classifierInputDigest,
      retained.evidence.classifierInputDigests[index],
    );
    assert.equal(
      sourceRecallClassifierCapsuleResponseDigest(
        JSON.stringify(response),
      ),
      retained.evidence.responseDigests[index],
    );
    assert.equal(
      sourceRecallClassifierCapsuleReceiptDigest(
        response.receipt,
      ),
      retained.evidence.receiptDigests[index],
    );
  }
  const retainedSerialized = JSON.stringify(retained);
  for (const privateValue of [
    REFERENCE.id,
    REFERENCE.metadataSource,
    REFERENCE.candidate.fullName,
    REFERENCE.candidate.email,
    REFERENCE.candidate.linkedin,
    REFERENCE.candidate.paraformEventId,
  ]) {
    assert.equal(
      retainedSerialized.includes(privateValue),
      false,
    );
  }
  assert.doesNotMatch(retainedSerialized, /https?:\/\//u);
  assert.doesNotMatch(
    retainedSerialized,
    /"(?:candidate|email|linkedin|paraformEventId|rawBody|responseBody|transcript)"\s*:/u,
  );
  assert.equal(
    retained.upstreamIssuedFromRedisAtMs,
    snapshot.redisNowMs,
  );
  assert.equal(
    retained.upstreamNotAfterMs,
    snapshot.record.expiresAtMs,
  );
  assert.equal(
    retained.upstreamIssuedFromRedisAtMs
      < retained.upstreamNotAfterMs,
    true,
  );
  assert.throws(
    () =>
      consumeSourceRecallClassifiedManifestEvidenceCapability(
        storeCapability,
      ),
    expectProjectorCode(
      "SOURCE_RECALL_CLASSIFIED_MANIFEST_EVIDENCE_CAPABILITY_INVALID",
    ),
  );

  const consumedPublicPair =
    await productionClassifierPair(snapshot);
  const consumedPublicCapability =
    issueSourceRecallSuccessEvidenceCapability(
      consumedPublicPair,
    );
  projectSourceRecallSuccessEvidence(
    consumedPublicCapability,
  );
  assert.throws(
    () =>
      projectSourceRecallClassifiedManifestEvidenceCapability(
        consumedPublicCapability,
      ),
    expectProjectorCode(
      "SOURCE_RECALL_SUCCESS_EVIDENCE_CAPABILITY_INVALID",
    ),
  );

  for (const classification of [
    "success",
    "failure",
    "unavailable",
  ]) {
    await t.test(classification, async () => {
      const pair = await productionClassifierPair(
        snapshot,
        { classification },
      );
      const capability =
        projectSourceRecallClassifiedManifestEvidenceCapability(
          issueSourceRecallSuccessEvidenceCapability(pair),
        );
      const value =
        consumeSourceRecallClassifiedManifestEvidenceCapability(
          capability,
        );
      assert.equal(
        value.evidence.classification,
        classification,
      );
      assert.equal(
        value.settlementStatus,
        classification === "unavailable"
          ? "unsettled"
          : "terminal",
      );
      assert.equal(
        value.evidence.classificationProofComplete,
        classification !== "unavailable",
      );
      assertHardDark(value.evidence);
    });
  }
});

test("one complete manifest seed and one signed-evidence handoff retain exactly one sealed member before the non-renewable deadline", async (t) => {
  const harness = await stableHarness();
  const pair = await productionClassifierPair(
    harness.snapshot,
  );
  const persistence = fakeClassifiedPersistence(
    pair.verifiedAtMs + 1,
  );
  const store = createSourceRecallClassifiedEvidenceStore({
    persistence: persistence.persistence,
    sealSecret:
      "classified-evidence-test-seal-secret-0123456789",
  });
  const manifestCapability =
    await classifiedManifestSeedForStableHarness(
      harness,
    );
  const evidenceCapability =
    projectSourceRecallClassifiedManifestEvidenceCapability(
      issueSourceRecallSuccessEvidenceCapability(pair),
    );
  const retained =
    await store.retainSourceRecallClassifiedEvidence(
      manifestCapability,
      evidenceCapability,
    );
  assert.equal(retained.status, "retained_terminal_dark");
  assert.equal(retained.created, true);
  assert.equal(retained.classification, "success");
  assert.equal(
    retained.classificationProofComplete,
    true,
  );
  assert.equal(
    retained.signedResponseRetentionAvailable,
    true,
  );
  assert.equal(
    retained.durableProvenanceSealAvailable,
    true,
  );
  assert.equal(
    retained.referenceManifestCoverageComplete,
    false,
  );
  assert.equal(retained.durableAttestationAvailable, false);
  assertHardDark(retained);
  assert.equal(persistence.calls.length, 1);
  assert.deepEqual(
    Object.keys(persistence.calls[0]).sort(),
    [
      "expiresAtMs",
      "issuedAtMs",
      "key",
      "notAfterMs",
      "proposedRaw",
    ],
  );
  // The transition floor is Redis-derived only. This fixture's local verifier
  // clock runs ahead of both Redis instants, so folding it in would show up
  // here as an issuedAtMs at or above pair.verifiedAtMs.
  assert.ok(
    persistence.calls[0].issuedAtMs < pair.verifiedAtMs,
  );
  assert.equal(
    persistence.calls[0].notAfterMs,
    Math.min(
      ...pair.signedResponses.map(
        (response) => response.receipt.expiresAtMs,
      ),
    ),
  );
  assert.equal(
    persistence.calls[0].expiresAtMs,
    harness.snapshot.record.expiresAtMs,
  );
  const raw = [...persistence.values.values()][0];
  const durable = JSON.parse(raw);
  assert.equal(
    durable.kind,
    "recall_classified_evidence_dark",
  );
  assert.equal(durable.signedResponses.length, 2);
  assert.equal(durable.recordSeal.length, 64);
  // Exactly the two Redis-derived observation clocks bound the transition;
  // the local verifier clock is retained as evidence but never compared
  // against the classified-evidence Redis TIME.
  assert.equal(
    persistence.calls[0].issuedAtMs,
    Math.max(
      durable.manifestIssuedFromRedisAtMs,
      durable.upstreamIssuedFromRedisAtMs,
    ),
  );
  assert.ok(
    Math.max(...durable.evidence.classifierVerifiedAtMs)
      > persistence.calls[0].issuedAtMs,
  );
  // A non-secret seal-key identifier is persisted inside the sealed body as a
  // triage hint only. Anyone who can rewrite the record can also choose it, so
  // it is never evidence that a rejection was benign — see sealKeyIdDigest and
  // the tamperer-chooses-the-code subtest below.
  assert.match(durable.sealKeyId, /^[a-f0-9]{64}$/u);
  assert.equal(
    raw.includes(
      "classified-evidence-test-seal-secret-0123456789",
    ),
    false,
  );
  // The public aggregate's exact shape is pinned, so a later change cannot
  // add or flip a claim without a test noticing.
  assert.deepEqual(
    Object.keys(retained).sort(),
    [
      "authorityAvailable",
      "candidateFacingWriteAvailable",
      "candidateIdentityResolutionAvailable",
      "classification",
      "classificationEvidenceDigest",
      "classificationProofComplete",
      "created",
      "curationAvailable",
      "durableAttestationAvailable",
      "durableProvenanceSealAvailable",
      "enrollmentAvailable",
      "expiresAtMs",
      "globalReferenceSetCoverageAvailable",
      "operational",
      "outreachAvailable",
      "pinnable",
      "q37TransitionAvailable",
      "referenceManifestCoverageComplete",
      "retainedAtRedisMs",
      "signedResponseRetentionAvailable",
      "sourceFactsAvailable",
      "standaloneSignatureReverificationAvailable",
      "status",
      "successClassificationAvailable",
      "workKeyDigest",
    ],
  );
  assert.equal(
    retained.standaloneSignatureReverificationAvailable,
    false,
  );
  assert.equal(
    durable.evidence.classificationEvidenceDigest,
    retained.classificationEvidenceDigest,
  );
  assert.equal(
    durable.manifestCompleteProofDigest.length,
    64,
  );
  assert.equal(
    durable.manifestMemberSetDigest.length,
    64,
  );
  assert.equal(
    durable.memberReferenceDigest.length,
    64,
  );
  assert.equal(
    durable.memberReferenceIdDigest.length,
    64,
  );
  assert.equal(
    Buffer.byteLength(raw, "utf8") < 256 * 1_024,
    true,
  );
  for (const privateValue of [
    REFERENCE.id,
    REFERENCE.metadataSource,
    REFERENCE.candidate.fullName,
    REFERENCE.candidate.email,
    REFERENCE.candidate.linkedin,
    REFERENCE.candidate.paraformEventId,
  ]) {
    assert.equal(raw.includes(privateValue), false);
  }
  assert.doesNotMatch(raw, /https?:\/\//u);
  assert.doesNotMatch(
    raw,
    /"(?:candidate|email|linkedin|paraformEventId|rawBody|responseBody|transcript)"\s*:/u,
  );
  assert.equal(
    Object.hasOwn(retained, "signedResponses"),
    false,
  );
  await assert.rejects(
    store.retainSourceRecallClassifiedEvidence(
      manifestCapability,
      evidenceCapability,
    ),
    expectClassifiedStoreCode(
      "SOURCE_RECALL_CLASSIFIED_EVIDENCE_CAPABILITY_INVALID",
    ),
  );
  assert.equal(persistence.calls.length, 1);

  await t.test("unavailable remains retained but unsettled", async () => {
    const unavailablePair =
      await productionClassifierPair(
        harness.snapshot,
        { classification: "unavailable" },
      );
    const unavailablePersistence =
      fakeClassifiedPersistence(
        unavailablePair.verifiedAtMs + 1,
      );
    const unavailableStore =
      createSourceRecallClassifiedEvidenceStore({
        persistence:
          unavailablePersistence.persistence,
        sealSecret:
          "classified-evidence-test-seal-secret-0123456789",
      });
    const result =
      await unavailableStore
        .retainSourceRecallClassifiedEvidence(
          await classifiedManifestSeedForStableHarness(
            harness,
          ),
          projectSourceRecallClassifiedManifestEvidenceCapability(
            issueSourceRecallSuccessEvidenceCapability(
              unavailablePair,
            ),
          ),
        );
    assert.equal(result.status, "retained_unsettled_dark");
    assert.equal(result.classification, "unavailable");
    assert.equal(
      result.classificationProofComplete,
      false,
    );
    assert.equal(
      result.referenceManifestCoverageComplete,
      false,
    );
    assertHardDark(result);
  });
});

test("classified retention enforces the trusted transition clock at regression, equality, and expiry and burns both capabilities", async (t) => {
  const harness = await stableHarness();
  const makeInputs = async (clockOffsetMs = 1_000) => {
    const pair = await productionClassifierPair(
      harness.snapshot,
      { clockOffsetMs },
    );
    return {
      pair,
      manifestCapability:
        await classifiedManifestSeedForStableHarness(
          harness,
        ),
      evidenceCapability:
        projectSourceRecallClassifiedManifestEvidenceCapability(
          issueSourceRecallSuccessEvidenceCapability(pair),
        ),
    };
  };
  const transitionDeadline = (input) => Math.min(
    ...input.pair.signedResponses.map(
      (response) => response.receipt.expiresAtMs,
    ),
  );
  const cases = [
    [
      // A Redis clock behind the Redis-derived floor is a genuine clock
      // regression and must still be refused. upstreamIssuedFromRedisAtMs is
      // harness.snapshot.redisNowMs, so this sits one millisecond under the
      // floor without moving the deadline.
      "before the Redis-derived transition floor",
      () => harness.snapshot.redisNowMs - 1,
    ],
    [
      "at deadline",
      transitionDeadline,
    ],
    [
      "after deadline",
      (input) => transitionDeadline(input) + 1,
    ],
  ];
  for (const [name, selectedNow] of cases) {
    await t.test(name, async () => {
      const input = await makeInputs();
      const fake = fakeClassifiedPersistence(
        selectedNow(input),
      );
      const store =
        createSourceRecallClassifiedEvidenceStore({
          persistence: fake.persistence,
          sealSecret:
            "classified-evidence-test-seal-secret-0123456789",
        });
      await assert.rejects(
        store.retainSourceRecallClassifiedEvidence(
          input.manifestCapability,
          input.evidenceCapability,
        ),
        expectClassifiedStoreCode(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_EXPIRED",
        ),
      );
      assert.equal(fake.calls.length, 1);
      await assert.rejects(
        store.retainSourceRecallClassifiedEvidence(
          input.manifestCapability,
          input.evidenceCapability,
        ),
        expectClassifiedStoreCode(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_CAPABILITY_INVALID",
        ),
      );
      assert.equal(fake.calls.length, 1);
    });
  }

  await t.test("immediately before deadline", async () => {
    const input = await makeInputs();
    const fake = fakeClassifiedPersistence(
      transitionDeadline(input) - 1,
    );
    const store = createSourceRecallClassifiedEvidenceStore({
      persistence: fake.persistence,
      sealSecret:
        "classified-evidence-test-seal-secret-0123456789",
    });
    const result =
      await store.retainSourceRecallClassifiedEvidence(
        input.manifestCapability,
        input.evidenceCapability,
      );
    assert.equal(result.status, "retained_terminal_dark");
    assert.equal(
      result.retainedAtRedisMs,
      transitionDeadline(input) - 1,
    );
    assert.equal(
      result.expiresAtMs,
      harness.snapshot.record.expiresAtMs,
    );
  });
});

test("classified retention converges after a lost response and rejects changed evidence, wrong seals, and non-members without another selector", async (t) => {
  const harness = await stableHarness();
  const fake = fakeClassifiedPersistence(
    harness.snapshot.redisNowMs + 10_000,
  );
  const sealSecret =
    "classified-evidence-test-seal-secret-0123456789";
  const store = createSourceRecallClassifiedEvidenceStore({
    persistence: fake.persistence,
    sealSecret,
  });
  const firstPair = await productionClassifierPair(
    harness.snapshot,
    { clockOffsetMs: 1_000 },
  );
  fake.setNow(firstPair.verifiedAtMs + 1);
  fake.setMode("throw_after_store_once");
  await assert.rejects(
    store.retainSourceRecallClassifiedEvidence(
      await classifiedManifestSeedForStableHarness(harness),
      projectSourceRecallClassifiedManifestEvidenceCapability(
        issueSourceRecallSuccessEvidenceCapability(
          firstPair,
        ),
      ),
    ),
    expectClassifiedStoreCode(
      "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_FAILED",
    ),
  );
  assert.equal(fake.values.size, 1);

  const retryPair = await productionClassifierPair(
    harness.snapshot,
    { clockOffsetMs: 2_000 },
  );
  fake.setNow(retryPair.verifiedAtMs + 1);
  const recovered =
    await store.retainSourceRecallClassifiedEvidence(
      await classifiedManifestSeedForStableHarness(harness),
      projectSourceRecallClassifiedManifestEvidenceCapability(
        issueSourceRecallSuccessEvidenceCapability(
          retryPair,
        ),
      ),
    );
  assert.equal(recovered.created, false);
  assert.equal(recovered.status, "retained_terminal_dark");

  await t.test("changed terminal evidence conflicts", async () => {
    const changedPair = await productionClassifierPair(
      harness.snapshot,
      {
        classification: "failure",
        clockOffsetMs: 3_000,
      },
    );
    fake.setNow(changedPair.verifiedAtMs + 1);
    await assert.rejects(
      store.retainSourceRecallClassifiedEvidence(
        await classifiedManifestSeedForStableHarness(
          harness,
        ),
        projectSourceRecallClassifiedManifestEvidenceCapability(
          issueSourceRecallSuccessEvidenceCapability(
            changedPair,
          ),
        ),
      ),
      expectClassifiedStoreCode(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_BINDING_MISMATCH",
      ),
    );
  });

  await t.test("wrong seal key cannot adopt retained bytes", async () => {
    const beforeRaw = [...fake.values.values()][0];
    const pair = await productionClassifierPair(
      harness.snapshot,
      { clockOffsetMs: 4_000 },
    );
    fake.setNow(pair.verifiedAtMs + 1);
    const wrongStore =
      createSourceRecallClassifiedEvidenceStore({
        persistence: fake.persistence,
        sealSecret:
          "different-classified-store-seal-secret-9876543210",
      });
    await assert.rejects(
      wrongStore.retainSourceRecallClassifiedEvidence(
        await classifiedManifestSeedForStableHarness(
          harness,
        ),
        projectSourceRecallClassifiedManifestEvidenceCapability(
          issueSourceRecallSuccessEvidenceCapability(pair),
        ),
      ),
      expectClassifiedStoreCode(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_KEY_MISMATCH",
      ),
    );
    // A rotated key is fail-closed in both directions: the retained record is
    // not adopted, and the wrong secret does not get to overwrite or re-seal
    // the bytes the original secret wrote.
    assert.equal(fake.values.size, 1);
    assert.equal([...fake.values.values()][0], beforeRaw);
  });

  // The seal-key check short-circuits ahead of the HMAC compare, so this case
  // exists to keep the HMAC itself pinned: same secret, so the key id matches
  // and the comparison is actually reached, but the sealed body has been
  // edited. Deleting the seal comparison must fail this test.
  // The tampered field is deliberately one that semanticallySameRecord STRIPS.
  // For every field it compares, a forged value is caught twice over and this
  // test would still pass with the seal deleted. The three stripped instants —
  // the manifest reproof clock, the point-observation read clock, and the local
  // verifier clock — are the only fields where the seal is the sole defence, so
  // they are the only ones that actually pin it. Forging one downward is what a
  // foreign or corrupted durable value would look like.
  await t.test("a stripped observation clock edited under the correct seal key still fails the HMAC", async () => {
    const key = [...fake.values.keys()][0];
    const original = fake.values.get(key);
    const tampered = JSON.parse(original);
    tampered.upstreamIssuedFromRedisAtMs -= 5_000;
    const tamperedRaw = JSON.stringify(tampered);
    assert.notEqual(tamperedRaw, original);
    // Only a value changed, so key order — and therefore canonical form — is
    // untouched. The seal is verified inside canonicalRecord BEFORE parseRecord
    // compares the round trip, so this subtest pins the HMAC unconditionally;
    // the assertion is drift protection for future edits to the fixture.
    assert.deepEqual(
      Object.keys(JSON.parse(tamperedRaw)),
      Object.keys(JSON.parse(original)),
    );
    fake.values.set(key, tamperedRaw);
    try {
      const pair = await productionClassifierPair(
        harness.snapshot,
        { clockOffsetMs: 5_000 },
      );
      fake.setNow(pair.verifiedAtMs + 1);
      await assert.rejects(
        store.retainSourceRecallClassifiedEvidence(
          await classifiedManifestSeedForStableHarness(
            harness,
          ),
          projectSourceRecallClassifiedManifestEvidenceCapability(
            issueSourceRecallSuccessEvidenceCapability(
              pair,
            ),
          ),
        ),
        expectClassifiedStoreCode(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_RECORD_INVALID",
        ),
      );
    } finally {
      // Restore even on failure: later subtests share this fake.
      fake.values.set(key, original);
    }
  });

  // SEAL_KEY_MISMATCH is a triage hint, not evidence of a benign rotation:
  // anyone who can rewrite the record can also choose that code. Pinned so the
  // comment on sealKeyIdDigest cannot drift back into claiming otherwise.
  await t.test("a tamperer can choose the seal-key-mismatch code, and is still refused", async () => {
    const key = [...fake.values.keys()][0];
    const original = fake.values.get(key);
    const tampered = JSON.parse(original);
    tampered.upstreamIssuedFromRedisAtMs -= 5_000;
    tampered.sealKeyId = `${"0".repeat(63)}1`;
    fake.values.set(key, JSON.stringify(tampered));
    try {
      const pair = await productionClassifierPair(
        harness.snapshot,
        { clockOffsetMs: 7_000 },
      );
      fake.setNow(pair.verifiedAtMs + 1);
      await assert.rejects(
        store.retainSourceRecallClassifiedEvidence(
          await classifiedManifestSeedForStableHarness(
            harness,
          ),
          projectSourceRecallClassifiedManifestEvidenceCapability(
            issueSourceRecallSuccessEvidenceCapability(
              pair,
            ),
          ),
        ),
        expectClassifiedStoreCode(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_KEY_MISMATCH",
        ),
      );
    } finally {
      fake.values.set(key, original);
    }
  });

  // A malformed sealKeyId is a malformed record, not a key mismatch. This pins
  // the exactDigest guard that keeps the two apart.
  await t.test("a non-digest seal key id is a malformed record, not a key mismatch", async () => {
    const key = [...fake.values.keys()][0];
    const original = fake.values.get(key);
    const tampered = JSON.parse(original);
    tampered.sealKeyId = "not-a-digest";
    fake.values.set(key, JSON.stringify(tampered));
    try {
      const pair = await productionClassifierPair(
        harness.snapshot,
        { clockOffsetMs: 8_000 },
      );
      fake.setNow(pair.verifiedAtMs + 1);
      await assert.rejects(
        store.retainSourceRecallClassifiedEvidence(
          await classifiedManifestSeedForStableHarness(
            harness,
          ),
          projectSourceRecallClassifiedManifestEvidenceCapability(
            issueSourceRecallSuccessEvidenceCapability(
              pair,
            ),
          ),
        ),
        expectClassifiedStoreCode(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_RECORD_INVALID",
        ),
      );
    } finally {
      fake.values.set(key, original);
    }
  });

  await t.test("a complete but different point proof is not membership", async () => {
    const changedHarness = await stableHarness(
      pointRaw({
        status_changes: [{
          code: "done",
          created_at:
            "2026-07-26T00:58:00.000000000Z",
        }],
      }),
    );
    assert.notEqual(
      changedHarness.snapshot.record.resolutionDigest,
      harness.snapshot.record.resolutionDigest,
    );
    const pair = await productionClassifierPair(
      harness.snapshot,
      { clockOffsetMs: 5_000 },
    );
    const isolated = fakeClassifiedPersistence(
      pair.verifiedAtMs + 1,
    );
    const isolatedStore =
      createSourceRecallClassifiedEvidenceStore({
        persistence: isolated.persistence,
        sealSecret,
      });
    await assert.rejects(
      isolatedStore.retainSourceRecallClassifiedEvidence(
        await classifiedManifestSeedForStableHarness(
          changedHarness,
        ),
        projectSourceRecallClassifiedManifestEvidenceCapability(
          issueSourceRecallSuccessEvidenceCapability(pair),
        ),
      ),
      expectClassifiedStoreCode(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_MEMBERSHIP_MISMATCH",
      ),
    );
    assert.equal(isolated.calls.length, 0);
  });
});

test("the projector emits one deterministic body-free binding for the exact source point and signed pair", async () => {
  const { snapshot } = await stableHarness();
  const firstPair =
    await productionClassifierPair(snapshot, {
      clockOffsetMs: 1_000,
    });
  const secondPair =
    await productionClassifierPair(snapshot, {
      clockOffsetMs: 2_000,
    });
  const first = projectSourceRecallSuccessEvidence(
    issueSourceRecallSuccessEvidenceCapability(firstPair),
  );
  const second = projectSourceRecallSuccessEvidence(
    issueSourceRecallSuccessEvidenceCapability(secondPair),
  );
  const firstHandoffPair =
    await productionClassifierPair(snapshot, {
      clockOffsetMs: 3_000,
    });
  const secondHandoffPair =
    await productionClassifierPair(snapshot, {
      clockOffsetMs: 4_000,
    });
  const firstHandoff =
    consumeSourceRecallClassifiedManifestEvidenceCapability(
      projectSourceRecallClassifiedManifestEvidenceCapability(
        issueSourceRecallSuccessEvidenceCapability(
          firstHandoffPair,
        ),
      ),
    );
  const secondHandoff =
    consumeSourceRecallClassifiedManifestEvidenceCapability(
      projectSourceRecallClassifiedManifestEvidenceCapability(
        issueSourceRecallSuccessEvidenceCapability(
          secondHandoffPair,
        ),
      ),
    );

  assert.equal(
    SOURCE_RECALL_SUCCESS_EVIDENCE_PROJECTOR_VERSION,
    "recall-success-evidence-projector-dark-v1",
  );
  assert.equal(
    SOURCE_RECALL_SUCCESS_EVIDENCE_VERSION,
    "recall-success-evidence-dark-v1",
  );
  assert.deepEqual(Object.keys(first), [
    "version",
    "projectorVersion",
    "status",
    "source",
    "classificationProofComplete",
    "decisionBoundaryAt",
    "decisionBoundaryDigest",
    "workKeyDigest",
    "contractPinsDigest",
    "workItemDigest",
    "resolutionDigest",
    "pointEvidenceDigest",
    "sourceNormalizedInputDigest",
    "sourceRecordDigest",
    "sourceRecordRevisionDigest",
    "sourceReferenceDigest",
    "sourceProvenanceDigest",
    "sourceStatusAtBoundaryDigest",
    "classification",
    "classificationBasis",
    "callsVerdict",
    "callEndedAt",
    "callEndedAtBasis",
    "callEndedAtDigest",
    "classifierCapsuleVersion",
    "classifierArtifactDigest",
    "classifierDeploymentDigest",
    "classifierRuntimeConfigDigest",
    "classifierPolicyDigest",
    "classifierOutputDigest",
    "transcriptEvidenceDigest",
    "presenceEvidenceDigest",
    "vapiEvidenceDigest",
    "mediaEvidenceDigest",
    "vapiAssociationStatus",
    "keyId",
    "requestDigests",
    "responseDigests",
    "receiptDigests",
    "pointProofDigests",
    "pointBindingDigests",
    "pointResponseDigests",
    "classifierInputDigests",
    "pointTransportReceiptDigests",
    "pointCompletedAtMs",
    "classifiedAtMs",
    "classifierVerifiedAtMs",
    "signatureVerifiedAtProjection",
    "standaloneSignatureReverificationAvailable",
    "signedResponseRetentionAvailable",
    "durableAttestationAvailable",
    "operational",
    "globalReferenceSetCoverageAvailable",
    "sourceFactsAvailable",
    "successClassificationAvailable",
    "candidateIdentityResolutionAvailable",
    "q37TransitionAvailable",
    "pinnable",
    "authorityAvailable",
    "curationAvailable",
    "enrollmentAvailable",
    "outreachAvailable",
    "candidateFacingWriteAvailable",
    "classificationEvidenceDigest",
  ]);
  assert.notDeepEqual(
    first.classifierVerifiedAtMs,
    second.classifierVerifiedAtMs,
  );
  const firstSemanticEvidence = clone(first);
  const secondSemanticEvidence = clone(second);
  delete firstSemanticEvidence.classifierVerifiedAtMs;
  delete secondSemanticEvidence.classifierVerifiedAtMs;
  assert.deepEqual(
    firstSemanticEvidence,
    secondSemanticEvidence,
  );
  assert.equal(
    first.classificationEvidenceDigest,
    second.classificationEvidenceDigest,
  );
  assert.equal(
    firstHandoff.evidence.classificationEvidenceDigest,
    secondHandoff.evidence.classificationEvidenceDigest,
  );
  assert.equal(
    firstHandoff.settlementStatus,
    secondHandoff.settlementStatus,
  );
  assert.deepEqual(
    firstHandoff.signedResponses,
    secondHandoff.signedResponses,
  );
  assert.equal(
    firstHandoff.upstreamIssuedFromRedisAtMs,
    secondHandoff.upstreamIssuedFromRedisAtMs,
  );
  assert.equal(
    firstHandoff.upstreamNotAfterMs,
    secondHandoff.upstreamNotAfterMs,
  );
  assert.notDeepEqual(
    firstHandoff.evidence.classifierVerifiedAtMs,
    secondHandoff.evidence.classifierVerifiedAtMs,
  );
  assert.equal(
    first.status,
    "verified_complete_recall_classification_evidence_dark",
  );
  assert.equal(first.source, "recall");
  assert.equal(first.classification, "success");
  assert.equal(first.classificationProofComplete, true);
  assert.equal(first.decisionBoundaryAt, BOUNDARY);
  assert.equal(
    first.workKeyDigest,
    snapshot.record.workKeyDigest,
  );
  assert.equal(
    first.contractPinsDigest,
    snapshot.record.contractPinsDigest,
  );
  assert.equal(
    first.workItemDigest,
    snapshot.record.workItemDigest,
  );
  assert.equal(
    first.resolutionDigest,
    snapshot.record.resolutionDigest,
  );
  const pointEvidence =
    snapshot.record.readOne.evidence;
  for (const field of [
    "decisionBoundaryDigest",
    "sourceNormalizedInputDigest",
    "sourceRecordDigest",
    "sourceRecordRevisionDigest",
    "sourceReferenceDigest",
    "sourceProvenanceDigest",
    "sourceStatusAtBoundaryDigest",
  ]) {
    assert.equal(first[field], pointEvidence[field], field);
  }
  assert.equal(
    first.pointEvidenceDigest,
    semanticDigest(
      SOURCE_RECALL_CLASSIFIER_CAPSULE_POINT_EVIDENCE_DIGEST_DOMAIN,
      pointEvidence,
    ),
  );
  assert.deepEqual(
    first.responseDigests,
    firstPair.responseDigests,
  );
  assert.deepEqual(
    first.receiptDigests,
    firstPair.receiptDigests,
  );
  assert.deepEqual(
    first.pointResponseDigests,
    firstPair.signedResponses.map(
      (response) =>
        response.capsule.pointResponseDigest,
    ),
  );
  assert.deepEqual(
    first.classifierInputDigests,
    firstPair.signedResponses.map(
      (response) =>
        response.capsule.classifierInputDigest,
    ),
  );
  assert.notEqual(
    first.classifierInputDigests[0],
    first.classifierInputDigests[1],
  );
  assert.notEqual(
    first.pointTransportReceiptDigests[0],
    first.pointTransportReceiptDigests[1],
  );
  assert.equal(first.signatureVerifiedAtProjection, true);
  assert.equal(
    first.standaloneSignatureReverificationAvailable,
    false,
  );
  assert.equal(
    first.signedResponseRetentionAvailable,
    false,
  );
  assert.equal(first.durableAttestationAvailable, false);

  const unsigned = clone(first);
  delete unsigned.classificationEvidenceDigest;
  delete unsigned.classifierVerifiedAtMs;
  assert.equal(
    first.classificationEvidenceDigest,
    semanticDigest(
      SOURCE_RECALL_SUCCESS_EVIDENCE_DIGEST_DOMAIN,
      unsigned,
    ),
  );
  const serialized = JSON.stringify(first);
  for (const privateValue of [
    REFERENCE.id,
    REFERENCE.metadataSource,
    REFERENCE.candidate.fullName,
    REFERENCE.candidate.email,
    REFERENCE.candidate.linkedin,
    REFERENCE.candidate.paraformEventId,
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.doesNotMatch(serialized, /https?:\/\//u);
  assert.doesNotMatch(
    serialized,
    /"(?:candidate|contextDigest|email|linkedin|paraformEventId|rawBody|reservationId|signedResponses)"\s*:/u,
  );
  assertHardDark(first);
});

test("failure is complete, unavailable stays incomplete, and a terminal classification without ended-at fails closed", async (t) => {
  const { snapshot } = await stableHarness();

  for (const classification of ["success", "failure"]) {
    await t.test(classification, async () => {
      const pair = await productionClassifierPair(
        snapshot,
        { classification },
      );
      const evidence =
        projectSourceRecallSuccessEvidence(
          issueSourceRecallSuccessEvidenceCapability(
            pair,
          ),
        );
      assert.equal(
        evidence.classification,
        classification,
      );
      assert.equal(
        evidence.classificationProofComplete,
        true,
      );
      assert.equal(
        evidence.status,
        "verified_complete_recall_classification_evidence_dark",
      );
      assert.notEqual(evidence.callEndedAt, null);
      assertHardDark(evidence);
    });
  }

  await t.test("unavailable", async () => {
    const pair = await productionClassifierPair(
      snapshot,
      { classification: "unavailable" },
    );
    const evidence =
      projectSourceRecallSuccessEvidence(
        issueSourceRecallSuccessEvidenceCapability(pair),
      );
    assert.equal(evidence.classification, "unavailable");
    assert.equal(
      evidence.classificationProofComplete,
      false,
    );
    assert.equal(
      evidence.status,
      "verified_unavailable_recall_classification_evidence_dark",
    );
    assertHardDark(evidence);
  });

  for (const classification of ["success", "failure"]) {
    await t.test(
      `${classification} without ended-at`,
      async () => {
        const pair = await productionClassifierPair(
          snapshot,
          {
            classification,
            callEndedAt: null,
          },
        );
        assert.equal(pair.pairStatus, "stable");
        const capability =
          issueSourceRecallSuccessEvidenceCapability(
            pair,
          );
        assert.throws(
          () => projectSourceRecallSuccessEvidence(
            capability,
          ),
          expectProjectorCode(
            "SOURCE_RECALL_SUCCESS_EVIDENCE_ENDED_AT_REQUIRED",
          ),
        );
        assert.throws(
          () =>
            projectSourceRecallClassifiedManifestEvidenceCapability(
              capability,
            ),
          expectProjectorCode(
            "SOURCE_RECALL_SUCCESS_EVIDENCE_CAPABILITY_INVALID",
          ),
        );
      },
    );
  }
});

test("non-stable, stale, and tampered store snapshots fail before client transport", async (t) => {
  const cases = [];

  const awaiting = await preparedHarness();
  cases.push([
    "awaiting read one",
    await awaiting.store.readRecallPointObservationWork(
      awaiting.work,
    ),
  ]);

  const inProgress = await preparedHarness();
  await inProgress.store.claimRecallPointObservationRead(
    inProgress.work,
  );
  cases.push([
    "in progress",
    await inProgress.store.readRecallPointObservationWork(
      inProgress.work,
    ),
  ]);

  const unresolved = await preparedHarness();
  const unresolvedClaim =
    await unresolved.store.claimRecallPointObservationRead(
      unresolved.work,
    );
  unresolved.fake.advance(1_000);
  await unresolved.store
    .recordRecallPointObservationUnresolved(
      unresolvedClaim,
      "point_read_failed",
    );
  cases.push([
    "unresolved",
    await unresolved.store.readRecallPointObservationWork(
      unresolved.work,
    ),
  ]);

  const conflicting = await preparedHarness();
  await checkpointNext(conflicting);
  await checkpointNext(
    conflicting,
    pointRaw({
      status_changes: [
        {
          code: "fatal",
          created_at:
            "2026-07-26T00:59:00.000000000Z",
        },
      ],
    }),
  );
  cases.push([
    "conflict",
    await conflicting.store.readRecallPointObservationWork(
      conflicting.work,
    ),
  ]);

  const stale = await stableHarness();
  stale.fake.setNow(
    stale.snapshot.record.expiresAtMs
      - SOURCE_RECALL_CLASSIFIER_CAPSULE_PAIR_MIN_BUDGET_MS
      + 1,
  );
  cases.push([
    "stale",
    await stale.store.readRecallPointObservationWork(
      stale.work,
    ),
  ]);

  const stable = await stableHarness();
  const rawMismatch = clone(stable.snapshot);
  rawMismatch.record.readTwo.evidence.sourceRecordDigest =
    digest("tampered-source-record");
  cases.push(["raw mismatch", rawMismatch]);

  const durableTamper = clone(stable.snapshot);
  durableTamper.record.readTwo.evidence
    .sourceRecordDigest = digest("tampered-durable-record");
  durableTamper.raw = canonicalJson(durableTamper.record);
  durableTamper.rawSha1 = sha1(durableTamper.raw);
  cases.push(["durable tamper", durableTamper]);

  for (const [name, snapshot] of cases) {
    await t.test(name, () => {
      let clientCalls = 0;
      assert.throws(
        () => {
          const capability =
            issueSourceRecallClassifierCapsuleCapability(
              snapshot,
            );
          void consumeStableRecallClassifierCapsule(
            capability,
            runtimeDependencies(
              snapshot.redisNowMs,
              async () => {
                clientCalls += 1;
              },
            ),
          );
        },
        expectCapabilityCode(
          "SOURCE_RECALL_CLASSIFIER_CAPSULE_STABLE_POINT_REQUIRED",
        ),
      );
      assert.equal(clientCalls, 0);
    });
  }
});

test("an issued capability that becomes stale is consumed without network access", async () => {
  const { snapshot } = await stableHarness();
  const capability =
    issueSourceRecallClassifierCapsuleCapability(snapshot);
  let calls = 0;
  const staleNowMs =
    snapshot.record.expiresAtMs
    - SOURCE_RECALL_CLASSIFIER_CAPSULE_PAIR_MIN_BUDGET_MS
    + 1;
  await assert.rejects(
    consumeStableRecallClassifierCapsule(
      capability,
      runtimeDependencies(staleNowMs, async () => {
        calls += 1;
      }),
    ),
    expectRuntimeCode(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_CAPABILITY_EXPIRED",
    ),
  );
  assert.equal(calls, 0);
});

test("hard-dark client configuration is checked before capability consumption", async (t) => {
  for (const [name, clientConfiguredImpl] of [
    ["false", () => false],
    ["throw", () => {
      throw new Error("private configuration detail");
    }],
  ]) {
    await t.test(name, async () => {
      const { snapshot } = await stableHarness();
      const capability =
        issueSourceRecallClassifierCapsuleCapability(
          snapshot,
        );
      let calls = 0;
      const nowMs = snapshot.redisNowMs + 1;
      await assert.rejects(
        consumeStableRecallClassifierCapsule(
          capability,
          runtimeDependencies(
            nowMs,
            async () => {
              calls += 1;
            },
            { clientConfiguredImpl },
          ),
        ),
        expectRuntimeCode(
          "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_NOT_CONFIGURED",
        ),
      );
      assert.equal(calls, 0);

      let ordinal = 0;
      const result =
        await consumeStableRecallClassifierCapsule(
          capability,
          runtimeDependencies(nowMs, async (request) => {
            calls += 1;
            ordinal += 1;
            return verifiedResult(request, {
              verifiedAtMs: nowMs + ordinal,
            });
          }),
        );
      assert.equal(result.pairStatus, "stable");
      assert.equal(calls, 2);
    });
  }
});

test("the second read needs its own fresh budget and is never attempted when that fence expires", async () => {
  const { snapshot } = await stableHarness();
  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_FINAL_READ_MIN_BUDGET_MS,
    25_000,
  );
  const firstNowMs = snapshot.redisNowMs + 1;
  const finalReadNowMs =
    snapshot.record.expiresAtMs
    - SOURCE_RECALL_CLASSIFIER_CAPSULE_FINAL_READ_MIN_BUDGET_MS
    + 1;
  const times = [firstNowMs, finalReadNowMs];
  const reads = [];
  await assert.rejects(
    consumeStableRecallClassifierCapsule(
      issueSourceRecallClassifierCapsuleCapability(snapshot),
      Object.freeze({
        clientConfiguredImpl: () => true,
        nowImpl: () => times.shift(),
        async readPrivateRecallClassifierCapsuleImpl(request) {
          reads.push(request.pointReadNumber);
          return verifiedResult(request, {
            verifiedAtMs: firstNowMs + 1,
          });
        },
      }),
    ),
    expectRuntimeCode(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_CAPABILITY_EXPIRED",
    ),
  );
  assert.deepEqual(reads, [1]);
});

test("caller selectors, forged snapshots, clocks, and dependency shapes fail closed before transport", async (t) => {
  const { snapshot } = await stableHarness();
  for (const selector of [
    ["botId", "caller-bot"],
    ["candidateId", "caller-candidate"],
    ["cursor", "caller-cursor"],
    ["force", true],
    ["limit", 1],
    ["readNumber", 2],
    ["retry", true],
  ]) {
    await t.test(selector[0], () => {
      const selected = {
        ...snapshot,
        [selector[0]]: selector[1],
      };
      assert.throws(
        () =>
          issueSourceRecallClassifierCapsuleCapability(
            selected,
          ),
        expectCapabilityCode(
          "SOURCE_RECALL_CLASSIFIER_CAPSULE_STABLE_POINT_REQUIRED",
        ),
      );
    });
  }

  let calls = 0;
  for (const capability of [
    {},
    Object.freeze({}),
    Object.freeze({ force: true }),
    null,
  ]) {
    await assert.rejects(
      consumeStableRecallClassifierCapsule(
        capability,
        runtimeDependencies(
          snapshot.redisNowMs + 1,
          async () => {
            calls += 1;
          },
        ),
      ),
      expectRuntimeCode(
        "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_CAPABILITY_INVALID",
      ),
    );
  }
  assert.equal(calls, 0);

  for (const nowMs of [
    0,
    -1,
    1.5,
    Number.NaN,
  ]) {
    await assert.rejects(
      consumeStableRecallClassifierCapsule(
        issueSourceRecallClassifierCapsuleCapability(
          snapshot,
        ),
        runtimeDependencies(nowMs, async () => {
          calls += 1;
        }),
      ),
      expectRuntimeCode(
        "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_CLOCK_INVALID",
      ),
    );
  }
  assert.equal(calls, 0);

  await assert.rejects(
    consumeStableRecallClassifierCapsule(
      issueSourceRecallClassifierCapsuleCapability(snapshot),
      Object.freeze({
        nowImpl: () => snapshot.redisNowMs + 1,
        readPrivateRecallClassifierCapsuleImpl:
          async () => undefined,
        force: true,
      }),
    ),
    expectRuntimeCode(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_TEST_DEPENDENCIES_INVALID",
    ),
  );
  assert.equal(calls, 0);
});

test("every verified-result binding mismatch fails closed on its first occurrence", async (t) => {
  const cases = [
    ["extra key", (value) => {
      value.extra = true;
    }],
    ["verifier version", (value) => {
      value.version = "wrong-verifier-version";
    }],
    ["verified before snapshot", (value) => {
      value.verifiedAtMs = 1;
    }],
    ["verified after expiry", (value) => {
      value.verifiedAtMs = Number.MAX_SAFE_INTEGER;
    }],
    ["signature flag", (value) => {
      value.signatureVerified = false;
    }],
    ["pins flag", (value) => {
      value.pinsVerified = false;
    }],
    ["operational flag", (value) => {
      value.operational = true;
    }],
    ["source facts flag", (value) => {
      value.sourceFactsAvailable = true;
    }],
    ["success flag", (value) => {
      value.successClassificationAvailable = true;
    }],
    ["identity flag", (value) => {
      value.candidateIdentityResolutionAvailable = true;
    }],
    ["pinnable flag", (value) => {
      value.pinnable = true;
    }],
    ["authority flag", (value) => {
      value.authorityAvailable = true;
    }],
    ["key id", (value) => {
      value.keyId = "invalid";
    }],
    ["response digest", (value) => {
      value.responseDigest = "invalid";
    }],
    ["receipt digest", (value) => {
      value.receiptDigest = "invalid";
    }],
    ["request binding", (value) => {
      value.response.requestDigest =
        digest("wrong-request");
    }],
    ["point proof binding", (value) => {
      value.response.capsule.pointProofDigest =
        digest("wrong-proof");
    }],
    ["point response binding", (value) => {
      value.response.capsule.pointBindingDigest =
        digest("wrong-binding");
    }],
    ["response read ordinal", (value) => {
      value.response.readNumber = 2;
    }],
    ["receipt read ordinal", (value) => {
      value.response.receipt.readNumber = 2;
    }],
    ["receipt key id", (value) => {
      value.response.receipt.keyId =
        digest("wrong-receipt-key");
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const { snapshot } = await stableHarness();
      const nowMs = snapshot.redisNowMs + 1;
      let calls = 0;
      await assert.rejects(
        consumeStableRecallClassifierCapsule(
          issueSourceRecallClassifierCapsuleCapability(
            snapshot,
          ),
          runtimeDependencies(nowMs, async (request) => {
            calls += 1;
            const value = clone(verifiedResult(request, {
              verifiedAtMs: nowMs + 1,
            }));
            mutate(value);
            return deepFreeze(value);
          }),
        ),
        expectRuntimeCode(
          "SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_RESULT_INVALID",
        ),
      );
      assert.equal(calls, 1);
    });
  }
});

test("pair-level signed-field or key mismatch is observable conflict, never a classification", async (t) => {
  for (const field of [
    "callEndedAt",
    "callEndedAtBasis",
    "callEndedAtDigest",
    "classifierArtifactDigest",
    "classifierDeploymentDigest",
    "classifierRuntimeConfigDigest",
    "classifierPolicyDigest",
    "transcriptEvidenceDigest",
    "presenceEvidenceDigest",
    "vapiEvidenceDigest",
    "mediaEvidenceDigest",
    "vapiAssociationStatus",
    "callsVerdict",
    "classification",
    "classificationBasis",
    "classifierOutputDigest",
  ]) {
    await t.test(field, async () => {
      const { snapshot } = await stableHarness();
      const nowMs = snapshot.redisNowMs + 1;
      let ordinal = 0;
      const result =
        await consumeStableRecallClassifierCapsule(
          issueSourceRecallClassifierCapsuleCapability(
            snapshot,
          ),
          runtimeDependencies(nowMs, async (request) => {
            ordinal += 1;
            const value = clone(verifiedResult(request, {
              verifiedAtMs: nowMs + ordinal,
            }));
            if (request.pointReadNumber === 2) {
              const replacements = {
                callEndedAt:
                  "2026-07-26T00:58:59.000Z",
                callEndedAtBasis:
                  "join_at_plus_duration",
                vapiAssociationStatus: "exact",
                callsVerdict: "pending",
                classification: "unavailable",
                classificationBasis: "processing",
              };
              value.response.capsule[field] =
                replacements[field]
                ?? digest(`changed-${field}`);
            }
            return deepFreeze(value);
          }),
        );
      assert.equal(result.pairStatus, "conflict");
      assert.equal(
        result.classificationCandidate,
        "unavailable",
      );
      assertHardDark(result);
    });
  }

  await t.test("signing key", async () => {
    const { snapshot } = await stableHarness();
    const nowMs = snapshot.redisNowMs + 1;
    let ordinal = 0;
    const result =
      await consumeStableRecallClassifierCapsule(
        issueSourceRecallClassifierCapsuleCapability(
          snapshot,
        ),
        runtimeDependencies(nowMs, async (request) => {
          ordinal += 1;
          return verifiedResult(request, {
            keyId: request.pointReadNumber === 1
              ? digest("classifier-key-one")
              : digest("classifier-key-two"),
            verifiedAtMs: nowMs + ordinal,
          });
        }),
      );
    assert.equal(result.pairStatus, "conflict");
    assert.equal(result.keyId, digest("classifier-key-one"));
    assert.equal(
      result.classificationCandidate,
      "unavailable",
    );
    assertHardDark(result);
  });

  await t.test("classifier input reuse", async () => {
    const { snapshot } = await stableHarness();
    const nowMs = snapshot.redisNowMs + 1;
    let firstClassifierInputDigest;
    let ordinal = 0;
    const result =
      await consumeStableRecallClassifierCapsule(
        issueSourceRecallClassifierCapsuleCapability(
          snapshot,
        ),
        runtimeDependencies(nowMs, async (request) => {
          ordinal += 1;
          const value = clone(verifiedResult(request, {
            verifiedAtMs: nowMs + ordinal,
          }));
          if (request.pointReadNumber === 1) {
            firstClassifierInputDigest =
              value.response.capsule
                .classifierInputDigest;
          } else {
            value.response.capsule.classifierInputDigest =
              firstClassifierInputDigest;
          }
          return deepFreeze(value);
        }),
      );
    assert.equal(result.pairStatus, "conflict");
    assert.equal(
      result.classificationCandidate,
      "unavailable",
    );
    assertHardDark(result);
  });
});

async function productionFiles(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const child = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      directory,
    );
    if (entry.isDirectory()) {
      files.push(...await productionFiles(child));
    } else if (/\.(?:mjs|js|ts)$/u.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

test("the capability/runtime/projector import closure is hard-dark with no production caller", async () => {
  const libraryRoot = new URL(
    "../api/paraai/_lib/",
    import.meta.url,
  );
  const capabilityUrl = new URL(
    "source-recall-classifier-capsule-capability.mjs",
    libraryRoot,
  );
  const runtimeUrl = new URL(
    "source-recall-classifier-capsule-runtime.mjs",
    libraryRoot,
  );
  const projectorUrl = new URL(
    "source-recall-success-evidence-projector.mjs",
    libraryRoot,
  );
  const [
    capabilitySource,
    runtimeSource,
    projectorSource,
  ] =
    await Promise.all([
      readFile(capabilityUrl, "utf8"),
      readFile(runtimeUrl, "utf8"),
      readFile(projectorUrl, "utf8"),
    ]);

  for (const source of [
    capabilitySource,
    runtimeSource,
    projectorSource,
  ]) {
    assert.doesNotMatch(source, /\bconsole\./u);
    assert.doesNotMatch(source, /\bfetch\s*\(/u);
    assert.doesNotMatch(source, /process\.env/u);
    assert.doesNotMatch(
      source,
      /PARAAI_(?:CURATE_ENABLED|ENROLL_APPROVED|MATCH_STAGE_ENABLED)/u,
    );
    assert.doesNotMatch(
      source,
      /source-(?:capture-coordinator|authority-store)/u,
    );
    assert.doesNotMatch(source, /phase4-curation/u);
  }
  assert.deepEqual(
    [...capabilitySource.matchAll(
      /from "\.\/([^"]+)"/gu,
    )].map((match) => match[1]).sort(),
    [
      "source-recall-classifier-capsule-client.mjs",
      "source-recall-classifier-capsule-protocol.mjs",
      "source-recall-point-observation-store.mjs",
    ],
  );
  assert.deepEqual(
    [...runtimeSource.matchAll(
      /from "\.\/([^"]+)"/gu,
    )].map((match) => match[1]).sort(),
    [
      "source-recall-classifier-capsule-capability.mjs",
      "source-recall-classifier-capsule-client.mjs",
      "source-recall-classifier-capsule-verifier.mjs",
    ],
  );
  assert.deepEqual(
    [...projectorSource.matchAll(
      /from "\.\/([^"]+)"/gu,
    )].map((match) => match[1]).sort(),
    [
      "source-recall-classifier-capsule-runtime.mjs",
    ],
  );

  const files = await productionFiles(
    new URL("../api/paraai/", import.meta.url),
  );
  const runtimeImporters = [];
  const projectorImporters = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (
      file.href !== runtimeUrl.href
      &&
      source.includes(
        "source-recall-classifier-capsule-runtime",
      )
    ) {
      runtimeImporters.push(file.pathname);
    }
    if (
      file.href !== projectorUrl.href
      && source.includes(
        "source-recall-success-evidence-projector",
      )
    ) {
      projectorImporters.push(file.pathname);
    }
  }
  assert.deepEqual(runtimeImporters, [
    projectorUrl.pathname,
  ]);
  assert.deepEqual(projectorImporters, [
    new URL(
      "source-recall-classified-evidence-store.mjs",
      libraryRoot,
    ).pathname,
  ]);
});

test("classified retention converges from a fresh invocation whose upstream read clock has advanced", async (t) => {
  const harness = await stableHarness();
  const fake = fakeClassifiedPersistence(
    harness.snapshot.redisNowMs + 10_000,
  );
  const sealSecret =
    "classified-evidence-test-seal-secret-0123456789";
  const store = createSourceRecallClassifiedEvidenceStore({
    persistence: fake.persistence,
    sealSecret,
  });
  const firstPair = await productionClassifierPair(
    harness.snapshot,
    { clockOffsetMs: 1_000 },
  );
  fake.setNow(firstPair.verifiedAtMs + 1);
  fake.setMode("throw_after_store_once");
  await assert.rejects(
    store.retainSourceRecallClassifiedEvidence(
      await classifiedManifestSeedForStableHarness(harness),
      projectSourceRecallClassifiedManifestEvidenceCapability(
        issueSourceRecallSuccessEvidenceCapability(
          firstPair,
        ),
      ),
    ),
    expectClassifiedStoreCode(
      "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_FAILED",
    ),
  );
  assert.equal(fake.values.size, 1);

  // The retrying invocation cannot reuse the original in-memory snapshot: the
  // process that held it is gone. It re-reads the point observation, which
  // necessarily yields a later Redis read clock. That clock is an observation
  // instant, not evidence, so convergence must still succeed.
  harness.fake.setNow(harness.snapshot.redisNowMs + 4_000);
  const refreshed =
    await harness.store.readRecallPointObservationWork(
      harness.work,
    );
  assert.equal(refreshed.record.status, "stable");
  assert.ok(
    refreshed.redisNowMs > harness.snapshot.redisNowMs,
  );
  const retryPair = await productionClassifierPair(
    refreshed,
    { clockOffsetMs: 1_000 },
  );
  fake.setNow(retryPair.verifiedAtMs + 1);
  const recovered =
    await store.retainSourceRecallClassifiedEvidence(
      await classifiedManifestSeedForStableHarness({
        ...harness,
        snapshot: refreshed,
      }),
      projectSourceRecallClassifiedManifestEvidenceCapability(
        issueSourceRecallSuccessEvidenceCapability(
          retryPair,
        ),
      ),
    );
  assert.equal(recovered.created, false);
  assert.equal(recovered.status, "retained_terminal_dark");
  assert.equal(recovered.classification, "success");
  // Convergence adopts the originally stored bytes; it never rewrites or
  // renews them.
  assert.equal(fake.values.size, 1);
  const durable = JSON.parse(
    [...fake.values.values()][0],
  );
  assert.equal(
    durable.upstreamIssuedFromRedisAtMs,
    harness.snapshot.redisNowMs,
  );

  await t.test("a different stable point still conflicts", async () => {
    const otherHarness = await stableHarness(
      pointRaw({
        status_changes: [{
          code: "done",
          created_at:
            "2026-07-26T00:58:00.000000000Z",
        }],
      }),
    );
    const otherPair = await productionClassifierPair(
      otherHarness.snapshot,
      { clockOffsetMs: 1_000 },
    );
    fake.setNow(otherPair.verifiedAtMs + 1);
    await assert.rejects(
      store.retainSourceRecallClassifiedEvidence(
        await classifiedManifestSeedForStableHarness(
          otherHarness,
        ),
        projectSourceRecallClassifiedManifestEvidenceCapability(
          issueSourceRecallSuccessEvidenceCapability(
            otherPair,
          ),
        ),
      ),
      expectClassifiedStoreCode(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_BINDING_MISMATCH",
      ),
    );
    assert.equal(fake.values.size, 1);
  });
});

test("a fast local verifier clock cannot expire an in-window classified retention", async () => {
  const harness = await stableHarness();
  // The verifying host's wall clock runs 4s ahead of the POINT-OBSERVATION
  // Redis, the ordinary NTP-skew case. The classified store's own Redis is set
  // one millisecond behind the local clock just below. Only Redis-derived instants may gate the
  // transition, so this must retain rather than burn both capabilities.
  const pair = await productionClassifierPair(
    harness.snapshot,
    { clockOffsetMs: 4_000 },
  );
  // Redis is one millisecond behind the latest local verify instant: exactly
  // the case a previous revision rejected as expired.
  const redisNowMs = pair.verifiedAtMs - 1;
  assert.ok(redisNowMs > harness.snapshot.redisNowMs);
  const fake = fakeClassifiedPersistence(redisNowMs);
  const store = createSourceRecallClassifiedEvidenceStore({
    persistence: fake.persistence,
    sealSecret:
      "classified-evidence-test-seal-secret-0123456789",
  });
  const retained =
    await store.retainSourceRecallClassifiedEvidence(
      await classifiedManifestSeedForStableHarness(harness),
      projectSourceRecallClassifiedManifestEvidenceCapability(
        issueSourceRecallSuccessEvidenceCapability(pair),
      ),
    );
  assert.equal(retained.created, true);
  assert.equal(retained.status, "retained_terminal_dark");
  assert.ok(
    Math.max(
      ...JSON.parse([...fake.values.values()][0])
        .evidence.classifierVerifiedAtMs,
    ) > retained.retainedAtRedisMs,
  );
  assertHardDark(retained);
});

// The classified store keeps its own floor comparisons against the instant the
// persistence layer reports, rather than trusting the adapter to have enforced
// them. The two floors are the point-observation read clock and the manifest
// reproof clock, which come from a DIFFERENT Redis deployment than this store's,
// so they can genuinely diverge in production. Every default fixture collapses
// them onto the same millisecond, which would let either comparison mask the
// other; advancing the manifest clock separates them so the manifest floor is
// driven on its own.
test("the store refuses a persistence layer that reports a Redis clock below either floor", async (t) => {
  const harness = await stableHarness();
  const upstreamFloorMs = harness.snapshot.redisNowMs;
  const manifestFloorMs = upstreamFloorMs + 3_000;
  harness.fake.setNow(manifestFloorMs);
  const fake = fakeClassifiedPersistence(upstreamFloorMs);
  let reportedRedisNowMs = upstreamFloorMs;
  const lying = Object.freeze({
    async retain(input) {
      const result = await fake.persistence.retain(input);
      return {
        ...result,
        redisNowMs: reportedRedisNowMs,
      };
    },
  });
  const store = createSourceRecallClassifiedEvidenceStore({
    persistence: lying,
    sealSecret:
      "classified-evidence-test-seal-secret-0123456789",
  });
  const attempt = async (reportedMs) => {
    const pair = await productionClassifierPair(
      harness.snapshot,
      { clockOffsetMs: 6_000 },
    );
    fake.setNow(pair.verifiedAtMs + 1);
    reportedRedisNowMs = reportedMs;
    return store.retainSourceRecallClassifiedEvidence(
      await classifiedManifestSeedForStableHarness(harness),
      projectSourceRecallClassifiedManifestEvidenceCapability(
        issueSourceRecallSuccessEvidenceCapability(pair),
      ),
    );
  };

  // The transition itself is allowed to succeed — the Lua writes the record —
  // and the store then refuses to trust the instant it was told. So these
  // cases assert the refusal, not the absence of a write.
  // Below BOTH floors, so either comparison refuses it. The point-observation
  // floor is driven on its own by the companion test further down.
  await t.test("below both floors is refused", async () => {
    await assert.rejects(
      attempt(upstreamFloorMs - 1),
      expectClassifiedStoreCode(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_EXPIRED",
      ),
    );
  });

  // Above the read floor but below the manifest floor: only the manifest
  // comparison can refuse this, so it is driven independently of the other.
  await t.test("below the manifest reproof floor alone", async () => {
    await assert.rejects(
      attempt(manifestFloorMs - 1),
      expectClassifiedStoreCode(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_EXPIRED",
      ),
    );
  });

  // Exactly at the higher floor. The comparisons are strict `<`, so this is
  // the first accepted instant; it pins the boundary against drifting to `<=`.
  // A record already exists from the refused attempts above, so this converges
  // onto it rather than creating one — which is itself the correct outcome.
  await t.test("exactly at the higher floor is accepted", async () => {
    const retained = await attempt(manifestFloorMs);
    assert.equal(retained.status, "retained_terminal_dark");
    assert.equal(retained.created, false);
    assert.equal(retained.retainedAtRedisMs, manifestFloorMs);
    assert.equal(fake.values.size, 1);
    // Manifest clock is the higher of the two here, so the transition floor
    // must be it. Collapsing the composition to the read clock alone would
    // show up as upstreamFloorMs.
    assert.equal(
      fake.calls.at(-1).issuedAtMs,
      manifestFloorMs,
    );
    assertHardDark(retained);
  });
});

// Companion to the test above, with the two floors in the opposite order. The
// manifest seed is minted first and the point observation is re-read after, so
// the read clock ends up ABOVE the manifest clock and the point-observation
// comparison becomes the binding one. In production the two clocks come from
// different Redis deployments and either ordering is possible, so both
// comparisons have to be driven on their own.
test("the store refuses a reported clock below the point-observation floor when it is the higher of the two", async () => {
  const harness = await stableHarness();
  const manifestFloorMs = harness.snapshot.redisNowMs;
  harness.fake.setNow(manifestFloorMs);
  const seed =
    await classifiedManifestSeedForStableHarness(harness);
  const upstreamFloorMs = manifestFloorMs + 3_000;
  harness.fake.setNow(upstreamFloorMs);
  const refreshed =
    await harness.store.readRecallPointObservationWork(
      harness.work,
    );
  assert.equal(refreshed.redisNowMs, upstreamFloorMs);
  const pair = await productionClassifierPair(refreshed, {
    clockOffsetMs: 6_000,
  });
  const fake = fakeClassifiedPersistence(
    pair.verifiedAtMs + 1,
  );
  // Between the manifest floor and the read floor: only the
  // point-observation comparison can refuse this.
  let reportedRedisNowMs = upstreamFloorMs - 1;
  const lying = Object.freeze({
    async retain(input) {
      const result = await fake.persistence.retain(input);
      return {
        ...result,
        redisNowMs: reportedRedisNowMs,
      };
    },
  });
  const store = createSourceRecallClassifiedEvidenceStore({
    persistence: lying,
    sealSecret:
      "classified-evidence-test-seal-secret-0123456789",
  });
  await assert.rejects(
    store.retainSourceRecallClassifiedEvidence(
      seed,
      projectSourceRecallClassifiedManifestEvidenceCapability(
        issueSourceRecallSuccessEvidenceCapability(pair),
      ),
    ),
    expectClassifiedStoreCode(
      "SOURCE_RECALL_CLASSIFIED_EVIDENCE_EXPIRED",
    ),
  );
  // With the read clock the higher of the two, the transition floor must be
  // that clock. If the composition collapsed to the manifest clock alone this
  // would be manifestFloorMs instead.
  assert.equal(
    fake.calls.at(-1).issuedAtMs,
    upstreamFloorMs,
  );

  // Exactly at the read floor is the first accepted instant: the comparison is
  // a strict `<`, and drifting it to `<=` would refuse a retention whose
  // classified-Redis instant lands on the read clock — the common case when
  // the two deployments are in step.
  reportedRedisNowMs = upstreamFloorMs;
  const boundaryPair = await productionClassifierPair(
    refreshed,
    { clockOffsetMs: 6_000 },
  );
  fake.setNow(boundaryPair.verifiedAtMs + 1);
  const retained =
    await store.retainSourceRecallClassifiedEvidence(
      await classifiedManifestSeedForStableHarness({
        ...harness,
        snapshot: refreshed,
      }),
      projectSourceRecallClassifiedManifestEvidenceCapability(
        issueSourceRecallSuccessEvidenceCapability(
          boundaryPair,
        ),
      ),
    );
  assert.equal(retained.status, "retained_terminal_dark");
  assert.equal(retained.retainedAtRedisMs, upstreamFloorMs);
  assertHardDark(retained);
});

// parseRecord re-checks the RETAINED record's two observation floors against
// the instant the persistence layer reports. That is a different question from
// the proposal-side floors above: a slow invocation can legitimately arrive
// with floors below those of the record it converges onto, having lost a race
// to a faster invocation whose upstream reads were newer. What must never
// happen is adopting a record observed later than the instant this store
// linearized against. Each ordering isolates one of the two comparisons.
const retainedFloorHarness = async (
  manifestOffsetMs,
  upstreamOffsetMs,
) => {
  const harness = await stableHarness();
  const baseMs = harness.snapshot.redisNowMs;
  // Minted first and held: the losing invocation's capabilities, floors at +0.
  const earlySeed =
    await classifiedManifestSeedForStableHarness(harness);
  const earlyPair = await productionClassifierPair(
    harness.snapshot,
    { clockOffsetMs: 500 },
  );
  const mintLate = async () => {
    harness.fake.setNow(baseMs + manifestOffsetMs);
    const lateSeed =
      await classifiedManifestSeedForStableHarness(harness);
    harness.fake.setNow(baseMs + upstreamOffsetMs);
    const refreshed =
      await harness.store.readRecallPointObservationWork(
        harness.work,
      );
    const latePair = await productionClassifierPair(
      refreshed,
      { clockOffsetMs: 500 },
    );
    return { lateSeed, latePair };
  };
  return { harness, baseMs, earlySeed, earlyPair, mintLate };
};

for (
  const [name, manifestOffsetMs, upstreamOffsetMs] of [
    [
      "point-observation read floor",
      3_000,
      6_000,
    ],
    [
      "manifest reproof floor",
      6_000,
      3_000,
    ],
  ]
) {
  test(`a retained record observed after the reported instant is refused by its ${name}`, async () => {
    const ctx = await retainedFloorHarness(
      manifestOffsetMs,
      upstreamOffsetMs,
    );
    const { lateSeed, latePair } = await ctx.mintLate();
    // Above both retained floors, so the creating transition is accepted on
    // its own merits and only the converging read is under test.
    const highMs = ctx.baseMs
      + Math.max(manifestOffsetMs, upstreamOffsetMs)
      + 1_000;
    const fake = fakeClassifiedPersistence(highMs);
    let reportedRedisNowMs = highMs;
    const reporting = Object.freeze({
      async retain(input) {
        const result = await fake.persistence.retain(input);
        return {
          ...result,
          redisNowMs: reportedRedisNowMs,
        };
      },
    });
    const store =
      createSourceRecallClassifiedEvidenceStore({
        persistence: reporting,
        sealSecret:
          "classified-evidence-test-seal-secret-0123456789",
      });
    const created =
      await store.retainSourceRecallClassifiedEvidence(
        lateSeed,
        projectSourceRecallClassifiedManifestEvidenceCapability(
          issueSourceRecallSuccessEvidenceCapability(
            latePair,
          ),
        ),
      );
    assert.equal(created.created, true);
    const durable = JSON.parse(
      [...fake.values.values()][0],
    );
    assert.equal(
      durable.manifestIssuedFromRedisAtMs,
      ctx.baseMs + manifestOffsetMs,
    );
    assert.equal(
      durable.upstreamIssuedFromRedisAtMs,
      ctx.baseMs + upstreamOffsetMs,
    );

    // The losing invocation now converges, while the persistence layer reports
    // an instant BETWEEN the retained record's two floors. Only the higher
    // floor can refuse it, so exactly one comparison is exercised.
    reportedRedisNowMs = ctx.baseMs + 4_500;
    await assert.rejects(
      store.retainSourceRecallClassifiedEvidence(
        ctx.earlySeed,
        projectSourceRecallClassifiedManifestEvidenceCapability(
          issueSourceRecallSuccessEvidenceCapability(
            ctx.earlyPair,
          ),
        ),
      ),
      expectClassifiedStoreCode(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_RECORD_INVALID",
      ),
    );
  });
}
