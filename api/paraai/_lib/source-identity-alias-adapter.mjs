// Private, hard-dark adapter for a sealed candidate-user alias artifact.
//
// This module has no transport, route, signer, or write-side integration. It
// accepts only the process-local capture claim selected by the source journal,
// wraps a narrow injected artifact-store interface, and returns private
// checkpoint evidence. The artifact store owns durable sealing and opaque
// cursor validation; this adapter independently validates exact stored bytes
// and computes every digest that it returns from those bytes.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

export const SOURCE_IDENTITY_ALIAS_ADAPTER_VERSION =
  "candidate-user-alias-sealed-adapter-v1";
export const SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE = 100;

const SOURCE = "aliases";
const ARTIFACT_STORE_POLICY_VERSION =
  "phase4-source-identity-artifact-store-v1";
const IDENTITY_POINT_READ_PROCEDURE =
  "candidateUser.getCandidateUserById";
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_HEAD_BYTES = 1_048_576;
const MAX_PAGE_BYTES = 8_388_608;
const CAPTURE_CLAIM_KEYS = Object.freeze([
  "claimNonceDigest",
  "raw",
  "record",
]);
const STORE_METHODS = Object.freeze([
  "prepareIdentityAliasArtifact",
  "readIdentityAliasArtifactHead",
  "readIdentityAliasArtifactPage",
]);
const HEAD_RECORD_KEYS = Object.freeze([
  "version",
  "policyVersion",
  "kind",
  "runNonceDigest",
  "decisionBoundaryAtMs",
  "contractPinsDigest",
  "sealedArtifactDigest",
  "workManifestDigest",
  "workManifestCount",
  "terminalWorkSetDigest",
  "pageSize",
  "pageCount",
  "resolvedEntryCount",
  "unresolvedWorkCount",
  "conflictWorkCount",
  "pages",
]);
const HEAD_PAGE_KEYS = Object.freeze([
  "pageNumber",
  "cursorToken",
  "nextCursorToken",
  "entryCount",
  "pageRecordDigest",
  "pageSemanticDigest",
]);
const PAGE_RECORD_KEYS = Object.freeze([
  "version",
  "policyVersion",
  "kind",
  "runNonceDigest",
  "decisionBoundaryAtMs",
  "contractPinsDigest",
  "pageNumber",
  "pageSize",
  "cursorToken",
  "nextCursorToken",
  "entryCount",
  "entries",
]);
const PAGE_ENTRY_KEYS = Object.freeze([
  "candidateUserAliasDigest",
  "canonicalCandidateDigest",
  "identityPointReadProcedure",
  "identityNormalizedInputDigest",
  "identityPointRecordDigest",
  "identityPointRecordRevisionDigest",
  "workItemDigest",
  "resolutionDigest",
]);

export class SourceIdentityAliasAdapterError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceIdentityAliasAdapterError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceIdentityAliasAdapterError(code);
}

function plainRecord(value, code) {
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
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(code);
  }
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
  return snapshot;
}

function exactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length
    || actual.some((key, index) => key !== required[index])
  ) {
    fail(code);
  }
}

function digest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
  return value;
}

function cursor(value, code) {
  if (value === null) return null;
  return digest(value, code);
}

function nonNegativeSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function positiveSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function rawDigest(raw) {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("SOURCE_IDENTITY_ALIAS_HEAD_INVALID");
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
  fail("SOURCE_IDENTITY_ALIAS_HEAD_INVALID");
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function byteCommitment(namespace, raw) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(raw, "utf8")
    .digest("hex");
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

function jsonSnapshot(value, code, seen = new WeakSet()) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(code);
    return value;
  }
  if (!value || typeof value !== "object") fail(code);
  if (seen.has(value) || nodeTypes.isProxy(value)) fail(code);
  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expectedKeys = [
      ...Array.from(
        { length: value.length },
        (_unused, index) => String(index),
      ),
      "length",
    ].sort();
    const actualKeys = Object.keys(descriptors).sort();
    if (
      Object.getOwnPropertySymbols(value).length !== 0
      || actualKeys.length !== expectedKeys.length
      || actualKeys.some(
        (key, index) => key !== expectedKeys[index],
      )
      || descriptors.length?.enumerable === true
    ) {
      fail(code);
    }
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index];
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
      result.push(jsonSnapshot(descriptor.value, code, seen));
    }
    seen.delete(value);
    return result;
  }
  const record = plainRecord(value, code);
  const result = {};
  for (const [key, child] of Object.entries(record)) {
    result[key] = jsonSnapshot(child, code, seen);
  }
  seen.delete(value);
  return result;
}

