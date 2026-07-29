import assert from "node:assert/strict";
import {
  createPrivateKey,
  createPublicKey,
  createHash,
  createHmac,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  readdir,
  readFile,
} from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_AUTH_DOMAIN,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_ORIGIN,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_PATH,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_SECRET_ENV,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_TIMEOUT_MS,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_URL,
  SourceRecallClassifierCapsuleClientError,
  readPrivateRecallClassifierCapsule,
  sourceRecallClassifierCapsuleClientConfigured,
} from "../api/paraai/_lib/source-recall-classifier-capsule-client.mjs";
import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_BODY_BYTES,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_RESPONSE_BYTES,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_PROTOCOL_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_TTL_MS,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_SIGNATURE_DOMAIN,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_VERSION,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_VERSION,
  SOURCE_RECALL_CLASSIFIER_POINT_PROOF_VERSION,
  SourceRecallClassifierCapsuleProtocolError,
  parseSourceRecallClassifierCapsuleResponse,
  prepareSourceRecallClassifierCapsuleRequest,
  sourceRecallClassifierCapsuleContextDigest,
  sourceRecallClassifierCapsuleDigest,
  sourceRecallClassifierCapsuleReceiptDigest,
  sourceRecallClassifierCapsuleReceiptSignatureBase,
  sourceRecallClassifierCapsuleReservationId,
  sourceRecallClassifierCapsuleResponseDigest,
  sourceRecallClassifierEndedAtDigest,
  sourceRecallClassifierOutputDigest,
} from "../api/paraai/_lib/source-recall-classifier-capsule-protocol.mjs";
import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_KEY_ID_DOMAIN,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_CLOCK_SKEW_MS,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_ENVS,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_PUBLIC_KEY_ENV,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_VERIFIER_VERSION,
  SourceRecallClassifierCapsuleVerifierError,
  createSourceRecallClassifierCapsuleVerifier,
  sourceRecallClassifierCapsuleVerifierConfigured,
} from "../api/paraai/_lib/source-recall-classifier-capsule-verifier.mjs";

const NOW_MS = Date.parse("2026-07-27T03:00:00.000Z");
const BOUNDARY = "2026-07-27T02:00:00.000Z";
const ENDED_AT = "2026-07-27T01:58:00.000Z";
const POINT_COMPLETED_AT_MS =
  Date.parse(BOUNDARY) + 2_000;
const CLASSIFIED_AT_MS = POINT_COMPLETED_AT_MS + 1_000;
const ISSUED_AT_MS = CLASSIFIED_AT_MS + 1_000;
const EXPIRES_AT_MS = NOW_MS + 60 * 60 * 1_000;
const SECRET =
  "classifier-capsule-client-test-secret-0123456789";
const PRIVATE_MARKER =
  "private-classifier-capsule-response-marker";
const SIGNAL = Object.freeze({ synthetic: "signal" });
const DIGEST = (character) => character.repeat(64);
// RFC 8032 test vector 1. Keeping the producer key deterministic turns the
// complete signed Calls response into a stable cross-repository golden.
const ED25519_SEED_HEX =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const ED25519_PUBLIC_HEX =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const KEY_PAIR = Object.freeze({
  privateKey: createPrivateKey({
    key: Buffer.from(
      `302e020100300506032b657004220420${ED25519_SEED_HEX}`,
      "hex",
    ),
    format: "der",
    type: "pkcs8",
  }),
  publicKey: createPublicKey({
    key: Buffer.from(
      `302a300506032b6570032100${ED25519_PUBLIC_HEX}`,
      "hex",
    ),
    format: "der",
    type: "spki",
  }),
});
const PUBLIC_KEY_BASE64 = KEY_PAIR.publicKey.export({
  format: "der",
  type: "spki",
}).toString("base64");
const KEY_ID = createHash("sha256")
  .update(
    `${SOURCE_RECALL_CLASSIFIER_CAPSULE_KEY_ID_DOMAIN}\0`,
    "utf8",
  )
  .update(Buffer.from(PUBLIC_KEY_BASE64, "base64"))
  .digest("hex");
const PINS = Object.freeze({
  classifierArtifactDigest: DIGEST("1"),
  classifierDeploymentDigest: DIGEST("2"),
  classifierRuntimeConfigDigest: DIGEST("3"),
  classifierPolicyDigest: DIGEST("4"),
});
const VERIFIER_CONFIGURATION = Object.freeze({
  publicKeySpkiBase64: PUBLIC_KEY_BASE64,
  ...PINS,
});
// Generated independently by the deployed Calls producer protocol using the
// fixed RFC 8032 key and the fixture below.
const CALLS_GOLDEN = Object.freeze({
  publicKeySpkiBase64:
    "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
  keyId:
    "d42959dcf733b92ddca2e8cef93d443461a56f263499c629f7a9d0e5375e8734",
  requestDigest:
    "767abc4bc9f45591d624c38886417efd7dc0d81547f7eb88c87f08b945a0ccb1",
  pointBindingDigest:
    "2c9708c994706e67e318c2ef840a318179f2bd61aa034823244ef67e341203b9",
  pointProofDigest:
    "34b828d46fff905573eaea676aa398d7cb8a42f1dbe5825fc8f85a38569905c3",
  contextDigest:
    "6ec34a64fbaba654291a9ac741461221b9ec8b147f816896e469071b18a5db3a",
  reservationId:
    "e76925cf3b39108c0f94fbc2c539c1d85b0fecdc022040948097b0023b97cbae",
  callEndedAtDigest:
    "11257686a47d13c36fdeea6f6c6393fe62b064e9d9848b243044135e63674182",
  classifierOutputDigest:
    "38b89003922ac093c5184f0f84c5d1b2c218fd08634171cc4d2e518246cd0e3f",
  capsuleDigest:
    "d11fdb3fa887a56838bfdec5c1284c53b53403f80b468a47eb0df0369301cf8d",
  signature:
    "KafjBOK8WdT-2XlDM805vgPKoMbfb93smTWekKLjXs8tkIag7fioTMLFKLqLsrgfRfWy61g9LdZtICG0swPzDg",
  responseDigest:
    "4c69781748c272e71ddf89c2253b6a19972a2b33218c2aed1105869a828350c8",
  receiptDigest:
    "73a9d127df83b68409b6ca6b18eedfb987f9677cc5e39e2dc8841d40fb003f06",
  responseBodyLength: 2_749,
});

function hash(domain, body) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(body, "utf8")
    .digest("hex");
}

