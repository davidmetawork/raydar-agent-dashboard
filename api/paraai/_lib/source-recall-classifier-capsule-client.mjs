// Private, hard-dark client for one signed Calls classifier capsule.
//
// This server-only leaf pins the Calls origin and exact request bytes, performs
// one signed POST, then delegates complete protocol, runtime-pin, expiry, and
// Ed25519 verification to the dashboard-owned verifier. It has no retry,
// browser, persistence, source-authority, Q37, curation, enrollment, or
// outreach surface.

import { createHmac } from "node:crypto";
import {
  TextDecoder,
  types as nodeTypes,
} from "node:util";

import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_RESPONSE_BYTES,
  prepareSourceRecallClassifierCapsuleRequest,
} from "./source-recall-classifier-capsule-protocol.mjs";
import {
  SOURCE_RECALL_CLASSIFIER_CAPSULE_PIN_ENVS,
  SOURCE_RECALL_CLASSIFIER_CAPSULE_PUBLIC_KEY_ENV,
  createSourceRecallClassifierCapsuleVerifier,
  sourceRecallClassifierCapsuleVerifierConfigured,
} from "./source-recall-classifier-capsule-verifier.mjs";

export const SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_VERSION =
  "recall-private-classifier-capsule-client-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_ORIGIN =
  "https://raydar-calls.vercel.app";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_PATH =
  "/api/paraai-source-classifier-capsule";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_URL =
  `${SOURCE_RECALL_CLASSIFIER_CAPSULE_ORIGIN}`
  + SOURCE_RECALL_CLASSIFIER_CAPSULE_PATH;
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_TIMEOUT_MS =
  20_000;
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_AUTH_DOMAIN =
  "paraai-recall-classifier-capsule-request-auth-v1";
export const SOURCE_RECALL_CLASSIFIER_CAPSULE_SECRET_ENV =
  "PARAAI_RECALL_SOURCE_CLASSIFIER_CAPSULE_SECRET";

const MIN_SECRET_LENGTH = 32;
const TEST_DEPENDENCY_KEYS = Object.freeze([
  "fetchImpl",
  "nowImpl",
  "secret",
  "signalFactory",
  "verifierConfiguration",
]);
const VERIFIER_CONFIGURATION_KEYS = Object.freeze([
  "publicKeySpkiBase64",
  "classifierArtifactDigest",
  "classifierDeploymentDigest",
  "classifierRuntimeConfigDigest",
  "classifierPolicyDigest",
]);

export class SourceRecallClassifierCapsuleClientError
  extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallClassifierCapsuleClientError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallClassifierCapsuleClientError(code);
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

function environmentVerifierConfiguration(environment) {
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

function dependencies(value) {
  if (value === undefined) {
    return Object.freeze({
      fetchImpl: globalThis.fetch,
      nowImpl: () => Date.now(),
      secret:
        process.env[
          SOURCE_RECALL_CLASSIFIER_CAPSULE_SECRET_ENV
        ],
      signalFactory: (timeoutMs) =>
        AbortSignal.timeout(timeoutMs),
      verifierConfiguration:
        environmentVerifierConfiguration(process.env),
    });
  }
  const code =
    "SOURCE_RECALL_CLASSIFIER_CAPSULE_TEST_DEPENDENCIES_INVALID";
  const selected = plainRecordSnapshot(value, code);
  exactKeys(selected, TEST_DEPENDENCY_KEYS, code);
  if (
    typeof selected.fetchImpl !== "function"
    || typeof selected.nowImpl !== "function"
    || typeof selected.signalFactory !== "function"
    || !(
      selected.secret === undefined
      || typeof selected.secret === "string"
    )
  ) {
    fail(code);
  }
  const verifier = plainRecordSnapshot(
    selected.verifierConfiguration,
    code,
  );
  exactKeys(verifier, VERIFIER_CONFIGURATION_KEYS, code);
  return Object.freeze({
    ...selected,
    verifierConfiguration: Object.freeze({
      ...verifier,
    }),
  });
}

function configuredSecret(value) {
  const selected = typeof value === "string"
    ? value.trim()
    : "";
  if (selected.length < MIN_SECRET_LENGTH) {
    fail(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_NOT_CONFIGURED",
    );
  }
  return selected;
}

export function sourceRecallClassifierCapsuleClientConfigured(
  environment = process.env,
) {
  try {
    if (
      environment === null
      || typeof environment !== "object"
      || Array.isArray(environment)
      || nodeTypes.isProxy(environment)
    ) {
      return false;
    }
    configuredSecret(
      environment[
        SOURCE_RECALL_CLASSIFIER_CAPSULE_SECRET_ENV
      ],
    );
    return sourceRecallClassifierCapsuleVerifierConfigured(
      environment,
    );
  } catch {
    return false;
  }
}

function exactNowMs(value) {
  const nowMs = Number(value);
  if (
    !Number.isSafeInteger(nowMs)
    || Object.is(nowMs, -0)
    || nowMs <= 0
  ) {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_CLOCK_INVALID");
  }
  return nowMs;
}

function timestampSeconds(nowMs) {
  const timestamp = String(Math.floor(nowMs / 1_000));
  if (!/^[0-9]{10}$/u.test(timestamp)) {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_CLOCK_INVALID");
  }
  return timestamp;
}

function responseHeader(headers, name) {
  if (typeof headers?.get === "function") {
    return String(headers.get(name) || "");
  }
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) {
      return value.length === 1 ? String(value[0] || "") : "";
    }
    return String(value || "");
  }
  return "";
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The stable client error is the only observable result.
  }
}

