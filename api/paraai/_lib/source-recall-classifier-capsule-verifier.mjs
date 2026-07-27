// Dashboard-owned verifier for one canonical Calls classifier capsule.
//
// Authenticity is not inferred from transport authentication. The dashboard
// independently pins the Ed25519 public key and all four Calls runtime pins,
// replays the complete protocol validation, and verifies the signed receipt.
// This leaf performs no network I/O and grants no source or write authority.

import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  parseSourceRecallClassifierCapsuleResponse,
  sourceRecallClassifierCapsuleReceiptDigest,
  sourceRecallClassifierCapsuleReceiptSignatureBase,
  sourceRecallClassifierCapsuleResponseDigest,
  sourceRecallClassifierCapsuleUnsignedReceipt,
} from "./source-recall-classifier-capsule-protocol.mjs";

export const SOURCE_RECALL_CLASSIFIER_CAPSULE_VERIFIER_VERSION =
  "recall-classifier-capsule-verifier-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_KEY_ID_DOMAIN =
  "paraai-recall-classifier-capsule-ed25519-key-id-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_CLOCK_SKEW_MS =
  0;

export const SOURCE_RECALL_CLASSIFIER_CAPSULE_PUBLIC_KEY_ENV =
  "PARAAI_RECALL_SOURCE_CLASSIFIER_CAPSULE_ED25519_PUBLIC_KEY_BASE64";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_ENVS =
  Object.freeze({
    classifierArtifactDigest:
      "PARAAI_RECALL_SOURCE_CLASSIFIER_CAPSULE_ARTIFACT_DIGEST",
    classifierDeploymentDigest:
      "PARAAI_RECALL_SOURCE_CLASSIFIER_CAPSULE_DEPLOYMENT_DIGEST",
    classifierRuntimeConfigDigest:
      "PARAAI_RECALL_SOURCE_CLASSIFIER_CAPSULE_RUNTIME_CONFIG_DIGEST",
    classifierPolicyDigest:
      "PARAAI_RECALL_SOURCE_CLASSIFIER_CAPSULE_POLICY_DIGEST",
  });

const DIGEST = /^[a-f0-9]{64}$/u;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const CONFIGURATION_KEYS = Object.freeze([
  "publicKeySpkiBase64",
  "classifierArtifactDigest",
  "classifierDeploymentDigest",
  "classifierRuntimeConfigDigest",
  "classifierPolicyDigest",
]);

export class SourceRecallClassifierCapsuleVerifierError
  extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallClassifierCapsuleVerifierError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallClassifierCapsuleVerifierError(code);
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
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(code);
  }
  const snapshot = Object.create(null);
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value",
      )
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactKeys(record, expected, code) {
  const actual = Object.keys(record).sort();
  const selected = [...expected].sort();
  if (
    actual.length !== selected.length
    || actual.some(
      (key, index) => key !== selected[index],
    )
  ) {
    fail(code);
  }
}

function canonicalBase64(value, code) {
  if (
    typeof value !== "string"
    || value.length < 1
    || !BASE64.test(value)
  ) {
    fail(code);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64");
  } catch {
    fail(code);
  }
  if (
    bytes.length < 1
    || bytes.toString("base64") !== value
  ) {
    fail(code);
  }
  return bytes;
}

function publicKeyFromBase64(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_PUBLIC_KEY_INVALID";
  const bytes = canonicalBase64(value, code);
  let key;
  try {
    key = createPublicKey({
      key: bytes,
      format: "der",
      type: "spki",
    });
  } catch {
    fail(code);
  }
  if (key.asymmetricKeyType !== "ed25519") fail(code);
  const canonicalBytes = Buffer.from(key.export({
    format: "der",
    type: "spki",
  }));
  if (!canonicalBytes.equals(bytes)) fail(code);
  return Object.freeze({
    bytes: canonicalBytes,
    key,
  });
}

function exactDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
  return value;
}

