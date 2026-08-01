// Private, hard-dark Paraform Human source-capture adapter contract.
//
// Paraform's paginated meeting response is not a source head. This adapter
// therefore requires two distinct process-local clients:
//   1. the reviewed private page client; and
//   2. a future independently reviewed immutable source-head client.
//
// Each page is sandwiched between two independent head observations and is
// checkpointable only when both exact head triples match. The capture journal
// separately requires the same triple across every page, both complete passes,
// and two post-capture head-verification rounds.
//
// There is intentionally no default head client, route, worker/coordinator
// importer, environment read, network implementation, pin, or authority
// transition in this module.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

export const SOURCE_PARAFORM_HUMAN_CAPTURE_ADAPTER_VERSION =
  "paraform-human-capture-adapter-v1";
export const SOURCE_PARAFORM_HUMAN_INDEPENDENT_HEAD_VERSION =
  "paraform-human-independent-source-head-v1";

const SOURCE = "paraform_human";
const PAGE_VERSION = "paraai-paraform-human-source-page-v2";
const DIGEST = /^[a-f0-9]{64}$/u;
const DECIMAL_CURSOR = /^(?:0|[1-9][0-9]*)$/u;
const CAPTURE_CLAIM_KEYS = Object.freeze([
  "claimNonceDigest",
  "raw",
  "record",
]);
const ADAPTER_OPTION_KEYS = Object.freeze([
  "pageClient",
  "sourceHeadClient",
]);
const PAGE_CLIENT_KEYS = Object.freeze([
  "assertPageResult",
  "readPage",
]);
const SOURCE_HEAD_CLIENT_KEYS = Object.freeze([
  "assertHeadResult",
  "readHead",
]);
const HEAD_RESULT_KEYS = Object.freeze([
  "boundaryAt",
  "source",
  "sourceHeadEpochDigest",
  "sourceHeadRecordDigest",
  "sourceHeadRevisionDigest",
  "version",
]);
const PAGE_RESULT_KEYS = Object.freeze([
  "boundaryAt",
  "exhausted",
  "nextCheckpoint",
  "outsideBoundary",
  "references",
  "scanned",
  "version",
]);
const PAGE_CHECKPOINT_KEYS = Object.freeze([
  "boundaryAt",
  "cursor",
  "version",
]);

export class SourceParaformHumanCaptureAdapterError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceParaformHumanCaptureAdapterError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceParaformHumanCaptureAdapterError(code);
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

function nonNegativeSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function positiveSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
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

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("SOURCE_PARAFORM_HUMAN_CAPTURE_PAGE_INVALID");
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
  fail("SOURCE_PARAFORM_HUMAN_CAPTURE_PAGE_INVALID");
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function captureClaim(value) {
  const code = "SOURCE_PARAFORM_HUMAN_CAPTURE_CLAIM_INVALID";
  const claim = plainRecord(value, code);
  exactKeys(claim, CAPTURE_CLAIM_KEYS, code);
  if (typeof claim.raw !== "string" || claim.raw.length === 0) {
    fail(code);
  }
  const record = plainRecord(claim.record, code);
  const decisionBoundaryAtMs = nonNegativeSafeInteger(
    record.decisionBoundaryAtMs,
    code,
  );
  const boundaryAt = new Date(decisionBoundaryAtMs).toISOString();
  if (Date.parse(boundaryAt) !== decisionBoundaryAtMs) {
    fail(code);
  }
  return {
    claimNonceDigest: digest(claim.claimNonceDigest, code),
    record,
    boundaryAt,
  };
}

function cursorToken(value, code) {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || !DECIMAL_CURSOR.test(value)
  ) {
    fail(code);
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 1) fail(code);
  return String(cursor);
}

function pageClaim(value) {
  const code =
    "SOURCE_PARAFORM_HUMAN_CAPTURE_PAGE_NOT_EXPECTED";
  const claim = captureClaim(value);
  if (claim.record.status !== "capturing") fail(code);
  const step = plainRecord(claim.record.activeStep, code);
  if (
    step.source !== SOURCE
    || ![1, 2].includes(step.passNumber)
  ) {
    fail(code);
  }
  const pageNumber = positiveSafeInteger(step.pageNumber, code);
  const currentCursorToken = cursorToken(
    step.cursorToken,
    "SOURCE_PARAFORM_HUMAN_CAPTURE_CURSOR_INVALID",
  );
  if (
    (pageNumber === 1 && currentCursorToken !== null)
    || (pageNumber > 1 && currentCursorToken === null)
  ) {
    fail("SOURCE_PARAFORM_HUMAN_CAPTURE_CURSOR_INVALID");
  }
  return {
    ...claim,
    step: deepFreeze({
      source: SOURCE,
      passNumber: step.passNumber,
      pageNumber,
      cursorToken: currentCursorToken,
    }),
  };
}

