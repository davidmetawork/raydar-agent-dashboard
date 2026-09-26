// BOOKING WORKER — drains the pending-booking queue every few minutes.
//
// The webhooks (raydar-booking-hook.mjs, calendly-hook.mjs) only ever
// enqueue now; this is the only thing that ever pauses anyone. Matching
// against the live-set index is 0 Paraform requests; only a real match costs
// 2 (pause + read-back verify). Cheap and safe to run often: an empty queue
// makes zero Paraform calls at all.
import { cors, requireAuth, cronAuth } from "./_lib/core.mjs";
import { shouldAlert } from "./_lib/booking-stop.mjs";
import { drainPendingBookings } from "./_lib/booking-protection-worker.mjs";
import { oldestPendingAgeMs } from "./_lib/booking-protection-queue.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";
import { withParaformTelemetrySource } from "../_lib/paraform-telemetry-context.mjs";

export const config = { maxDuration: 120 };

const STUCK_PENDING_AGE_MS = 6 * 3600 * 1000; // §4 "lost or delayed events" cover

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

  try {
    const result = await drainPendingBookings({});
    const stuckAgeMs = await oldestPendingAgeMs().catch(() => null);
    if (
      stuckAgeMs != null
      && stuckAgeMs > STUCK_PENDING_AGE_MS
      && (await shouldAlert("booking-worker-stuck-pending", 3600))
    ) {
      await notifySlack(`:rotating_light: Booking worker has a pending booking older than ${Math.round(stuckAgeMs / 3600000)}h — it is not being matched. Check /api/seq/health and the live-set index age.`).catch(() => {});
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
      pauseErrors: result.pauseErrors.length,
      liveSetReady: result.liveSetReady,
      oldestPendingAgeMinutes: stuckAgeMs == null ? null : Math.round(stuckAgeMs / 60000),
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
