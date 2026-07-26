// Dark-only Phase 4 source capture journal.
//
// This store owns the decision boundary, source order, pass order, page
// checkpoints, source-head verification, and a short freshness lease. All
// clocks come from Redis TIME and all updates compare the exact raw record.
//
// Nothing in this module activates a source generation, mints an authority
// receipt, reserves a Paraform write, or makes a source call. Page/head events
// are a private adapter boundary for a future reviewed coordinator. The
// runner-facing coordinator does not accept or forward any of those fields.
// Every observation binds three independent head values: the semantic epoch,
// the observation revision digest, and SHA-256 of the exact raw durable head
// record. Capture-record CAS separately compares the complete raw bytes.

import {
  createHash,
  randomBytes,
} from "node:crypto";

import {
  SOURCE_HUMAN_INTRO_ARTIFACT_DIGEST,
  SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_DIGEST,
  SOURCE_Q37_DISCRIMINATOR_ARTIFACT_DIGEST,
  SOURCE_WATERMARK_APPROVED_COLLECTORS,
  SOURCE_WATERMARK_POLICY_VERSION,
} from "./source-watermark.mjs";

export const SOURCE_CAPTURE_POLICY_VERSION =
  "phase4-source-capture-coordinator-v1";
export const SOURCE_CAPTURE_RECORD_VERSION = 1;
export const SOURCE_CAPTURE_FRESHNESS_LEASE_VERSION = 1;
export const SOURCE_CAPTURE_FRESHNESS_LEASE_MS = 60_000;
export const SOURCE_CAPTURE_HEAD_VERIFICATION_ROUNDS = 2;
export const SOURCE_CAPTURE_HEAD_VERIFICATION_MAX_SPAN_MS =
  15_000;

const CURRENT_CAPTURE_KEY =
  "paraai:phase4:source-capture:current:v1";
const CAPTURE_HEAD_KEY =
  "paraai:phase4:source-capture:head:v1";
const SOURCE_ORDER = Object.freeze([
  "recall",
  "paraform_human",
  "human_intro",
  "aliases",
]);
const SOURCE_SET = new Set(SOURCE_ORDER);
const DIGEST = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const MAX_CURSOR_LENGTH = 8_192;
const REDIS_CLOCK_SKEW_MS = 5_000;
const ISSUED_CAPTURE_CLAIMS = new WeakSet();

export class SourceCaptureStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "SourceCaptureStoreError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new SourceCaptureStoreError(code, message);
}

function invariant(condition, code, message = code) {
  if (!condition) fail(code, message);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, code, field) {
  const actual = Object.keys(object(value, field)).sort();
  const required = [...expected].sort();
  invariant(
    canonicalJson(actual) === canonicalJson(required),
    code,
    `${field} has an unexpected shape`,
  );
}

