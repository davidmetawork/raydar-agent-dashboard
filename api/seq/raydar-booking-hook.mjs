// RAYDAR SCHEDULER BOOKING WEBHOOK — native fast path for stop-on-booking.
//
// This route is additive during migration: Calendly's webhook, the Calendly
// reconciliation sweep, and Paraform relationship-status detection all remain
// active. Native events use their own HMAC contract and durable replay keys; no
// legacy event is relabelled or spoofed as a Raydar scheduler event.
import { hasCookie } from "./_lib/core.mjs";
import {
  K,
  kvConfigured,
  kvGet,
  kvSet,
  kvSetNx,
  pauseForBooking,
  shouldAlert,
} from "./_lib/booking-stop.mjs";
import {
  normalizeRaydarBookingEvent,
  verifyRaydarBookingWebhook,
} from "./_lib/raydar-booking-contract.mjs";
import {
  raydarSchedulerBookingStopEnabled,
} from "./_lib/raydar-booking-index.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";

export const config = { maxDuration: 60 };

const MAX_BODY_BYTES = 64 * 1024;
const EVENT_TTL_SECONDS = 180 * 24 * 3600;

const json = (value, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

async function durableWrite(write, key, value, ttlSeconds) {
  const result = await write(key, value, ttlSeconds);
  if (result !== "OK" && result !== true) {
    const error = new Error("STORE_WRITE_FAILED");
    error.code = "STORE_WRITE_FAILED";
    throw error;
  }
}

export async function handleRaydarBookingWebhook(request, {
  enabled = raydarSchedulerBookingStopEnabled(),
  secret = process.env.RAYDAR_SCHEDULER_WEBHOOK_SECRET,
  apply = process.env.BOOKING_STOP_APPLY !== "0",
  hasParaformCookie = hasCookie,
  storeConfigured = kvConfigured,
  claim = kvSetNx,
  readClaim = kvGet,
  write = kvSet,
  pause = pauseForBooking,
  alert = notifySlack,
  alertAllowed = shouldAlert,
  nowMs = Date.now(),
} = {}) {
  if (request.method !== "POST") return json({ ok: false, error: "POST_only" }, 405);
  if (!enabled) return json({ ok: false, error: "not_enabled" }, 503);
  if (String(secret || "").length < 32) {
    return json({ ok: false, error: "not_configured" }, 503);
  }
  if (!storeConfigured()) return json({ ok: false, error: "store_unavailable" }, 503);

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload_too_large" }, 413);
  }

  let verified;
  try {
    verified = verifyRaydarBookingWebhook({
      secret,
      headers: request.headers,
      rawBody: raw,
      nowMs,
    });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.code || "verification_failed"),
    }, 401);
  }

  let event;
  try {
    event = normalizeRaydarBookingEvent(JSON.parse(raw));
    if (event.eventId !== verified.eventId) {
      const error = new Error("RAYDAR_BOOKING_EVENT_ID_MISMATCH");
      error.code = "RAYDAR_BOOKING_EVENT_ID_MISMATCH";
      throw error;
    }
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.code || "invalid_json"),
    }, 400);
  }

  if (!hasParaformCookie()) return json({ ok: false, error: "no_cookie" }, 503);

  const eventKey = K.raydarEvent(event.eventId);
  try {
    const won = await claim(eventKey, {
      state: "received",
      receivedAt: new Date(nowMs).toISOString(),
      event: event.event,
    }, EVENT_TTL_SECONDS);
    if (won !== "OK" && won !== true) {
      const prior = await readClaim(eventKey);
      if (prior?.state === "done") {
        return json({ ok: true, duplicate: true, firstSeen: prior.receivedAt || null }, 202);
      }
      // A prior delivery won the durable claim but failed before settlement.
      // Retrying the pause is safe and is preferable to silently dropping it.
    }
  } catch {
    return json({ ok: false, error: "store_unavailable" }, 503);
  }

  if (
    event.event === "booking.cancelled"
    || event.event === "booking.rescheduled"
  ) {
    try {
      await durableWrite(write, K.raydarCancel(event.bookingId), {
        at: event.occurredAt,
        callType: event.callType,
        event: event.event,
      }, EVENT_TTL_SECONDS);
      await durableWrite(write, eventKey, {
        state: "done",
        receivedAt: new Date(nowMs).toISOString(),
        processedAt: new Date().toISOString(),
        event: event.event,
      }, EVENT_TTL_SECONDS);
    } catch {
      return json({ ok: false, error: "store_unavailable" }, 503);
    }
    if (
      event.event === "booking.cancelled"
      && await alertAllowed(`raydar-cancel:${event.bookingId}`, 3600)
    ) {
      await alert(":calendar: Raydar booking cancelled — a paused sequence lead may need resuming. Sequences are never auto-resumed.").catch(() => {});
    }
    return json({ ok: true, event: event.event, recorded: true }, 202);
  }

  let outcome;
  try {
    outcome = await pause({
      email: event.candidate.email,
      bookedAt: new Date(event.effectiveBookedAtMs).toISOString(),
      startsAt: event.startsAt,
      eventName: event.callType === "agent" ? "Agent Call" : "Human Call",
      source: "raydar_scheduler",
      apply,
    });
  } catch (error) {
    const expired = error?.code === "AUTH_EXPIRED";
    if (expired && (await alertAllowed("raydar-booking-auth-expired"))) {
      await alert(":rotating_light: Raydar booking stop could not pause a booked candidate — the Paraform session cookie is expired.").catch(() => {});
    }
    return json({ ok: false, error: expired ? "expired" : "error" }, 503);
  }

  if (outcome.pauseErrors?.length && (await alertAllowed("raydar-booking-pause-errors", 3600))) {
    await alert(`:warning: Raydar booking stop failed to pause ${outcome.pauseErrors.length} lead(s); the hourly native index sweep will retry.`).catch(() => {});
  }
  if (outcome.pauseErrors?.length) {
    // Leave the durable claim in `received`: the scheduler should retry this
    // idempotent pause until every matched lead passes read-back.
    return json({
      ok: false,
      error: "pause_incomplete",
      pauseErrors: outcome.pauseErrors.length,
    }, 503);
  }

  try {
    await durableWrite(write, eventKey, {
      state: "done",
      receivedAt: new Date(nowMs).toISOString(),
      processedAt: new Date().toISOString(),
      event: event.event,
      matched: outcome.decisions.length,
      paused: outcome.paused,
      deferred: Boolean(outcome.deferred),
    }, EVENT_TTL_SECONDS);
  } catch {
    // The pause is idempotent. Return 503 so the scheduler retries and the
    // durable record eventually reaches `done`.
    return json({ ok: false, error: "store_unavailable" }, 503);
  }

  return json({
    ok: true,
    event: event.event,
    apply,
    matched: outcome.decisions.length,
    paused: outcome.paused,
    deferred: Boolean(outcome.deferred),
    pauseErrors: outcome.pauseErrors.length,
  }, 202);
}

export default {
  async fetch(request) {
    return handleRaydarBookingWebhook(request);
  },
};
