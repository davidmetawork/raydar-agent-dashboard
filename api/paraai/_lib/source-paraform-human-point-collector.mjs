// Pure, hard-dark Paraform Human source-point projector.
//
// A controlled read-only capture on 2026-07-29 established one stable
// 16-field getCallById contract across the sampled PHONE/TWILIO Human calls,
// including both linked and unlinked candidate records. This module validates
// that complete phone-screen shape, proves the stable Human-call
// discriminator, binds the point response to an exhaustive-page reference,
// derives a semantic source-record revision, and classifies only substantive
// two-speaker transcripts that end before the common decision boundary.
//
// The private projection may contain source identifiers and page-held identity
// hints. Public evidence contains digests, bounded enums, and booleans only.
// Candidate-user-to-canonical-candidate identity remains a separate two-read
// proof, so complete identity continuity and pinnability remain false here.
// No transport, environment read, store, head, signer, coordinator, authority,
// curation, enrollment, or candidate-facing write is exported.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  SOURCE_IDENTITY_POINT_READ_PROCEDURES,
} from "./source-watermark.mjs";

export const SOURCE_PARAFORM_HUMAN_POINT_COLLECTOR_VERSION =
  "paraform-human-source-point-v2";

const SOURCE = "paraform_human";
const HUMAN_PLATFORM = "PHONE";
const HUMAN_RECORDING_PROVIDER = "TWILIO";
const MAX_REFERENCE_JSON_BYTES = 131_072;
const MAX_REFERENCE_EMAILS = 512;
const MAX_TRANSCRIPT_TURNS = 20_000;
const MAX_TRANSCRIPT_WORDS = 250_000;
const MAX_TRANSCRIPT_TEXT_BYTES = 4_194_304;
const MAX_WORD_SECONDS = 86_400;
const SUBSTANCE_MIN_SPEAKERS = 2;
const SUBSTANCE_MIN_SECOND_SPEAKER_CHARS = 400;

const PHONE_POINT_KEYS = Object.freeze([
  "attendee_emails",
  "candidate_user",
  "candidate_user_id",
  "event_scheduled_at",
  "event_title",
  "google_calendar_event",
  "granola_note_id",
  "id",
  "is_public",
  "meeting_link",
  "meeting_platform",
  "recording_provider",
  "recording_summary",
  "recording_transcript",
  "recording_url",
  "user_id",
]);

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
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail("SOURCE_PARAFORM_HUMAN_POINT_SYMBOL_INVALID");
  }
  const snapshot = Object.create(null);
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      fail("SOURCE_PARAFORM_HUMAN_POINT_ACCESSOR_INVALID");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function arraySnapshot(value, maximum, code) {
  if (
    !Array.isArray(value)
    || value.length > maximum
    || nodeTypes.isProxy(value)
    || Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail(code);
  }
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
    actual.length !== expected.length
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
      || !Object.prototype.hasOwnProperty.call(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    result.push(descriptor.value);
  }
  return result;
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
    const items = arraySnapshot(
      value,
      MAX_REFERENCE_EMAILS,
      code,
    ).map((item) => jsonSnapshot(item, code, seen));
    seen.delete(value);
    return items;
  }
  const record = plainRecordSnapshot(value, code);
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

function optionalPointText(value, {
  code,
  maximum,
  lowercase = false,
  collapseWhitespace = false,
} = {}) {
  if (value === null) return "";
  return boundedText(value, {
    code,
    maximum,
    lowercase,
    collapseWhitespace,
  });
}

function rawTranscriptText(value) {
  if (
    typeof value !== "string"
    || value.length > 4_096
    || /[\u0000\u007f]/u.test(value)
  ) {
    fail("SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_INVALID");
  }
  return value;
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
    canonical: `${utcSecond}.${fractionNanoseconds}Z`,
    epochNanoseconds,
    millisecondCanonical: new Date(
      Number(epochMilliseconds),
    ).toISOString(),
  });
}