function digest(value, field) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${field} must be a lowercase sha256 digest`);
  }
  return value;
}

function optionalDigest(value, field) {
  return value == null ? null : digest(value, field);
}

function sha1(value, field) {
  if (typeof value !== "string" || !SHA1.test(value)) {
    throw new TypeError(`${field} must be a lowercase sha1 digest`);
  }
  return value;
}

function optionalSha1(value, field) {
  return value == null ? null : sha1(value, field);
}

function nonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function nullableCursor(value, field) {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_CURSOR_LENGTH
  ) {
    throw new TypeError(`${field} must be a bounded opaque cursor`);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical values must be finite");
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
  throw new TypeError("canonical values must be JSON-safe");
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function releasePinsDigest() {
  return semanticDigest(
    "phase4-source-capture-release-pins-v1",
    {
      capturePolicyVersion: SOURCE_CAPTURE_POLICY_VERSION,
      requiredSources: SOURCE_ORDER,
      sourcePolicyVersion: SOURCE_WATERMARK_POLICY_VERSION,
      collectors: SOURCE_WATERMARK_APPROVED_COLLECTORS,
      identityCollectorArtifactDigest:
        SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_DIGEST,
      q37DiscriminatorArtifactDigest:
        SOURCE_Q37_DISCRIMINATOR_ARTIFACT_DIGEST,
      humanIntroArtifactDigest:
        SOURCE_HUMAN_INTRO_ARTIFACT_DIGEST,
    },
  );
}

function emptyPass(passNumber) {
  return {
    passNumber,
    status: "pending",
    nextPageNumber: 1,
    nextCursorToken: null,
    pageCount: 0,
    recordCount: 0,
    pageSemanticDigests: [],
    sourceHeadEpochDigest: null,
    sourceHeadRevisionDigest: null,
    sourceHeadRecordDigest: null,
    terminalCursorObserved: false,
    semanticDigest: null,
  };
}

function emptySource(source) {
  return {
    source,
    status: "pending",
    passes: [emptyPass(1), emptyPass(2)],
    headChecks: [1, 2].map((round) => ({
      round,
      status: "pending",
      sourceHeadEpochDigest: null,
      sourceHeadRevisionDigest: null,
      sourceHeadRecordDigest: null,
      observedAtMs: null,
    })),
    verifiedHeadEpochDigest: null,
    verifiedHeadRevisionDigest: null,
    verifiedHeadRecordDigest: null,
  };
}

function initialCaptureTemplate() {
  return {
    version: SOURCE_CAPTURE_RECORD_VERSION,
    policyVersion: SOURCE_CAPTURE_POLICY_VERSION,
    status: "capturing",
    runNonceDigest: randomBytes(32).toString("hex"),
    contractPinsDigest: releasePinsDigest(),
    priorCaptureRevisionSha1: null,
    decisionBoundaryAtMs: 0,
    createdAtMs: 0,
    updatedAtMs: 0,
    revision: 0,
    activeStep: {
      source: SOURCE_ORDER[0],
      passNumber: 1,
      pageNumber: 1,
      cursorToken: null,
    },
    headVerificationRound: 1,
    headVerificationIndex: 0,
    sources: SOURCE_ORDER.map(emptySource),
    freshnessLease: null,
    invalidReason: null,
  };
}

function canonicalPass(
  rawValue,
  expectedPassNumber,
  field,
  source,
) {
  const raw = object(rawValue, field);
  exactKeys(
    raw,
    [
      "passNumber",
      "status",
      "nextPageNumber",
      "nextCursorToken",
      "pageCount",
      "recordCount",
      "pageSemanticDigests",
      "sourceHeadEpochDigest",
      "sourceHeadRevisionDigest",
      "sourceHeadRecordDigest",
      "terminalCursorObserved",
      "semanticDigest",
    ],
    "SOURCE_CAPTURE_PASS_SHAPE_INVALID",
    field,
  );
  invariant(
    raw.passNumber === expectedPassNumber,
    "SOURCE_CAPTURE_PASS_ORDER_INVALID",
    `${field} has an invalid pass number`,
  );
  invariant(
    ["pending", "capturing", "complete"].includes(raw.status),
    "SOURCE_CAPTURE_PASS_STATUS_INVALID",
    `${field} has an invalid status`,
  );
  const nextPageNumber = positiveSafeInteger(
    raw.nextPageNumber,
    `${field}.nextPageNumber`,
  );
  const pageCount = nonNegativeSafeInteger(
    raw.pageCount,
    `${field}.pageCount`,
  );
  const recordCount = nonNegativeSafeInteger(
    raw.recordCount,
    `${field}.recordCount`,
  );
  invariant(
    Array.isArray(raw.pageSemanticDigests)
      && raw.pageSemanticDigests.length === pageCount,
    "SOURCE_CAPTURE_PAGE_CHECKPOINTS_INVALID",
    `${field} page checkpoints are incomplete`,
  );
  const pageSemanticDigests = raw.pageSemanticDigests.map(
    (value, index) => digest(
      value,
      `${field}.pageSemanticDigests[${index}]`,
    ),
  );
  invariant(
    typeof raw.terminalCursorObserved === "boolean",
    "SOURCE_CAPTURE_TERMINAL_CURSOR_INVALID",
    `${field}.terminalCursorObserved must be boolean`,
  );
  const sourceHeadEpochDigest = optionalDigest(
    raw.sourceHeadEpochDigest,
    `${field}.sourceHeadEpochDigest`,
  );
  const sourceHeadRevisionDigest = optionalDigest(
    raw.sourceHeadRevisionDigest,
    `${field}.sourceHeadRevisionDigest`,
  );
  const sourceHeadRecordDigest = optionalDigest(
    raw.sourceHeadRecordDigest,
    `${field}.sourceHeadRecordDigest`,
  );
  const semanticDigestValue = optionalDigest(
    raw.semanticDigest,
    `${field}.semanticDigest`,
  );
  const nextCursorToken = nullableCursor(
    raw.nextCursorToken,
    `${field}.nextCursorToken`,
  );
  if (raw.status === "pending") {
    invariant(
      pageCount === 0
        && recordCount === 0
        && nextPageNumber === 1
        && nextCursorToken === null
        && sourceHeadEpochDigest === null
        && sourceHeadRevisionDigest === null
        && sourceHeadRecordDigest === null
        && raw.terminalCursorObserved === false
        && semanticDigestValue === null,
      "SOURCE_CAPTURE_PENDING_PASS_DIRTY",
      `${field} has evidence before it started`,
    );
  }
  if (raw.status === "capturing") {
    invariant(
      pageCount > 0
        && nextPageNumber === pageCount + 1
        && nextCursorToken !== null
        && sourceHeadEpochDigest !== null
        && sourceHeadRevisionDigest !== null
        && sourceHeadRecordDigest !== null
        && raw.terminalCursorObserved === false
        && semanticDigestValue === null,
      "SOURCE_CAPTURE_ACTIVE_PASS_INVALID",
      `${field} active pass checkpoint is incomplete`,
    );
  }
  if (raw.status === "complete") {
    invariant(
      pageCount > 0
        && nextPageNumber === pageCount + 1
        && nextCursorToken === null
        && sourceHeadEpochDigest !== null
        && sourceHeadRevisionDigest !== null
        && sourceHeadRecordDigest !== null
        && raw.terminalCursorObserved === true
        && semanticDigestValue !== null,
      "SOURCE_CAPTURE_COMPLETE_PASS_INVALID",
      `${field} is not an exhaustive completed pass`,
    );
    invariant(
      semanticDigestValue === completedPassDigest(
        source,
        {
          pageSemanticDigests,
          pageCount,
          recordCount,
          sourceHeadEpochDigest,
          sourceHeadRevisionDigest,
          sourceHeadRecordDigest,
          terminalCursorObserved: raw.terminalCursorObserved,
        },
      ),
      "SOURCE_CAPTURE_PASS_DIGEST_INVALID",
      `${field} semantic digest does not match its pages`,
    );
  }
  return {
    passNumber: expectedPassNumber,
    status: raw.status,
    nextPageNumber,
    nextCursorToken,
    pageCount,
    recordCount,
    pageSemanticDigests,
    sourceHeadEpochDigest,
    sourceHeadRevisionDigest,
    sourceHeadRecordDigest,
    terminalCursorObserved: raw.terminalCursorObserved,
    semanticDigest: semanticDigestValue,
  };
}

function canonicalHeadCheck(rawValue, expectedRound, field) {
  const raw = object(rawValue, field);
  exactKeys(
    raw,
    [
      "round",
      "status",
      "sourceHeadEpochDigest",
      "sourceHeadRevisionDigest",
      "sourceHeadRecordDigest",
      "observedAtMs",
    ],
    "SOURCE_CAPTURE_HEAD_CHECK_SHAPE_INVALID",
    field,
  );
  invariant(
    raw.round === expectedRound,
    "SOURCE_CAPTURE_HEAD_ROUND_INVALID",
    `${field} has an invalid round`,
  );
  invariant(
    ["pending", "complete"].includes(raw.status),
    "SOURCE_CAPTURE_HEAD_CHECK_STATUS_INVALID",
    `${field} has an invalid status`,
  );
  const sourceHeadEpochDigest = optionalDigest(
    raw.sourceHeadEpochDigest,
    `${field}.sourceHeadEpochDigest`,
  );
  const sourceHeadRevisionDigest = optionalDigest(
    raw.sourceHeadRevisionDigest,
    `${field}.sourceHeadRevisionDigest`,
  );
  const sourceHeadRecordDigest = optionalDigest(
    raw.sourceHeadRecordDigest,
    `${field}.sourceHeadRecordDigest`,
  );
  const observedAtMs = raw.observedAtMs == null
    ? null
    : nonNegativeSafeInteger(
      raw.observedAtMs,
      `${field}.observedAtMs`,
    );
  invariant(
    raw.status === "pending"
      ? sourceHeadEpochDigest === null
        && sourceHeadRevisionDigest === null
        && sourceHeadRecordDigest === null
        && observedAtMs === null
      : sourceHeadEpochDigest !== null
        && sourceHeadRevisionDigest !== null
        && sourceHeadRecordDigest !== null
        && observedAtMs !== null,
    "SOURCE_CAPTURE_HEAD_CHECK_INCOMPLETE",
    `${field} is incomplete`,
  );
  return {
    round: expectedRound,
    status: raw.status,
    sourceHeadEpochDigest,
    sourceHeadRevisionDigest,
    sourceHeadRecordDigest,
    observedAtMs,
  };
}

function canonicalSource(rawValue, expectedSource, index) {
  const field = `sources[${index}]`;
  const raw = object(rawValue, field);
  exactKeys(
    raw,
    [
      "source",
      "status",
      "passes",
      "headChecks",
      "verifiedHeadEpochDigest",
      "verifiedHeadRevisionDigest",
      "verifiedHeadRecordDigest",
    ],
    "SOURCE_CAPTURE_SOURCE_SHAPE_INVALID",
    field,
  );
  invariant(
    raw.source === expectedSource,
    "SOURCE_CAPTURE_SOURCE_ORDER_INVALID",
    `${field} is not server-selected source order`,
  );
  invariant(
    ["pending", "capturing", "captured", "head_verified"]
      .includes(raw.status),
    "SOURCE_CAPTURE_SOURCE_STATUS_INVALID",
    `${field} has an invalid status`,
  );
  invariant(
    Array.isArray(raw.passes) && raw.passes.length === 2,
    "SOURCE_CAPTURE_PASS_COUNT_INVALID",
    `${field} must contain exactly two passes`,
  );
  const passes = raw.passes.map(
    (pass, passIndex) => canonicalPass(
      pass,
      passIndex + 1,
      `${field}.passes[${passIndex}]`,
      expectedSource,
    ),
  );
  invariant(
    Array.isArray(raw.headChecks)
      && raw.headChecks.length
        === SOURCE_CAPTURE_HEAD_VERIFICATION_ROUNDS,
    "SOURCE_CAPTURE_HEAD_ROUND_COUNT_INVALID",
    `${field} must contain exact head verification rounds`,
  );
  const headChecks = raw.headChecks.map(
    (check, checkIndex) => canonicalHeadCheck(
      check,
      checkIndex + 1,
      `${field}.headChecks[${checkIndex}]`,
    ),
  );
  if (headChecks[1].status === "complete") {
    invariant(
      headChecks[0].status === "complete",
      "SOURCE_CAPTURE_HEAD_ROUND_SEQUENCE_INVALID",
      `${field} head round two completed before round one`,
    );
  }
  invariant(
    headChecks.every((check) => (
      check.status !== "complete"
      || check.sourceHeadEpochDigest
        === passes[0].sourceHeadEpochDigest
        && check.sourceHeadRevisionDigest
          === passes[0].sourceHeadRevisionDigest
        && check.sourceHeadRecordDigest
          === passes[0].sourceHeadRecordDigest
    )),
    "SOURCE_CAPTURE_HEAD_CHECK_EPOCH_MISMATCH",
    `${field} head check does not match the captured epoch`,
  );
  if (passes[1].status !== "pending") {
    invariant(
      passes[0].status === "complete",
      "SOURCE_CAPTURE_PASS_SEQUENCE_INVALID",
      `${field} pass two started before pass one completed`,
    );
  }
  if (["captured", "head_verified"].includes(raw.status)) {
    invariant(
      passes.every((pass) => pass.status === "complete")
        && passes[0].semanticDigest
          === passes[1].semanticDigest
        && passes[0].sourceHeadEpochDigest
          === passes[1].sourceHeadEpochDigest
        && passes[0].sourceHeadRevisionDigest
          === passes[1].sourceHeadRevisionDigest
        && passes[0].sourceHeadRecordDigest
          === passes[1].sourceHeadRecordDigest,
      "SOURCE_CAPTURE_STABLE_PASSES_REQUIRED",
      `${field} does not have two identical stable passes`,
    );
  }
  const verifiedHeadEpochDigest = optionalDigest(
    raw.verifiedHeadEpochDigest,
    `${field}.verifiedHeadEpochDigest`,
  );
  const verifiedHeadRevisionDigest = optionalDigest(
    raw.verifiedHeadRevisionDigest,
    `${field}.verifiedHeadRevisionDigest`,
  );
  const verifiedHeadRecordDigest = optionalDigest(
    raw.verifiedHeadRecordDigest,
    `${field}.verifiedHeadRecordDigest`,
  );
  if (raw.status === "head_verified") {
    invariant(
      verifiedHeadEpochDigest
        === passes[0].sourceHeadEpochDigest
        && verifiedHeadRevisionDigest
          === passes[0].sourceHeadRevisionDigest
        && verifiedHeadRecordDigest
          === passes[0].sourceHeadRecordDigest
        && headChecks.every((check) => (
          check.status === "complete"
          && check.sourceHeadEpochDigest
            === verifiedHeadEpochDigest
          && check.sourceHeadRevisionDigest
            === verifiedHeadRevisionDigest
          && check.sourceHeadRecordDigest
            === verifiedHeadRecordDigest
        )),
      "SOURCE_CAPTURE_HEAD_VERIFICATION_INVALID",
      `${field} head verification does not match its capture`,
    );
  } else {
    invariant(
      verifiedHeadEpochDigest === null
        && verifiedHeadRevisionDigest === null
        && verifiedHeadRecordDigest === null,
      "SOURCE_CAPTURE_HEAD_VERIFICATION_EARLY",
      `${field} has a premature verified head`,
    );
  }
  return {
    source: expectedSource,
    status: raw.status,
    passes,
    headChecks,
    verifiedHeadEpochDigest,
    verifiedHeadRevisionDigest,
    verifiedHeadRecordDigest,
  };
}

function canonicalActiveStep(rawValue, field) {
  if (rawValue === null) return null;
  const raw = object(rawValue, field);
  exactKeys(
    raw,
    ["source", "passNumber", "pageNumber", "cursorToken"],
    "SOURCE_CAPTURE_ACTIVE_STEP_SHAPE_INVALID",
    field,
  );
  invariant(
    SOURCE_SET.has(raw.source),
    "SOURCE_CAPTURE_ACTIVE_SOURCE_INVALID",
    `${field}.source is invalid`,
  );
  invariant(
    [1, 2].includes(raw.passNumber),
    "SOURCE_CAPTURE_ACTIVE_PASS_INVALID",
    `${field}.passNumber is invalid`,
  );
  return {
    source: raw.source,
    passNumber: raw.passNumber,
    pageNumber: positiveSafeInteger(
      raw.pageNumber,
      `${field}.pageNumber`,
    ),
    cursorToken: nullableCursor(
      raw.cursorToken,
      `${field}.cursorToken`,
    ),
  };
}

function canonicalLease(rawValue, record) {
  if (rawValue === null) return null;
  const raw = object(rawValue, "freshnessLease");
  exactKeys(
    raw,
    [
      "version",
      "kind",
      "runNonceDigest",
      "decisionBoundaryAtMs",
      "sourceHeadEpochs",
      "sourceHeadRevisionDigests",
      "sourceHeadRecordDigests",
      "sourcePassDigests",
      "headVerificationRounds",
      "evidenceFreshSinceMs",
      "headVerifiedThroughMs",
      "issuedAtMs",
      "validUntilMs",
      "leaseDigest",
    ],
    "SOURCE_CAPTURE_LEASE_SHAPE_INVALID",
    "freshnessLease",
  );
  invariant(
    raw.version === SOURCE_CAPTURE_FRESHNESS_LEASE_VERSION
      && raw.kind === "source_capture_freshness_dark",
    "SOURCE_CAPTURE_LEASE_VERSION_INVALID",
    "freshness lease version is invalid",
  );
  exactKeys(
    raw.sourceHeadEpochs,
    SOURCE_ORDER,
    "SOURCE_CAPTURE_LEASE_EPOCH_SHAPE_INVALID",
    "freshnessLease.sourceHeadEpochs",
  );
  exactKeys(
    raw.sourceHeadRevisionDigests,
    SOURCE_ORDER,
    "SOURCE_CAPTURE_LEASE_REVISION_SHAPE_INVALID",
    "freshnessLease.sourceHeadRevisionDigests",
  );
  exactKeys(
    raw.sourceHeadRecordDigests,
    SOURCE_ORDER,
    "SOURCE_CAPTURE_LEASE_HEAD_RAW_SHAPE_INVALID",
    "freshnessLease.sourceHeadRecordDigests",
  );
  exactKeys(
    raw.sourcePassDigests,
    SOURCE_ORDER,
    "SOURCE_CAPTURE_LEASE_PASS_SHAPE_INVALID",
    "freshnessLease.sourcePassDigests",
  );
  const material = {
    version: SOURCE_CAPTURE_FRESHNESS_LEASE_VERSION,
    kind: "source_capture_freshness_dark",
    runNonceDigest: digest(
      raw.runNonceDigest,
      "freshnessLease.runNonceDigest",
    ),
    decisionBoundaryAtMs: nonNegativeSafeInteger(
      raw.decisionBoundaryAtMs,
      "freshnessLease.decisionBoundaryAtMs",
    ),
    sourceHeadEpochs: Object.fromEntries(
      SOURCE_ORDER.map((source) => [
        source,
        digest(
          raw.sourceHeadEpochs[source],
          `freshnessLease.sourceHeadEpochs.${source}`,
        ),
      ]),
    ),
    sourceHeadRevisionDigests: Object.fromEntries(
      SOURCE_ORDER.map((source) => [
        source,
        digest(
          raw.sourceHeadRevisionDigests[source],
          `freshnessLease.sourceHeadRevisionDigests.${source}`,
        ),
      ]),
    ),
    sourceHeadRecordDigests: Object.fromEntries(
      SOURCE_ORDER.map((source) => [
        source,
        digest(
          raw.sourceHeadRecordDigests[source],
          `freshnessLease.sourceHeadRecordDigests.${source}`,
        ),
      ]),
    ),
    sourcePassDigests: Object.fromEntries(
      SOURCE_ORDER.map((source) => [
        source,
        digest(
          raw.sourcePassDigests[source],
          `freshnessLease.sourcePassDigests.${source}`,
        ),
      ]),
    ),
    headVerificationRounds: positiveSafeInteger(
      raw.headVerificationRounds,
      "freshnessLease.headVerificationRounds",
    ),
    evidenceFreshSinceMs: nonNegativeSafeInteger(
      raw.evidenceFreshSinceMs,
      "freshnessLease.evidenceFreshSinceMs",
    ),
    headVerifiedThroughMs: nonNegativeSafeInteger(
      raw.headVerifiedThroughMs,
      "freshnessLease.headVerifiedThroughMs",
    ),
    issuedAtMs: nonNegativeSafeInteger(
      raw.issuedAtMs,
      "freshnessLease.issuedAtMs",
    ),
    validUntilMs: nonNegativeSafeInteger(
      raw.validUntilMs,
      "freshnessLease.validUntilMs",
    ),
  };
  invariant(
    material.runNonceDigest === record.runNonceDigest
      && material.decisionBoundaryAtMs
        === record.decisionBoundaryAtMs
      && material.headVerificationRounds
        === SOURCE_CAPTURE_HEAD_VERIFICATION_ROUNDS
      && material.evidenceFreshSinceMs
        >= record.decisionBoundaryAtMs
      && material.headVerifiedThroughMs
        >= material.evidenceFreshSinceMs
      && material.issuedAtMs
        === material.headVerifiedThroughMs
      && material.validUntilMs
        - material.evidenceFreshSinceMs
        === SOURCE_CAPTURE_FRESHNESS_LEASE_MS,
    "SOURCE_CAPTURE_LEASE_BINDING_INVALID",
    "freshness lease is not bound to the exact capture",
  );
  invariant(
    SOURCE_ORDER.every((source, index) => (
      material.sourceHeadEpochs[source]
        === record.sources[index].verifiedHeadEpochDigest
      && material.sourceHeadRevisionDigests[source]
        === record.sources[index].verifiedHeadRevisionDigest
      && material.sourceHeadRecordDigests[source]
        === record.sources[index].verifiedHeadRecordDigest
      && material.sourcePassDigests[source]
        === record.sources[index].passes[0].semanticDigest
    )),
    "SOURCE_CAPTURE_LEASE_EVIDENCE_MISMATCH",
    "freshness lease does not bind the captured evidence",
  );
  const headTimes = record.sources.flatMap(
    (source) => source.headChecks.map(
      (check) => check.observedAtMs,
    ),
  );
  invariant(
    headTimes.every(Number.isSafeInteger)
      && material.evidenceFreshSinceMs === Math.min(...headTimes)
      && material.headVerifiedThroughMs === Math.max(...headTimes)
      && material.issuedAtMs === record.updatedAtMs,
    "SOURCE_CAPTURE_LEASE_TIME_MISMATCH",
    "freshness lease time is not bound to its head checks",
  );
  const leaseDigest = digest(
    raw.leaseDigest,
    "freshnessLease.leaseDigest",
  );
  invariant(
    leaseDigest === semanticDigest(
      "phase4-source-capture-freshness-lease-v1",
      material,
    ),
    "SOURCE_CAPTURE_LEASE_DIGEST_INVALID",
    "freshness lease digest does not match its material",
  );
  return { ...material, leaseDigest };
}

export function validateDarkSourceCaptureRecord(value) {
  const raw = object(value, "source capture record");
  exactKeys(
    raw,
    [
      "version",
      "policyVersion",
      "status",
      "runNonceDigest",
      "contractPinsDigest",
      "priorCaptureRevisionSha1",
      "decisionBoundaryAtMs",
      "createdAtMs",
      "updatedAtMs",
      "revision",
      "activeStep",
      "headVerificationRound",
      "headVerificationIndex",
      "sources",
      "freshnessLease",
      "invalidReason",
    ],
    "SOURCE_CAPTURE_RECORD_SHAPE_INVALID",
    "source capture record",
  );
  invariant(
    raw.version === SOURCE_CAPTURE_RECORD_VERSION
      && raw.policyVersion === SOURCE_CAPTURE_POLICY_VERSION,
    "SOURCE_CAPTURE_RECORD_VERSION_INVALID",
    "source capture record version is invalid",
  );
  invariant(
    [
      "capturing",
      "verifying_heads",
      "leased_dark",
      "invalidated",
    ].includes(raw.status),
    "SOURCE_CAPTURE_STATUS_INVALID",
    "source capture status is invalid",
  );
  const record = {
    version: SOURCE_CAPTURE_RECORD_VERSION,
    policyVersion: SOURCE_CAPTURE_POLICY_VERSION,
    status: raw.status,
    runNonceDigest: digest(
      raw.runNonceDigest,
      "source capture runNonceDigest",
    ),
    contractPinsDigest: digest(
      raw.contractPinsDigest,
      "source capture contractPinsDigest",
    ),
    priorCaptureRevisionSha1: optionalSha1(
      raw.priorCaptureRevisionSha1,
      "source capture priorCaptureRevisionSha1",
    ),
    decisionBoundaryAtMs: nonNegativeSafeInteger(
      raw.decisionBoundaryAtMs,
      "source capture decisionBoundaryAtMs",
    ),
    createdAtMs: nonNegativeSafeInteger(
      raw.createdAtMs,
      "source capture createdAtMs",
    ),
    updatedAtMs: nonNegativeSafeInteger(
      raw.updatedAtMs,
      "source capture updatedAtMs",
    ),
    revision: nonNegativeSafeInteger(
      raw.revision,
      "source capture revision",
    ),
    activeStep: canonicalActiveStep(
      raw.activeStep,
      "source capture activeStep",
    ),
    headVerificationRound: positiveSafeInteger(
      raw.headVerificationRound,
      "source capture headVerificationRound",
    ),
    headVerificationIndex: nonNegativeSafeInteger(
      raw.headVerificationIndex,
      "source capture headVerificationIndex",
    ),
    sources: null,
    freshnessLease: null,
    invalidReason: raw.invalidReason,
  };
  invariant(
    record.contractPinsDigest === releasePinsDigest(),
    "SOURCE_CAPTURE_RELEASE_PINS_CHANGED",
    "source capture was planned for different release pins",
  );
  invariant(
    record.createdAtMs === record.decisionBoundaryAtMs
      && record.updatedAtMs >= record.createdAtMs,
    "SOURCE_CAPTURE_REDIS_TIME_INVALID",
    "source capture timestamps are inconsistent",
  );
  invariant(
    Array.isArray(raw.sources)
      && raw.sources.length === SOURCE_ORDER.length,
    "SOURCE_CAPTURE_SOURCE_COUNT_INVALID",
    "source capture must contain the exact source set",
  );
  record.sources = raw.sources.map(
    (source, index) => canonicalSource(
      source,
      SOURCE_ORDER[index],
      index,
    ),
  );
  const completedHeadChecks = [];
  for (
    let roundIndex = 0;
    roundIndex < SOURCE_CAPTURE_HEAD_VERIFICATION_ROUNDS;
    roundIndex += 1
  ) {
    for (const source of record.sources) {
      const check = source.headChecks[roundIndex];
      if (check.status === "complete") {
        completedHeadChecks.push(check);
      }
    }
  }
  invariant(
    completedHeadChecks.every((check, index) => (
      check.observedAtMs >= record.decisionBoundaryAtMs
      && check.observedAtMs <= record.updatedAtMs
      && (
        index === 0
        || check.observedAtMs
          >= completedHeadChecks[index - 1].observedAtMs
      )
    )),
    "SOURCE_CAPTURE_HEAD_CHECK_TIME_INVALID",
    "source head check timestamps are invalid",
  );
  if (completedHeadChecks.length > 1) {
    invariant(
      completedHeadChecks.at(-1).observedAtMs
        - completedHeadChecks[0].observedAtMs
        <= SOURCE_CAPTURE_HEAD_VERIFICATION_MAX_SPAN_MS,
      "SOURCE_CAPTURE_HEAD_CHECK_SPAN_INVALID",
      "source head verification exceeded its maximum span",
    );
  }
  invariant(
    record.headVerificationRound
      <= SOURCE_CAPTURE_HEAD_VERIFICATION_ROUNDS,
    "SOURCE_CAPTURE_HEAD_ROUND_INVALID",
    "source capture head verification round is invalid",
  );
  invariant(
    record.headVerificationIndex <= SOURCE_ORDER.length,
    "SOURCE_CAPTURE_HEAD_INDEX_INVALID",
    "source capture head verification index is invalid",
  );
  if (raw.status === "capturing") {
    invariant(
      record.activeStep !== null
        && record.headVerificationRound === 1
        && record.headVerificationIndex === 0,
      "SOURCE_CAPTURE_ACTIVE_STEP_REQUIRED",
      "capturing requires exactly one active step",
    );
    const sourceIndex = SOURCE_ORDER.indexOf(
      record.activeStep.source,
    );
    const source = record.sources[sourceIndex];
    const pass = source.passes[
      record.activeStep.passNumber - 1
    ];
    invariant(
      record.sources.slice(0, sourceIndex).every(
        (item) => item.status === "captured",
      )
        && record.sources.slice(sourceIndex + 1).every(
          (item) => item.status === "pending",
        )
        && ["pending", "capturing"].includes(source.status)
        && ["pending", "capturing"].includes(pass.status)
        && record.activeStep.pageNumber === pass.nextPageNumber
        && record.activeStep.cursorToken === pass.nextCursorToken,
      "SOURCE_CAPTURE_ACTIVE_STEP_INCONSISTENT",
      "active step does not match the durable checkpoint",
    );
  } else {
    invariant(
      record.activeStep === null,
      "SOURCE_CAPTURE_TERMINAL_ACTIVE_STEP",
      "non-capturing state cannot have an active page step",
    );
  }
  if (raw.status === "verifying_heads") {
    const completedRounds =
      record.headVerificationRound - 1;
    invariant(
      record.sources.every((source) => (
        ["captured", "head_verified"].includes(source.status)
      ))
        && record.sources.every((source, sourceIndex) => (
          source.headChecks.every((check, checkIndex) => (
            checkIndex < completedRounds
              ? check.status === "complete"
              : checkIndex > completedRounds
                ? check.status === "pending"
                : sourceIndex < record.headVerificationIndex
                  ? check.status === "complete"
                  : check.status === "pending"
          ))
        ))
        && record.sources.every((source) => (
          record.headVerificationRound
            < SOURCE_CAPTURE_HEAD_VERIFICATION_ROUNDS
            || source.status === "captured"
            || source.headChecks[
              SOURCE_CAPTURE_HEAD_VERIFICATION_ROUNDS - 1
            ].status === "complete"
        )),
      "SOURCE_CAPTURE_HEAD_SEQUENCE_INVALID",
      "source heads are not verified in server-selected order",
    );
  }
  if (raw.status === "leased_dark") {
    invariant(
      record.headVerificationIndex === SOURCE_ORDER.length
        && record.headVerificationRound
          === SOURCE_CAPTURE_HEAD_VERIFICATION_ROUNDS
        && record.sources.every(
          (source) => source.status === "head_verified",
        ),
      "SOURCE_CAPTURE_LEASE_WITHOUT_HEADS",
      "freshness lease requires every exact source head",
    );
  }
  invariant(
    raw.invalidReason === null
      || (
        typeof raw.invalidReason === "string"
        && /^[a-z0-9_]{1,80}$/u.test(raw.invalidReason)
      ),
    "SOURCE_CAPTURE_INVALID_REASON_MALFORMED",
    "source capture invalid reason is malformed",
  );
  invariant(
    raw.status === "invalidated"
      ? raw.invalidReason !== null
      : raw.invalidReason === null,
    "SOURCE_CAPTURE_INVALID_REASON_INCONSISTENT",
    "source capture invalid reason is inconsistent",
  );
  record.freshnessLease = canonicalLease(
    raw.freshnessLease,
    record,
  );
  invariant(
    raw.status === "leased_dark"
      ? record.freshnessLease !== null
      : record.freshnessLease === null,
    "SOURCE_CAPTURE_LEASE_STATUS_INVALID",
    "freshness lease is inconsistent with capture status",
  );
  return deepFreeze(record);
}

function eventObject(event, keys, kind) {
  const raw = object(event, "trusted source capture event");
  exactKeys(
    raw,
    keys,
    "SOURCE_CAPTURE_EVENT_SHAPE_INVALID",
    "trusted source capture event",
  );
  invariant(
    raw.kind === kind,
    "SOURCE_CAPTURE_EVENT_KIND_INVALID",
    "trusted source capture event kind is invalid",
  );
  return raw;
}

function invalidated(record, reason, redisNowMs) {
  const next = clone(record);
  next.status = "invalidated";
  next.activeStep = null;
  next.freshnessLease = null;
  next.invalidReason = reason;
  next.updatedAtMs = redisNowMs;
  next.revision += 1;
  return validateDarkSourceCaptureRecord(next);
}

function completedPassDigest(source, pass) {
  return semanticDigest(
    "phase4-source-capture-stable-pass-v1",
    {
      source,
      pageSemanticDigests: pass.pageSemanticDigests,
      pageCount: pass.pageCount,
      recordCount: pass.recordCount,
      sourceHeadEpochDigest: pass.sourceHeadEpochDigest,
      sourceHeadRevisionDigest:
        pass.sourceHeadRevisionDigest,
      sourceHeadRecordDigest: pass.sourceHeadRecordDigest,
      terminalCursorObserved: pass.terminalCursorObserved,
    },
  );
}

function transitionPage(record, event, redisNowMs) {
  const raw = eventObject(
    event,
    [
      "kind",
      "claimNonceDigest",
      "source",
      "passNumber",
      "pageNumber",
      "cursorToken",
      "nextCursorToken",
      "pageSemanticDigest",
      "recordCount",
      "sourceHeadEpochDigest",
      "sourceHeadRevisionDigest",
      "sourceHeadRecordDigest",
    ],
    "page_checkpoint",
  );
  digest(
    raw.claimNonceDigest,
    "trusted source capture event.claimNonceDigest",
  );
  invariant(
    record.status === "capturing" && record.activeStep,
    "SOURCE_CAPTURE_PAGE_NOT_EXPECTED",
    "capture is not waiting for a page",
  );
  const step = record.activeStep;
  invariant(
    raw.source === step.source
      && raw.passNumber === step.passNumber
      && raw.pageNumber === step.pageNumber
      && raw.cursorToken === step.cursorToken,
    "SOURCE_CAPTURE_SERVER_SELECTION_MISMATCH",
    "page does not match the server-selected checkpoint",
  );
  const nextCursorToken = nullableCursor(
    raw.nextCursorToken,
    "trusted source capture event.nextCursorToken",
  );
  const pageSemanticDigest = digest(
    raw.pageSemanticDigest,
    "trusted source capture event.pageSemanticDigest",
  );
  const recordCount = nonNegativeSafeInteger(
    raw.recordCount,
    "trusted source capture event.recordCount",
  );
  const sourceHeadEpochDigest = digest(
    raw.sourceHeadEpochDigest,
    "trusted source capture event.sourceHeadEpochDigest",
  );
  const sourceHeadRevisionDigest = digest(
    raw.sourceHeadRevisionDigest,
    "trusted source capture event.sourceHeadRevisionDigest",
  );
  const sourceHeadRecordDigest = digest(
    raw.sourceHeadRecordDigest,
    "trusted source capture event.sourceHeadRecordDigest",
  );
  const next = clone(record);
  const sourceIndex = SOURCE_ORDER.indexOf(step.source);
  const source = next.sources[sourceIndex];
  const pass = source.passes[step.passNumber - 1];
  source.status = "capturing";
  pass.status = "capturing";
  if (
    pass.sourceHeadEpochDigest
    && (
      pass.sourceHeadEpochDigest !== sourceHeadEpochDigest
      || pass.sourceHeadRevisionDigest
        !== sourceHeadRevisionDigest
      || pass.sourceHeadRecordDigest !== sourceHeadRecordDigest
    )
  ) {
    return invalidated(
      record,
      "source_head_changed_within_pass",
      redisNowMs,
    );
  }
  if (
    step.passNumber === 2
    && (
      source.passes[0].sourceHeadEpochDigest
        !== sourceHeadEpochDigest
      || source.passes[0].sourceHeadRevisionDigest
        !== sourceHeadRevisionDigest
      || source.passes[0].sourceHeadRecordDigest
        !== sourceHeadRecordDigest
    )
  ) {
    return invalidated(
      record,
      "source_head_changed_between_passes",
      redisNowMs,
    );
  }
  pass.sourceHeadEpochDigest = sourceHeadEpochDigest;
  pass.sourceHeadRevisionDigest = sourceHeadRevisionDigest;
  pass.sourceHeadRecordDigest = sourceHeadRecordDigest;
  pass.pageSemanticDigests.push(pageSemanticDigest);
  pass.pageCount += 1;
  pass.recordCount += recordCount;
  pass.nextPageNumber += 1;
  pass.nextCursorToken = nextCursorToken;
  next.updatedAtMs = redisNowMs;
  next.revision += 1;
  if (nextCursorToken !== null) {
    next.activeStep = {
      source: step.source,
      passNumber: step.passNumber,
      pageNumber: pass.nextPageNumber,
      cursorToken: nextCursorToken,
    };
    return validateDarkSourceCaptureRecord(next);
  }
  pass.status = "complete";
  pass.terminalCursorObserved = true;
  pass.semanticDigest = completedPassDigest(
    step.source,
    pass,
  );
  if (step.passNumber === 1) {
    next.activeStep = {
      source: step.source,
      passNumber: 2,
      pageNumber: 1,
      cursorToken: null,
    };
    return validateDarkSourceCaptureRecord(next);
  }
  if (
    source.passes[0].semanticDigest !== pass.semanticDigest
  ) {
    return invalidated(
      record,
      "sequential_pass_digest_mismatch",
      redisNowMs,
    );
  }
  source.status = "captured";
  const nextSource = SOURCE_ORDER[sourceIndex + 1];
  if (nextSource) {
    next.activeStep = {
      source: nextSource,
      passNumber: 1,
      pageNumber: 1,
      cursorToken: null,
    };
    return validateDarkSourceCaptureRecord(next);
  }
  next.status = "verifying_heads";
  next.activeStep = null;
  next.headVerificationIndex = 0;
  return validateDarkSourceCaptureRecord(next);
}

function transitionHead(record, event, redisNowMs) {
  const raw = eventObject(
    event,
    [
      "kind",
      "claimNonceDigest",
      "source",
      "sourceHeadEpochDigest",
      "sourceHeadRevisionDigest",
      "sourceHeadRecordDigest",
    ],
    "head_checkpoint",
  );
  digest(
    raw.claimNonceDigest,
    "trusted source capture event.claimNonceDigest",
  );
  invariant(
    record.status === "verifying_heads",
    "SOURCE_CAPTURE_HEAD_NOT_EXPECTED",
    "capture is not waiting for head verification",
  );
  const expectedSource =
    SOURCE_ORDER[record.headVerificationIndex];
  invariant(
    raw.source === expectedSource,
    "SOURCE_CAPTURE_HEAD_SELECTION_MISMATCH",
    "head does not match the server-selected source",
  );
  const head = digest(
    raw.sourceHeadEpochDigest,
    "trusted source capture event.sourceHeadEpochDigest",
  );
  const headRevision = digest(
    raw.sourceHeadRevisionDigest,
    "trusted source capture event.sourceHeadRevisionDigest",
  );
  const headRecordDigest = digest(
    raw.sourceHeadRecordDigest,
    "trusted source capture event.sourceHeadRecordDigest",
  );
  const source = record.sources[
    record.headVerificationIndex
  ];
  if (
    source.passes[0].sourceHeadEpochDigest !== head
    || source.passes[0].sourceHeadRevisionDigest
      !== headRevision
    || source.passes[0].sourceHeadRecordDigest
      !== headRecordDigest
  ) {
    return invalidated(
      record,
      "source_head_changed_after_capture",
      redisNowMs,
    );
  }
  if (
    record.headVerificationRound > 1
    && (
      source.headChecks[0].sourceHeadEpochDigest !== head
      || source.headChecks[0].sourceHeadRevisionDigest
        !== headRevision
      || source.headChecks[0].sourceHeadRecordDigest
        !== headRecordDigest
    )
  ) {
    return invalidated(
      record,
      "source_head_changed_between_verification_rounds",
      redisNowMs,
    );
  }
  const firstObservedAtMs =
    record.sources[0].headChecks[0].observedAtMs;
  if (
    firstObservedAtMs != null
    && redisNowMs - firstObservedAtMs
      > SOURCE_CAPTURE_HEAD_VERIFICATION_MAX_SPAN_MS
  ) {
    return invalidated(
      record,
      "head_verification_window_exceeded",
      redisNowMs,
    );
  }
  const next = clone(record);
  const nextSource = next.sources[next.headVerificationIndex];
  nextSource.headChecks[
    next.headVerificationRound - 1
  ] = {
    round: next.headVerificationRound,
    status: "complete",
    sourceHeadEpochDigest: head,
    sourceHeadRevisionDigest: headRevision,
    sourceHeadRecordDigest: headRecordDigest,
    observedAtMs: redisNowMs,
  };
  if (
    next.headVerificationRound
      === SOURCE_CAPTURE_HEAD_VERIFICATION_ROUNDS
  ) {
    nextSource.status = "head_verified";
    nextSource.verifiedHeadEpochDigest = head;
    nextSource.verifiedHeadRevisionDigest = headRevision;
    nextSource.verifiedHeadRecordDigest = headRecordDigest;
  }
  next.headVerificationIndex += 1;
  next.updatedAtMs = redisNowMs;
  next.revision += 1;
  if (next.headVerificationIndex < SOURCE_ORDER.length) {
    return validateDarkSourceCaptureRecord(next);
  }
  if (
    next.headVerificationRound
      < SOURCE_CAPTURE_HEAD_VERIFICATION_ROUNDS
  ) {
    next.headVerificationRound += 1;
    next.headVerificationIndex = 0;
    return validateDarkSourceCaptureRecord(next);
  }
  const headTimes = next.sources.flatMap(
    (item) => item.headChecks.map(
      (check) => check.observedAtMs,
    ),
  );
  const evidenceFreshSinceMs = Math.min(...headTimes);
  const headVerifiedThroughMs = Math.max(...headTimes);
  const material = {
    version: SOURCE_CAPTURE_FRESHNESS_LEASE_VERSION,
    kind: "source_capture_freshness_dark",
    runNonceDigest: next.runNonceDigest,
    decisionBoundaryAtMs: next.decisionBoundaryAtMs,
    sourceHeadEpochs: Object.fromEntries(
      next.sources.map((item) => [
        item.source,
        item.verifiedHeadEpochDigest,
      ]),
    ),
    sourceHeadRevisionDigests: Object.fromEntries(
      next.sources.map((item) => [
        item.source,
        item.verifiedHeadRevisionDigest,
      ]),
    ),
    sourceHeadRecordDigests: Object.fromEntries(
      next.sources.map((item) => [
        item.source,
        item.verifiedHeadRecordDigest,
      ]),
    ),
    sourcePassDigests: Object.fromEntries(
      next.sources.map((item) => [
        item.source,
        item.passes[0].semanticDigest,
      ]),
    ),
    headVerificationRounds:
      SOURCE_CAPTURE_HEAD_VERIFICATION_ROUNDS,
    evidenceFreshSinceMs,
    headVerifiedThroughMs,
    issuedAtMs: headVerifiedThroughMs,
    validUntilMs:
      evidenceFreshSinceMs
      + SOURCE_CAPTURE_FRESHNESS_LEASE_MS,
  };
  next.status = "leased_dark";
  next.freshnessLease = {
    ...material,
    leaseDigest: semanticDigest(
      "phase4-source-capture-freshness-lease-v1",
      material,
    ),
  };
  return validateDarkSourceCaptureRecord(next);
}

// This reducer is deliberately non-authoritative. It lets a future private
// adapter checkpoint exact results, but its output is never consumed by the
// source-authority store and cannot authorize curation or enrollment.
export function transitionDarkSourceCaptureRecord(
  recordValue,
  event,
  redisNowMs,
) {
  const record = validateDarkSourceCaptureRecord(recordValue);
  const nowMs = nonNegativeSafeInteger(
    redisNowMs,
    "trusted transition Redis time",
  );
  invariant(
    nowMs >= record.updatedAtMs,
    "SOURCE_CAPTURE_REDIS_TIME_REGRESSION",
    "trusted transition Redis time regressed",
  );
  if (event?.kind === "page_checkpoint") {
    return transitionPage(record, event, nowMs);
  }
  if (event?.kind === "head_checkpoint") {
    return transitionHead(record, event, nowMs);
  }
  fail(
    "SOURCE_CAPTURE_EVENT_KIND_INVALID",
    "trusted source capture event kind is unsupported",
  );
}

function kvConfiguration() {
  return {
    url: String(
      process.env.PARAAI_SOURCE_AUTHORITY_KV_REST_API_URL
      || process.env.KV_REST_API_URL
      || "",
    ).replace(/\/+$/u, ""),
    token:
      process.env.PARAAI_SOURCE_AUTHORITY_KV_REST_API_TOKEN
      || process.env.KV_REST_API_TOKEN
      || "",
  };
}

export function sourceCaptureStoreConfigured() {
  const { url, token } = kvConfiguration();
  return Boolean(url && token);
}

async function kv(command) {
  const { url, token } = kvConfiguration();
  invariant(
    url && token,
    "SOURCE_CAPTURE_STORE_UNAVAILABLE",
    "source capture KV is unavailable",
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8_000),
  });
  let body = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  invariant(
    response.ok && !body?.error,
    "SOURCE_CAPTURE_STORE_REQUEST_FAILED",
    "source capture KV request failed",
  );
  return body?.result ?? null;
}

function redisTime(result, offset, field) {
  invariant(
    Array.isArray(result)
      && /^\d+$/u.test(String(result[offset] || ""))
      && /^\d+$/u.test(String(result[offset + 1] || "")),
    "SOURCE_CAPTURE_REDIS_TIME_INVALID",
    `${field} did not return Redis TIME`,
  );
  const nowMs =
    Number(result[offset]) * 1_000
    + Math.floor(Number(result[offset + 1]) / 1_000);
  invariant(
    Number.isSafeInteger(nowMs) && nowMs >= 0,
    "SOURCE_CAPTURE_REDIS_TIME_INVALID",
    `${field} returned invalid Redis TIME`,
  );
  return nowMs;
}

const ENSURE_CAPTURE_LUA = `
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local templateOk, proposed = pcall(cjson.decode, ARGV[1])
  if not templateOk or type(proposed) ~= 'table'
    or type(proposed.version) ~= 'number'
    or type(proposed.policyVersion) ~= 'string'
    or type(proposed.contractPinsDigest) ~= 'string' then
    return {-9, '', redisTime[1], redisTime[2]}
  end
  local currentRaw = redis.call('GET', KEYS[1])
  local rotate = false
  if currentRaw then
    local ok, current = pcall(cjson.decode, currentRaw)
    if not ok or type(current) ~= 'table'
      or type(current.version) ~= 'number'
      or type(current.policyVersion) ~= 'string'
      or type(current.contractPinsDigest) ~= 'string'
      or type(current.status) ~= 'string' then
      return {-8, currentRaw, redisTime[1], redisTime[2]}
    end
    if current.version ~= proposed.version
      or current.policyVersion ~= proposed.policyVersion
      or current.contractPinsDigest
        ~= proposed.contractPinsDigest then
      rotate = true
    elseif current.status == 'leased_dark'
      and type(current.freshnessLease) == 'table'
      and tonumber(current.freshnessLease.validUntilMs) < nowMs then
      rotate = true
    elseif current.status == 'invalidated' then
      rotate = true
    else
      return {0, currentRaw, redisTime[1], redisTime[2]}
    end
  end
  local priorRaw = currentRaw or redis.call('GET', KEYS[2])
  if currentRaw and rotate then
    redis.call('SET', KEYS[2], currentRaw)
  end
  proposed.decisionBoundaryAtMs = nowMs
  proposed.createdAtMs = nowMs
  proposed.updatedAtMs = nowMs
  if priorRaw then
    proposed.priorCaptureRevisionSha1 =
      redis.sha1hex(priorRaw)
  else
    proposed.priorCaptureRevisionSha1 = cjson.null
  end
  local encoded = cjson.encode(proposed)
  redis.call('SET', KEYS[1], encoded)
  return {1, encoded, redisTime[1], redisTime[2]}
