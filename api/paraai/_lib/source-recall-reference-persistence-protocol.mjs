// Hard-dark Recall reference persistence protocol and state machine.
//
// This module has no production persistence adapter, environment topology,
// route, scheduler, or coordinator import. A separately reviewed injected
// persistence implementation would have to satisfy every exact receipt,
// Redis-time, CAS, readback, and retention proof below before this state
// machine can durably advance.
// Pass-one private pages are never renewed or exposed after comparison; they
// retain only their original, non-extendable 24-hour absolute expiry. Every
// observable sealed result re-proves the retained pass-two page set.
//
// The protocol models exactly two sequential exhaustive reads of the private
// Calls page transport at one boundary. Each source read is claimed durably
// before I/O. Deadline-sensitive transitions first persist an unobservable
// pending-validation record that preserves the prior logical state. An exact
// on-time staging receipt proves the transition deadline before one
// digest-bound promotion can expose it; promotion itself creates no new source
// evidence. A concurrent call is a no-op, and an abandoned/failed claim
// invalidates the run instead of issuing another provider read. Exact page
// references are kept only in private page records. The sealed head and every
// aggregate contain digests/counts only and explicitly provide no source
// facts, point-read proof, success classification, identity resolution,
// pinning, or authority.

import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  performance,
} from "node:perf_hooks";
import {
  types as nodeTypes,
} from "node:util";

import {
  SOURCE_RECALL_PAGE_CLIENT_VERSION,
  SOURCE_RECALL_PAGE_SIZE,
  SOURCE_RECALL_PAGE_TIMEOUT_MS,
  SOURCE_RECALL_PAGE_VERSION,
} from "./source-recall-page-client.mjs";

export const SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION =
  "recall-reference-head-dark-v1";
export const SOURCE_RECALL_REFERENCE_RECORD_VERSION = 1;
export const SOURCE_RECALL_REFERENCE_REQUIRED_PASSES = 2;
export const SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS = 150_000;
export const SOURCE_RECALL_REFERENCE_CLAIM_PREPARATION_MARGIN_MS =
  60_000;
export const SOURCE_RECALL_REFERENCE_PROVIDER_HANDOFF_MARGIN_MS =
  1_000;
export const SOURCE_RECALL_REFERENCE_CHECKPOINT_COMMIT_MARGIN_MS =
  60_000;
export const SOURCE_RECALL_REFERENCE_ATOMIC_COMMIT_BUDGET_MS =
  15_000;
export const SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS =
  24 * 60 * 60 * 1_000;
export const SOURCE_RECALL_REFERENCE_MAX_COLLECTION_AGE_MS =
  4 * 60 * 60 * 1_000;
export const SOURCE_RECALL_REFERENCE_MIN_PAGE_RETENTION_MS =
  SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS
  - SOURCE_RECALL_REFERENCE_MAX_COLLECTION_AGE_MS;
export const SOURCE_RECALL_REFERENCE_MIN_SEALED_RETENTION_MS =
  SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS;
export const SOURCE_RECALL_REFERENCE_MAX_PAGES = 200;

