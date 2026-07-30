// Private, fail-closed client for the webview Paraform Human source page.
//
// This server-only module pins the canonical webview origin, signs the exact
// request bytes with a dedicated secret, performs one POST, and independently
// validates the complete private page response. It has no fallback
// credential, retry, redirect, logger, coordinator import, source authority,
// or candidate-facing output.

import { createHmac } from "node:crypto";
import {
  TextDecoder,
  types as nodeTypes,
} from "node:util";

export const SOURCE_PARAFORM_HUMAN_PAGE_CLIENT_VERSION =
  "paraform-human-private-page-client-v1";
export const SOURCE_PARAFORM_HUMAN_PAGE_VERSION =
  "paraai-paraform-human-source-page-v2";
export const SOURCE_PARAFORM_HUMAN_PAGE_ORIGIN =
  "https://webview-lake.vercel.app";
export const SOURCE_PARAFORM_HUMAN_PAGE_PATH =
  "/api/paraai-paraform-human-source-page";
export const SOURCE_PARAFORM_HUMAN_PAGE_URL =
  `${SOURCE_PARAFORM_HUMAN_PAGE_ORIGIN}`
  + SOURCE_PARAFORM_HUMAN_PAGE_PATH;
export const SOURCE_PARAFORM_HUMAN_PAGE_TIMEOUT_MS = 20_000;
export const SOURCE_PARAFORM_HUMAN_PAGE_MAX_BODY_BYTES =
  32 * 1024;
export const SOURCE_PARAFORM_HUMAN_PAGE_MAX_RESPONSE_BYTES =
  4 * 1024 * 1024;
export const SOURCE_PARAFORM_HUMAN_PAGE_SIZE = 50;
export const SOURCE_PARAFORM_HUMAN_PAGE_MAX_EMAILS = 32;

const MIN_SECRET_LENGTH = 32;
const REQUEST_KEYS = Object.freeze([
  "boundaryAt",
  "checkpoint",
]);
const CHECKPOINT_KEYS = Object.freeze([
  "boundaryAt",
  "cursor",
  "version",
]);
const RESPONSE_KEYS = Object.freeze([
  "boundaryAt",
  "exhausted",
  "nextCheckpoint",
  "outsideBoundary",
  "references",
  "scanned",
  "version",
]);
const REFERENCE_KEYS = Object.freeze([
  "candidate",
  "candidateUserId",
  "createdAt",
  "hasTranscript",
  "humanCall",
  "id",
  "owner",
  "ownerId",
  "platform",
  "recordingProvider",
  "scheduledAt",
  "title",
]);
const CANDIDATE_KEYS = Object.freeze([
  "emails",
  "linkedin",
  "name",
]);
const TEST_DEPENDENCY_KEYS = Object.freeze([
  "fetchImpl",
  "nowImpl",
  "secret",
  "signalFactory",
]);

export class SourceParaformHumanPageClientError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceParaformHumanPageClientError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceParaformHumanPageClientError(code);
}

function sameKeys(actual, expected) {
  return (
    actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
  );
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

function exactRecord(value, expectedKeys, code) {
  const record = plainRecordSnapshot(value, code);
  if (
    !sameKeys(
      Object.keys(record).sort(),
      [...expectedKeys].sort(),
    )
  ) {
    fail(code);
  }
  return record;
}

function denseArraySnapshot(value, code) {
  if (
    !Array.isArray(value)
    || nodeTypes.isProxy(value)
    || Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length;
  if (
    !length
    || !Object.prototype.hasOwnProperty.call(length, "value")
    || length.value !== value.length
  ) {
    fail(code);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor
      || !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value",
      )
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    result.push(descriptor.value);
  }
  const allowed = new Set([
    "length",
    ...result.map((_item, index) => String(index)),
  ]);
  if (
    Object.keys(descriptors).some((key) => !allowed.has(key))
  ) {
    fail(code);
  }
  return result;
}

function canonicalTimestamp(value, code) {
  if (
    typeof value !== "string"
    || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u
      .test(value)
  ) {
    fail(code);
  }
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value
  ) {
    fail(code);
  }
  return value;
}

function canonicalCheckpoint(value, boundaryAt, code) {
  if (value === null) return null;
  const checkpoint = exactRecord(value, CHECKPOINT_KEYS, code);
  if (
    checkpoint.version !== SOURCE_PARAFORM_HUMAN_PAGE_VERSION
    || canonicalTimestamp(checkpoint.boundaryAt, code)
      !== boundaryAt
    || !Number.isSafeInteger(checkpoint.cursor)
    || checkpoint.cursor < 1
  ) {
    fail(code);
  }
  return Object.freeze({
    version: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    boundaryAt,
    cursor: checkpoint.cursor,
  });
}

