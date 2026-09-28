// BOOKING WORKER — drains the pending-booking queue every few minutes.
//
// The webhooks (raydar-booking-hook.mjs, calendly-hook.mjs) only ever
// enqueue now; this is the only thing that ever pauses anyone. Matching
// against the live-set index is 0 Paraform requests; only a real match costs
// 2 (pause + read-back verify). Cheap and safe to run often: an empty queue
// makes zero Paraform calls at all.
import { cors, requireAuth, cronAuth, ensureParaformSession } from "./_lib/core.mjs";
import { shouldAlert } from "./_lib/booking-stop.mjs";
import { drainPendingBookings } from "./_lib/booking-protection-worker.mjs";
import { pendingQueueSummary } from "./_lib/booking-protection-queue.mjs";
import {
  createPacer,
  pacedApplyDecisionsOverrides,
} from "./_lib/booking-protection-pace.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";
import { withParaformTelemetrySource } from "../_lib/paraform-telemetry-context.mjs";

export const config = { maxDuration: 120 };

const STUCK_PENDING_AGE_MS = 6 * 3600 * 1000; // §4 "lost or delayed events" cover

// A held job waits for the next daily refresh to read the sequences the last
// one could not. Past a full day plus margin, that refresh has run and not
// cleared it, so a human has to look. The job is still never dropped before
// its record expires (PENDING_JOB_TTL_SECONDS, 14 days).
export function heldAlertAgeMs(env = process.env) {
  const hours = Number(env.BOOKING_STOP_LITE_HOLD_ALERT_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 26) * 3600 * 1000;
}

export function heldAlertText({ held, oldestHeldAgeMs, heldSequenceIds = [], unverifiedSequences = [] }) {
  const nameById = new Map(unverifiedSequences.map((s) => [s.id, s.name]));
  const names = heldSequenceIds.map((id) => nameById.get(id) || id).filter(Boolean);
  const listed = names.slice(0, 5).join(", ") + (names.length > 5 ? ` and ${names.length - 5} more` : "");
  return `:rotating_light: Booking worker is holding ${held} booking(s), the oldest for ${Math.round(oldestHeldAgeMs / 3600000)}h, because the live-set index could not read ${listed ? `these sequences: ${listed}` : "one or more sequences"}. They stay queued, not dropped, but the daily refresh has not cleared them, so those candidates may still get nudges. Someone needs to find out why those sequences fail to read.`;
}

async function warnOnCronRejection(cron) {
  if (cron.ok || !cron.headerPresent) return;
  if (await shouldAlert(`booking-worker-cron-auth-${cron.reason}`, 3600)) {
    await notifySlack(`:warning: A request to /api/seq/booking-worker carried \`x-vercel-cron\` but no valid CRON_SECRET bearer (${cron.reason}). Pending bookings will not be matched if scheduled ticks cannot authenticate.`).catch(() => {});
  }
}

async function handleBookingWorker(req, res) {
  if (cors(req, res)) return;
  const cron = cronAuth(req);
  if (!cron.ok && !(await requireAuth(req, res))) { await warnOnCronRejection(cron); return; }
  await ensureParaformSession();

  try {
    const pace = createPacer();
    const result = await drainPendingBookings({
      applyDecisionsOverrides: pacedApplyDecisionsOverrides(pace),
    });
    const queue = await pendingQueueSummary().catch(() => null);
    // Held jobs are waiting by design and have their own alert below; this
    // one is for jobs nothing is working on.
    const stuckAgeMs = queue?.oldestUnheldAgeMs ?? null;
    if (
      stuckAgeMs != null
      && stuckAgeMs > STUCK_PENDING_AGE_MS
      && (await shouldAlert("booking-worker-stuck-pending", 3600))
    ) {
      await notifySlack(`:rotating_light: Booking worker has a pending booking older than ${Math.round(stuckAgeMs / 3600000)}h — it is not being matched. Check /api/seq/health and the live-set index age.`).catch(() => {});
    }
    if (
      queue?.oldestHeldAgeMs != null
      && queue.oldestHeldAgeMs > heldAlertAgeMs()
      && (await shouldAlert("booking-worker-held", 6 * 3600))
    ) {
      await notifySlack(heldAlertText({
        held: queue.held,
        oldestHeldAgeMs: queue.oldestHeldAgeMs,
        heldSequenceIds: queue.heldSequenceIds,
        unverifiedSequences: result.unverifiedSequences,
      })).catch(() => {});
    }
    if (result.missing > 0 && (await shouldAlert("booking-worker-missing", 6 * 3600))) {
      await notifySlack(`:warning: Booking worker removed ${result.missing} queued booking(s) whose record was gone: expired after 14 days unmatched (a hold that never cleared), or never written. Those bookings were never cleared against a complete index.`).catch(() => {});
    }
    if (
      result.pending > 0
      && !result.liveSetReady
      && (await shouldAlert("booking-worker-liveset-stale", 3600))
    ) {
      await notifySlack(":warning: Booking worker has pending bookings but no usable live-set index — the daily refresh may be failing. See /api/seq/booking-liveset-refresh.").catch(() => {});
    }
    if (result.pauseErrors.length && (await shouldAlert("booking-worker-pause-errors", 3600))) {
      await notifySlack(`:warning: Booking worker failed to pause ${result.pauseErrors.length} booked lead(s); left queued for the next tick.`).catch(() => {});
    }
    if (result.paused > 0) {
      await notifySlack(`:pause_button: Booking worker paused ${result.paused} booked candidate(s) (${result.matched} matched of ${result.processed} processed).`).catch(() => {});
    }
    return res.status(200).json({
      ok: true,
      pending: result.pending,
      processed: result.processed,
      matched: result.matched,
      paused: result.paused,
      deferred: result.deferred,
      cancelled: result.cancelled,
      held: result.held,
      missing: result.missing,
      unreadable: result.unreadable,
      pauseErrors: result.pauseErrors.length,
      liveSetReady: result.liveSetReady,
      liveSetUnverifiedSequences: result.unverifiedSequences.length,
      oldestPendingAgeMinutes: queue?.oldestPendingAgeMs == null ? null : Math.round(queue.oldestPendingAgeMs / 60000),
      oldestHeldAgeMinutes: queue?.oldestHeldAgeMs == null ? null : Math.round(queue.oldestHeldAgeMs / 60000),
      ranAt: new Date().toISOString(),
    });
  } catch (e) {
    if (await shouldAlert("booking-worker-error", 3600)) {
      await notifySlack(`:rotating_light: Booking worker failed: ${String(e?.message || e).slice(0, 160)}`).catch(() => {});
    }
    return res.status(200).json({ ok: false, error: "error", detail: String(e?.message || e).slice(0, 200) });
  }
}

export default function handler(req, res) {
  return withParaformTelemetrySource("dashboard-booking", () => handleBookingWorker(req, res));
}
