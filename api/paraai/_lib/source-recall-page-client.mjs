// Private, fail-closed client for the Calls Recall source-page transport.
//
// This module is server-side only. It pins the canonical Calls origin, signs
// the exact request bytes with the dedicated source-page secret, performs one
// POST, and independently validates the complete normalized page response.
// It has no fallback credential, browser surface, retry, redirect, logger,
// source authority, or candidate-facing output.

import {
  createHmac,
} from "node:crypto";
import {
  types as nodeTypes,
  TextDecoder,
} from "node:util";

export const SOURCE_RECALL_PAGE_CLIENT_VERSION =
  "recall-private-page-client-v1";
export const SOURCE_RECALL_PAGE_VERSION =
  "paraai-recall-source-page-v1";
export const SOURCE_RECALL_PAGE_ORIGIN =
  "https://raydar-calls.vercel.app";
export const SOURCE_RECALL_PAGE_PATH =
  "/api/paraai-source-page";
export const SOURCE_RECALL_PAGE_URL =
  `${SOURCE_RECALL_PAGE_ORIGIN}${SOURCE_RECALL_PAGE_PATH}`;
export const SOURCE_RECALL_PAGE_TIMEOUT_MS = 20_000;
export const SOURCE_RECALL_PAGE_MAX_BODY_BYTES = 32 * 1024;
export const SOURCE_RECALL_PAGE_MAX_RESPONSE_BYTES =
  16 * 1024 * 1024;
export const SOURCE_RECALL_PAGE_SIZE = 100;

const MIN_SECRET_LENGTH = 32;
const MAX_CURSOR_LENGTH = 8_192;
const MAX_SEEN_CURSORS = 200;
const MAX_REFERENCE_ID_LENGTH = 128;
const SOURCE_BASE = "https://us-west-2.recall.ai/api/v1";
const SOURCE_ORIGIN = new URL(SOURCE_BASE).origin;
const SOURCE_BOT_PATH = `${new URL(SOURCE_BASE).pathname}/bot/`;
const SOURCE_METADATA = new Set([
  "paraform-auto",
  "paraform-auto-guardian",
  "paraform-reconciliation",
  "paraform-reconciliation-guardian",
  "fyxer-guardian-n8n",
  "fyxer-guardian-n8n-guardian",
]);
const REQUEST_KEYS = Object.freeze([
  "boundaryAt",
  "cursor",
  "seenCursors",
]);
const RESPONSE_KEYS = Object.freeze([
  "boundaryAt",
  "exhausted",
  "nextCursor",
  "references",
  "scanned",
  "version",
]);
const REFERENCE_KEYS = Object.freeze([
  "candidate",
  "id",
  "joinAt",
  "metadataSource",
]);
const CANDIDATE_KEYS = Object.freeze([
  "email",
  "fullName",
  "linkedin",
  "paraformEventId",
]);
const TEST_DEPENDENCY_KEYS = Object.freeze([
  "fetchImpl",
  "nowImpl",
  "secret",
  "signalFactory",
]);

export class SourceRecallPageClientError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallPageClientError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallPageClientError(code);
}

function sameKeys(actual, expected) {
  if (actual.length !== expected.length) return false;
  return actual.every((key, index) => key === expected[index]);
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
  const items = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor
      || !Object.prototype.hasOwnProperty.call(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    items.push(descriptor.value);
  }
  const allowed = new Set([
    "length",
    ...items.map((_, index) => String(index)),
  ]);
  if (
    Object.keys(descriptors).some((key) => !allowed.has(key))
  ) {
    fail(code);
  }
  return items;
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
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
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

function exactRecord(value, keys, code) {
  const record = plainRecordSnapshot(value, code);
  if (!sameKeys(Object.keys(record).sort(), [...keys].sort())) {
    fail(code);
  }
  return record;
}

function canonicalBoundary(value, code) {
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

function canonicalCursor(value, boundaryAt, code) {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_CURSOR_LENGTH
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code);
  }
  let parsed;
  try {
    parsed = value.startsWith("/bot/")
      ? new URL(`${SOURCE_BASE}${value}`)
      : new URL(value, `${SOURCE_BASE}/`);
  } catch {
    fail(code);
  }
  const exactParam = (name, expected) => (
    parsed.searchParams.getAll(name).length === 1
    && parsed.searchParams.get(name) === expected
  );
  const allowed = new Set([
    "ordering",
    "page_size",
    "join_at_before",
    "page",
  ]);
  const pages = parsed.searchParams.getAll("page");
  const pageText = pages[0] || "";
  const pageNumber = Number(pageText);
  if (
    parsed.origin !== SOURCE_ORIGIN
    || parsed.pathname !== SOURCE_BOT_PATH
    || !exactParam("ordering", "-join_at")
    || !exactParam("page_size", String(SOURCE_RECALL_PAGE_SIZE))
    || !exactParam("join_at_before", boundaryAt)
    || [...parsed.searchParams.keys()].some(
      (name) => !allowed.has(name),
    )
    || pages.length !== 1
    || !/^[1-9][0-9]*$/u.test(pageText)
    || !Number.isSafeInteger(pageNumber)
    || pageNumber < 2
  ) {
    fail(code);
  }
  const query = new URLSearchParams({
    ordering: "-join_at",
    page_size: String(SOURCE_RECALL_PAGE_SIZE),
    join_at_before: boundaryAt,
  });
  query.set("page", pageText);
  return `/bot/?${query}`;
}

