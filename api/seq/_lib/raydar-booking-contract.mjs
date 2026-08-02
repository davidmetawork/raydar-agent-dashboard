import { createHmac, timingSafeEqual } from "node:crypto";

export const RAYDAR_BOOKING_EVENT_SCHEMA = "raydar-booking-event-v1";
export const RAYDAR_BOOKING_INDEX_SCHEMA = "raydar-booking-index-v1";
export const RAYDAR_BOOKING_HOOK_PATH = "/api/seq/raydar-booking-hook";
export const RAYDAR_BOOKING_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

const EVENT_STATUS = new Map([
  ["booking.confirmed", "confirmed"],
  ["booking.rescheduled", "rescheduled"],
  ["booking.cancelled", "cancelled"],
]);

const EVENT_FIELDS = new Set([
  "schema",
  "event",
  "eventId",
  "occurredAt",
  "bookingId",
  "callType",
  "candidate",
  "startsAt",
  "endsAt",
  "bookedAt",
  "sourceAttribution",
  "status",
  "supersedesBookingId",
]);
const INDEX_ITEM_FIELDS = new Set([
  "bookingId",
  "callType",
  "candidate",
  "startsAt",
  "endsAt",
  "bookedAt",
  "sourceAttribution",
  "status",
  "supersedesBookingId",
]);
const CANDIDATE_FIELDS = new Set(["email", "name"]);
const BOOKING_STATUSES = new Set(["confirmed", "rescheduled", "cancelled"]);

function contractError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactFields(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(code);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw contractError(code);
  }
}

function requiredString(value, code, { max = 256 } = {}) {
  if (typeof value !== "string" || !value || value.length > max || value !== value.trim()) {
    throw contractError(code);
  }
  return value;
}

function opaqueId(value, prefix, code) {
  const id = requiredString(value, code, { max: 200 });
  const leading = prefix === "bevt" ? "[A-Za-z0-9_-]" : "[A-Za-z0-9]";
  const pattern = new RegExp(`^${prefix}_${leading}[A-Za-z0-9_-]{0,191}$`);
  if (!pattern.test(id)) throw contractError(code);
  return id;
}

function timestamp(value, code) {
  const raw = requiredString(value, code, { max: 64 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw contractError(code);
  }
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) throw contractError(code);
  return { raw, milliseconds };
}

function normalizedEmail(value) {
  const email = requiredString(value, "RAYDAR_BOOKING_EMAIL_INVALID", { max: 320 });
  if (email !== email.toLowerCase() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw contractError("RAYDAR_BOOKING_EMAIL_INVALID");
  }
  return email;
}

function candidateName(value) {
  if (value === null) return null;
  const name = requiredString(value, "RAYDAR_BOOKING_NAME_INVALID", { max: 200 });
  if (/[\u0000-\u001f\u007f]/.test(name)) throw contractError("RAYDAR_BOOKING_NAME_INVALID");
  return name;
}

function sourceAttribution(value) {
  // v1 originally shipped without attribution. Accept the missing key during
  // the consumer-first deployment overlap, while still rejecting every
  // malformed value when the producer supplies it.
  if (value == null) return null;
  const source = requiredString(
    value,
    "RAYDAR_BOOKING_SOURCE_ATTRIBUTION_INVALID",
    { max: 64 },
  );
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(source)) {
    throw contractError("RAYDAR_BOOKING_SOURCE_ATTRIBUTION_INVALID");
  }
  return source;
}

/**
 * Validate and project the complete v1 booking event. Unknown keys fail closed:
 * this feed controls candidate-facing sequence suppression, so schema drift must
 * be explicit rather than silently interpreted as "not booked".
 */
export function normalizeRaydarBookingEvent(value) {
  exactFields(value, EVENT_FIELDS, "RAYDAR_BOOKING_EVENT_INVALID");
  if (value.schema !== RAYDAR_BOOKING_EVENT_SCHEMA) {
    throw contractError("RAYDAR_BOOKING_SCHEMA_INVALID");
  }

  const event = requiredString(value.event, "RAYDAR_BOOKING_EVENT_KIND_INVALID");
  const expectedStatus = EVENT_STATUS.get(event);
  if (!expectedStatus) throw contractError("RAYDAR_BOOKING_EVENT_KIND_INVALID");
  if (value.status !== expectedStatus) throw contractError("RAYDAR_BOOKING_STATUS_INVALID");

  const eventId = opaqueId(value.eventId, "bevt", "RAYDAR_BOOKING_EVENT_ID_INVALID");
  const bookingId = opaqueId(value.bookingId, "bk", "RAYDAR_BOOKING_ID_INVALID");
  const supersedesBookingId = value.supersedesBookingId === null
    ? null
    : opaqueId(value.supersedesBookingId, "bk", "RAYDAR_BOOKING_SUPERSEDES_INVALID");
  if (supersedesBookingId === bookingId) {
    throw contractError("RAYDAR_BOOKING_SUPERSEDES_INVALID");
  }

  if (value.callType !== "agent" && value.callType !== "human") {
    throw contractError("RAYDAR_BOOKING_CALL_TYPE_INVALID");
  }

  exactFields(value.candidate, CANDIDATE_FIELDS, "RAYDAR_BOOKING_CANDIDATE_INVALID");
  const email = normalizedEmail(value.candidate.email);
  const name = candidateName(value.candidate.name);

  const occurredAt = timestamp(value.occurredAt, "RAYDAR_BOOKING_OCCURRED_AT_INVALID");
  const startsAt = timestamp(value.startsAt, "RAYDAR_BOOKING_START_INVALID");
  const endsAt = timestamp(value.endsAt, "RAYDAR_BOOKING_END_INVALID");
  const bookedAt = timestamp(value.bookedAt, "RAYDAR_BOOKING_BOOKED_AT_INVALID");
  const selectedSourceAttribution = sourceAttribution(
    value.sourceAttribution,
  );
  if (endsAt.milliseconds <= startsAt.milliseconds) {
    throw contractError("RAYDAR_BOOKING_RANGE_INVALID");
  }

  return {
    schema: RAYDAR_BOOKING_EVENT_SCHEMA,
    event,
    eventId,
    occurredAt: occurredAt.raw,
    occurredAtMs: occurredAt.milliseconds,
    bookingId,
    callType: value.callType,
    candidate: { email, name },
    startsAt: startsAt.raw,
    startsAtMs: startsAt.milliseconds,
    endsAt: endsAt.raw,
    endsAtMs: endsAt.milliseconds,
    bookedAt: bookedAt.raw,
    bookedAtMs: bookedAt.milliseconds,
    sourceAttribution: selectedSourceAttribution,
    effectiveBookedAtMs: event === "booking.rescheduled"
      ? Math.max(bookedAt.milliseconds, occurredAt.milliseconds)
      : bookedAt.milliseconds,
    status: expectedStatus,
    supersedesBookingId,
  };
}

