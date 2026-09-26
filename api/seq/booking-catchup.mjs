// BOOKING CATCH-UP — once a day: reconcile the Scheduler + Calendly booking
// indexes against what the webhook/worker path already resolved (0 Paraform
// unless it finds a real, previously-missed match), plus a small bounded
// daily check against Paraform's own Book Time page (item 5). Replaces the
// 10-minute booking-sweep.mjs pass, including its ~100-profile-reads-per-pass
// rotor.
import { cors, requireAuth, hasCookie, cronAuth } from "./_lib/core.mjs";
import { shouldAlert, applyDecisions } from "./_lib/booking-stop.mjs";
import {
  catchUpBookingIndexes,
  bookTimeRotorCheck,
} from "./_lib/booking-protection-catchup.mjs";
import {
  createPacer,
  pacedApplyDecisionsOverrides,
  pacedRelationshipStatusLoader,
} from "./_lib/booking-protection-pace.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";
import { withParaformTelemetrySource } from "../_lib/paraform-telemetry-context.mjs";

export const config = { maxDuration: 120 };

async function warnOnCronRejection(cron) {
  if (cron.ok || !cron.headerPresent) return;
  if (await shouldAlert(`booking-catchup-cron-auth-${cron.reason}`, 3600)) {
    await notifySlack(`:warning: A request to /api/seq/booking-catchup carried \`x-vercel-cron\` but no valid CRON_SECRET bearer (${cron.reason}).`).catch(() => {});
  }
}

async function handleBookingCatchup(req, res) {
  if (cors(req, res)) return;
  const cron = cronAuth(req);
  if (!cron.ok && !(await requireAuth(req, res))) { await warnOnCronRejection(cron); return; }

  const out = { ok: true, indexes: null, bookTime: null };
  // One pacer per invocation, shared by both the index reconciliation and the
  // Book Time rotor below — item 6's <=10/min, one-in-flight ceiling applies
  // across every Paraform call this daily job makes, not per sub-step.
  const pace = createPacer();
  const pacedApplyDecisionsImpl = (decisions) =>
    applyDecisions(decisions, pacedApplyDecisionsOverrides(pace));
  try {
    out.indexes = await catchUpBookingIndexes({
      applyDecisionsImpl: pacedApplyDecisionsImpl,
    });
    if (
      (out.indexes.raydarError || out.indexes.calendlyError)
      && (await shouldAlert("booking-catchup-index-error", 6 * 3600))
    ) {
      await notifySlack(`:warning: Booking catch-up could not fully reconcile bookings (raydar: ${out.indexes.raydarError || "ok"}, calendly: ${out.indexes.calendlyError || "ok"}).`).catch(() => {});
    }
    const raydarPauseErrors = out.indexes.raydar?.pauseErrors?.length || 0;
    const calendlyPauseErrors = out.indexes.calendly?.pauseErrors?.length || 0;
    if ((raydarPauseErrors || calendlyPauseErrors) && (await shouldAlert("booking-catchup-pause-errors", 6 * 3600))) {
      await notifySlack(`:warning: Booking catch-up failed to pause ${raydarPauseErrors + calendlyPauseErrors} previously-missed lead(s); retried next run.`).catch(() => {});
    }
    const caughtRaydar = out.indexes.raydar?.paused || 0;
    const caughtCalendly = out.indexes.calendly?.paused || 0;
    if (caughtRaydar + caughtCalendly > 0) {
      await notifySlack(`:pause_button: Booking catch-up paused ${caughtRaydar + caughtCalendly} candidate(s) the webhook path had missed.`).catch(() => {});
    }
  } catch (error) {
    out.ok = false;
    out.indexesError = String(error?.message || error).slice(0, 200);
  }

  if (hasCookie()) {
    try {
      out.bookTime = await bookTimeRotorCheck({
        relationshipStatusLoader: pacedRelationshipStatusLoader(pace),
        applyDecisionsImpl: pacedApplyDecisionsImpl,
      });
      if (out.bookTime.pauseErrors?.length && (await shouldAlert("booking-catchup-booktime-errors", 6 * 3600))) {
        await notifySlack(`:warning: Booking catch-up's Book Time check failed to pause ${out.bookTime.pauseErrors.length} lead(s); retried next run.`).catch(() => {});
      }
      if (out.bookTime.paused > 0) {
        await notifySlack(`:pause_button: Booking catch-up's Book Time check paused ${out.bookTime.paused} candidate(s) who booked on Paraform's own page.`).catch(() => {});
      }
    } catch (error) {
      out.bookTimeError = String(error?.message || error).slice(0, 200);
    }
  }

  return res.status(200).json({ ...out, ranAt: new Date().toISOString() });
}

export default function handler(req, res) {
  return withParaformTelemetrySource("dashboard-booking", () => handleBookingCatchup(req, res));
}