function cursorPage(value, boundaryAt, code) {
  if (value === null) return 1;
  return Number(
    new URL(
      canonicalCursor(value, boundaryAt, code),
      "https://collector.invalid",
    ).searchParams.get("page"),
  );
}

function canonicalRequest(value) {
  const code = "SOURCE_RECALL_PAGE_REQUEST_INVALID";
  const request = exactRecord(value, REQUEST_KEYS, code);
  const boundaryAt = canonicalBoundary(request.boundaryAt, code);
  const cursor = canonicalCursor(request.cursor, boundaryAt, code);
  const rawSeenCursors = denseArraySnapshot(
    request.seenCursors,
    code,
  );
  if (rawSeenCursors.length > MAX_SEEN_CURSORS) {
    fail(code);
  }
  const seenCursors = rawSeenCursors.map(
    (seen) => canonicalCursor(seen, boundaryAt, code),
  );
  if (seenCursors.some((seen) => seen === null)) fail(code);
  const currentPage = cursorPage(cursor, boundaryAt, code);
  if (seenCursors.length !== Math.max(0, currentPage - 2)) {
    fail(code);
  }
  for (let index = 0; index < seenCursors.length; index += 1) {
    if (
      cursorPage(seenCursors[index], boundaryAt, code)
        !== index + 2
    ) {
      fail(code);
    }
  }
  if (cursor !== null && seenCursors.includes(cursor)) fail(code);
  const normalized = Object.freeze({
    boundaryAt,
    cursor,
    seenCursors: Object.freeze([...seenCursors]),
  });
  const rawBody = JSON.stringify(normalized);
  if (
    Buffer.byteLength(rawBody, "utf8")
      > SOURCE_RECALL_PAGE_MAX_BODY_BYTES
  ) {
    fail(code);
  }
  return Object.freeze({
    body: normalized,
    currentPage,
    rawBody,
  });
}

function configuredSecret(value) {
  if (typeof value !== "string") {
    fail("SOURCE_RECALL_PAGE_CLIENT_NOT_CONFIGURED");
  }
  const secret = value.trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    fail("SOURCE_RECALL_PAGE_CLIENT_NOT_CONFIGURED");
  }
  return secret;
}