function pointProof(overrides = {}) {
  return Object.freeze({
    version:
      SOURCE_RECALL_CLASSIFIER_POINT_PROOF_VERSION,
    observationStatus: "stable",
    workKeyDigest: DIGEST("5"),
    contractPinsDigest: DIGEST("6"),
    workItemDigest: DIGEST("7"),
    resolutionDigest: DIGEST("8"),
    pointCompletedAtMs: POINT_COMPLETED_AT_MS,
    pointTransportReceiptDigest: DIGEST("9"),
    pointEvidenceDigest: DIGEST("a"),
    sourceNormalizedInputDigest: DIGEST("b"),
    sourceRecordDigest: DIGEST("c"),
    sourceRecordRevisionDigest: DIGEST("d"),
    sourceReferenceDigest: DIGEST("e"),
    sourceProvenanceDigest: DIGEST("f"),
    sourceStatusAtBoundaryDigest: DIGEST("0"),
    decisionBoundaryDigest: DIGEST("1"),
    ...overrides,
  });
}

function requestValue(overrides = {}) {
  return Object.freeze({
    version:
      SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_VERSION,
    pointReservationId: DIGEST("2"),
    pointContextDigest: DIGEST("3"),
    pointReadNumber: 2,
    pointRequestDigest: DIGEST("4"),
    decisionBoundaryAt: BOUNDARY,
    pointProof: pointProof(),
    ...overrides,
  });
}

function signedFixture({
  requestInput = requestValue(),
  output = {
    vapiAssociationStatus: "not_used",
    callsVerdict: "success",
    classification: "success",
    classificationBasis: "transcript_two_way",
  },
  capsuleOverrides = {},
  receiptOverrides = {},
  privateKey = KEY_PAIR.privateKey,
} = {}) {
  const request =
    prepareSourceRecallClassifierCapsuleRequest(
      requestInput,
    );
  const capsule = {
    version: SOURCE_RECALL_CLASSIFIER_CAPSULE_VERSION,
    source: "recall",
    pointBindingDigest: request.pointBindingDigest,
    pointProofDigest: request.pointProofDigest,
    pointResponseDigest: DIGEST("5"),
    decisionBoundaryDigest:
      request.pointProof.decisionBoundaryDigest,
    callEndedAt: ENDED_AT,
    callEndedAtBasis: "recording_completed_at",
    callEndedAtDigest:
      sourceRecallClassifierEndedAtDigest({
        sourceRecordDigest:
          request.pointProof.sourceRecordDigest,
        callEndedAt: ENDED_AT,
        callEndedAtBasis: "recording_completed_at",
      }),
    ...PINS,
    classifierInputDigest: DIGEST("6"),
    transcriptEvidenceDigest: DIGEST("7"),
    presenceEvidenceDigest: DIGEST("8"),
    vapiEvidenceDigest: DIGEST("9"),
    mediaEvidenceDigest: DIGEST("a"),
    ...output,
    classifierOutputDigest:
      sourceRecallClassifierOutputDigest(output),
    classifiedAtMs: CLASSIFIED_AT_MS,
    ...capsuleOverrides,
  };
  const contextDigest =
    sourceRecallClassifierCapsuleContextDigest(
      request,
      PINS,
    );
  const reservationId =
    sourceRecallClassifierCapsuleReservationId(
      request,
      contextDigest,
    );
  const unsignedReceipt = {
    version:
      SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_VERSION,
    keyId: KEY_ID,
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
    issuedAtMs: ISSUED_AT_MS,
    expiresAtMs: EXPIRES_AT_MS,
    ...receiptOverrides,
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
      privateKey,
    ).toString("base64url"),
  };
  const response = {
    version:
      SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_VERSION,
    reservationId,
    contextDigest,
    readNumber: request.pointReadNumber,
    requestDigest: request.requestDigest,
    capsule,
    receipt,
  };
  return {
    request,
    requestInput,
    response,
    responseBody: JSON.stringify(response),
  };
}

function responseHeaders(overrides = {}) {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...overrides,
  };
}

function responseFor(body, {
  status = 200,
  headers = {},
} = {}) {
  return new Response(body, {
    status,
    headers: responseHeaders(headers),
  });
}

function dependencies(fetchImpl, overrides = {}) {
  const times = [NOW_MS, NOW_MS + 1];
  return {
    fetchImpl,
    nowImpl: () => times.shift() ?? NOW_MS + 1,
    secret: SECRET,
    signalFactory: (timeoutMs) => {
      assert.equal(
        timeoutMs,
        SOURCE_RECALL_CLASSIFIER_CAPSULE_TIMEOUT_MS,
      );
      return SIGNAL;
    },
    verifierConfiguration: VERIFIER_CONFIGURATION,
    ...overrides,
  };
}

