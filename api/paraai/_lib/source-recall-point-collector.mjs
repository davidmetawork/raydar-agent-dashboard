// Pure, hard-dark Recall source point projection.
//
// This module performs no network read and owns no durable state. It accepts
// the private response from the pinned Recall bot point read, binds it to the
// exact source reference and common capture boundary, and returns either a
// private normalized projection or digest-only evidence.
//
// A raw Recall bot is not sufficient to prove Raydar's success verdict:
// transcript, participant-presence, and Vapi evidence live outside this point
// response. This module therefore exports no success classifier, identity
// resolver, receipt signer, source-head commitment, or authority transition.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  SOURCE_IDENTITY_POINT_READ_PROCEDURES,
} from "./source-watermark.mjs";

export const SOURCE_RECALL_POINT_COLLECTOR_VERSION =
  "recall-source-point-projection-v1";

const SOURCE = "recall";
const BOT_NAME = "Raydar Screener";
const BOT_ID = /^[A-Za-z0-9_-]{5,128}$/u;
const STATUS_CODE = /^[a-z][a-z0-9_]{0,79}$/u;
const MAX_RAW_JSON_BYTES = 8_388_608;
const WORKFLOW_SOURCES = new Set([
  "paraform-auto",
  "paraform-auto-guardian",
  "paraform-reconciliation",
  "paraform-reconciliation-guardian",
  "fyxer-guardian-n8n",
  "fyxer-guardian-n8n-guardian",
]);
const FORBIDDEN_DERIVED_ROOT_FIELDS = Object.freeze([
  "classification",
  "presence",
  "provenanceVerified",
  "transcript",
  "vapi",
  "verdict",
]);
const STATUS_TIME_FIELDS = Object.freeze([
  "created_at",
  "updated_at",
]);

export class SourceRecallPointCollectorError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallPointCollectorError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallPointCollectorError(code);
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
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail("SOURCE_RECALL_POINT_SYMBOL_INVALID");
  }
  const snapshot = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value",
      )
      || descriptor.enumerable !== true
    ) {
      fail("SOURCE_RECALL_POINT_ACCESSOR_INVALID");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
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
    const expected = [
      ...Array.from(
        { length: value.length },
        (_unused, index) => String(index),
      ),
      "length",
    ].sort();
    const actual = Object.keys(descriptors).sort();
    if (
      Object.getOwnPropertySymbols(value).length !== 0
      || actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])
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
  const record = plainRecordSnapshot(value, code);
  // Provider-controlled JSON keys must never invoke Object.prototype's
  // legacy __proto__ setter or become inherited required fields.
  const result = Object.create(null);
  for (const [key, child] of Object.entries(record)) {
    result[key] = jsonSnapshot(child, code, seen);
  }
  seen.delete(value);
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

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical digest values must be finite");
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
  throw new TypeError("canonical digest values must be JSON-safe");
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function exactBotId(value, code) {
  if (typeof value !== "string" || !BOT_ID.test(value)) {
    fail(code);
  }
  return value;
}

function boundedText(
  value,
  {
    code,
    maximum,
    allowEmpty = true,
    lowercase = false,
  },
) {
  if (typeof value !== "string") fail(code);
  if (/[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  const normalized = (
    lowercase ? value.toLowerCase() : value
  ).trim();
  if (
    (!allowEmpty && normalized.length === 0)
    || normalized.length > maximum
  ) {
    fail(code);
  }
  return normalized;
}

function canonicalMillisecondUtc(value, code) {
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

function canonicalBoundary(value) {
  return canonicalMillisecondUtc(
    value,
    "SOURCE_RECALL_POINT_BOUNDARY_INVALID",
  );
}

function canonicalVendorTimestamp(value, code) {
  const match = typeof value === "string"
    ? value.match(
      /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,9}))?(Z|([+-])([0-9]{2}):([0-9]{2}))$/u,
    )
    : null;
  if (!match) fail(code);
  const [
    ,
    localSecond,
    fraction = "",
    zone,
    offsetSign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const localSecondMs = Date.parse(`${localSecond}.000Z`);
  if (
    !Number.isFinite(localSecondMs)
    || new Date(localSecondMs).toISOString().slice(0, 19)
      !== localSecond
  ) {
    fail(code);
  }
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (
      !Number.isSafeInteger(offsetHours)
      || !Number.isSafeInteger(offsetMinute)
      || offsetHours > 23
      || offsetMinute > 59
    ) {
      fail(code);
    }
    offsetMinutes = (
      offsetHours * 60 + offsetMinute
    ) * (offsetSign === "+" ? 1 : -1);
  }
  const utcSecondMs =
    localSecondMs - offsetMinutes * 60_000;
  if (!Number.isFinite(utcSecondMs)) fail(code);
  const fractionNanoseconds = fraction.padEnd(9, "0");
  const epochNanoseconds =
    BigInt(utcSecondMs) * 1_000_000n
    + BigInt(fractionNanoseconds);
  const utcSecond = new Date(utcSecondMs)
    .toISOString()
    .slice(0, 19);
  const epochMilliseconds = epochNanoseconds >= 0n
    ? epochNanoseconds / 1_000_000n
    : (epochNanoseconds - 999_999n) / 1_000_000n;
  return Object.freeze({
    canonical:
      `${utcSecond}.${fractionNanoseconds}Z`,
    epochNanoseconds,
    millisecondCanonical: new Date(
      Number(epochMilliseconds),
    ).toISOString(),
  });
}

