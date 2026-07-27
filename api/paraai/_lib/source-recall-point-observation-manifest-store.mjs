// Private, hard-dark full-manifest Recall point-observation store.
//
// The caller supplies only one verified sealed-reference head. This store
// durably indexes every verified pass-two page before it permits any point
// observation. Page and reference selection are then owned by durable state.
// The persisted index contains commitments only: no raw references, candidate
// fields, cursors, point bodies, evidence, or transport receipts.
//
// No production route, worker, coordinator, health surface, source tick, or
// release gate imports this module.

import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  types as nodeTypes,
} from "node:util";

import {
  SOURCE_RECALL_PAGE_CLIENT_VERSION,
  SOURCE_RECALL_PAGE_SIZE,
} from "./source-recall-page-client.mjs";
import {
  SOURCE_RECALL_POINT_OBSERVATION_CLAIM_LEASE_MS,
  SOURCE_RECALL_POINT_OBSERVATION_MAX_INTERVAL_MS,
  createSourceRecallPointObservationManifestPointInterface,
  createSourceRecallPointObservationPersistenceAdapter,
} from "./source-recall-point-observation-store.mjs";
import {
  SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION,
  SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS,
} from "./source-recall-reference-persistence-protocol.mjs";

export const SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_STORE_VERSION =
  "recall-point-observation-manifest-store-dark-v1";
export const SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RECORD_VERSION = 1;
export const SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PAGE_VERSION = 1;
export const SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CLAIM_LEASE_MS =
  SOURCE_RECALL_POINT_OBSERVATION_CLAIM_LEASE_MS;

const SOURCE = "recall";
const MAX_PAGES = 200;
const MAX_REFERENCES = MAX_PAGES * SOURCE_RECALL_PAGE_SIZE;
const MAX_RAW_BYTES = 256 * 1_024;
const RUN_PREFIX =
  "paraai:phase4:recall-point-observation-manifest:v1:run:";
const PAGE_PREFIX =
  "paraai:phase4:recall-point-observation-manifest:v1:page:";
const DIGEST = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const RUN_STATUSES = new Set([
  "indexing_pages",
  "observing",
  "verifying_complete",
  "observed_complete_dark",
]);
const RUN_STATUS_ORDER = new Map([
  ["indexing_pages", 0],
  ["observing", 1],
  ["verifying_complete", 2],
  ["observed_complete_dark", 3],
]);
const POINT_TERMINAL_STATUSES = new Set([
  "stable",
  "conflict",
  "unresolved",
]);
const CLAIM_TYPES = new Set([
  "index_page",
  "observe_work",
]);
const RUN_KEYS = Object.freeze([
  "activeClaim",
  "authorityAvailable",
  "candidateIdentityResolutionAvailable",
  "completeProofDigest",
  "contractPinsDigest",
  "createdAtMs",
  "decisionBoundaryAtMs",
  "expiresAtMs",
  "globalReferenceSetCoverageAvailable",
  "headPageSetDigest",
  "indexedManifestDigest",
  "kind",
  "manifestKeyDigest",
  "nextObservationOrdinal",
  "nextObservationPageNumber",
  "nextPageNumber",
  "operational",
  "pageCount",
  "pageManifests",
  "pagesIndexed",
  "pinnable",
  "policyVersion",
  "recallReferenceHeadEpochDigest",
  "recallReferenceHeadRecordDigest",
  "recallReferenceHeadRevisionDigest",
  "referenceCount",
  "referenceManifestCoverageComplete",
  "referenceManifestDigest",
  "referencesConflict",
  "referencesIndexed",
  "referencesSettled",
  "referencesStable",
  "referencesUnresolved",
  "revision",
  "runNonceDigest",
  "scannedCount",
  "settledReadsCompleted",
  "source",
  "sourceFactsAvailable",
  "stablePassSemanticDigest",
  "status",
  "successClassificationAvailable",
  "updatedAtMs",
  "version",
  "workKeyDigest",
]);
const ACTIVE_CLAIM_KEYS = Object.freeze([
  "claimNonceDigest",
  "expiresAtMs",
  "issuedAtMs",
  "pageNumber",
  "referenceOrdinal",
  "type",
  "workKeyDigest",
]);
const PAGE_MANIFEST_KEYS = Object.freeze([
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
const HEAD_RESULT_KEYS = Object.freeze([
  "authorityAvailable",
  "pinnable",
  "pointReadAvailable",
  "raw",
  "recallReferenceHeadEpochDigest",
  "recallReferenceHeadRecordDigest",
  "recallReferenceHeadRevisionDigest",
  "record",
  "redisNowMs",
  "sourceFactsAvailable",
]);
const HEAD_RECORD_KEYS = Object.freeze([
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
  "recallReferenceHeadEpochDigest",
  "recallReferenceHeadRevisionDigest",
  "referenceCount",
  "referenceManifestDigest",
  "runNonceDigest",
  "scannedCount",
  "sealedAtMs",
  "source",
  "sourceFactsAvailable",
  "stablePassSemanticDigest",
  "successClassificationAvailable",
  "version",
  "workKeyDigest",
]);
const PAGE_KEYS = Object.freeze([
  "createdAtMs",
  "entries",
  "expiresAtMs",
  "indexDigest",
  "kind",
  "manifestKeyDigest",
  "outcomeDigest",
  "pageExpiresAtMs",
  "pageKeyDigest",
  "pageNativeByteProofDigest",
  "pageNumber",
  "pageRecordDigest",
  "pageSemanticDigest",
  "policyVersion",
  "recallReferenceHeadEpochDigest",
  "recallReferenceHeadRecordDigest",
  "recallReferenceHeadRevisionDigest",
  "referenceCount",
  "referencesConflict",
  "referencesSettled",
  "referencesStable",
  "referencesUnresolved",
  "revision",
  "scannedCount",
  "settledReadsCompleted",
  "source",
  "updatedAtMs",
  "version",
]);
const ENTRY_KEYS = Object.freeze([
  "outcome",
  "readsCompleted",
  "referenceDigest",
  "referenceIdDigest",
  "resolutionDigest",
  "workItemDigest",
  "workKeyDigest",
]);
const MANIFEST_ENTRY_RESULT_KEYS = Object.freeze([
  "contractPinsDigest",
  "decisionBoundaryAtMs",
  "entries",
  "pageExpiresAtMs",
  "pageKeyDigest",
  "pageNativeByteProofDigest",
  "pageNumber",
  "pageRecordDigest",
  "pageSemanticDigest",
  "recallReferenceHeadEpochDigest",
  "recallReferenceHeadRecordDigest",
  "recallReferenceHeadRevisionDigest",
  "referenceCount",
  "runNonceDigest",
  "scannedCount",
  "verifiedAtMs",
]);
const MANIFEST_ENTRY_KEYS = Object.freeze([
  "referenceDigest",
  "referenceIdDigest",
  "workItemDigest",
  "workKeyDigest",
]);
const POINT_SNAPSHOT_KEYS = Object.freeze([
  "raw",
  "rawSha1",
  "record",
  "redisNowMs",
]);
const RUN_WORK_KEYS = Object.freeze(["manifestKeyDigest"]);
const POINT_WORK_KEYS = Object.freeze(["workKeyDigest"]);
const PERSISTENCE_METHODS = Object.freeze([
  "compareAndSet",
  "ensure",
  "read",
  "time",
]);
const POINT_METHODS = Object.freeze([
  "manifestEntries",
  "prepareManifestSelection",
  "readManifestSelection",
]);
const FACTORY_KEYS = Object.freeze([
  "persistence",
  "pointObservation",
]);
const issuedPointSelections = new WeakMap();

export class SourceRecallPointObservationManifestStoreError
  extends Error {
  constructor(code) {
    super(code);
    this.name =
      "SourceRecallPointObservationManifestStoreError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallPointObservationManifestStoreError(code);
}

function issueRecallPointObservationManifestCapability(
  purpose,
  selection,
) {
  const capability = Object.freeze({});
  issuedPointSelections.set(capability, deepFreeze({
    purpose,
    selection,
  }));
  return capability;
}

function consumeRecallPointObservationManifestCapability(
  capability,
  purpose,
) {
  if (
    capability === null
    || typeof capability !== "object"
    || !Object.isFrozen(capability)
    || !issuedPointSelections.has(capability)
  ) {
    fail(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CAPABILITY_INVALID",
    );
  }
  const issued = issuedPointSelections.get(capability);
  issuedPointSelections.delete(capability);
  if (issued.purpose !== purpose) {
    fail(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CAPABILITY_INVALID",
    );
  }
  return issued.selection;
}

export function consumeRecallPointObservationManifestPrepareCapability(
  capability,
) {
  return consumeRecallPointObservationManifestCapability(
    capability,
    "prepare",
  );
}

export function consumeRecallPointObservationManifestReadCapability(
  capability,
) {
  return consumeRecallPointObservationManifestCapability(
    capability,
    "read",
  );
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
  return snapshot;
}

function exactRecord(value, keys, code) {
  const record = plainRecordSnapshot(value, code);
  if (
    !sameKeys(
      Object.keys(record).sort(),
      [...keys].sort(),
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
    ...result.map((unused, index) => String(index)),
  ]);
  if (
    Object.keys(descriptors).some((key) => !allowed.has(key))
  ) {
    fail(code);
  }
  return result;
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

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CANONICAL_VALUE_INVALID",
      );
    }
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
  fail(
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CANONICAL_VALUE_INVALID",
  );
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

function rawSha1(raw) {
  return createHash("sha1").update(raw).digest("hex");
}

function exactDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
  return value;
}

function exactSha1(value, code) {
  if (typeof value !== "string" || !SHA1.test(value)) fail(code);
  return value;
}

function safeInteger(value, code, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(code);
  }
  return value;
}

function optionalInteger(value, code, minimum = 0) {
  return value === null
    ? null
    : safeInteger(value, code, minimum);
}

function optionalDigest(value, code) {
  return value === null ? null : exactDigest(value, code);
}

function persistenceInterface(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PERSISTENCE_INVALID";
  const persistence = exactRecord(
    value,
    PERSISTENCE_METHODS,
    code,
  );
  for (const method of PERSISTENCE_METHODS) {
    if (typeof persistence[method] !== "function") fail(code);
  }
  return Object.freeze(persistence);
}