/**
 * Validate one current-booking record from `raydar-booking-index-v1`.
 *
 * Index rows intentionally omit webhook delivery metadata (`schema`, `event`,
 * `eventId`, and `occurredAt`). They are stable current-state records used for
 * reconciliation, not replayable webhook envelopes.
 */
export function normalizeRaydarBookingIndexItem(value) {
  exactFields(value, INDEX_ITEM_FIELDS, "RAYDAR_BOOKING_INDEX_ITEM_INVALID");

  const bookingId = opaqueId(value.bookingId, "bk", "RAYDAR_BOOKING_ID_INVALID");
  const supersedesBookingId = value.supersedesBookingId === null
    ? null
    : opaqueId(value.supersedesBookingId, "bk", "RAYDAR_BOOKING_SUPERSEDES_INVALID");
  if (supersedesBookingId === bookingId) {
    throw contractError("RAYDAR_BOOKING_SUPERSEDES_INVALID");
  }
  if (value.callType !== "agent" && value.callType !== "human") {
    throw contractError("RAYDAR_BOOKING_CALL_TYPE_INVALID");
  }
  if (!BOOKING_STATUSES.has(value.status)) {
    throw contractError("RAYDAR_BOOKING_STATUS_INVALID");
  }

  exactFields(value.candidate, CANDIDATE_FIELDS, "RAYDAR_BOOKING_CANDIDATE_INVALID");
  const email = normalizedEmail(value.candidate.email);
  const name = candidateName(value.candidate.name);
  const startsAt = timestamp(value.startsAt, "RAYDAR_BOOKING_START_INVALID");
  const endsAt = timestamp(value.endsAt, "RAYDAR_BOOKING_END_INVALID");
  const bookedAt = timestamp(value.bookedAt, "RAYDAR_BOOKING_BOOKED_AT_INVALID");
  const selectedSourceAttribution = sourceAttribution(
    value.sourceAttribution,
  );
  if (endsAt.milliseconds <= startsAt.milliseconds) {
    throw contractError("RAYDAR_BOOKING_RANGE_INVALID");
  }

  return {
    bookingId,
    callType: value.callType,
    candidate: { email, name },
    startsAt: startsAt.raw,
    startsAtMs: startsAt.milliseconds,
    endsAt: endsAt.raw,
    endsAtMs: endsAt.milliseconds,
    bookedAt: bookedAt.raw,
    bookedAtMs: bookedAt.milliseconds,
    sourceAttribution: selectedSourceAttribution,
    status: value.status,
    supersedesBookingId,
  };
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? value.join(" ") : String(value || "");
}

/**
 * Authenticate exact raw bytes. Body parsing and schema projection happen only
 * after this passes; `expectedEventId` then binds the signed header to the body.
 */
export function verifyRaydarBookingWebhook({
  secret,
  headers,
  rawBody,
  expectedEventId,
  nowMs = Date.now(),
  toleranceSeconds = RAYDAR_BOOKING_SIGNATURE_TOLERANCE_SECONDS,
  method = "POST",
  path = RAYDAR_BOOKING_HOOK_PATH,
} = {}) {
  const key = String(secret || "");
  if (key.length < 32) throw contractError("RAYDAR_BOOKING_SECRET_MISSING");

  const rawTimestamp = headerValue(headers, "x-raydar-timestamp");
  if (!/^\d{10}$/.test(rawTimestamp)) {
    throw contractError("RAYDAR_BOOKING_TIMESTAMP_INVALID");
  }
  const timestampSeconds = Number(rawTimestamp);
  if (Math.abs(nowMs / 1000 - timestampSeconds) > toleranceSeconds) {
    throw contractError("RAYDAR_BOOKING_TIMESTAMP_STALE");
  }

  const eventId = headerValue(headers, "x-raydar-event-id");
  if (!eventId || (expectedEventId && eventId !== expectedEventId)) {
    throw contractError("RAYDAR_BOOKING_EVENT_ID_MISMATCH");
  }

  const supplied = headerValue(headers, "x-raydar-signature");
  if (!/^v1=[0-9a-f]{64}$/.test(supplied)) {
    throw contractError("RAYDAR_BOOKING_SIGNATURE_INVALID");
  }
  const canonical = `${rawTimestamp}\n${method}\n${path}\n${String(rawBody ?? "")}`;
  const expected = `v1=${createHmac("sha256", key).update(canonical).digest("hex")}`;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw contractError("RAYDAR_BOOKING_SIGNATURE_INVALID");
  }

  return { timestampSeconds, eventId };
}