function metadataText(
  metadata,
  key,
  {
    maximum,
    lowercase = false,
  },
) {
  if (!Object.prototype.hasOwnProperty.call(metadata, key)) {
    return "";
  }
  return boundedText(metadata[key], {
    code: "SOURCE_RECALL_POINT_METADATA_INVALID",
    maximum,
    lowercase,
  });
}

function normalizeCandidateHints(metadata) {
  const fullNameValue = (
    Object.prototype.hasOwnProperty.call(
      metadata,
      "candidate_full_name",
    )
    && metadata.candidate_full_name
  ) || (
    Object.prototype.hasOwnProperty.call(
      metadata,
      "candidate_first_name",
    )
    && metadata.candidate_first_name
  ) || "";
  return deepFreeze({
    fullName: boundedText(fullNameValue, {
      code: "SOURCE_RECALL_POINT_METADATA_INVALID",
      maximum: 512,
    }),
    email: metadataText(
      metadata,
      "candidate_email",
      { maximum: 512, lowercase: true },
    ),
    linkedin: metadataText(
      metadata,
      "candidate_linkedin",
      { maximum: 4_096 },
    ),
    paraformEventId: metadataText(
      metadata,
      "paraform_event_id",
      { maximum: 1_024 },
    ),
  });
}

function exactKeys(record, expected, code) {
  const keys = Object.keys(record).sort();
  const exact = [...expected].sort();
  if (
    keys.length !== exact.length
    || keys.some((key, index) => key !== exact[index])
  ) {
    fail(code);
  }
}

function exactReferenceText(
  value,
  {
    maximum,
    lowercase = false,
    code = "SOURCE_RECALL_POINT_REFERENCE_INVALID",
  },
) {
  const normalized = boundedText(value, {
    code,
    maximum,
    lowercase,
  });
  if (normalized !== value) fail(code);
  return normalized;
}

// This is the exact private shape emitted by the exhaustive Recall source page
// reader. It is server-held input only: no raw reference is returned by the
// public evidence projection.
function canonicalExpectedReference(
  value,
  decisionBoundaryAt,
) {
  const reference = plainRecordSnapshot(
    value,
    "SOURCE_RECALL_POINT_REFERENCE_INVALID",
  );
  exactKeys(
    reference,
    ["id", "joinAt", "metadataSource", "candidate"],
    "SOURCE_RECALL_POINT_REFERENCE_INVALID",
  );
  const candidate = plainRecordSnapshot(
    reference.candidate,
    "SOURCE_RECALL_POINT_REFERENCE_INVALID",
  );
  exactKeys(
    candidate,
    ["fullName", "email", "linkedin", "paraformEventId"],
    "SOURCE_RECALL_POINT_REFERENCE_INVALID",
  );
  const id = exactBotId(
    reference.id,
    "SOURCE_RECALL_POINT_REFERENCE_INVALID",
  );
  const joinAt = canonicalMillisecondUtc(
    reference.joinAt,
    "SOURCE_RECALL_POINT_REFERENCE_INVALID",
  );
  if (
    Date.parse(joinAt) >= Date.parse(decisionBoundaryAt)
  ) {
    fail("SOURCE_RECALL_POINT_REFERENCE_INVALID");
  }
  if (
    typeof reference.metadataSource !== "string"
    || !WORKFLOW_SOURCES.has(reference.metadataSource)
  ) {
    fail("SOURCE_RECALL_POINT_REFERENCE_INVALID");
  }
  return deepFreeze({
    id,
    joinAt,
    metadataSource: reference.metadataSource,
    candidate: {
      fullName: exactReferenceText(
        candidate.fullName,
        { maximum: 512 },
      ),
      email: exactReferenceText(
        candidate.email,
        { maximum: 512, lowercase: true },
      ),
      linkedin: exactReferenceText(
        candidate.linkedin,
        { maximum: 4_096 },
      ),
      paraformEventId: exactReferenceText(
        candidate.paraformEventId,
        { maximum: 1_024 },
      ),
    },
  });
}