function pointObservationInterface(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_POINT_INTERFACE_INVALID";
  const selected = exactRecord(value, POINT_METHODS, code);
  for (const method of POINT_METHODS) {
    if (typeof selected[method] !== "function") fail(code);
  }
  return Object.freeze(selected);
}

function canonicalPageManifest(value, pageNumber, code) {
  const raw = exactRecord(value, PAGE_MANIFEST_KEYS, code);
  if (
    safeInteger(raw.pageNumber, code, 1) !== pageNumber
    || raw.pageNumber > MAX_PAGES
  ) {
    fail(code);
  }
  const pageExpiresAtMs = safeInteger(
    raw.pageExpiresAtMs,
    code,
    1,
  );
  const scannedCount = safeInteger(raw.scannedCount, code);
  const referenceCount = safeInteger(
    raw.referenceCount,
    code,
  );
  if (
    scannedCount > SOURCE_RECALL_PAGE_SIZE
    || referenceCount > scannedCount
  ) {
    fail(code);
  }
  return deepFreeze({
    cursorDigest: exactDigest(raw.cursorDigest, code),
    nextCursorDigest: exactDigest(
      raw.nextCursorDigest,
      code,
    ),
    pageExpiresAtMs,
    pageNativeByteProofDigest: exactSha1(
      raw.pageNativeByteProofDigest,
      code,
    ),
    pageNumber,
    pageRecordDigest: exactDigest(
      raw.pageRecordDigest,
      code,
    ),
    pageSemanticDigest: exactDigest(
      raw.pageSemanticDigest,
      code,
    ),
    referenceCount,
    scannedCount,
  });
}

function verifiedHead(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_VERIFIED_HEAD_INVALID";
  const wrapper = exactRecord(value, HEAD_RESULT_KEYS, code);
  if (!Object.isFrozen(value)) fail(code);
  const record = exactRecord(
    wrapper.record,
    HEAD_RECORD_KEYS,
    code,
  );
  if (
    !Object.isFrozen(wrapper.record)
    || record.version !== 1
    || record.policyVersion
      !== SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION
    || record.kind !== "recall_reference_artifact_head_dark"
    || record.source !== SOURCE
    || record.clientVersion !== SOURCE_RECALL_PAGE_CLIENT_VERSION
    || record.passCount !== 2
    || record.pointReadAvailable !== false
    || record.sourceFactsAvailable !== false
    || record.successClassificationAvailable !== false
    || record.candidateIdentityResolutionAvailable !== false
    || record.pinnable !== false
    || record.authorityAvailable !== false
    || wrapper.pointReadAvailable !== false
    || wrapper.sourceFactsAvailable !== false
    || wrapper.pinnable !== false
    || wrapper.authorityAvailable !== false
  ) {
    fail(code);
  }
  const pageCount = safeInteger(record.pageCount, code, 1);
  const scannedCount = safeInteger(record.scannedCount, code);
  const referenceCount = safeInteger(
    record.referenceCount,
    code,
  );
  const redisNowMs = safeInteger(wrapper.redisNowMs, code);
  const decisionBoundaryAtMs = safeInteger(
    record.decisionBoundaryAtMs,
    code,
  );
  const sealedAtMs = safeInteger(record.sealedAtMs, code);
  if (
    pageCount > MAX_PAGES
    || referenceCount > MAX_REFERENCES
    || decisionBoundaryAtMs > sealedAtMs
    || sealedAtMs > redisNowMs
  ) {
    fail(code);
  }
  const pages = denseArraySnapshot(
    record.pageManifests,
    code,
  ).map(
    (page, index) => canonicalPageManifest(
      page,
      index + 1,
      code,
    ),
  );
  if (
    !Object.isFrozen(record.pageManifests)
    || pages.length !== pageCount
    || pages.reduce(
      (sum, page) => sum + page.scannedCount,
      0,
    ) !== scannedCount
    || pages.reduce(
      (sum, page) => sum + page.referenceCount,
      0,
    ) !== referenceCount
  ) {
    fail(code);
  }
  const expiresAtMs = Math.min(
    ...pages.map((page) => page.pageExpiresAtMs),
  );
  if (
    !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= redisNowMs
    || expiresAtMs - sealedAtMs
      > SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS
  ) {
    fail(code);
  }
  if (
    typeof wrapper.raw !== "string"
    || wrapper.raw.length === 0
    || Buffer.byteLength(wrapper.raw, "utf8") > MAX_RAW_BYTES
    || canonicalJson(record) !== wrapper.raw
  ) {
    fail(code);
  }
  const headRecordDigest = exactDigest(
    wrapper.recallReferenceHeadRecordDigest,
    code,
  );
  const headEpochDigest = exactDigest(
    wrapper.recallReferenceHeadEpochDigest,
    code,
  );
  const headRevisionDigest = exactDigest(
    wrapper.recallReferenceHeadRevisionDigest,
    code,
  );
  if (
    rawDigest(wrapper.raw) !== headRecordDigest
    || record.recallReferenceHeadEpochDigest
      !== headEpochDigest
    || record.recallReferenceHeadRevisionDigest
      !== headRevisionDigest
  ) {
    fail(code);
  }
  const workKeyDigest = exactDigest(
    record.workKeyDigest,
    code,
  );
  const manifestKeyDigest = semanticDigest(
    "phase4-recall-point-observation-manifest-work-v1",
    {
      policyVersion:
        SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_STORE_VERSION,
      workKeyDigest,
    },
  );
  return deepFreeze({
    contractPinsDigest: exactDigest(
      record.contractPinsDigest,
      code,
    ),
    decisionBoundaryAtMs,
    expiresAtMs,
    headPageSetDigest: semanticDigest(
      "phase4-recall-point-observation-manifest-head-pages-v1",
      pages,
    ),
    manifestKeyDigest,
    pageCount,
    pageManifests: pages,
    recallReferenceHeadEpochDigest: headEpochDigest,
    recallReferenceHeadRecordDigest: headRecordDigest,
    recallReferenceHeadRevisionDigest:
      headRevisionDigest,
    referenceCount,
    referenceManifestDigest: exactDigest(
      record.referenceManifestDigest,
      code,
    ),
    redisNowMs,
    runNonceDigest: exactDigest(
      record.runNonceDigest,
      code,
    ),
    scannedCount,
    stablePassSemanticDigest: exactDigest(
      record.stablePassSemanticDigest,
      code,
    ),
    workKeyDigest,
  });
}

function canonicalActiveClaim(value, run, code) {
  if (value === null) return null;
  const raw = exactRecord(value, ACTIVE_CLAIM_KEYS, code);
  if (
    !CLAIM_TYPES.has(raw.type)
    || safeInteger(raw.issuedAtMs, code) !== run.updatedAtMs
  ) {
    fail(code);
  }
  const pageNumber = safeInteger(raw.pageNumber, code, 1);
  const referenceOrdinal = optionalInteger(
    raw.referenceOrdinal,
    code,
  );
  const workKeyDigest = raw.workKeyDigest === null
    ? null
    : exactDigest(raw.workKeyDigest, code);
  const expiresAtMs = safeInteger(raw.expiresAtMs, code, 1);
  if (
    pageNumber > run.pageCount
    || expiresAtMs <= raw.issuedAtMs
    || expiresAtMs !== Math.min(
      raw.issuedAtMs
        + SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CLAIM_LEASE_MS,
      run.expiresAtMs,
    )
    || (
      raw.type === "index_page"
      && (
        run.status !== "indexing_pages"
        || pageNumber !== run.nextPageNumber
        || referenceOrdinal !== null
        || workKeyDigest !== null
      )
    )
    || (
      raw.type === "observe_work"
      && (
        run.status !== "observing"
        || pageNumber !== run.nextObservationPageNumber
        || referenceOrdinal !== run.nextObservationOrdinal
        || referenceOrdinal === null
        || referenceOrdinal >= SOURCE_RECALL_PAGE_SIZE
        || workKeyDigest === null
      )
    )
  ) {
    fail(code);
  }
  return deepFreeze({
    claimNonceDigest: exactDigest(
      raw.claimNonceDigest,
      code,
    ),
    expiresAtMs,
    issuedAtMs: raw.issuedAtMs,
    pageNumber,
    referenceOrdinal,
    type: raw.type,
    workKeyDigest,
  });
}