function dependencies(overrides) {
  if (overrides === undefined) {
    return Object.freeze({
      fetchImpl: fetch,
      nowImpl: Date.now,
      secret: process.env.PARAAI_RECALL_SOURCE_PAGE_SECRET,
      signalFactory: (timeoutMs) =>
        AbortSignal.timeout(timeoutMs),
    });
  }
  const code = "SOURCE_RECALL_PAGE_CLIENT_DEPENDENCIES_INVALID";
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

function timestampSeconds(nowValue) {
  const nowMs = Number(nowValue);
  const seconds = Math.floor(nowMs / 1_000);
  const text = String(seconds);
  if (
    !Number.isSafeInteger(seconds)
    || seconds < 0
    || !/^[0-9]{10}$/u.test(text)
  ) {
    fail("SOURCE_RECALL_PAGE_CLIENT_CLOCK_INVALID");
  }
  return text;
}

function signature(secret, timestamp, rawBody) {
  return `v1=${createHmac("sha256", secret)
    .update(
      `${timestamp}.POST.${SOURCE_RECALL_PAGE_PATH}.${rawBody}`,
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
  const contentLength = responseHeader(
    response?.headers,
    "content-length",
  );
  if (contentLength) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      fail("SOURCE_RECALL_PAGE_UNAVAILABLE");
    }
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared)
      || declared > SOURCE_RECALL_PAGE_MAX_RESPONSE_BYTES
    ) {
      fail("SOURCE_RECALL_PAGE_UNAVAILABLE");
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
    if (size > SOURCE_RECALL_PAGE_MAX_RESPONSE_BYTES) {
      if (typeof cancel === "function") {
        await Promise.resolve(cancel()).catch(() => {});
      }
      fail("SOURCE_RECALL_PAGE_UNAVAILABLE");
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
    fail("SOURCE_RECALL_PAGE_UNAVAILABLE");
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(Buffer.concat(chunks, size));
  } catch {
    fail("SOURCE_RECALL_PAGE_UNAVAILABLE");
  }
}

function boundedText(value, maximum, {
  lowercase = false,
} = {}) {
  if (
    typeof value !== "string"
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || (lowercase && value.toLowerCase() !== value)
  ) {
    fail("SOURCE_RECALL_PAGE_RESPONSE_INVALID");
  }
  return value;
}

function canonicalReference(value, boundaryAt) {
  const code = "SOURCE_RECALL_PAGE_RESPONSE_INVALID";
  const reference = exactRecord(value, REFERENCE_KEYS, code);
  if (
    typeof reference.id !== "string"
    || reference.id.length < 5
    || reference.id.length > MAX_REFERENCE_ID_LENGTH
    || !/^[A-Za-z0-9_-]+$/u.test(reference.id)
  ) {
    fail(code);
  }
  const joinAt = canonicalBoundary(reference.joinAt, code);
  if (Date.parse(joinAt) >= Date.parse(boundaryAt)) fail(code);
  if (!SOURCE_METADATA.has(reference.metadataSource)) fail(code);
  const candidate = exactRecord(
    reference.candidate,
    CANDIDATE_KEYS,
    code,
  );
  const normalized = {
    fullName: boundedText(candidate.fullName, 512),
    email: boundedText(candidate.email, 512, {
      lowercase: true,
    }),
    linkedin: boundedText(candidate.linkedin, 4_096),
    paraformEventId: boundedText(
      candidate.paraformEventId,
      1_024,
    ),
  };
  return Object.freeze({
    id: reference.id,
    joinAt,
    metadataSource: reference.metadataSource,
    candidate: Object.freeze(normalized),
  });
}

function canonicalResponse(value, request) {
  const code = "SOURCE_RECALL_PAGE_RESPONSE_INVALID";
  const response = exactRecord(value, RESPONSE_KEYS, code);
  if (
    response.version !== SOURCE_RECALL_PAGE_VERSION
    || canonicalBoundary(response.boundaryAt, code)
      !== request.body.boundaryAt
    || typeof response.exhausted !== "boolean"
    || !Number.isSafeInteger(response.scanned)
    || response.scanned < 0
    || response.scanned > SOURCE_RECALL_PAGE_SIZE
  ) {
    fail(code);
  }
  const rawReferences = denseArraySnapshot(
    response.references,
    code,
  );
  if (
    rawReferences.length > response.scanned
    || rawReferences.length > SOURCE_RECALL_PAGE_SIZE
  ) {
    fail(code);
  }
  const nextCursor = canonicalCursor(
    response.nextCursor,
    request.body.boundaryAt,
    code,
  );
  if (response.exhausted !== (nextCursor === null)) fail(code);
  if (
    nextCursor !== null
    && (
      cursorPage(
        nextCursor,
        request.body.boundaryAt,
        code,
      ) !== request.currentPage + 1
      || request.body.seenCursors.includes(nextCursor)
      || nextCursor === request.body.cursor
    )
  ) {
    fail(code);
  }
  const references = rawReferences.map(
    (reference) => canonicalReference(
      reference,
      request.body.boundaryAt,
    ),
  );
  const seenIds = new Set();
  let priorJoinAt = null;
  for (const reference of references) {
    if (seenIds.has(reference.id)) fail(code);
    if (
      priorJoinAt !== null
      && reference.joinAt > priorJoinAt
    ) {
      fail(code);
    }
    seenIds.add(reference.id);
    priorJoinAt = reference.joinAt;
  }
  return Object.freeze({
    version: SOURCE_RECALL_PAGE_VERSION,
    boundaryAt: request.body.boundaryAt,
    exhausted: response.exhausted,
    nextCursor,
    scanned: response.scanned,
    references: Object.freeze(references),
  });
}

export async function readPrivateRecallSourcePage(
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
    response = await fetchImpl(SOURCE_RECALL_PAGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-raydar-timestamp": timestamp,
        "x-raydar-signature": signed,
      },
      body: request.rawBody,
      cache: "no-store",
      redirect: "error",
      signal: signalFactory(SOURCE_RECALL_PAGE_TIMEOUT_MS),
    });
  } catch {
    fail("SOURCE_RECALL_PAGE_UNAVAILABLE");
  }
  try {
    if (
      !response
      || response.status !== 200
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
        responseHeader(response.headers, "content-type").trim(),
      )
    ) {
      fail("SOURCE_RECALL_PAGE_UNAVAILABLE");
    }
    const raw = await boundedResponseText(response);
    const parsed = JSON.parse(raw);
    return canonicalResponse(parsed, request);
  } catch {
    fail("SOURCE_RECALL_PAGE_UNAVAILABLE");
  }
}
