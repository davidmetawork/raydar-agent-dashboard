// Private, hard-dark Recall point-observation store.
//
// This is a logically distinct store that shares only the future dedicated
// Recall-reference Redis topology. It uses a disjoint key namespace and does
// not extend the sealed reference adapter's exact six-method interface.
//
// The minimum slice implemented here prepares one deterministic work item from
// the first reference of one fully verified pass-two page. It then owns two
// durable point-read claims, distinct replay reservations, exact checkpoints,
// and terminal settlement. It deliberately does not claim full reference-set
// coverage, success classification, canonical identity, source facts,
// pinnability, authority, or operational readiness.

import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  TextDecoder,
  types as nodeTypes,
} from "node:util";

import {
  SOURCE_RECALL_POINT_COLLECTOR_VERSION,
} from "./source-recall-point-collector.mjs";
import {
  SOURCE_RECALL_POINT_CLIENT_VERSION,
  SOURCE_RECALL_POINT_REQUEST_VERSION,
  SOURCE_RECALL_POINT_TRANSPORT_RECEIPT_VERSION,
} from "./source-recall-point-client.mjs";
import {
  SOURCE_RECALL_PAGE_CLIENT_VERSION,
} from "./source-recall-page-client.mjs";
import {
  SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION,
  SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS,
} from "./source-recall-reference-persistence-protocol.mjs";
import {
  SOURCE_IDENTITY_POINT_READ_PROCEDURES,
} from "./source-watermark.mjs";

export const SOURCE_RECALL_POINT_OBSERVATION_STORE_VERSION =
  "recall-point-observation-store-dark-v1";
export const SOURCE_RECALL_POINT_OBSERVATION_RECORD_VERSION = 1;
export const SOURCE_RECALL_POINT_OBSERVATION_CLAIM_LEASE_MS =
  150_000;
export const SOURCE_RECALL_POINT_OBSERVATION_MAX_INTERVAL_MS =
  10 * 60 * 1_000;
export const SOURCE_RECALL_POINT_OBSERVATION_READ_MIN_BUDGET_MS =
  30_000;

const SOURCE = "recall";
const WORK_PREFIX =
  "paraai:phase4:recall-point-observation:v1:work:";
const WORK_KEY = new RegExp(
  `^${WORK_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`
    + "([a-f0-9]{64})$",
  "u",
);
const DIGEST = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const BOT_ID = /^[A-Za-z0-9_-]{5,128}$/u;
const WORKFLOW_SOURCES = new Set([
  "paraform-auto",
  "paraform-auto-guardian",
  "paraform-reconciliation",
  "paraform-reconciliation-guardian",
  "fyxer-guardian-n8n",
  "fyxer-guardian-n8n-guardian",
]);
const POINT_REQUEST_DIGEST_DOMAIN =
  "paraai-recall-source-point-request-bytes-v1";