function validateRun(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_DURABLE_STATE_INVALID";
  const raw = exactRecord(value, RUN_KEYS, code);
  if (
    raw.version
      !== SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RECORD_VERSION
    || raw.policyVersion
      !== SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_STORE_VERSION
    || raw.kind !== "recall_point_observation_manifest_dark"
    || raw.source !== SOURCE
    || !RUN_STATUSES.has(raw.status)
    || raw.operational !== false
    || raw.sourceFactsAvailable !== false
    || raw.successClassificationAvailable !== false
    || raw.candidateIdentityResolutionAvailable !== false
    || raw.pinnable !== false
    || raw.authorityAvailable !== false
  ) {
    fail(code);
  }
  const run = {
    ...raw,
    manifestKeyDigest: exactDigest(
      raw.manifestKeyDigest,
      code,
    ),
    workKeyDigest: exactDigest(raw.workKeyDigest, code),
    runNonceDigest: exactDigest(raw.runNonceDigest, code),
    contractPinsDigest: exactDigest(
      raw.contractPinsDigest,
      code,
    ),
    recallReferenceHeadEpochDigest: exactDigest(
      raw.recallReferenceHeadEpochDigest,
      code,
    ),
    recallReferenceHeadRevisionDigest: exactDigest(
      raw.recallReferenceHeadRevisionDigest,
      code,
    ),
    recallReferenceHeadRecordDigest: exactDigest(
      raw.recallReferenceHeadRecordDigest,
      code,
    ),
    referenceManifestDigest: exactDigest(
      raw.referenceManifestDigest,
      code,
    ),
    stablePassSemanticDigest: exactDigest(
      raw.stablePassSemanticDigest,
      code,
    ),
    headPageSetDigest: exactDigest(
      raw.headPageSetDigest,
      code,
    ),
    indexedManifestDigest: optionalDigest(
      raw.indexedManifestDigest,
      code,
    ),
    completeProofDigest: optionalDigest(
      raw.completeProofDigest,
      code,
    ),
    decisionBoundaryAtMs: safeInteger(
      raw.decisionBoundaryAtMs,
      code,
    ),
    pageCount: safeInteger(raw.pageCount, code, 1),
    scannedCount: safeInteger(raw.scannedCount, code),
    referenceCount: safeInteger(
      raw.referenceCount,
      code,
    ),
    pagesIndexed: safeInteger(raw.pagesIndexed, code),
    referencesIndexed: safeInteger(
      raw.referencesIndexed,
      code,
    ),
    referencesSettled: safeInteger(
      raw.referencesSettled,
      code,
    ),
    referencesStable: safeInteger(
      raw.referencesStable,
      code,
    ),
    referencesConflict: safeInteger(
      raw.referencesConflict,
      code,
    ),
    referencesUnresolved: safeInteger(
      raw.referencesUnresolved,
      code,
    ),
    settledReadsCompleted: safeInteger(
      raw.settledReadsCompleted,
      code,
    ),
    nextPageNumber: optionalInteger(
      raw.nextPageNumber,
      code,
      1,
    ),
    nextObservationPageNumber: optionalInteger(
      raw.nextObservationPageNumber,
      code,
      1,
    ),
    nextObservationOrdinal: optionalInteger(
      raw.nextObservationOrdinal,
      code,
    ),
    createdAtMs: safeInteger(raw.createdAtMs, code),
    updatedAtMs: safeInteger(raw.updatedAtMs, code),
    expiresAtMs: safeInteger(raw.expiresAtMs, code, 1),
    revision: safeInteger(raw.revision, code),
  };
  if (
    run.pageCount > MAX_PAGES
    || run.referenceCount > MAX_REFERENCES
    || run.pagesIndexed > run.pageCount
    || run.referencesIndexed > run.referenceCount
    || run.referencesSettled > run.referencesIndexed
    || run.referencesStable
      + run.referencesConflict
      + run.referencesUnresolved
      !== run.referencesSettled
    || run.settledReadsCompleted
      > run.referencesSettled * 2
    || run.decisionBoundaryAtMs > run.createdAtMs
    || run.createdAtMs > run.updatedAtMs
    || run.updatedAtMs >= run.expiresAtMs
    || run.expiresAtMs - run.createdAtMs
      > SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS
  ) {
    fail(code);
  }
  const pageManifests = denseArraySnapshot(
    raw.pageManifests,
    code,
  ).map(
    (page, index) => canonicalPageManifest(
      page,
      index + 1,
      code,
    ),
  );
  if (
    pageManifests.length !== run.pageCount
    || canonicalJson(pageManifests)
      !== canonicalJson(raw.pageManifests)
    || pageManifests.reduce(
      (sum, page) => sum + page.scannedCount,
      0,
    ) !== run.scannedCount
    || pageManifests.reduce(
      (sum, page) => sum + page.referenceCount,
      0,
    ) !== run.referenceCount
    || Math.min(
      ...pageManifests.map((page) => page.pageExpiresAtMs),
    ) !== run.expiresAtMs
    || semanticDigest(
      "phase4-recall-point-observation-manifest-head-pages-v1",
      pageManifests,
    ) !== run.headPageSetDigest
  ) {
    fail(code);
  }
  run.pageManifests = pageManifests;
  const expectedManifestKey = semanticDigest(
    "phase4-recall-point-observation-manifest-work-v1",
    {
      policyVersion:
        SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_STORE_VERSION,
      workKeyDigest: run.workKeyDigest,
    },
  );
  if (run.manifestKeyDigest !== expectedManifestKey) fail(code);
  run.activeClaim = canonicalActiveClaim(
    raw.activeClaim,
    run,
    code,
  );
  const complete =
    run.status === "observed_complete_dark";
  const indexing = run.status === "indexing_pages";
  const observing = run.status === "observing";
  const verifying =
    run.status === "verifying_complete";
  if (
    raw.referenceManifestCoverageComplete !== complete
    || raw.globalReferenceSetCoverageAvailable
      !== (
        complete
        && run.referencesStable === run.referenceCount
        && run.referencesConflict === 0
        && run.referencesUnresolved === 0
      )
    || (
      indexing
      && (
        run.nextPageNumber !== (
          run.pagesIndexed >= run.pageCount
            ? run.pageCount + 1
            : run.pagesIndexed + 1
        )
        || run.referencesIndexed > run.referenceCount
        || run.indexedManifestDigest !== null
        || run.nextObservationPageNumber !== null
        || run.nextObservationOrdinal !== null
        || run.referencesSettled !== 0
        || run.completeProofDigest !== null
      )
    )
    || (
      !indexing
      && (
        run.pagesIndexed !== run.pageCount
        || run.referencesIndexed !== run.referenceCount
        || run.nextPageNumber !== null
        || run.indexedManifestDigest === null
      )
    )
    || (
      observing
      && (
        run.referencesSettled >= run.referenceCount
        || run.nextObservationPageNumber === null
        || run.nextObservationOrdinal === null
      )
    )
    || (
      verifying
      && (
        run.referencesSettled !== run.referenceCount
        || run.nextObservationPageNumber !== null
        || run.nextObservationOrdinal !== null
        || run.activeClaim !== null
        || run.completeProofDigest !== null
      )
    )
    || (
      complete
      && (
        run.referencesSettled !== run.referenceCount
        || run.nextObservationPageNumber !== null
        || run.nextObservationOrdinal !== null
        || run.activeClaim !== null
        || run.completeProofDigest === null
      )
    )
    || (
      !complete
      && run.completeProofDigest !== null
    )
  ) {
    fail(code);
  }
  return deepFreeze(run);
}

function canonicalEntry(value, code) {
  const raw = exactRecord(value, ENTRY_KEYS, code);
  const outcome = raw.outcome;
  if (
    !(
      outcome === null
      || POINT_TERMINAL_STATUSES.has(outcome)
    )
  ) {
    fail(code);
  }
  const readsCompleted = safeInteger(
    raw.readsCompleted,
    code,
  );
  const resolutionDigest = optionalDigest(
    raw.resolutionDigest,
    code,
  );
  if (
    (
      outcome === null
      && (readsCompleted !== 0 || resolutionDigest !== null)
    )
    || (
      ["stable", "conflict"].includes(outcome)
      && (readsCompleted !== 2 || resolutionDigest === null)
    )
    || (
      outcome === "unresolved"
      && (
        readsCompleted > 1
        || resolutionDigest === null
      )
    )
  ) {
    fail(code);
  }
  return deepFreeze({
    outcome,
    readsCompleted,
    referenceDigest: exactDigest(
      raw.referenceDigest,
      code,
    ),
    referenceIdDigest: exactDigest(
      raw.referenceIdDigest,
      code,
    ),
    resolutionDigest,
    workItemDigest: exactDigest(
      raw.workItemDigest,
      code,
    ),
    workKeyDigest: exactDigest(
      raw.workKeyDigest,
      code,
    ),
  });
}

function indexEntry(entry) {
  return {
    referenceDigest: entry.referenceDigest,
    referenceIdDigest: entry.referenceIdDigest,
    workItemDigest: entry.workItemDigest,
    workKeyDigest: entry.workKeyDigest,
  };
}

function outcomeEntry(entry) {
  return {
    outcome: entry.outcome,
    readsCompleted: entry.readsCompleted,
    resolutionDigest: entry.resolutionDigest,
    workKeyDigest: entry.workKeyDigest,
  };
}

function validatePage(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PAGE_STATE_INVALID";
  const raw = exactRecord(value, PAGE_KEYS, code);
  if (
    raw.version
      !== SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PAGE_VERSION
    || raw.policyVersion
      !== SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_STORE_VERSION
    || raw.kind
      !== "recall_point_observation_manifest_page_dark"
    || raw.source !== SOURCE
  ) {
    fail(code);
  }
  const page = {
    ...raw,
    manifestKeyDigest: exactDigest(
      raw.manifestKeyDigest,
      code,
    ),
    recallReferenceHeadEpochDigest: exactDigest(
      raw.recallReferenceHeadEpochDigest,
      code,
    ),
    recallReferenceHeadRevisionDigest: exactDigest(
      raw.recallReferenceHeadRevisionDigest,
      code,
    ),
    recallReferenceHeadRecordDigest: exactDigest(
      raw.recallReferenceHeadRecordDigest,
      code,
    ),
    pageNumber: safeInteger(raw.pageNumber, code, 1),
    pageKeyDigest: exactDigest(raw.pageKeyDigest, code),
    pageRecordDigest: exactDigest(
      raw.pageRecordDigest,
      code,
    ),
    pageNativeByteProofDigest: exactSha1(
      raw.pageNativeByteProofDigest,
      code,
    ),
    pageSemanticDigest: exactDigest(
      raw.pageSemanticDigest,
      code,
    ),
    pageExpiresAtMs: safeInteger(
      raw.pageExpiresAtMs,
      code,
      1,
    ),
    scannedCount: safeInteger(raw.scannedCount, code),
    referenceCount: safeInteger(
      raw.referenceCount,
      code,
    ),
    referencesSettled: safeInteger(
      raw.referencesSettled,
      code,
    ),
    referencesStable: safeInteger(
      raw.referencesStable,
      code,
    ),
    referencesConflict: safeInteger(
      raw.referencesConflict,
      code,
    ),
    referencesUnresolved: safeInteger(
      raw.referencesUnresolved,
      code,
    ),
    settledReadsCompleted: safeInteger(
      raw.settledReadsCompleted,
      code,
    ),
    indexDigest: exactDigest(raw.indexDigest, code),
    outcomeDigest: exactDigest(raw.outcomeDigest, code),
    createdAtMs: safeInteger(raw.createdAtMs, code),
    updatedAtMs: safeInteger(raw.updatedAtMs, code),
    expiresAtMs: safeInteger(raw.expiresAtMs, code, 1),
    revision: safeInteger(raw.revision, code),
  };
  if (
    page.pageNumber > MAX_PAGES
    || page.scannedCount > SOURCE_RECALL_PAGE_SIZE
    || page.referenceCount > page.scannedCount
    || page.referencesSettled > page.referenceCount
    || page.referencesStable
      + page.referencesConflict
      + page.referencesUnresolved
      !== page.referencesSettled
    || page.settledReadsCompleted
      > page.referencesSettled * 2
    || page.createdAtMs > page.updatedAtMs
    || page.updatedAtMs >= page.expiresAtMs
    || page.expiresAtMs > page.pageExpiresAtMs
  ) {
    fail(code);
  }
  const entries = denseArraySnapshot(raw.entries, code).map(
    (entry) => canonicalEntry(entry, code),
  );
  if (entries.length !== page.referenceCount) fail(code);
  const ids = new Set();
  const workKeys = new Set();
  for (const entry of entries) {
    if (
      ids.has(entry.referenceIdDigest)
      || workKeys.has(entry.workKeyDigest)
    ) {
      fail(code);
    }
    ids.add(entry.referenceIdDigest);
    workKeys.add(entry.workKeyDigest);
  }
  const settled = entries.filter(
    (entry) => entry.outcome !== null,
  );
  let unsettledSeen = false;
  const terminalOrderInvalid = entries.some((entry) => {
    if (entry.outcome === null) {
      unsettledSeen = true;
      return false;
    }
    return unsettledSeen;
  });
  if (
    settled.length !== page.referencesSettled
    || settled.filter(
      (entry) => entry.outcome === "stable",
    ).length !== page.referencesStable
    || settled.filter(
      (entry) => entry.outcome === "conflict",
    ).length !== page.referencesConflict
    || settled.filter(
      (entry) => entry.outcome === "unresolved",
    ).length !== page.referencesUnresolved
    || settled.reduce(
      (sum, entry) => sum + entry.readsCompleted,
      0,
    ) !== page.settledReadsCompleted
    || terminalOrderInvalid
    || semanticDigest(
      "phase4-recall-point-observation-manifest-page-index-v1",
      entries.map(indexEntry),
    ) !== page.indexDigest
    || semanticDigest(
      "phase4-recall-point-observation-manifest-page-outcomes-v1",
      entries.map(outcomeEntry),
    ) !== page.outcomeDigest
  ) {
    fail(code);
  }
  page.entries = entries;
  return deepFreeze(page);
}