function exactRawRecord(raw, record, maximumBytes, code) {
  if (
    typeof raw !== "string"
    || raw.length === 0
    || Buffer.byteLength(raw, "utf8") > maximumBytes
  ) {
    fail(code);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(code);
  }
  const parsedSnapshot = jsonSnapshot(parsed, code);
  const returnedSnapshot = jsonSnapshot(record, code);
  if (
    JSON.stringify(parsedSnapshot) !== raw
    || JSON.stringify(returnedSnapshot) !== raw
  ) {
    fail(code);
  }
  return deepFreeze(parsedSnapshot);
}

function captureClaim(value) {
  const claim = plainRecord(
    value,
    "SOURCE_IDENTITY_ALIAS_CLAIM_INVALID",
  );
  exactKeys(
    claim,
    CAPTURE_CLAIM_KEYS,
    "SOURCE_IDENTITY_ALIAS_CLAIM_INVALID",
  );
  if (typeof claim.raw !== "string" || claim.raw.length === 0) {
    fail("SOURCE_IDENTITY_ALIAS_CLAIM_INVALID");
  }
  const record = plainRecord(
    claim.record,
    "SOURCE_IDENTITY_ALIAS_CLAIM_INVALID",
  );
  return {
    claimNonceDigest: digest(
      claim.claimNonceDigest,
      "SOURCE_IDENTITY_ALIAS_CLAIM_INVALID",
    ),
    record,
    context: deepFreeze({
      runNonceDigest: digest(
        record.runNonceDigest,
        "SOURCE_IDENTITY_ALIAS_CLAIM_INVALID",
      ),
      decisionBoundaryAtMs: nonNegativeSafeInteger(
        record.decisionBoundaryAtMs,
        "SOURCE_IDENTITY_ALIAS_CLAIM_INVALID",
      ),
      contractPinsDigest: digest(
        record.contractPinsDigest,
        "SOURCE_IDENTITY_ALIAS_CLAIM_INVALID",
      ),
    }),
  };
}

function pageClaim(value) {
  const claim = captureClaim(value);
  if (claim.record.status !== "capturing") {
    fail("SOURCE_IDENTITY_ALIAS_PAGE_NOT_EXPECTED");
  }
  const step = plainRecord(
    claim.record.activeStep,
    "SOURCE_IDENTITY_ALIAS_PAGE_NOT_EXPECTED",
  );
  if (
    step.source !== SOURCE
    || ![1, 2].includes(step.passNumber)
  ) {
    fail("SOURCE_IDENTITY_ALIAS_PAGE_NOT_EXPECTED");
  }
  const pageNumber = positiveSafeInteger(
    step.pageNumber,
    "SOURCE_IDENTITY_ALIAS_PAGE_NOT_EXPECTED",
  );
  const cursorToken = cursor(
    step.cursorToken,
    "SOURCE_IDENTITY_ALIAS_CURSOR_INVALID",
  );
  if (
    (pageNumber === 1 && cursorToken !== null)
    || (pageNumber > 1 && cursorToken === null)
  ) {
    fail("SOURCE_IDENTITY_ALIAS_CURSOR_INVALID");
  }
  return {
    ...claim,
    step: deepFreeze({
      source: SOURCE,
      passNumber: step.passNumber,
      pageNumber,
      cursorToken,
    }),
  };
}

