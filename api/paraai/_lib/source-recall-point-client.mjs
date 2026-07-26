// Private, hard-dark client for one replay-reserved Recall point read.
//
// This server-only leaf pins the Calls origin and exact request bytes, performs
// one signed POST, and validates the complete private response envelope. It is
// deliberately not imported by a route, worker, coordinator, health surface,
// release gate, or source tick.

import {
  createHash,
  createHmac,
} from "node:crypto";
import {
  TextDecoder,
  types as nodeTypes,
} from "node:util";

export const SOURCE_RECALL_POINT_CLIENT_VERSION =
  "recall-private-point-client-v1";
export const SOURCE_RECALL_POINT_REQUEST_VERSION =
  "paraai-recall-source-point-request-v1";
export const SOURCE_RECALL_POINT_RESPONSE_VERSION =
  "paraai-recall-source-point-response-v1";
export const SOURCE_RECALL_POINT_TRANSPORT_RECEIPT_VERSION =
  "paraai-recall-source-point-transport-receipt-v1";
export const SOURCE_RECALL_POINT_ORIGIN =
  "https://raydar-calls.vercel.app";
export const SOURCE_RECALL_POINT_PATH =
  "/api/paraai-source-point";
export const SOURCE_RECALL_POINT_URL =
  `${SOURCE_RECALL_POINT_ORIGIN}${SOURCE_RECALL_POINT_PATH}`;
export const SOURCE_RECALL_POINT_TIMEOUT_MS = 20_000;
export const SOURCE_RECALL_POINT_MAX_BODY_BYTES = 32 * 1024;
export const SOURCE_RECALL_POINT_MAX_RESPONSE_BYTES = 4_000_000;

const MIN_SECRET_LENGTH = 32;
const DIGEST = /^[a-f0-9]{64}$/u;
const BOT_ID = /^[A-Za-z0-9_-]{5,128}$/u;
const REQUEST_KEYS = Object.freeze([
  "version",
  "reservationId",
  "contextDigest",
  "readNumber",
  "botId",
]);
const RESPONSE_KEYS = Object.freeze([
  "version",
  "reservationId",
  "contextDigest",
  "readNumber",
  "requestDigest",
  "point",
]);
const TEST_DEPENDENCY_KEYS = Object.freeze([
  "fetchImpl",
  "nowImpl",
  "secret",
  "signalFactory",
]);
const REQUEST_DIGEST_DOMAIN =
  "paraai-recall-source-point-request-bytes-v1";

export class SourceRecallPointClientError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallPointClientError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallPointClientError(code);
}

function sameKeys(actual, expected) {
  if (actual.length !== expected.length) return false;
  return actual.every((key, index) => key === expected[index]);
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
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function canonicalRequest(value) {
  const code = "SOURCE_RECALL_POINT_REQUEST_INVALID";
  if (!Object.isFrozen(value)) fail(code);
  const input = plainRecordSnapshot(value, code);
  if (
    !sameKeys(
      Object.keys(input).sort(),
      [...REQUEST_KEYS].sort(),
    )
    || input.version !== SOURCE_RECALL_POINT_REQUEST_VERSION
    || typeof input.reservationId !== "string"
    || !DIGEST.test(input.reservationId)
    || typeof input.contextDigest !== "string"
    || !DIGEST.test(input.contextDigest)
    || ![1, 2].includes(input.readNumber)
    || typeof input.botId !== "string"
    || !BOT_ID.test(input.botId)
  ) {
    fail(code);
  }
  const body = {
    version: SOURCE_RECALL_POINT_REQUEST_VERSION,
    reservationId: input.reservationId,
    contextDigest: input.contextDigest,
    readNumber: input.readNumber,
    botId: input.botId,
  };
  const rawBody = JSON.stringify(body);
  if (
    Buffer.byteLength(rawBody, "utf8")
      > SOURCE_RECALL_POINT_MAX_BODY_BYTES
  ) {
    fail(code);
  }
  const requestDigest = createHash("sha256")
    .update(REQUEST_DIGEST_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(rawBody, "utf8")
    .digest("hex");
  return Object.freeze({
    body: Object.freeze(body),
    rawBody,
    requestDigest,
  });
}

function dependencies(value) {
  if (value === undefined) {
    return Object.freeze({
      fetchImpl: globalThis.fetch,
      nowImpl: () => Date.now(),
      secret:
        process.env.PARAAI_RECALL_SOURCE_POINT_SECRET,
      signalFactory: (timeoutMs) =>
        AbortSignal.timeout(timeoutMs),
    });
  }
  const code =
    "SOURCE_RECALL_POINT_TEST_DEPENDENCIES_INVALID";
  const selected = plainRecordSnapshot(value, code);
  if (
    !sameKeys(
      Object.keys(selected).sort(),
      [...TEST_DEPENDENCY_KEYS].sort(),
    )
    || typeof selected.fetchImpl !== "function"
    || typeof selected.nowImpl !== "function"
    || typeof selected.signalFactory !== "function"
    || !(
      selected.secret === undefined
      || typeof selected.secret === "string"
    )
  ) {
    fail(code);
  }
  return selected;
}

function configuredSecret(value) {
  const selected = typeof value === "string"
    ? value.trim()
    : "";
  if (selected.length < MIN_SECRET_LENGTH) {
    fail("SOURCE_RECALL_POINT_CLIENT_NOT_CONFIGURED");
  }
  return selected;
}

function timestampSeconds(value) {
  const nowMs = Number(value);
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    fail("SOURCE_RECALL_POINT_CLIENT_CLOCK_INVALID");
  }
  const timestamp = String(Math.floor(nowMs / 1_000));
  if (!/^[0-9]{10}$/u.test(timestamp)) {
    fail("SOURCE_RECALL_POINT_CLIENT_CLOCK_INVALID");
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
      fail("SOURCE_RECALL_POINT_RESPONSE_INVALID");
    }
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared)
      || declared > SOURCE_RECALL_POINT_MAX_RESPONSE_BYTES
    ) {
      fail("SOURCE_RECALL_POINT_RESPONSE_INVALID");
    }
  }
  if (!response?.body) {
    fail("SOURCE_RECALL_POINT_RESPONSE_INVALID");
  }

  const chunks = [];
  let size = 0;
  const append = async (chunk, cancel) => {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    size += bytes.length;
    if (size > SOURCE_RECALL_POINT_MAX_RESPONSE_BYTES) {
      await Promise.resolve(cancel?.()).catch(() => {});
      fail("SOURCE_RECALL_POINT_RESPONSE_INVALID");
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
    fail("SOURCE_RECALL_POINT_RESPONSE_INVALID");
  }

  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      // Retain a BOM so different received bytes cannot collapse to one
      // accepted JSON document.
      ignoreBOM: true,
    }).decode(Buffer.concat(chunks, size));
  } catch {
    fail("SOURCE_RECALL_POINT_RESPONSE_INVALID");
  }
}