function configuration(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_VERIFIER_NOT_CONFIGURED";
  const raw = plainRecordSnapshot(value, code);
  exactKeys(raw, CONFIGURATION_KEYS, code);
  const publicKey = publicKeyFromBase64(
    raw.publicKeySpkiBase64,
  );
  const pins = Object.freeze({
    classifierArtifactDigest:
      exactDigest(raw.classifierArtifactDigest, code),
    classifierDeploymentDigest:
      exactDigest(raw.classifierDeploymentDigest, code),
    classifierRuntimeConfigDigest:
      exactDigest(
        raw.classifierRuntimeConfigDigest,
        code,
      ),
    classifierPolicyDigest:
      exactDigest(raw.classifierPolicyDigest, code),
  });
  const keyId = createHash("sha256")
    .update(
      `${SOURCE_RECALL_CLASSIFIER_CAPSULE_KEY_ID_DOMAIN}\0`,
      "utf8",
    )
    .update(publicKey.bytes)
    .digest("hex");
  return Object.freeze({
    keyId,
    pins,
    publicKey: publicKey.key,
  });
}

function configurationFromEnvironment(environment) {
  if (
    environment === null
    || typeof environment !== "object"
    || Array.isArray(environment)
    || nodeTypes.isProxy(environment)
  ) {
    fail(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_VERIFIER_NOT_CONFIGURED",
    );
  }
  return {
    publicKeySpkiBase64:
      environment[
        SOURCE_RECALL_CLASSIFIER_CAPSULE_PUBLIC_KEY_ENV
      ],
    classifierArtifactDigest:
      environment[
        SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_ENVS
          .classifierArtifactDigest
      ],
    classifierDeploymentDigest:
      environment[
        SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_ENVS
          .classifierDeploymentDigest
      ],
    classifierRuntimeConfigDigest:
      environment[
        SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_ENVS
          .classifierRuntimeConfigDigest
      ],
    classifierPolicyDigest:
      environment[
        SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_ENVS
          .classifierPolicyDigest
      ],
  };
}

function exactNowMs(value) {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value <= 0
  ) {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_CLOCK_INVALID");
  }
  return value;
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

export function sourceRecallClassifierCapsuleVerifierConfigured(
  environment = process.env,
) {
  try {
    configuration(
      configurationFromEnvironment(environment),
    );
    return true;
  } catch {
    return false;
  }
}

export function createSourceRecallClassifierCapsuleVerifier(
  configurationValue = configurationFromEnvironment(process.env),
) {
  const selected = configuration(configurationValue);

  function verifyResponse({
    responseBody,
    request,
    nowMs,
  } = {}) {
    const verifiedAtMs = exactNowMs(nowMs);
    let response;
    try {
      response = parseSourceRecallClassifierCapsuleResponse(
        responseBody,
        request,
      );
    } catch {
      fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_INVALID");
    }
    const { capsule, receipt } = response;
    for (const [key, expected] of Object.entries(
      selected.pins,
    )) {
      if (capsule[key] !== expected) {
        fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_MISMATCH");
      }
    }
    if (receipt.keyId !== selected.keyId) {
      fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_KEY_MISMATCH");
    }
    if (
      receipt.expiresAtMs <= verifiedAtMs
      || receipt.issuedAtMs
        > verifiedAtMs
          + SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_CLOCK_SKEW_MS
      || capsule.classifiedAtMs
        > verifiedAtMs
          + SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_CLOCK_SKEW_MS
    ) {
      fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_RECEIPT_STALE");
    }
    const unsigned =
      sourceRecallClassifierCapsuleUnsignedReceipt(receipt);
    let signatureVerified = false;
    try {
      signatureVerified = verify(
        null,
        Buffer.from(
          sourceRecallClassifierCapsuleReceiptSignatureBase(
            unsigned,
          ),
          "utf8",
        ),
        selected.publicKey,
        Buffer.from(receipt.signature, "base64url"),
      );
    } catch {
      signatureVerified = false;
    }
    if (!signatureVerified) {
      fail(
        "SOURCE_RECALL_CLASSIFIER_CAPSULE_SIGNATURE_INVALID",
      );
    }
    return deepFreeze({
      version:
        SOURCE_RECALL_CLASSIFIER_CAPSULE_VERIFIER_VERSION,
      verifiedAtMs,
      signatureVerified: true,
      pinsVerified: true,
      keyId: receipt.keyId,
      responseDigest:
        sourceRecallClassifierCapsuleResponseDigest(
          responseBody,
        ),
      receiptDigest:
        sourceRecallClassifierCapsuleReceiptDigest(receipt),
      response,
      operational: false,
      sourceFactsAvailable: false,
      successClassificationAvailable: false,
      candidateIdentityResolutionAvailable: false,
      pinnable: false,
      authorityAvailable: false,
    });
  }

  return Object.freeze({
    keyId: selected.keyId,
    verifyResponse,
  });
}
