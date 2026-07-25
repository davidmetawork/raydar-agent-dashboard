import { createHash } from "node:crypto";

import {
  normLinkedin,
  normalizeEmail,
} from "./core.mjs";

export const HUMAN_INTRO_JOB_PREFIX = "hi-";
export const HUMAN_INTRO_SOURCE =
  "google_calendar_calendly_role_chat";
export const HUMAN_INTRO_PARSER_VERSION =
  "calendly-role-chat-v1";
export const HUMAN_INTRO_QUEUE_SOURCE =
  "calendar_human_intro_resume_wait";
export const HUMAN_INTRO_PAYLOAD_CONFLICT_CODE =
  "human_intro_payload_conflict";
export const HUMAN_INTRO_PAYLOAD_CONFLICT_MESSAGE =
  "Calendar booking facts changed for this intake; reconcile the booking before submission";
export const HUMAN_INTRO_RESUME_REVIEW_CODE =
  "calendar_resume_received_review";
export const HUMAN_INTRO_RESUME_REVIEW_MESSAGE =
  "Calendar resume artifact was received but requires manual PDF or conversion review";
export const HUMAN_INTRO_RESUME_AMBIGUOUS_CODE =
  "calendar_resume_link_ambiguous";
export const HUMAN_INTRO_RESUME_AMBIGUOUS_MESSAGE =
  "Multiple Calendar resume links were found; review the exact booking artifacts manually";

const SOURCE_ID = /^[a-f0-9]{64}$/u;
const JOB_ID = /^hi-[a-f0-9]{64}$/u;
const ARTIFACT_SHA256 = /^[a-f0-9]{64}$/u;
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/iu;
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
const RESUME_RECEIPT_KEYS = Object.freeze([
  "artifactSha256",
  "mimeType",
  "source",
  "status",
].sort());
const PAYLOAD_KEYS = Object.freeze([
  "bookingCreatedAt",
  "candidateName",
  "eventId",
  "inviteeEmail",
  "linkedinUrl",
  "parserVersion",
  "resumeLinkDisposition",
  "resumeReceipt",
  "scheduledEnd",
  "scheduledStart",
  "source",
  "sourceId",
].sort());

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function humanIntroSourceId(value) {
  const selected = String(value || "").trim().toLowerCase();
  if (!SOURCE_ID.test(selected)) {
    throw codedError(
      "HUMAN_INTRO_SOURCE_ID_INVALID",
      "valid opaque Calendar source id required",
    );
  }
  return selected;
}

function canonicalInstant(value, code) {
  const selected = String(value || "").trim();
  const milliseconds = Date.parse(selected);
  if (!EXPLICIT_OFFSET.test(selected) || !Number.isFinite(milliseconds)) {
    throw codedError(code);
  }
  return new Date(milliseconds).toISOString();
}

function candidateName(value) {
  const selected = String(value || "").replace(/\s+/gu, " ").trim();
  if (
    selected.length < 1
    || selected.length > 200
    || /[\u0000-\u001f\u007f]/u.test(selected)
  ) {
    throw codedError("HUMAN_INTRO_CANDIDATE_NAME_INVALID");
  }
  return selected;
}

function normalizeResumeReceipt(value, disposition) {
  if (!RESUME_LINK_DISPOSITIONS.has(disposition)) {
    throw codedError("HUMAN_INTRO_RESUME_DISPOSITION_INVALID");
  }
  if (value == null) {
    if (["received", "received_review"].includes(disposition)) {
      throw codedError("HUMAN_INTRO_RESUME_RECEIPT_INVALID");
    }
    return null;
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort())
      !== JSON.stringify(RESUME_RECEIPT_KEYS)
    || value.source !== "calendar_resume_link"
    || !RESUME_RECEIPT_STATUSES.has(value.status)
    || value.status !== disposition
    || !ARTIFACT_SHA256.test(String(value.artifactSha256 || ""))
    || !RESUME_RECEIPT_MIME_TYPES.has(value.mimeType)
  ) {
    throw codedError("HUMAN_INTRO_RESUME_RECEIPT_INVALID");
  }
  return Object.freeze({
    source: "calendar_resume_link",
    status: value.status,
    artifactSha256: value.artifactSha256,
    mimeType: value.mimeType,
  });
}

export function humanIntroEventId(sourceId) {
  return createHash("sha256")
    .update("paraai-human-intro-v1")
    .update("\0")
    .update(humanIntroSourceId(sourceId))
    .digest("hex");
}