function validateJsonValue(value, seen = new WeakSet()) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("SOURCE_RECALL_POINT_RESPONSE_INVALID");
    }
    return;
  }
  if (
    !value
    || typeof value !== "object"
    || nodeTypes.isProxy(value)
    || seen.has(value)
  ) {
    fail("SOURCE_RECALL_POINT_RESPONSE_INVALID");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) validateJsonValue(child, seen);
  } else {
    const record = plainRecordSnapshot(
      value,
      "SOURCE_RECALL_POINT_RESPONSE_INVALID",
    );
    for (const child of Object.values(record)) {
      validateJsonValue(child, seen);
    }
  }
  seen.delete(value);
}

function deepFreeze(value) {
  if (
    value
    && typeof value === "object"
    && !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalResponse(value, request) {
  const code = "SOURCE_RECALL_POINT_RESPONSE_INVALID";
  const response = plainRecordSnapshot(value, code);
  if (
    !sameKeys(Object.keys(response), RESPONSE_KEYS)
    || response.version !== SOURCE_RECALL_POINT_RESPONSE_VERSION
    || response.reservationId
      !== request.body.reservationId
    || response.contextDigest
      !== request.body.contextDigest
    || response.readNumber !== request.body.readNumber
    || response.requestDigest !== request.requestDigest
  ) {
    fail(code);
  }
  const point = response.point;
  if (
    point === null
    || typeof point !== "object"
    || Array.isArray(point)
  ) {
    fail(code);
  }
  validateJsonValue(point);
  deepFreeze(point);
  return Object.freeze({
    point,
    transportReceipt: Object.freeze({
      version:
        SOURCE_RECALL_POINT_TRANSPORT_RECEIPT_VERSION,
      reservationId: request.body.reservationId,
      contextDigest: request.body.contextDigest,
      readNumber: request.body.readNumber,
      requestDigest: request.requestDigest,
    }),
  });
}

export async function readPrivateRecallSourcePoint(
  requestValue,
  testDependencies,
) {
  const request = canonicalRequest(requestValue);
  const {
    fetchImpl,
    nowImpl,
    secret: rawSecret,
    signalFactory,
  } = dependencies(testDependencies);
  if (typeof fetchImpl !== "function") {
    fail("SOURCE_RECALL_POINT_CLIENT_NOT_CONFIGURED");
  }
  const secret = configuredSecret(rawSecret);
  const timestamp = timestampSeconds(nowImpl());
  const signature = `v1=${createHmac("sha256", secret)
    .update(
      `${timestamp}.POST.${SOURCE_RECALL_POINT_PATH}.${request.rawBody}`,
      "utf8",
    )
    .digest("hex")}`;

  let response;
  try {
    response = await fetchImpl(
      SOURCE_RECALL_POINT_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-raydar-timestamp": timestamp,
          "x-raydar-signature": signature,
        },
        body: request.rawBody,
        cache: "no-store",
        redirect: "error",
        signal: signalFactory(
          SOURCE_RECALL_POINT_TIMEOUT_MS,
        ),
      },
    );
  } catch {
    fail("SOURCE_RECALL_POINT_UNAVAILABLE");
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
      fail("SOURCE_RECALL_POINT_UNAVAILABLE");
    }
    const raw = await boundedResponseText(response);
    const parsed = JSON.parse(raw);
    return canonicalResponse(parsed, request);
  } catch {
    await cancelResponseBody(response);
    fail("SOURCE_RECALL_POINT_UNAVAILABLE");
  }
}