function runWork(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_WORK_INVALID";
  const raw = exactRecord(value, RUN_WORK_KEYS, code);
  if (!Object.isFrozen(value)) fail(code);
  return deepFreeze({
    manifestKeyDigest: exactDigest(
      raw.manifestKeyDigest,
      code,
    ),
  });
}

function pointWork(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_POINT_WORK_INVALID";
  const raw = exactRecord(value, POINT_WORK_KEYS, code);
  if (!Object.isFrozen(value)) fail(code);
  return deepFreeze({
    workKeyDigest: exactDigest(raw.workKeyDigest, code),
  });
}

function persistenceSnapshot(result, code) {
  const raw = exactRecord(
    result,
    ["expiresAtMs", "raw", "redisNowMs", "status"],
    code,
  );
  if (
    ![
      "conflict",
      "created",
      "existing",
      "expired",
      "stored",
    ].includes(raw.status)
    || !(
      raw.raw === null
      || typeof raw.raw === "string"
    )
    || !(
      raw.expiresAtMs === -2
      || Number.isSafeInteger(raw.expiresAtMs)
    )
  ) {
    fail(code);
  }
  safeInteger(raw.redisNowMs, code);
  return raw;
}

function readResult(result, code) {
  const raw = exactRecord(
    result,
    ["expiresAtMs", "raw", "redisNowMs"],
    code,
  );
  if (
    !(
      raw.raw === null
      || typeof raw.raw === "string"
    )
    || !(
      raw.expiresAtMs === -2
      || Number.isSafeInteger(raw.expiresAtMs)
    )
  ) {
    fail(code);
  }
  safeInteger(raw.redisNowMs, code);
  return raw;
}

function timeResult(result) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PERSISTENCE_RESULT_INVALID";
  const raw = exactRecord(result, ["redisNowMs"], code);
  return safeInteger(raw.redisNowMs, code);
}

function parseRun(raw, redisNowMs, expiresAtMs) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PERSISTENCE_RESULT_INVALID";
  if (
    typeof raw !== "string"
    || raw.length === 0
    || Buffer.byteLength(raw, "utf8") > MAX_RAW_BYTES
  ) {
    fail(code);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(code);
  }
  const record = validateRun(parsed);
  if (
    canonicalJson(record) !== raw
    || redisNowMs < record.updatedAtMs
    || expiresAtMs !== record.expiresAtMs
    || redisNowMs >= expiresAtMs
  ) {
    fail(code);
  }
  return deepFreeze({
    raw,
    rawSha1: rawSha1(raw),
    record,
    redisNowMs,
  });
}

function parsePage(raw, redisNowMs, expiresAtMs) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PERSISTENCE_RESULT_INVALID";
  if (
    typeof raw !== "string"
    || raw.length === 0
    || Buffer.byteLength(raw, "utf8") > MAX_RAW_BYTES
  ) {
    fail(code);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(code);
  }
  const record = validatePage(parsed);
  if (
    canonicalJson(record) !== raw
    || redisNowMs < record.updatedAtMs
    || expiresAtMs !== record.expiresAtMs
    || redisNowMs >= expiresAtMs
  ) {
    fail(code);
  }
  return deepFreeze({
    raw,
    rawSha1: rawSha1(raw),
    record,
    redisNowMs,
  });
}

function aggregateFor(run) {
  return deepFreeze({
    status: run.status,
    pageCount: run.pageCount,
    pagesIndexed: run.pagesIndexed,
    referenceCount: run.referenceCount,
    referencesIndexed: run.referencesIndexed,
    referencesSettled: run.referencesSettled,
    referencesStable: run.referencesStable,
    referencesConflict: run.referencesConflict,
    referencesUnresolved: run.referencesUnresolved,
    settledReadsCompleted: run.settledReadsCompleted,
    inProgress: run.activeClaim !== null,
    referenceManifestCoverageComplete:
      run.referenceManifestCoverageComplete,
    operational: false,
    globalReferenceSetCoverageAvailable:
      run.globalReferenceSetCoverageAvailable,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
  });
}

function initialRun(head, createdAtMs) {
  return validateRun({
    version:
      SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RECORD_VERSION,
    policyVersion:
      SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_STORE_VERSION,
    kind: "recall_point_observation_manifest_dark",
    source: SOURCE,
    status: "indexing_pages",
    manifestKeyDigest: head.manifestKeyDigest,
    workKeyDigest: head.workKeyDigest,
    runNonceDigest: head.runNonceDigest,
    decisionBoundaryAtMs: head.decisionBoundaryAtMs,
    contractPinsDigest: head.contractPinsDigest,
    recallReferenceHeadEpochDigest:
      head.recallReferenceHeadEpochDigest,
    recallReferenceHeadRevisionDigest:
      head.recallReferenceHeadRevisionDigest,
    recallReferenceHeadRecordDigest:
      head.recallReferenceHeadRecordDigest,
    referenceManifestDigest:
      head.referenceManifestDigest,
    stablePassSemanticDigest:
      head.stablePassSemanticDigest,
    headPageSetDigest: head.headPageSetDigest,
    pageCount: head.pageCount,
    scannedCount: head.scannedCount,
    referenceCount: head.referenceCount,
    pageManifests: head.pageManifests,
    pagesIndexed: 0,
    referencesIndexed: 0,
    referencesSettled: 0,
    referencesStable: 0,
    referencesConflict: 0,
    referencesUnresolved: 0,
    settledReadsCompleted: 0,
    nextPageNumber: 1,
    nextObservationPageNumber: null,
    nextObservationOrdinal: null,
    indexedManifestDigest: null,
    completeProofDigest: null,
    activeClaim: null,
    createdAtMs,
    updatedAtMs: createdAtMs,
    expiresAtMs: head.expiresAtMs,
    revision: 0,
    referenceManifestCoverageComplete: false,
    operational: false,
    globalReferenceSetCoverageAvailable: false,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
  });
}

function pageKey(manifestKeyDigest, pageNumber) {
  return `${PAGE_PREFIX}${manifestKeyDigest}:${pageNumber}`;
}

function runKey(manifestKeyDigest) {
  return `${RUN_PREFIX}${manifestKeyDigest}`;
}

function manifestEntryResult(value, run, claim, code) {
  const raw = exactRecord(
    value,
    MANIFEST_ENTRY_RESULT_KEYS,
    code,
  );
  if (!Object.isFrozen(value) || !Object.isFrozen(raw.entries)) {
    fail(code);
  }
  const entries = denseArraySnapshot(raw.entries, code).map(
    (entry) => {
      const selected = exactRecord(
        entry,
        MANIFEST_ENTRY_KEYS,
        code,
      );
      if (!Object.isFrozen(entry)) fail(code);
      return deepFreeze({
        referenceDigest: exactDigest(
          selected.referenceDigest,
          code,
        ),
        referenceIdDigest: exactDigest(
          selected.referenceIdDigest,
          code,
        ),
        workItemDigest: exactDigest(
          selected.workItemDigest,
          code,
        ),
        workKeyDigest: exactDigest(
          selected.workKeyDigest,
          code,
        ),
      });
    },
  );
  const expected = run.pageManifests[claim.pageNumber - 1];
  if (
    raw.pageNumber !== claim.pageNumber
    || raw.pageNumber !== expected.pageNumber
    || raw.runNonceDigest !== run.runNonceDigest
    || raw.decisionBoundaryAtMs !== run.decisionBoundaryAtMs
    || raw.contractPinsDigest !== run.contractPinsDigest
    || raw.recallReferenceHeadEpochDigest
      !== run.recallReferenceHeadEpochDigest
    || raw.recallReferenceHeadRevisionDigest
      !== run.recallReferenceHeadRevisionDigest
    || raw.recallReferenceHeadRecordDigest
      !== run.recallReferenceHeadRecordDigest
    || raw.pageKeyDigest !== expected.pageKeyDigest
      && Object.prototype.hasOwnProperty.call(
        expected,
        "pageKeyDigest",
      )
    || raw.pageRecordDigest !== expected.pageRecordDigest
    || raw.pageNativeByteProofDigest
      !== expected.pageNativeByteProofDigest
    || raw.pageSemanticDigest !== expected.pageSemanticDigest
    || raw.pageExpiresAtMs !== expected.pageExpiresAtMs
    || raw.scannedCount !== expected.scannedCount
    || raw.referenceCount !== expected.referenceCount
    || entries.length !== expected.referenceCount
    || safeInteger(raw.verifiedAtMs, code)
      < claim.issuedAtMs
  ) {
    fail(code);
  }
  exactDigest(raw.pageKeyDigest, code);
  const ids = new Set();
  const workKeys = new Set();
  for (const entry of entries) {
    if (
      ids.has(entry.referenceIdDigest)
      || workKeys.has(entry.workKeyDigest)
    ) {
      fail(code);
    }
    ids.add(entry.referenceIdDigest);
    workKeys.add(entry.workKeyDigest);
  }
  return deepFreeze({
    entries,
    pageExpiresAtMs: raw.pageExpiresAtMs,
    pageKeyDigest: raw.pageKeyDigest,
    pageNativeByteProofDigest:
      raw.pageNativeByteProofDigest,
    pageNumber: raw.pageNumber,
    pageRecordDigest: raw.pageRecordDigest,
    pageSemanticDigest: raw.pageSemanticDigest,
    referenceCount: raw.referenceCount,
    scannedCount: raw.scannedCount,
  });
}

