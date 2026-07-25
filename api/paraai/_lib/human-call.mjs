// Paraform human-call intake adapter. Human jobs are deliberately identified by
// both their `hc-` key and queue source so they can never fall through to the
// Recall Calls API.

import { createHash } from "node:crypto";

import {
  firstEmail,
  normLinkedin,
  normalizeEmail,
  trpcGet,
} from "./core.mjs";

export const HUMAN_CALL_JOB_PREFIX = "hc-";
export const HUMAN_CALL_QUEUE_SOURCE = "human_call_completed";
export const HUMAN_CALL_SOFT_REVIEW_CODE = "human_intro_without_transcript";
export const HUMAN_CALL_SOFT_REVIEW_MESSAGE =
  "human intro call without transcript — preferences confirmed manually";

const HUMAN_CALL_ID = /^[A-Za-z0-9_-]{5,96}$/u;
const HUMAN_JOB_ID = /^hc-[A-Za-z0-9_-]{5,96}$/u;
const SUBSTANCE_MIN_SPEAKERS = 2;
const SUBSTANCE_MIN_QUIETER_CHARS = 400;

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function paraformHumanCallId(value) {
  const id = String(value || "").trim();
  if (!HUMAN_CALL_ID.test(id)) {
    throw codedError("HUMAN_CALL_ID_INVALID", "valid Paraform human-call id required");
  }
  return id;
}

export function humanCallJobId(callId) {
  return `${HUMAN_CALL_JOB_PREFIX}${paraformHumanCallId(callId)}`;
}

export function isHumanCallJob(value) {
  return HUMAN_JOB_ID.test(String(value || "").trim());
}

export function callIdFromHumanJob(value) {
  const id = String(value || "").trim();
  if (!isHumanCallJob(id)) {
    throw codedError("HUMAN_CALL_JOB_ID_INVALID", "valid human-call job id required");
  }
  return paraformHumanCallId(id.slice(HUMAN_CALL_JOB_PREFIX.length));
}