function expectClientCode(code) {
  return (error) => {
    assert.equal(
      error instanceof SourceRecallClassifierCapsuleClientError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

function expectVerifierCode(code) {
  return (error) => {
    assert.equal(
      error instanceof SourceRecallClassifierCapsuleVerifierError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

function expectProtocolCode(code) {
  return (error) => {
    assert.equal(
      error instanceof SourceRecallClassifierCapsuleProtocolError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

function expectProtocolFailure(error) {
  assert.equal(
    error instanceof SourceRecallClassifierCapsuleProtocolError,
    true,
  );
  assert.match(
    error.code,
    /^SOURCE_RECALL_CLASSIFIER_CAPSULE_/u,
  );
  assert.equal(error.message, error.code);
  return true;
}

function flippedCanonicalSignature(value) {
  const bytes = Buffer.from(value, "base64url");
  bytes[0] ^= 0x01;
  return bytes.toString("base64url");
}

function mutateSignedFixture({
  fixture = signedFixture(),
  mutateCapsule,
  mutateReceipt,
  mutateResponse,
  resign = true,
} = {}) {
  const response = JSON.parse(fixture.responseBody);
  mutateCapsule?.(response.capsule);
  mutateReceipt?.(response.receipt);
  mutateResponse?.(response);
  if (resign) {
    const { signature: _signature, ...unsigned } =
      response.receipt;
    response.receipt.signature = sign(
      null,
      Buffer.from(
        sourceRecallClassifierCapsuleReceiptSignatureBase(
          unsigned,
        ),
        "utf8",
      ),
      KEY_PAIR.privateKey,
    ).toString("base64url");
  }
  return JSON.stringify(response);
}

test("request bytes and all three initial bindings match the deployed v2 domains", () => {
  const value = requestValue();
  const request =
    prepareSourceRecallClassifierCapsuleRequest(value);
  const rawBody = JSON.stringify(value);
  const expectedRequestDigest = hash(
    "paraai-recall-classifier-capsule-request-bytes-v1",
    rawBody,
  );
  const expectedPointBindingDigest = hash(
    "paraai-recall-classifier-point-binding-v1",
    JSON.stringify({
      pointReservationId: value.pointReservationId,
      pointContextDigest: value.pointContextDigest,
      pointReadNumber: value.pointReadNumber,
      pointRequestDigest: value.pointRequestDigest,
    }),
  );
  const expectedPointProofDigest = hash(
    "paraai-recall-classifier-point-proof-v1",
    JSON.stringify(value.pointProof),
  );

  assert.equal(request.rawBody, rawBody);
  assert.equal(request.requestDigest, expectedRequestDigest);
  assert.equal(
    request.pointBindingDigest,
    expectedPointBindingDigest,
  );
  assert.equal(
    request.pointProofDigest,
    expectedPointProofDigest,
  );
  assert.deepEqual(Object.keys(JSON.parse(rawBody)), [
    "version",
    "pointReservationId",
    "pointContextDigest",
    "pointReadNumber",
    "pointRequestDigest",
    "decisionBoundaryAt",
    "pointProof",
  ]);
  assert.deepEqual(Object.keys(value.pointProof), [
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
});

test("the complete deterministic signed response matches the Calls producer golden", () => {
  const fixture = signedFixture();
  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_PROTOCOL_VERSION,
    "recall-classifier-capsule-consumer-protocol-v1",
  );
  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_BODY_BYTES,
    32 * 1024,
  );
  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_RESPONSE_BYTES,
    32 * 1024,
  );
  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_TTL_MS,
    24 * 60 * 60 * 1_000,
  );
  assert.equal(PUBLIC_KEY_BASE64, CALLS_GOLDEN.publicKeySpkiBase64);
  assert.equal(KEY_ID, CALLS_GOLDEN.keyId);
  assert.equal(
    fixture.request.requestDigest,
    CALLS_GOLDEN.requestDigest,
  );
  assert.equal(
    fixture.request.pointBindingDigest,
    CALLS_GOLDEN.pointBindingDigest,
  );
  assert.equal(
    fixture.request.pointProofDigest,
    CALLS_GOLDEN.pointProofDigest,
  );
  assert.equal(
    fixture.response.contextDigest,
    CALLS_GOLDEN.contextDigest,
  );
  assert.equal(
    fixture.response.reservationId,
    CALLS_GOLDEN.reservationId,
  );
  assert.equal(
    fixture.response.capsule.callEndedAtDigest,
    CALLS_GOLDEN.callEndedAtDigest,
  );
  assert.equal(
    fixture.response.capsule.classifierOutputDigest,
    CALLS_GOLDEN.classifierOutputDigest,
  );
  assert.equal(
    fixture.response.receipt.capsuleDigest,
    CALLS_GOLDEN.capsuleDigest,
  );
  assert.equal(
    fixture.response.receipt.signature,
    CALLS_GOLDEN.signature,
  );
  assert.equal(
    sourceRecallClassifierCapsuleResponseDigest(
      fixture.responseBody,
    ),
    CALLS_GOLDEN.responseDigest,
  );
  assert.equal(
    sourceRecallClassifierCapsuleReceiptDigest(
      fixture.response.receipt,
    ),
    CALLS_GOLDEN.receiptDigest,
  );
  assert.equal(
    Buffer.byteLength(fixture.responseBody, "utf8"),
    CALLS_GOLDEN.responseBodyLength,
  );
  assert.deepEqual(
    parseSourceRecallClassifierCapsuleResponse(
      fixture.responseBody,
      fixture.request,
    ),
    fixture.response,
  );
});

test("protocol rejects non-exact response, capsule, receipt, binding, and time state", async (t) => {
  const fixture = signedFixture();
  const cases = [
    ["response extra key", (response) => {
      response.force = true;
    }],
    ["response missing key", (response) => {
      delete response.requestDigest;
    }],
    ["capsule extra key", (response) => {
      response.capsule.score = 100;
    }],
    ["capsule missing key", (response) => {
      delete response.capsule.classifierPolicyDigest;
    }],
    ["receipt extra key", (response) => {
      response.receipt.privateKey = PRIVATE_MARKER;
    }],
    ["receipt missing key", (response) => {
      delete response.receipt.contextDigest;
    }],
    ["request digest echo", (response) => {
      response.requestDigest = DIGEST("0");
    }],
    ["read ordinal echo", (response) => {
      response.readNumber = 1;
    }],
    ["point binding", (response) => {
      response.capsule.pointBindingDigest = DIGEST("0");
    }],
    ["point proof", (response) => {
      response.capsule.pointProofDigest = DIGEST("0");
    }],
    ["decision boundary", (response) => {
      response.capsule.decisionBoundaryDigest = DIGEST("0");
    }],
    ["ended-at digest", (response) => {
      response.capsule.callEndedAtDigest = DIGEST("0");
    }],
    ["ended after boundary", (response) => {
      response.capsule.callEndedAt =
        "2026-07-27T02:00:00.001Z";
    }],
    ["classifier output digest", (response) => {
      response.capsule.classifierOutputDigest = DIGEST("0");
    }],
    ["classified before point", (response) => {
      response.capsule.classifiedAtMs =
        POINT_COMPLETED_AT_MS - 1;
    }],
    ["receipt reservation", (response) => {
      response.receipt.reservationId = DIGEST("0");
    }],
    ["receipt context", (response) => {
      response.receipt.contextDigest = DIGEST("0");
    }],
    ["receipt point response", (response) => {
      response.receipt.pointResponseDigest = DIGEST("0");
    }],
    ["receipt capsule digest", (response) => {
      response.receipt.capsuleDigest = DIGEST("0");
    }],
    ["receipt before classification", (response) => {
      response.receipt.issuedAtMs =
        response.capsule.classifiedAtMs - 1;
    }],
    ["receipt nonpositive TTL", (response) => {
      response.receipt.expiresAtMs =
        response.receipt.issuedAtMs;
    }],
    ["receipt TTL over 24 hours", (response) => {
      response.receipt.expiresAtMs =
        response.receipt.issuedAtMs
        + SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_TTL_MS
        + 1;
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const response = JSON.parse(fixture.responseBody);
      mutate(response);
      assert.throws(
        () => parseSourceRecallClassifierCapsuleResponse(
          JSON.stringify(response),
          fixture.request,
        ),
        expectProtocolFailure,
      );
    });
  }
});

test("the verifier proves canonical response, atomic pins, key id, signature, and freshness", () => {
  const fixture = signedFixture();
  const verifier =
    createSourceRecallClassifierCapsuleVerifier(
      VERIFIER_CONFIGURATION,
    );
  const result = verifier.verifyResponse({
    responseBody: fixture.responseBody,
    request: fixture.request,
    nowMs: NOW_MS,
  });

  assert.equal(
    result.version,
    SOURCE_RECALL_CLASSIFIER_CAPSULE_VERIFIER_VERSION,
  );
  assert.equal(result.signatureVerified, true);
  assert.equal(result.pinsVerified, true);
  assert.equal(result.keyId, KEY_ID);
  assert.equal(
    result.response.capsule.classification,
    "success",
  );
  assert.equal(
    result.response.capsule.classificationBasis,
    "transcript_two_way",
  );
  assert.equal(result.operational, false);
  assert.equal(result.sourceFactsAvailable, false);
  assert.equal(result.successClassificationAvailable, false);
  assert.equal(
    result.candidateIdentityResolutionAvailable,
    false,
  );
  assert.equal(result.pinnable, false);
  assert.equal(result.authorityAvailable, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.response), true);
  assert.equal(Object.isFrozen(result.response.capsule), true);
  assert.equal(Object.isFrozen(result.response.receipt), true);
});

test("all Calls v2 bases preserve the exact non-score-derived classification mapping", async (t) => {
  const cases = [
    [
      "transcript_two_way",
      "success",
      "success",
      ["not_used"],
    ],
    [
      "transcript_agent_audio_failure",
      "audio_fail",
      "failure",
      ["not_used"],
    ],
    [
      "transcript_incomplete",
      "incomplete",
      "failure",
      ["not_used"],
    ],
    [
      "transcript_joined_silent",
      "joined_silent",
      "unavailable",
      ["not_used"],
    ],
    [
      "vapi_answers",
      "success",
      "unavailable",
      ["exact", "unproven"],
    ],
    [
      "presence_recorded",
      "recorded",
      "unavailable",
      ["not_used"],
    ],
    [
      "recall_empty_room",
      "no_show",
      "unavailable",
      ["not_used"],
    ],
    [
      "presence_empty_room",
      "no_show",
      "unavailable",
      ["not_used"],
    ],
    [
      "transcript_empty_room",
      "no_show",
      "unavailable",
      ["not_used"],
    ],
    [
      "vapi_silence",
      "no_show",
      "unavailable",
      ["exact", "unproven"],
    ],
    [
      "media_recorded",
      "recorded",
      "unavailable",
      ["not_used"],
    ],
    [
      "processing",
      "pending",
      "unavailable",
      ["not_used"],
    ],
  ];
  for (const [
    classificationBasis,
    callsVerdict,
    classification,
    associationStatuses,
  ] of cases) {
    await t.test(classificationBasis, () => {
      for (const vapiAssociationStatus of associationStatuses) {
        const output = {
          vapiAssociationStatus,
          callsVerdict,
          classification,
          classificationBasis,
        };
        assert.match(
          sourceRecallClassifierOutputDigest(output),
          /^[a-f0-9]{64}$/u,
        );
        for (const wrong of [
          "success",
          "failure",
          "unavailable",
        ].filter((value) => value !== classification)) {
          assert.throws(
            () => sourceRecallClassifierOutputDigest({
              ...output,
              classification: wrong,
            }),
            expectProtocolCode(
              "SOURCE_RECALL_CLASSIFIER_CAPSULE_OUTPUT_INVALID",
            ),
          );
        }
        assert.throws(
          () => sourceRecallClassifierOutputDigest({
            ...output,
            callsVerdict:
              callsVerdict === "unknown"
                ? "pending"
                : "unknown",
          }),
          expectProtocolCode(
            "SOURCE_RECALL_CLASSIFIER_CAPSULE_OUTPUT_INVALID",
          ),
        );
      }
    });
  }

  for (const output of [
    {
      vapiAssociationStatus: "exact",
      callsVerdict: "success",
      classification: "success",
      classificationBasis: "vapi_answers",
    },
    {
      vapiAssociationStatus: "not_used",
      callsVerdict: "success",
      classification: "unavailable",
      classificationBasis: "vapi_answers",
    },
    {
      vapiAssociationStatus: "exact",
      callsVerdict: "success",
      classification: "success",
      classificationBasis: "transcript_two_way",
    },
  ]) {
    assert.throws(
      () => sourceRecallClassifierOutputDigest(output),
      expectProtocolCode(
        "SOURCE_RECALL_CLASSIFIER_CAPSULE_OUTPUT_INVALID",
      ),
    );
  }
});

test("verifier rejects every atomic pin, key, signature, and freshness mutation", async (t) => {
  const fixture = signedFixture();
  const pinKeys = Object.keys(PINS);
  for (const [index, key] of pinKeys.entries()) {
    const crossedKey = pinKeys[(index + 1) % pinKeys.length];
    await t.test(`cross-mixed ${key}`, () => {
      const verifier =
        createSourceRecallClassifierCapsuleVerifier(
          {
            ...VERIFIER_CONFIGURATION,
            [key]: PINS[crossedKey],
          },
        );
      assert.throws(
        () => verifier.verifyResponse({
          responseBody: fixture.responseBody,
          request: fixture.request,
          nowMs: NOW_MS,
        }),
        expectVerifierCode(
          "SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_MISMATCH",
        ),
      );
    });
  }

  const wrongPair = generateKeyPairSync("ed25519");
  assert.throws(
    () => createSourceRecallClassifierCapsuleVerifier({
      ...VERIFIER_CONFIGURATION,
      publicKeySpkiBase64:
        wrongPair.publicKey.export({
          format: "der",
          type: "spki",
        }).toString("base64"),
    }).verifyResponse({
      responseBody: fixture.responseBody,
      request: fixture.request,
      nowMs: NOW_MS,
    }),
    expectVerifierCode(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_KEY_MISMATCH",
    ),
  );

  const wrongKeyIdBody = mutateSignedFixture({
    fixture,
    mutateReceipt(receipt) {
      receipt.keyId = DIGEST("0");
    },
  });
  assert.throws(
    () => createSourceRecallClassifierCapsuleVerifier(
      VERIFIER_CONFIGURATION,
    ).verifyResponse({
      responseBody: wrongKeyIdBody,
      request: fixture.request,
      nowMs: NOW_MS,
    }),
    expectVerifierCode(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_KEY_MISMATCH",
    ),
  );

  const tampered = JSON.parse(fixture.responseBody);
  tampered.receipt.signature = flippedCanonicalSignature(
    tampered.receipt.signature,
  );
  assert.throws(
    () => createSourceRecallClassifierCapsuleVerifier(
      VERIFIER_CONFIGURATION,
    ).verifyResponse({
      responseBody: JSON.stringify(tampered),
      request: fixture.request,
      nowMs: NOW_MS,
    }),
    expectVerifierCode(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_SIGNATURE_INVALID",
    ),
  );

  const futureIssued = signedFixture({
    receiptOverrides: {
      issuedAtMs:
        NOW_MS
        + SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_CLOCK_SKEW_MS
        + 1,
      expiresAtMs:
        NOW_MS
        + SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_CLOCK_SKEW_MS
        + 60_001,
    },
  });
  const futureClassifiedAtMs =
    NOW_MS
    + SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_CLOCK_SKEW_MS
    + 1;
  const futureClassified = signedFixture({
    capsuleOverrides: {
      classifiedAtMs: futureClassifiedAtMs,
    },
    receiptOverrides: {
      issuedAtMs: futureClassifiedAtMs,
      expiresAtMs: futureClassifiedAtMs + 60_000,
    },
  });
  for (const [name, selected, nowMs] of [
    ["expires exactly now", fixture, EXPIRES_AT_MS],
    [
      "issued beyond skew",
      futureIssued,
      NOW_MS,
    ],
    [
      "classified beyond skew",
      futureClassified,
      NOW_MS,
    ],
  ]) {
    await t.test(name, () => {
      assert.throws(
        () => createSourceRecallClassifierCapsuleVerifier(
          VERIFIER_CONFIGURATION,
        ).verifyResponse({
          responseBody: selected.responseBody,
          request: selected.request,
          nowMs,
        }),
        expectVerifierCode(
          "SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_STALE",
        ),
      );
    });
  }

  const justInsideSkew = signedFixture({
    receiptOverrides: {
      issuedAtMs:
        NOW_MS
        + SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_CLOCK_SKEW_MS,
      expiresAtMs:
        NOW_MS
        + SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_CLOCK_SKEW_MS
        + 60_000,
    },
  });
  assert.equal(
    createSourceRecallClassifierCapsuleVerifier(
      VERIFIER_CONFIGURATION,
    ).verifyResponse({
      responseBody: justInsideSkew.responseBody,
      request: justInsideSkew.request,
      nowMs: NOW_MS,
    }).signatureVerified,
    true,
  );
});

test("client performs exactly one domain-bound HMAC POST and returns only verified body-free material", async () => {
  const fixture = signedFixture();
  const calls = [];
  const result = await readPrivateRecallClassifierCapsule(
    fixture.requestInput,
    dependencies(async (...args) => {
      calls.push(args);
      return responseFor(fixture.responseBody);
    }),
  );

  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_VERSION,
    "recall-private-classifier-capsule-client-v1",
  );
  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_ORIGIN,
    "https://raydar-calls.vercel.app",
  );
  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_AUTH_DOMAIN,
    "paraai-recall-classifier-capsule-request-auth-v1",
  );
  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_URL,
    `${SOURCE_RECALL_CLASSIFIER_CAPSULE_ORIGIN}`
      + SOURCE_RECALL_CLASSIFIER_CAPSULE_PATH,
  );
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, SOURCE_RECALL_CLASSIFIER_CAPSULE_URL);
  const timestamp = String(Math.floor(NOW_MS / 1_000));
  const expectedSignature = `v1=${createHmac(
    "sha256",
    SECRET,
  ).update(
    `${SOURCE_RECALL_CLASSIFIER_CAPSULE_AUTH_DOMAIN}\0`
    + `${timestamp}.POST.`
    + `${SOURCE_RECALL_CLASSIFIER_CAPSULE_PATH}.`
    + fixture.request.rawBody,
    "utf8",
  ).digest("hex")}`;
  assert.equal(
    expectedSignature,
    "v1=a3e7131f214e5a7835dd84dc7416db87f51be1e9fd35dfe9f66786c4bc22dee1",
  );
  assert.deepEqual(options, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-raydar-timestamp": timestamp,
      "x-raydar-signature": expectedSignature,
    },
    body: fixture.request.rawBody,
    cache: "no-store",
    redirect: "error",
    signal: SIGNAL,
  });
  assert.equal(result.signatureVerified, true);
  assert.equal(result.pinsVerified, true);
  assert.equal(
    JSON.stringify(result).includes(SECRET),
    false,
  );
  assert.equal(
    JSON.stringify(result).includes(PRIVATE_MARKER),
    false,
  );
  assert.equal(
    JSON.stringify(result).includes("rawBody"),
    false,
  );
});