function headClaim(value) {
  const code =
    "SOURCE_PARAFORM_HUMAN_CAPTURE_HEAD_NOT_EXPECTED";
  const claim = captureClaim(value);
  if (
    claim.record.status !== "verifying_heads"
    || claim.record.activeStep !== null
    || !Array.isArray(claim.record.sources)
  ) {
    fail(code);
  }
  const index = nonNegativeSafeInteger(
    claim.record.headVerificationIndex,
    code,
  );
  const source = claim.record.sources[index];
  if (
    !source
    || plainRecord(source, code).source !== SOURCE
  ) {
    fail(code);
  }
  return claim;
}

function exactInterface(value, expectedKeys, code) {
  const selected = plainRecord(value, code);
  exactKeys(selected, expectedKeys, code);
  for (const key of expectedKeys) {
    if (typeof selected[key] !== "function") fail(code);
  }
  return selected;
}

async function clientCall(
  client,
  method,
  input,
  code,
  secondInput,
) {
  try {
    const args = secondInput === undefined
      ? [input]
      : [input, secondInput];
    return await Reflect.apply(client[method], client, args);
  } catch (error) {
    if (error instanceof SourceParaformHumanCaptureAdapterError) {
      throw error;
    }
    fail(code);
  }
}

function headRequest(boundaryAt) {
  return deepFreeze({ boundaryAt });
}

function canonicalHead(value, boundaryAt) {
  const code = "SOURCE_PARAFORM_HUMAN_CAPTURE_HEAD_INVALID";
  const head = plainRecord(value, code);
  exactKeys(head, HEAD_RESULT_KEYS, code);
  if (
    head.version
      !== SOURCE_PARAFORM_HUMAN_INDEPENDENT_HEAD_VERSION
    || head.source !== SOURCE
    || canonicalTimestamp(head.boundaryAt, code) !== boundaryAt
  ) {
    fail(code);
  }
  return deepFreeze({
    version: SOURCE_PARAFORM_HUMAN_INDEPENDENT_HEAD_VERSION,
    source: SOURCE,
    boundaryAt,
    sourceHeadEpochDigest: digest(
      head.sourceHeadEpochDigest,
      code,
    ),
    sourceHeadRevisionDigest: digest(
      head.sourceHeadRevisionDigest,
      code,
    ),
    sourceHeadRecordDigest: digest(
      head.sourceHeadRecordDigest,
      code,
    ),
  });
}

function sameHead(left, right) {
  return (
    left.sourceHeadEpochDigest === right.sourceHeadEpochDigest
    && left.sourceHeadRevisionDigest
      === right.sourceHeadRevisionDigest
    && left.sourceHeadRecordDigest
      === right.sourceHeadRecordDigest
  );
}

function pageRequest(claim) {
  const checkpoint = claim.step.cursorToken === null
    ? null
    : deepFreeze({
        version: PAGE_VERSION,
        boundaryAt: claim.boundaryAt,
        cursor: Number(claim.step.cursorToken),
      });
  return deepFreeze({
    boundaryAt: claim.boundaryAt,
    checkpoint,
  });
}

function canonicalPage(value, request, claim) {
  const code = "SOURCE_PARAFORM_HUMAN_CAPTURE_PAGE_INVALID";
  const page = plainRecord(value, code);
  exactKeys(page, PAGE_RESULT_KEYS, code);
  if (
    page.version !== PAGE_VERSION
    || canonicalTimestamp(page.boundaryAt, code)
      !== claim.boundaryAt
    || typeof page.exhausted !== "boolean"
    || !Number.isSafeInteger(page.scanned)
    || page.scanned < 0
    || page.scanned > 50
    || !Number.isSafeInteger(page.outsideBoundary)
    || page.outsideBoundary < 0
    || page.outsideBoundary > page.scanned
  ) {
    fail(code);
  }
  let nextCursorToken = null;
  if (page.nextCheckpoint !== null) {
    const checkpoint = plainRecord(page.nextCheckpoint, code);
    exactKeys(checkpoint, PAGE_CHECKPOINT_KEYS, code);
    if (
      checkpoint.version !== PAGE_VERSION
      || checkpoint.boundaryAt !== claim.boundaryAt
      || !Number.isSafeInteger(checkpoint.cursor)
      || checkpoint.cursor < 1
      || checkpoint.cursor
        !== Number(claim.step.cursorToken ?? 0) + page.scanned
    ) {
      fail(code);
    }
    nextCursorToken = String(checkpoint.cursor);
  }
  if (
    page.exhausted !== (page.nextCheckpoint === null)
    || !Array.isArray(page.references)
    || page.references.length
      > page.scanned - page.outsideBoundary
  ) {
    fail(code);
  }
  const normalized = jsonSnapshot(page, code);
  if (
    normalized.boundaryAt !== request.boundaryAt
    || (
      request.checkpoint === null
        ? claim.step.cursorToken !== null
        : String(request.checkpoint.cursor)
          !== claim.step.cursorToken
    )
  ) {
    fail(code);
  }
  return deepFreeze({
    normalized,
    nextCursorToken,
    recordCount: page.references.length,
  });
}

