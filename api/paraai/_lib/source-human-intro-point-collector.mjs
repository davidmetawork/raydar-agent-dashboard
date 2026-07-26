// Pure, hard-dark Human Intro durable-intake projection.
//
// A signed Calendar intake can create a durable `hi-` job, but the persisted
// job does not retain the HMAC verification receipt and does not prove that the
// scheduled conversation occurred. This module validates only the exact
// durable intake already present on that job and keeps every unavailable
// source capability explicit.
//
// The private projection contains intake identifiers and candidate hints. Its
// evidence projection contains domain-separated digests only. This module has
// no transport, persistence, coordinator integration, release pin, or write
// surface.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

export const SOURCE_HUMAN_INTRO_POINT_COLLECTOR_VERSION =
  "human-intro-source-point-scaffold-v1";

const SOURCE = "human_intro";
const HUMAN_INTRO_SOURCE =
  "google_calendar_calendly_role_chat";
const HUMAN_INTRO_PARSER_VERSION =
  "calendly-role-chat-v1";
const JOB_ID = /^hi-[a-f0-9]{64}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CANONICAL_INSTANT =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const MAX_RECORD_KEYS = 128;
const MAX_TEXT_LENGTH = 4_096;
const INTERNAL_EMAIL_SUFFIXES = Object.freeze([
  "@paraform.com",
  "@raydar.xyz",
  "@raydargroup.com",
]);
const RESUME_LINK_DISPOSITIONS = new Set([
  "none",
  "unusable",
  "ambiguous",
  "received",
  "received_review",
]);
const RESUME_RECEIPT_STATUSES = new Set([
  "received",
  "received_review",
]);
const RESUME_RECEIPT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/rtf",
]);
const OPTIONS_KEYS = Object.freeze([
  "decisionBoundaryAt",
]);
const CANDIDATE_KEYS = Object.freeze([
  "email",
  "firstName",
  "fullName",
  "linkedin",
  "paraformEventId",
  "phone",
  "scheduledStart",
].sort());
const METADATA_KEYS = Object.freeze([
  "bookingCreatedAt",
  "bookingCreatedAtSource",
  "calendarIntro",
  "intakeEventId",
  "manualOnly",
  "parserVersion",
  "payloadDigest",
  "platform",
  "population",
  "profileOnly",
  "provenanceVerified",
  "resumeLinkDisposition",
  "resumeReceipt",
  "source",
  "sourceId",
  "speakerHeuristic",
  "substance",
  "transcriptPresent",
].sort());
const RESUME_RECEIPT_KEYS = Object.freeze([
  "artifactSha256",
  "mimeType",
  "source",
  "status",
].sort());
const SUBSTANCE_KEYS = Object.freeze([
  "louderSpeakerChars",
  "quieterSpeakerChars",
  "speakers",
  "turns",
].sort());

export class SourceHumanIntroPointCollectorError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceHumanIntroPointCollectorError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceHumanIntroPointCollectorError(code);
}

function plainRecordSnapshot(value, code) {
  if (
    value === null
    || typeof value !== "object"
    || nodeTypes.isProxy(value)
    || Array.isArray(value)
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
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > MAX_RECORD_KEYS
    || keys.some((key) => typeof key !== "string")
  ) {
    fail(code);
  }
  const snapshot = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
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
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactKeys(record, expected, code) {
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length
    || actual.some((key, index) => key !== required[index])
  ) {
    fail(code);
  }
}

function ownValue(record, key, code) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    fail(code);
  }
  return record[key];
}

function exactText(
  value,
  code,
  {
    allowEmpty = false,
    maximum = MAX_TEXT_LENGTH,
  } = {},
) {
  if (
    typeof value !== "string"
    || value.length > maximum
    || (!allowEmpty && value.length === 0)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code);
  }
  return value;
}

function canonicalInstant(value, code) {
  const selected = exactText(value, code, {
    maximum: 40,
  });
  const milliseconds = Date.parse(selected);
  if (
    !CANONICAL_INSTANT.test(selected)
    || !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== selected
  ) {
    fail(code);
  }
  return selected;
}

function canonicalLinkedin(value, code) {
  const selected = exactText(value, code, {
    allowEmpty: true,
  });
  if (!selected) return "";
  let parsed;
  try {
    parsed = new URL(selected);
  } catch {
    fail(code);
  }
  const prefix = "/in/";
  const handle = parsed.pathname.startsWith(prefix)
    ? parsed.pathname.slice(prefix.length)
    : "";
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "www.linkedin.com"
    || parsed.port !== ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || !handle
    || handle.includes("/")
    || handle !== handle.toLowerCase()
    || selected !== `https://www.linkedin.com${prefix}${handle}`
  ) {
    fail(code);
  }
  return selected;
}