test("missing HMAC, public key, or any one of the atomic four pins is hard-dark before transport", async (t) => {
  const fixture = signedFixture();
  const missing = [
    ["missing secret", "secret", undefined],
    ["short secret", "secret", "x".repeat(31)],
    ["blank secret", "secret", " ".repeat(40)],
    [
      "publicKeySpkiBase64",
      "publicKeySpkiBase64",
      undefined,
    ],
    [
      "classifierArtifactDigest",
      "classifierArtifactDigest",
      undefined,
    ],
    [
      "classifierDeploymentDigest",
      "classifierDeploymentDigest",
      undefined,
    ],
    [
      "classifierRuntimeConfigDigest",
      "classifierRuntimeConfigDigest",
      undefined,
    ],
    [
      "classifierPolicyDigest",
      "classifierPolicyDigest",
      undefined,
    ],
  ];
  for (const [name, key, replacement] of missing) {
    await t.test(name, async () => {
      let fetchCount = 0;
      const selected = dependencies(async () => {
        fetchCount += 1;
        return responseFor(fixture.responseBody);
      });
      if (key === "secret") {
        selected.secret = replacement;
      } else {
        selected.verifierConfiguration = {
          ...selected.verifierConfiguration,
          [key]: replacement,
        };
      }
      await assert.rejects(
        () => readPrivateRecallClassifierCapsule(
          fixture.requestInput,
          selected,
        ),
        expectClientCode(
          "SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_NOT_CONFIGURED",
        ),
      );
      assert.equal(fetchCount, 0);
    });
  }
});