function normalizeStatusChanges(
  raw,
  decisionBoundaryAt,
) {
  if (!Array.isArray(raw)) {
    fail("SOURCE_RECALL_POINT_STATUS_CHANGES_INVALID");
  }
  const boundaryNanoseconds = canonicalVendorTimestamp(
    decisionBoundaryAt,
    "SOURCE_RECALL_POINT_BOUNDARY_INVALID",
  ).epochNanoseconds;
  let priorAtBoundaryNanoseconds = null;
  let postBoundaryObserved = false;
  const atBoundary = [];
  for (const value of raw) {
    const status = plainRecordSnapshot(
      value,
      "SOURCE_RECALL_POINT_STATUS_CHANGE_INVALID",
    );
    const timeFields = STATUS_TIME_FIELDS.filter(
      (field) => Object.prototype.hasOwnProperty.call(
        status,
        field,
      ),
    );
    if (timeFields.length !== 1) {
      fail("SOURCE_RECALL_POINT_STATUS_TIME_INVALID");
    }
    const observed = canonicalVendorTimestamp(
      status[timeFields[0]],
      "SOURCE_RECALL_POINT_STATUS_TIME_INVALID",
    );
    if (observed.epochNanoseconds > boundaryNanoseconds) {
      // Future vendor status/subcode shapes cannot rewrite evidence at the
      // capture boundary. Timestamps remain mandatory so a later <=T re-entry
      // still exposes a non-canonical provider timeline.
      postBoundaryObserved = true;
      continue;
    }
    if (
      postBoundaryObserved
      || (
        priorAtBoundaryNanoseconds !== null
        && observed.epochNanoseconds
          < priorAtBoundaryNanoseconds
      )
    ) {
      fail("SOURCE_RECALL_POINT_STATUS_ORDER_INVALID");
    }
    priorAtBoundaryNanoseconds =
      observed.epochNanoseconds;
    if (
      typeof status.code !== "string"
      || !STATUS_CODE.test(status.code)
    ) {
      fail("SOURCE_RECALL_POINT_STATUS_CODE_INVALID");
    }
    let subCode = null;
    if (status.sub_code != null) {
      subCode = boundedText(status.sub_code, {
        code: "SOURCE_RECALL_POINT_STATUS_SUBCODE_INVALID",
        maximum: 256,
        allowEmpty: false,
      });
    }
    atBoundary.push({
      code: status.code,
      subCode,
      observedAt: observed.canonical,
    });
  }
  return deepFreeze(atBoundary);
}

// Recording artifacts are deliberately not consumed or committed by this
// point projection. Only their root container is checked; transcript/presence
// validation belongs to the future classifier that can actually use them.
function validateRecordingsContainer(raw) {
  if (!Array.isArray(raw)) {
    fail("SOURCE_RECALL_POINT_RECORDINGS_INVALID");
  }
}

function normalizedOptions(value) {
  const options = plainRecordSnapshot(
    value,
    "SOURCE_RECALL_POINT_OPTIONS_INVALID",
  );
  const keys = Object.keys(options).sort();
  if (
    keys.length !== 2
    || keys[0] !== "decisionBoundaryAt"
    || keys[1] !== "expectedReference"
  ) {
    fail("SOURCE_RECALL_POINT_OPTIONS_INVALID");
  }
  const decisionBoundaryAt = canonicalBoundary(
    options.decisionBoundaryAt,
  );
  return {
    decisionBoundaryAt,
    expectedReference: canonicalExpectedReference(
      options.expectedReference,
      decisionBoundaryAt,
    ),
  };
}

export function recallSourcePointReadRequest(botId) {
  const exactId = exactBotId(
    botId,
    "SOURCE_RECALL_POINT_INPUT_INVALID",
  );
  return deepFreeze({
    method: "GET",
    path: `/api/v1/bot/${exactId}/`,
  });
}