function initialPage(run, selected, nowMs) {
  const entries = selected.entries.map((entry) => ({
    ...entry,
    outcome: null,
    readsCompleted: 0,
    resolutionDigest: null,
  }));
  return validatePage({
    version:
      SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PAGE_VERSION,
    policyVersion:
      SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_STORE_VERSION,
    kind: "recall_point_observation_manifest_page_dark",
    source: SOURCE,
    manifestKeyDigest: run.manifestKeyDigest,
    recallReferenceHeadEpochDigest:
      run.recallReferenceHeadEpochDigest,
    recallReferenceHeadRevisionDigest:
      run.recallReferenceHeadRevisionDigest,
    recallReferenceHeadRecordDigest:
      run.recallReferenceHeadRecordDigest,
    pageNumber: selected.pageNumber,
    pageKeyDigest: selected.pageKeyDigest,
    pageRecordDigest: selected.pageRecordDigest,
    pageNativeByteProofDigest:
      selected.pageNativeByteProofDigest,
    pageSemanticDigest: selected.pageSemanticDigest,
    pageExpiresAtMs: selected.pageExpiresAtMs,
    scannedCount: selected.scannedCount,
    referenceCount: selected.referenceCount,
    entries,
    referencesSettled: 0,
    referencesStable: 0,
    referencesConflict: 0,
    referencesUnresolved: 0,
    settledReadsCompleted: 0,
    indexDigest: semanticDigest(
      "phase4-recall-point-observation-manifest-page-index-v1",
      entries.map(indexEntry),
    ),
    outcomeDigest: semanticDigest(
      "phase4-recall-point-observation-manifest-page-outcomes-v1",
      entries.map(outcomeEntry),
    ),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    expiresAtMs: run.expiresAtMs,
    revision: 0,
  });
}

function pageBoundToRun(page, run, pageNumber) {
  const expected = run.pageManifests[pageNumber - 1];
  if (
    page.manifestKeyDigest !== run.manifestKeyDigest
    || page.pageNumber !== pageNumber
    || page.recallReferenceHeadEpochDigest
      !== run.recallReferenceHeadEpochDigest
    || page.recallReferenceHeadRevisionDigest
      !== run.recallReferenceHeadRevisionDigest
    || page.recallReferenceHeadRecordDigest
      !== run.recallReferenceHeadRecordDigest
    || page.pageRecordDigest !== expected.pageRecordDigest
    || page.pageNativeByteProofDigest
      !== expected.pageNativeByteProofDigest
    || page.pageSemanticDigest !== expected.pageSemanticDigest
    || page.pageExpiresAtMs !== expected.pageExpiresAtMs
    || page.scannedCount !== expected.scannedCount
    || page.referenceCount !== expected.referenceCount
    || page.expiresAtMs !== run.expiresAtMs
  ) {
    fail(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PAGE_BINDING_MISMATCH",
    );
  }
}

function pointSnapshot(value, claim) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_POINT_SNAPSHOT_INVALID";
  const raw = exactRecord(value, POINT_SNAPSHOT_KEYS, code);
  const record = plainRecordSnapshot(raw.record, code);
  if (
    typeof raw.raw !== "string"
    || raw.raw.length === 0
    || Buffer.byteLength(raw.raw, "utf8") > MAX_RAW_BYTES
    || canonicalJson(record) !== raw.raw
    || rawSha1(raw.raw) !== raw.rawSha1
    || safeInteger(raw.redisNowMs, code)
      < safeInteger(record.updatedAtMs, code)
    || !POINT_TERMINAL_STATUSES.has(record.status)
    || record.workKeyDigest !== claim.workKeyDigest
    || record.referencePageNumber !== claim.pageNumber
    || record.referenceOrdinal !== claim.referenceOrdinal
    || record.referenceHeadEpochDigest
      !== claim.run.recallReferenceHeadEpochDigest
    || record.referenceHeadRevisionDigest
      !== claim.run.recallReferenceHeadRevisionDigest
    || record.referenceHeadRecordDigest
      !== claim.run.recallReferenceHeadRecordDigest
    || record.operational !== false
    || record.globalReferenceSetCoverageAvailable !== false
    || record.sourceFactsAvailable !== false
    || record.successClassificationAvailable !== false
    || record.candidateIdentityResolutionAvailable !== false
    || record.pinnable !== false
    || record.authorityAvailable !== false
    || typeof record.resolutionDigest !== "string"
    || !DIGEST.test(record.resolutionDigest)
  ) {
    fail(code);
  }
  const readsCompleted =
    (record.readOne === null ? 0 : 1)
    + (record.readTwo === null ? 0 : 1);
  if (
    (
      ["stable", "conflict"].includes(record.status)
      && readsCompleted !== 2
    )
    || (
      record.status === "unresolved"
      && readsCompleted > 1
    )
  ) {
    fail(code);
  }
  return deepFreeze({
    outcome: record.status,
    redisNowMs: raw.redisNowMs,
    readsCompleted,
    resolutionDigest: record.resolutionDigest,
    workItemDigest: exactDigest(
      record.workItemDigest,
      code,
    ),
    workKeyDigest: record.workKeyDigest,
  });
}

function preparedPointSnapshot(value, claim) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_POINT_PREPARE_INVALID";
  const raw = exactRecord(value, POINT_SNAPSHOT_KEYS, code);
  const record = plainRecordSnapshot(raw.record, code);
  if (
    typeof raw.raw !== "string"
    || raw.raw.length === 0
    || Buffer.byteLength(raw.raw, "utf8") > MAX_RAW_BYTES
    || canonicalJson(record) !== raw.raw
    || rawSha1(raw.raw) !== raw.rawSha1
    || safeInteger(raw.redisNowMs, code)
      < safeInteger(record.updatedAtMs, code)
    || record.workKeyDigest !== claim.workKeyDigest
    || record.referencePageNumber !== claim.pageNumber
    || record.referenceOrdinal !== claim.referenceOrdinal
    || record.referenceHeadEpochDigest
      !== claim.run.recallReferenceHeadEpochDigest
    || record.referenceHeadRevisionDigest
      !== claim.run.recallReferenceHeadRevisionDigest
    || record.referenceHeadRecordDigest
      !== claim.run.recallReferenceHeadRecordDigest
    || record.operational !== false
    || record.globalReferenceSetCoverageAvailable !== false
    || record.sourceFactsAvailable !== false
    || record.successClassificationAvailable !== false
    || record.candidateIdentityResolutionAvailable !== false
    || record.pinnable !== false
    || record.authorityAvailable !== false
  ) {
    fail(code);
  }
  return pointWork(deepFreeze({
    workKeyDigest: record.workKeyDigest,
  }));
}

