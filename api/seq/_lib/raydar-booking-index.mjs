import {
  RAYDAR_BOOKING_INDEX_SCHEMA,
  normalizeRaydarBookingIndexItem,
} from "./raydar-booking-contract.mjs";

const DEFAULT_BASE_URL = "https://book.raydar.xyz";
const DEFAULT_LOOKBACK_DAYS = 180;
const MAX_PAGES = 100;
const MAX_PAGE_BYTES = 2_000_000;
const INDEX_FIELDS = new Set([
  "schema",
  "items",
  "nextCursor",
  "complete",
  "generatedAt",
]);

function indexError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactObject(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw indexError(code);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw indexError(code);
}

function validTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function raydarSchedulerBookingStopEnabled() {
  return process.env.RAYDAR_SCHEDULER_BOOKING_STOP_ENABLED === "1";
}

export function raydarSchedulerIndexConfigured() {
  return Boolean(
    String(process.env.RAYDAR_SCHEDULER_INTEGRATION_READ_KEY || "")
    && String(process.env.RAYDAR_SCHEDULER_INTEGRATION_URL || DEFAULT_BASE_URL),
  );
}

function bookingIdentity(booking) {
  return JSON.stringify({
    bookingId: booking.bookingId,
    callType: booking.callType,
    email: booking.candidate.email,
    name: booking.candidate.name,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    bookedAt: booking.bookedAt,
    status: booking.status,
    supersedesBookingId: booking.supersedesBookingId,
  });
}

/**
 * Read the scheduler's private, cursor-complete booking index.
 *
 * There is intentionally no "best effort" return: a missing page, incomplete
 * flag, malformed event, repeated cursor, or transport failure throws. Callers
 * must never convert an incomplete booking source into "this person did not
 * book".
 */
export async function fetchRaydarBookingIndex({
  fetchImpl = fetch,
  baseUrl = process.env.RAYDAR_SCHEDULER_INTEGRATION_URL || DEFAULT_BASE_URL,
  readKey = process.env.RAYDAR_SCHEDULER_INTEGRATION_READ_KEY || "",
  createdAfter = null,
  now = Date.now(),
  lookbackDays = Number(process.env.RAYDAR_SCHEDULER_INDEX_BACK_DAYS || DEFAULT_LOOKBACK_DAYS),
  limit = 100,
  maxPages = MAX_PAGES,
} = {}) {
  if (!readKey) throw indexError("RAYDAR_BOOKING_INDEX_KEY_MISSING");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw indexError("RAYDAR_BOOKING_INDEX_LIMIT_INVALID");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) {
    throw indexError("RAYDAR_BOOKING_INDEX_PAGE_LIMIT_INVALID");
  }
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0 || lookbackDays > 730) {
    throw indexError("RAYDAR_BOOKING_INDEX_LOOKBACK_INVALID");
  }

  let origin;
  try { origin = new URL(baseUrl); }
  catch { throw indexError("RAYDAR_BOOKING_INDEX_URL_INVALID"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash) {
    throw indexError("RAYDAR_BOOKING_INDEX_URL_INVALID");
  }

  const after = createdAfter || new Date(now - lookbackDays * 864e5).toISOString();
  if (!validTimestamp(after)) throw indexError("RAYDAR_BOOKING_INDEX_AFTER_INVALID");

  const byBookingId = new Map();
  let itemCount = 0;
  const seenCursors = new Set();
  let cursor = null;
  let pages = 0;
  let generatedAt = null;

  while (true) {
    if (pages >= maxPages) throw indexError("RAYDAR_BOOKING_INDEX_TRUNCATED");
    const url = new URL("/api/integrations/bookings", origin);
    url.searchParams.set("createdAfter", after);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);

    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${readKey}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw indexError("RAYDAR_BOOKING_INDEX_UNAVAILABLE");
    }
    if (!response.ok) {
      throw indexError(response.status === 401 || response.status === 403
        ? "RAYDAR_BOOKING_INDEX_AUTH"
        : "RAYDAR_BOOKING_INDEX_UNAVAILABLE");
    }

    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_PAGE_BYTES) {
      throw indexError("RAYDAR_BOOKING_INDEX_RESPONSE_TOO_LARGE");
    }
    let body;
    try { body = JSON.parse(raw); }
    catch { throw indexError("RAYDAR_BOOKING_INDEX_JSON_INVALID"); }

    exactObject(body, INDEX_FIELDS, "RAYDAR_BOOKING_INDEX_RESPONSE_INVALID");
    if (body.schema !== RAYDAR_BOOKING_INDEX_SCHEMA || body.complete !== true) {
      throw indexError("RAYDAR_BOOKING_INDEX_INCOMPLETE");
    }
    if (!Array.isArray(body.items)
      || !Object.hasOwn(body, "nextCursor")
      || !validTimestamp(body.generatedAt)) {
      throw indexError("RAYDAR_BOOKING_INDEX_RESPONSE_INVALID");
    }
    generatedAt = body.generatedAt;

    for (const rawBooking of body.items) {
      const booking = normalizeRaydarBookingIndexItem(rawBooking);
      const identity = bookingIdentity(booking);
      const priorBooking = byBookingId.get(booking.bookingId);
      if (priorBooking && priorBooking.identity !== identity) {
        throw indexError("RAYDAR_BOOKING_INDEX_BOOKING_CONFLICT");
      }
      byBookingId.set(booking.bookingId, { identity, booking });
      itemCount++;
    }

    pages++;
    const nextCursor = body.nextCursor;
    if (nextCursor == null) break;
    if (typeof nextCursor !== "string" || !nextCursor || nextCursor.length > 1000) {
      throw indexError("RAYDAR_BOOKING_INDEX_CURSOR_INVALID");
    }
    if (seenCursors.has(nextCursor)) throw indexError("RAYDAR_BOOKING_INDEX_CURSOR_REPEATED");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  const index = new Map();
  let active = 0;
  let cancelled = 0;
  let rescheduled = 0;
  for (const { booking } of byBookingId.values()) {
    if (booking.status === "cancelled") {
      cancelled++;
      continue;
    }
    // A rescheduled row is the immutable, superseded booking—not the
    // replacement. The scheduler emits a separate confirmed row for the new
    // booking, carrying supersedesBookingId back to this history record. If the
    // old row is allowed into the active email index, a rescheduled-away call
    // can keep blocking a future enrollment even when the replacement is
    // cancelled or falls outside the consumer's intended state transition.
    if (booking.status === "rescheduled") {
      rescheduled++;
      continue;
    }
    active++;
    const candidate = booking.candidate.email;
    const prior = index.get(candidate);
    if (!prior || booking.bookedAtMs > prior.bookedAt) {
      index.set(candidate, {
        bookedAt: booking.bookedAtMs,
        startsAt: booking.startsAt,
        eventName: booking.callType === "agent" ? "Agent Call" : "Human Call",
        status: "active",
        source: "raydar_scheduler",
        bookingId: booking.bookingId,
        callType: booking.callType,
      });
    }
  }

  return {
    index,
    items: itemCount,
    bookings: byBookingId.size,
    active,
    cancelled,
    rescheduled,
    pages,
    complete: true,
    createdAfter: after,
    generatedAt,
  };
}