function digestNormalizedHumanIntroPayload(payload) {
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

export function humanIntroJobId(sourceId) {
  return `${HUMAN_INTRO_JOB_PREFIX}${humanIntroSourceId(sourceId)}`;
}

export function isHumanIntroJob(value) {
  return JOB_ID.test(String(value || "").trim());
}

export function sourceIdFromHumanIntroJob(value) {
  const jobId = String(value || "").trim();
  if (!isHumanIntroJob(jobId)) {
    throw codedError(
      "HUMAN_INTRO_JOB_ID_INVALID",
      "valid Calendar human-intro job id required",
    );
  }
  return humanIntroSourceId(jobId.slice(HUMAN_INTRO_JOB_PREFIX.length));
}

export function normalizeHumanIntroPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("HUMAN_INTRO_PAYLOAD_INVALID");
  }
  if (
    JSON.stringify(Object.keys(value).sort())
    !== JSON.stringify(PAYLOAD_KEYS)
  ) {
    throw codedError("HUMAN_INTRO_PAYLOAD_INVALID");
  }
  const sourceId = humanIntroSourceId(value.sourceId);
  if (
    value.source !== HUMAN_INTRO_SOURCE
    || value.parserVersion !== HUMAN_INTRO_PARSER_VERSION
    || String(value.eventId || "").trim() !== humanIntroEventId(sourceId)
  ) {
    throw codedError("HUMAN_INTRO_PROVENANCE_INVALID");
  }
  const email = normalizeEmail(value.inviteeEmail);
  if (!email || email !== String(value.inviteeEmail || "").trim().toLowerCase()) {
    throw codedError("HUMAN_INTRO_EMAIL_INVALID");
  }
  const rawLinkedin = value.linkedinUrl == null
    ? ""
    : String(value.linkedinUrl).trim();
  const linkedin = normLinkedin(rawLinkedin);
  if (rawLinkedin && !linkedin) {
    throw codedError("HUMAN_INTRO_LINKEDIN_INVALID");
  }
  const scheduledStart = canonicalInstant(
    value.scheduledStart,
    "HUMAN_INTRO_START_INVALID",
  );
  const bookingCreatedAt = canonicalInstant(
    value.bookingCreatedAt,
    "HUMAN_INTRO_BOOKING_CREATED_INVALID",
  );
  const scheduledEnd = canonicalInstant(
    value.scheduledEnd,
    "HUMAN_INTRO_END_INVALID",
  );
  const duration = Date.parse(scheduledEnd) - Date.parse(scheduledStart);
  if (Date.parse(bookingCreatedAt) > Date.parse(scheduledStart)) {
    throw codedError("HUMAN_INTRO_BOOKING_CREATED_INVALID");
  }
  if (duration < 60_000 || duration > 4 * 60 * 60_000) {
    throw codedError("HUMAN_INTRO_DURATION_INVALID");
  }
  const resumeLinkDisposition = String(
    value.resumeLinkDisposition || "",
  );
  const resumeReceipt = normalizeResumeReceipt(
    value.resumeReceipt,
    resumeLinkDisposition,
  );
  return Object.freeze({
    source: HUMAN_INTRO_SOURCE,
    parserVersion: HUMAN_INTRO_PARSER_VERSION,
    sourceId,
    eventId: humanIntroEventId(sourceId),
    bookingCreatedAt,
    candidateName: candidateName(value.candidateName),
    inviteeEmail: email,
    linkedinUrl: linkedin || null,
    resumeLinkDisposition,
    resumeReceipt,
    scheduledStart,
    scheduledEnd,
  });
}

export function humanIntroPayloadDigest(value) {
  return digestNormalizedHumanIntroPayload(
    normalizeHumanIntroPayload(value),
  );
}

export function humanIntroCallRecord(value) {
  const payload = normalizeHumanIntroPayload(value);
  const payloadDigest = digestNormalizedHumanIntroPayload(payload);
  return {
    id: payload.sourceId,
    humanCall: true,
    humanIntro: true,
    humanPopulation: "role_chat",
    humanIntroSourceId: payload.sourceId,
    humanIntroEventId: payload.eventId,
    humanIntroSource: payload.source,
    humanIntroParserVersion: payload.parserVersion,
    humanIntroPayloadDigest: payloadDigest,
    resumeLinkDisposition: payload.resumeLinkDisposition,
    resumeReceipt: payload.resumeReceipt,
    bookingCreatedAt: payload.bookingCreatedAt,
    bookingCreatedAtSource: "calendar_booking_created_at",
    candidateUserId: "",
    candidate: {
      fullName: payload.candidateName,
      firstName: payload.candidateName.split(/\s+/u)[0] || "",
      email: payload.inviteeEmail,
      linkedin: payload.linkedinUrl || "",
      phone: "",
      scheduledStart: payload.scheduledStart,
      paraformEventId: null,
    },
    transcript: [],
    transcriptPresent: false,
    substance: {
      speakers: 0,
      turns: 0,
      totalChars: 0,
      quieterSpeakerChars: 0,
      louderSpeakerChars: 0,
      substantive: false,
    },
    title: "Calendly Role Chat",
    owner: "David Phillips",
    platform: "GOOGLE_CALENDAR_CALENDLY",
    joinAt: payload.scheduledStart,
    endedAt: payload.scheduledEnd,
    screeningCallLink: "",
  };
}