function canonicalRequest(value) {
  const code = "SOURCE_PARAFORM_HUMAN_PAGE_REQUEST_INVALID";
  const request = exactRecord(value, REQUEST_KEYS, code);
  const boundaryAt = canonicalTimestamp(
    request.boundaryAt,
    code,
  );
  const checkpoint = canonicalCheckpoint(
    request.checkpoint,
    boundaryAt,
    code,
  );
  const body = Object.freeze({
    boundaryAt,
    checkpoint,
  });
  const rawBody = JSON.stringify(body);
  if (
    Buffer.byteLength(rawBody, "utf8")
      > SOURCE_PARAFORM_HUMAN_PAGE_MAX_BODY_BYTES
  ) {
    fail(code);
  }
  return Object.freeze({
    body,
    currentCursor: checkpoint?.cursor ?? 0,
    rawBody,
  });
}

function configuredSecret(value) {
  if (typeof value !== "string") {
    fail("SOURCE_PARAFORM_HUMAN_PAGE_CLIENT_NOT_CONFIGURED");
  }
  const secret = value.trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    fail("SOURCE_PARAFORM_HUMAN_PAGE_CLIENT_NOT_CONFIGURED");
  }
  return secret;
}

function dependencies(overrides) {
  if (overrides === undefined) {
    return Object.freeze({
      fetchImpl: fetch,
      nowImpl: Date.now,
      secret:
        process.env.PARAAI_PARAFORM_HUMAN_SOURCE_PAGE_SECRET,
      signalFactory: (timeoutMs) =>
        AbortSignal.timeout(timeoutMs),
    });
  }
  const code =
    "SOURCE_PARAFORM_HUMAN_PAGE_CLIENT_DEPENDENCIES_INVALID";
  const selected = exactRecord(
    overrides,
    TEST_DEPENDENCY_KEYS,
    code,
  );
  if (
    typeof selected.fetchImpl !== "function"
    || typeof selected.nowImpl !== "function"
    || typeof selected.signalFactory !== "function"
  ) {
    fail(code);
  }
  return selected;
}

function timestampSeconds(value) {
  const nowMs = Number(value);
  const seconds = Math.floor(nowMs / 1_000);
  const text = String(seconds);
  if (
    !Number.isSafeInteger(seconds)
    || seconds < 0
    || !/^[0-9]{10}$/u.test(text)
  ) {
    fail("SOURCE_PARAFORM_HUMAN_PAGE_CLIENT_CLOCK_INVALID");
  }
  return text;
}

function signature(secret, timestamp, rawBody) {
  return `v1=${createHmac("sha256", secret)
    .update(
      (
        `${timestamp}.POST.`
        + `${SOURCE_PARAFORM_HUMAN_PAGE_PATH}.${rawBody}`
      ),
      "utf8",
    )
    .digest("hex")}`;
}

function responseHeader(headers, name) {
  if (headers?.get) return String(headers.get(name) || "");
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

async function boundedResponseText(response) {
  const code = "SOURCE_PARAFORM_HUMAN_PAGE_UNAVAILABLE";
  const contentLength = responseHeader(
    response?.headers,
    "content-length",
  );
  if (contentLength) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      fail(code);
    }
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared)
      || declared > SOURCE_PARAFORM_HUMAN_PAGE_MAX_RESPONSE_BYTES
    ) {
      fail(code);
    }
  }
  if (!response?.body) return "";
  const chunks = [];
  let size = 0;
  const append = async (chunk, cancel = null) => {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    size += bytes.length;
    if (size > SOURCE_PARAFORM_HUMAN_PAGE_MAX_RESPONSE_BYTES) {
      if (typeof cancel === "function") {
        await Promise.resolve(cancel()).catch(() => {});
      }
      fail(code);
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
    for await (const chunk of response.body) {
      await append(chunk);
    }
  } else {
    fail(code);
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(Buffer.concat(chunks, size));
  } catch {
    fail(code);
  }
}

function boundedText(value, maximum, {
  allowEmpty = true,
  lowercase = false,
  uppercase = false,
} = {}) {
  const code = "SOURCE_PARAFORM_HUMAN_PAGE_RESPONSE_INVALID";
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || (lowercase && value.toLowerCase() !== value)
    || (uppercase && value.toUpperCase() !== value)
  ) {
    fail(code);
  }
  return value;
}

function canonicalCandidate(value) {
  const code = "SOURCE_PARAFORM_HUMAN_PAGE_RESPONSE_INVALID";
  const candidate = exactRecord(value, CANDIDATE_KEYS, code);
  const emails = denseArraySnapshot(candidate.emails, code);
  if (emails.length > SOURCE_PARAFORM_HUMAN_PAGE_MAX_EMAILS) {
    fail(code);
  }
  return Object.freeze({
    name: boundedText(candidate.name, 512),
    linkedin: boundedText(candidate.linkedin, 4_096),
    emails: Object.freeze(emails.map((email) => boundedText(
      email,
      512,
      { allowEmpty: false, lowercase: true },
    ))),
  });
}