test("verifier configuration is exact, proxy- and accessor-safe, and atomically environment-gated", async (t) => {
  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_PUBLIC_KEY_ENV,
    "PARAAI_RECALL_SOURCE_CLASSIFIER_CAPSULE_ED25519_PUBLIC_KEY_BASE64",
  );
  assert.equal(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_SECRET_ENV,
    "PARAAI_RECALL_SOURCE_CLASSIFIER_CAPSULE_SECRET",
  );
  assert.deepEqual(
    SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_ENVS,
    {
      classifierArtifactDigest:
        "PARAAI_RECALL_SOURCE_CLASSIFIER_CAPSULE_ARTIFACT_DIGEST",
      classifierDeploymentDigest:
        "PARAAI_RECALL_SOURCE_CLASSIFIER_CAPSULE_DEPLOYMENT_DIGEST",
      classifierRuntimeConfigDigest:
        "PARAAI_RECALL_SOURCE_CLASSIFIER_CAPSULE_RUNTIME_CONFIG_DIGEST",
      classifierPolicyDigest:
        "PARAAI_RECALL_SOURCE_CLASSIFIER_CAPSULE_POLICY_DIGEST",
    },
  );

  const environment = {
    [SOURCE_RECALL_CLASSIFIER_CAPSULE_SECRET_ENV]: SECRET,
    [SOURCE_RECALL_CLASSIFIER_CAPSULE_PUBLIC_KEY_ENV]:
      PUBLIC_KEY_BASE64,
    ...Object.fromEntries(
      Object.entries(
        SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_ENVS,
      ).map(([key, name]) => [name, PINS[key]]),
    ),
  };
  assert.equal(
    sourceRecallClassifierCapsuleVerifierConfigured(
      environment,
    ),
    true,
  );
  assert.equal(
    sourceRecallClassifierCapsuleClientConfigured(
      environment,
    ),
    true,
  );
  for (const name of [
    SOURCE_RECALL_CLASSIFIER_CAPSULE_PUBLIC_KEY_ENV,
    ...Object.values(
      SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_ENVS,
    ),
  ]) {
    const selected = { ...environment };
    delete selected[name];
    assert.equal(
      sourceRecallClassifierCapsuleVerifierConfigured(
        selected,
      ),
      false,
    );
    assert.equal(
      sourceRecallClassifierCapsuleClientConfigured(
        selected,
      ),
      false,
    );
  }
  const noSecret = { ...environment };
  delete noSecret[
    SOURCE_RECALL_CLASSIFIER_CAPSULE_SECRET_ENV
  ];
  assert.equal(
    sourceRecallClassifierCapsuleVerifierConfigured(
      noSecret,
    ),
    true,
  );
  assert.equal(
    sourceRecallClassifierCapsuleClientConfigured(
      noSecret,
    ),
    false,
  );
  assert.equal(
    sourceRecallClassifierCapsuleVerifierConfigured(
      new Proxy(environment, {}),
    ),
    false,
  );
  assert.equal(
    sourceRecallClassifierCapsuleClientConfigured(
      new Proxy(environment, {}),
    ),
    false,
  );

  const accessor = { ...VERIFIER_CONFIGURATION };
  Object.defineProperty(
    accessor,
    "classifierPolicyDigest",
    {
      enumerable: true,
      get() {
        throw new Error(`${PRIVATE_MARKER} ${SECRET}`);
      },
    },
  );
  const rsa = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const missing = { ...VERIFIER_CONFIGURATION };
  delete missing.classifierDeploymentDigest;
  const notConfigured =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_VERIFIER_NOT_CONFIGURED";
  const publicKeyInvalid =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_PUBLIC_KEY_INVALID";
  const invalid = [
    ["null", null, notConfigured],
    ["array", [], notConfigured],
    ["proxy", new Proxy(
      { ...VERIFIER_CONFIGURATION },
      {},
    ), notConfigured],
    ["accessor", accessor, notConfigured],
    ["missing key", missing, notConfigured],
    ["extra key", {
      ...VERIFIER_CONFIGURATION,
      alternateKeyId: DIGEST("0"),
    }, notConfigured],
    ["uppercase pin", {
      ...VERIFIER_CONFIGURATION,
      classifierPolicyDigest: DIGEST("A"),
    }, notConfigured],
    ["noncanonical public key", {
      ...VERIFIER_CONFIGURATION,
      publicKeySpkiBase64: `${PUBLIC_KEY_BASE64}\n`,
    }, publicKeyInvalid],
    ["wrong public-key algorithm", {
      ...VERIFIER_CONFIGURATION,
      publicKeySpkiBase64:
        rsa.publicKey.export({
          format: "der",
          type: "spki",
        }).toString("base64"),
    }, publicKeyInvalid],
  ];
  for (const [name, selected, code] of invalid) {
    await t.test(name, () => {
      assert.throws(
        () => createSourceRecallClassifierCapsuleVerifier(
          selected,
        ),
        expectVerifierCode(code),
      );
    });
  }
});