function headClaim(value) {
  const claim = captureClaim(value);
  if (
    claim.record.status !== "verifying_heads"
    || claim.record.activeStep !== null
    || !Array.isArray(claim.record.sources)
  ) {
    fail("SOURCE_IDENTITY_ALIAS_HEAD_NOT_EXPECTED");
  }
  const index = nonNegativeSafeInteger(
    claim.record.headVerificationIndex,
    "SOURCE_IDENTITY_ALIAS_HEAD_NOT_EXPECTED",
  );
  const source = claim.record.sources[index];
  if (
    !source
    || plainRecord(
      source,
      "SOURCE_IDENTITY_ALIAS_HEAD_NOT_EXPECTED",
    ).source !== SOURCE
  ) {
    fail("SOURCE_IDENTITY_ALIAS_HEAD_NOT_EXPECTED");
  }
  return claim;
}

function aliasClaim(value) {
  const claim = captureClaim(value);
  if (claim.record.status === "capturing") {
    return pageClaim(value);
  }
  if (claim.record.status === "verifying_heads") {
    return headClaim(value);
  }
  fail("SOURCE_IDENTITY_ALIAS_STEP_NOT_EXPECTED");
}

function storeInterface(value) {
  const store = plainRecord(
    value,
    "SOURCE_IDENTITY_ALIAS_STORE_INTERFACE_INVALID",
  );
  for (const method of STORE_METHODS) {
    if (typeof store[method] !== "function") {
      fail("SOURCE_IDENTITY_ALIAS_STORE_INTERFACE_INVALID");
    }
  }
  return store;
}

async function storeCall(store, method, input, errorCode) {
  try {
    return await Reflect.apply(store[method], store, [input]);
  } catch (error) {
    if (error instanceof SourceIdentityAliasAdapterError) {
      throw error;
    }
    fail(errorCode);
  }
}

function preparation(value) {
  const prepared = plainRecord(
    value,
    "SOURCE_IDENTITY_ALIAS_ARTIFACT_INVALID",
  );
  return deepFreeze({
    sealedArtifactDigest: digest(
      prepared.sealedArtifactDigest,
      "SOURCE_IDENTITY_ALIAS_ARTIFACT_INVALID",
    ),
    headRecordDigest: digest(
      prepared.headRecordDigest,
      "SOURCE_IDENTITY_ALIAS_ARTIFACT_INVALID",
    ),
  });
}

function boundHeadRecord(record, context, sealedArtifactDigest) {
  if (
    record.runNonceDigest !== context.runNonceDigest
    || record.decisionBoundaryAtMs
      !== context.decisionBoundaryAtMs
    || record.contractPinsDigest !== context.contractPinsDigest
    || record.sealedArtifactDigest !== sealedArtifactDigest
  ) {
    fail("SOURCE_IDENTITY_ALIAS_HEAD_BINDING_INVALID");
  }
}