`;

const READ_CAPTURE_LUA = `
  local redisTime = redis.call('TIME')
  return {
    redis.call('GET', KEYS[1]) or '',
    redisTime[1],
    redisTime[2]
  }
`;

const CAS_CAPTURE_LUA = `
  local redisTime = redis.call('TIME')
  local currentRaw = redis.call('GET', KEYS[1])
  if not currentRaw then
    return {-4, '', redisTime[1], redisTime[2]}
  end
  if currentRaw ~= ARGV[1] then
    return {-3, currentRaw, redisTime[1], redisTime[2]}
  end
  local nextOk, next = pcall(cjson.decode, ARGV[2])
  if not nextOk or type(next) ~= 'table' then
    return {-9, currentRaw, redisTime[1], redisTime[2]}
  end
  if next.runNonceDigest == nil
    or next.runNonceDigest ~= ARGV[3]
    or next.decisionBoundaryAtMs ~= tonumber(ARGV[4])
    or next.contractPinsDigest ~= ARGV[5]
    or next.revision ~= tonumber(ARGV[7]) then
    return {-7, currentRaw, redisTime[1], redisTime[2]}
  end
  local priorMatches = (
    ARGV[6] == ''
    and next.priorCaptureRevisionSha1 == cjson.null
  ) or (
    ARGV[6] ~= ''
    and next.priorCaptureRevisionSha1 == ARGV[6]
  )
  if not priorMatches then
    return {-7, currentRaw, redisTime[1], redisTime[2]}
  end
  local encoded = cjson.encode(next)
  redis.call('SET', KEYS[1], encoded)
  if next.status == 'leased_dark' then
    redis.call('SET', KEYS[2], encoded)
  end
  return {1, encoded, redisTime[1], redisTime[2]}