function canonicalPageEmails(value) {
  const emails = arraySnapshot(
    value,
    MAX_REFERENCE_EMAILS,
    "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
  );
  return deepFreeze(emails.map((email) => exactPageText(
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
  return deepFreeze(arraySnapshot(
    value,
    MAX_REFERENCE_EMAILS,
    "SOURCE_PARAFORM_HUMAN_POINT_ATTENDEE_EMAILS_INVALID",
  )
    .map((email) => boundedText(email, {
      code:
        "SOURCE_PARAFORM_HUMAN_POINT_ATTENDEE_EMAILS_INVALID",
      maximum: 512,
      lowercase: true,
      collapseWhitespace: true,
    }))
    .filter(Boolean));
}

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
      "candidate",
      "candidateUserId",
      "createdAt",
      "hasTranscript",
      "humanCall",
      "id",
      "owner",
      "ownerId",
      "platform",
      "recordingProvider",
      "scheduledAt",
      "title",
    ],
    "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
  );
  const candidate = plainRecordSnapshot(
    reference.candidate,
    "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
  );
  exactKeys(
    candidate,
    ["emails", "linkedin", "name"],
    "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
  );
  const scheduledAt = canonicalMillisecondUtc(
    reference.scheduledAt,
    "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
  );
  const createdAt = canonicalMillisecondUtc(
    reference.createdAt,
    "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
  );
  if (
    Date.parse(scheduledAt) >= Date.parse(decisionBoundaryAt)
    || Date.parse(createdAt) >= Date.parse(decisionBoundaryAt)
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_OUTSIDE_BOUNDARY",
    );
  }
  if (
    reference.hasTranscript !== null
    && typeof reference.hasTranscript !== "boolean"
  ) {
    fail("SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID");
  }
  if (reference.humanCall !== true) {
    fail(
      "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_NOT_HUMAN",
    );
  }
  const platform = exactPageText(
    reference.platform,
    { maximum: 256, allowEmpty: false },
  );
  const recordingProvider = exactPageText(
    reference.recordingProvider,
    { maximum: 256, allowEmpty: false },
  );
  if (
    platform !== HUMAN_PLATFORM
    || recordingProvider !== HUMAN_RECORDING_PROVIDER
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_NOT_HUMAN",
    );
  }
  return deepFreeze({
    id: exactSourceId(
      reference.id,
      "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
    ),
    scheduledAt,
    createdAt,
    title: exactPageText(
      reference.title,
      { maximum: 4_096 },
    ),
    platform,
    recordingProvider,
    owner: exactPageText(
      reference.owner,
      { maximum: 512 },
    ),
    ownerId: exactPageText(
      reference.ownerId,
      { maximum: 256, allowEmpty: false },
    ),
    candidateUserId: exactPageText(
      reference.candidateUserId,
      { maximum: 256 },
    ),
    hasTranscript: reference.hasTranscript,
    humanCall: true,
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

function nullableContractText(value, code, maximum) {
  if (value === null) return null;
  return boundedText(value, {
    code,
    maximum,
  });
}

function normalizedCandidate(record) {
  const candidateUserId = optionalPointText(
    record.candidate_user_id,
    {
      code:
        "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_USER_ID_INVALID",
      maximum: 256,
    },
  );
  if (record.candidate_user === null) {
    if (candidateUserId !== "") {
      fail(
        "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_LINKAGE_INVALID",
      );
    }
    return deepFreeze({
      candidateUserId: "",
      candidate: {
        name: "",
        imageDigest: null,
      },
    });
  }
  const candidateUser = plainRecordSnapshot(
    record.candidate_user,
    "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_USER_INVALID",
  );
  exactKeys(
    candidateUser,
    ["candidate"],
    "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_USER_INVALID",
  );
  const candidate = plainRecordSnapshot(
    candidateUser.candidate,
    "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_INVALID",
  );
  exactKeys(
    candidate,
    ["image_src", "name"],
    "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_INVALID",
  );
  if (!candidateUserId) {
    fail(
      "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_LINKAGE_INVALID",
    );
  }
  const name = optionalPointText(candidate.name, {
    code:
      "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_NAME_INVALID",
    maximum: 512,
  });
  const image = nullableContractText(
    candidate.image_src,
    "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_IMAGE_INVALID",
    8_192,
  );
  return deepFreeze({
    candidateUserId,
    candidate: {
      name,
      imageDigest: image == null
        ? null
        : semanticDigest(
          "phase4-paraform-human-candidate-image-v1",
          image,
        ),
    },
  });
}

function normalizedTranscript(value) {
  const turns = arraySnapshot(
    value,
    MAX_TRANSCRIPT_TURNS,
    "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_INVALID",
  );
  const material = [];
  const charactersBySpeaker = new Map();
  let wordCount = 0;
  let textBytes = 0;
  let maximumEndSeconds = null;
  for (const rawTurn of turns) {
    const turn = plainRecordSnapshot(
      rawTurn,
      "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_INVALID",
    );
    exactKeys(
      turn,
      ["speaker", "speaker_id", "words"],
      "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_INVALID",
    );
    const speaker = boundedText(turn.speaker, {
      code:
        "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_INVALID",
      maximum: 512,
      allowEmpty: false,
    });
    const speakerId = exactSourceId(
      turn.speaker_id,
      "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_INVALID",
    );
    const words = [];
    for (const rawWord of arraySnapshot(
      turn.words,
      MAX_TRANSCRIPT_WORDS,
      "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_INVALID",
    )) {
      wordCount += 1;
      if (wordCount > MAX_TRANSCRIPT_WORDS) {
        fail("SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_TOO_LARGE");
      }
      const word = plainRecordSnapshot(
        rawWord,
        "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_INVALID",
      );
      exactKeys(
        word,
        ["end_timestamp", "start_timestamp", "text"],
        "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_INVALID",
      );
      const text = rawTranscriptText(word.text);
      textBytes += Buffer.byteLength(text, "utf8");
      if (textBytes > MAX_TRANSCRIPT_TEXT_BYTES) {
        fail("SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_TOO_LARGE");
      }
      const start = word.start_timestamp;
      const end = word.end_timestamp;
      if (
        !Number.isFinite(start)
        || !Number.isFinite(end)
        || start < 0
        || end < start
        || end > MAX_WORD_SECONDS
      ) {
        fail(
          "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_TIMESTAMP_INVALID",
        );
      }
      charactersBySpeaker.set(
        speakerId,
        (charactersBySpeaker.get(speakerId) || 0)
          + text.length,
      );
      maximumEndSeconds = maximumEndSeconds == null
        ? end
        : Math.max(maximumEndSeconds, end);
      words.push({ start, end, text });
    }
    material.push({ speaker, speakerId, words });
  }
  const ranked = [...charactersBySpeaker.values()]
    .sort((left, right) => right - left);
  return deepFreeze({
    transcriptDigest: semanticDigest(
      "phase4-paraform-human-transcript-v1",
      material,
    ),
    transcriptPresent: wordCount > 0,
    transcriptTurnCount: turns.length,
    transcriptWordCount: wordCount,
    transcriptSpeakerCount: charactersBySpeaker.size,
    secondSpeakerChars: ranked[1] || 0,
    substantive: (
      charactersBySpeaker.size >= SUBSTANCE_MIN_SPEAKERS
      && (ranked[1] || 0)
        >= SUBSTANCE_MIN_SECOND_SPEAKER_CHARS
    ),
    maximumEndSeconds,
  });
}

function transcriptEndedAt(scheduledAt, maximumEndSeconds) {
  if (maximumEndSeconds == null) return null;
  const endOffsetNanoseconds = Math.ceil(
    maximumEndSeconds * 1_000_000_000,
  );
  if (!Number.isSafeInteger(endOffsetNanoseconds)) {
    fail(
      "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_TIMESTAMP_INVALID",
    );
  }
  const epochNanoseconds =
    scheduledAt.epochNanoseconds
    + BigInt(endOffsetNanoseconds);
  const ceilingMilliseconds =
    (epochNanoseconds + 999_999n) / 1_000_000n;
  const endedAtMs = Number(ceilingMilliseconds);
  if (
    !Number.isSafeInteger(endedAtMs)
    || !Number.isFinite(endedAtMs)
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_TIMESTAMP_INVALID",
    );
  }
  return Object.freeze({
    canonical: new Date(endedAtMs).toISOString(),
    epochNanoseconds,
  });
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
  exactKeys(
    record,
    PHONE_POINT_KEYS,
    "SOURCE_PARAFORM_HUMAN_POINT_CONTRACT_INVALID",
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
    scheduledAt.epochNanoseconds >= boundary.epochNanoseconds
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_POINT_SCHEDULED_AT_OUTSIDE_BOUNDARY",
    );
  }
  const platform = boundedText(record.meeting_platform, {
    code: "SOURCE_PARAFORM_HUMAN_POINT_PLATFORM_INVALID",
    maximum: 256,
    allowEmpty: false,
  });
  const recordingProvider = boundedText(
    record.recording_provider,
    {
      code:
        "SOURCE_PARAFORM_HUMAN_POINT_RECORDING_PROVIDER_INVALID",
      maximum: 256,
      allowEmpty: false,
    },
  );
  if (
    platform !== HUMAN_PLATFORM
    || recordingProvider !== HUMAN_RECORDING_PROVIDER
  ) {
    fail("SOURCE_PARAFORM_HUMAN_POINT_NOT_HUMAN");
  }
  const ownerId = exactSourceId(
    record.user_id,
    "SOURCE_PARAFORM_HUMAN_POINT_OWNER_ID_INVALID",
  );
  const title = optionalPointText(record.event_title, {
    code: "SOURCE_PARAFORM_HUMAN_POINT_TITLE_INVALID",
    maximum: 4_096,
  });
  const linkage = normalizedCandidate(record);
  const emails = normalizePointEmails(record.attendee_emails);
  const transcript = normalizedTranscript(
    record.recording_transcript,
  );
  if (
    record.google_calendar_event !== null
    || record.granola_note_id !== null
    || typeof record.is_public !== "boolean"
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_POINT_PHONE_CONTRACT_INVALID",
    );
  }
  const meetingLink = nullableContractText(
    record.meeting_link,
    "SOURCE_PARAFORM_HUMAN_POINT_MEETING_LINK_INVALID",
    8_192,
  );
  const recordingSummary = nullableContractText(
    record.recording_summary,
    "SOURCE_PARAFORM_HUMAN_POINT_RECORDING_SUMMARY_INVALID",
    131_072,
  );
  const recordingUrl = nullableContractText(
    record.recording_url,
    "SOURCE_PARAFORM_HUMAN_POINT_RECORDING_URL_INVALID",
    8_192,
  );
  const pointReference = {
    id: callId,
    scheduledAt: scheduledAt.millisecondCanonical,
    title,
    platform,
    recordingProvider,
    ownerId,
    candidateUserId: linkage.candidateUserId,
    candidate: {
      name: linkage.candidate.name,
      emails,
    },
  };
  const expectedPointReference = {
    id: expectedReference.id,
    scheduledAt: expectedReference.scheduledAt,
    title: expectedReference.title,
    platform: expectedReference.platform,
    recordingProvider:
      expectedReference.recordingProvider,
    ownerId: expectedReference.ownerId,
    candidateUserId:
      expectedReference.candidateUserId,
    candidate: {
      name: expectedReference.candidate.name,
      emails: expectedReference.candidate.emails,
    },
  };
  if (
    canonicalJson(pointReference)
      !== canonicalJson(expectedPointReference)
  ) {
    fail("SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_MISMATCH");
  }
  if (
    expectedReference.hasTranscript !== null
    && expectedReference.hasTranscript
      !== transcript.transcriptPresent
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_CONTINUITY_MISMATCH",
    );
  }
  const observedEndedAt = transcriptEndedAt(
    scheduledAt,
    transcript.maximumEndSeconds,
  );
  const successVerified = (
    transcript.substantive
    && observedEndedAt !== null
    && observedEndedAt.epochNanoseconds
      < boundary.epochNanoseconds
  );
  const classification = successVerified
    ? "success"
    : "pending";
  const completePointMaterial = {
    pointReference,
    isPublic: record.is_public,
    candidateImageDigest:
      linkage.candidate.imageDigest,
    meetingLinkDigest: meetingLink == null
      ? null
      : semanticDigest(
        "phase4-paraform-human-meeting-link-v1",
        meetingLink,
      ),
    recordingSummaryDigest: recordingSummary == null
      ? null
      : semanticDigest(
        "phase4-paraform-human-recording-summary-v1",
        recordingSummary,
      ),
    recordingUrlDigest: recordingUrl == null
      ? null
      : semanticDigest(
        "phase4-paraform-human-recording-url-v1",
        recordingUrl,
      ),
    transcriptDigest: transcript.transcriptDigest,
  };
  return deepFreeze({
    source: SOURCE,
    callId,
    scheduledAt: scheduledAt.canonical,
    enumeratedScheduledAt:
      scheduledAt.millisecondCanonical,
    title,
    platform,
    recordingProvider,
    ownerId,
    candidateUserId: linkage.candidateUserId,
    candidate: {
      name: linkage.candidate.name,
      emails,
    },
    transcriptPresent: transcript.transcriptPresent,
    transcriptTurnCount: transcript.transcriptTurnCount,
    transcriptWordCount: transcript.transcriptWordCount,
    transcriptSpeakerCount:
      transcript.transcriptSpeakerCount,
    secondSpeakerChars: transcript.secondSpeakerChars,
    observedEndedAt:
      observedEndedAt?.canonical ?? null,
    classification,
    successVerified,
    decisionBoundaryAt,
    pageReference: expectedReference,
    completePointMaterial,
    pointRecordIdVerified: true,
    pointResponseContractVerified: true,
    recordContinuityVerified: true,
    pageTranscriptContinuityVerified:
      expectedReference.hasTranscript === null
        ? null
        : true,
    sourceRecordRevisionAvailable: true,
    humanCallDiscriminatorAvailable: true,
    humanCallVerified: true,
    successClassificationAvailable: true,
    // LinkedIn is page-only and canonical candidate identity is resolved by
    // the separate candidate-user identity two-read collector.
    completeReferenceContinuityAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
  });
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
  const referenceMaterial = {
    sourceRecordDigest,
    scheduledAt: normalized.expectedReference.scheduledAt,
    createdAt: normalized.expectedReference.createdAt,
    title: normalized.expectedReference.title,
    platform: normalized.expectedReference.platform,
    recordingProvider:
      normalized.expectedReference.recordingProvider,
    owner: normalized.expectedReference.owner,
    ownerId: normalized.expectedReference.ownerId,
    candidateUserId:
      normalized.expectedReference.candidateUserId,
    hasTranscript:
      normalized.expectedReference.hasTranscript,
    humanCall: normalized.expectedReference.humanCall,
    candidate: normalized.expectedReference.candidate,
  };
  const pointMaterial = {
    sourceRecordDigest,
    ...projection.completePointMaterial,
    scheduledAt: projection.scheduledAt,
    observedEndedAt: projection.observedEndedAt,
  };
  const statusMaterial = {
    sourceRecordDigest,
    decisionBoundaryAt: projection.decisionBoundaryAt,
    classification: projection.classification,
    successVerified: projection.successVerified,
    observedEndedAt: projection.successVerified
      ? projection.observedEndedAt
      : null,
  };
  return deepFreeze({
    source: SOURCE,
    sourcePointReadProcedure:
      SOURCE_IDENTITY_POINT_READ_PROCEDURES
        .paraformHumanSource,
    sourceNormalizedInputDigest: semanticDigest(
      "phase4-paraform-human-source-point-request-v2",
      request,
    ),
    sourceRecordDigest,
    sourceReferenceDigest: semanticDigest(
      "phase4-paraform-human-source-reference-v2",
      referenceMaterial,
    ),
    sourcePointDigest: semanticDigest(
      "phase4-paraform-human-source-point-v2",
      pointMaterial,
    ),
    sourceRecordRevisionDigest: semanticDigest(
      "phase4-paraform-human-source-point-semantic-revision-v2",
      {
        referenceMaterial,
        pointMaterial,
      },
    ),
    sourceStatusAtBoundaryDigest: semanticDigest(
      "phase4-paraform-human-source-status-at-boundary-v1",
      statusMaterial,
    ),
    humanCallDiscriminatorDigest: semanticDigest(
      "phase4-paraform-human-discriminator-v1",
      {
        platform: projection.platform,
        recordingProvider: projection.recordingProvider,
      },
    ),
    decisionBoundaryDigest: semanticDigest(
      "phase4-source-decision-boundary-v1",
      normalized.decisionBoundaryAt,
    ),
    classification: projection.classification,
    pointRecordIdVerified: true,
    pointResponseContractVerified: true,
    recordContinuityVerified: true,
    pageTranscriptContinuityVerified:
      projection.pageTranscriptContinuityVerified,
    sourceRecordRevisionAvailable: true,
    humanCallDiscriminatorAvailable: true,
    humanCallVerified: true,
    successClassificationAvailable: true,
    successVerified: projection.successVerified,
    completeReferenceContinuityAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
  });
}