export function createSourceRecallPointObservationManifestStore(
  options,
) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_STORE_OPTIONS_INVALID";
  const selected = exactRecord(options, FACTORY_KEYS, code);
  const persistence = persistenceInterface(
    selected.persistence,
  );
  const pointObservation = pointObservationInterface(
    selected.pointObservation,
  );
  const issuedClaims = new WeakMap();

  async function readRun(work) {
    const selectedWork = runWork(work);
    const result = readResult(
      await persistence.read({
        key: runKey(selectedWork.manifestKeyDigest),
      }),
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PERSISTENCE_RESULT_INVALID",
    );
    if (result.raw === null) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_NOT_FOUND",
      );
    }
    const snapshot = parseRun(
      result.raw,
      result.redisNowMs,
      result.expiresAtMs,
    );
    if (
      snapshot.record.manifestKeyDigest
        !== selectedWork.manifestKeyDigest
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_BINDING_MISMATCH",
      );
    }
    return snapshot;
  }

  async function readPage(run, pageNumber) {
    const result = readResult(
      await persistence.read({
        key: pageKey(run.manifestKeyDigest, pageNumber),
      }),
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PERSISTENCE_RESULT_INVALID",
    );
    if (result.raw === null) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PAGE_NOT_FOUND",
      );
    }
    const snapshot = parsePage(
      result.raw,
      result.redisNowMs,
      result.expiresAtMs,
    );
    pageBoundToRun(snapshot.record, run, pageNumber);
    return snapshot;
  }

  async function casRun(snapshot, next, notAfterMs) {
    const nextRaw = canonicalJson(next);
    const result = persistenceSnapshot(
      await persistence.compareAndSet({
        key: runKey(snapshot.record.manifestKeyDigest),
        expectedRaw: snapshot.raw,
        nextRaw,
        expiresAtMs: snapshot.record.expiresAtMs,
        notAfterMs,
      }),
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PERSISTENCE_RESULT_INVALID",
    );
    if (result.status === "conflict") {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CAS_CONFLICT",
      );
    }
    if (result.status === "expired") {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_EXPIRED",
      );
    }
    if (result.status !== "stored" || result.raw !== nextRaw) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PERSISTENCE_RESULT_INVALID",
      );
    }
    return parseRun(
      result.raw,
      result.redisNowMs,
      result.expiresAtMs,
    );
  }

  async function casPage(snapshot, next, notAfterMs) {
    const nextRaw = canonicalJson(next);
    const result = persistenceSnapshot(
      await persistence.compareAndSet({
        key: pageKey(
          snapshot.record.manifestKeyDigest,
          snapshot.record.pageNumber,
        ),
        expectedRaw: snapshot.raw,
        nextRaw,
        expiresAtMs: snapshot.record.expiresAtMs,
        notAfterMs,
      }),
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PERSISTENCE_RESULT_INVALID",
    );
    if (result.status === "conflict") {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PAGE_CAS_CONFLICT",
      );
    }
    if (result.status === "expired") {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_EXPIRED",
      );
    }
    if (result.status !== "stored" || result.raw !== nextRaw) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PERSISTENCE_RESULT_INVALID",
      );
    }
    return parsePage(
      result.raw,
      result.redisNowMs,
      result.expiresAtMs,
    );
  }

  async function ensureRecallPointObservationManifest(
    verifiedHeadValue,
  ) {
    const head = verifiedHead(verifiedHeadValue);
    const createdAtMs = timeResult(await persistence.time());
    if (
      createdAtMs < head.redisNowMs
      || createdAtMs >= head.expiresAtMs
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_REFERENCE_EXPIRED",
      );
    }
    const proposed = initialRun(head, createdAtMs);
    const proposedRaw = canonicalJson(proposed);
    const result = persistenceSnapshot(
      await persistence.ensure({
        key: runKey(proposed.manifestKeyDigest),
        proposedRaw,
        expiresAtMs: proposed.expiresAtMs,
      }),
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PERSISTENCE_RESULT_INVALID",
    );
    if (
      result.status === "expired"
      || result.raw === null
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_REFERENCE_EXPIRED",
      );
    }
    if (!["created", "existing"].includes(result.status)) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PERSISTENCE_RESULT_INVALID",
      );
    }
    const snapshot = parseRun(
      result.raw,
      result.redisNowMs,
      result.expiresAtMs,
    );
    for (const key of [
      "contractPinsDigest",
      "decisionBoundaryAtMs",
      "expiresAtMs",
      "headPageSetDigest",
      "manifestKeyDigest",
      "pageCount",
      "recallReferenceHeadEpochDigest",
      "recallReferenceHeadRecordDigest",
      "recallReferenceHeadRevisionDigest",
      "referenceCount",
      "referenceManifestDigest",
      "runNonceDigest",
      "scannedCount",
      "stablePassSemanticDigest",
      "workKeyDigest",
    ]) {
      if (snapshot.record[key] !== proposed[key]) {
        fail(
          "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_BINDING_MISMATCH",
        );
      }
    }
    if (
      canonicalJson(snapshot.record.pageManifests)
        !== canonicalJson(proposed.pageManifests)
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_BINDING_MISMATCH",
      );
    }
    if (
      snapshot.record.status === "observed_complete_dark"
    ) {
      await verifyCompleteManifest(snapshot.record);
    }
    return snapshot;
  }

  async function clearExpiredClaim(snapshot) {
    const nextValue = clone(snapshot.record);
    nextValue.activeClaim = null;
    nextValue.updatedAtMs = snapshot.redisNowMs;
    nextValue.revision += 1;
    return casRun(
      snapshot,
      validateRun(nextValue),
      snapshot.record.expiresAtMs,
    );
  }

  function durableRunAdvancedFrom(current, previous) {
    for (const key of [
      "contractPinsDigest",
      "createdAtMs",
      "decisionBoundaryAtMs",
      "expiresAtMs",
      "headPageSetDigest",
      "manifestKeyDigest",
      "pageCount",
      "recallReferenceHeadEpochDigest",
      "recallReferenceHeadRecordDigest",
      "recallReferenceHeadRevisionDigest",
      "referenceCount",
      "referenceManifestDigest",
      "runNonceDigest",
      "scannedCount",
      "stablePassSemanticDigest",
      "workKeyDigest",
    ]) {
      if (current[key] !== previous[key]) return false;
    }
    if (
      canonicalJson(current.pageManifests)
        !== canonicalJson(previous.pageManifests)
      || current.revision <= previous.revision
      || current.updatedAtMs < previous.updatedAtMs
      || RUN_STATUS_ORDER.get(current.status)
        < RUN_STATUS_ORDER.get(previous.status)
    ) {
      return false;
    }
    for (const key of [
      "pagesIndexed",
      "referencesConflict",
      "referencesIndexed",
      "referencesSettled",
      "referencesStable",
      "referencesUnresolved",
      "settledReadsCompleted",
    ]) {
      if (current[key] < previous[key]) return false;
    }
    if (
      (
        previous.indexedManifestDigest !== null
        && current.indexedManifestDigest
          !== previous.indexedManifestDigest
      )
      || (
        previous.completeProofDigest !== null
        && current.completeProofDigest
          !== previous.completeProofDigest
      )
    ) {
      return false;
    }
    return true;
  }

  async function recoverClaimLoopRunTransition(
    work,
    previous,
    error,
  ) {
    let current;
    try {
      current = await readRun(work);
    } catch {
      throw error;
    }
    if (
      current.raw !== previous.raw
      && durableRunAdvancedFrom(
        current.record,
        previous.record,
      )
    ) {
      return current;
    }
    if (
      current.raw === previous.raw
      && error
        instanceof SourceRecallPointObservationManifestStoreError
      && error.code
        === "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CAS_CONFLICT"
    ) {
      return current;
    }
    throw error;
  }

  async function allPages(run) {
    const pages = [];
    for (
      let pageNumber = 1;
      pageNumber <= run.pageCount;
      pageNumber += 1
    ) {
      pages.push(await readPage(run, pageNumber));
    }
    return pages;
  }

  function firstObservationCoordinate(pages, startPage = 1) {
    for (
      let pageNumber = startPage;
      pageNumber <= pages.length;
      pageNumber += 1
    ) {
      const page = pages[pageNumber - 1].record;
      const ordinal = page.entries.findIndex(
        (entry) => entry.outcome === null,
      );
      if (ordinal !== -1) {
        return { pageNumber, referenceOrdinal: ordinal };
      }
    }
    return null;
  }

  async function nextObservationCoordinate(
    run,
    currentPageSnapshot,
    currentOrdinal,
  ) {
    const currentPage = currentPageSnapshot.record;
    const nextOrdinal = currentOrdinal + 1;
    if (nextOrdinal < currentPage.entries.length) {
      if (
        currentPage.entries[nextOrdinal].outcome !== null
      ) {
        fail(
          "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_DURABLE_STATE_INVALID",
        );
      }
      return {
        pageNumber: currentPage.pageNumber,
        referenceOrdinal: nextOrdinal,
      };
    }
    for (
      let pageNumber = currentPage.pageNumber + 1;
      pageNumber <= run.pageCount;
      pageNumber += 1
    ) {
      const page = await readPage(run, pageNumber);
      const referenceOrdinal = page.record.entries.findIndex(
        (entry) => entry.outcome === null,
      );
      if (referenceOrdinal !== -1) {
        return { pageNumber, referenceOrdinal };
      }
    }
    return null;
  }

  async function sealIndex(snapshot) {
    const run = snapshot.record;
    if (
      run.status !== "indexing_pages"
      || run.pagesIndexed !== run.pageCount
      || run.referencesIndexed !== run.referenceCount
      || run.activeClaim !== null
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_DURABLE_STATE_INVALID",
      );
    }
    const pages = await allPages(run);
    const commitments = pages
      .flatMap((page) => page.record.entries)
      .map((entry) => ({
        referenceDigest: entry.referenceDigest,
        referenceIdDigest: entry.referenceIdDigest,
      }));
    const ids = new Set();
    const workKeys = new Set();
    for (const page of pages) {
      for (const entry of page.record.entries) {
        if (
          ids.has(entry.referenceIdDigest)
          || workKeys.has(entry.workKeyDigest)
        ) {
          fail(
            "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_INDEX_INVALID",
          );
        }
        ids.add(entry.referenceIdDigest);
        workKeys.add(entry.workKeyDigest);
      }
    }
    const sortedCommitments = [...commitments].sort(
      (left, right) => (
        left.referenceIdDigest.localeCompare(
          right.referenceIdDigest,
        )
        || left.referenceDigest.localeCompare(
          right.referenceDigest,
        )
      ),
    );
    if (
      commitments.length !== run.referenceCount
      || semanticDigest(
        "phase4-recall-reference-manifest-v1",
        sortedCommitments,
      ) !== run.referenceManifestDigest
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_INDEX_INVALID",
      );
    }
    const coordinate = firstObservationCoordinate(pages);
    const nextValue = clone(run);
    nextValue.status = coordinate === null
      ? "verifying_complete"
      : "observing";
    nextValue.nextPageNumber = null;
    nextValue.nextObservationPageNumber =
      coordinate?.pageNumber ?? null;
    nextValue.nextObservationOrdinal =
      coordinate?.referenceOrdinal ?? null;
    nextValue.indexedManifestDigest = semanticDigest(
      "phase4-recall-point-observation-manifest-index-v1",
      pages.map((page) => ({
        indexDigest: page.record.indexDigest,
        pageNumber: page.record.pageNumber,
        referenceCount: page.record.referenceCount,
      })),
    );
    nextValue.referenceManifestCoverageComplete = false;
    nextValue.globalReferenceSetCoverageAvailable = false;
    nextValue.completeProofDigest = null;
    nextValue.updatedAtMs = snapshot.redisNowMs;
    nextValue.revision += 1;
    return casRun(
      snapshot,
      validateRun(nextValue),
      run.expiresAtMs,
    );
  }

  async function verifyCompleteManifest(run) {
    if (
      ![
        "verifying_complete",
        "observed_complete_dark",
      ].includes(run.status)
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_DURABLE_STATE_INVALID",
      );
    }
    const pages = await allPages(run);
    const entries = pages.flatMap(
      (page) => page.record.entries,
    );
    const commitments = entries.map((entry) => ({
      referenceDigest: entry.referenceDigest,
      referenceIdDigest: entry.referenceIdDigest,
    }));
    const sortedCommitments = [...commitments].sort(
      (left, right) => (
        left.referenceIdDigest.localeCompare(
          right.referenceIdDigest,
        )
        || left.referenceDigest.localeCompare(
          right.referenceDigest,
        )
      ),
    );
    const referencesStable = entries.filter(
      (entry) => entry.outcome === "stable",
    ).length;
    const referencesConflict = entries.filter(
      (entry) => entry.outcome === "conflict",
    ).length;
    const referencesUnresolved = entries.filter(
      (entry) => entry.outcome === "unresolved",
    ).length;
    const settledReadsCompleted = entries.reduce(
      (sum, entry) => sum + entry.readsCompleted,
      0,
    );
    const ids = new Set();
    const workKeys = new Set();
    for (const entry of entries) {
      if (
        ids.has(entry.referenceIdDigest)
        || workKeys.has(entry.workKeyDigest)
      ) {
        fail(
          "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_COMPLETE_PROOF_INVALID",
        );
      }
      ids.add(entry.referenceIdDigest);
      workKeys.add(entry.workKeyDigest);
    }
    if (
      entries.length !== run.referenceCount
      || entries.some((entry) => entry.outcome === null)
      || referencesStable !== run.referencesStable
      || referencesConflict !== run.referencesConflict
      || referencesUnresolved !== run.referencesUnresolved
      || settledReadsCompleted
        !== run.settledReadsCompleted
      || semanticDigest(
        "phase4-recall-reference-manifest-v1",
        sortedCommitments,
      ) !== run.referenceManifestDigest
      || semanticDigest(
        "phase4-recall-point-observation-manifest-index-v1",
        pages.map((page) => ({
          indexDigest: page.record.indexDigest,
          pageNumber: page.record.pageNumber,
          referenceCount: page.record.referenceCount,
        })),
      ) !== run.indexedManifestDigest
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_COMPLETE_PROOF_INVALID",
      );
    }
    const completeProofDigest = semanticDigest(
      "phase4-recall-point-observation-manifest-complete-proof-v1",
      pages.map((page) => ({
        indexDigest: page.record.indexDigest,
        outcomeDigest: page.record.outcomeDigest,
        pageNumber: page.record.pageNumber,
        referenceCount: page.record.referenceCount,
        referencesConflict:
          page.record.referencesConflict,
        referencesStable: page.record.referencesStable,
        referencesUnresolved:
          page.record.referencesUnresolved,
        settledReadsCompleted:
          page.record.settledReadsCompleted,
      })),
    );
    if (
      run.status === "observed_complete_dark"
      && run.completeProofDigest !== completeProofDigest
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_COMPLETE_PROOF_INVALID",
      );
    }
    return completeProofDigest;
  }

  async function sealCompleteProof(snapshot) {
    const run = snapshot.record;
    if (
      run.status !== "verifying_complete"
      || run.activeClaim !== null
      || run.referencesSettled !== run.referenceCount
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_DURABLE_STATE_INVALID",
      );
    }
    const completeProofDigest =
      await verifyCompleteManifest(run);
    const nextValue = clone(run);
    nextValue.status = "observed_complete_dark";
    nextValue.completeProofDigest = completeProofDigest;
    nextValue.referenceManifestCoverageComplete = true;
    nextValue.globalReferenceSetCoverageAvailable =
      nextValue.referencesStable === run.referenceCount
      && nextValue.referencesConflict === 0
      && nextValue.referencesUnresolved === 0;
    nextValue.updatedAtMs = snapshot.redisNowMs;
    nextValue.revision += 1;
    return casRun(
      snapshot,
      validateRun(nextValue),
      run.expiresAtMs,
    );
  }

  async function aggregateFromDurableRun(run) {
    if (run.status === "observed_complete_dark") {
      await verifyCompleteManifest(run);
    }
    return aggregateFor(run);
  }

  function terminalClaim(run) {
    return deepFreeze({
      aggregate: aggregateFor(run),
      status: "complete",
    });
  }

  function inProgressClaim(run) {
    return deepFreeze({
      aggregate: aggregateFor(run),
      status: "in_progress",
    });
  }

  async function reconcileSettledEntry(snapshot, pageSnapshot) {
    const run = snapshot.record;
    const page = pageSnapshot.record;
    const ordinal = run.nextObservationOrdinal;
    const entry = page.entries[ordinal];
    if (
      run.status !== "observing"
      || run.activeClaim !== null
      || page.pageNumber !== run.nextObservationPageNumber
      || !entry
      || entry.outcome === null
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_DURABLE_STATE_INVALID",
      );
    }
    const coordinate = await nextObservationCoordinate(
      run,
      pageSnapshot,
      ordinal,
    );
    const nextValue = clone(run);
    nextValue.referencesSettled += 1;
    nextValue.settledReadsCompleted += entry.readsCompleted;
    if (entry.outcome === "stable") {
      nextValue.referencesStable += 1;
    } else if (entry.outcome === "conflict") {
      nextValue.referencesConflict += 1;
    } else {
      nextValue.referencesUnresolved += 1;
    }
    if (coordinate === null) {
      nextValue.status = "verifying_complete";
      nextValue.nextObservationPageNumber = null;
      nextValue.nextObservationOrdinal = null;
      nextValue.referenceManifestCoverageComplete = false;
      nextValue.globalReferenceSetCoverageAvailable = false;
      nextValue.completeProofDigest = null;
    } else {
      nextValue.nextObservationPageNumber =
        coordinate.pageNumber;
      nextValue.nextObservationOrdinal =
        coordinate.referenceOrdinal;
    }
    nextValue.updatedAtMs = snapshot.redisNowMs;
    nextValue.revision += 1;
    return casRun(
      snapshot,
      validateRun(nextValue),
      run.expiresAtMs,
    );
  }

  async function issueClaim(snapshot, {
    pageNumber,
    referenceOrdinal,
    type,
    workKeyDigest,
  }) {
    const nonce = randomBytes(32).toString("hex");
    const nextValue = clone(snapshot.record);
    nextValue.activeClaim = {
      claimNonceDigest: nonce,
      expiresAtMs: Math.min(
        snapshot.redisNowMs
          + SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CLAIM_LEASE_MS,
        snapshot.record.expiresAtMs,
      ),
      issuedAtMs: snapshot.redisNowMs,
      pageNumber,
      referenceOrdinal,
      type,
      workKeyDigest,
    };
    nextValue.updatedAtMs = snapshot.redisNowMs;
    nextValue.revision += 1;
    const stored = await casRun(
      snapshot,
      validateRun(nextValue),
      snapshot.record.expiresAtMs,
    );
    const claim = deepFreeze({
      pageNumber,
      referenceOrdinal,
      status: type === "index_page"
        ? "page_required"
        : "observation_required",
      workKeyDigest,
    });
    issuedClaims.set(claim, deepFreeze({
      claimNonceDigest: nonce,
      run: stored.record,
      runRaw: stored.raw,
      runRedisNowMs: stored.redisNowMs,
    }));
    return claim;
  }

  async function claimRecallPointObservationManifestStep(
    work,
  ) {
    let snapshot = await readRun(work);
    for (
      let attempt = 0;
      attempt <= snapshot.record.pageCount + 8;
      attempt += 1
    ) {
      const run = snapshot.record;
      if (run.status === "observed_complete_dark") {
        await verifyCompleteManifest(run);
        return terminalClaim(run);
      }
      if (run.status === "verifying_complete") {
        try {
          snapshot = await sealCompleteProof(snapshot);
          return terminalClaim(snapshot.record);
        } catch (error) {
          const current =
            await recoverClaimLoopRunTransition(
              work,
              snapshot,
              error,
            );
          if (
            current.record.status
              === "observed_complete_dark"
          ) {
            await verifyCompleteManifest(current.record);
            return terminalClaim(current.record);
          }
          snapshot = current;
          continue;
        }
      }
      if (run.activeClaim !== null) {
        if (run.activeClaim.expiresAtMs > snapshot.redisNowMs) {
          return inProgressClaim(run);
        }
        try {
          snapshot = await clearExpiredClaim(snapshot);
        } catch (error) {
          snapshot =
            await recoverClaimLoopRunTransition(
              work,
              snapshot,
              error,
            );
        }
        continue;
      }
      if (
        run.status === "indexing_pages"
        && run.pagesIndexed === run.pageCount
      ) {
        try {
          snapshot = await sealIndex(snapshot);
          continue;
        } catch (error) {
          snapshot =
            await recoverClaimLoopRunTransition(
              work,
              snapshot,
              error,
            );
          continue;
        }
      }
      if (run.status === "indexing_pages") {
        try {
          return await issueClaim(snapshot, {
            pageNumber: run.nextPageNumber,
            referenceOrdinal: null,
            type: "index_page",
            workKeyDigest: null,
          });
        } catch (error) {
          snapshot =
            await recoverClaimLoopRunTransition(
              work,
              snapshot,
              error,
            );
          continue;
        }
      }
      const page = await readPage(
        run,
        run.nextObservationPageNumber,
      );
      const entry = page.record.entries[
        run.nextObservationOrdinal
      ];
      if (!entry) {
        fail(
          "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_DURABLE_STATE_INVALID",
        );
      }
      if (entry.outcome !== null) {
        try {
          snapshot = await reconcileSettledEntry(
            snapshot,
            page,
          );
        } catch (error) {
          snapshot =
            await recoverClaimLoopRunTransition(
              work,
              snapshot,
              error,
            );
        }
        continue;
      }
      try {
        return await issueClaim(snapshot, {
          pageNumber: run.nextObservationPageNumber,
          referenceOrdinal: run.nextObservationOrdinal,
          type: "observe_work",
          workKeyDigest: entry.workKeyDigest,
        });
      } catch (error) {
        snapshot =
          await recoverClaimLoopRunTransition(
            work,
            snapshot,
            error,
          );
        continue;
      }
    }
    fail(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PROGRESS_INVALID",
    );
  }

  function issuedClaim(value, expectedStatus) {
    const code =
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CLAIM_INVALID";
    if (
      value === null
      || typeof value !== "object"
      || !Object.isFrozen(value)
      || !issuedClaims.has(value)
      || value.status !== expectedStatus
    ) {
      fail(code);
    }
    const issued = issuedClaims.get(value);
    const active = issued.run.activeClaim;
    if (
      active === null
      || active.claimNonceDigest !== issued.claimNonceDigest
      || active.pageNumber !== value.pageNumber
      || active.referenceOrdinal !== value.referenceOrdinal
      || active.workKeyDigest !== value.workKeyDigest
    ) {
      fail(code);
    }
    return deepFreeze({
      ...issued,
      claim: value,
    });
  }

  async function checkpointRecallPointObservationManifestPage(
    claimValue,
    verifiedPageValue,
  ) {
    const issued = issuedClaim(
      claimValue,
      "page_required",
    );
    const claim = issued.claim;
    let selected;
    try {
      selected = manifestEntryResult(
        await pointObservation.manifestEntries(
          verifiedPageValue,
        ),
        issued.run,
        claim,
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PAGE_INVALID",
      );
    } catch (error) {
      if (
        error
          instanceof SourceRecallPointObservationManifestStoreError
      ) {
        throw error;
      }
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PAGE_INVALID",
      );
    }
    const nowMs = timeResult(await persistence.time());
    if (
      nowMs < issued.runRedisNowMs
      || nowMs >= issued.run.activeClaim.expiresAtMs
      || nowMs >= issued.run.expiresAtMs
    ) {
      issuedClaims.delete(claimValue);
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CLAIM_EXPIRED",
      );
    }
    const proposed = initialPage(issued.run, selected, nowMs);
    const proposedRaw = canonicalJson(proposed);
    const ensured = persistenceSnapshot(
      await persistence.ensure({
        key: pageKey(
          issued.run.manifestKeyDigest,
          claim.pageNumber,
        ),
        proposedRaw,
        expiresAtMs: issued.run.expiresAtMs,
      }),
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PERSISTENCE_RESULT_INVALID",
    );
    if (
      ensured.status === "expired"
      || ensured.raw === null
    ) {
      issuedClaims.delete(claimValue);
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_EXPIRED",
      );
    }
    const pageSnapshot = parsePage(
      ensured.raw,
      ensured.redisNowMs,
      ensured.expiresAtMs,
    );
    pageBoundToRun(
      pageSnapshot.record,
      issued.run,
      claim.pageNumber,
    );
    if (
      pageSnapshot.record.indexDigest
        !== proposed.indexDigest
      || pageSnapshot.record.referenceCount
        !== proposed.referenceCount
      || canonicalJson(
        pageSnapshot.record.entries.map(indexEntry),
      ) !== canonicalJson(proposed.entries.map(indexEntry))
    ) {
      issuedClaims.delete(claimValue);
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_PAGE_BINDING_MISMATCH",
      );
    }
    const current = await readRun(deepFreeze({
      manifestKeyDigest: issued.run.manifestKeyDigest,
    }));
    if (current.raw !== issued.runRaw) {
      issuedClaims.delete(claimValue);
      if (
        current.record.pagesIndexed >= claim.pageNumber
      ) {
        return aggregateFromDurableRun(current.record);
      }
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CAS_CONFLICT",
      );
    }
    const nextValue = clone(current.record);
    nextValue.activeClaim = null;
    nextValue.pagesIndexed += 1;
    nextValue.referencesIndexed +=
      pageSnapshot.record.referenceCount;
    nextValue.nextPageNumber = claim.pageNumber + 1;
    nextValue.updatedAtMs = current.redisNowMs;
    nextValue.revision += 1;
    issuedClaims.delete(claimValue);
    const stored = await casRun(
      current,
      validateRun(nextValue),
      current.record.activeClaim.expiresAtMs,
    );
    return aggregateFor(stored.record);
  }

  async function prepareRecallPointObservationManifestSelection(
    claimValue,
    verifiedPageValue,
  ) {
    const issued = issuedClaim(
      claimValue,
      "observation_required",
    );
    const nowMs = timeResult(await persistence.time());
    if (
      nowMs < issued.runRedisNowMs
      || nowMs >= issued.run.activeClaim.expiresAtMs
      || nowMs >= issued.run.expiresAtMs
      || issued.run.status !== "observing"
      || issued.run.indexedManifestDigest === null
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CLAIM_EXPIRED",
      );
    }
    let prepared;
    try {
      const capability =
        issueRecallPointObservationManifestCapability(
          "prepare",
          deepFreeze({
            verifiedPage: verifiedPageValue,
            expiresAtMs: issued.run.expiresAtMs,
            workKeyDigest: issued.claim.workKeyDigest,
          }),
        );
      prepared = await pointObservation.prepareManifestSelection(
        capability,
      );
    } catch {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_POINT_PREPARE_FAILED",
      );
    }
    return preparedPointSnapshot(prepared, {
      ...issued.claim,
      run: issued.run,
    });
  }

  async function checkpointRecallPointObservationManifestWork(
    claimValue,
  ) {
    const issued = issuedClaim(
      claimValue,
      "observation_required",
    );
    const nowMs = timeResult(await persistence.time());
    if (
      nowMs < issued.runRedisNowMs
      || nowMs >= issued.run.activeClaim.expiresAtMs
      || nowMs >= issued.run.expiresAtMs
    ) {
      issuedClaims.delete(claimValue);
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CLAIM_EXPIRED",
      );
    }
    let pointSnapshotValue;
    try {
      const capability =
        issueRecallPointObservationManifestCapability(
          "read",
          deepFreeze({
            workKeyDigest: issued.claim.workKeyDigest,
          }),
        );
      pointSnapshotValue =
        await pointObservation.readManifestSelection(
          capability,
        );
    } catch {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_POINT_READ_FAILED",
      );
    }
    const selectedPoint = pointSnapshot(
      pointSnapshotValue,
      {
        ...issued.claim,
        run: issued.run,
      },
    );
    const pageSnapshot = await readPage(
      issued.run,
      issued.claim.pageNumber,
    );
    const currentEntry = pageSnapshot.record.entries[
      issued.claim.referenceOrdinal
    ];
    if (
      !currentEntry
      || currentEntry.workKeyDigest
        !== selectedPoint.workKeyDigest
      || currentEntry.workItemDigest
        !== selectedPoint.workItemDigest
    ) {
      issuedClaims.delete(claimValue);
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_POINT_BINDING_MISMATCH",
      );
    }
    let settledPage = pageSnapshot;
    if (currentEntry.outcome === null) {
      const nextPageValue = clone(pageSnapshot.record);
      const nextEntry = nextPageValue.entries[
        issued.claim.referenceOrdinal
      ];
      nextEntry.outcome = selectedPoint.outcome;
      nextEntry.readsCompleted =
        selectedPoint.readsCompleted;
      nextEntry.resolutionDigest =
        selectedPoint.resolutionDigest;
      nextPageValue.referencesSettled += 1;
      nextPageValue.settledReadsCompleted +=
        selectedPoint.readsCompleted;
      if (selectedPoint.outcome === "stable") {
        nextPageValue.referencesStable += 1;
      } else if (selectedPoint.outcome === "conflict") {
        nextPageValue.referencesConflict += 1;
      } else {
        nextPageValue.referencesUnresolved += 1;
      }
      nextPageValue.outcomeDigest = semanticDigest(
        "phase4-recall-point-observation-manifest-page-outcomes-v1",
        nextPageValue.entries.map(outcomeEntry),
      );
      nextPageValue.updatedAtMs =
        selectedPoint.redisNowMs;
      nextPageValue.revision += 1;
      settledPage = await casPage(
        pageSnapshot,
        validatePage(nextPageValue),
        issued.run.activeClaim.expiresAtMs,
      );
    } else if (
      currentEntry.outcome !== selectedPoint.outcome
      || currentEntry.readsCompleted
        !== selectedPoint.readsCompleted
      || currentEntry.resolutionDigest
        !== selectedPoint.resolutionDigest
    ) {
      issuedClaims.delete(claimValue);
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_POINT_BINDING_MISMATCH",
      );
    }
    const currentRun = await readRun(deepFreeze({
      manifestKeyDigest: issued.run.manifestKeyDigest,
    }));
    issuedClaims.delete(claimValue);
    if (currentRun.raw !== issued.runRaw) {
      if (
        currentRun.record.status
          === "observed_complete_dark"
        || currentRun.record.referencesSettled
          > issued.run.referencesSettled
      ) {
        return aggregateFromDurableRun(
          currentRun.record,
        );
      }
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_CAS_CONFLICT",
      );
    }
    const nextValue = clone(currentRun.record);
    nextValue.activeClaim = null;
    nextValue.updatedAtMs = currentRun.redisNowMs;
    nextValue.revision += 1;
    const cleared = await casRun(
      currentRun,
      validateRun(nextValue),
      currentRun.record.activeClaim.expiresAtMs,
    );
    const reconciled = await reconcileSettledEntry(
      cleared,
      settledPage,
    );
    return aggregateFor(reconciled.record);
  }

  async function readRecallPointObservationManifest(work) {
    const snapshot = await readRun(work);
    if (
      snapshot.record.status === "observed_complete_dark"
    ) {
      await verifyCompleteManifest(snapshot.record);
    }
    return snapshot;
  }

  return deepFreeze({
    checkpointRecallPointObservationManifestPage,
    checkpointRecallPointObservationManifestWork,
    claimRecallPointObservationManifestStep,
    ensureRecallPointObservationManifest,
    prepareRecallPointObservationManifestSelection,
    readRecallPointObservationManifest,
  });
}