test("test dependencies and clocks reject proxies, accessors, extras, and malformed values without transport", async (t) => {
  const fixture = signedFixture();
  const valid = dependencies(async () =>
    responseFor(fixture.responseBody));
  const missing = { ...valid };
  delete missing.signalFactory;
  const accessor = { ...valid };
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() {
      throw new Error(`${PRIVATE_MARKER} ${SECRET}`);
    },
  });
  const verifierAccessor = {
    ...VERIFIER_CONFIGURATION,
  };
  Object.defineProperty(
    verifierAccessor,
    "classifierArtifactDigest",
    {
      enumerable: true,
      get() {
        throw new Error(`${PRIVATE_MARKER} ${SECRET}`);
      },
    },
  );
  const invalidDependencies = [
    ["empty", {}],
    ["missing key", missing],
    ["extra key", {
      ...valid,
      retryCount: 1,
    }],
    ["proxy", new Proxy(valid, {})],
    ["accessor", accessor],
    ["bad fetch", {
      ...valid,
      fetchImpl: null,
    }],
    ["bad now", {
      ...valid,
      nowImpl: null,
    }],
    ["bad signal factory", {
      ...valid,
      signalFactory: null,
    }],
    ["bad secret type", {
      ...valid,
      secret: Buffer.from(SECRET),
    }],
    ["verifier extra key", {
      ...valid,
      verifierConfiguration: {
        ...VERIFIER_CONFIGURATION,
        privateKey: PRIVATE_MARKER,
      },
    }],
    ["verifier proxy", {
      ...valid,
      verifierConfiguration: new Proxy(
        { ...VERIFIER_CONFIGURATION },
        {},
      ),
    }],
    ["verifier accessor", {
      ...valid,
      verifierConfiguration: verifierAccessor,
    }],
  ];
  for (const [name, selected] of invalidDependencies) {
    await t.test(name, async () => {
      await assert.rejects(
        () => readPrivateRecallClassifierCapsule(
          fixture.requestInput,
          selected,
        ),
        expectClientCode(
          "SOURCE_RECALL_CLASSIFIER_CAPSULE_TEST_DEPENDENCIES_INVALID",
        ),
      );
    });
  }

  for (const [name, nowImpl] of [
    ["NaN", () => Number.NaN],
    ["zero", () => 0],
    ["negative zero", () => -0],
    ["fraction", () => NOW_MS + 0.5],
    ["nine-digit seconds", () => 999_999_999_000],
  ]) {
    await t.test(`clock ${name}`, async () => {
      let fetchCount = 0;
      await assert.rejects(
        () => readPrivateRecallClassifierCapsule(
          fixture.requestInput,
          {
            ...valid,
            fetchImpl: async () => {
              fetchCount += 1;
              return responseFor(fixture.responseBody);
            },
            nowImpl,
          },
        ),
        expectClientCode(
          "SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_CLOCK_INVALID",
        ),
      );
      assert.equal(fetchCount, 0);
    });
  }

  let signalFetchCount = 0;
  await assert.rejects(
    () => readPrivateRecallClassifierCapsule(
      fixture.requestInput,
      {
        ...valid,
        fetchImpl: async () => {
          signalFetchCount += 1;
          return responseFor(fixture.responseBody);
        },
        signalFactory() {
          throw new Error(`${PRIVATE_MARKER} ${SECRET}`);
        },
      },
    ),
    expectClientCode(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_UNAVAILABLE",
    ),
  );
  assert.equal(signalFetchCount, 0);
});