export function humanCallEventId(callId) {
  return createHash("sha256")
    .update("paraai-human-call-v1")
    .update("\0")
    .update(paraformHumanCallId(callId))
    .digest("hex");
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function unwrapCall(value) {
  let current = object(value);
  for (let depth = 0; current && depth < 4; depth += 1) {
    const next = object(current.call)
      || object(current.meeting)
      || object(current.item)
      || object(current.data);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function validDate(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstDate(...values) {
  for (const value of values) {
    const parsed = validDate(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function sourceBookingCreatedAt(call) {
  const candidates = [
    ["booking_created_at", call?.booking_created_at],
    ["booking_created_at", call?.bookingCreatedAt],
    ["event_created_at", call?.event_created_at],
    ["event_created_at", call?.eventCreatedAt],
    ["source_created_at", call?.created_at],
    ["source_created_at", call?.createdAt],
  ]
    .map(([source, value]) => [source, validDate(value)])
    .filter(([, value]) => value != null)
    .sort((left, right) => left[1] - right[1]);
  const selected = candidates[0];
  return selected
    ? {
        bookingCreatedAt: new Date(selected[1]).toISOString(),
        bookingCreatedAtSource: selected[0],
      }
    : {
        bookingCreatedAt: null,
        bookingCreatedAtSource: null,
      };
}

function positiveNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function callTiming(call) {
  const startedAt = firstDate(
    call?.started_at,
    call?.startedAt,
    call?.recording_started_at,
    call?.recordingStartedAt,
    call?.event_scheduled_at,
    call?.eventScheduledAt,
    call?.scheduled_at,
    call?.scheduledAt,
  );
  const explicitEnd = firstDate(
    call?.ended_at,
    call?.endedAt,
    call?.completed_at,
    call?.completedAt,
    call?.recording_ended_at,
    call?.recordingEndedAt,
    call?.event_ended_at,
    call?.eventEndedAt,
    call?.event_end_at,
    call?.eventEndAt,
    call?.scheduled_end_at,
    call?.scheduledEndAt,
    call?.end_time,
    call?.endTime,
  );
  const durationSeconds = positiveNumber(
    call?.duration_seconds,
    call?.duration_secs,
    call?.durationSecs,
    call?.recording_duration_seconds,
    call?.recordingDurationSeconds,
  );
  const durationMinutes = positiveNumber(
    call?.duration_minutes,
    call?.durationMins,
    call?.event_duration_minutes,
    call?.eventDurationMinutes,
    call?.scheduled_duration_minutes,
    call?.scheduledDurationMinutes,
  );
  const inferredEnd = startedAt == null
    ? null
    : durationSeconds != null
      ? startedAt + durationSeconds * 1000
      : durationMinutes != null
        ? startedAt + durationMinutes * 60_000
        : null;
  const endedAt = explicitEnd ?? inferredEnd;
  return {
    startedAt: startedAt == null ? null : new Date(startedAt).toISOString(),
    endedAt: endedAt == null ? null : new Date(endedAt).toISOString(),
  };
}

function wordText(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return firstString(
    value.text,
    value.word,
    value.punctuated_word,
    value.content,
  );
}

function turnText(turn) {
  if (!turn || typeof turn !== "object") return "";
  if (Array.isArray(turn.words)) {
    return turn.words.map(wordText).filter(Boolean).join(" ").trim();
  }
  return wordText(turn.words)
    || firstString(turn.text, turn.transcript, turn.content);
}

function speakerKey(turn) {
  const raw = turn?.speaker_id
    ?? turn?.speakerId
    ?? turn?.speaker
    ?? turn?.speaker_name
    ?? turn?.speakerName;
  if (raw == null || String(raw).trim() === "") return "";
  return String(raw).trim();
}

export function humanTranscriptSubstance(transcript) {
  if (!Array.isArray(transcript)) {
    return {
      speakers: 0,
      turns: 0,
      totalChars: 0,
      quieterSpeakerChars: 0,
      louderSpeakerChars: 0,
      substantive: false,
    };
  }
  const perSpeaker = new Map();
  let totalChars = 0;
  let turns = 0;
  for (const turn of transcript) {
    const speaker = speakerKey(turn);
    const text = turnText(turn);
    if (!speaker || !text) continue;
    const chars = text.length;
    perSpeaker.set(speaker, (perSpeaker.get(speaker) || 0) + chars);
    totalChars += chars;
    turns += 1;
  }
  const ranked = [...perSpeaker.entries()]
    .sort((left, right) => right[1] - left[1]);
  const louderSpeakerChars = ranked[0]?.[1] || 0;
  const quieterSpeakerChars = ranked[1]?.[1] || 0;
  return {
    speakers: perSpeaker.size,
    turns,
    totalChars,
    quieterSpeakerChars,
    louderSpeakerChars,
    substantive: (
      perSpeaker.size >= SUBSTANCE_MIN_SPEAKERS
      && quieterSpeakerChars >= SUBSTANCE_MIN_QUIETER_CHARS
    ),
    // These identifiers are used only while normalizing this in-memory read.
    // They are removed before human-call provenance is persisted on a job.
    louderSpeaker: ranked[0]?.[0] || "",
    quieterSpeaker: ranked[1]?.[0] || "",
  };
}

export function normalizeHumanTranscript(transcript) {
  const substance = humanTranscriptSubstance(transcript);
  const selectedSpeakers = new Set([
    substance.louderSpeaker,
    substance.quieterSpeaker,
  ].filter(Boolean));
  const rows = [];
  for (const turn of Array.isArray(transcript) ? transcript : []) {
    const speaker = speakerKey(turn);
    const text = turnText(turn);
    // The governing heuristic is explicitly the louder/quieter principal
    // speaker pair. Do not mislabel a third participant or noise channel as
    // candidate content and feed it to preference extraction.
    if (!speaker || !text || !selectedSpeakers.has(speaker)) continue;
    rows.push({
      role: speaker === substance.louderSpeaker ? "agent" : "candidate",
      speaker,
      text,
    });
  }
  return {
    rows,
    substance: {
      speakers: substance.speakers,
      turns: substance.turns,
      totalChars: substance.totalChars,
      quieterSpeakerChars: substance.quieterSpeakerChars,
      louderSpeakerChars: substance.louderSpeakerChars,
      substantive: substance.substantive,
    },
  };
}

function descriptionLinkedin(call) {
  const fields = [
    call?.event_description,
    call?.eventDescription,
    call?.calendar_description,
    call?.calendarDescription,
    call?.booking_description,
    call?.bookingDescription,
    call?.description,
    call?.notes,
  ];
  for (const field of fields) {
    const matches = String(field || "").match(
      /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:in|pub)\/[A-Za-z0-9_.%~-]+/giu,
    ) || [];
    for (const match of matches) {
      const normalized = normLinkedin(match);
      if (normalized) return normalized;
    }
  }
  return "";
}

function candidateNameFromTitle(title) {
  const value = String(title || "").trim();
  if (!value) return "";
  const roleChat = value.match(/role\s*chat\s*[|:/-]\s*(.+?)(?:\s+(?:and|\/|<>|\|)\s+david(?:\s+phillips)?)?$/iu);
  if (roleChat?.[1]) return roleChat[1].trim();
  const slash = value.match(/^(.+?)\s*(?:\/|<>|\|)\s*(?:david|alzen)(?:\s+(?:phillips|flores))?$/iu);
  return slash?.[1]?.trim() || "";
}

function paraformCallUrl(call, callId) {
  const candidates = [
    call?.paraAI_screening_call_url,
    call?.paraAiScreeningCallUrl,
    call?.screening_call_url,
    call?.screeningCallUrl,
    call?.call_url,
    call?.callUrl,
    call?.url,
  ];
  for (const value of candidates) {
    try {
      const url = new URL(String(value || ""));
      if (
        url.protocol === "https:"
        && /(^|\.)paraform\.com$/iu.test(url.hostname)
        && url.pathname.includes("/calls/")
      ) {
        return url.toString();
      }
    } catch {
      // Canonical URL below is safer than retaining an untrusted record value.
    }
  }
  return `https://www.paraform.com/calls/${encodeURIComponent(callId)}`;
}

function callPopulation({ title, owner, platform, transcript }) {
  const hasTranscript = Array.isArray(transcript) && transcript.length > 0;
  const roleChat = /\brole\s*chat\b/iu.test(title)
    || (!hasTranscript && /\bdavid\s+phillips\b/iu.test(owner));
  if (roleChat) return "role_chat";
  if (
    hasTranscript
    || /\balzen\s+flores\b/iu.test(owner)
    || /\bphone\b/iu.test(platform)
  ) {
    return "phone_screen";
  }
  return "unknown";
}

export function normalizeHumanCallRecord(value, { callId } = {}) {
  const id = paraformHumanCallId(callId);
  const call = unwrapCall(value);
  if (!call) {
    throw codedError("HUMAN_CALL_NOT_FOUND", "Paraform human call was not found");
  }
  const returnedId = firstString(call.id, call.call_id, call.callId);
  if (returnedId && returnedId !== id) {
    throw codedError("HUMAN_CALL_ID_MISMATCH", "Paraform returned a different human call");
  }
  const candidateUser = object(call.candidate_user)
    || object(call.candidateUser)
    || null;
  const candidate = object(candidateUser?.candidate)
    || object(call.candidate)
    || candidateUser
    || {};
  const title = firstString(call.event_title, call.eventTitle, call.title);
  const owner = firstString(
    call.user?.name,
    call.owner?.name,
    call.recruiter?.name,
    call.owner_name,
    call.ownerName,
  );
  const platform = firstString(
    call.meeting_platform,
    call.meetingPlatform,
    call.platform,
  );
  const transcript = Array.isArray(call.recording_transcript)
    ? call.recording_transcript
    : Array.isArray(call.recordingTranscript)
      ? call.recordingTranscript
      : [];
  const normalizedTranscript = normalizeHumanTranscript(transcript);
  const timing = callTiming(call);
  const email = normalizeEmail(firstEmail({
    candidate_user: candidateUser,
    candidate,
    attendee_emails: call.attendee_emails,
    attendeeEmails: call.attendeeEmails,
    invitees: call.invitees,
    guests: call.guests,
  }));
  const linkedin = normLinkedin(
    firstString(
      candidate.linkedin_user,
      candidate.linkedinUrl,
      candidate.linkedin_url,
      candidateUser?.linkedin_user,
      candidateUser?.linkedinUrl,
      candidateUser?.linkedin_url,
    ),
  ) || descriptionLinkedin(call);
  const scheduledStart = timing.startedAt
    || firstString(call.event_scheduled_at, call.eventScheduledAt);
  const candidateUserId = firstString(
    call.candidate_user_id,
    call.candidateUserId,
    candidateUser?.id,
    candidateUser?.candidate_user_id,
    candidateUser?.candidateUserId,
  );
  const population = callPopulation({
    title,
    owner,
    platform,
    transcript,
  });
  const booking = sourceBookingCreatedAt(call);
  return {
    id,
    humanCall: true,
    humanPopulation: population,
    ...booking,
    candidateUserId,
    candidate: {
      fullName: firstString(
        candidate.name,
        candidate.fullName,
        candidate.full_name,
        candidateUser?.name,
        candidateNameFromTitle(title),
      ),
      firstName: firstString(candidate.firstName, candidate.first_name),
      email,
      linkedin,
      phone: firstString(
        candidate.phone_number,
        candidate.phone,
        candidateUser?.phone_number,
        candidateUser?.phone,
      ),
      scheduledStart,
      paraformEventId: id,
    },
    transcript: normalizedTranscript.rows,
    transcriptPresent: transcript.length > 0,
    substance: normalizedTranscript.substance,
    title,
    owner,
    platform,
    joinAt: timing.startedAt,
    endedAt: timing.endedAt,
    screeningCallLink: paraformCallUrl(call, id),
  };
}

export async function fetchHumanCall(
  callId,
  { trpcGetImpl = trpcGet } = {},
) {
  const id = paraformHumanCallId(callId);
  const record = await trpcGetImpl("candidateUserMeeting.getCallById", { id });
  return normalizeHumanCallRecord(record, { callId: id });
}

export function humanCallReadiness(call) {
  if (!call?.humanCall) {
    return {
      ready: false,
      terminal: true,
      reason: "Paraform human-call provenance is missing",
    };
  }
  if (!String(call?.candidate?.fullName || "").trim()) {
    return {
      ready: false,
      terminal: false,
      reason: "human-call booking identity is still unavailable",
    };
  }
  if (call?.humanPopulation === "role_chat" && !call?.transcriptPresent) {
    return {
      ready: true,
      terminal: false,
      reason: null,
      profileOnly: true,
    };
  }
  if (call?.substance?.substantive === true) {
    return {
      ready: true,
      terminal: false,
      reason: null,
      profileOnly: false,
    };
  }
  if (call?.transcriptPresent) {
    return {
      ready: false,
      terminal: true,
      reason: "human-call transcript failed the two-speaker substance gate",
    };
  }
  return {
    ready: false,
    terminal: false,
    reason: "human-call transcript is still unavailable",
  };
}

export function persistedHumanCallMetadata(call) {
  return {
    paraformCallId: paraformHumanCallId(call?.id),
    population: String(call?.humanPopulation || "unknown"),
    platform: String(call?.platform || "").slice(0, 40) || null,
    bookingCreatedAt: call?.bookingCreatedAt || null,
    bookingCreatedAtSource: call?.bookingCreatedAtSource || null,
    transcriptPresent: call?.transcriptPresent === true,
    profileOnly: (
      call?.humanPopulation === "role_chat"
      && call?.transcriptPresent !== true
    ),
    provenanceVerified: (
      call?.substance?.substantive === true
      || (
        call?.humanPopulation === "role_chat"
        && call?.transcriptPresent !== true
      )
    ),
    substance: {
      speakers: Number(call?.substance?.speakers) || 0,
      turns: Number(call?.substance?.turns) || 0,
      quieterSpeakerChars: Number(call?.substance?.quieterSpeakerChars) || 0,
      louderSpeakerChars: Number(call?.substance?.louderSpeakerChars) || 0,
    },
    speakerHeuristic: {
      assignment: "quieter_candidate_louder_agent",
      validation: "shadow",
    },
  };
}