function digest(value, code) {
  const selected = exactText(value, code, {
    maximum: 64,
  });
  if (!DIGEST.test(selected)) fail(code);
  return selected;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
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

function expectedHumanIntroEventId(sourceId) {
  return createHash("sha256")
    .update("paraai-human-intro-v1")
    .update("\0")
    .update(sourceId)
    .digest("hex");
}

function expectedHumanIntroPayloadDigest(payload) {
  return createHash("sha256")
    .update("paraai-human-intro-payload-v1")
    .update("\0")
    .update(JSON.stringify({
      source: payload.source,
      parserVersion: payload.parserVersion,
      sourceId: payload.sourceId,
      eventId: payload.eventId,
      bookingCreatedAt: payload.bookingCreatedAt,
      candidateName: payload.candidateName,
      inviteeEmail: payload.inviteeEmail,
      linkedinUrl: payload.linkedinUrl,
      resumeLinkDisposition: payload.resumeLinkDisposition,
      resumeReceipt: payload.resumeReceipt,
      scheduledStart: payload.scheduledStart,
      scheduledEnd: payload.scheduledEnd,
    }))
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

function resumeReceiptSnapshot(value) {
  if (value === null) return null;
  const receipt = plainRecordSnapshot(
    value,
    "SOURCE_HUMAN_INTRO_POINT_RESUME_RECEIPT_INVALID",
  );
  exactKeys(
    receipt,
    RESUME_RECEIPT_KEYS,
    "SOURCE_HUMAN_INTRO_POINT_RESUME_RECEIPT_INVALID",
  );
  const normalized = {
    source: exactText(
      receipt.source,
      "SOURCE_HUMAN_INTRO_POINT_RESUME_RECEIPT_INVALID",
      { maximum: 80 },
    ),
    status: exactText(
      receipt.status,
      "SOURCE_HUMAN_INTRO_POINT_RESUME_RECEIPT_INVALID",
      { maximum: 80 },
    ),
    artifactSha256: digest(
      receipt.artifactSha256,
      "SOURCE_HUMAN_INTRO_POINT_RESUME_RECEIPT_INVALID",
    ),
    mimeType: exactText(
      receipt.mimeType,
      "SOURCE_HUMAN_INTRO_POINT_RESUME_RECEIPT_INVALID",
      { maximum: 160 },
    ),
  };
  if (
    normalized.source !== "calendar_resume_link"
    || !RESUME_RECEIPT_STATUSES.has(normalized.status)
    || !RESUME_RECEIPT_MIME_TYPES.has(
      normalized.mimeType,
    )
  ) {
    fail("SOURCE_HUMAN_INTRO_POINT_RESUME_RECEIPT_INVALID");
  }
  return normalized;
}

function candidateSnapshot(value) {
  const candidate = plainRecordSnapshot(
    value,
    "SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID",
  );
  exactKeys(
    candidate,
    CANDIDATE_KEYS,
    "SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID",
  );
  if (candidate.paraformEventId !== null) {
    fail("SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID");
  }
  const normalized = {
    fullName: exactText(
      candidate.fullName,
      "SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID",
      { maximum: 200 },
    ),
    firstName: exactText(
      candidate.firstName,
      "SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID",
      { maximum: 200 },
    ),
    email: exactText(
      candidate.email,
      "SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID",
      { maximum: 320 },
    ),
    linkedin: canonicalLinkedin(
      candidate.linkedin,
      "SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID",
    ),
    phone: exactText(
      candidate.phone,
      "SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID",
      { allowEmpty: true, maximum: 80 },
    ),
    scheduledStart: canonicalInstant(
      candidate.scheduledStart,
      "SOURCE_HUMAN_INTRO_POINT_SCHEDULE_INVALID",
    ),
    paraformEventId: null,
  };
  const normalizedName = normalized.fullName
    .replace(/\s+/gu, " ")
    .trim();
  const normalizedEmail = normalized.email
    .trim()
    .toLowerCase();
  if (
    normalizedName !== normalized.fullName
    || normalized.firstName
      !== normalized.fullName.split(/\s+/u)[0]
    || normalizedEmail !== normalized.email
    || !EMAIL.test(normalized.email)
    || INTERNAL_EMAIL_SUFFIXES.some((suffix) => (
      normalized.email.endsWith(suffix)
    ))
    || normalized.phone !== ""
  ) {
    fail("SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID");
  }
  return normalized;
}

function metadataSnapshot(value) {
  const metadata = plainRecordSnapshot(
    value,
    "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
  );
  exactKeys(
    metadata,
    METADATA_KEYS,
    "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
  );
  const substance = plainRecordSnapshot(
    metadata.substance,
    "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
  );
  exactKeys(
    substance,
    SUBSTANCE_KEYS,
    "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
  );
  if (metadata.speakerHeuristic !== null) {
    fail("SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID");
  }
  const normalized = {
    calendarIntro: metadata.calendarIntro,
    manualOnly: metadata.manualOnly,
    sourceId: digest(
      metadata.sourceId,
      "SOURCE_HUMAN_INTRO_POINT_SOURCE_ID_INVALID",
    ),
    intakeEventId: digest(
      metadata.intakeEventId,
      "SOURCE_HUMAN_INTRO_POINT_EVENT_ID_INVALID",
    ),
    source: exactText(
      metadata.source,
      "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
      { maximum: 100 },
    ),
    parserVersion: exactText(
      metadata.parserVersion,
      "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
      { maximum: 100 },
    ),
    payloadDigest: digest(
      metadata.payloadDigest,
      "SOURCE_HUMAN_INTRO_POINT_PAYLOAD_DIGEST_INVALID",
    ),
    bookingCreatedAt: canonicalInstant(
      metadata.bookingCreatedAt,
      "SOURCE_HUMAN_INTRO_POINT_BOOKING_CREATED_INVALID",
    ),
    bookingCreatedAtSource: exactText(
      metadata.bookingCreatedAtSource,
      "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
      { maximum: 100 },
    ),
    resumeLinkDisposition: exactText(
      metadata.resumeLinkDisposition,
      "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
      { maximum: 80 },
    ),
    resumeReceipt: resumeReceiptSnapshot(
      metadata.resumeReceipt,
    ),
    population: exactText(
      metadata.population,
      "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
      { maximum: 80 },
    ),
    platform: exactText(
      metadata.platform,
      "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
      { maximum: 100 },
    ),
    transcriptPresent: metadata.transcriptPresent,
    profileOnly: metadata.profileOnly,
    provenanceVerified: metadata.provenanceVerified,
    substance: {
      speakers: nonNegativeInteger(
        substance.speakers,
        "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
      ),
      turns: nonNegativeInteger(
        substance.turns,
        "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
      ),
      quieterSpeakerChars: nonNegativeInteger(
        substance.quieterSpeakerChars,
        "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
      ),
      louderSpeakerChars: nonNegativeInteger(
        substance.louderSpeakerChars,
        "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
      ),
    },
    speakerHeuristic: null,
  };
  const receiptRequired = [
    "received",
    "received_review",
  ].includes(normalized.resumeLinkDisposition);
  if (
    normalized.calendarIntro !== true
    || normalized.manualOnly !== true
    || normalized.bookingCreatedAtSource
      !== "calendar_booking_created_at"
    || !RESUME_LINK_DISPOSITIONS.has(
      normalized.resumeLinkDisposition,
    )
    || receiptRequired !== (normalized.resumeReceipt !== null)
    || (
      normalized.resumeReceipt !== null
      && normalized.resumeReceipt.status
        !== normalized.resumeLinkDisposition
    )
    || normalized.population !== "role_chat"
    || normalized.platform
      !== "GOOGLE_CALENDAR_CALENDLY"
    || normalized.transcriptPresent !== false
    || normalized.profileOnly !== true
    || normalized.provenanceVerified !== true
    || Object.values(normalized.substance).some(
      (value) => value !== 0,
    )
  ) {
    fail("SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID");
  }
  return normalized;
}

function normalizedOptions(options) {
  const selected = plainRecordSnapshot(
    options,
    "SOURCE_HUMAN_INTRO_POINT_OPTIONS_INVALID",
  );
  exactKeys(
    selected,
    OPTIONS_KEYS,
    "SOURCE_HUMAN_INTRO_POINT_OPTIONS_INVALID",
  );
  return {
    decisionBoundaryAt: canonicalInstant(
      selected.decisionBoundaryAt,
      "SOURCE_HUMAN_INTRO_POINT_BOUNDARY_INVALID",
    ),
  };
}

function optionalExact(record, key, expected, normalizer, code) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return;
  const actual = normalizer
    ? normalizer(record[key])
    : record[key];
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(code);
}

export function normalizeHumanIntroSourcePointJob(
  rawJob,
  options = {},
) {
  const { decisionBoundaryAt } = normalizedOptions(options);
  const job = plainRecordSnapshot(
    rawJob,
    "SOURCE_HUMAN_INTRO_POINT_JOB_INVALID",
  );
  const jobId = exactText(
    ownValue(
      job,
      "id",
      "SOURCE_HUMAN_INTRO_POINT_JOB_ID_INVALID",
    ),
    "SOURCE_HUMAN_INTRO_POINT_JOB_ID_INVALID",
    { maximum: 67 },
  );
  if (!JOB_ID.test(jobId)) {
    fail("SOURCE_HUMAN_INTRO_POINT_JOB_ID_INVALID");
  }
  if (
    ownValue(
      job,
      "humanCall",
      "SOURCE_HUMAN_INTRO_POINT_MARKERS_INVALID",
    ) !== true
    || ownValue(
      job,
      "humanIntro",
      "SOURCE_HUMAN_INTRO_POINT_MARKERS_INVALID",
    ) !== true
    || ownValue(
      job,
      "callType",
      "SOURCE_HUMAN_INTRO_POINT_MARKERS_INVALID",
    ) !== "human"
  ) {
    fail("SOURCE_HUMAN_INTRO_POINT_MARKERS_INVALID");
  }

  const scheduledStart = canonicalInstant(
    ownValue(
      job,
      "callStartedAt",
      "SOURCE_HUMAN_INTRO_POINT_SCHEDULE_INVALID",
    ),
    "SOURCE_HUMAN_INTRO_POINT_SCHEDULE_INVALID",
  );
  const scheduledEnd = canonicalInstant(
    ownValue(
      job,
      "callEndedAt",
      "SOURCE_HUMAN_INTRO_POINT_SCHEDULE_INVALID",
    ),
    "SOURCE_HUMAN_INTRO_POINT_SCHEDULE_INVALID",
  );
  if (
    Date.parse(scheduledStart) >= Date.parse(scheduledEnd)
    || Date.parse(scheduledEnd) >= Date.parse(decisionBoundaryAt)
  ) {
    fail("SOURCE_HUMAN_INTRO_POINT_OUTSIDE_BOUNDARY");
  }

  const candidate = candidateSnapshot(
    ownValue(
      job,
      "candidate",
      "SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID",
    ),
  );
  if (candidate.scheduledStart !== scheduledStart) {
    fail("SOURCE_HUMAN_INTRO_POINT_SCHEDULE_MISMATCH");
  }
  const metadata = metadataSnapshot(
    ownValue(
      job,
      "humanCallMeta",
      "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
    ),
  );
  const sourceId = jobId.slice(3);
  if (metadata.sourceId !== sourceId) {
    fail("SOURCE_HUMAN_INTRO_POINT_SOURCE_ID_MISMATCH");
  }
  if (
    metadata.intakeEventId
      !== expectedHumanIntroEventId(sourceId)
  ) {
    fail("SOURCE_HUMAN_INTRO_POINT_EVENT_ID_MISMATCH");
  }
  if (
    metadata.source !== HUMAN_INTRO_SOURCE
    || metadata.parserVersion !== HUMAN_INTRO_PARSER_VERSION
  ) {
    fail("SOURCE_HUMAN_INTRO_POINT_PROVENANCE_INVALID");
  }
  const durationMs =
    Date.parse(scheduledEnd) - Date.parse(scheduledStart);
  if (
    Date.parse(metadata.bookingCreatedAt)
      > Date.parse(scheduledStart)
    || durationMs < 60_000
    || durationMs > 4 * 60 * 60_000
  ) {
    fail("SOURCE_HUMAN_INTRO_POINT_SCHEDULE_INVALID");
  }
  const exactPayload = {
    source: metadata.source,
    parserVersion: metadata.parserVersion,
    sourceId,
    eventId: metadata.intakeEventId,
    bookingCreatedAt: metadata.bookingCreatedAt,
    candidateName: candidate.fullName,
    inviteeEmail: candidate.email,
    linkedinUrl: candidate.linkedin || null,
    resumeLinkDisposition:
      metadata.resumeLinkDisposition,
    resumeReceipt: metadata.resumeReceipt,
    scheduledStart,
    scheduledEnd,
  };
  if (
    metadata.payloadDigest
      !== expectedHumanIntroPayloadDigest(exactPayload)
  ) {
    fail("SOURCE_HUMAN_INTRO_POINT_PAYLOAD_DIGEST_MISMATCH");
  }

  optionalExact(
    job,
    "bookingSourceId",
    sourceId,
    (value) => exactText(
      value,
      "SOURCE_HUMAN_INTRO_POINT_SOURCE_ID_MISMATCH",
      { maximum: 64 },
    ),
    "SOURCE_HUMAN_INTRO_POINT_SOURCE_ID_MISMATCH",
  );
  optionalExact(
    job,
    "callTypeAt",
    scheduledEnd,
    (value) => canonicalInstant(
      value,
      "SOURCE_HUMAN_INTRO_POINT_SCHEDULE_MISMATCH",
    ),
    "SOURCE_HUMAN_INTRO_POINT_SCHEDULE_MISMATCH",
  );
  optionalExact(
    job,
    "resumeLinkDisposition",
    metadata.resumeLinkDisposition,
    (value) => exactText(
      value,
      "SOURCE_HUMAN_INTRO_POINT_METADATA_MISMATCH",
      { maximum: 80 },
    ),
    "SOURCE_HUMAN_INTRO_POINT_METADATA_MISMATCH",
  );
  optionalExact(
    job,
    "resumeReceipt",
    metadata.resumeReceipt,
    resumeReceiptSnapshot,
    "SOURCE_HUMAN_INTRO_POINT_METADATA_MISMATCH",
  );

  return deepFreeze({
    version: SOURCE_HUMAN_INTRO_POINT_COLLECTOR_VERSION,
    source: SOURCE,
    intakeSource: HUMAN_INTRO_SOURCE,
    parserVersion: HUMAN_INTRO_PARSER_VERSION,
    jobId,
    sourceId,
    intakeEventId: metadata.intakeEventId,
    payloadDigest: metadata.payloadDigest,
    bookingCreatedAt: metadata.bookingCreatedAt,
    scheduledStart,
    scheduledEnd,
    candidate: {
      name: candidate.fullName,
      email: candidate.email,
      linkedinUrl: candidate.linkedin || null,
    },
    resumeLinkDisposition:
      metadata.resumeLinkDisposition,
    resumeReceipt: metadata.resumeReceipt,
    decisionBoundaryAt,
    durableIntakeAvailable: true,
    durableSignedReceiptAvailable: false,
    sourceRecordRevisionAvailable: false,
    sourceHeadAvailable: false,
    sourceExhaustivenessAvailable: false,
    cancellationTombstoneAvailable: false,
    occurredEvidenceAvailable: false,
    outcomeEvidenceAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
  });
}

export function humanIntroSourcePointEvidence(
  rawJob,
  options = {},
) {
  const projection = normalizeHumanIntroSourcePointJob(
    rawJob,
    options,
  );
  const sourceRecordDigest = semanticDigest(
    "phase4-human-intro-source-record-v1",
    {
      source: projection.source,
      jobId: projection.jobId,
      sourceId: projection.sourceId,
      intakeEventId: projection.intakeEventId,
    },
  );
  const durableIntakeDigest = semanticDigest(
    "phase4-human-intro-durable-intake-v1",
    {
      sourceRecordDigest,
      intakeSource: projection.intakeSource,
      parserVersion: projection.parserVersion,
      payloadDigest: projection.payloadDigest,
      bookingCreatedAt: projection.bookingCreatedAt,
      scheduledStart: projection.scheduledStart,
      scheduledEnd: projection.scheduledEnd,
      candidate: projection.candidate,
      resumeLinkDisposition:
        projection.resumeLinkDisposition,
      resumeReceipt: projection.resumeReceipt,
    },
  );
  return deepFreeze({
    version: SOURCE_HUMAN_INTRO_POINT_COLLECTOR_VERSION,
    source: SOURCE,
    sourceRecordDigest,
    durableIntakeDigest,
    privateProjectionDigest: semanticDigest(
      "phase4-human-intro-private-projection-v1",
      projection,
    ),
    decisionBoundaryDigest: semanticDigest(
      "phase4-source-decision-boundary-v1",
      projection.decisionBoundaryAt,
    ),
    durableIntakeAvailable: true,
    durableSignedReceiptAvailable: false,
    sourceRecordRevisionAvailable: false,
    sourceHeadAvailable: false,
    sourceExhaustivenessAvailable: false,
    cancellationTombstoneAvailable: false,
    occurredEvidenceAvailable: false,
    outcomeEvidenceAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
  });
}