export function normalizeRecallSourcePointRecord(
  raw,
  options = {},
) {
  const {
    expectedReference,
    decisionBoundaryAt,
  } = normalizedOptions(options);
  const record = jsonSnapshot(
    raw,
    "SOURCE_RECALL_POINT_RECORD_INVALID",
  );
  if (
    Buffer.byteLength(JSON.stringify(record), "utf8")
      > MAX_RAW_JSON_BYTES
  ) {
    fail("SOURCE_RECALL_POINT_RECORD_TOO_LARGE");
  }
  for (const field of FORBIDDEN_DERIVED_ROOT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      fail("SOURCE_RECALL_POINT_DERIVED_EVIDENCE_FORBIDDEN");
    }
  }
  const botId = exactBotId(
    record.id,
    "SOURCE_RECALL_POINT_RECORD_ID_INVALID",
  );
  if (botId !== expectedReference.id) {
    fail("SOURCE_RECALL_POINT_EXPECTED_ID_MISMATCH");
  }
  if (record.bot_name !== BOT_NAME) {
    fail("SOURCE_RECALL_POINT_BOT_NAME_INVALID");
  }
  const joinAt = canonicalVendorTimestamp(
    record.join_at,
    "SOURCE_RECALL_POINT_JOIN_AT_INVALID",
  );
  const boundary = canonicalVendorTimestamp(
    decisionBoundaryAt,
    "SOURCE_RECALL_POINT_BOUNDARY_INVALID",
  );
  if (
    joinAt.epochNanoseconds >= boundary.epochNanoseconds
  ) {
    fail("SOURCE_RECALL_POINT_JOIN_AT_OUTSIDE_BOUNDARY");
  }
  const metadata = plainRecordSnapshot(
    record.metadata,
    "SOURCE_RECALL_POINT_METADATA_INVALID",
  );
  if (
    typeof metadata.source !== "string"
    || !WORKFLOW_SOURCES.has(metadata.source)
  ) {
    fail("SOURCE_RECALL_POINT_PROVENANCE_INVALID");
  }
  if (!Object.prototype.hasOwnProperty.call(record, "status_changes")) {
    fail("SOURCE_RECALL_POINT_STATUS_CHANGES_INVALID");
  }
  if (!Object.prototype.hasOwnProperty.call(record, "recordings")) {
    fail("SOURCE_RECALL_POINT_RECORDINGS_INVALID");
  }
  const statusChangesAtBoundary = normalizeStatusChanges(
    record.status_changes,
    decisionBoundaryAt,
  );
  validateRecordingsContainer(record.recordings);
  const projection = {
    source: SOURCE,
    botId,
    botName: BOT_NAME,
    joinAt: joinAt.canonical,
    enumeratedJoinAt: joinAt.millisecondCanonical,
    metadataSource: metadata.source,
    candidate: normalizeCandidateHints(metadata),
    statusChangesAtBoundary,
  };
  const pointReference = {
    id: projection.botId,
    joinAt: projection.enumeratedJoinAt,
    metadataSource: projection.metadataSource,
    candidate: projection.candidate,
  };
  if (
    canonicalJson(pointReference)
      !== canonicalJson(expectedReference)
  ) {
    fail("SOURCE_RECALL_POINT_REFERENCE_MISMATCH");
  }
  return deepFreeze(projection);
}

export function recallSourcePointEvidence(
  raw,
  options = {},
) {
  const normalized = normalizedOptions(options);
  const projection = normalizeRecallSourcePointRecord(
    raw,
    normalized,
  );
  const request = recallSourcePointReadRequest(
    projection.botId,
  );
  const sourceRecordDigest = semanticDigest(
    "phase4-recall-source-record-v1",
    projection.botId,
  );
  const referenceMaterial = {
    sourceRecordDigest,
    joinAt: normalized.expectedReference.joinAt,
    metadataSource:
      normalized.expectedReference.metadataSource,
    candidate: normalized.expectedReference.candidate,
  };
  const statusMaterial = {
    sourceRecordDigest,
    decisionBoundaryAt: normalized.decisionBoundaryAt,
    statusChangesAtBoundary:
      projection.statusChangesAtBoundary,
  };
  return deepFreeze({
    source: SOURCE,
    sourcePointReadProcedure:
      SOURCE_IDENTITY_POINT_READ_PROCEDURES.recallSource,
    sourceNormalizedInputDigest: semanticDigest(
      "phase4-recall-source-point-input-v1",
      request,
    ),
    sourceRecordDigest,
    sourceReferenceDigest: semanticDigest(
      "phase4-recall-source-reference-v1",
      referenceMaterial,
    ),
    sourceProvenanceDigest: semanticDigest(
      "phase4-recall-source-provenance-v1",
      {
        sourceRecordDigest,
        botName: projection.botName,
        metadataSource: projection.metadataSource,
      },
    ),
    sourceStatusAtBoundaryDigest: semanticDigest(
      "phase4-recall-source-status-at-boundary-v1",
      statusMaterial,
    ),
    sourceRecordRevisionDigest: semanticDigest(
      "phase4-recall-source-point-semantic-revision-v1",
      {
        referenceMaterial,
        joinAt: projection.joinAt,
        statusMaterial,
      },
    ),
    decisionBoundaryDigest: semanticDigest(
      "phase4-source-decision-boundary-v1",
      normalized.decisionBoundaryAt,
    ),
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
  });
}