function headPageManifest(value, expectedPageNumber) {
  const page = plainRecord(
    value,
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  exactKeys(
    page,
    HEAD_PAGE_KEYS,
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  const pageNumber = positiveSafeInteger(
    page.pageNumber,
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  if (pageNumber !== expectedPageNumber) {
    fail("SOURCE_IDENTITY_ALIAS_HEAD_INVALID");
  }
  return deepFreeze({
    pageNumber,
    cursorToken: cursor(
      page.cursorToken,
      "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
    ),
    nextCursorToken: cursor(
      page.nextCursorToken,
      "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
    ),
    entryCount: nonNegativeSafeInteger(
      page.entryCount,
      "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
    ),
    pageRecordDigest: digest(
      page.pageRecordDigest,
      "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
    ),
    pageSemanticDigest: digest(
      page.pageSemanticDigest,
      "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
    ),
  });
}

function canonicalHeadRecord(record, context, sealedArtifactDigest) {
  exactKeys(
    record,
    HEAD_RECORD_KEYS,
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  boundHeadRecord(record, context, sealedArtifactDigest);
  if (
    record.version !== 1
    || record.policyVersion !== ARTIFACT_STORE_POLICY_VERSION
    || record.kind !== "identity_alias_artifact_head_dark"
    || record.pageSize !== SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE
    || !Array.isArray(record.pages)
  ) {
    fail("SOURCE_IDENTITY_ALIAS_HEAD_INVALID");
  }
  const pageCount = positiveSafeInteger(
    record.pageCount,
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  if (record.pages.length !== pageCount) {
    fail("SOURCE_IDENTITY_ALIAS_HEAD_INVALID");
  }
  const pages = record.pages.map((page, index) => (
    headPageManifest(page, index + 1)
  ));
  let priorNextCursor = null;
  let resolvedEntryCount = 0;
  const seenCursors = new Set();
  for (const [index, page] of pages.entries()) {
    if (
      page.cursorToken !== priorNextCursor
      || (index === 0 && page.cursorToken !== null)
      || (
        index < pages.length - 1
        && page.nextCursorToken === null
      )
      || (
        index === pages.length - 1
        && page.nextCursorToken !== null
      )
      || (
        index < pages.length - 1
        && page.entryCount
          !== SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE
      )
      || page.entryCount
        > SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE
    ) {
      fail("SOURCE_IDENTITY_ALIAS_HEAD_INVALID");
    }
    if (
      page.cursorToken !== null
      && seenCursors.has(page.cursorToken)
    ) {
      fail("SOURCE_IDENTITY_ALIAS_HEAD_INVALID");
    }
    if (page.cursorToken !== null) {
      seenCursors.add(page.cursorToken);
    }
    priorNextCursor = page.nextCursorToken;
    resolvedEntryCount += page.entryCount;
  }
  if (
    nonNegativeSafeInteger(
      record.resolvedEntryCount,
      "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
    ) !== resolvedEntryCount
  ) {
    fail("SOURCE_IDENTITY_ALIAS_HEAD_INVALID");
  }
  nonNegativeSafeInteger(
    record.unresolvedWorkCount,
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  nonNegativeSafeInteger(
    record.conflictWorkCount,
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  const workManifestCount = nonNegativeSafeInteger(
    record.workManifestCount,
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  digest(
    record.workManifestDigest,
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  digest(
    record.terminalWorkSetDigest,
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  if (
    resolvedEntryCount
      + record.unresolvedWorkCount
      + record.conflictWorkCount
      !== workManifestCount
  ) {
    fail("SOURCE_IDENTITY_ALIAS_HEAD_INVALID");
  }
  const {
    sealedArtifactDigest: ignoredSealedArtifactDigest,
    ...headMaterial
  } = record;
  void ignoredSealedArtifactDigest;
  if (
    semanticDigest(
      "phase4-source-identity-alias-artifact-v1",
      headMaterial,
    ) !== sealedArtifactDigest
  ) {
    fail("SOURCE_IDENTITY_ALIAS_ARTIFACT_DIGEST_MISMATCH");
  }
  return deepFreeze({
    policyVersion: record.policyVersion,
    pages,
  });
}

function headEvidence(value, prepared, context) {
  const head = plainRecord(
    value,
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  exactKeys(
    head,
    ["headRecordDigest", "raw", "record", "redisNowMs"],
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  const rawRecord = exactRawRecord(
    head.raw,
    head.record,
    MAX_HEAD_BYTES,
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  const computedRecordDigest = rawDigest(head.raw);
  if (
    digest(
      head.headRecordDigest,
      "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
    ) !== computedRecordDigest
    || prepared.headRecordDigest !== computedRecordDigest
  ) {
    fail("SOURCE_IDENTITY_ALIAS_HEAD_DIGEST_MISMATCH");
  }
  nonNegativeSafeInteger(
    head.redisNowMs,
    "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
  );
  const canonical = canonicalHeadRecord(
    rawRecord,
    context,
    prepared.sealedArtifactDigest,
  );
  return deepFreeze({
    raw: head.raw,
    sealedArtifactDigest: prepared.sealedArtifactDigest,
    policyVersion: canonical.policyVersion,
    pages: canonical.pages,
    sourceHeadEpochDigest: byteCommitment(
      "phase4-source-identity-alias-head-epoch-v1",
      head.raw,
    ),
    sourceHeadRevisionDigest: byteCommitment(
      "phase4-source-identity-alias-head-revision-v1",
      head.raw,
    ),
    sourceHeadRecordDigest: computedRecordDigest,
  });
}

function canonicalPageEntry(value) {
  const entry = plainRecord(
    value,
    "SOURCE_IDENTITY_ALIAS_PAGE_ENTRY_INVALID",
  );
  exactKeys(
    entry,
    PAGE_ENTRY_KEYS,
    "SOURCE_IDENTITY_ALIAS_PAGE_ENTRY_INVALID",
  );
  if (
    entry.identityPointReadProcedure
      !== IDENTITY_POINT_READ_PROCEDURE
  ) {
    fail("SOURCE_IDENTITY_ALIAS_PAGE_ENTRY_INVALID");
  }
  for (const key of PAGE_ENTRY_KEYS) {
    if (key === "identityPointReadProcedure") continue;
    digest(
      entry[key],
      "SOURCE_IDENTITY_ALIAS_PAGE_ENTRY_INVALID",
    );
  }
  if (
    entry.candidateUserAliasDigest
      === entry.canonicalCandidateDigest
  ) {
    fail("SOURCE_IDENTITY_ALIAS_PAGE_ENTRY_INVALID");
  }
  return entry;
}

function validatePageEntries(entries) {
  const normalized = entries.map(canonicalPageEntry);
  const aliases = new Set();
  const canonicals = new Set();
  let prior = null;
  for (const entry of normalized) {
    const orderingKey = [
      entry.candidateUserAliasDigest,
      entry.canonicalCandidateDigest,
      entry.workItemDigest,
    ].join(":");
    if (
      (prior !== null && orderingKey <= prior)
      || aliases.has(entry.candidateUserAliasDigest)
      || canonicals.has(entry.canonicalCandidateDigest)
    ) {
      fail("SOURCE_IDENTITY_ALIAS_PAGE_ENTRY_INVALID");
    }
    prior = orderingKey;
    aliases.add(entry.candidateUserAliasDigest);
    canonicals.add(entry.canonicalCandidateDigest);
  }
  return normalized;
}

function pageEvidence(value, claim, head) {
  const page = plainRecord(
    value,
    "SOURCE_IDENTITY_ALIAS_PAGE_INVALID",
  );
  exactKeys(
    page,
    [
      "cursorToken",
      "nextCursorToken",
      "pageRecordDigest",
      "pageSemanticDigest",
      "raw",
      "record",
      "recordCount",
      "redisNowMs",
    ],
    "SOURCE_IDENTITY_ALIAS_PAGE_INVALID",
  );
  const currentCursor = cursor(
    page.cursorToken,
    "SOURCE_IDENTITY_ALIAS_CURSOR_INVALID",
  );
  const nextCursorToken = cursor(
    page.nextCursorToken,
    "SOURCE_IDENTITY_ALIAS_CURSOR_INVALID",
  );
  if (
    currentCursor !== claim.step.cursorToken
    || (
      nextCursorToken !== null
      && nextCursorToken === currentCursor
    )
  ) {
    fail("SOURCE_IDENTITY_ALIAS_CURSOR_MISMATCH");
  }
  const rawRecord = exactRawRecord(
    page.raw,
    page.record,
    MAX_PAGE_BYTES,
    "SOURCE_IDENTITY_ALIAS_PAGE_INVALID",
  );
  const pageRecordDigest = rawDigest(page.raw);
  const returnedPageSemanticDigest = digest(
    page.pageSemanticDigest,
    "SOURCE_IDENTITY_ALIAS_PAGE_INVALID",
  );
  if (
    digest(
      page.pageRecordDigest,
      "SOURCE_IDENTITY_ALIAS_PAGE_INVALID",
    ) !== pageRecordDigest
  ) {
    fail("SOURCE_IDENTITY_ALIAS_PAGE_DIGEST_MISMATCH");
  }
  const recordCount = nonNegativeSafeInteger(
    page.recordCount,
    "SOURCE_IDENTITY_ALIAS_PAGE_INVALID",
  );
  if (recordCount > SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE) {
    fail("SOURCE_IDENTITY_ALIAS_PAGE_SIZE_INVALID");
  }
  nonNegativeSafeInteger(
    page.redisNowMs,
    "SOURCE_IDENTITY_ALIAS_PAGE_INVALID",
  );
  exactKeys(
    rawRecord,
    PAGE_RECORD_KEYS,
    "SOURCE_IDENTITY_ALIAS_PAGE_INVALID",
  );
  if (
    rawRecord.version !== 1
    || rawRecord.policyVersion !== head.policyVersion
    || rawRecord.kind !== "identity_alias_artifact_page_dark"
    || rawRecord.runNonceDigest
      !== claim.context.runNonceDigest
    || rawRecord.decisionBoundaryAtMs
      !== claim.context.decisionBoundaryAtMs
    || rawRecord.contractPinsDigest
      !== claim.context.contractPinsDigest
    || rawRecord.pageNumber !== claim.step.pageNumber
    || rawRecord.pageSize
      !== SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE
    || rawRecord.cursorToken !== currentCursor
    || rawRecord.nextCursorToken !== nextCursorToken
    || rawRecord.entryCount !== recordCount
    || !Array.isArray(rawRecord.entries)
    || rawRecord.entries.length !== recordCount
  ) {
    fail("SOURCE_IDENTITY_ALIAS_PAGE_BINDING_INVALID");
  }
  const entries = validatePageEntries(rawRecord.entries);
  const computedPageSemanticDigest = semanticDigest(
    "phase4-source-identity-alias-page-semantic-v1",
    entries,
  );
  const manifest = head.pages[claim.step.pageNumber - 1];
  if (
    !manifest
    || manifest.cursorToken !== currentCursor
    || manifest.nextCursorToken !== nextCursorToken
    || manifest.entryCount !== recordCount
    || manifest.pageRecordDigest !== pageRecordDigest
    || manifest.pageSemanticDigest
      !== returnedPageSemanticDigest
    || returnedPageSemanticDigest
      !== computedPageSemanticDigest
  ) {
    fail("SOURCE_IDENTITY_ALIAS_PAGE_SEAL_MISMATCH");
  }
  return deepFreeze({
    raw: page.raw,
    pageRecordDigest,
    pageSemanticDigest: returnedPageSemanticDigest,
    recordCount,
    cursorToken: currentCursor,
    nextCursorToken,
  });
}

function contextKey(context) {
  return [
    context.runNonceDigest,
    context.decisionBoundaryAtMs,
    context.contractPinsDigest,
  ].join(":");
}

export function createSourceIdentityAliasAdapter(options = {}) {
  const normalizedOptions = plainRecord(
    options,
    "SOURCE_IDENTITY_ALIAS_STORE_INTERFACE_INVALID",
  );
  exactKeys(
    normalizedOptions,
    ["artifactStore"],
    "SOURCE_IDENTITY_ALIAS_STORE_INTERFACE_INVALID",
  );
  const { artifactStore } = normalizedOptions;
  const store = storeInterface(artifactStore);
  const observedHeads = new Map();
  const observedPages = new Map();

  async function loadSealedHead(context) {
    const prepared = preparation(await storeCall(
      store,
      "prepareIdentityAliasArtifact",
      context,
      "SOURCE_IDENTITY_ALIAS_PREPARE_FAILED",
    ));
    const head = headEvidence(await storeCall(
      store,
      "readIdentityAliasArtifactHead",
      deepFreeze({
        sealedArtifactDigest: prepared.sealedArtifactDigest,
        ...context,
      }),
      "SOURCE_IDENTITY_ALIAS_HEAD_READ_FAILED",
    ), prepared, context);
    const key = contextKey(context);
    const observed = observedHeads.get(key);
    if (
      observed
      && (
        observed.sealedArtifactDigest
          !== head.sealedArtifactDigest
        || observed.sourceHeadRecordDigest
          !== head.sourceHeadRecordDigest
        || observed.raw !== head.raw
      )
    ) {
      fail("SOURCE_IDENTITY_ALIAS_SEALED_HEAD_CHANGED");
    }
    observedHeads.set(key, head);
    return head;
  }

  async function prepare(value) {
    const claim = aliasClaim(value);
    const head = await loadSealedHead(claim.context);
    return deepFreeze({
      status: "sealed",
      source: SOURCE,
      pageSize: SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE,
      rawSourceHead: head.raw,
      sourceHeadEpochDigest: head.sourceHeadEpochDigest,
      sourceHeadRevisionDigest:
        head.sourceHeadRevisionDigest,
      sourceHeadRecordDigest: head.sourceHeadRecordDigest,
    });
  }

  async function readPage(value) {
    const claim = pageClaim(value);
    const head = await loadSealedHead(claim.context);
    const page = pageEvidence(await storeCall(
      store,
      "readIdentityAliasArtifactPage",
      deepFreeze({
        sealedArtifactDigest: head.sealedArtifactDigest,
        ...claim.context,
        cursorToken: claim.step.cursorToken,
      }),
      "SOURCE_IDENTITY_ALIAS_PAGE_READ_FAILED",
    ), claim, head);
    const pageKey = [
      contextKey(claim.context),
      head.sealedArtifactDigest,
      head.sourceHeadRecordDigest,
      claim.step.pageNumber,
      claim.step.cursorToken ?? "root",
    ].join(":");
    const observedPageDigest = observedPages.get(pageKey);
    if (
      observedPageDigest
      && observedPageDigest !== page.pageRecordDigest
    ) {
      fail("SOURCE_IDENTITY_ALIAS_SEALED_PAGE_CHANGED");
    }
    observedPages.set(pageKey, page.pageRecordDigest);
    return deepFreeze({
      rawSourceHead: head.raw,
      checkpointEvent: {
        kind: "page_checkpoint",
        claimNonceDigest: claim.claimNonceDigest,
        source: SOURCE,
        passNumber: claim.step.passNumber,
        pageNumber: claim.step.pageNumber,
        cursorToken: claim.step.cursorToken,
        nextCursorToken: page.nextCursorToken,
        pageSemanticDigest: page.pageSemanticDigest,
        recordCount: page.recordCount,
        sourceHeadEpochDigest: head.sourceHeadEpochDigest,
        sourceHeadRevisionDigest:
          head.sourceHeadRevisionDigest,
        sourceHeadRecordDigest:
          head.sourceHeadRecordDigest,
      },
    });
  }

  async function readHead(value) {
    const claim = headClaim(value);
    const head = await loadSealedHead(claim.context);
    return deepFreeze({
      rawSourceHead: head.raw,
      checkpointEvent: {
        kind: "head_checkpoint",
        claimNonceDigest: claim.claimNonceDigest,
        source: SOURCE,
        sourceHeadEpochDigest: head.sourceHeadEpochDigest,
        sourceHeadRevisionDigest:
          head.sourceHeadRevisionDigest,
        sourceHeadRecordDigest:
          head.sourceHeadRecordDigest,
      },
    });
  }

  return deepFreeze({
    prepare,
    readPage,
    readHead,
  });
}