test("transport, framing, private-header, and cryptographic failures are generic and single-attempt", async (t) => {
  const fixture = signedFixture();
  const invalidSignature = JSON.parse(fixture.responseBody);
  invalidSignature.receipt.signature =
    flippedCanonicalSignature(
      invalidSignature.receipt.signature,
    );
  const cases = [
    ["network", async () => {
      throw new Error(`${PRIVATE_MARKER} ${SECRET}`);
    }],
    ["status", async () => responseFor(
      JSON.stringify({ error: PRIVATE_MARKER }),
      { status: 503 },
    )],
    ["cors", async () => responseFor(
      fixture.responseBody,
      { headers: { "access-control-allow-origin": "*" } },
    )],
    ["cache", async () => responseFor(
      fixture.responseBody,
      { headers: { "cache-control": "" } },
    )],
    ["nosniff", async () => responseFor(
      fixture.responseBody,
      { headers: { "x-content-type-options": "" } },
    )],
    ["signature", async () => responseFor(
      JSON.stringify(invalidSignature),
    )],
  ];
  for (const [name, fetchImpl] of cases) {
    await t.test(name, async () => {
      let fetchCount = 0;
      let observed;
      try {
        await readPrivateRecallClassifierCapsule(
          fixture.requestInput,
          dependencies(async (...args) => {
            fetchCount += 1;
            return fetchImpl(...args);
          }),
        );
      } catch (error) {
        observed = error;
      }
      assert.equal(fetchCount, 1);
      assert.equal(
        observed instanceof
          SourceRecallClassifierCapsuleClientError,
        true,
      );
      assert.equal(
        observed.code,
        "SOURCE_RECALL_CLASSIFIER_CAPSULE_UNAVAILABLE",
      );
      assert.equal(
        observed.message.includes(PRIVATE_MARKER),
        false,
      );
      assert.equal(observed.message.includes(SECRET), false);
    });
  }
});

test("response framing, byte limits, UTF-8, and canonical JSON all fail closed in one attempt", async (t) => {
  const fixture = signedFixture();
  const secureHeaders = new Headers(responseHeaders());
  let streamedCancelCount = 0;
  const streamedOversize = {
    status: 200,
    headers: secureHeaders,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(
          SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_RESPONSE_BYTES,
          0x20,
        );
        yield Buffer.from(" ");
      },
      async cancel() {
        streamedCancelCount += 1;
      },
    },
  };
  const reordered = JSON.stringify({
    receipt: fixture.response.receipt,
    capsule: fixture.response.capsule,
    requestDigest: fixture.response.requestDigest,
    readNumber: fixture.response.readNumber,
    contextDigest: fixture.response.contextDigest,
    reservationId: fixture.response.reservationId,
    version: fixture.response.version,
  });
  const duplicateVersion = fixture.responseBody.replace(
    /^\{"version":/u,
    `{"version":"${SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_VERSION}","version":`,
  );
  const cases = [
    [
      "missing content type",
      () => responseFor(fixture.responseBody, {
        headers: { "content-type": "" },
      }),
    ],
    [
      "wrong content type",
      () => responseFor(fixture.responseBody, {
        headers: { "content-type": "text/plain" },
      }),
    ],
    [
      "wrong charset",
      () => responseFor(fixture.responseBody, {
        headers: {
          "content-type":
            "application/json; charset=iso-8859-1",
        },
      }),
    ],
    [
      "malformed content length",
      () => responseFor(fixture.responseBody, {
        headers: { "content-length": "01" },
      }),
    ],
    [
      "declared oversized",
      () => responseFor(fixture.responseBody, {
        headers: {
          "content-length": String(
            SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_RESPONSE_BYTES
            + 1,
          ),
        },
      }),
    ],
    ["streamed oversized", () => streamedOversize],
    [
      "invalid UTF-8",
      () => new Response(
        Uint8Array.from([0xc3, 0x28]),
        { status: 200, headers: responseHeaders() },
      ),
    ],
    [
      "retained BOM",
      () => new Response(
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(fixture.responseBody, "utf8"),
        ]),
        { status: 200, headers: responseHeaders() },
      ),
    ],
    [
      "empty body",
      () => ({
        status: 200,
        headers: secureHeaders,
        body: null,
      }),
    ],
    [
      "unsupported stream",
      () => ({
        status: 200,
        headers: secureHeaders,
        body: {},
      }),
    ],
    [
      "canonical trailing whitespace",
      () => responseFor(`${fixture.responseBody}\n`),
    ],
    [
      "canonical key reordering",
      () => responseFor(reordered),
    ],
    [
      "duplicate JSON key",
      () => responseFor(duplicateVersion),
    ],
    [
      "redirect status",
      () => responseFor(
        JSON.stringify({ error: PRIVATE_MARKER }),
        { status: 302 },
      ),
    ],
    [
      "rate-limit status",
      () => responseFor(
        JSON.stringify({ error: PRIVATE_MARKER }),
        { status: 429 },
      ),
    ],
  ];

  for (const [name, factory] of cases) {
    await t.test(name, async () => {
      let fetchCount = 0;
      await assert.rejects(
        () => readPrivateRecallClassifierCapsule(
          fixture.requestInput,
          dependencies(async () => {
            fetchCount += 1;
            return factory();
          }),
        ),
        expectClientCode(
          "SOURCE_RECALL_CLASSIFIER_CAPSULE_UNAVAILABLE",
        ),
      );
      assert.equal(fetchCount, 1);
    });
  }
  assert.equal(streamedCancelCount >= 1, true);
});

test("requests reject proxies, accessors, symbols, non-exact keys, selectors, and malformed proof before transport", async (t) => {
  const base = requestValue();
  const missing = { ...base };
  delete missing.pointContextDigest;
  const proofMissing = { ...base.pointProof };
  delete proofMissing.sourceRecordDigest;
  const accessor = { ...base };
  Object.defineProperty(accessor, "pointReservationId", {
    enumerable: true,
    get() {
      throw new Error(`${PRIVATE_MARKER} ${SECRET}`);
    },
  });
  const proofAccessor = { ...base.pointProof };
  Object.defineProperty(proofAccessor, "workKeyDigest", {
    enumerable: true,
    get() {
      throw new Error(`${PRIVATE_MARKER} ${SECRET}`);
    },
  });
  const invalid = [
    ["null", null],
    ["array", []],
    ["missing key", missing],
    ["extra selector keys", {
      ...base,
      botId: "caller-controlled",
      limit: 1,
      force: true,
    }],
    ["wrong version", {
      ...base,
      version: "paraai-recall-classifier-capsule-request-v2",
    }],
    ["uppercase digest", {
      ...base,
      pointContextDigest: DIGEST("A"),
    }],
    ["read zero", {
      ...base,
      pointReadNumber: 0,
    }],
    ["read three", {
      ...base,
      pointReadNumber: 3,
    }],
    ["noncanonical boundary", {
      ...base,
      decisionBoundaryAt: "2026-07-27T02:00:00Z",
    }],
    ["point precedes boundary", {
      ...base,
      pointProof: pointProof({
        pointCompletedAtMs: Date.parse(BOUNDARY) - 1,
      }),
    }],
    ["unstable proof", {
      ...base,
      pointProof: pointProof({
        observationStatus: "conflict",
      }),
    }],
    ["proof missing key", {
      ...base,
      pointProof: proofMissing,
    }],
    ["proof extra key", {
      ...base,
      pointProof: {
        ...base.pointProof,
        candidateId: PRIVATE_MARKER,
      },
    }],
    ["top-level proxy", new Proxy({ ...base }, {})],
    ["proof proxy", {
      ...base,
      pointProof: new Proxy({ ...base.pointProof }, {}),
    }],
    ["top-level accessor", accessor],
    ["proof accessor", {
      ...base,
      pointProof: proofAccessor,
    }],
    ["top-level symbol", {
      ...base,
      [Symbol("private")]: true,
    }],
    ["proof symbol", {
      ...base,
      pointProof: {
        ...base.pointProof,
        [Symbol("private")]: true,
      },
    }],
    ["non-plain request", Object.assign(
      Object.create({ inherited: true }),
      base,
    )],
  ];

  for (const [name, selected] of invalid) {
    await t.test(name, async () => {
      let fetchCount = 0;
      await assert.rejects(
        () => readPrivateRecallClassifierCapsule(
          selected,
          dependencies(async () => {
            fetchCount += 1;
            return responseFor(
              signedFixture().responseBody,
            );
          }),
        ),
        expectClientCode(
          "SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_INVALID",
        ),
      );
      assert.equal(fetchCount, 0);
    });
  }
});