export function createSourceParaformHumanCaptureAdapter(
  options = {},
) {
  const selectedOptions = plainRecord(
    options,
    "SOURCE_PARAFORM_HUMAN_CAPTURE_ADAPTER_OPTIONS_INVALID",
  );
  exactKeys(
    selectedOptions,
    ADAPTER_OPTION_KEYS,
    "SOURCE_PARAFORM_HUMAN_CAPTURE_ADAPTER_OPTIONS_INVALID",
  );
  const pageClient = exactInterface(
    selectedOptions.pageClient,
    PAGE_CLIENT_KEYS,
    "SOURCE_PARAFORM_HUMAN_CAPTURE_PAGE_CLIENT_INVALID",
  );
  const sourceHeadClient = exactInterface(
    selectedOptions.sourceHeadClient,
    SOURCE_HEAD_CLIENT_KEYS,
    "SOURCE_PARAFORM_HUMAN_CAPTURE_HEAD_CLIENT_INVALID",
  );

  async function readIndependentHead(boundaryAt) {
    const request = headRequest(boundaryAt);
    const result = await clientCall(
      sourceHeadClient,
      "readHead",
      request,
      "SOURCE_PARAFORM_HUMAN_CAPTURE_HEAD_READ_FAILED",
    );
    const asserted = await clientCall(
      sourceHeadClient,
      "assertHeadResult",
      result,
      "SOURCE_PARAFORM_HUMAN_CAPTURE_HEAD_UNTRUSTED",
      request,
    );
    if (asserted !== result) {
      fail("SOURCE_PARAFORM_HUMAN_CAPTURE_HEAD_UNTRUSTED");
    }
    return canonicalHead(result, boundaryAt);
  }

  async function readPage(value) {
    const claim = pageClaim(value);
    const before = await readIndependentHead(claim.boundaryAt);
    const request = pageRequest(claim);
    const result = await clientCall(
      pageClient,
      "readPage",
      request,
      "SOURCE_PARAFORM_HUMAN_CAPTURE_PAGE_READ_FAILED",
    );
    const asserted = await clientCall(
      pageClient,
      "assertPageResult",
      result,
      "SOURCE_PARAFORM_HUMAN_CAPTURE_PAGE_UNTRUSTED",
      request,
    );
    if (asserted !== result) {
      fail("SOURCE_PARAFORM_HUMAN_CAPTURE_PAGE_UNTRUSTED");
    }
    const page = canonicalPage(result, request, claim);
    const after = await readIndependentHead(claim.boundaryAt);
    if (!sameHead(before, after)) {
      fail("SOURCE_PARAFORM_HUMAN_CAPTURE_HEAD_CHANGED_DURING_PAGE");
    }
    return deepFreeze({
      checkpointEvent: {
        kind: "page_checkpoint",
        claimNonceDigest: claim.claimNonceDigest,
        source: SOURCE,
        passNumber: claim.step.passNumber,
        pageNumber: claim.step.pageNumber,
        cursorToken: claim.step.cursorToken,
        nextCursorToken: page.nextCursorToken,
        pageSemanticDigest: semanticDigest(
          "phase4-source-paraform-human-page-semantic-v1",
          page.normalized,
        ),
        recordCount: page.recordCount,
        sourceHeadEpochDigest:
          before.sourceHeadEpochDigest,
        sourceHeadRevisionDigest:
          before.sourceHeadRevisionDigest,
        sourceHeadRecordDigest:
          before.sourceHeadRecordDigest,
      },
    });
  }

  async function readHead(value) {
    const claim = headClaim(value);
    const head = await readIndependentHead(claim.boundaryAt);
    return deepFreeze({
      checkpointEvent: {
        kind: "head_checkpoint",
        claimNonceDigest: claim.claimNonceDigest,
        source: SOURCE,
        sourceHeadEpochDigest:
          head.sourceHeadEpochDigest,
        sourceHeadRevisionDigest:
          head.sourceHeadRevisionDigest,
        sourceHeadRecordDigest:
          head.sourceHeadRecordDigest,
      },
    });
  }

  return deepFreeze({
    readHead,
    readPage,
  });
}
