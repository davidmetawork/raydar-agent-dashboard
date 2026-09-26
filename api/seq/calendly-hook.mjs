// CALENDLY WEBHOOK — the primary stop-on-booking control.
//
// A candidate books through the Calendly link in a sequence email; Calendly
// pushes invitee.created here within seconds; every active "please book a call"
// lead for that address is enqueued for the background matcher
// (_lib/booking-protection-worker.mjs) before the next sequence step can fire.
//
// LIGHTWEIGHT REDESIGN (2026-09-26, docs/research/booking-protection-minimum-
// 2026-09-26.md item 3): like the Scheduler hook, this route now only
// validates, durably records, and enqueues — it never calls Paraform and it
// always answers OK for anything it can durably record. The daily catch-up
// (api/seq/booking-catchup.mjs) remains the backstop for dropped deliveries
// and for candidates who book from a different address than the sequence
// targets.
//
// AUTH: HMAC only. The Google gate in middleware.ts explicitly excludes /api/*
// (matcher: '/((?!api(?:/|$)|login…).*)'), so there is no session to lean on and
// none is wanted — Calendly cannot present one. Unsigned requests get a bare 401.
import { verifyCalendlyWebhook, calendlyWebhookEvent } from "./_lib/calendly-webhook.mjs";
import {
  kvGet,
  kvSetNx,
  kvSet,
  kvConfigured,
  K,
  shouldAlert,
} from "./_lib/booking-stop.mjs";
import { enqueuePendingBooking } from "./_lib/booking-protection-queue.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";

export const config = { maxDuration: 60 };

const json = (value, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

export async function handleCalendlyWebhook(request, {
  secret = process.env.CALENDLY_WEBHOOK_SECRET,
  alert = notifySlack,
  enqueue = enqueuePendingBooking,
  claim = kvSetNx,
  readClaim = kvGet,
  nowMs = Date.now(),
} = {}) {
  if (request.method !== "POST") return json({ ok: false, error: "POST_only" }, 405);

  const raw = await request.text();
  try {
    verifyCalendlyWebhook({ secret, headers: request.headers, payload: raw });
  } catch (error) {
    // Bounded diagnostic only: never echo headers, body, or addresses.
    return json({ ok: false, error: String(error?.code || "verification_failed") }, 401);
  }

  let body;
  try { body = JSON.parse(raw); }
  catch { return json({ ok: false, error: "invalid_json" }, 400); }

  const event = calendlyWebhookEvent(body);

  // invitee.canceled: RECORD ONLY. Auto-unpausing would re-nag someone who
  // cancelled precisely because they are no longer interested — a human decides.
  if (event.event === "invitee.canceled") {
    if (event.inviteeUri) await kvSet(K.cancel(event.inviteeUri), { at: new Date().toISOString(), eventName: event.eventName }, 90 * 24 * 3600);
    if (await shouldAlert(`cancel:${event.inviteeUri || event.email}`, 3600)) {
      await alert(`:calendar: Calendly booking cancelled — a paused sequence lead may need resuming (${event.eventName || "booking"}). Sequences are never auto-resumed.`).catch(() => {});
    }
    return json({ ok: true, event: event.event, recorded: true }, 202);
  }

  if (event.event !== "invitee.created") return json({ ok: true, ignored: true }, 202);
  if (!event.email) return json({ ok: true, ignored: "no_email" }, 202);

  const bookedAtMs = Date.parse(event.createdAt || "");
  const effectiveBookedAtMs = Number.isFinite(bookedAtMs) ? bookedAtMs : nowMs;
  const eventId = event.inviteeUri
    ? `calendly:${event.inviteeUri}`
    : `calendly:${event.email}:${effectiveBookedAtMs}`;

  // Idempotency: Calendly retries, and a retry must not re-enqueue.
  if (kvConfigured()) {
    try {
      const claimed = await claim(K.event(eventId), { at: new Date(nowMs).toISOString() }, 30 * 24 * 3600);
      if (claimed !== "OK" && claimed !== true) {
        const prior = await readClaim(K.event(eventId)).catch(() => null);
        return json({ ok: true, duplicate: true, firstSeen: prior?.at || null }, 202);
      }
    } catch {
      // KV unreachable for the dedup claim: fall through and enqueue anyway.
      // Enqueuing twice just makes the worker match twice (a pause is
      // idempotent); NOT enqueuing is the failure that produced the original
      // incident this whole system exists to prevent.
    }
  }

  try {
    await enqueue({
      eventId,
      email: event.email,
      bookedAtMs: effectiveBookedAtMs,
      effectiveBookedAtMs,
      startsAt: event.startsAt,
      eventName: event.eventName,
      source: "calendly",
      bookingId: eventId,
      enqueuedAt: new Date(nowMs).toISOString(),
    });
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
    return handleCalendlyWebhook(request);
  },
};
