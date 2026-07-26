// CALENDLY WEBHOOK — the primary stop-on-booking control.
//
// A candidate books through the Calendly link in a sequence email; Calendly
// pushes invitee.created here within seconds; every active "please book a call"
// lead for that address is paused before the next step can fire.
//
// This is the replacement for polling. The n8n predecessor spent 124.8s per run
// fanning out Calendly invitee reads — more than twice its entire 60s budget —
// to discover something Calendly will simply tell us. The hourly sweep
// (booking-sweep.mjs) remains as a backstop for dropped deliveries and for the
// candidates who book from a different address than the sequence targets.
//
// AUTH: HMAC only. The Google gate in middleware.ts explicitly excludes /api/*
// (matcher: '/((?!api(?:/|$)|login…).*)'), so there is no session to lean on and
// none is wanted — Calendly cannot present one. Unsigned requests get a bare 401.
import { hasCookie } from "./_lib/core.mjs";
import { verifyCalendlyWebhook, calendlyWebhookEvent } from "./_lib/calendly-webhook.mjs";
import {
  pauseForBooking,
  kvGet,
  kvSetNx,
  kvSet,
  kvConfigured,
  K,
  shouldAlert,
} from "./_lib/booking-stop.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";

export const config = { maxDuration: 60 };

const json = (value, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

export async function handleCalendlyWebhook(request, {
  secret = process.env.CALENDLY_WEBHOOK_SECRET,
  pause = pauseForBooking,
  alert = notifySlack,
  hasParaformCookie = hasCookie,
  apply = process.env.BOOKING_STOP_APPLY !== "0",
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
  if (!hasParaformCookie()) return json({ ok: false, error: "no_cookie" }, 503);

  // Idempotency: Calendly retries, and a retry must not re-run the scan.
  if (event.inviteeUri && kvConfigured()) {
    try {
      const claimed = await kvSetNx(K.event(event.inviteeUri), { at: new Date().toISOString() }, 30 * 24 * 3600);
      if (claimed !== "OK" && claimed !== true) {
        const prior = await kvGet(K.event(event.inviteeUri)).catch(() => null);
        return json({ ok: true, duplicate: true, firstSeen: prior?.at || null }, 202);
      }
    } catch {
      // KV unreachable: fall through and pause anyway. Pausing twice is a no-op;
      // NOT pausing is the failure that produced this incident.
    }
  }

  let outcome;
  try {
    outcome = await pause({
      email: event.email,
      bookedAt: event.createdAt || new Date().toISOString(),
      startsAt: event.startsAt,
      eventName: event.eventName,
      apply,
    });
  } catch (error) {
    const expired = error?.code === "AUTH_EXPIRED";
    if (expired && (await shouldAlert("auth-expired"))) {
      await alert(":rotating_light: Booking stop could not pause a booked candidate — the Paraform session cookie is expired. Recapture it; sequence nudges are unprotected until then.").catch(() => {});
    }
    return json({ ok: false, error: expired ? "expired" : "error" }, 503);
  }

  if (outcome.pauseErrors?.length && (await shouldAlert("pause-errors", 3600))) {
    await alert(`:warning: Booking stop failed to pause ${outcome.pauseErrors.length} lead(s) after a Calendly booking — the hourly sweep will retry.`).catch(() => {});
  }

  return json({
    ok: true,
    event: event.event,
    apply,
    matched: outcome.decisions.length,
    paused: outcome.paused,
    pauseErrors: outcome.pauseErrors,
  }, 202);
}

export default {
  async fetch(request) {
    return handleCalendlyWebhook(request);
  },
};
