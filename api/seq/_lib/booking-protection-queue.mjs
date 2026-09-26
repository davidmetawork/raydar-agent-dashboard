// ─────────────────────────────────────────────────────────────────────────────
// PENDING-BOOKING QUEUE — what the webhooks now do instead of pausing inline.
//
// api/seq/raydar-booking-hook.mjs and api/seq/calendly-hook.mjs durably save
// the booking here and answer OK immediately, every time (item 3 of the
// design). The background worker (booking-protection-worker.mjs, run by
// api/seq/booking-worker.mjs) is the only thing that ever drains it.
import {
  LITE_KEYS,
  kvGet,
  kvSet,
  kvSadd,
  kvSrem,
  kvSmembers,
} from "./booking-protection-store.mjs";

export const PENDING_JOB_TTL_SECONDS = 14 * 24 * 3600;

export async function enqueuePendingBooking(job, {
  write = kvSet,
  add = kvSadd,
  ttlSeconds = PENDING_JOB_TTL_SECONDS,
} = {}) {
  if (!job?.eventId) {
    const error = new Error("BOOKING_STOP_LITE_JOB_INVALID");
    error.code = "BOOKING_STOP_LITE_JOB_INVALID";
    throw error;
  }
  await write(LITE_KEYS.pending(job.eventId), job, ttlSeconds);
  await add(LITE_KEYS.pendingSet, job.eventId);
}

export async function pendingBookingIds({ list = kvSmembers } = {}) {
  const ids = await list(LITE_KEYS.pendingSet);
  return Array.isArray(ids) ? ids : [];
}

export async function readPendingBooking(eventId, { read = kvGet } = {}) {
  return read(LITE_KEYS.pending(eventId));
}

export async function removePendingBooking(eventId, { remove = kvSrem } = {}) {
  await remove(LITE_KEYS.pendingSet, eventId);
}

export async function pendingQueueDepth(options = {}) {
  return (await pendingBookingIds(options)).length;
}

/** Age of the oldest still-pending job. Alert when this crosses a few hours —
 *  well inside the multi-day step gap between sequence sends, and the signal
 *  the design's §4 "lost or delayed events" cover names explicitly. */
export async function oldestPendingAgeMs(now = Date.now(), options = {}) {
  const ids = await pendingBookingIds(options);
  if (!ids.length) return null;
  let oldest = null;
  for (const eventId of ids) {
    const job = await readPendingBooking(eventId, options);
    const at = Date.parse(job?.enqueuedAt || "");
    if (Number.isFinite(at) && (oldest == null || at < oldest)) oldest = at;
  }
  return oldest == null ? null : Math.max(0, now - oldest);
}