const DIGEST = /^[a-f0-9]{64}$/u;
const NATIVE_BYTE_PROOF_DIGEST = /^[a-f0-9]{40}$/u;
const SOURCE = "recall";
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
const RUN_PREFIX = "paraai:phase4:recall-reference:run:v1:";
const PAGE_PREFIX = "paraai:phase4:recall-reference:page:v1:";
const HEAD_PREFIX = "paraai:phase4:recall-reference:head:v1:";
const RUN_KEYS = Object.freeze([
  "activeClaim",
  "clientVersion",
  "contractPinsDigest",
  "createdAtMs",
  "decisionBoundaryAtMs",
  "headRecordDigest",
  "invalidReason",
  "kind",
  "passes",
  "pendingValidation",
  "policyVersion",
  "revision",
  "runNonceDigest",
  "source",
  "status",
  "updatedAtMs",
  "version",
  "workKeyDigest",
]);
const PASS_KEYS = Object.freeze([
  "completedAtMs",
  "lastJoinAt",
  "nextCursor",
  "nextPageNumber",
  "pageCount",
  "pageManifests",
  "passNumber",
  "referenceCount",
  "referenceManifestDigest",
  "scannedCount",
  "seenCursors",
  "semanticDigest",
  "startedAtMs",
  "status",
]);
const ACTIVE_CLAIM_KEYS = Object.freeze([
  "claimNonceDigest",
  "expiresAtMs",
  "issuedAtMs",
  "pageNumber",
  "passNumber",
  "requestDigest",
]);
const PENDING_VALIDATION_KEYS = Object.freeze([
  "nextRecordDigest",
  "notAfterMs",
  "recoveryExpiresAtMs",
]);
const MANIFEST_KEYS = Object.freeze([
  "cursorDigest",
  "firstJoinAt",
  "lastJoinAt",
  "nextCursorDigest",
  "pageExpiresAtMs",
  "pageNativeByteProofDigest",
  "pageNumber",
  "pageRecordDigest",
  "pageSemanticDigest",
  "referenceCommitments",
  "referenceCount",
  "scannedCount",
]);
const REFERENCE_COMMITMENT_KEYS = Object.freeze([
  "referenceDigest",
  "referenceIdDigest",
]);
const CONTEXT_KEYS = Object.freeze([
  "contractPinsDigest",
  "decisionBoundaryAtMs",
  "runNonceDigest",
]);
const WORK_KEYS = Object.freeze(["workKeyDigest"]);
const PRIVATE_PAGE_READ_KEYS = Object.freeze([
  "pageNumber",
  "workKeyDigest",
]);
const PRIVATE_PAGE_RECORD_KEYS = Object.freeze([
  "clientVersion",
  "contractPinsDigest",
  "cursor",
  "decisionBoundaryAtMs",
  "kind",
  "nextCursor",
  "pageExpiresAtMs",
  "pageNumber",
  "pageSemanticDigest",
  "passNumber",
  "policyVersion",
  "referenceCount",
  "references",
  "runNonceDigest",
  "scannedCount",
  "source",
  "version",
  "workKeyDigest",
]);
const FACTORY_KEYS = Object.freeze(["persistence"]);
const CLAIM_KEYS = Object.freeze([
  "boundaryAt",
  "claimNonceDigest",
  "cursor",
  "passNumber",
  "pageNumber",
  "requestDigest",
  "seenCursors",
  "sourceReadStartDeadlineMonotonicMs",
  "status",
  "workKeyDigest",
]);
const PAGE_KEYS = Object.freeze([
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
const PAGE_MANIFEST_HEAD_KEYS = Object.freeze([
  "cursorDigest",
  "nextCursorDigest",
  "pageExpiresAtMs",
  "pageNativeByteProofDigest",
  "pageNumber",
  "pageRecordDigest",
  "pageSemanticDigest",
  "referenceCount",
  "scannedCount",
]);
const HEAD_KEYS = Object.freeze([
  "authorityAvailable",
  "candidateIdentityResolutionAvailable",
  "clientVersion",
  "contractPinsDigest",
  "decisionBoundaryAtMs",
  "kind",
  "pageCount",
  "pageManifests",
  "passCount",
  "pinnable",
  "pointReadAvailable",
  "policyVersion",
  "referenceCount",
  "referenceManifestDigest",
  "runNonceDigest",
  "scannedCount",
  "sealedAtMs",
  "source",
  "sourceFactsAvailable",
  "recallReferenceHeadEpochDigest",
  "recallReferenceHeadRevisionDigest",
  "stablePassSemanticDigest",
  "successClassificationAvailable",
  "version",
  "workKeyDigest",
]);
const PERSISTENCE_METHODS = Object.freeze([
  "compareAndSet",
  "ensure",
  "readHead",
  "readPage",
  "readRun",
  "verifyArtifactSet",
]);
const ENSURE_RESULT_KEYS = Object.freeze([
  "raw",
  "redisNowMs",
  "status",
]);
const READ_RESULT_KEYS = Object.freeze([
  "raw",
  "redisNowMs",
]);
const PRIVATE_PAGE_READ_RESULT_KEYS = Object.freeze([
  "raw",
  "redisNowMs",
  "remainingTtlMs",
]);
const CAS_RESULT_KEYS = Object.freeze([
  "headReceipt",
  "pageReceipt",
  "pageSetReceipt",
  "raw",
  "redisNowMs",
  "status",
]);
const PAGE_RECEIPT_KEYS = Object.freeze([
  "expiresAtMs",
  "keyDigest",
  "rawDigest",
  "ttlMs",
]);
const HEAD_RECEIPT_KEYS = Object.freeze([
  "keyDigest",
  "rawDigest",
]);
const PAGE_SET_RECEIPT_KEYS = Object.freeze([
  "count",
  "requestDigest",
  "verifiedAtMs",
]);
const ARTIFACT_SET_VERIFY_RESULT_KEYS = Object.freeze([
  "artifactSetReceipt",
  "redisNowMs",
  "status",
]);
const ARTIFACT_SET_RECEIPT_KEYS = Object.freeze([
  "count",
  "requestDigest",
  "verifiedAtMs",
]);
const REQUIRED_PAGE_KEYS = Object.freeze([
  "expectedExpiresAtMs",
  "key",
  "minimumRemainingTtlMs",
  "nativeByteProofDigest",
  "rawDigest",
]);

export class SourceRecallReferencePersistenceProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallReferencePersistenceProtocolError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallReferencePersistenceProtocolError(code);
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
  return snapshot;
}

function exactRecord(value, keys, code) {
  const record = plainRecordSnapshot(value, code);
  if (!sameKeys(Object.keys(record).sort(), [...keys].sort())) {
    fail(code);
  }
  return record;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(
      "SOURCE_RECALL_REFERENCE_CANONICAL_VALUE_INVALID",
    );
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  fail("SOURCE_RECALL_REFERENCE_CANONICAL_VALUE_INVALID");
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function rawDigest(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function digest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
  return value;
}

function optionalDigest(value, code) {
  return value === null ? null : digest(value, code);
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function optionalTime(value, code) {
  return value === null ? null : nonNegativeInteger(value, code);
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cursor(value, code) {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 8_192
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code);
  }
  return value;
}

function canonicalRecallCursor(value, boundaryAt, code) {
  if (value === null) return null;
  cursor(value, code);
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

function recallCursorPage(value, boundaryAt, code) {
  if (value === null) return 1;
  return Number(
    new URL(
      canonicalRecallCursor(value, boundaryAt, code),
      "https://collector.invalid",
    ).searchParams.get("page"),
  );
}

function canonicalBoundaryFromMs(value, code) {
  const boundaryAtMs = nonNegativeInteger(value, code);
  const boundaryAt = new Date(boundaryAtMs).toISOString();
  if (Date.parse(boundaryAt) !== boundaryAtMs) fail(code);
  return boundaryAt;
}

function runKeyFor(context) {
  return semanticDigest(
    "phase4-recall-reference-run-key-v1",
    {
      policyVersion:
        SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION,
      runNonceDigest: context.runNonceDigest,
      decisionBoundaryAtMs: context.decisionBoundaryAtMs,
      contractPinsDigest: context.contractPinsDigest,
    },
  );
}

function canonicalContext(value) {
  const code = "SOURCE_RECALL_REFERENCE_CONTEXT_INVALID";
  const context = exactRecord(value, CONTEXT_KEYS, code);
  const normalized = {
    runNonceDigest: digest(context.runNonceDigest, code),
    decisionBoundaryAtMs: nonNegativeInteger(
      context.decisionBoundaryAtMs,
      code,
    ),
    contractPinsDigest: digest(
      context.contractPinsDigest,
      code,
    ),
  };
  canonicalBoundaryFromMs(normalized.decisionBoundaryAtMs, code);
  return deepFreeze(normalized);
}

function canonicalWork(value) {
  const code = "SOURCE_RECALL_REFERENCE_WORK_INVALID";
  const work = exactRecord(value, WORK_KEYS, code);
  if (!Object.isFrozen(value)) fail(code);
  return deepFreeze({
    workKeyDigest: digest(work.workKeyDigest, code),
  });
}

function canonicalPrivatePageRead(value) {
  const code = "SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_INPUT_INVALID";
  const input = exactRecord(value, PRIVATE_PAGE_READ_KEYS, code);
  if (
    !Object.isFrozen(value)
    || !Number.isSafeInteger(input.pageNumber)
    || input.pageNumber < 1
    || input.pageNumber > SOURCE_RECALL_REFERENCE_MAX_PAGES
  ) {
    fail(code);
  }
  return deepFreeze({
    workKeyDigest: digest(input.workKeyDigest, code),
    pageNumber: input.pageNumber,
  });
}

function emptyPass(passNumber) {
  return {
    passNumber,
    status: "pending",
    startedAtMs: null,
    completedAtMs: null,
    nextPageNumber: 1,
    nextCursor: null,
    seenCursors: [],
    pageCount: 0,
    scannedCount: 0,
    referenceCount: 0,
    lastJoinAt: null,
    pageManifests: [],
    referenceManifestDigest: null,
    semanticDigest: null,
  };
}

function initialRun(context) {
  return {
    version: SOURCE_RECALL_REFERENCE_RECORD_VERSION,
    policyVersion:
      SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION,
    kind: "recall_reference_collection_dark",
    source: SOURCE,
    clientVersion: SOURCE_RECALL_PAGE_CLIENT_VERSION,
    status: "collecting",
    workKeyDigest: runKeyFor(context),
    runNonceDigest: context.runNonceDigest,
    decisionBoundaryAtMs: context.decisionBoundaryAtMs,
    contractPinsDigest: context.contractPinsDigest,
    createdAtMs: 0,
    updatedAtMs: 0,
    revision: 0,
    activeClaim: null,
    pendingValidation: null,
    passes: [emptyPass(1), emptyPass(2)],
    headRecordDigest: null,
    invalidReason: null,
  };
}

function canonicalCommitment(value, code) {
  const item = exactRecord(
    value,
    REFERENCE_COMMITMENT_KEYS,
    code,
  );
  return {
    referenceIdDigest: digest(item.referenceIdDigest, code),
    referenceDigest: digest(item.referenceDigest, code),
  };
}

function nativeByteProofDigest(value, code) {
  if (
    typeof value !== "string"
    || !NATIVE_BYTE_PROOF_DIGEST.test(value)
  ) {
    fail(code);
  }
  return value;
}

function canonicalManifest(value, expectedPageNumber, code) {
  const manifest = exactRecord(value, MANIFEST_KEYS, code);
  if (manifest.pageNumber !== expectedPageNumber) fail(code);
  const referenceCount = nonNegativeInteger(
    manifest.referenceCount,
    code,
  );
  const rawCommitments = denseArraySnapshot(
    manifest.referenceCommitments,
    code,
  );
  if (rawCommitments.length !== referenceCount) {
    fail(code);
  }
  const referenceCommitments =
    rawCommitments.map(
      (item) => canonicalCommitment(item, code),
    );
  const ids = new Set();
  for (const item of referenceCommitments) {
    if (ids.has(item.referenceIdDigest)) fail(code);
    ids.add(item.referenceIdDigest);
  }
  const normalized = {
    pageNumber: expectedPageNumber,
    cursorDigest: digest(manifest.cursorDigest, code),
    nextCursorDigest: digest(manifest.nextCursorDigest, code),
    pageSemanticDigest: digest(
      manifest.pageSemanticDigest,
      code,
    ),
    pageRecordDigest: digest(manifest.pageRecordDigest, code),
    pageNativeByteProofDigest: nativeByteProofDigest(
      manifest.pageNativeByteProofDigest,
      code,
    ),
    pageExpiresAtMs: positiveInteger(
      manifest.pageExpiresAtMs,
      code,
    ),
    scannedCount: nonNegativeInteger(
      manifest.scannedCount,
      code,
    ),
    referenceCount,
    firstJoinAt: manifest.firstJoinAt === null
      ? null
      : canonicalBoundaryFromString(manifest.firstJoinAt, code),
    lastJoinAt: manifest.lastJoinAt === null
      ? null
      : canonicalBoundaryFromString(manifest.lastJoinAt, code),
    referenceCommitments,
  };
  if (
    normalized.scannedCount > SOURCE_RECALL_PAGE_SIZE
    || normalized.referenceCount > normalized.scannedCount
    || (
      normalized.referenceCount === 0
      && (
        normalized.firstJoinAt !== null
        || normalized.lastJoinAt !== null
      )
    )
    || (
      normalized.referenceCount > 0
      && (
        normalized.firstJoinAt === null
        || normalized.lastJoinAt === null
        || normalized.firstJoinAt < normalized.lastJoinAt
      )
    )
  ) {
    fail(code);
  }
  return normalized;
}

function canonicalBoundaryFromString(value, code) {
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

function canonicalPass(value, expectedPassNumber) {
  const code = "SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED";
  const pass = exactRecord(value, PASS_KEYS, code);
  if (
    pass.passNumber !== expectedPassNumber
    || !["pending", "collecting", "complete"]
      .includes(pass.status)
  ) {
    fail(code);
  }
  const pageCount = nonNegativeInteger(pass.pageCount, code);
  const rawPageManifests = denseArraySnapshot(
    pass.pageManifests,
    code,
  );
  if (rawPageManifests.length !== pageCount) {
    fail(code);
  }
  const pageManifests = rawPageManifests.map(
    (manifest, index) =>
      canonicalManifest(manifest, index + 1, code),
  );
  const seenCursors = denseArraySnapshot(
    pass.seenCursors,
    code,
  ).map((value) => cursor(value, code));
  if (seenCursors.some((value) => value === null)) fail(code);
  const nextPageNumber = positiveInteger(
    pass.nextPageNumber,
    code,
  );
  const scannedCount = nonNegativeInteger(
    pass.scannedCount,
    code,
  );
  const referenceCount = nonNegativeInteger(
    pass.referenceCount,
    code,
  );
  if (
    scannedCount !== pageManifests.reduce(
      (sum, page) => sum + page.scannedCount,
      0,
    )
    || referenceCount !== pageManifests.reduce(
      (sum, page) => sum + page.referenceCount,
      0,
    )
  ) {
    fail(code);
  }
  const normalized = {
    passNumber: expectedPassNumber,
    status: pass.status,
    startedAtMs: optionalTime(pass.startedAtMs, code),
    completedAtMs: optionalTime(pass.completedAtMs, code),
    nextPageNumber,
    nextCursor: cursor(pass.nextCursor, code),
    seenCursors,
    pageCount,
    scannedCount,
    referenceCount,
    lastJoinAt: pass.lastJoinAt === null
      ? null
      : canonicalBoundaryFromString(pass.lastJoinAt, code),
    pageManifests,
    referenceManifestDigest: optionalDigest(
      pass.referenceManifestDigest,
      code,
    ),
    semanticDigest: optionalDigest(pass.semanticDigest, code),
  };
  if (pass.status === "pending") {
    if (
      normalized.startedAtMs !== null
      || normalized.completedAtMs !== null
      || nextPageNumber !== 1
      || normalized.nextCursor !== null
      || seenCursors.length !== 0
      || pageCount !== 0
      || scannedCount !== 0
      || referenceCount !== 0
      || normalized.lastJoinAt !== null
      || normalized.referenceManifestDigest !== null
      || normalized.semanticDigest !== null
    ) {
      fail(code);
    }
  } else if (pass.status === "collecting") {
    if (
      normalized.startedAtMs === null
      || normalized.completedAtMs !== null
      || nextPageNumber !== pageCount + 1
      || pageCount > 0 && normalized.nextCursor === null
      || normalized.referenceManifestDigest !== null
      || normalized.semanticDigest !== null
    ) {
      fail(code);
    }
  } else if (
    normalized.startedAtMs === null
    || normalized.completedAtMs === null
    || normalized.completedAtMs < normalized.startedAtMs
    || nextPageNumber !== pageCount + 1
    || normalized.nextCursor !== null
    || pageCount < 1
    || normalized.referenceManifestDigest === null
    || normalized.semanticDigest === null
  ) {
    fail(code);
  }
  if (normalized.status === "complete") {
    const recomputed = passDigests(normalized);
    if (
      normalized.referenceManifestDigest
        !== recomputed.referenceManifestDigest
      || normalized.semanticDigest
        !== recomputed.semanticDigestValue
    ) {
      fail(code);
    }
  }
  return normalized;
}

function canonicalActiveClaim(value, run) {
  const code = "SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED";
  if (value === null) return null;
  const claim = exactRecord(value, ACTIVE_CLAIM_KEYS, code);
  if (
    ![1, 2].includes(claim.passNumber)
    || claim.pageNumber
      !== run.passes[claim.passNumber - 1].nextPageNumber
  ) {
    fail(code);
  }
  const issuedAtMs = nonNegativeInteger(claim.issuedAtMs, code);
  const expiresAtMs = nonNegativeInteger(claim.expiresAtMs, code);
  if (
    expiresAtMs - issuedAtMs
      !== SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS
  ) {
    fail(code);
  }
  return {
    claimNonceDigest: digest(claim.claimNonceDigest, code),
    passNumber: claim.passNumber,
    pageNumber: claim.pageNumber,
    requestDigest: digest(claim.requestDigest, code),
    issuedAtMs,
    expiresAtMs,
  };
}

function canonicalPendingValidation(value, run) {
  const code = "SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED";
  if (value === null) return null;
  const pending = exactRecord(
    value,
    PENDING_VALIDATION_KEYS,
    code,
  );
  const recoveryExpiresAtMs = positiveInteger(
    pending.recoveryExpiresAtMs,
    code,
  );
  const notAfterMs = positiveInteger(
    pending.notAfterMs,
    code,
  );
  if (
    run.status !== "collecting"
    || recoveryExpiresAtMs <= run.updatedAtMs
    || recoveryExpiresAtMs > notAfterMs
  ) {
    fail(code);
  }
  return {
    nextRecordDigest: digest(pending.nextRecordDigest, code),
    notAfterMs,
    recoveryExpiresAtMs,
  };
}

export function validateRecallReferenceRun(value) {
  const code = "SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED";
  const raw = exactRecord(value, RUN_KEYS, code);
  if (
    raw.version !== SOURCE_RECALL_REFERENCE_RECORD_VERSION
    || raw.policyVersion
      !== SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION
    || raw.kind !== "recall_reference_collection_dark"
    || raw.source !== SOURCE
    || raw.clientVersion !== SOURCE_RECALL_PAGE_CLIENT_VERSION
    || !["collecting", "sealed_unpinnable", "invalidated"]
      .includes(raw.status)
  ) {
    fail(code);
  }
  const rawPasses = denseArraySnapshot(raw.passes, code);
  if (
    rawPasses.length
      !== SOURCE_RECALL_REFERENCE_REQUIRED_PASSES
  ) {
    fail(code);
  }
  const run = {
    version: raw.version,
    policyVersion: raw.policyVersion,
    kind: raw.kind,
    source: raw.source,
    clientVersion: raw.clientVersion,
    status: raw.status,
    workKeyDigest: digest(raw.workKeyDigest, code),
    runNonceDigest: digest(raw.runNonceDigest, code),
    decisionBoundaryAtMs: nonNegativeInteger(
      raw.decisionBoundaryAtMs,
      code,
    ),
    contractPinsDigest: digest(raw.contractPinsDigest, code),
    createdAtMs: positiveInteger(raw.createdAtMs, code),
    updatedAtMs: positiveInteger(raw.updatedAtMs, code),
    revision: nonNegativeInteger(raw.revision, code),
    passes: rawPasses.map(
      (pass, index) => canonicalPass(pass, index + 1),
    ),
    headRecordDigest: optionalDigest(
      raw.headRecordDigest,
      code,
    ),
    invalidReason: raw.invalidReason,
  };
  run.pendingValidation = canonicalPendingValidation(
    raw.pendingValidation,
    run,
  );
  const boundaryAt = canonicalBoundaryFromMs(
    run.decisionBoundaryAtMs,
    code,
  );
  for (const pass of run.passes) {
    const normalizedSeen = pass.seenCursors.map(
      (value) => canonicalRecallCursor(value, boundaryAt, code),
    );
    if (
      normalizedSeen.length !== Math.max(0, pass.pageCount - 1)
      || normalizedSeen.some((value) => value === null)
    ) {
      fail(code);
    }
    for (let index = 0; index < normalizedSeen.length; index += 1) {
      if (
        recallCursorPage(normalizedSeen[index], boundaryAt, code)
          !== index + 2
      ) {
        fail(code);
      }
    }
    const normalizedNextCursor = canonicalRecallCursor(
      pass.nextCursor,
      boundaryAt,
      code,
    );
    if (
      normalizedNextCursor !== pass.nextCursor
      || (
        normalizedNextCursor !== null
        && recallCursorPage(
          normalizedNextCursor,
          boundaryAt,
          code,
        ) !== pass.nextPageNumber
      )
      || (
        normalizedNextCursor !== null
        && normalizedSeen.includes(normalizedNextCursor)
      )
    ) {
      fail(code);
    }
    let lastObservedJoinAt = null;
    for (
      let index = 0;
      index < pass.pageManifests.length;
      index += 1
    ) {
      const manifest = pass.pageManifests[index];
      const retentionAnchoredAtMs =
        manifest.pageExpiresAtMs
        - SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS;
      const exactCursor = index === 0
        ? null
        : normalizedSeen[index - 1];
      const exactNextCursor =
        index + 1 < pass.pageManifests.length
          ? normalizedSeen[index]
          : normalizedNextCursor;
      const cursorDigest = semanticDigest(
        "phase4-recall-reference-cursor-v1",
        exactCursor,
      );
      const nextCursorDigest = semanticDigest(
        "phase4-recall-reference-cursor-v1",
        exactNextCursor,
      );
      const pageSemanticDigest = semanticDigest(
        "phase4-recall-reference-page-semantic-v1",
        {
          boundaryAt,
          pageNumber: manifest.pageNumber,
          cursorDigest,
          nextCursorDigest,
          scannedCount: manifest.scannedCount,
          referenceCommitments: manifest.referenceCommitments,
          firstJoinAt: manifest.firstJoinAt,
          lastJoinAt: manifest.lastJoinAt,
          exhausted: exactNextCursor === null,
        },
      );
      if (
        manifest.cursorDigest !== cursorDigest
        || manifest.nextCursorDigest !== nextCursorDigest
        || manifest.pageSemanticDigest !== pageSemanticDigest
        || !Number.isSafeInteger(retentionAnchoredAtMs)
        || retentionAnchoredAtMs < pass.startedAtMs
        || retentionAnchoredAtMs > run.updatedAtMs
        || (
          lastObservedJoinAt !== null
          && manifest.firstJoinAt !== null
          && manifest.firstJoinAt > lastObservedJoinAt
        )
      ) {
        fail(code);
      }
      lastObservedJoinAt = manifest.lastJoinAt
        ?? lastObservedJoinAt;
    }
    if (pass.lastJoinAt !== lastObservedJoinAt) fail(code);
  }
  if (
    runKeyFor(run) !== run.workKeyDigest
    || run.createdAtMs > run.updatedAtMs
    || run.passes.some((pass) => (
      pass.startedAtMs !== null
      && (
        pass.startedAtMs < run.createdAtMs
        || pass.startedAtMs > run.updatedAtMs
      )
      || pass.completedAtMs !== null
      && pass.completedAtMs > run.updatedAtMs
    ))
    || run.passes[1].status !== "pending"
      && run.passes[0].status !== "complete"
  ) {
    fail(code);
  }
  run.activeClaim = canonicalActiveClaim(raw.activeClaim, run);
  if (run.activeClaim !== null) {
    const activePass = run.passes[
      run.activeClaim.passNumber - 1
    ];
    const expectedRequest = requestForPass(run, activePass);
    if (
      run.status !== "collecting"
      || activePass.status !== "collecting"
      || run.activeClaim.requestDigest
        !== expectedRequest.requestDigest
    ) {
      fail(code);
    }
  }
  if (
    run.status === "collecting"
    && run.headRecordDigest !== null
    || run.status === "sealed_unpinnable"
      && (
        run.headRecordDigest === null
        || run.activeClaim !== null
        || run.passes.some((pass) => pass.status !== "complete")
        || run.passes[0].semanticDigest
          !== run.passes[1].semanticDigest
      )
    || run.status === "invalidated"
      && (
        run.activeClaim !== null
        || run.headRecordDigest !== null
      )
    || run.status !== "collecting"
      && run.pendingValidation !== null
  ) {
    fail(code);
  }
  if (
    run.status === "invalidated"
      ? typeof run.invalidReason !== "string"
        || !/^[a-z0-9_]{1,80}$/u.test(run.invalidReason)
      : run.invalidReason !== null
  ) {
    fail(code);
  }
  return deepFreeze(run);
}

function parseRun(raw, nowMs) {
  if (
    typeof raw !== "string"
    || !Number.isSafeInteger(nowMs)
    || nowMs < 1
  ) {
    fail("SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED");
  }
  const record = validateRecallReferenceRun(value);
  if (
    canonicalJson(record) !== raw
    || record.createdAtMs > nowMs
    || record.updatedAtMs > nowMs
  ) {
    fail("SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED");
  }
  return deepFreeze({ record, raw, redisNowMs: nowMs });
}

function persistenceInterface(value) {
  const code = "SOURCE_RECALL_REFERENCE_PERSISTENCE_INVALID";
  const persistence = plainRecordSnapshot(value, code);
  if (
    !sameKeys(
      Object.keys(persistence).sort(),
      [...PERSISTENCE_METHODS].sort(),
    )
    || PERSISTENCE_METHODS.some(
      (method) => typeof persistence[method] !== "function",
    )
  ) {
    fail(code);
  }
  return persistence;
}

function persistenceResult(value, keys) {
  const code = "SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID";
  const result = exactRecord(value, keys, code);
  positiveInteger(result.redisNowMs, code);
  return result;
}

function pageKeyFor(workKeyDigest, passNumber, pageNumber) {
  return (
    `${PAGE_PREFIX}${workKeyDigest}`
    + `:${passNumber}:${pageNumber}`
  );
}

function persistenceKeyDigest(key) {
  return semanticDigest(
    "phase4-recall-reference-persistence-key-v1",
    key,
  );
}

function canonicalRequiredPageSet(
  value,
  expectedMinimumRemainingTtlMs =
    SOURCE_RECALL_REFERENCE_MIN_PAGE_RETENTION_MS,
) {
  const code = "SOURCE_RECALL_REFERENCE_PAGE_SET_INVALID";
  if (
    ![
      SOURCE_RECALL_REFERENCE_MIN_PAGE_RETENTION_MS,
      SOURCE_RECALL_REFERENCE_MIN_SEALED_RETENTION_MS,
    ].includes(expectedMinimumRemainingTtlMs)
  ) {
    fail(code);
  }
  return denseArraySnapshot(value, code).map((item) => {
    const required = exactRecord(item, REQUIRED_PAGE_KEYS, code);
    if (
      typeof required.key !== "string"
      || !required.key.startsWith(PAGE_PREFIX)
      || required.minimumRemainingTtlMs
        !== expectedMinimumRemainingTtlMs
      || required.expectedExpiresAtMs
        <= required.minimumRemainingTtlMs
    ) {
      fail(code);
    }
    return deepFreeze({
      key: required.key,
      rawDigest: digest(required.rawDigest, code),
      nativeByteProofDigest: nativeByteProofDigest(
        required.nativeByteProofDigest,
        code,
      ),
      expectedExpiresAtMs: positiveInteger(
        required.expectedExpiresAtMs,
        code,
      ),
      minimumRemainingTtlMs:
        required.minimumRemainingTtlMs,
    });
  });
}

function requiredPageSetDigest(requiredPageSet) {
  return semanticDigest(
    "phase4-recall-reference-required-page-set-v1",
    requiredPageSet,
  );
}

function artifactSetRequestDigest({
  runKey,
  expectedRunRaw,
  headKey,
  expectedHeadRaw,
  requiredPageSetDigest: pageSetDigest,
}) {
  return semanticDigest(
    "phase4-recall-reference-sealed-artifact-set-v1",
    {
      runKeyDigest: persistenceKeyDigest(runKey),
      runRawDigest: rawDigest(expectedRunRaw),
      headKeyDigest: persistenceKeyDigest(headKey),
      headRawDigest: rawDigest(expectedHeadRaw),
      requiredPageSetDigest: pageSetDigest,
    },
  );
}

function requestForPass(run, pass) {
  const body = {
    boundaryAt: canonicalBoundaryFromMs(
      run.decisionBoundaryAtMs,
      "SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED",
    ),
    cursor: pass.nextCursor,
    seenCursors: [...pass.seenCursors],
  };
  return deepFreeze({
    ...body,
    requestDigest: semanticDigest(
      "phase4-recall-reference-page-request-v1",
      body,
    ),
  });
}

function invalidated(record, reason, nowMs) {
  const next = clone(record);
  next.status = "invalidated";
  next.activeClaim = null;
  next.pendingValidation = null;
  next.headRecordDigest = null;
  next.invalidReason = reason;
  next.updatedAtMs = nowMs;
  next.revision += 1;
  return validateRecallReferenceRun(next);
}

function normalizedReference(value, boundaryAt) {
  const code = "SOURCE_RECALL_REFERENCE_PAGE_INVALID";
  const reference = exactRecord(value, REFERENCE_KEYS, code);
  const candidate = exactRecord(
    reference.candidate,
    CANDIDATE_KEYS,
    code,
  );
  if (
    typeof reference.id !== "string"
    || !/^[A-Za-z0-9_-]{5,128}$/u.test(reference.id)
    || !SOURCE_METADATA.has(reference.metadataSource)
  ) {
    fail(code);
  }
  const joinAt = canonicalBoundaryFromString(reference.joinAt, code);
  if (Date.parse(joinAt) >= Date.parse(boundaryAt)) fail(code);
  const fields = [
    [candidate.fullName, 512, false],
    [candidate.email, 512, true],
    [candidate.linkedin, 4_096, false],
    [candidate.paraformEventId, 1_024, false],
  ];
  for (const [item, maximum, lowercase] of fields) {
    if (
      typeof item !== "string"
      || item.length > maximum
      || item.trim() !== item
      || /[\u0000-\u001f\u007f]/u.test(item)
      || lowercase && item.toLowerCase() !== item
    ) {
      fail(code);
    }
  }
  return {
    id: reference.id,
    joinAt,
    metadataSource: reference.metadataSource,
    candidate: {
      fullName: candidate.fullName,
      email: candidate.email,
      linkedin: candidate.linkedin,
      paraformEventId: candidate.paraformEventId,
    },
  };
}

function pageEvidence(value, run, claim, nowMs) {
  const code = "SOURCE_RECALL_REFERENCE_PAGE_INVALID";
  const page = exactRecord(value, PAGE_KEYS, code);
  const boundaryAt = canonicalBoundaryFromMs(
    run.decisionBoundaryAtMs,
    code,
  );
  const normalizedCurrentCursor = canonicalRecallCursor(
    claim.cursor,
    boundaryAt,
    code,
  );
  const normalizedNextCursor = canonicalRecallCursor(
    page.nextCursor,
    boundaryAt,
    code,
  );
  const currentPage = recallCursorPage(
    normalizedCurrentCursor,
    boundaryAt,
    code,
  );
  const rawReferences = denseArraySnapshot(page.references, code);
  if (
    !Object.isFrozen(value)
    || page.version !== SOURCE_RECALL_PAGE_VERSION
    || page.boundaryAt !== boundaryAt
    || typeof page.exhausted !== "boolean"
    || page.exhausted !== (normalizedNextCursor === null)
    || normalizedCurrentCursor !== claim.cursor
    || normalizedNextCursor !== page.nextCursor
    || currentPage !== claim.pageNumber
    || (
      normalizedNextCursor !== null
      && recallCursorPage(
        normalizedNextCursor,
        boundaryAt,
        code,
      ) !== currentPage + 1
    )
    || (
      normalizedNextCursor !== null
      && (
        claim.seenCursors.includes(normalizedNextCursor)
        || normalizedNextCursor === normalizedCurrentCursor
      )
    )
    || !Number.isSafeInteger(page.scanned)
    || page.scanned < 0
    || page.scanned > SOURCE_RECALL_PAGE_SIZE
    || rawReferences.length > page.scanned
    || rawReferences.length > SOURCE_RECALL_PAGE_SIZE
  ) {
    fail(code);
  }
  const references = rawReferences.map(
    (reference) => normalizedReference(reference, boundaryAt),
  );
  let priorJoinAt = null;
  const rawIds = new Set();
  for (const reference of references) {
    if (
      rawIds.has(reference.id)
      || (
        priorJoinAt !== null
        && reference.joinAt > priorJoinAt
      )
    ) {
      fail(code);
    }
    rawIds.add(reference.id);
    priorJoinAt = reference.joinAt;
  }
  const referenceCommitments = references.map((reference) => ({
    referenceIdDigest: semanticDigest(
      "phase4-recall-reference-id-v1",
      reference.id,
    ),
    referenceDigest: semanticDigest(
      "phase4-recall-private-reference-v1",
      reference,
    ),
  }));
  const localIds = new Set();
  for (const commitment of referenceCommitments) {
    if (localIds.has(commitment.referenceIdDigest)) fail(code);
    localIds.add(commitment.referenceIdDigest);
  }
  const cursorDigest = semanticDigest(
    "phase4-recall-reference-cursor-v1",
    claim.cursor,
  );
  const nextCursorDigest = semanticDigest(
    "phase4-recall-reference-cursor-v1",
    page.nextCursor,
  );
  const pageSemanticDigest = semanticDigest(
    "phase4-recall-reference-page-semantic-v1",
    {
      boundaryAt,
      pageNumber: claim.pageNumber,
      cursorDigest,
      nextCursorDigest,
      scannedCount: page.scanned,
      referenceCommitments,
      firstJoinAt: references[0]?.joinAt ?? null,
      lastJoinAt: references.at(-1)?.joinAt ?? null,
      exhausted: page.exhausted,
    },
  );
  const pageRecord = {
    version: 1,
    policyVersion:
      SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION,
    kind: "recall_private_reference_page_dark",
    source: SOURCE,
    clientVersion: SOURCE_RECALL_PAGE_CLIENT_VERSION,
    workKeyDigest: run.workKeyDigest,
    runNonceDigest: run.runNonceDigest,
    decisionBoundaryAtMs: run.decisionBoundaryAtMs,
    contractPinsDigest: run.contractPinsDigest,
    passNumber: claim.passNumber,
    pageNumber: claim.pageNumber,
    pageExpiresAtMs:
      nowMs + SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS,
    cursor: claim.cursor,
    nextCursor: normalizedNextCursor,
    scannedCount: page.scanned,
    referenceCount: references.length,
    references,
    pageSemanticDigest,
  };
  const pageRaw = canonicalJson(pageRecord);
  const manifest = {
    pageNumber: claim.pageNumber,
    cursorDigest,
    nextCursorDigest,
    pageSemanticDigest,
    pageRecordDigest: rawDigest(pageRaw),
    pageNativeByteProofDigest:
      createHash("sha1").update(pageRaw).digest("hex"),
    pageExpiresAtMs:
      nowMs + SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS,
    scannedCount: page.scanned,
    referenceCount: references.length,
    firstJoinAt: references[0]?.joinAt ?? null,
    lastJoinAt: references.at(-1)?.joinAt ?? null,
    referenceCommitments,
  };
  return {
    nextCursor: normalizedNextCursor,
    references,
    manifest,
    pageRaw,
  };
}

function canonicalPrivateReferencePage(
  value,
  run,
  expectedManifest,
) {
  const code = "SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_INVALID";
  const page = exactRecord(
    value,
    PRIVATE_PAGE_RECORD_KEYS,
    code,
  );
  const pass = run.passes[1];
  const pageIndex = expectedManifest.pageNumber - 1;
  const boundaryAt = canonicalBoundaryFromMs(
    run.decisionBoundaryAtMs,
    code,
  );
  const expectedCursor = pageIndex === 0
    ? null
    : pass.seenCursors[pageIndex - 1];
  const expectedNextCursor = pageIndex + 1 < pass.pageCount
    ? pass.seenCursors[pageIndex]
    : pass.nextCursor;
  const normalizedCursor = canonicalRecallCursor(
    page.cursor,
    boundaryAt,
    code,
  );
  const normalizedNextCursor = canonicalRecallCursor(
    page.nextCursor,
    boundaryAt,
    code,
  );
  const scannedCount = nonNegativeInteger(
    page.scannedCount,
    code,
  );
  const referenceCount = nonNegativeInteger(
    page.referenceCount,
    code,
  );
  const rawReferences = denseArraySnapshot(
    page.references,
    code,
  );
  if (
    page.version !== SOURCE_RECALL_REFERENCE_RECORD_VERSION
    || page.policyVersion
      !== SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION
    || page.kind !== "recall_private_reference_page_dark"
    || page.source !== SOURCE
    || page.clientVersion !== SOURCE_RECALL_PAGE_CLIENT_VERSION
    || page.workKeyDigest !== run.workKeyDigest
    || page.runNonceDigest !== run.runNonceDigest
    || page.decisionBoundaryAtMs !== run.decisionBoundaryAtMs
    || page.contractPinsDigest !== run.contractPinsDigest
    || page.passNumber !== 2
    || page.pageNumber !== expectedManifest.pageNumber
    || positiveInteger(page.pageExpiresAtMs, code)
      !== expectedManifest.pageExpiresAtMs
    || normalizedCursor !== expectedCursor
    || normalizedNextCursor !== expectedNextCursor
    || scannedCount > SOURCE_RECALL_PAGE_SIZE
    || referenceCount !== rawReferences.length
    || referenceCount > scannedCount
  ) {
    fail(code);
  }
  digest(page.workKeyDigest, code);
  digest(page.runNonceDigest, code);
  digest(page.contractPinsDigest, code);
  const references = rawReferences.map(
    (reference) => normalizedReference(reference, boundaryAt),
  );
  let priorJoinAt = null;
  const referenceIds = new Set();
  for (const reference of references) {
    if (
      referenceIds.has(reference.id)
      || (
        priorJoinAt !== null
        && reference.joinAt > priorJoinAt
      )
    ) {
      fail(code);
    }
    referenceIds.add(reference.id);
    priorJoinAt = reference.joinAt;
  }
  const referenceCommitments = references.map((reference) => ({
    referenceIdDigest: semanticDigest(
      "phase4-recall-reference-id-v1",
      reference.id,
    ),
    referenceDigest: semanticDigest(
      "phase4-recall-private-reference-v1",
      reference,
    ),
  }));
  const cursorDigest = semanticDigest(
    "phase4-recall-reference-cursor-v1",
    normalizedCursor,
  );
  const nextCursorDigest = semanticDigest(
    "phase4-recall-reference-cursor-v1",
    normalizedNextCursor,
  );
  const firstJoinAt = references[0]?.joinAt ?? null;
  const lastJoinAt = references.at(-1)?.joinAt ?? null;
  const pageSemanticDigest = semanticDigest(
    "phase4-recall-reference-page-semantic-v1",
    {
      boundaryAt,
      pageNumber: page.pageNumber,
      cursorDigest,
      nextCursorDigest,
      scannedCount,
      referenceCommitments,
      firstJoinAt,
      lastJoinAt,
      exhausted: normalizedNextCursor === null,
    },
  );
  if (
    digest(page.pageSemanticDigest, code) !== pageSemanticDigest
    || expectedManifest.cursorDigest !== cursorDigest
    || expectedManifest.nextCursorDigest !== nextCursorDigest
    || expectedManifest.pageSemanticDigest !== pageSemanticDigest
    || expectedManifest.scannedCount !== scannedCount
    || expectedManifest.referenceCount !== referenceCount
    || expectedManifest.firstJoinAt !== firstJoinAt
    || expectedManifest.lastJoinAt !== lastJoinAt
    || canonicalJson(expectedManifest.referenceCommitments)
      !== canonicalJson(referenceCommitments)
  ) {
    fail(code);
  }
  return deepFreeze({
    version: page.version,
    policyVersion: page.policyVersion,
    kind: page.kind,
    source: page.source,
    clientVersion: page.clientVersion,
    workKeyDigest: page.workKeyDigest,
    runNonceDigest: page.runNonceDigest,
    decisionBoundaryAtMs: page.decisionBoundaryAtMs,
    contractPinsDigest: page.contractPinsDigest,
    passNumber: page.passNumber,
    pageNumber: page.pageNumber,
    pageExpiresAtMs: page.pageExpiresAtMs,
    cursor: normalizedCursor,
    nextCursor: normalizedNextCursor,
    scannedCount,
    referenceCount,
    references,
    pageSemanticDigest,
  });
}

function passDigests(pass) {
  const commitments = pass.pageManifests
    .flatMap((page) => page.referenceCommitments)
    .sort((left, right) => (
      left.referenceIdDigest.localeCompare(
        right.referenceIdDigest,
      )
      || left.referenceDigest.localeCompare(
        right.referenceDigest,
      )
    ));
  const referenceManifestDigest = semanticDigest(
    "phase4-recall-reference-manifest-v1",
    commitments,
  );
  const semanticDigestValue = semanticDigest(
    "phase4-recall-reference-stable-pass-v1",
    {
      pageCount: pass.pageCount,
      scannedCount: pass.scannedCount,
      referenceCount: pass.referenceCount,
      pageSemanticDigests: pass.pageManifests.map(
        (page) => page.pageSemanticDigest,
      ),
      referenceManifestDigest,
      terminalCursorObserved: true,
    },
  );
  return { referenceManifestDigest, semanticDigestValue };
}

function digestOnlyPageManifest(value) {
  return Object.fromEntries(
    PAGE_MANIFEST_HEAD_KEYS.map((key) => [key, value[key]]),
  );
}

function sealedHead(run, nowMs) {
  const first = run.passes[0];
  const second = run.passes[1];
  const pageManifests = second.pageManifests.map(
    digestOnlyPageManifest,
  );
  const recallReferenceHeadEpochDigest = semanticDigest(
    "phase4-recall-reference-head-epoch-v1",
    {
      decisionBoundaryAtMs: run.decisionBoundaryAtMs,
      referenceManifestDigest: second.referenceManifestDigest,
      referenceCount: second.referenceCount,
    },
  );
  const recallReferenceHeadRevisionDigest = semanticDigest(
    "phase4-recall-reference-head-revision-v1",
    {
      firstPassPageRecordDigests: first.pageManifests.map(
        (page) => page.pageRecordDigest,
      ),
      secondPassPageRecordDigests: second.pageManifests.map(
        (page) => page.pageRecordDigest,
      ),
      stablePassSemanticDigest: second.semanticDigest,
    },
  );
  return {
    version: 1,
    policyVersion:
      SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION,
    kind: "recall_reference_artifact_head_dark",
    source: SOURCE,
    clientVersion: SOURCE_RECALL_PAGE_CLIENT_VERSION,
    workKeyDigest: run.workKeyDigest,
    runNonceDigest: run.runNonceDigest,
    decisionBoundaryAtMs: run.decisionBoundaryAtMs,
    contractPinsDigest: run.contractPinsDigest,
    passCount: SOURCE_RECALL_REFERENCE_REQUIRED_PASSES,
    pageCount: second.pageCount,
    scannedCount: second.scannedCount,
    referenceCount: second.referenceCount,
    referenceManifestDigest: second.referenceManifestDigest,
    stablePassSemanticDigest: second.semanticDigest,
    pageManifests,
    recallReferenceHeadEpochDigest,
    recallReferenceHeadRevisionDigest,
    sealedAtMs: nowMs,
    pointReadAvailable: false,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
  };
}

function transitionPage(runValue, claim, pageValue, nowMs) {
  const run = validateRecallReferenceRun(runValue);
  const active = run.activeClaim;
  if (
    run.status !== "collecting"
    || !active
    || active.claimNonceDigest !== claim.claimNonceDigest
    || active.passNumber !== claim.passNumber
    || active.pageNumber !== claim.pageNumber
    || active.requestDigest !== claim.requestDigest
  ) {
    fail("SOURCE_RECALL_REFERENCE_CLAIM_MISMATCH");
  }
  if (
    nowMs - run.createdAtMs
      >= SOURCE_RECALL_REFERENCE_MAX_COLLECTION_AGE_MS
  ) {
    return {
      next: invalidated(
        run,
        "collection_age_exceeded",
        nowMs,
      ),
      pageRaw: null,
      headRaw: null,
    };
  }
  if (nowMs >= active.expiresAtMs) {
    return {
      next: invalidated(
        run,
        "page_claim_expired",
        nowMs,
      ),
      pageRaw: null,
      headRaw: null,
    };
  }
  const passBeforeRead = run.passes[claim.passNumber - 1];
  const expectedRequest = requestForPass(run, passBeforeRead);
  if (
    claim.boundaryAt !== expectedRequest.boundaryAt
    || claim.cursor !== expectedRequest.cursor
    || claim.requestDigest !== expectedRequest.requestDigest
    || claim.seenCursors.length
      !== expectedRequest.seenCursors.length
    || claim.seenCursors.some(
      (value, index) =>
        value !== expectedRequest.seenCursors[index],
    )
  ) {
    fail("SOURCE_RECALL_REFERENCE_CLAIM_MISMATCH");
  }
  const evidence = pageEvidence(pageValue, run, claim, nowMs);
  const next = clone(run);
  const pass = next.passes[claim.passNumber - 1];
  const priorIds = new Set(
    pass.pageManifests.flatMap(
      (manifest) => manifest.referenceCommitments.map(
        (item) => item.referenceIdDigest,
      ),
    ),
  );
  if (
    evidence.manifest.referenceCommitments.some(
      (item) => priorIds.has(item.referenceIdDigest),
    )
  ) {
    return {
      next: invalidated(
        run,
        "duplicate_reference_across_pages",
        nowMs,
      ),
      pageRaw: null,
      headRaw: null,
    };
  }
  if (
    pass.lastJoinAt !== null
    && evidence.manifest.firstJoinAt !== null
    && evidence.manifest.firstJoinAt > pass.lastJoinAt
  ) {
    return {
      next: invalidated(
        run,
        "reference_order_regressed",
        nowMs,
      ),
      pageRaw: null,
      headRaw: null,
    };
  }
  if (
    claim.passNumber === 2
    && (
      !run.passes[0].pageManifests[claim.pageNumber - 1]
      || run.passes[0].pageManifests[
        claim.pageNumber - 1
      ].pageSemanticDigest
        !== evidence.manifest.pageSemanticDigest
    )
  ) {
    return {
      next: invalidated(
        run,
        "sequential_pass_page_mismatch",
        nowMs,
      ),
      pageRaw: null,
      headRaw: null,
    };
  }
  pass.pageManifests.push(evidence.manifest);
  pass.pageCount += 1;
  pass.scannedCount += evidence.manifest.scannedCount;
  pass.referenceCount += evidence.manifest.referenceCount;
  pass.lastJoinAt = evidence.manifest.lastJoinAt
    ?? pass.lastJoinAt;
  pass.nextPageNumber += 1;
  pass.nextCursor = evidence.nextCursor;
  if (claim.cursor !== null) {
    pass.seenCursors.push(claim.cursor);
  }
  next.activeClaim = null;
  next.updatedAtMs = nowMs;
  next.revision += 1;
  if (evidence.nextCursor !== null) {
    if (pass.pageCount >= SOURCE_RECALL_REFERENCE_MAX_PAGES) {
      return {
        next: invalidated(
          run,
          "page_limit_exceeded",
          nowMs,
        ),
        pageRaw: null,
        headRaw: null,
      };
    }
    pass.status = "collecting";
    return {
      next: validateRecallReferenceRun(next),
      pageRaw: evidence.pageRaw,
      headRaw: null,
    };
  }
  pass.status = "complete";
  pass.completedAtMs = nowMs;
  const {
    referenceManifestDigest,
    semanticDigestValue,
  } = passDigests(pass);
  pass.referenceManifestDigest = referenceManifestDigest;
  pass.semanticDigest = semanticDigestValue;
  if (claim.passNumber === 1) {
    return {
      next: validateRecallReferenceRun(next),
      pageRaw: evidence.pageRaw,
      headRaw: null,
    };
  }
  const first = next.passes[0];
  if (
    first.semanticDigest !== pass.semanticDigest
    || first.referenceManifestDigest
      !== pass.referenceManifestDigest
    || first.pageCount !== pass.pageCount
    || first.scannedCount !== pass.scannedCount
    || first.referenceCount !== pass.referenceCount
  ) {
    return {
      next: invalidated(
        run,
        "sequential_pass_digest_mismatch",
        nowMs,
      ),
      pageRaw: null,
      headRaw: null,
    };
  }
  const head = sealedHead(next, nowMs);
  const headRaw = canonicalJson(head);
  next.status = "sealed_unpinnable";
  next.headRecordDigest = rawDigest(headRaw);
  return {
    next: validateRecallReferenceRun(next),
    pageRaw: evidence.pageRaw,
    headRaw,
  };
}

function canonicalHead(value, expectedRun) {
  const code = "SOURCE_RECALL_REFERENCE_HEAD_MALFORMED";
  const head = exactRecord(value, HEAD_KEYS, code);
  if (
    head.version !== 1
    || head.policyVersion
      !== SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION
    || head.kind !== "recall_reference_artifact_head_dark"
    || head.source !== SOURCE
    || head.clientVersion !== SOURCE_RECALL_PAGE_CLIENT_VERSION
    || head.workKeyDigest !== expectedRun.workKeyDigest
    || head.passCount
      !== SOURCE_RECALL_REFERENCE_REQUIRED_PASSES
    || head.pointReadAvailable !== false
    || head.sourceFactsAvailable !== false
    || head.successClassificationAvailable !== false
    || head.candidateIdentityResolutionAvailable !== false
    || head.pinnable !== false
    || head.authorityAvailable !== false
  ) {
    fail(code);
  }
  digest(head.runNonceDigest, code);
  digest(head.contractPinsDigest, code);
  digest(head.referenceManifestDigest, code);
  digest(head.stablePassSemanticDigest, code);
  digest(head.recallReferenceHeadEpochDigest, code);
  digest(head.recallReferenceHeadRevisionDigest, code);
  nonNegativeInteger(head.decisionBoundaryAtMs, code);
  nonNegativeInteger(head.pageCount, code);
  nonNegativeInteger(head.scannedCount, code);
  nonNegativeInteger(head.referenceCount, code);
  nonNegativeInteger(head.sealedAtMs, code);
  const rawPageManifests = denseArraySnapshot(
    head.pageManifests,
    code,
  );
  if (rawPageManifests.length !== head.pageCount) fail(code);
  const pageManifests = rawPageManifests.map((value, index) => {
    const page = exactRecord(
      value,
      PAGE_MANIFEST_HEAD_KEYS,
      code,
    );
    if (page.pageNumber !== index + 1) fail(code);
    digest(page.cursorDigest, code);
    digest(page.nextCursorDigest, code);
    digest(page.pageRecordDigest, code);
    nativeByteProofDigest(
      page.pageNativeByteProofDigest,
      code,
    );
    digest(page.pageSemanticDigest, code);
    nonNegativeInteger(page.scannedCount, code);
    nonNegativeInteger(page.referenceCount, code);
    return page;
  });
  const expectedSecond = expectedRun.passes[1];
  const expectedHead = sealedHead(
    expectedRun,
    expectedRun.updatedAtMs,
  );
  if (
    head.runNonceDigest !== expectedRun.runNonceDigest
    || head.decisionBoundaryAtMs
      !== expectedRun.decisionBoundaryAtMs
    || head.contractPinsDigest !== expectedRun.contractPinsDigest
    || head.sealedAtMs !== expectedRun.updatedAtMs
    || head.pageCount !== expectedSecond.pageCount
    || head.scannedCount !== expectedSecond.scannedCount
    || head.referenceCount !== expectedSecond.referenceCount
    || head.referenceManifestDigest
      !== expectedSecond.referenceManifestDigest
    || head.stablePassSemanticDigest !== expectedSecond.semanticDigest
    || canonicalJson(pageManifests)
      !== canonicalJson(expectedHead.pageManifests)
    || head.recallReferenceHeadEpochDigest
      !== expectedHead.recallReferenceHeadEpochDigest
    || head.recallReferenceHeadRevisionDigest
      !== expectedHead.recallReferenceHeadRevisionDigest
    || head.scannedCount !== pageManifests.reduce(
      (sum, page) => sum + page.scannedCount,
      0,
    )
    || head.referenceCount !== pageManifests.reduce(
      (sum, page) => sum + page.referenceCount,
      0,
    )
  ) {
    fail(code);
  }
  return deepFreeze({ ...head, pageManifests });
}

function aggregateFor(record) {
  const completedPasses = record.passes.filter(
    (pass) => pass.status === "complete",
  ).length;
  const currentPass = record.passes[
    Math.min(completedPasses, 1)
  ];
  return deepFreeze({
    status: record.status,
    operational: false,
    serverSelected: true,
    completedPasses,
    requiredPasses: SOURCE_RECALL_REFERENCE_REQUIRED_PASSES,
    pageCount: currentPass.pageCount,
    scannedCount: currentPass.scannedCount,
    referenceCount: currentPass.referenceCount,
    inProgress:
      record.activeClaim !== null
      || record.pendingValidation !== null,
    headSealed: record.status === "sealed_unpinnable",
    pointReadAvailable: false,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
  });
}

export function recallReferenceAggregateStatus(snapshot) {
  const value = plainRecordSnapshot(
    snapshot,
    "SOURCE_RECALL_REFERENCE_SNAPSHOT_INVALID",
  );
  return aggregateFor(validateRecallReferenceRun(value.record));
}

function terminalClaim(record) {
  return deepFreeze({
    status: "complete",
    outcome: record.status,
    aggregate: aggregateFor(record),
  });
}

export function createSourceRecallReferencePersistenceProtocol(options) {
  const { persistence } = exactRecord(
    options,
    FACTORY_KEYS,
    "SOURCE_RECALL_REFERENCE_PERSISTENCE_INVALID",
  );
  const durable = persistenceInterface(persistence);
  // Claims are process-local, one-shot capabilities layered on the persisted
  // claim record. A process restart cannot reconstruct one and therefore
  // cannot checkpoint a response from an abandoned read.
  const issuedClaims = new WeakMap();

  async function ensureRecallReferenceRun(input) {
    const context = canonicalContext(input);
    const proposed = initialRun(context);
    const result = persistenceResult(
      await durable.ensure({
        key: `${RUN_PREFIX}${proposed.workKeyDigest}`,
        proposedRaw: canonicalJson(proposed),
      }),
      ENSURE_RESULT_KEYS,
    );
    if (!["created", "existing"].includes(result.status)) {
      fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_FAILED");
    }
    if (typeof result.raw !== "string") {
      fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
    }
    const snapshot = parseRun(result.raw, result.redisNowMs);
    if (
      result.status === "created"
      && (
        snapshot.record.revision !== 0
        || snapshot.record.createdAtMs !== snapshot.redisNowMs
        || snapshot.record.updatedAtMs !== snapshot.redisNowMs
      )
    ) {
      fail("SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED");
    }
    if (
      snapshot.record.workKeyDigest !== proposed.workKeyDigest
      || snapshot.record.runNonceDigest !== context.runNonceDigest
      || snapshot.record.decisionBoundaryAtMs
        !== context.decisionBoundaryAtMs
      || snapshot.record.contractPinsDigest
        !== context.contractPinsDigest
    ) {
      fail("SOURCE_RECALL_REFERENCE_RUN_BINDING_MISMATCH");
    }
    return deepFreeze({
      snapshot,
      work: deepFreeze({
        workKeyDigest: proposed.workKeyDigest,
      }),
    });
  }

  async function readRun(work) {
    const selected = canonicalWork(work);
    const result = persistenceResult(
      await durable.readRun({
        key: `${RUN_PREFIX}${selected.workKeyDigest}`,
      }),
      READ_RESULT_KEYS,
    );
    if (
      result.raw !== null
      && typeof result.raw !== "string"
    ) {
      fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
    }
    if (!result.raw) {
      fail("SOURCE_RECALL_REFERENCE_RUN_NOT_FOUND");
    }
    const snapshot = parseRun(result.raw, result.redisNowMs);
    if (snapshot.record.workKeyDigest !== selected.workKeyDigest) {
      fail("SOURCE_RECALL_REFERENCE_RUN_BINDING_MISMATCH");
    }
    return snapshot;
  }

  async function verifySealedReferenceArtifacts(snapshot) {
    const code =
      "SOURCE_RECALL_REFERENCE_SEALED_ARTIFACTS_INVALID";
    if (
      snapshot.record.status !== "sealed_unpinnable"
      || snapshot.record.headRecordDigest === null
    ) {
      fail(code);
    }
    const headResult = persistenceResult(
      await durable.readHead({
        key: `${HEAD_PREFIX}${snapshot.record.workKeyDigest}`,
      }),
      READ_RESULT_KEYS,
    );
    if (
      typeof headResult.raw !== "string"
      || headResult.redisNowMs < snapshot.redisNowMs
    ) {
      fail(code);
    }
    let parsedHead;
    try {
      parsedHead = JSON.parse(headResult.raw);
    } catch {
      fail(code);
    }
    const head = canonicalHead(parsedHead, snapshot.record);
    const recallReferenceHeadRecordDigest =
      rawDigest(headResult.raw);
    if (
      canonicalJson(head) !== headResult.raw
      || recallReferenceHeadRecordDigest
        !== snapshot.record.headRecordDigest
    ) {
      fail(code);
    }
    const requiredPageSet = canonicalRequiredPageSet(
      snapshot.record.passes[1].pageManifests.map(
        (manifest) => deepFreeze({
          key: pageKeyFor(
            snapshot.record.workKeyDigest,
            2,
            manifest.pageNumber,
          ),
          rawDigest: manifest.pageRecordDigest,
          nativeByteProofDigest:
            manifest.pageNativeByteProofDigest,
          expectedExpiresAtMs: manifest.pageExpiresAtMs,
          minimumRemainingTtlMs:
            SOURCE_RECALL_REFERENCE_MIN_SEALED_RETENTION_MS,
        }),
      ),
      SOURCE_RECALL_REFERENCE_MIN_SEALED_RETENTION_MS,
    );
    // The compare-and-set receipt proves each page's exact immutable
    // generation when it is published. Re-reading every raw page here would
    // add up to 200 private REST transfers. The persistence artifact-set
    // operation is the fresh linearizable proof that those exact page
    // generations, expiries, head, and run still coexist.
    let verifiedAtMs = headResult.redisNowMs;
    const runKey =
      `${RUN_PREFIX}${snapshot.record.workKeyDigest}`;
    const headKey =
      `${HEAD_PREFIX}${snapshot.record.workKeyDigest}`;
    const pageSetDigest =
      requiredPageSetDigest(requiredPageSet);
    const requestDigest = artifactSetRequestDigest({
      runKey,
      expectedRunRaw: snapshot.raw,
      headKey,
      expectedHeadRaw: headResult.raw,
      requiredPageSetDigest: pageSetDigest,
    });
    const artifactResult = persistenceResult(
      await durable.verifyArtifactSet({
        runKey,
        expectedRunRaw: snapshot.raw,
        headKey,
        expectedHeadRaw: headResult.raw,
        requiredPageSet: deepFreeze([...requiredPageSet]),
        requiredPageSetDigest: pageSetDigest,
        requestDigest,
      }),
      ARTIFACT_SET_VERIFY_RESULT_KEYS,
    );
    if (artifactResult.redisNowMs < verifiedAtMs) {
      fail(code);
    }
    if (artifactResult.status === "mismatch") {
      if (artifactResult.artifactSetReceipt !== null) {
        fail(
          "SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID",
        );
      }
      fail(code);
    }
    if (artifactResult.status !== "verified") {
      fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
    }
    const artifactReceipt = exactRecord(
      artifactResult.artifactSetReceipt,
      ARTIFACT_SET_RECEIPT_KEYS,
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID",
    );
    if (
      artifactReceipt.count !== requiredPageSet.length
      || artifactReceipt.requestDigest !== requestDigest
      || artifactReceipt.verifiedAtMs
        !== artifactResult.redisNowMs
      || requiredPageSet.some((required) => (
        required.expectedExpiresAtMs
          - artifactResult.redisNowMs
          < required.minimumRemainingTtlMs
      ))
    ) {
      fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
    }
    verifiedAtMs = artifactResult.redisNowMs;
    return deepFreeze({
      head,
      headRaw: headResult.raw,
      recallReferenceHeadRecordDigest,
      verifiedAtMs,
    });
  }

  async function invalidateUnverifiedSealedRun(work) {
    const current = await readRun(work);
    if (current.record.status !== "sealed_unpinnable") {
      return current;
    }
    const next = invalidated(
      current.record,
      "sealed_artifact_verification_failed",
      current.redisNowMs,
    );
    return casRun(current, next);
  }

  async function invalidateCommittedLateTransition(snapshot) {
    const work = deepFreeze({
      workKeyDigest: snapshot.record.workKeyDigest,
    });
    // A late stored transition is never allowed to become a new base state.
    // A conforming linearizable CAS can conflict only while another writer
    // advances the same finite run. Keep rebasing the terminal invalidation
    // until one revision owns it; never return a claim or checkpoint while a
    // late descendant remains collectable or sealed.
    while (true) {
      const current = await readRun(work);
      if (current.record.status === "invalidated") return current;
      try {
        return await casRun(
          current,
          invalidated(
            current.record,
            "persistence_deadline_violated",
            current.redisNowMs,
          ),
        );
      } catch (error) {
        if (
          !(error
            instanceof SourceRecallReferencePersistenceProtocolError)
          || error.code !== "SOURCE_RECALL_REFERENCE_CAS_CONFLICT"
        ) {
          throw error;
        }
      }
    }
  }

  async function casRunOnce(snapshot, nextRecord, {
    pageRaw = null,
    pageKey = null,
    pageExpiresAtMs = null,
    headRaw = null,
    requiredPageSet = [],
    notBeforeMs = snapshot.redisNowMs,
    notAfterMs = null,
    artifactRecord = nextRecord,
    pendingPromotionDigest = null,
  } = {}) {
    const nextRaw = canonicalJson(nextRecord);
    const selectedPageSet = canonicalRequiredPageSet(
      requiredPageSet,
    );
    const requiredKeys = new Set(
      selectedPageSet.map((item) => item.key),
    );
    const isPendingPromotion =
      pendingPromotionDigest !== null;
    if (
      nextRecord.createdAtMs !== snapshot.record.createdAtMs
      || nextRecord.revision !== snapshot.record.revision + 1
      || artifactRecord.createdAtMs
        !== snapshot.record.createdAtMs
      || artifactRecord.workKeyDigest
        !== snapshot.record.workKeyDigest
      || (
        isPendingPromotion
          ? (
            snapshot.record.pendingValidation === null
            || nextRecord.pendingValidation !== null
            || nextRecord.updatedAtMs
              !== snapshot.record.updatedAtMs
            || pendingPromotionDigest !== rawDigest(nextRaw)
            || snapshot.record.pendingValidation
              .nextRecordDigest !== pendingPromotionDigest
            || pageRaw !== null
            || pageKey !== null
            || pageExpiresAtMs !== null
            || headRaw !== null
            || selectedPageSet.length !== 0
            || notAfterMs !== null
          )
          : nextRecord.updatedAtMs !== snapshot.redisNowMs
      )
      || requiredKeys.size !== selectedPageSet.length
      || !Number.isSafeInteger(notBeforeMs)
      || notBeforeMs < snapshot.redisNowMs
      || !(
        notAfterMs === null
        || Number.isSafeInteger(notAfterMs)
          && notAfterMs > snapshot.redisNowMs
      )
      || (
        pageRaw === null
        && pageExpiresAtMs !== null
      )
      || (
        pageRaw !== null
        && (
          pageExpiresAtMs
            !== artifactRecord.updatedAtMs
              + SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS
          || !Number.isSafeInteger(pageExpiresAtMs)
        )
      )
      || (
        headRaw === null
        && selectedPageSet.length !== 0
      )
      || (
        headRaw !== null
        && (
          pageRaw === null
          || pageKey === null
          || selectedPageSet.length
            !== artifactRecord.passes[1].pageCount
          || !requiredKeys.has(pageKey)
          || selectedPageSet.some((required, index) => (
            required.key !== pageKeyFor(
              artifactRecord.workKeyDigest,
              2,
              index + 1,
            )
            || required.rawDigest
              !== artifactRecord.passes[1]
                .pageManifests[index].pageRecordDigest
            || required.nativeByteProofDigest
              !== artifactRecord.passes[1]
                .pageManifests[index]
                .pageNativeByteProofDigest
            || required.expectedExpiresAtMs
              !== artifactRecord.passes[1]
                .pageManifests[index].pageExpiresAtMs
          ))
        )
      )
    ) {
      fail("SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED");
    }
    const pageTtlMs = pageRaw === null
      ? null
      : SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS;
    const headKey = headRaw === null
      ? null
      : `${HEAD_PREFIX}${snapshot.record.workKeyDigest}`;
    const pageSetRequestDigest = requiredPageSetDigest(
      selectedPageSet,
    );
    const result = persistenceResult(
      await durable.compareAndSet({
        key: `${RUN_PREFIX}${snapshot.record.workKeyDigest}`,
        expectedRaw: snapshot.raw,
        nextRaw,
        pageKey,
        pageRaw,
        pageTtlMs,
        pageExpiresAtMs,
        headKey,
        headRaw,
        requiredPageSet: deepFreeze([...selectedPageSet]),
        requiredPageSetDigest: pageSetRequestDigest,
        notBeforeMs,
        notAfterMs,
      }),
      CAS_RESULT_KEYS,
    );
    if (result.redisNowMs < notBeforeMs) {
      fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
    }
    if (result.status === "conflict") {
      if (
        result.pageReceipt !== null
        || result.headReceipt !== null
        || result.pageSetReceipt !== null
        || !(
          result.raw === null
          || typeof result.raw === "string"
        )
      ) {
        fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
      }
      fail("SOURCE_RECALL_REFERENCE_CAS_CONFLICT");
    }
    if (result.status === "deadline_exceeded") {
      if (
        notAfterMs === null
        || result.redisNowMs
          + SOURCE_RECALL_REFERENCE_ATOMIC_COMMIT_BUDGET_MS
          < notAfterMs
        || result.raw !== snapshot.raw
        || result.pageReceipt !== null
        || result.headReceipt !== null
        || result.pageSetReceipt !== null
      ) {
        fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
      }
      fail("SOURCE_RECALL_REFERENCE_CAS_DEADLINE_EXCEEDED");
    }
    if (result.status !== "stored") {
      fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_FAILED");
    }
    if (
      notAfterMs !== null
      && result.redisNowMs >= notAfterMs
    ) {
      await invalidateCommittedLateTransition(snapshot);
      fail("SOURCE_RECALL_REFERENCE_CAS_DEADLINE_EXCEEDED");
    }
    if (result.raw !== nextRaw) {
      fail("SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED");
    }
    if (pageRaw === null) {
      if (result.pageReceipt !== null) {
        fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
      }
    } else {
      const receipt = exactRecord(
        result.pageReceipt,
        PAGE_RECEIPT_KEYS,
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID",
      );
      if (
        receipt.keyDigest !== persistenceKeyDigest(pageKey)
        || receipt.rawDigest !== rawDigest(pageRaw)
        || receipt.ttlMs !== pageTtlMs
        || receipt.expiresAtMs !== pageExpiresAtMs
        || !Number.isSafeInteger(receipt.expiresAtMs)
      ) {
        fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
      }
    }
    if (headRaw === null) {
      if (result.headReceipt !== null) {
        fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
      }
    } else {
      const receipt = exactRecord(
        result.headReceipt,
        HEAD_RECEIPT_KEYS,
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID",
      );
      if (
        receipt.keyDigest !== persistenceKeyDigest(headKey)
        || receipt.rawDigest !== rawDigest(headRaw)
      ) {
        fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
      }
    }
    if (selectedPageSet.length === 0) {
      if (result.pageSetReceipt !== null) {
        fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
      }
    } else {
      const receipt = exactRecord(
        result.pageSetReceipt,
        PAGE_SET_RECEIPT_KEYS,
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID",
      );
      if (
        receipt.count !== selectedPageSet.length
        || receipt.requestDigest !== pageSetRequestDigest
        || receipt.verifiedAtMs !== result.redisNowMs
      ) {
        fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
      }
    }
    return parseRun(result.raw, result.redisNowMs);
  }

  async function casRun(snapshot, nextRecord, options = {}) {
    const notAfterMs = options.notAfterMs ?? null;
    if (notAfterMs === null) {
      return casRunOnce(snapshot, nextRecord, options);
    }
    if (
      snapshot.record.pendingValidation !== null
      || nextRecord.pendingValidation !== null
      || !Number.isSafeInteger(notAfterMs)
      || notAfterMs <= snapshot.redisNowMs
    ) {
      fail("SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED");
    }
    const promotedRecordValue = clone(nextRecord);
    promotedRecordValue.revision += 1;
    const promotedRecord = validateRecallReferenceRun(
      promotedRecordValue,
    );
    const promotedRaw = canonicalJson(promotedRecord);
    const pendingValue = clone(snapshot.record);
    pendingValue.pendingValidation = {
      nextRecordDigest: rawDigest(promotedRaw),
      notAfterMs,
      recoveryExpiresAtMs: Math.min(
        notAfterMs,
        snapshot.redisNowMs
          + SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS,
      ),
    };
    pendingValue.updatedAtMs = snapshot.redisNowMs;
    pendingValue.revision += 1;
    const pendingRecord = validateRecallReferenceRun(
      pendingValue,
    );
    const staged = await casRunOnce(
      snapshot,
      pendingRecord,
      {
        ...options,
        notAfterMs:
          pendingRecord.pendingValidation
            .recoveryExpiresAtMs,
        artifactRecord: promotedRecord,
      },
    );
    return casRunOnce(
      staged,
      promotedRecord,
      {
        notBeforeMs: staged.redisNowMs,
        pendingPromotionDigest:
          pendingRecord.pendingValidation.nextRecordDigest,
      },
    );
  }

  async function claimRecallReferencePage(work) {
    const selected = canonicalWork(work);
    const snapshot = await readRun(selected);
    const { record, redisNowMs } = snapshot;
    if (record.pendingValidation !== null) {
      if (
        record.pendingValidation.recoveryExpiresAtMs
          > redisNowMs
      ) {
        return deepFreeze({
          status: "in_progress",
          aggregate: aggregateFor(record),
        });
      }
      const next = invalidated(
        record,
        "pending_transition_expired",
        redisNowMs,
      );
      const settled = await casRun(snapshot, next);
      return terminalClaim(settled.record);
    }
    if (record.status !== "collecting") {
      if (record.status === "sealed_unpinnable") {
        try {
          await verifySealedReferenceArtifacts(snapshot);
        } catch {
          const settled = await invalidateUnverifiedSealedRun(
            selected,
          );
          return terminalClaim(settled.record);
        }
      }
      return terminalClaim(record);
    }
    if (
      redisNowMs - record.createdAtMs
        >= SOURCE_RECALL_REFERENCE_MAX_COLLECTION_AGE_MS
    ) {
      const next = invalidated(
        record,
        "collection_age_exceeded",
        redisNowMs,
      );
      const settled = await casRun(snapshot, next);
      return terminalClaim(settled.record);
    }
    if (record.activeClaim !== null) {
      if (record.activeClaim.expiresAtMs > redisNowMs) {
        return deepFreeze({
          status: "in_progress",
          aggregate: aggregateFor(record),
        });
      }
      const next = invalidated(
        record,
        "abandoned_page_claim",
        redisNowMs,
      );
      const settled = await casRun(snapshot, next);
      return terminalClaim(settled.record);
    }
    const pass = record.passes.find(
      (item) => item.status !== "complete",
    );
    if (!pass) {
      fail("SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED");
    }
    const request = requestForPass(record, pass);
    const claimNonceDigest = randomBytes(32).toString("hex");
    const next = clone(record);
    const nextPass = next.passes[pass.passNumber - 1];
    if (nextPass.status === "pending") {
      nextPass.status = "collecting";
      nextPass.startedAtMs = redisNowMs;
    }
    next.activeClaim = {
      claimNonceDigest,
      passNumber: pass.passNumber,
      pageNumber: pass.nextPageNumber,
      requestDigest: request.requestDigest,
      issuedAtMs: redisNowMs,
      expiresAtMs:
        redisNowMs + SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS,
    };
    next.updatedAtMs = redisNowMs;
    next.revision += 1;
    const claimedSnapshot = await casRun(
      snapshot,
      validateRecallReferenceRun(next),
      {
        notAfterMs:
          record.createdAtMs
          + SOURCE_RECALL_REFERENCE_MAX_COLLECTION_AGE_MS,
      },
    );
    const confirmationStartedAtMonotonicMs = performance.now();
    if (
      !Number.isFinite(confirmationStartedAtMonotonicMs)
      || confirmationStartedAtMonotonicMs < 0
    ) {
      fail("SOURCE_RECALL_REFERENCE_MONOTONIC_CLOCK_INVALID");
    }
    const confirmedSnapshot = await readRun(selected);
    const confirmationCompletedAtMonotonicMs = performance.now();
    if (
      !Number.isFinite(confirmationCompletedAtMonotonicMs)
      || confirmationCompletedAtMonotonicMs
        < confirmationStartedAtMonotonicMs
    ) {
      fail("SOURCE_RECALL_REFERENCE_MONOTONIC_CLOCK_INVALID");
    }
    if (
      confirmedSnapshot.redisNowMs
        < claimedSnapshot.redisNowMs
    ) {
      fail("SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID");
    }
    if (confirmedSnapshot.raw !== claimedSnapshot.raw) {
      if (confirmedSnapshot.record.status === "invalidated") {
        return terminalClaim(confirmedSnapshot.record);
      }
      fail("SOURCE_RECALL_REFERENCE_CAS_CONFLICT");
    }
    const durableReadDeadlineMs = Math.min(
      confirmedSnapshot.record.activeClaim.expiresAtMs,
      confirmedSnapshot.record.createdAtMs
        + SOURCE_RECALL_REFERENCE_MAX_COLLECTION_AGE_MS,
    );
    const sourceReadStartDeadlineMonotonicMs =
      confirmationStartedAtMonotonicMs
      + (
        durableReadDeadlineMs
        - confirmedSnapshot.redisNowMs
      )
      - SOURCE_RECALL_PAGE_TIMEOUT_MS
      - SOURCE_RECALL_REFERENCE_PROVIDER_HANDOFF_MARGIN_MS
      - SOURCE_RECALL_REFERENCE_CHECKPOINT_COMMIT_MARGIN_MS;
    if (
      confirmedSnapshot.redisNowMs
        >= durableReadDeadlineMs
      || !Number.isFinite(
        sourceReadStartDeadlineMonotonicMs,
      )
      || confirmationCompletedAtMonotonicMs
        >= sourceReadStartDeadlineMonotonicMs
    ) {
      const invalid = invalidated(
        confirmedSnapshot.record,
        "page_claim_read_budget_exhausted",
        confirmedSnapshot.redisNowMs,
      );
      const settled = await casRun(confirmedSnapshot, invalid);
      return terminalClaim(settled.record);
    }
    const claim = deepFreeze({
      status: "page_required",
      workKeyDigest: selected.workKeyDigest,
      claimNonceDigest,
      passNumber: pass.passNumber,
      pageNumber: pass.nextPageNumber,
      boundaryAt: request.boundaryAt,
      cursor: request.cursor,
      seenCursors: deepFreeze([...request.seenCursors]),
      requestDigest: request.requestDigest,
      sourceReadStartDeadlineMonotonicMs,
    });
    issuedClaims.set(claim, confirmedSnapshot.raw);
    return claim;
  }

  function canonicalIssuedClaim(value) {
    const code = "SOURCE_RECALL_REFERENCE_CLAIM_INVALID";
    const claim = exactRecord(value, CLAIM_KEYS, code);
    if (
      !Object.isFrozen(value)
      || claim.status !== "page_required"
      || ![1, 2].includes(claim.passNumber)
      || !Number.isSafeInteger(claim.pageNumber)
      || claim.pageNumber < 1
      || !Object.isFrozen(claim.seenCursors)
      || !Number.isFinite(
        claim.sourceReadStartDeadlineMonotonicMs,
      )
      || claim.sourceReadStartDeadlineMonotonicMs <= 0
      || !issuedClaims.has(value)
    ) {
      fail(code);
    }
    digest(claim.workKeyDigest, code);
    digest(claim.claimNonceDigest, code);
    digest(claim.requestDigest, code);
    const boundaryAt =
      canonicalBoundaryFromString(claim.boundaryAt, code);
    const normalizedCursor = canonicalRecallCursor(
      claim.cursor,
      boundaryAt,
      code,
    );
    const seenCursors = denseArraySnapshot(
      claim.seenCursors,
      code,
    ).map((item) => canonicalRecallCursor(
      item,
      boundaryAt,
      code,
    ));
    if (
      normalizedCursor !== claim.cursor
      || seenCursors.some((item) => item === null)
      || seenCursors.length !== Math.max(0, claim.pageNumber - 2)
      || recallCursorPage(normalizedCursor, boundaryAt, code)
        !== claim.pageNumber
    ) {
      fail(code);
    }
    for (let index = 0; index < seenCursors.length; index += 1) {
      if (
        recallCursorPage(seenCursors[index], boundaryAt, code)
          !== index + 2
      ) {
        fail(code);
      }
    }
    return claim;
  }

  async function checkpointRecallReferencePage(claimValue, page) {
    const claim = canonicalIssuedClaim(claimValue);
    const expectedRaw = issuedClaims.get(claimValue);
    issuedClaims.delete(claimValue);
    const work = deepFreeze({
      workKeyDigest: claim.workKeyDigest,
    });
    const snapshot = await readRun(work);
    if (snapshot.raw !== expectedRaw) {
      fail("SOURCE_RECALL_REFERENCE_CAS_CONFLICT");
    }
    const transitioned = transitionPage(
      snapshot.record,
      claim,
      page,
      snapshot.redisNowMs,
    );
    const pageKey = transitioned.pageRaw === null
      ? null
      : pageKeyFor(
        claim.workKeyDigest,
        claim.passNumber,
        claim.pageNumber,
      );
    const pageExpiresAtMs = transitioned.pageRaw === null
      ? null
      : transitioned.next.passes[
        claim.passNumber - 1
      ].pageManifests[claim.pageNumber - 1]
        .pageExpiresAtMs;
    const requiredPageSet = transitioned.headRaw === null
      ? []
      : transitioned.next.passes[1].pageManifests.map(
        (manifest) => deepFreeze({
          key: pageKeyFor(
            claim.workKeyDigest,
            2,
            manifest.pageNumber,
          ),
          rawDigest: manifest.pageRecordDigest,
          nativeByteProofDigest:
            manifest.pageNativeByteProofDigest,
          expectedExpiresAtMs: manifest.pageExpiresAtMs,
          minimumRemainingTtlMs:
            SOURCE_RECALL_REFERENCE_MIN_PAGE_RETENTION_MS,
        }),
      );
    const nextSnapshot = await casRun(
      snapshot,
      transitioned.next,
      {
        pageRaw: transitioned.pageRaw,
        pageKey,
        pageExpiresAtMs,
        headRaw: transitioned.headRaw,
        requiredPageSet,
        notBeforeMs: snapshot.redisNowMs,
        notAfterMs: transitioned.pageRaw === null
          ? null
          : Math.min(
            snapshot.record.activeClaim.expiresAtMs,
            snapshot.record.createdAtMs
              + SOURCE_RECALL_REFERENCE_MAX_COLLECTION_AGE_MS,
          ),
      },
    );
    if (transitioned.headRaw !== null) {
      try {
        await verifySealedReferenceArtifacts(nextSnapshot);
      } catch {
        await invalidateUnverifiedSealedRun(work);
        fail("SOURCE_RECALL_REFERENCE_HEAD_READBACK_FAILED");
      }
    }
    return deepFreeze({
      snapshot: nextSnapshot,
      aggregate: aggregateFor(nextSnapshot.record),
    });
  }

  async function recordRecallReferencePageFailure(
    claimValue,
    reason = "source_page_read_failed",
  ) {
    const claim = canonicalIssuedClaim(claimValue);
    if (
      typeof reason !== "string"
      || !/^[a-z0-9_]{1,80}$/u.test(reason)
    ) {
      fail("SOURCE_RECALL_REFERENCE_FAILURE_REASON_INVALID");
    }
    const expectedRaw = issuedClaims.get(claimValue);
    issuedClaims.delete(claimValue);
    const snapshot = await readRun(deepFreeze({
      workKeyDigest: claim.workKeyDigest,
    }));
    if (snapshot.raw !== expectedRaw) {
      fail("SOURCE_RECALL_REFERENCE_CAS_CONFLICT");
    }
    const next = invalidated(
      snapshot.record,
      reason,
      snapshot.redisNowMs,
    );
    const nextSnapshot = await casRun(snapshot, next);
    return deepFreeze({
      snapshot: nextSnapshot,
      aggregate: aggregateFor(nextSnapshot.record),
    });
  }

  async function readRecallReferenceHead(work) {
    const selected = canonicalWork(work);
    const snapshot = await readRun(selected);
    if (
      snapshot.record.status !== "sealed_unpinnable"
      || snapshot.record.headRecordDigest === null
    ) {
      fail("SOURCE_RECALL_REFERENCE_HEAD_NOT_AVAILABLE");
    }
    let verified;
    try {
      verified = await verifySealedReferenceArtifacts(snapshot);
    } catch {
      await invalidateUnverifiedSealedRun(selected);
      fail("SOURCE_RECALL_REFERENCE_SEALED_ARTIFACTS_INVALID");
    }
    return deepFreeze({
      raw: verified.headRaw,
      record: verified.head,
      recallReferenceHeadEpochDigest:
        verified.head.recallReferenceHeadEpochDigest,
      recallReferenceHeadRevisionDigest:
        verified.head.recallReferenceHeadRevisionDigest,
      recallReferenceHeadRecordDigest:
        verified.recallReferenceHeadRecordDigest,
      redisNowMs: verified.verifiedAtMs,
      pointReadAvailable: false,
      sourceFactsAvailable: false,
      pinnable: false,
      authorityAvailable: false,
    });
  }

  // This is a server-private bridge from the sealed reference artifact to
  // store-owned point-read work construction. It accepts no raw key, pass,
  // cursor, reference, digest, TTL, or force input. The complete sealed
  // pass-two artifact is re-proved before the one selected private page is
  // read, and that read cannot renew its original absolute expiry.
  async function readRecallReferencePage(input) {
    const selected = canonicalPrivatePageRead(input);
    const work = deepFreeze({
      workKeyDigest: selected.workKeyDigest,
    });
    const snapshot = await readRun(work);
    if (
      snapshot.record.status !== "sealed_unpinnable"
      || snapshot.record.headRecordDigest === null
    ) {
      fail("SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_NOT_AVAILABLE");
    }
    let verified;
    try {
      verified = await verifySealedReferenceArtifacts(snapshot);
    } catch {
      await invalidateUnverifiedSealedRun(work);
      fail("SOURCE_RECALL_REFERENCE_SEALED_ARTIFACTS_INVALID");
    }
    const expectedManifest = snapshot.record.passes[1]
      .pageManifests[selected.pageNumber - 1];
    const expectedHeadManifest =
      verified.head.pageManifests[selected.pageNumber - 1];
    if (
      !expectedManifest
      || !expectedHeadManifest
      || canonicalJson(digestOnlyPageManifest(expectedManifest))
        !== canonicalJson(expectedHeadManifest)
    ) {
      fail("SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_NOT_AVAILABLE");
    }
    const pageKey = pageKeyFor(
      selected.workKeyDigest,
      2,
      selected.pageNumber,
    );
    try {
      const result = persistenceResult(
        await durable.readPage({ key: pageKey }),
        PRIVATE_PAGE_READ_RESULT_KEYS,
      );
      if (
        typeof result.raw !== "string"
        || result.raw.length === 0
        || result.redisNowMs < verified.verifiedAtMs
        || !Number.isSafeInteger(result.remainingTtlMs)
        || result.remainingTtlMs
          < SOURCE_RECALL_REFERENCE_MIN_SEALED_RETENTION_MS
        || expectedManifest.pageExpiresAtMs
          - result.redisNowMs !== result.remainingTtlMs
      ) {
        fail("SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_INVALID");
      }
      let parsed;
      try {
        parsed = JSON.parse(result.raw);
      } catch {
        fail("SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_INVALID");
      }
      const record = canonicalPrivateReferencePage(
        parsed,
        snapshot.record,
        expectedManifest,
      );
      if (
        canonicalJson(record) !== result.raw
        || rawDigest(result.raw)
          !== expectedManifest.pageRecordDigest
        || createHash("sha1").update(result.raw).digest("hex")
          !== expectedManifest.pageNativeByteProofDigest
      ) {
        fail("SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_INVALID");
      }
      return deepFreeze({
        record,
        pageKeyDigest: persistenceKeyDigest(pageKey),
        pageRecordDigest: expectedManifest.pageRecordDigest,
        pageNativeByteProofDigest:
          expectedManifest.pageNativeByteProofDigest,
        recallReferenceHeadEpochDigest:
          verified.head.recallReferenceHeadEpochDigest,
        recallReferenceHeadRevisionDigest:
          verified.head.recallReferenceHeadRevisionDigest,
        recallReferenceHeadRecordDigest:
          verified.recallReferenceHeadRecordDigest,
        redisNowMs: result.redisNowMs,
        remainingTtlMs: result.remainingTtlMs,
      });
    } catch {
      await invalidateUnverifiedSealedRun(work);
      fail("SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_INVALID");
    }
  }

  return deepFreeze({
    claimRecallReferencePage,
    checkpointRecallReferencePage,
    ensureRecallReferenceRun,
    readRecallReferenceHead,
    readRecallReferencePage,
    recallReferenceAggregateStatus,
    recordRecallReferencePageFailure,
  });
}