export function persistedHumanIntroMetadata(call) {
  const sourceId = humanIntroSourceId(call?.humanIntroSourceId);
  const expectedPayload = normalizeHumanIntroPayload({
    source: call?.humanIntroSource,
    parserVersion: call?.humanIntroParserVersion,
    sourceId,
    eventId: call?.humanIntroEventId,
    bookingCreatedAt: call?.bookingCreatedAt,
    candidateName: call?.candidate?.fullName,
    inviteeEmail: call?.candidate?.email,
    linkedinUrl: call?.candidate?.linkedin || null,
    resumeLinkDisposition: call?.resumeLinkDisposition,
    resumeReceipt: call?.resumeReceipt ?? null,
    scheduledStart: call?.joinAt,
    scheduledEnd: call?.endedAt,
  });
  const payloadDigest = digestNormalizedHumanIntroPayload(expectedPayload);
  if (
    call?.humanIntro !== true
    || call?.humanCall !== true
    || call?.humanPopulation !== "role_chat"
    || call?.humanIntroEventId !== humanIntroEventId(sourceId)
    || call?.humanIntroSource !== HUMAN_INTRO_SOURCE
    || call?.humanIntroParserVersion !== HUMAN_INTRO_PARSER_VERSION
    || call?.humanIntroPayloadDigest !== payloadDigest
    || call?.transcriptPresent !== false
  ) {
    throw codedError("HUMAN_INTRO_PROVENANCE_INVALID");
  }
  return {
    calendarIntro: true,
    manualOnly: true,
    sourceId,
    intakeEventId: call.humanIntroEventId,
    source: HUMAN_INTRO_SOURCE,
    parserVersion: HUMAN_INTRO_PARSER_VERSION,
    payloadDigest,
    bookingCreatedAt: expectedPayload.bookingCreatedAt,
    bookingCreatedAtSource: "calendar_booking_created_at",
    resumeLinkDisposition: expectedPayload.resumeLinkDisposition,
    resumeReceipt: expectedPayload.resumeReceipt,
    population: "role_chat",
    platform: "GOOGLE_CALENDAR_CALENDLY",
    transcriptPresent: false,
    profileOnly: true,
    provenanceVerified: true,
    substance: {
      speakers: 0,
      turns: 0,
      quieterSpeakerChars: 0,
      louderSpeakerChars: 0,
    },
    speakerHeuristic: null,
  };
}

export function humanIntroCallFromJob(job) {
  if (!isHumanIntroJob(job?.id)) {
    throw codedError("HUMAN_INTRO_RECORD_REQUIRED");
  }
  const sourceId = sourceIdFromHumanIntroJob(job.id);
  const metadata = job?.humanCallMeta;
  if (
    metadata?.calendarIntro !== true
    || metadata?.manualOnly !== true
    || metadata?.provenanceVerified !== true
    || metadata?.sourceId !== sourceId
    || metadata?.source !== HUMAN_INTRO_SOURCE
    || metadata?.parserVersion !== HUMAN_INTRO_PARSER_VERSION
    || !/^[a-f0-9]{64}$/u.test(String(metadata?.payloadDigest || ""))
  ) {
    throw codedError("HUMAN_INTRO_RECORD_REQUIRED");
  }
  const call = humanIntroCallRecord({
    source: HUMAN_INTRO_SOURCE,
    parserVersion: HUMAN_INTRO_PARSER_VERSION,
    sourceId,
    eventId: humanIntroEventId(sourceId),
    bookingCreatedAt: metadata.bookingCreatedAt,
    candidateName: job?.candidate?.fullName,
    inviteeEmail: job?.candidate?.email,
    linkedinUrl: job?.candidate?.linkedin || null,
    resumeLinkDisposition: metadata.resumeLinkDisposition,
    resumeReceipt: metadata.resumeReceipt ?? null,
    scheduledStart: job?.callStartedAt,
    scheduledEnd: job?.callEndedAt,
  });
  if (call.humanIntroPayloadDigest !== metadata.payloadDigest) {
    throw codedError("HUMAN_INTRO_PAYLOAD_CONFLICT");
  }
  return call;
}

export function humanIntroResumeQueueOptions(
  job,
  { now = Date.now() } = {},
) {
  if (
    !isHumanIntroJob(job?.id)
    || job?.humanIntro !== true
    || job?.state !== "waiting_for_resume"
    || !/^[a-f0-9]{64}$/u.test(
      String(job?.humanCallMeta?.payloadDigest || ""),
    )
  ) {
    throw codedError("HUMAN_INTRO_RESUME_WAIT_INVALID");
  }
  const dueAt = Date.parse(
    String(job?.automation?.resumeWait?.nextCheckAt || ""),
  );
  return {
    source: HUMAN_INTRO_QUEUE_SOURCE,
    eventId:
      `human-intro-resume:${job.id}:${job.humanCallMeta.payloadDigest}`,
    dueAt: Number.isFinite(dueAt) ? dueAt : Number(now),
    callEndedAt: job.callEndedAt || null,
    now: Number(now),
  };
}
