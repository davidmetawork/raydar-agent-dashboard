// RAYDAR SCHEDULER BOOKING WEBHOOK — native fast path for stop-on-booking.
//
// This route is additive during migration: Calendly's webhook, the Calendly
// reconciliation sweep, and Paraform relationship-status detection all remain
// active. Native events use their own HMAC contract and durable replay keys; no
// legacy event is relabelled or spoofed as a Raydar scheduler event.
//
// LIGHTWEIGHT REDESIGN (2026-09-26, docs/research/booking-protection-minimum-
// 2026-09-26.md item 3): this hook now ONLY validates, durably records, and
// enqueues. It never calls Paraform and it always answers OK for anything it
// can durably record — it must, or the Scheduler retries an event 6 times
// over ~8 minutes and then drops it. Matching against the live-set index (0
// Paraform requests) and the actual pause (2, only on a real match) happen in
// the background worker (_lib/booking-protection-worker.mjs, run by
// api/seq/booking-worker.mjs every few minutes). A non-2xx here means the
// durable record itself could not be written — a real store outage, not
// anything about Paraform or a pause outcome.
import {
  K,
  kvConfigured,
  kvGet,
  kvSet,
  kvSetNx,
  shouldAlert,
} from "./_lib/booking-stop.mjs";
import {
  normalizeRaydarBookingEvent,
  verifyRaydarBookingWebhook,
} from "./_lib/raydar-booking-contract.mjs";
import {
  raydarSchedulerBookingStopEnabled,
} from "./_lib/raydar-booking-index.mjs";
import { enqueuePendingBooking } from "./_lib/booking-protection-queue.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";

export const config = { maxDuration: 60 };

const MAX_BODY_BYTES = 64 * 1024;
const EVENT_TTL_SECONDS = 180 * 24 * 3600;

// Item 3 requires the hook to "skip Scheduler test/canary bookings". The v1
// event contract (raydar-booking-contract.mjs) has no dedicated test/canary
// flag on the wire — this repo does not own that contract, so rather than
// silently mark the requirement done with no way to satisfy it, this
// recognizes the two signals that ARE available today and are both
// deliberately OFF by default (matching nothing) until configured:
//   - a reserved `sourceAttribution` marker, for a producer that tags
//     synthetic bookings that way (the existing convention: see
//     pause-canary-rearm.mjs's own "operator_pause_canary" tag for Raydar's
//     side of this);
//   - an explicit `bookingId` allow-list, for wiring in the Scheduler's own
//     known cutover-canary booking IDs (scheduler/lib/cutover-canary-config.mjs
//     SCHEDULER_CANARY_*_BOOKING_ID / SCHEDULER_CANARY_AGENT_BURST_BOOKING_IDS
//     in the main Raydar repo) by copying them into this dashboard's env.
// See the PR body's "Docs follow-up" for what still needs confirming with
// whoever owns the Scheduler webhook producer.
const DEFAULT_TEST_SOURCE_ATTRIBUTIONS = "scheduler_test,scheduler_canary,cutover_canary";

function parsedCsvSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function isTestOrCanaryBooking(event, env = process.env) {
  const markers = parsedCsvSet(
    env.RAYDAR_BOOKING_TEST_SOURCE_ATTRIBUTIONS ?? DEFAULT_TEST_SOURCE_ATTRIBUTIONS,
  );
  if (event.sourceAttribution && markers.has(event.sourceAttribution)) return true;
  const testBookingIds = parsedCsvSet(env.RAYDAR_BOOKING_TEST_BOOKING_IDS);
  if (testBookingIds.has(event.bookingId)) return true;
  return false;
}

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
  storeConfigured = kvConfigured,
  claim = kvSetNx,
  readClaim = kvGet,
  write = kvSet,
  enqueue = enqueuePendingBooking,
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

  if (isTestOrCanaryBooking(event)) {
    try {
      await durableWrite(write, eventKey, {
        state: "done",
        receivedAt: new Date(nowMs).toISOString(),
        processedAt: new Date().toISOString(),
        event: event.event,
        skippedTest: true,
      }, EVENT_TTL_SECONDS);
    } catch {
      return json({ ok: false, error: "store_unavailable" }, 503);
    }
    return json({ ok: true, event: event.event, skippedTest: true }, 202);
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

  // Durably enqueue for the background worker and answer OK — no Paraform
  // call happens on this path at all. This is the whole point of item 3: the
  // hook must keep answering OK, or the Scheduler retries an event 6 times
  // over ~8 minutes and then drops it.
  try {
    await enqueue({
      eventId: event.eventId,
      email: event.candidate.email,
      bookedAtMs: event.bookedAtMs,
      effectiveBookedAtMs: event.effectiveBookedAtMs,
      startsAt: event.startsAt,
      eventName: event.callType === "agent" ? "Agent Call" : "Human Call",
      source: "raydar_scheduler",
      bookingId: event.bookingId,
      enqueuedAt: new Date(nowMs).toISOString(),
    });
    await durableWrite(write, eventKey, {
      state: "done",
      receivedAt: new Date(nowMs).toISOString(),
      processedAt: new Date().toISOString(),
      event: event.event,
      queued: true,
    }, EVENT_TTL_SECONDS);
  } catch {
    return json({ ok: false, error: "store_unavailable" }, 503);
  }

  return json({
    ok: true,
    event: event.event,
    queued: true,
  }, 202);
}

export default {
  async fetch(request) {
    return handleRaydarBookingWebhook(request);
  },
};