function canonicalReference(value, boundaryAt) {
  const code = "SOURCE_PARAFORM_HUMAN_PAGE_RESPONSE_INVALID";
  const reference = exactRecord(value, REFERENCE_KEYS, code);
  const scheduledAt = canonicalTimestamp(
    reference.scheduledAt,
    code,
  );
  const createdAt = canonicalTimestamp(
    reference.createdAt,
    code,
  );
  if (
    Date.parse(scheduledAt) >= Date.parse(boundaryAt)
    || Date.parse(createdAt) >= Date.parse(boundaryAt)
    || (
      reference.hasTranscript !== null
      && typeof reference.hasTranscript !== "boolean"
    )
    || typeof reference.humanCall !== "boolean"
  ) {
    fail(code);
  }
  const platform = boundedText(reference.platform, 256, {
    uppercase: true,
  });
  const recordingProvider = boundedText(
    reference.recordingProvider,
    256,
    { uppercase: true },
  );
  const humanCall = (
    platform === "PHONE"
    && recordingProvider === "TWILIO"
  );
  if (reference.humanCall !== humanCall) fail(code);
  return Object.freeze({
    id: boundedText(reference.id, 256, {
      allowEmpty: false,
    }),
    scheduledAt,
    createdAt,
    title: boundedText(reference.title, 4_096),
    platform,
    recordingProvider,
    owner: boundedText(reference.owner, 512),
    ownerId: boundedText(reference.ownerId, 256),
    candidateUserId: boundedText(
      reference.candidateUserId,
      256,
    ),
    hasTranscript: reference.hasTranscript,
    humanCall,
    candidate: canonicalCandidate(reference.candidate),
  });
}

function canonicalResponse(value, request) {
  const code = "SOURCE_PARAFORM_HUMAN_PAGE_RESPONSE_INVALID";
  const response = exactRecord(value, RESPONSE_KEYS, code);
  if (
    response.version !== SOURCE_PARAFORM_HUMAN_PAGE_VERSION
    || canonicalTimestamp(response.boundaryAt, code)
      !== request.body.boundaryAt
    || typeof response.exhausted !== "boolean"
    || !Number.isSafeInteger(response.scanned)
    || response.scanned < 0
    || response.scanned > SOURCE_PARAFORM_HUMAN_PAGE_SIZE
    || !Number.isSafeInteger(response.outsideBoundary)
    || response.outsideBoundary < 0
    || response.outsideBoundary > response.scanned
  ) {
    fail(code);
  }
  const nextCheckpoint = canonicalCheckpoint(
    response.nextCheckpoint,
    request.body.boundaryAt,
    code,
  );
  if (
    response.exhausted !== (nextCheckpoint === null)
    || (
      nextCheckpoint
      && (
        response.scanned < 1
        || nextCheckpoint.cursor
          !== request.currentCursor + response.scanned
      )
    )
  ) {
    fail(code);
  }
  const rawReferences = denseArraySnapshot(
    response.references,
    code,
  );
  if (
    rawReferences.length
      > response.scanned - response.outsideBoundary
    || rawReferences.length > SOURCE_PARAFORM_HUMAN_PAGE_SIZE
  ) {
    fail(code);
  }
  const references = rawReferences.map(
    (reference) => canonicalReference(
      reference,
      request.body.boundaryAt,
    ),
  );
  const ids = new Set();
  let priorScheduledAt = null;
  for (const reference of references) {
    if (
      ids.has(reference.id)
      || (
        priorScheduledAt !== null
        && reference.scheduledAt > priorScheduledAt
      )
    ) {
      fail(code);
    }
    ids.add(reference.id);
    priorScheduledAt = reference.scheduledAt;
  }
  return Object.freeze({
    version: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    boundaryAt: request.body.boundaryAt,
    exhausted: response.exhausted,
    nextCheckpoint,
    scanned: response.scanned,
    outsideBoundary: response.outsideBoundary,
    references: Object.freeze(references),
  });
}

export async function readPrivateParaformHumanSourcePage(
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
  const secret = configuredSecret(rawSecret);
  const timestamp = timestampSeconds(nowImpl());
  const signed = signature(secret, timestamp, request.rawBody);
  let response;
  try {
    response = await fetchImpl(
      SOURCE_PARAFORM_HUMAN_PAGE_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-raydar-timestamp": timestamp,
          "x-raydar-signature": signed,
        },
        body: request.rawBody,
        cache: "no-store",
        redirect: "error",
        signal: signalFactory(
          SOURCE_PARAFORM_HUMAN_PAGE_TIMEOUT_MS,
        ),
      },
    );
  } catch {
    fail("SOURCE_PARAFORM_HUMAN_PAGE_UNAVAILABLE");
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
    ) {
      fail("SOURCE_PARAFORM_HUMAN_PAGE_UNAVAILABLE");
    }
    const raw = await boundedResponseText(response);
    return canonicalResponse(JSON.parse(raw), request);
  } catch {
    fail("SOURCE_PARAFORM_HUMAN_PAGE_UNAVAILABLE");
  }
}
