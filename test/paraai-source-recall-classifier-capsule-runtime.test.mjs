import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
} from "../api/paraai/_lib/source-recall-classifier-capsule-client.mjs";
import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_VERSION,
  SOURCE_RECALL_CLASSIFIER_POINT_PROOF_VERSION,
  prepareSourceRecallClassifierCapsuleRequest,
} from "../api/paraai/_lib/source-recall-classifier-capsule-protocol.mjs";
import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_RUNTIME_VERSION,
  SourceRecallClassifierCapsuleRuntimeError,
  consumeStableRecallClassifierCapsule,
} from "../api/paraai/_lib/source-recall-classifier-capsule-runtime.mjs";
import {
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

function verifiedPage(nowMs) {
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
    recallReferenceHeadRecordDigest: digest("head-record"),
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
    advance(deltaMs) {
      nowMs += deltaMs;
    },
    setNow(nextNowMs) {
      nowMs = nextNowMs;
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

async function stableHarness() {
  const harness = await preparedHarness();
  await checkpointNext(harness);
  await checkpointNext(harness);
  const snapshot =
    await harness.store.readRecallPointObservationWork(
      harness.work,
    );
  assert.equal(snapshot.record.status, "stable");
  return { ...harness, snapshot };
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

test("the capability/runtime import closure is hard-dark with zero production importers", async () => {
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
  const [capabilitySource, runtimeSource] =
    await Promise.all([
      readFile(capabilityUrl, "utf8"),
      readFile(runtimeUrl, "utf8"),
    ]);

  for (const source of [capabilitySource, runtimeSource]) {
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

  const files = await productionFiles(
    new URL("../api/paraai/", import.meta.url),
  );
  const runtimeImporters = [];
  for (const file of files) {
    if (file.href === runtimeUrl.href) continue;
    const source = await readFile(file, "utf8");
    if (
      source.includes(
        "source-recall-classifier-capsule-runtime",
      )
    ) {
      runtimeImporters.push(file.pathname);
    }
  }
  assert.deepEqual(runtimeImporters, []);
});