`;

function parsedSnapshot(raw, nowMs, field) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(
      "SOURCE_CAPTURE_DURABLE_STATE_MALFORMED",
      `${field} is malformed`,
    );
  }
  const record = validateDarkSourceCaptureRecord(value);
  invariant(
    record.updatedAtMs <= nowMs + REDIS_CLOCK_SKEW_MS,
    "SOURCE_CAPTURE_DURABLE_STATE_MALFORMED",
    `${field} is from the future`,
  );
  return deepFreeze({
    record,
    raw,
    rawSha1: createHash("sha1").update(raw).digest("hex"),
    redisNowMs: nowMs,
  });
}

export async function ensureDarkSourceCaptureRun() {
  const result = await kv([
    "EVAL",
    ENSURE_CAPTURE_LUA,
    2,
    CURRENT_CAPTURE_KEY,
    CAPTURE_HEAD_KEY,
    JSON.stringify(initialCaptureTemplate()),
  ]);
  invariant(
    Array.isArray(result),
    "SOURCE_CAPTURE_DURABLE_STATE_MALFORMED",
    "source capture ensure returned an invalid result",
  );
  invariant(
    [0, 1].includes(Number(result[0])),
    "SOURCE_CAPTURE_DURABLE_STATE_MALFORMED",
    "source capture ensure rejected durable state",
  );
  const nowMs = redisTime(result, 2, "source capture ensure");
  return parsedSnapshot(
    result[1],
    nowMs,
    "current source capture",
  );
}

export async function readDarkSourceCaptureRun() {
  const result = await kv([
    "EVAL",
    READ_CAPTURE_LUA,
    1,
    CURRENT_CAPTURE_KEY,
  ]);
  invariant(
    Array.isArray(result),
    "SOURCE_CAPTURE_DURABLE_STATE_MALFORMED",
    "source capture read returned an invalid result",
  );
  const nowMs = redisTime(result, 1, "source capture read");
  if (!result[0]) {
    return deepFreeze({
      record: null,
      raw: null,
      rawSha1: null,
      redisNowMs: nowMs,
    });
  }
  return parsedSnapshot(
    result[0],
    nowMs,
    "current source capture",
  );
}

// A future private adapter claims the exact current raw record before making
// one source call. Claims are process-local, one-shot capabilities. A crash
// loses only the claim; the durable cursor remains available to a new claim.
export async function claimDarkSourceCaptureStep() {
  const current = await readDarkSourceCaptureRun();
  invariant(
    current.record && current.raw,
    "SOURCE_CAPTURE_NOT_PLANNED",
    "no server-selected source capture exists",
  );
  invariant(
    ["capturing", "verifying_heads"].includes(
      current.record.status,
    ),
    "SOURCE_CAPTURE_STEP_NOT_AVAILABLE",
    "source capture has no claimable step",
  );
  const claim = deepFreeze({
    record: current.record,
    raw: current.raw,
    claimNonceDigest: randomBytes(32).toString("hex"),
  });
  ISSUED_CAPTURE_CLAIMS.add(claim);
  return claim;
}

// Private adapter checkpoint. The current coordinator never calls this
// because its exact source/identity interfaces are deliberately unpinned.
// The event is accepted only with the exact one-shot claim issued before the
// source call; stale events cannot cross a run, boundary, or raw checkpoint.
export async function checkpointTrustedSourceCaptureEvent(
  claim,
  event,
) {
  invariant(
    claim
      && typeof claim === "object"
      && ISSUED_CAPTURE_CLAIMS.has(claim),
    "SOURCE_CAPTURE_CLAIM_INVALID",
    "source capture checkpoint requires its exact issued claim",
  );
  ISSUED_CAPTURE_CLAIMS.delete(claim);
  invariant(
    event?.claimNonceDigest === claim.claimNonceDigest,
    "SOURCE_CAPTURE_CLAIM_EVENT_MISMATCH",
    "source capture result is not bound to its pre-call claim",
  );
  const current = await readDarkSourceCaptureRun();
  invariant(
    current.record
      && current.raw
      && current.raw === claim.raw,
    "SOURCE_CAPTURE_CHECKPOINT_CONFLICT",
    "source capture changed after its source-step claim",
  );
  const next = transitionDarkSourceCaptureRecord(
    current.record,
    event,
    current.redisNowMs,
  );
  const result = await kv([
    "EVAL",
    CAS_CAPTURE_LUA,
    2,
    CURRENT_CAPTURE_KEY,
    CAPTURE_HEAD_KEY,
    current.raw,
    JSON.stringify(next),
    current.record.runNonceDigest,
    String(current.record.decisionBoundaryAtMs),
    current.record.contractPinsDigest,
    current.record.priorCaptureRevisionSha1 || "",
    String(current.record.revision + 1),
  ]);
  invariant(
    Array.isArray(result),
    "SOURCE_CAPTURE_DURABLE_STATE_MALFORMED",
    "source capture checkpoint returned an invalid result",
  );
  if (Number(result[0]) === -3) {
    fail(
      "SOURCE_CAPTURE_CHECKPOINT_CONFLICT",
      "source capture changed before checkpoint commit",
    );
  }
  invariant(
    Number(result[0]) === 1,
    "SOURCE_CAPTURE_DURABLE_STATE_MALFORMED",
    "source capture checkpoint was rejected",
  );
  const nowMs = redisTime(
    result,
    2,
    "source capture checkpoint",
  );
  return parsedSnapshot(
    result[1],
    nowMs,
    "checkpointed source capture",
  );
}

export function sourceCaptureAggregateStatus(
  snapshotValue = null,
) {
  const snapshot = snapshotValue
    ? object(snapshotValue, "source capture snapshot")
    : null;
  const record = snapshot?.record
    ? validateDarkSourceCaptureRecord(snapshot.record)
    : null;
  const nowMs = snapshot?.redisNowMs == null
    ? null
    : nonNegativeSafeInteger(
      snapshot.redisNowMs,
      "source capture snapshot Redis time",
    );
  const completedPasses = record
    ? record.sources.flatMap((source) => source.passes)
      .filter((pass) => pass.status === "complete").length
    : 0;
  const completedSources = record
    ? record.sources.filter(
      (source) => ["captured", "head_verified"]
        .includes(source.status),
    ).length
    : 0;
  const verifiedHeads = record
    ? record.sources.filter(
      (source) => source.status === "head_verified",
    ).length
    : 0;
  const freshnessLeaseCurrent = Boolean(
    record?.status === "leased_dark"
      && nowMs != null
      && record.freshnessLease.issuedAtMs <= nowMs
      && record.freshnessLease.validUntilMs >= nowMs,
  );
  const status = !record
    ? "not_planned"
    : record.status === "leased_dark" && !freshnessLeaseCurrent
      ? "freshness_expired"
      : record.status;
  return deepFreeze({
    status,
    operational: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
    serverSelected: true,
    commonRedisBoundary: Boolean(record),
    requiredSources: SOURCE_ORDER.length,
    requiredPassesPerSource: 2,
    completedSources,
    completedPasses,
    verifiedHeads,
    freshnessLeaseCurrent,
  });
}