async function boundedResponseText(response) {
  const contentLength = responseHeader(
    response?.headers,
    "content-length",
  );
  if (contentLength) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      fail(
        "SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_INVALID",
      );
    }
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared)
      || declared
        > SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_RESPONSE_BYTES
    ) {
      fail(
        "SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_INVALID",
      );
    }
  }
  if (!response?.body) {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_INVALID");
  }

  const chunks = [];
  let size = 0;
  const append = async (chunk, cancel) => {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    size += bytes.length;
    if (
      size
        > SOURCE_RECALL_CLASSIFIER_CAPSULE_MAX_RESPONSE_BYTES
    ) {
      await Promise.resolve(cancel?.()).catch(() => {});
      fail(
        "SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_INVALID",
      );
    }
    chunks.push(bytes);
  };

  if (typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        await append(value, () => reader.cancel());
      }
    } finally {
      reader.releaseLock();
    }
  } else if (
    typeof response.body[Symbol.asyncIterator] === "function"
  ) {
    try {
      for await (const chunk of response.body) {
        await append(
          chunk,
          () => response.body.cancel?.(),
        );
      }
    } catch (error) {
      await Promise.resolve(
        response.body.cancel?.(),
      ).catch(() => {});
      throw error;
    }
  } else {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_INVALID");
  }

  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      // Preserve a BOM so distinct response bytes cannot collapse to one
      // accepted canonical JSON document.
      ignoreBOM: true,
    }).decode(Buffer.concat(chunks, size));
  } catch {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_RESPONSE_INVALID");
  }
}

function signature({
  secret,
  timestamp,
  rawBody,
}) {
  return `v1=${createHmac("sha256", secret)
    .update(
      `${SOURCE_RECALL_CLASSIFIER_CAPSULE_AUTH_DOMAIN}\0`
      + `${timestamp}.POST.`
      + `${SOURCE_RECALL_CLASSIFIER_CAPSULE_PATH}.`
      + rawBody,
      "utf8",
    )
    .digest("hex")}`;
}

export async function readPrivateRecallClassifierCapsule(
  requestValue,
  testDependencies,
) {
  let request;
  try {
    request =
      prepareSourceRecallClassifierCapsuleRequest(requestValue);
  } catch {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_REQUEST_INVALID");
  }
  const {
    fetchImpl,
    nowImpl,
    secret: rawSecret,
    signalFactory,
    verifierConfiguration,
  } = dependencies(testDependencies);
  if (typeof fetchImpl !== "function") {
    fail(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_NOT_CONFIGURED",
    );
  }
  const secret = configuredSecret(rawSecret);
  let verifier;
  try {
    verifier =
      createSourceRecallClassifierCapsuleVerifier(
        verifierConfiguration,
      );
  } catch {
    fail(
      "SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_NOT_CONFIGURED",
    );
  }
  const requestStartedAtMs = exactNowMs(nowImpl());
  const timestamp = timestampSeconds(requestStartedAtMs);
  const requestSignature = signature({
    secret,
    timestamp,
    rawBody: request.rawBody,
  });

  let signal;
  try {
    signal = signalFactory(
      SOURCE_RECALL_CLASSIFIER_CAPSULE_TIMEOUT_MS,
    );
  } catch {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_UNAVAILABLE");
  }
  let response;
  try {
    response = await fetchImpl(
      SOURCE_RECALL_CLASSIFIER_CAPSULE_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-raydar-timestamp": timestamp,
          "x-raydar-signature": requestSignature,
        },
        body: request.rawBody,
        cache: "no-store",
        redirect: "error",
        signal,
      },
    );
  } catch {
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_UNAVAILABLE");
  }

  try {
    if (
      !response
      || response.status !== 200
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
        responseHeader(
          response.headers,
          "content-type",
        ).trim(),
      )
      || responseHeader(
        response.headers,
        "cache-control",
      ).trim().toLowerCase() !== "no-store"
      || responseHeader(
        response.headers,
        "x-content-type-options",
      ).trim().toLowerCase() !== "nosniff"
      || responseHeader(
        response.headers,
        "access-control-allow-origin",
      ) !== ""
    ) {
      await cancelResponseBody(response);
      fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_UNAVAILABLE");
    }
    const responseBody = await boundedResponseText(response);
    const verifiedAtMs = exactNowMs(nowImpl());
    if (verifiedAtMs < requestStartedAtMs) {
      fail(
        "SOURCE_RECALL_CLASSIFIER_CAPSULE_CLIENT_CLOCK_INVALID",
      );
    }
    return verifier.verifyResponse({
      responseBody,
      request,
      nowMs: verifiedAtMs,
    });
  } catch {
    await cancelResponseBody(response);
    fail("SOURCE_RECALL_CLASSIFIER_CAPSULE_UNAVAILABLE");
  }
}