let defaultStore = null;

function productionStore() {
  if (defaultStore === null) {
    const persistence =
      createSourceRecallPointObservationPersistenceAdapter();
    defaultStore =
      createSourceRecallPointObservationManifestStore({
        persistence,
        pointObservation:
          createSourceRecallPointObservationManifestPointInterface({
            persistence,
          }),
      });
  }
  return defaultStore;
}

export function ensureRecallPointObservationManifest(
  verifiedHeadValue,
) {
  return productionStore()
    .ensureRecallPointObservationManifest(verifiedHeadValue);
}

export function claimRecallPointObservationManifestStep(work) {
  return productionStore()
    .claimRecallPointObservationManifestStep(work);
}

export function checkpointRecallPointObservationManifestPage(
  claim,
  verifiedPageValue,
) {
  return productionStore()
    .checkpointRecallPointObservationManifestPage(
      claim,
      verifiedPageValue,
    );
}

export function prepareRecallPointObservationManifestSelection(
  claim,
  verifiedPageValue,
) {
  return productionStore()
    .prepareRecallPointObservationManifestSelection(
      claim,
      verifiedPageValue,
    );
}

export function checkpointRecallPointObservationManifestWork(
  claim,
) {
  return productionStore()
    .checkpointRecallPointObservationManifestWork(
      claim,
    );
}

export function readRecallPointObservationManifest(work) {
  return productionStore()
    .readRecallPointObservationManifest(work);
}