const REQUEST_TIMEOUT_MS = 8_000;
const REQUEST_MAX_BYTES = 256 * 1_024;
const RESPONSE_MAX_BYTES = 256 * 1_024;
const WORK_STATUSES = new Set([
  "awaiting_read_1",
  "reading_1",
  "awaiting_read_2",
  "reading_2",
  "stable",
  "conflict",
  "unresolved",
]);
const TERMINAL_STATUSES = new Set([
  "stable",
  "conflict",
  "unresolved",
]);
const TERMINAL_REASONS = new Set([
  "point_claim_abandoned",
  "point_interval_expired",
  "point_read_failed",
  "point_response_invalid",
]);
const RECORD_KEYS = Object.freeze([
  "activeClaim",
  "authorityAvailable",
  "candidateIdentityResolutionAvailable",
  "contextDigest",
  "contractPinsDigest",
  "createdAtMs",
  "decisionBoundaryAtMs",
  "expectedReference",
  "expiresAtMs",
  "firstEvidence",
  "firstTransportReceipt",
  "globalReferenceSetCoverageAvailable",
  "kind",
  "operational",
  "pinnable",
  "policyVersion",
  "readOne",
  "readTwo",
  "referenceHeadEpochDigest",
  "referenceHeadRecordDigest",
  "referenceHeadRevisionDigest",
  "referencePageKeyDigest",
  "referencePageNativeByteProofDigest",
  "referencePageRecordDigest",
  "referencePageSemanticDigest",
  "resolutionDigest",
  "revision",
  "runNonceDigest",
  "source",
  "sourceFactsAvailable",
  "status",
  "successClassificationAvailable",
  "terminalReason",
  "updatedAtMs",
  "version",
  "workItemDigest",
  "workKeyDigest",
]);
const ACTIVE_CLAIM_KEYS = Object.freeze([
  "claimNonceDigest",
  "expiresAtMs",
  "issuedAtMs",
  "readNumber",
  "reservationId",
]);
const OBSERVATION_KEYS = Object.freeze([
  "completedAtMs",
  "evidence",
  "transportReceipt",
]);
const EVIDENCE_KEYS = Object.freeze([
  "candidateIdentityResolutionAvailable",
  "decisionBoundaryDigest",
  "pinnable",
  "source",
  "sourceNormalizedInputDigest",
  "sourcePointReadProcedure",
  "sourceProvenanceDigest",
  "sourceRecordDigest",
  "sourceRecordRevisionDigest",
  "sourceReferenceDigest",
  "sourceStatusAtBoundaryDigest",
  "successClassificationAvailable",
]);
const RECEIPT_KEYS = Object.freeze([
  "contextDigest",
  "readNumber",
  "requestDigest",
  "reservationId",
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
const VERIFIED_PAGE_KEYS = Object.freeze([
  "pageKeyDigest",
  "pageNativeByteProofDigest",
  "pageRecordDigest",
  "recallReferenceHeadEpochDigest",
  "recallReferenceHeadRecordDigest",
  "recallReferenceHeadRevisionDigest",
  "record",
  "redisNowMs",
  "remainingTtlMs",
]);
const PRIVATE_PAGE_KEYS = Object.freeze([
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
const CLAIM_INPUT_KEYS = Object.freeze(["workKeyDigest"]);
const CLAIM_RESULT_KEYS = Object.freeze([
  "claimNonceDigest",
  "contextDigest",
  "contractPinsDigest",
  "decisionBoundaryAtMs",
  "expectedReference",
  "firstEvidence",
  "readNumber",
  "reservationId",
  "runNonceDigest",
  "status",
  "workItemDigest",
  "workKeyDigest",
]);
const CHECKPOINT_INPUT_KEYS = Object.freeze([
  "evidence",
  "transportReceipt",
]);
const PERSISTENCE_METHODS = Object.freeze([
  "compareAndSet",
  "ensure",
  "read",
  "time",
]);
const STORE_FACTORY_KEYS = Object.freeze(["persistence"]);
const ADAPTER_OPTION_KEYS = new Set([
  "fetchImpl",
  "signalFactory",
  "token",
  "url",
]);

export class SourceRecallPointObservationStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallPointObservationStoreError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallPointObservationStoreError(code);
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
        "SOURCE_RECALL_POINT_OBSERVATION_CANONICAL_VALUE_INVALID",
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
  fail("SOURCE_RECALL_POINT_OBSERVATION_CANONICAL_VALUE_INVALID");
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function sha1(raw) {
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

function boundedText(
  value,
  {
    code,
    maximum,
    lowercase = false,
  },
) {
  if (
    typeof value !== "string"
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || (lowercase && value.toLowerCase() !== value)
  ) {
    fail(code);
  }
  return value;
}

function canonicalBoundaryFromMs(value, code) {
  const boundaryAtMs = safeInteger(value, code);
  const boundaryDate = new Date(boundaryAtMs);
  if (!Number.isFinite(boundaryDate.getTime())) fail(code);
  const boundaryAt = boundaryDate.toISOString();
  if (Date.parse(boundaryAt) !== boundaryAtMs) fail(code);
  return boundaryAt;
}

function canonicalReference(value, boundaryAtMs, code) {
  const reference = exactRecord(value, REFERENCE_KEYS, code);
  if (
    typeof reference.id !== "string"
    || !BOT_ID.test(reference.id)
  ) {
    fail(code);
  }
  const joinAtMs = Date.parse(reference.joinAt);
  if (
    typeof reference.joinAt !== "string"
    || !Number.isFinite(joinAtMs)
    || new Date(joinAtMs).toISOString() !== reference.joinAt
    || joinAtMs >= boundaryAtMs
  ) {
    fail(code);
  }
  const candidate = exactRecord(
    reference.candidate,
    CANDIDATE_KEYS,
    code,
  );
  return deepFreeze({
    id: reference.id,
    joinAt: reference.joinAt,
    metadataSource: (() => {
      const source = boundedText(reference.metadataSource, {
        code,
        maximum: 128,
      });
      if (!WORKFLOW_SOURCES.has(source)) fail(code);
      return source;
    })(),
    candidate: {
      fullName: boundedText(candidate.fullName, {
        code,
        maximum: 512,
      }),
      email: boundedText(candidate.email, {
        code,
        maximum: 512,
        lowercase: true,
      }),
      linkedin: boundedText(candidate.linkedin, {
        code,
        maximum: 4_096,
      }),
      paraformEventId: boundedText(candidate.paraformEventId, {
        code,
        maximum: 1_024,
      }),
    },
  });
}

function canonicalEvidence(value, code) {
  const evidence = exactRecord(value, EVIDENCE_KEYS, code);
  if (
    evidence.source !== SOURCE
    || evidence.sourcePointReadProcedure
      !== SOURCE_IDENTITY_POINT_READ_PROCEDURES.recallSource
    || evidence.successClassificationAvailable !== false
    || evidence.candidateIdentityResolutionAvailable !== false
    || evidence.pinnable !== false
  ) {
    fail(code);
  }
  for (const key of EVIDENCE_KEYS) {
    if (
      [
        "candidateIdentityResolutionAvailable",
        "pinnable",
        "source",
        "sourcePointReadProcedure",
        "successClassificationAvailable",
      ].includes(key)
    ) {
      continue;
    }
    exactDigest(evidence[key], code);
  }
  return deepFreeze({ ...evidence });
}

function canonicalReceipt(value, {
  contextDigest,
  expectedBotId = null,
  readNumber,
  reservationId,
}, code) {
  const receipt = exactRecord(value, RECEIPT_KEYS, code);
  if (
    receipt.version
      !== SOURCE_RECALL_POINT_TRANSPORT_RECEIPT_VERSION
    || receipt.contextDigest !== contextDigest
    || receipt.readNumber !== readNumber
    || receipt.reservationId !== reservationId
  ) {
    fail(code);
  }
  exactDigest(receipt.requestDigest, code);
  if (expectedBotId !== null) {
    const requestBody = JSON.stringify({
      version: SOURCE_RECALL_POINT_REQUEST_VERSION,
      reservationId,
      contextDigest,
      readNumber,
      botId: expectedBotId,
    });
    const expectedRequestDigest = createHash("sha256")
      .update(POINT_REQUEST_DIGEST_DOMAIN, "utf8")
      .update("\0", "utf8")
      .update(requestBody, "utf8")
      .digest("hex");
    if (receipt.requestDigest !== expectedRequestDigest) fail(code);
  }
  return deepFreeze({ ...receipt });
}

function canonicalObservation(value, record, readNumber, code) {
  if (value === null) return null;
  const observation = exactRecord(
    value,
    OBSERVATION_KEYS,
    code,
  );
  const completedAtMs = safeInteger(
    observation.completedAtMs,
    code,
  );
  if (
    completedAtMs < record.createdAtMs
    || completedAtMs > record.updatedAtMs
    || completedAtMs >= record.expiresAtMs
  ) {
    fail(code);
  }
  return deepFreeze({
    completedAtMs,
    evidence: canonicalEvidence(observation.evidence, code),
    transportReceipt: canonicalReceipt(
      observation.transportReceipt,
      {
        contextDigest: record.contextDigest,
        expectedBotId: record.expectedReference.id,
        readNumber,
        reservationId:
          observation.transportReceipt?.reservationId,
      },
      code,
    ),
  });
}

function canonicalActiveClaim(value, record, code) {
  if (value === null) return null;
  const claim = exactRecord(value, ACTIVE_CLAIM_KEYS, code);
  const intervalDeadlineMs = Math.min(
    record.expiresAtMs,
    record.createdAtMs
      + SOURCE_RECALL_POINT_OBSERVATION_MAX_INTERVAL_MS,
  );
  if (
    ![1, 2].includes(claim.readNumber)
    || claim.issuedAtMs < record.createdAtMs
    || claim.issuedAtMs !== record.updatedAtMs
    || claim.issuedAtMs >= intervalDeadlineMs
    || claim.expiresAtMs <= claim.issuedAtMs
    || claim.expiresAtMs !== Math.min(
      claim.issuedAtMs
        + SOURCE_RECALL_POINT_OBSERVATION_CLAIM_LEASE_MS,
      intervalDeadlineMs,
    )
  ) {
    fail(code);
  }
  exactDigest(claim.claimNonceDigest, code);
  exactDigest(claim.reservationId, code);
  return deepFreeze({
    claimNonceDigest: claim.claimNonceDigest,
    expiresAtMs: claim.expiresAtMs,
    issuedAtMs: claim.issuedAtMs,
    readNumber: claim.readNumber,
    reservationId: claim.reservationId,
  });
}

function validateObservationRecord(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_DURABLE_STATE_INVALID";
  const raw = exactRecord(value, RECORD_KEYS, code);
  if (
    raw.version
      !== SOURCE_RECALL_POINT_OBSERVATION_RECORD_VERSION
    || raw.policyVersion
      !== SOURCE_RECALL_POINT_OBSERVATION_STORE_VERSION
    || raw.kind !== "recall_point_observation_work_dark"
    || raw.source !== SOURCE
    || !WORK_STATUSES.has(raw.status)
    || raw.operational !== false
    || raw.globalReferenceSetCoverageAvailable !== false
    || raw.sourceFactsAvailable !== false
    || raw.successClassificationAvailable !== false
    || raw.candidateIdentityResolutionAvailable !== false
    || raw.pinnable !== false
    || raw.authorityAvailable !== false
  ) {
    fail(code);
  }
  const record = {
    ...raw,
    workKeyDigest: exactDigest(raw.workKeyDigest, code),
    workItemDigest: exactDigest(raw.workItemDigest, code),
    runNonceDigest: exactDigest(raw.runNonceDigest, code),
    contractPinsDigest: exactDigest(
      raw.contractPinsDigest,
      code,
    ),
    contextDigest: exactDigest(raw.contextDigest, code),
    referenceHeadEpochDigest: exactDigest(
      raw.referenceHeadEpochDigest,
      code,
    ),
    referenceHeadRevisionDigest: exactDigest(
      raw.referenceHeadRevisionDigest,
      code,
    ),
    referenceHeadRecordDigest: exactDigest(
      raw.referenceHeadRecordDigest,
      code,
    ),
    referencePageKeyDigest: exactDigest(
      raw.referencePageKeyDigest,
      code,
    ),
    referencePageRecordDigest: exactDigest(
      raw.referencePageRecordDigest,
      code,
    ),
    referencePageNativeByteProofDigest: exactSha1(
      raw.referencePageNativeByteProofDigest,
      code,
    ),
    referencePageSemanticDigest: exactDigest(
      raw.referencePageSemanticDigest,
      code,
    ),
    decisionBoundaryAtMs: safeInteger(
      raw.decisionBoundaryAtMs,
      code,
    ),
    createdAtMs: safeInteger(raw.createdAtMs, code),
    updatedAtMs: safeInteger(raw.updatedAtMs, code),
    expiresAtMs: safeInteger(raw.expiresAtMs, code, 1),
    revision: safeInteger(raw.revision, code),
  };
  canonicalBoundaryFromMs(record.decisionBoundaryAtMs, code);
  if (
    record.createdAtMs
      > Number.MAX_SAFE_INTEGER
        - SOURCE_RECALL_POINT_OBSERVATION_MAX_INTERVAL_MS
    || record.decisionBoundaryAtMs > record.createdAtMs
    || record.updatedAtMs < record.createdAtMs
    || record.updatedAtMs >= record.expiresAtMs
    || record.expiresAtMs - record.createdAtMs
      > SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS
  ) {
    fail(code);
  }
  record.expectedReference = canonicalReference(
    raw.expectedReference,
    record.decisionBoundaryAtMs,
    code,
  );
  record.activeClaim = canonicalActiveClaim(
    raw.activeClaim,
    record,
    code,
  );
  record.readOne = canonicalObservation(
    raw.readOne,
    record,
    1,
    code,
  );
  record.readTwo = canonicalObservation(
    raw.readTwo,
    record,
    2,
    code,
  );
  record.firstEvidence = raw.firstEvidence === null
    ? null
    : canonicalEvidence(raw.firstEvidence, code);
  record.firstTransportReceipt =
    raw.firstTransportReceipt === null
      ? null
      : canonicalReceipt(
        raw.firstTransportReceipt,
        {
          contextDigest: record.contextDigest,
          expectedBotId: record.expectedReference.id,
          readNumber: 1,
          reservationId:
            raw.firstTransportReceipt.reservationId,
        },
        code,
      );
  record.resolutionDigest = raw.resolutionDigest === null
    ? null
    : exactDigest(raw.resolutionDigest, code);
  if (
    !(
      raw.terminalReason === null
      || TERMINAL_REASONS.has(raw.terminalReason)
    )
  ) {
    fail(code);
  }
  const readingNumber = raw.status === "reading_1"
    ? 1
    : raw.status === "reading_2"
      ? 2
      : null;
  const intervalDeadlineMs = Math.min(
    record.expiresAtMs,
    record.createdAtMs
      + SOURCE_RECALL_POINT_OBSERVATION_MAX_INTERVAL_MS,
  );
  const hasReadOne = record.readOne !== null;
  const hasFirstEvidence = record.firstEvidence !== null;
  const hasFirstReceipt =
    record.firstTransportReceipt !== null;
  if (
    (readingNumber === null) !== (record.activeClaim === null)
    || (
      readingNumber !== null
      && record.activeClaim.readNumber !== readingNumber
    )
    || hasReadOne !== hasFirstEvidence
    || hasReadOne !== hasFirstReceipt
    || (
      hasReadOne
      && (
        canonicalJson(record.firstEvidence)
          !== canonicalJson(record.readOne.evidence)
        || canonicalJson(record.firstTransportReceipt)
          !== canonicalJson(record.readOne.transportReceipt)
      )
    )
    || (
      record.readOne !== null
      && record.readOne.completedAtMs >= intervalDeadlineMs
    )
    || (
      record.readTwo !== null
      && (
        record.readOne === null
        || record.readTwo.completedAtMs
          < record.readOne.completedAtMs
        || record.readTwo.completedAtMs
          >= intervalDeadlineMs
      )
    )
    || (
      ["awaiting_read_1", "reading_1"].includes(raw.status)
      && (
        record.readOne !== null
        || record.readTwo !== null
        || record.firstEvidence !== null
        || record.firstTransportReceipt !== null
      )
    )
    || (
      ["awaiting_read_2", "reading_2"].includes(raw.status)
      && (
        record.readOne === null
        || record.readTwo !== null
        || record.firstEvidence === null
        || record.firstTransportReceipt === null
        || canonicalJson(record.firstEvidence)
          !== canonicalJson(record.readOne.evidence)
        || canonicalJson(record.firstTransportReceipt)
          !== canonicalJson(record.readOne.transportReceipt)
      )
    )
    || (
      ["stable", "conflict"].includes(raw.status)
      && (
        record.readOne === null
        || record.readTwo === null
        || record.firstEvidence === null
        || record.firstTransportReceipt === null
        || record.resolutionDigest === null
        || raw.terminalReason !== null
      )
    )
    || (
      raw.status === "unresolved"
      && (
        raw.terminalReason === null
        || record.resolutionDigest === null
        || record.readTwo !== null
      )
    )
    || (
      !TERMINAL_STATUSES.has(raw.status)
      && (
        record.resolutionDigest !== null
        || raw.terminalReason !== null
      )
    )
    || (
      raw.status === "awaiting_read_1"
      && (
        record.updatedAtMs !== record.createdAtMs
        || record.revision !== 0
      )
    )
    || (
      raw.status === "awaiting_read_2"
      && record.updatedAtMs !== record.readOne.completedAtMs
    )
    || (
      raw.status === "reading_2"
      && record.activeClaim.issuedAtMs
        < record.readOne.completedAtMs
    )
    || (
      ["stable", "conflict"].includes(raw.status)
      && record.updatedAtMs !== record.readTwo.completedAtMs
    )
  ) {
    fail(code);
  }
  if (record.readOne !== null && record.readTwo !== null) {
    const stable =
      canonicalJson(record.readOne.evidence)
        === canonicalJson(record.readTwo.evidence);
    if (
      record.readOne.transportReceipt.reservationId
        === record.readTwo.transportReceipt.reservationId
      || (raw.status === "stable") !== stable
      || !["stable", "conflict"].includes(raw.status)
    ) {
      fail(code);
    }
    const expectedResolutionDigest = semanticDigest(
      "phase4-recall-point-observation-resolution-v1",
      {
        workKeyDigest: record.workKeyDigest,
        status: raw.status,
        firstEvidence: record.firstEvidence,
        firstTransportReceipt:
          record.firstTransportReceipt,
        secondEvidence: record.readTwo.evidence,
        secondTransportReceipt:
          record.readTwo.transportReceipt,
      },
    );
    if (record.resolutionDigest !== expectedResolutionDigest) {
      fail(code);
    }
  }
  if (raw.status === "unresolved") {
    const expectedResolutionDigest = semanticDigest(
      "phase4-recall-point-observation-resolution-v1",
      {
        workKeyDigest: record.workKeyDigest,
        status: "unresolved",
        reason: raw.terminalReason,
        firstEvidence: record.firstEvidence,
        firstTransportReceipt:
          record.firstTransportReceipt,
      },
    );
    if (record.resolutionDigest !== expectedResolutionDigest) {
      fail(code);
    }
  }
  const workItemMaterial = {
    runNonceDigest: record.runNonceDigest,
    decisionBoundaryAtMs: record.decisionBoundaryAtMs,
    contractPinsDigest: record.contractPinsDigest,
    referenceHeadEpochDigest:
      record.referenceHeadEpochDigest,
    referenceHeadRevisionDigest:
      record.referenceHeadRevisionDigest,
    referenceHeadRecordDigest:
      record.referenceHeadRecordDigest,
    referencePageKeyDigest:
      record.referencePageKeyDigest,
    referencePageRecordDigest:
      record.referencePageRecordDigest,
    referencePageNativeByteProofDigest:
      record.referencePageNativeByteProofDigest,
    referencePageSemanticDigest:
      record.referencePageSemanticDigest,
    referenceOrdinal: 0,
    expectedReference: record.expectedReference,
  };
  const expectedWorkItemDigest = semanticDigest(
    "phase4-recall-point-observation-work-item-v1",
    workItemMaterial,
  );
  const expectedWorkKeyDigest = semanticDigest(
    "phase4-recall-point-observation-work-key-v1",
    {
      policyVersion:
        SOURCE_RECALL_POINT_OBSERVATION_STORE_VERSION,
      workItemDigest: expectedWorkItemDigest,
    },
  );
  const expectedContextDigest = semanticDigest(
    "phase4-recall-point-observation-context-v1",
    {
      policyVersion:
        SOURCE_RECALL_POINT_OBSERVATION_STORE_VERSION,
      pointClientVersion: SOURCE_RECALL_POINT_CLIENT_VERSION,
      pointProjectorVersion:
        SOURCE_RECALL_POINT_COLLECTOR_VERSION,
      workKeyDigest: expectedWorkKeyDigest,
      workItemDigest: expectedWorkItemDigest,
      runNonceDigest: record.runNonceDigest,
      decisionBoundaryAtMs: record.decisionBoundaryAtMs,
      contractPinsDigest: record.contractPinsDigest,
      referenceHeadEpochDigest:
        record.referenceHeadEpochDigest,
      referenceHeadRevisionDigest:
        record.referenceHeadRevisionDigest,
      referenceHeadRecordDigest:
        record.referenceHeadRecordDigest,
    },
  );
  if (
    record.workItemDigest !== expectedWorkItemDigest
    || record.workKeyDigest !== expectedWorkKeyDigest
    || record.contextDigest !== expectedContextDigest
  ) {
    fail(code);
  }
  return deepFreeze(record);
}

function parseSnapshot(raw, redisNowMs, expiresAtMs) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID";
  if (
    typeof raw !== "string"
    || raw.length === 0
    || Buffer.byteLength(raw, "utf8") > REQUEST_MAX_BYTES
  ) {
    fail(code);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(code);
  }
  const record = validateObservationRecord(parsed);
  if (
    canonicalJson(record) !== raw
    || safeInteger(redisNowMs, code) < record.updatedAtMs
    || safeInteger(expiresAtMs, code, 1)
      !== record.expiresAtMs
    || redisNowMs >= expiresAtMs
  ) {
    fail(code);
  }
  return deepFreeze({
    record,
    raw,
    rawSha1: sha1(raw),
    redisNowMs,
  });
}

function canonicalWork(value) {
  const code = "SOURCE_RECALL_POINT_OBSERVATION_WORK_INVALID";
  const input = exactRecord(value, CLAIM_INPUT_KEYS, code);
  if (!Object.isFrozen(value)) fail(code);
  return deepFreeze({
    workKeyDigest: exactDigest(input.workKeyDigest, code),
  });
}

function aggregateFor(record) {
  return deepFreeze({
    status: record.status,
    prepared: true,
    stable: record.status === "stable" ? 1 : 0,
    unresolved: record.status === "unresolved" ? 1 : 0,
    conflict: record.status === "conflict" ? 1 : 0,
    readsCompleted:
      (record.readOne === null ? 0 : 1)
      + (record.readTwo === null ? 0 : 1),
    inProgress: record.activeClaim !== null,
    operational: false,
    globalReferenceSetCoverageAvailable: false,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
  });
}

export function recallPointObservationAggregateStatus(snapshot) {
  const value = plainRecordSnapshot(
    snapshot,
    "SOURCE_RECALL_POINT_OBSERVATION_SNAPSHOT_INVALID",
  );
  return aggregateFor(
    validateObservationRecord(value.record),
  );
}

function configurationFromEnvironment() {
  return {
    url: String(
      process.env
        .PARAAI_SOURCE_RECALL_REFERENCE_KV_REST_API_URL
      || "",
    ),
    token: String(
      process.env
        .PARAAI_SOURCE_RECALL_REFERENCE_KV_REST_API_TOKEN
      || "",
    ),
  };
}

function canonicalConfiguration(urlValue, tokenValue) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_CONFIGURATION_INVALID";
  const url = typeof urlValue === "string"
    ? urlValue.replace(/\/+$/u, "")
    : "";
  const token = typeof tokenValue === "string"
    ? tokenValue
    : "";
  if (Boolean(url) !== Boolean(token)) fail(code);
  if (!url && !token) {
    fail("SOURCE_RECALL_POINT_OBSERVATION_UNAVAILABLE");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(code);
  }
  if (
    parsed.protocol !== "https:"
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    fail(code);
  }
  return Object.freeze({ url, token });
}

export function sourceRecallPointObservationStoreConfigured() {
  const { url, token } = configurationFromEnvironment();
  if (Boolean(url) !== Boolean(token) || !url || !token) {
    return false;
  }
  try {
    canonicalConfiguration(url, token);
    return true;
  } catch {
    return false;
  }
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
    // The stable store error is the only observable result.
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
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_FAILED",
      );
    }
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared)
      || declared > RESPONSE_MAX_BYTES
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_FAILED",
      );
    }
  }
  if (!response?.body) {
    fail("SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_FAILED");
  }
  const chunks = [];
  let size = 0;
  const append = (chunk) => {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    size += bytes.length;
    if (size > RESPONSE_MAX_BYTES) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_FAILED",
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
        append(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else if (
    typeof response.body[Symbol.asyncIterator] === "function"
  ) {
    for await (const chunk of response.body) {
      append(chunk);
    }
  } else {
    fail("SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_FAILED");
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(Buffer.concat(chunks, size));
  } catch {
    fail("SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_FAILED");
  }
}

function adapterOptions(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_CONFIGURATION_INVALID";
  if (value === undefined) return Object.create(null);
  const options = plainRecordSnapshot(value, code);
  if (
    Object.keys(options).some(
      (key) => !ADAPTER_OPTION_KEYS.has(key),
    )
  ) {
    fail(code);
  }
  return options;
}

function redisTimeFromResult(result, secondsIndex, code) {
  if (
    !Array.isArray(result)
    || !/^(?:0|[1-9][0-9]*)$/u.test(
      String(result[secondsIndex] ?? ""),
    )
    || !/^[0-9]{1,6}$/u.test(
      String(result[secondsIndex + 1] ?? ""),
    )
  ) {
    fail(code);
  }
  const seconds = Number(result[secondsIndex]);
  const microseconds = Number(result[secondsIndex + 1]);
  if (
    !Number.isSafeInteger(seconds)
    || !Number.isSafeInteger(microseconds)
    || microseconds < 0
    || microseconds > 999_999
  ) {
    fail(code);
  }
  const value =
    seconds * 1_000 + Math.floor(microseconds / 1_000);
  return safeInteger(value, code);
}

function adapterKey(value, code) {
  if (typeof value !== "string" || !WORK_KEY.test(value)) {
    fail(code);
  }
  return value;
}

const TIME_LUA = `
  -- recall_point_observation_time_v1
  local redisTime = redis.call('TIME')
  return {redisTime[1], redisTime[2]}
`;

const ENSURE_LUA = `
  -- recall_point_observation_ensure_v1
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local expiresAtMs = tonumber(ARGV[2])
  local current = redis.call('GET', KEYS[1])
  if current then
    return {
      0,
      current,
      redisTime[1],
      redisTime[2],
      redis.call('PEXPIRETIME', KEYS[1])
    }
  end
  if not expiresAtMs
    or expiresAtMs ~= math.floor(expiresAtMs)
    or nowMs >= expiresAtMs then
    return {2, false, redisTime[1], redisTime[2], -2}
  end
  local stored = redis.call(
    'SET',
    KEYS[1],
    ARGV[1],
    'NX',
    'PXAT',
    tostring(expiresAtMs)
  )
  if not stored then
    current = redis.call('GET', KEYS[1])
    return {
      0,
      current,
      redisTime[1],
      redisTime[2],
      redis.call('PEXPIRETIME', KEYS[1])
    }
  end
  return {
    1,
    ARGV[1],
    redisTime[1],
    redisTime[2],
    redis.call('PEXPIRETIME', KEYS[1])
  }
`;

const READ_LUA = `
  -- recall_point_observation_read_v1
  local redisTime = redis.call('TIME')
  local current = redis.call('GET', KEYS[1])
  if not current then
    return {false, redisTime[1], redisTime[2], -2}
  end
  return {
    current,
    redisTime[1],
    redisTime[2],
    redis.call('PEXPIRETIME', KEYS[1])
  }
`;

const CAS_LUA = `
  -- recall_point_observation_cas_v1
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
  local current = redis.call('GET', KEYS[1])
  local currentExpiry = redis.call('PEXPIRETIME', KEYS[1])
  local expectedExpiry = tonumber(ARGV[3])
  local notAfterMs = tonumber(ARGV[4])
  if not current or current ~= ARGV[1] then
    return {
      0,
      current,
      redisTime[1],
      redisTime[2],
      currentExpiry
    }
  end
  if not expectedExpiry
    or expectedExpiry ~= math.floor(expectedExpiry)
    or currentExpiry ~= expectedExpiry
    or not notAfterMs
    or notAfterMs ~= math.floor(notAfterMs)
    or nowMs >= expectedExpiry
    or nowMs >= notAfterMs then
    return {
      2,
      current,
      redisTime[1],
      redisTime[2],
      currentExpiry
    }
  end
  local stored = redis.call(
    'SET',
    KEYS[1],
    ARGV[2],
    'XX',
    'PXAT',
    tostring(expectedExpiry)
  )
  if not stored then
    return {
      0,
      redis.call('GET', KEYS[1]),
      redisTime[1],
      redisTime[2],
      redis.call('PEXPIRETIME', KEYS[1])
    }
  end
  return {
    1,
    ARGV[2],
    redisTime[1],
    redisTime[2],
    redis.call('PEXPIRETIME', KEYS[1])
  }
`;

export function createSourceRecallPointObservationPersistenceAdapter(
  value,
) {
  const options = adapterOptions(value);
  const environment = configurationFromEnvironment();
  const hasUrl = Object.prototype.hasOwnProperty.call(
    options,
    "url",
  );
  const hasToken = Object.prototype.hasOwnProperty.call(
    options,
    "token",
  );
  if (hasUrl !== hasToken) {
    fail(
      "SOURCE_RECALL_POINT_OBSERVATION_CONFIGURATION_INVALID",
    );
  }
  const configuration = canonicalConfiguration(
    hasUrl ? options.url : environment.url,
    hasToken ? options.token : environment.token,
  );
  const fetchImpl = Object.prototype.hasOwnProperty.call(
    options,
    "fetchImpl",
  )
    ? options.fetchImpl
    : globalThis.fetch;
  const signalFactory = Object.prototype.hasOwnProperty.call(
    options,
    "signalFactory",
  )
    ? options.signalFactory
    : (timeoutMs) => AbortSignal.timeout(timeoutMs);
  if (
    typeof fetchImpl !== "function"
    || typeof signalFactory !== "function"
  ) {
    fail(
      "SOURCE_RECALL_POINT_OBSERVATION_CONFIGURATION_INVALID",
    );
  }

  async function execute(command) {
    const body = JSON.stringify(command);
    if (Buffer.byteLength(body, "utf8") > REQUEST_MAX_BYTES) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_FAILED",
      );
    }
    let response;
    try {
      response = await fetchImpl(configuration.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${configuration.token}`,
          "content-type": "application/json",
        },
        body,
        cache: "no-store",
        redirect: "error",
        signal: signalFactory(REQUEST_TIMEOUT_MS),
      });
    } catch {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_FAILED",
      );
    }
    try {
      if (
        !response
        || response.status !== 200
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu
          .test(
            responseHeader(
              response.headers,
              "content-type",
            ).trim(),
          )
      ) {
        fail(
          "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_FAILED",
        );
      }
      const text = await boundedResponseText(response);
      const envelope = exactRecord(
        JSON.parse(text),
        ["result"],
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_FAILED",
      );
      return envelope.result;
    } catch {
      await cancelResponseBody(response);
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_FAILED",
      );
    }
  }

  async function evaluate(script, key, args = []) {
    return execute([
      "EVAL",
      script,
      1,
      key,
      ...args.map(String),
    ]);
  }

  return deepFreeze({
    async time() {
      const result = await execute([
        "EVAL",
        TIME_LUA,
        0,
      ]);
      if (!Array.isArray(result) || result.length !== 2) {
        fail(
          "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
        );
      }
      return deepFreeze({
        redisNowMs: redisTimeFromResult(
          result,
          0,
          "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
        ),
      });
    },
    async ensure(inputValue) {
      const code =
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_INPUT_INVALID";
      const input = exactRecord(
        inputValue,
        ["expiresAtMs", "key", "proposedRaw"],
        code,
      );
      const key = adapterKey(input.key, code);
      if (
        typeof input.proposedRaw !== "string"
        || Buffer.byteLength(input.proposedRaw, "utf8")
          > REQUEST_MAX_BYTES
      ) {
        fail(code);
      }
      safeInteger(input.expiresAtMs, code, 1);
      const result = await evaluate(
        ENSURE_LUA,
        key,
        [input.proposedRaw, input.expiresAtMs],
      );
      if (
        !Array.isArray(result)
        || result.length !== 5
        || ![0, 1, 2].includes(result[0])
        || !(
          typeof result[1] === "string"
          || result[1] === null
        )
        || !Number.isSafeInteger(result[4])
        || (
          result[0] === 2
          && (result[1] !== null || result[4] !== -2)
        )
        || (
          result[0] !== 2
          && (
            typeof result[1] !== "string"
            || result[4] < 1
          )
        )
      ) {
        fail(
          "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
        );
      }
      const statusCode = result[0];
      const redisNowMs = redisTimeFromResult(
        result,
        2,
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
      );
      const expiresAtMs = result[4];
      return deepFreeze({
        status: statusCode === 1
          ? "created"
          : statusCode === 0
            ? "existing"
            : "expired",
        raw: typeof result[1] === "string"
          ? result[1]
          : null,
        redisNowMs,
        expiresAtMs,
      });
    },
    async read(inputValue) {
      const code =
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_INPUT_INVALID";
      const input = exactRecord(inputValue, ["key"], code);
      const result = await evaluate(
        READ_LUA,
        adapterKey(input.key, code),
      );
      if (
        !Array.isArray(result)
        || result.length !== 4
        || !(
          typeof result[0] === "string"
          || result[0] === null
        )
        || !Number.isSafeInteger(result[3])
        || (
          result[0] === null
          && result[3] !== -2
        )
        || (
          typeof result[0] === "string"
          && result[3] < 1
        )
      ) {
        fail(
          "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
        );
      }
      const redisNowMs = redisTimeFromResult(
        result,
        1,
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
      );
      const expiresAtMs = result[3];
      return deepFreeze({
        raw: typeof result[0] === "string"
          ? result[0]
          : null,
        redisNowMs,
        expiresAtMs,
      });
    },
    async compareAndSet(inputValue) {
      const code =
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_INPUT_INVALID";
      const input = exactRecord(
        inputValue,
        [
          "expectedRaw",
          "expiresAtMs",
          "key",
          "nextRaw",
          "notAfterMs",
        ],
        code,
      );
      const key = adapterKey(input.key, code);
      for (const raw of [input.expectedRaw, input.nextRaw]) {
        if (
          typeof raw !== "string"
          || Buffer.byteLength(raw, "utf8")
            > REQUEST_MAX_BYTES
        ) {
          fail(code);
        }
      }
      safeInteger(input.expiresAtMs, code, 1);
      safeInteger(input.notAfterMs, code, 1);
      const result = await evaluate(
        CAS_LUA,
        key,
        [
          input.expectedRaw,
          input.nextRaw,
          input.expiresAtMs,
          input.notAfterMs,
        ],
      );
      if (
        !Array.isArray(result)
        || result.length !== 5
        || ![0, 1, 2].includes(result[0])
        || !(
          typeof result[1] === "string"
          || result[1] === null
        )
        || !Number.isSafeInteger(result[4])
        || (
          result[0] === 0
          && (
            (result[1] === null && result[4] !== -2)
            || (
              typeof result[1] === "string"
              && result[4] < 1
            )
          )
        )
        || (
          result[0] !== 0
          && (
            typeof result[1] !== "string"
            || result[4] < 1
          )
        )
      ) {
        fail(
          "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
        );
      }
      const statusCode = result[0];
      return deepFreeze({
        status: statusCode === 1
          ? "stored"
          : statusCode === 0
            ? "conflict"
            : "expired",
        raw: typeof result[1] === "string"
          ? result[1]
          : null,
        redisNowMs: redisTimeFromResult(
          result,
          2,
          "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
        ),
        expiresAtMs: result[4],
      });
    },
  });
}

function persistenceInterface(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_INVALID";
  const persistence = plainRecordSnapshot(value, code);
  if (
    !sameKeys(
      Object.keys(persistence).sort(),
      [...PERSISTENCE_METHODS].sort(),
    )
  ) {
    fail(code);
  }
  for (const method of PERSISTENCE_METHODS) {
    if (typeof persistence[method] !== "function") fail(code);
  }
  return Object.freeze(persistence);
}

function verifiedPrivatePage(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_VERIFIED_PAGE_INVALID";
  const verified = exactRecord(
    value,
    VERIFIED_PAGE_KEYS,
    code,
  );
  if (!Object.isFrozen(value)) fail(code);
  const page = exactRecord(
    verified.record,
    PRIVATE_PAGE_KEYS,
    code,
  );
  if (
    !Object.isFrozen(verified.record)
    || page.version !== 1
    || page.policyVersion
      !== SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION
    || page.kind !== "recall_private_reference_page_dark"
    || page.source !== SOURCE
    || page.clientVersion !== SOURCE_RECALL_PAGE_CLIENT_VERSION
    || page.passNumber !== 2
    || page.pageNumber !== 1
    || page.cursor !== null
  ) {
    fail(code);
  }
  const referenceCount = safeInteger(
    page.referenceCount,
    code,
  );
  const scannedCount = safeInteger(
    page.scannedCount,
    code,
  );
  if (scannedCount < referenceCount) fail(code);
  const references = denseArraySnapshot(
    page.references,
    code,
  );
  if (
    !Object.isFrozen(page.references)
    || references.length !== referenceCount
  ) {
    fail(code);
  }
  const decisionBoundaryAtMs = safeInteger(
    page.decisionBoundaryAtMs,
    code,
  );
  canonicalBoundaryFromMs(decisionBoundaryAtMs, code);
  exactDigest(page.workKeyDigest, code);
  exactDigest(page.runNonceDigest, code);
  exactDigest(page.contractPinsDigest, code);
  exactDigest(page.pageSemanticDigest, code);
  if (
    !(
      page.nextCursor === null
      || (
        typeof page.nextCursor === "string"
        && page.nextCursor.length <= 8_192
        && page.nextCursor.trim() === page.nextCursor
      )
    )
  ) {
    fail(code);
  }
  const canonicalReferences = references.map((reference) => {
    const frozenReference = exactRecord(
      reference,
      REFERENCE_KEYS,
      code,
    );
    exactRecord(
      frozenReference.candidate,
      CANDIDATE_KEYS,
      code,
    );
    if (
      !Object.isFrozen(reference)
      || !Object.isFrozen(frozenReference.candidate)
    ) {
      fail(code);
    }
    return canonicalReference(
      reference,
      decisionBoundaryAtMs,
      code,
    );
  });
  if (canonicalReferences.length === 0) {
    fail(
      "SOURCE_RECALL_POINT_OBSERVATION_REFERENCE_UNAVAILABLE",
    );
  }
  const selectedReference = canonicalReferences[0];
  const redisNowMs = safeInteger(
    verified.redisNowMs,
    code,
  );
  const remainingTtlMs = safeInteger(
    verified.remainingTtlMs,
    code,
    1,
  );
  const pageExpiresAtMs = safeInteger(
    page.pageExpiresAtMs,
    code,
    1,
  );
  if (
    decisionBoundaryAtMs > redisNowMs
    || pageExpiresAtMs - redisNowMs !== remainingTtlMs
    || remainingTtlMs
      > SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS
    || remainingTtlMs
      <= SOURCE_RECALL_POINT_OBSERVATION_MAX_INTERVAL_MS
        + SOURCE_RECALL_POINT_OBSERVATION_CLAIM_LEASE_MS
  ) {
    fail(code);
  }
  return deepFreeze({
    runNonceDigest: exactDigest(page.runNonceDigest, code),
    decisionBoundaryAtMs,
    contractPinsDigest: exactDigest(
      page.contractPinsDigest,
      code,
    ),
    referenceHeadEpochDigest: exactDigest(
      verified.recallReferenceHeadEpochDigest,
      code,
    ),
    referenceHeadRevisionDigest: exactDigest(
      verified.recallReferenceHeadRevisionDigest,
      code,
    ),
    referenceHeadRecordDigest: exactDigest(
      verified.recallReferenceHeadRecordDigest,
      code,
    ),
    referencePageKeyDigest: exactDigest(
      verified.pageKeyDigest,
      code,
    ),
    referencePageRecordDigest: exactDigest(
      verified.pageRecordDigest,
      code,
    ),
    referencePageNativeByteProofDigest: exactSha1(
      verified.pageNativeByteProofDigest,
      code,
    ),
    referencePageSemanticDigest: exactDigest(
      page.pageSemanticDigest,
      code,
    ),
    selectedReference,
    pageExpiresAtMs,
    verifiedAtMs: redisNowMs,
  });
}

function initialRecord(page, createdAtMs) {
  const workItemMaterial = {
    runNonceDigest: page.runNonceDigest,
    decisionBoundaryAtMs: page.decisionBoundaryAtMs,
    contractPinsDigest: page.contractPinsDigest,
    referenceHeadEpochDigest:
      page.referenceHeadEpochDigest,
    referenceHeadRevisionDigest:
      page.referenceHeadRevisionDigest,
    referenceHeadRecordDigest:
      page.referenceHeadRecordDigest,
    referencePageKeyDigest: page.referencePageKeyDigest,
    referencePageRecordDigest:
      page.referencePageRecordDigest,
    referencePageNativeByteProofDigest:
      page.referencePageNativeByteProofDigest,
    referencePageSemanticDigest:
      page.referencePageSemanticDigest,
    referenceOrdinal: 0,
    expectedReference: page.selectedReference,
  };
  const workItemDigest = semanticDigest(
    "phase4-recall-point-observation-work-item-v1",
    workItemMaterial,
  );
  const workKeyDigest = semanticDigest(
    "phase4-recall-point-observation-work-key-v1",
    {
      policyVersion:
        SOURCE_RECALL_POINT_OBSERVATION_STORE_VERSION,
      workItemDigest,
    },
  );
  const contextDigest = semanticDigest(
    "phase4-recall-point-observation-context-v1",
    {
      policyVersion:
        SOURCE_RECALL_POINT_OBSERVATION_STORE_VERSION,
      pointClientVersion: SOURCE_RECALL_POINT_CLIENT_VERSION,
      pointProjectorVersion:
        SOURCE_RECALL_POINT_COLLECTOR_VERSION,
      workKeyDigest,
      workItemDigest,
      runNonceDigest: page.runNonceDigest,
      decisionBoundaryAtMs: page.decisionBoundaryAtMs,
      contractPinsDigest: page.contractPinsDigest,
      referenceHeadEpochDigest:
        page.referenceHeadEpochDigest,
      referenceHeadRevisionDigest:
        page.referenceHeadRevisionDigest,
      referenceHeadRecordDigest:
        page.referenceHeadRecordDigest,
    },
  );
  const expiresAtMs = Math.min(
    page.pageExpiresAtMs,
    createdAtMs
      + SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS,
  );
  return validateObservationRecord({
    version: SOURCE_RECALL_POINT_OBSERVATION_RECORD_VERSION,
    policyVersion:
      SOURCE_RECALL_POINT_OBSERVATION_STORE_VERSION,
    kind: "recall_point_observation_work_dark",
    source: SOURCE,
    status: "awaiting_read_1",
    workKeyDigest,
    workItemDigest,
    runNonceDigest: page.runNonceDigest,
    decisionBoundaryAtMs: page.decisionBoundaryAtMs,
    contractPinsDigest: page.contractPinsDigest,
    contextDigest,
    expectedReference: page.selectedReference,
    referenceHeadEpochDigest:
      page.referenceHeadEpochDigest,
    referenceHeadRevisionDigest:
      page.referenceHeadRevisionDigest,
    referenceHeadRecordDigest:
      page.referenceHeadRecordDigest,
    referencePageKeyDigest: page.referencePageKeyDigest,
    referencePageRecordDigest:
      page.referencePageRecordDigest,
    referencePageNativeByteProofDigest:
      page.referencePageNativeByteProofDigest,
    referencePageSemanticDigest:
      page.referencePageSemanticDigest,
    createdAtMs,
    updatedAtMs: createdAtMs,
    expiresAtMs,
    revision: 0,
    activeClaim: null,
    readOne: null,
    readTwo: null,
    firstEvidence: null,
    firstTransportReceipt: null,
    resolutionDigest: null,
    terminalReason: null,
    operational: false,
    globalReferenceSetCoverageAvailable: false,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
  });
}

function terminalized(record, reason, nowMs) {
  const next = clone(record);
  next.status = "unresolved";
  next.activeClaim = null;
  next.terminalReason = reason;
  next.resolutionDigest = semanticDigest(
    "phase4-recall-point-observation-resolution-v1",
    {
      workKeyDigest: record.workKeyDigest,
      status: "unresolved",
      reason,
      firstEvidence: record.firstEvidence,
      firstTransportReceipt: record.firstTransportReceipt,
    },
  );
  next.updatedAtMs = nowMs;
  next.revision += 1;
  return validateObservationRecord(next);
}

function observationSnapshotResult(result, code) {
  const value = exactRecord(
    result,
    ["expiresAtMs", "raw", "redisNowMs", "status"],
    code,
  );
  if (
    !["conflict", "created", "existing", "expired", "stored"]
      .includes(value.status)
  ) {
    fail(code);
  }
  safeInteger(value.redisNowMs, code);
  if (
    !(
      value.expiresAtMs === -2
      || Number.isSafeInteger(value.expiresAtMs)
    )
  ) {
    fail(code);
  }
  if (!(value.raw === null || typeof value.raw === "string")) {
    fail(code);
  }
  return value;
}

function readResult(result, code) {
  const value = exactRecord(
    result,
    ["expiresAtMs", "raw", "redisNowMs"],
    code,
  );
  safeInteger(value.redisNowMs, code);
  if (
    !(
      value.expiresAtMs === -2
      || Number.isSafeInteger(value.expiresAtMs)
    )
    || !(value.raw === null || typeof value.raw === "string")
  ) {
    fail(code);
  }
  return value;
}

function timeResult(result) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID";
  const value = exactRecord(result, ["redisNowMs"], code);
  return safeInteger(value.redisNowMs, code);
}

export function createSourceRecallPointObservationStore(options) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_STORE_OPTIONS_INVALID";
  const normalized = exactRecord(
    options,
    STORE_FACTORY_KEYS,
    code,
  );
  const persistence = persistenceInterface(
    normalized.persistence,
  );
  const issuedClaims = new WeakMap();

  async function readSnapshot(work) {
    const selected = canonicalWork(work);
    const result = readResult(
      await persistence.read({
        key: `${WORK_PREFIX}${selected.workKeyDigest}`,
      }),
      "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
    );
    if (result.raw === null) {
      fail("SOURCE_RECALL_POINT_OBSERVATION_WORK_NOT_FOUND");
    }
    const snapshot = parseSnapshot(
      result.raw,
      result.redisNowMs,
      result.expiresAtMs,
    );
    if (
      snapshot.record.workKeyDigest
        !== selected.workKeyDigest
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_WORK_BINDING_MISMATCH",
      );
    }
    return snapshot;
  }

  async function compareAndSet(snapshot, next, notAfterMs) {
    const nextRaw = canonicalJson(next);
    const result = observationSnapshotResult(
      await persistence.compareAndSet({
        key: `${WORK_PREFIX}${snapshot.record.workKeyDigest}`,
        expectedRaw: snapshot.raw,
        nextRaw,
        expiresAtMs: snapshot.record.expiresAtMs,
        notAfterMs,
      }),
      "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
    );
    if (result.status === "conflict") {
      fail("SOURCE_RECALL_POINT_OBSERVATION_CAS_CONFLICT");
    }
    if (result.status === "expired") {
      fail("SOURCE_RECALL_POINT_OBSERVATION_EXPIRED");
    }
    if (
      result.status !== "stored"
      || result.raw !== nextRaw
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
      );
    }
    return parseSnapshot(
      result.raw,
      result.redisNowMs,
      result.expiresAtMs,
    );
  }

  async function prepareRecallPointObservationWork(verifiedPage) {
    const page = verifiedPrivatePage(verifiedPage);
    const createdAtMs = timeResult(await persistence.time());
    if (
      createdAtMs < page.verifiedAtMs
      || page.pageExpiresAtMs - createdAtMs
        <= SOURCE_RECALL_POINT_OBSERVATION_MAX_INTERVAL_MS
          + SOURCE_RECALL_POINT_OBSERVATION_CLAIM_LEASE_MS
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_REFERENCE_EXPIRED",
      );
    }
    const proposed = initialRecord(page, createdAtMs);
    const proposedRaw = canonicalJson(proposed);
    const result = observationSnapshotResult(
      await persistence.ensure({
        key: `${WORK_PREFIX}${proposed.workKeyDigest}`,
        proposedRaw,
        expiresAtMs: proposed.expiresAtMs,
      }),
      "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
    );
    if (result.status === "expired" || result.raw === null) {
      fail("SOURCE_RECALL_POINT_OBSERVATION_REFERENCE_EXPIRED");
    }
    if (!["created", "existing"].includes(result.status)) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
      );
    }
    const snapshot = parseSnapshot(
      result.raw,
      result.redisNowMs,
      result.expiresAtMs,
    );
    if (
      snapshot.record.workKeyDigest !== proposed.workKeyDigest
      || snapshot.record.workItemDigest !== proposed.workItemDigest
      || snapshot.record.contextDigest !== proposed.contextDigest
      || snapshot.record.referenceHeadRecordDigest
        !== proposed.referenceHeadRecordDigest
      || snapshot.record.referencePageRecordDigest
        !== proposed.referencePageRecordDigest
      || snapshot.record.expiresAtMs !== proposed.expiresAtMs
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_WORK_BINDING_MISMATCH",
      );
    }
    return snapshot;
  }

  function completeClaim(record) {
    if (!TERMINAL_STATUSES.has(record.status)) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_DURABLE_STATE_INVALID",
      );
    }
    return deepFreeze({
      outcome: record.status,
      status: "complete",
      workKeyDigest: record.workKeyDigest,
    });
  }

  function inProgressClaim(record) {
    return deepFreeze({
      status: "in_progress",
      workKeyDigest: record.workKeyDigest,
    });
  }

  async function postConflictClaim(work) {
    const current = await readSnapshot(work);
    if (TERMINAL_STATUSES.has(current.record.status)) {
      return completeClaim(current.record);
    }
    return inProgressClaim(current.record);
  }

  async function settleUnresolved(
    snapshot,
    reason,
    nowMs = snapshot.redisNowMs,
  ) {
    const next = terminalized(
      snapshot.record,
      reason,
      nowMs,
    );
    try {
      return await compareAndSet(
        snapshot,
        next,
        snapshot.record.expiresAtMs,
      );
    } catch (error) {
      if (
        error
          instanceof SourceRecallPointObservationStoreError
        && error.code
          === "SOURCE_RECALL_POINT_OBSERVATION_CAS_CONFLICT"
      ) {
        return readSnapshot(deepFreeze({
          workKeyDigest: snapshot.record.workKeyDigest,
        }));
      }
      throw error;
    }
  }

  async function claimRecallPointObservationRead(work) {
    const selected = canonicalWork(work);
    const snapshot = await readSnapshot(selected);
    const { record, redisNowMs } = snapshot;
    if (TERMINAL_STATUSES.has(record.status)) {
      return completeClaim(record);
    }
    const intervalDeadline = Math.min(
      record.createdAtMs
        + SOURCE_RECALL_POINT_OBSERVATION_MAX_INTERVAL_MS,
      record.expiresAtMs,
    );
    if (redisNowMs >= intervalDeadline) {
      const settled = await settleUnresolved(
        snapshot,
        "point_interval_expired",
      );
      return TERMINAL_STATUSES.has(settled.record.status)
        ? completeClaim(settled.record)
        : inProgressClaim(settled.record);
    }
    if (record.activeClaim !== null) {
      if (record.activeClaim.expiresAtMs > redisNowMs) {
        return inProgressClaim(record);
      }
      const settled = await settleUnresolved(
        snapshot,
        "point_claim_abandoned",
      );
      return TERMINAL_STATUSES.has(settled.record.status)
        ? completeClaim(settled.record)
        : inProgressClaim(settled.record);
    }
    if (
      intervalDeadline - redisNowMs
        <= SOURCE_RECALL_POINT_OBSERVATION_READ_MIN_BUDGET_MS
    ) {
      const settled = await settleUnresolved(
        snapshot,
        "point_interval_expired",
      );
      return TERMINAL_STATUSES.has(settled.record.status)
        ? completeClaim(settled.record)
        : inProgressClaim(settled.record);
    }
    const readNumber = record.status === "awaiting_read_1"
      ? 1
      : record.status === "awaiting_read_2"
        ? 2
        : null;
    if (readNumber === null) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_DURABLE_STATE_INVALID",
      );
    }
    const claimNonceDigest =
      randomBytes(32).toString("hex");
    const reservationId =
      randomBytes(32).toString("hex");
    const claimExpiresAtMs = Math.min(
      redisNowMs
        + SOURCE_RECALL_POINT_OBSERVATION_CLAIM_LEASE_MS,
      intervalDeadline,
    );
    const nextValue = clone(record);
    nextValue.status = `reading_${readNumber}`;
    nextValue.activeClaim = {
      claimNonceDigest,
      expiresAtMs: claimExpiresAtMs,
      issuedAtMs: redisNowMs,
      readNumber,
      reservationId,
    };
    nextValue.updatedAtMs = redisNowMs;
    nextValue.revision += 1;
    const next = validateObservationRecord(nextValue);
    let stored;
    try {
      stored = await compareAndSet(
        snapshot,
        next,
        intervalDeadline,
      );
    } catch (error) {
      if (
        error
          instanceof SourceRecallPointObservationStoreError
        && error.code
          === "SOURCE_RECALL_POINT_OBSERVATION_CAS_CONFLICT"
      ) {
        return postConflictClaim(selected);
      }
      throw error;
    }
    const claim = deepFreeze({
      status: "read_required",
      workKeyDigest: stored.record.workKeyDigest,
      runNonceDigest: stored.record.runNonceDigest,
      decisionBoundaryAtMs:
        stored.record.decisionBoundaryAtMs,
      contractPinsDigest:
        stored.record.contractPinsDigest,
      workItemDigest: stored.record.workItemDigest,
      claimNonceDigest,
      readNumber,
      reservationId,
      contextDigest: stored.record.contextDigest,
      expectedReference: stored.record.expectedReference,
      firstEvidence: readNumber === 1
        ? null
        : stored.record.firstEvidence,
    });
    issuedClaims.set(claim, stored);
    return claim;
  }

  function canonicalIssuedClaim(value) {
    const code =
      "SOURCE_RECALL_POINT_OBSERVATION_CLAIM_INVALID";
    const claim = exactRecord(value, CLAIM_RESULT_KEYS, code);
    if (
      !Object.isFrozen(value)
      || claim.status !== "read_required"
      || ![1, 2].includes(claim.readNumber)
      || !issuedClaims.has(value)
    ) {
      fail(code);
    }
    for (const key of [
      "claimNonceDigest",
      "contextDigest",
      "contractPinsDigest",
      "reservationId",
      "runNonceDigest",
      "workItemDigest",
      "workKeyDigest",
    ]) {
      exactDigest(claim[key], code);
    }
    safeInteger(claim.decisionBoundaryAtMs, code);
    const expectedReference = canonicalReference(
      claim.expectedReference,
      claim.decisionBoundaryAtMs,
      code,
    );
    const firstEvidence = claim.readNumber === 1
      ? claim.firstEvidence
      : canonicalEvidence(claim.firstEvidence, code);
    if (
      (claim.readNumber === 1 && firstEvidence !== null)
      || (claim.readNumber === 2 && firstEvidence === null)
    ) {
      fail(code);
    }
    const snapshot = issuedClaims.get(value);
    const active = snapshot.record.activeClaim;
    if (
      active === null
      || active.claimNonceDigest !== claim.claimNonceDigest
      || active.readNumber !== claim.readNumber
      || active.reservationId !== claim.reservationId
      || snapshot.record.workKeyDigest
        !== claim.workKeyDigest
      || snapshot.record.runNonceDigest !== claim.runNonceDigest
      || snapshot.record.decisionBoundaryAtMs
        !== claim.decisionBoundaryAtMs
      || snapshot.record.contractPinsDigest
        !== claim.contractPinsDigest
      || snapshot.record.workItemDigest
        !== claim.workItemDigest
      || snapshot.record.contextDigest !== claim.contextDigest
      || canonicalJson(snapshot.record.expectedReference)
        !== canonicalJson(expectedReference)
      || canonicalJson(snapshot.record.firstEvidence)
        !== canonicalJson(firstEvidence)
    ) {
      fail(code);
    }
    return deepFreeze({
      claim,
      expectedReference,
      firstEvidence,
      snapshot,
    });
  }

  async function checkpointRecallPointObservationRead(
    claimValue,
    checkpointValue,
  ) {
    const issued = canonicalIssuedClaim(claimValue);
    const code =
      "SOURCE_RECALL_POINT_OBSERVATION_CHECKPOINT_INVALID";
    const checkpoint = exactRecord(
      checkpointValue,
      CHECKPOINT_INPUT_KEYS,
      code,
    );
    if (!Object.isFrozen(checkpointValue)) fail(code);
    const evidence = canonicalEvidence(
      checkpoint.evidence,
      code,
    );
    const receipt = canonicalReceipt(
      checkpoint.transportReceipt,
      {
        contextDigest: issued.claim.contextDigest,
        expectedBotId: issued.expectedReference.id,
        readNumber: issued.claim.readNumber,
        reservationId: issued.claim.reservationId,
      },
      code,
    );
    const nowMs = timeResult(await persistence.time());
    const active = issued.snapshot.record.activeClaim;
    if (
      nowMs < issued.snapshot.redisNowMs
      || nowMs >= active.expiresAtMs
      || nowMs >= issued.snapshot.record.expiresAtMs
      || nowMs >= issued.snapshot.record.createdAtMs
        + SOURCE_RECALL_POINT_OBSERVATION_MAX_INTERVAL_MS
    ) {
      issuedClaims.delete(claimValue);
      fail("SOURCE_RECALL_POINT_OBSERVATION_CLAIM_EXPIRED");
    }
    const nextValue = clone(issued.snapshot.record);
    const observation = {
      completedAtMs: nowMs,
      evidence,
      transportReceipt: receipt,
    };
    nextValue.activeClaim = null;
    nextValue.updatedAtMs = nowMs;
    nextValue.revision += 1;
    if (issued.claim.readNumber === 1) {
      nextValue.status = "awaiting_read_2";
      nextValue.readOne = observation;
      nextValue.firstEvidence = evidence;
      nextValue.firstTransportReceipt = receipt;
    } else {
      if (
        issued.snapshot.record.firstTransportReceipt
          .reservationId === receipt.reservationId
      ) {
        issuedClaims.delete(claimValue);
        fail(code);
      }
      const stable = canonicalJson(
        issued.snapshot.record.firstEvidence,
      ) === canonicalJson(evidence);
      nextValue.status = stable ? "stable" : "conflict";
      nextValue.readTwo = observation;
      nextValue.resolutionDigest = semanticDigest(
        "phase4-recall-point-observation-resolution-v1",
        {
          workKeyDigest:
            issued.snapshot.record.workKeyDigest,
          status: nextValue.status,
          firstEvidence:
            issued.snapshot.record.firstEvidence,
          firstTransportReceipt:
            issued.snapshot.record.firstTransportReceipt,
          secondEvidence: evidence,
          secondTransportReceipt: receipt,
        },
      );
    }
    const next = validateObservationRecord(nextValue);
    issuedClaims.delete(claimValue);
    return compareAndSet(
      issued.snapshot,
      next,
      active.expiresAtMs,
    );
  }

  async function recordRecallPointObservationUnresolved(
    claimValue,
    reason,
  ) {
    const issued = canonicalIssuedClaim(claimValue);
    if (
      ![
        "point_read_failed",
        "point_response_invalid",
      ].includes(reason)
    ) {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_FAILURE_REASON_INVALID",
      );
    }
    const nowMs = timeResult(await persistence.time());
    const active = issued.snapshot.record.activeClaim;
    if (
      nowMs < issued.snapshot.redisNowMs
      || nowMs >= active.expiresAtMs
      || nowMs >= issued.snapshot.record.expiresAtMs
    ) {
      issuedClaims.delete(claimValue);
      fail("SOURCE_RECALL_POINT_OBSERVATION_CLAIM_EXPIRED");
    }
    const next = terminalized(
      issued.snapshot.record,
      reason,
      nowMs,
    );
    issuedClaims.delete(claimValue);
    return compareAndSet(
      issued.snapshot,
      next,
      active.expiresAtMs,
    );
  }

  async function readRecallPointObservationWork(work) {
    return readSnapshot(work);
  }

  return deepFreeze({
    checkpointRecallPointObservationRead,
    claimRecallPointObservationRead,
    prepareRecallPointObservationWork,
    readRecallPointObservationWork,
    recallPointObservationAggregateStatus,
    recordRecallPointObservationUnresolved,
  });
}

let defaultStore = null;

function productionStore() {
  if (defaultStore === null) {
    defaultStore = createSourceRecallPointObservationStore({
      persistence:
        createSourceRecallPointObservationPersistenceAdapter(),
    });
  }
  return defaultStore;
}

export function prepareRecallPointObservationWork(verifiedPage) {
  return productionStore()
    .prepareRecallPointObservationWork(verifiedPage);
}

export function claimRecallPointObservationRead(work) {
  return productionStore()
    .claimRecallPointObservationRead(work);
}

export function checkpointRecallPointObservationRead(
  claim,
  checkpoint,
) {
  return productionStore()
    .checkpointRecallPointObservationRead(
      claim,
      checkpoint,
    );
}

export function recordRecallPointObservationUnresolved(
  claim,
  reason,
) {
  return productionStore()
    .recordRecallPointObservationUnresolved(claim, reason);
}

export function readRecallPointObservationWork(work) {
  return productionStore()
    .readRecallPointObservationWork(work);
}
