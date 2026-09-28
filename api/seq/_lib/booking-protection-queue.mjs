// ─────────────────────────────────────────────────────────────────────────────
// PENDING-BOOKING QUEUE — what the webhooks now do instead of pausing inline.
//
// api/seq/raydar-booking-hook.mjs and api/seq/calendly-hook.mjs durably save
// the booking here and answer OK immediately, every time (item 3 of the
// design). The background worker (booking-protection-worker.mjs, run by
// api/seq/booking-worker.mjs) is the only thing that ever drains it.
import {
  LITE_KEYS,
  kvGetStrict,
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

// Throws KV_UNAVAILABLE when KV does not answer, so a transport blip is never
// mistaken for a missing record (the worker removes a queue entry whose record
// is missing).
export async function readPendingBooking(eventId, { read = kvGetStrict } = {}) {
  return read(LITE_KEYS.pending(eventId));
}

/**
 * Keep a job queued, marked as held: it was matched against a live set that
 * could not read every protected sequence, so "no match" could not be
 * trusted (booking-protection-liveset.mjs holdAfterMatch). The record keeps
 * its original expiry, so holding never stretches a booking's life past
 * PENDING_JOB_TTL_SECONDS.
 */
export async function holdPendingBooking(eventId, job, hold, {
  now = Date.now(),
  write = kvSet,
  ttlSeconds = PENDING_JOB_TTL_SECONDS,
} = {}) {
  const enqueuedMs = Date.parse(job?.enqueuedAt || "");
  const remaining = Number.isFinite(enqueuedMs)
    ? ttlSeconds - Math.floor((now - enqueuedMs) / 1000)
    : ttlSeconds;
  await write(LITE_KEYS.pending(eventId), { ...job, hold }, Math.max(60, remaining));
}

export async function removePendingBooking(eventId, { remove = kvSrem } = {}) {
  await remove(LITE_KEYS.pendingSet, eventId);
}

export async function pendingQueueDepth(options = {}) {
  return (await pendingBookingIds(options)).length;
}

/**
 * One pass over the queue. `oldestPendingAgeMs` covers every job;
 * `oldestUnheldAgeMs` leaves out held jobs, which wait for a later live set by
 * design and have their own clock (`oldestHeldAgeMs`, measured from when the
 * job was first held, so it says how long the unreadable sequence has blocked
 * it).
 */
export async function pendingQueueSummary(now = Date.now(), options = {}) {
  const ids = await pendingBookingIds(options);
  let oldest = null;
  let oldestUnheld = null;
  let oldestHeld = null;
  let held = 0;
  let unreadable = 0;
  for (const eventId of ids) {
    let job;
    try {
      job = await readPendingBooking(eventId, options);
    } catch {
      unreadable++;
      continue;
    }
    const at = Date.parse(job?.enqueuedAt || "");
    if (Number.isFinite(at) && (oldest == null || at < oldest)) oldest = at;
    if (job?.hold) {
      held++;
      const since = Date.parse(job.hold.heldSince || "");
      if (Number.isFinite(since) && (oldestHeld == null || since < oldestHeld)) oldestHeld = since;
    } else if (Number.isFinite(at) && (oldestUnheld == null || at < oldestUnheld)) {
      oldestUnheld = at;
    }
  }
  const age = (at) => (at == null ? null : Math.max(0, now - at));
  return {
    depth: ids.length,
    held,
    unreadable,
    oldestPendingAgeMs: age(oldest),
    oldestUnheldAgeMs: age(oldestUnheld),
    oldestHeldAgeMs: age(oldestHeld),
  };
}

/** Age of the oldest still-pending job. Alert when this crosses a few hours —
 *  well inside the multi-day step gap between sequence sends, and the signal
 *  the design's §4 "lost or delayed events" cover names explicitly. */
export async function oldestPendingAgeMs(now = Date.now(), options = {}) {
  return (await pendingQueueSummary(now, options)).oldestPendingAgeMs;
}
