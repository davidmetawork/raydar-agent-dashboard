// Pure, hard-dark Paraform Human source point scaffold.
//
// The exhaustive page reader emits a complete private source reference.
// Sanitized read-only contract capture proves that getCallById repeats the
// root id, scheduled time, title, platform, candidate-user id, candidate name,
// and attendee emails. It does not return the page owner, has_transcript flag,
// or candidate LinkedIn. This module verifies only those proven point fields
// and binds the complete page reference, but deliberately does not invent full
// continuity or a source-record revision.
//
// The private projection may contain source identifiers and candidate hints.
// Its evidence projection contains digests only. No transcript, response body,
// classifier, identity resolver, source head, receipt signer, or authority
// transition is exported.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  SOURCE_IDENTITY_POINT_READ_PROCEDURES,
} from "./source-watermark.mjs";

export const SOURCE_PARAFORM_HUMAN_POINT_COLLECTOR_VERSION =
  "paraform-human-source-point-scaffold-v1";

const SOURCE = "paraform_human";
const MAX_REFERENCE_JSON_BYTES = 131_072;
const MAX_REFERENCE_EMAILS = 512;

export class SourceParaformHumanPointCollectorError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceParaformHumanPointCollectorError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceParaformHumanPointCollectorError(code);
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
    fail("SOURCE_PARAFORM_HUMAN_POINT_SYMBOL_INVALID");
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
      fail("SOURCE_PARAFORM_HUMAN_POINT_ACCESSOR_INVALID");
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
    if (value.length > MAX_REFERENCE_EMAILS) fail(code);
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
  const result = Object.create(null);
  for (const [key, child] of Object.entries(record)) {
    // Provider-controlled "__proto__" remains an ordinary own key on this
    // null-prototype reconstruction and can never synthesize inherited fields.
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

function boundedText(
  value,
  {
    code,
    maximum,
    allowEmpty = true,
    lowercase = false,
    collapseWhitespace = false,
  },
) {
  if (typeof value !== "string") fail(code);
  if (/[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  let normalized = lowercase ? value.toLowerCase() : value;
  normalized = normalized.trim();
  if (collapseWhitespace) {
    normalized = normalized.replace(/\s+/gu, " ");
  }
  if (
    (!allowEmpty && normalized.length === 0)
    || normalized.length > maximum
  ) {
    fail(code);
  }
  return normalized;
}

function exactPageText(
  value,
  {
    maximum,
    allowEmpty = true,
    lowercase = false,
    collapseWhitespace = false,
  },
) {
  const code = "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID";
  const normalized = boundedText(value, {
    code,
    maximum,
    allowEmpty,
    lowercase,
    collapseWhitespace,
  });
  if (normalized !== value) fail(code);
  return normalized;
}

function exactSourceId(value, code) {
  const normalized = boundedText(value, {
    code,
    maximum: 256,
    allowEmpty: false,
  });
  if (normalized !== value) fail(code);
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
    "SOURCE_PARAFORM_HUMAN_POINT_BOUNDARY_INVALID",
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

function canonicalPageEmails(value) {
  if (
    !Array.isArray(value)
    || value.length > MAX_REFERENCE_EMAILS
  ) {
    fail("SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID");
  }
  return deepFreeze(value.map((email) => exactPageText(
    email,
    {
      maximum: 512,
      allowEmpty: false,
      lowercase: true,
      collapseWhitespace: true,
    },
  )));
}

function normalizePointEmails(value) {
  const snapshot = jsonSnapshot(
    value,
    "SOURCE_PARAFORM_HUMAN_POINT_ATTENDEE_EMAILS_INVALID",
  );
  if (
    !Array.isArray(snapshot)
    || snapshot.length > MAX_REFERENCE_EMAILS
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_POINT_ATTENDEE_EMAILS_INVALID",
    );
  }
  return deepFreeze(snapshot
    .map((email) => boundedText(email, {
      code:
        "SOURCE_PARAFORM_HUMAN_POINT_ATTENDEE_EMAILS_INVALID",
      maximum: 512,
      lowercase: true,
      collapseWhitespace: true,
    }))
    .filter(Boolean));
}

// This mirrors exactly the private shape emitted by
// readParaformHumanSourcePage(). It validates the server-held reference; it
// does not claim that getCallById has a captured equivalent for every field.
function canonicalExpectedReference(
  value,
  decisionBoundaryAt,
) {
  const snapshot = jsonSnapshot(
    value,
    "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
  );
  if (
    Buffer.byteLength(JSON.stringify(snapshot), "utf8")
      > MAX_REFERENCE_JSON_BYTES
  ) {
    fail("SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_TOO_LARGE");
  }
  const reference = plainRecordSnapshot(
    snapshot,
    "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
  );
  exactKeys(
    reference,
    [
      "id",
      "scheduledAt",
      "title",
      "platform",
      "owner",
      "candidateUserId",
      "hasTranscript",
      "candidate",
    ],
    "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
  );
  const candidate = plainRecordSnapshot(
    reference.candidate,
    "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
  );
  exactKeys(
    candidate,
    ["name", "linkedin", "emails"],
    "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
  );
  const scheduledAt = canonicalMillisecondUtc(
    reference.scheduledAt,
    "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
  );
  if (
    Date.parse(scheduledAt)
      >= Date.parse(decisionBoundaryAt)
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_POINT_SCHEDULED_AT_OUTSIDE_BOUNDARY",
    );
  }
  if (
    reference.hasTranscript !== null
    && typeof reference.hasTranscript !== "boolean"
  ) {
    fail("SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID");
  }
  return deepFreeze({
    id: exactSourceId(
      reference.id,
      "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
    ),
    scheduledAt,
    title: exactPageText(
      reference.title,
      { maximum: 4_096 },
    ),
    platform: exactPageText(
      reference.platform,
      { maximum: 256 },
    ),
    owner: exactPageText(
      reference.owner,
      { maximum: 512 },
    ),
    candidateUserId: exactPageText(
      reference.candidateUserId,
      { maximum: 256 },
    ),
    hasTranscript: reference.hasTranscript,
    candidate: {
      name: exactPageText(
        candidate.name,
        { maximum: 512 },
      ),
      linkedin: exactPageText(
        candidate.linkedin,
        { maximum: 4_096 },
      ),
      emails: canonicalPageEmails(candidate.emails),
    },
  });
}

function normalizedOptions(value) {
  const options = plainRecordSnapshot(
    value,
    "SOURCE_PARAFORM_HUMAN_POINT_OPTIONS_INVALID",
  );
  exactKeys(
    options,
    ["decisionBoundaryAt", "expectedReference"],
    "SOURCE_PARAFORM_HUMAN_POINT_OPTIONS_INVALID",
  );
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

export function paraformHumanSourcePointReadRequest(callId) {
  const id = exactSourceId(
    callId,
    "SOURCE_PARAFORM_HUMAN_POINT_INPUT_INVALID",
  );
  return deepFreeze({
    method: "GET",
    procedure:
      SOURCE_IDENTITY_POINT_READ_PROCEDURES
        .paraformHumanSource,
    input: {
      json: {
        id,
      },
    },
  });
}

export function normalizeParaformHumanSourcePointRecord(
  raw,
  options = {},
) {
  const {
    decisionBoundaryAt,
    expectedReference,
  } = normalizedOptions(options);
  const record = plainRecordSnapshot(
    raw,
    "SOURCE_PARAFORM_HUMAN_POINT_RECORD_INVALID",
  );
  const callId = exactSourceId(
    record.id,
    "SOURCE_PARAFORM_HUMAN_POINT_RECORD_ID_INVALID",
  );
  if (callId !== expectedReference.id) {
    fail("SOURCE_PARAFORM_HUMAN_POINT_EXPECTED_ID_MISMATCH");
  }
  const scheduledAt = canonicalVendorTimestamp(
    record.event_scheduled_at,
    "SOURCE_PARAFORM_HUMAN_POINT_SCHEDULED_AT_INVALID",
  );
  const boundary = canonicalVendorTimestamp(
    decisionBoundaryAt,
    "SOURCE_PARAFORM_HUMAN_POINT_BOUNDARY_INVALID",
  );
  if (
    scheduledAt.epochNanoseconds
      >= boundary.epochNanoseconds
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_POINT_SCHEDULED_AT_OUTSIDE_BOUNDARY",
    );
  }
  const candidateUser = plainRecordSnapshot(
    record.candidate_user,
    "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_USER_INVALID",
  );
  const candidate = plainRecordSnapshot(
    candidateUser.candidate,
    "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_INVALID",
  );
  const projection = {
    source: SOURCE,
    callId,
    scheduledAt: scheduledAt.canonical,
    enumeratedScheduledAt:
      scheduledAt.millisecondCanonical,
    title: boundedText(record.event_title, {
      code: "SOURCE_PARAFORM_HUMAN_POINT_TITLE_INVALID",
      maximum: 4_096,
    }),
    platform: boundedText(record.meeting_platform, {
      code: "SOURCE_PARAFORM_HUMAN_POINT_PLATFORM_INVALID",
      maximum: 256,
    }),
    candidateUserId: boundedText(
      record.candidate_user_id,
      {
        code:
          "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_USER_ID_INVALID",
        maximum: 256,
      },
    ),
    candidate: {
      name: boundedText(candidate.name, {
        code:
          "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_NAME_INVALID",
        maximum: 512,
      }),
      emails: normalizePointEmails(
        record.attendee_emails,
      ),
    },
    decisionBoundaryAt,
    pageReference: expectedReference,
    pointRecordIdVerified: true,
    partialReferenceContinuityVerified: true,
    completePointResponseContractAvailable: false,
    completeReferenceContinuityAvailable: false,
    sourceRecordRevisionAvailable: false,
    humanCallDiscriminatorAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
  };
  const partialReference = {
    id: projection.callId,
    scheduledAt: projection.enumeratedScheduledAt,
    title: projection.title,
    platform: projection.platform,
    candidateUserId: projection.candidateUserId,
    candidate: projection.candidate,
  };
  const expectedPartialReference = {
    id: expectedReference.id,
    scheduledAt: expectedReference.scheduledAt,
    title: expectedReference.title,
    platform: expectedReference.platform,
    candidateUserId: expectedReference.candidateUserId,
    candidate: {
      name: expectedReference.candidate.name,
      emails: expectedReference.candidate.emails,
    },
  };
  if (
    canonicalJson(partialReference)
      !== canonicalJson(expectedPartialReference)
  ) {
    fail("SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_MISMATCH");
  }
  return deepFreeze(projection);
}

export function paraformHumanSourcePointEvidence(
  raw,
  options = {},
) {
  const normalized = normalizedOptions(options);
  const projection =
    normalizeParaformHumanSourcePointRecord(
      raw,
      normalized,
    );
  const request = paraformHumanSourcePointReadRequest(
    projection.callId,
  );
  const sourceRecordDigest = semanticDigest(
    "phase4-paraform-human-source-record-v1",
    projection.callId,
  );
  // This commits the complete exhaustive-page artifact. It is not evidence
  // that the point response repeated the three uncaptured page-only fields.
  const referenceMaterial = {
    sourceRecordDigest,
    scheduledAt: normalized.expectedReference.scheduledAt,
    title: normalized.expectedReference.title,
    platform: normalized.expectedReference.platform,
    owner: normalized.expectedReference.owner,
    candidateUserId:
      normalized.expectedReference.candidateUserId,
    hasTranscript:
      normalized.expectedReference.hasTranscript,
    candidate: normalized.expectedReference.candidate,
  };
  const partialPointMaterial = {
    sourceRecordDigest,
    scheduledAt: projection.scheduledAt,
    enumeratedScheduledAt:
      projection.enumeratedScheduledAt,
    title: projection.title,
    platform: projection.platform,
    candidateUserId: projection.candidateUserId,
    candidate: projection.candidate,
  };
  return deepFreeze({
    source: SOURCE,
    sourcePointReadProcedure:
      SOURCE_IDENTITY_POINT_READ_PROCEDURES
        .paraformHumanSource,
    sourceNormalizedInputDigest: semanticDigest(
      "phase4-paraform-human-source-point-request-v1",
      request,
    ),
    sourceRecordDigest,
    sourceReferenceDigest: semanticDigest(
      "phase4-paraform-human-source-reference-v1",
      referenceMaterial,
    ),
    sourcePartialPointDigest: semanticDigest(
      "phase4-paraform-human-source-partial-point-v1",
      partialPointMaterial,
    ),
    decisionBoundaryDigest: semanticDigest(
      "phase4-source-decision-boundary-v1",
      normalized.decisionBoundaryAt,
    ),
    pointRecordIdVerified: true,
    partialReferenceContinuityVerified: true,
    completePointResponseContractAvailable: false,
    completeReferenceContinuityAvailable: false,
    sourceRecordRevisionAvailable: false,
    humanCallDiscriminatorAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
  });
}