test("prepared requests and verified responses expose exact deeply frozen digest-only state", () => {
  const fixture = signedFixture();
  const prepared =
    prepareSourceRecallClassifierCapsuleRequest(
      fixture.requestInput,
    );
  assert.deepEqual(Object.keys(prepared), [
    "version",
    "pointReservationId",
    "pointContextDigest",
    "pointReadNumber",
    "pointRequestDigest",
    "decisionBoundaryAt",
    "pointProof",
    "requestDigest",
    "pointBindingDigest",
    "pointProofDigest",
    "rawBody",
  ]);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.pointProof), true);
  assert.throws(() => {
    prepared.pointProof.observationStatus = "conflict";
  }, TypeError);

  const verifier =
    createSourceRecallClassifierCapsuleVerifier(
      VERIFIER_CONFIGURATION,
    );
  assert.equal(Object.isFrozen(verifier), true);
  assert.deepEqual(Object.keys(verifier), [
    "keyId",
    "verifyResponse",
  ]);
  const result = verifier.verifyResponse({
    responseBody: fixture.responseBody,
    request: fixture.request,
    nowMs: NOW_MS,
  });
  assert.deepEqual(Object.keys(result), [
    "version",
    "verifiedAtMs",
    "signatureVerified",
    "pinsVerified",
    "keyId",
    "responseDigest",
    "receiptDigest",
    "response",
    "operational",
    "sourceFactsAvailable",
    "successClassificationAvailable",
    "candidateIdentityResolutionAvailable",
    "pinnable",
    "authorityAvailable",
  ]);
  for (const value of [
    result,
    result.response,
    result.response.capsule,
    result.response.receipt,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => {
    result.response.capsule.classification = "failure";
  }, TypeError);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("rawBody"), false);
  assert.equal(serialized.includes("x-raydar-signature"), false);
});

async function runtimeFiles(
  root,
  excludedDirectories = new Set(),
) {
  const entries = await readdir(root, {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const child = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      root,
    );
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) continue;
      files.push(...await runtimeFiles(
        child,
        excludedDirectories,
      ));
    } else if (/\.(?:mjs|js|ts)$/u.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

test("the exact v2 consumer closure has no production importer or release integration", async () => {
  const names = [
    "source-recall-classifier-capsule-protocol.mjs",
    "source-recall-classifier-capsule-verifier.mjs",
    "source-recall-classifier-capsule-client.mjs",
    "source-recall-classifier-capsule-capability.mjs",
    "source-recall-classifier-capsule-runtime.mjs",
    "source-recall-success-evidence-projector.mjs",
    "source-recall-classified-evidence-persistence-adapter.mjs",
    "source-recall-classified-evidence-store.mjs",
    "source-recall-classified-evidence-manifest-store.mjs",
  ];
  const moduleUrls = names.map((name) => new URL(
    `../api/paraai/_lib/${name}`,
    import.meta.url,
  ));
  const exactImports = new Map([
    [
      names[0],
      ["node:crypto", "node:util"],
    ],
    [
      names[1],
      [
        "./source-recall-classifier-capsule-protocol.mjs",
        "node:crypto",
        "node:util",
      ],
    ],
    [
      names[2],
      [
        "./source-recall-classifier-capsule-protocol.mjs",
        "./source-recall-classifier-capsule-verifier.mjs",
        "node:crypto",
        "node:util",
      ],
    ],
    [
      names[5],
      [
        "./source-recall-classifier-capsule-runtime.mjs",
        "node:crypto",
      ],
    ],
    [
      names[6],
      [
        "node:util",
      ],
    ],
    [
      names[7],
      [
        "./source-recall-classified-evidence-persistence-adapter.mjs",
        "./source-recall-classifier-capsule-protocol.mjs",
        "./source-recall-point-observation-manifest-store.mjs",
        "./source-recall-success-evidence-projector.mjs",
        "node:crypto",
        "node:util",
      ],
    ],
    [
      names[8],
      [
        "./source-recall-classified-evidence-persistence-adapter.mjs",
        "./source-recall-classified-evidence-store.mjs",
        "./source-recall-point-observation-manifest-store.mjs",
        "node:crypto",
        "node:util",
      ],
    ],
  ]);
  for (const moduleUrl of moduleUrls) {
    const source = await readFile(moduleUrl, "utf8");
    assert.doesNotMatch(source, /\bconsole\./u);
    assert.doesNotMatch(
      source,
      /PARAAI_(?:CURATE_ENABLED|ENROLL_APPROVED|MATCH_STAGE_ENABLED)/u,
    );
    assert.doesNotMatch(
      source,
      /source-(?:capture-coordinator|authority-store|watermark)/u,
    );
    const expected = exactImports.get(
      moduleUrl.pathname.slice(
        moduleUrl.pathname.lastIndexOf("/") + 1,
      ),
    );
    if (expected) {
      const imports = [
        ...source.matchAll(
          /\bfrom\s+["']([^"']+)["']/gu,
        ),
      ].map((match) => match[1]).sort();
      assert.deepEqual(imports, expected);
    }
  }

  const repositoryRoot = new URL("../", import.meta.url);
  const files = await runtimeFiles(
    repositoryRoot,
    new Set([".git", "node_modules", "test"]),
  );
  const closureHrefs = new Set(
    moduleUrls.map((moduleUrl) => moduleUrl.href),
  );
  const productionImporters = [];
  for (const file of files) {
    if (closureHrefs.has(file.href)) continue;
    const source = await readFile(file, "utf8");
    for (const name of names) {
      if (source.includes(name.replace(/\.mjs$/u, ""))) {
        productionImporters.push({
          file: file.pathname,
          imported: name,
        });
      }
    }
  }
  assert.deepEqual(productionImporters, []);
});

test("receipt signature base retains the exact deployed domain and canonical unsigned ordering", () => {
  const fixture = signedFixture();
  const { signature, ...unsigned } =
    fixture.response.receipt;
  const base =
    sourceRecallClassifierCapsuleReceiptSignatureBase(
      unsigned,
    );
  assert.equal(
    base,
    `${SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_SIGNATURE_DOMAIN}\0`
      + JSON.stringify(unsigned),
  );
  assert.equal(signature.length, 86);
});
