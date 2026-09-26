// ─────────────────────────────────────────────────────────────────────────────
// DAILY SAFETY NET (item 5 of docs/research/booking-protection-minimum-
// 2026-09-26.md):
//   - a catch-up against ALL Scheduler bookings and Calendly bookings, so a
//     dropped or delayed webhook still gets caught within a day (0 Paraform
//     requests to check; 2 only on a real, previously-unresolved match);
//   - a small daily rotor check against Paraform's own Book Time page, which
//     emits no webhook at all ("David's gap" — bounded to a configurable
//     daily budget, default 60 requests/day).
//
// The once-a-day pause-canary rearm keeps its existing implementation
// unchanged (api/seq/_lib/pause-canary-rearm.mjs) — only its cron cadence
// moves from every 10 minutes to once a day (vercel.json). Nothing here
// duplicates it.
import {
  applyDecisions,
  decideLead,
  cachedRelationshipStatus,
  calendlyConfigured,
  calendlyBookingIndex,
  normEmail,
} from "./booking-stop.mjs";
import {
  fetchRaydarBookingIndex,
  raydarSchedulerBookingStopEnabled,
  raydarSchedulerIndexConfigured,
} from "./raydar-booking-index.mjs";
import {
  loadLiveSet,
  liveSetUsable,
  matchBookingAgainstLiveSet,
} from "./booking-protection-liveset.mjs";
import { alsoPauseIfBookedBeforeJoining } from "./booking-protection-policy.mjs";
import {
  LITE_KEYS,
  kvGet,
  kvSet,
  kvSetNx,
} from "./booking-protection-store.mjs";

const PROCESSED_TTL_SECONDS = 60 * 24 * 3600;

async function markProcessed(bookingId, { claim = kvSetNx } = {}) {
  try { await claim(LITE_KEYS.processed(bookingId), { at: new Date().toISOString() }, PROCESSED_TTL_SECONDS); }
  catch { /* best-effort marker; a duplicate re-check next run is harmless */ }
}
async function isProcessed(bookingId, { read = kvGet } = {}) {
  return Boolean(await read(LITE_KEYS.processed(bookingId)));
}

/**
 * Reconcile one already-fetched booking index (Scheduler or Calendly; both
 * expose `{ index: Map<email, {bookedAt, startsAt, eventName, status}> }`)
 * against the live-set index. Zero Paraform requests unless a booking that
 * the webhook path never resolved turns out to be a real match.
 */
async function reconcileIndex(index, {
  now,
  liveSet,
  source,
  bookingIdOf,
  applyDecisionsImpl,
  apply,
  alsoBeforeJoin,
  isProcessedFn,
  markProcessedFn,
}) {
  const out = { checked: 0, matched: 0, paused: 0, pauseErrors: [] };
  for (const [email, booking] of index.entries()) {
    if (booking.status !== "active") continue;
    const bookingId = bookingIdOf(booking, email);
    if (await isProcessedFn(bookingId)) continue;
    out.checked++;
    const decisions = matchBookingAgainstLiveSet({
      liveSet,
      email,
      bookedAtMs: booking.bookedAt,
      source,
      eventName: booking.eventName ?? null,
      startsAt: booking.startsAt ?? null,
      alsoPauseBeforeJoiningInterviewChase: alsoBeforeJoin,
      now,
    });
    out.matched += decisions.length;
    if (decisions.length && apply) {
      const applied = await applyDecisionsImpl(decisions);
      out.paused += applied.paused || 0;
      if (applied.pauseErrors?.length) {
        out.pauseErrors.push(...applied.pauseErrors);
        continue; // leave unmarked -> retried tomorrow, same idempotent rule
      }
    }
    await markProcessedFn(bookingId);
  }
  return out;
}

export async function catchUpBookingIndexes({
  now = Date.now(),
  loadLive = loadLiveSet,
  fetchRaydarIndex = fetchRaydarBookingIndex,
  fetchCalendlyIndex = calendlyBookingIndex,
  applyDecisionsImpl = applyDecisions,
  apply = process.env.BOOKING_STOP_APPLY !== "0",
  processedRead = kvGet,
  processedClaim = kvSetNx,
} = {}) {
  const out = {
    raydar: null,
    calendly: null,
    raydarError: null,
    calendlyError: null,
    liveSetReady: false,
  };
  const liveSet = await loadLive();
  out.liveSetReady = liveSetUsable(liveSet, now);
  if (!out.liveSetReady) return out;

  const alsoBeforeJoin = alsoPauseIfBookedBeforeJoining();
  const isProcessedFn = (id) => isProcessed(id, { read: processedRead });
  const markProcessedFn = (id) => markProcessed(id, { claim: processedClaim });

  if (raydarSchedulerBookingStopEnabled() && raydarSchedulerIndexConfigured()) {
    try {
      const raydarIndex = await fetchRaydarIndex({ now });
      if (raydarIndex?.complete === true && raydarIndex.index instanceof Map) {
        out.raydar = await reconcileIndex(raydarIndex.index, {
          now, liveSet, source: "raydar_scheduler",
          bookingIdOf: (booking) => `raydar:${booking.bookingId}`,
          applyDecisionsImpl, apply, alsoBeforeJoin,
          isProcessedFn, markProcessedFn,
        });
      } else {
        out.raydarError = "incomplete_index";
      }
    } catch (error) {
      out.raydarError = String(error?.code || error?.message || "error").slice(0, 120);
    }
  }

  if (calendlyConfigured()) {
    try {
      const calendlyIndex = await fetchCalendlyIndex({ backDays: 2, forwardDays: 120, now });
      if (calendlyIndex?.index instanceof Map) {
        out.calendly = await reconcileIndex(calendlyIndex.index, {
          now, liveSet, source: "calendly",
          bookingIdOf: (booking, email) => `calendly:${normEmail(email)}:${booking.bookedAt}`,
          applyDecisionsImpl, apply, alsoBeforeJoin,
          isProcessedFn, markProcessedFn,
        });
      } else {
        out.calendlyError = "incomplete_index";
      }
    } catch (error) {
      out.calendlyError = String(error?.code || error?.message || "error").slice(0, 120);
    }
  }

  return out;
}

/**
 * Paraform's own "Book Time" page sets relationship_status = SCHEDULED_CALL
 * and emits no webhook at all ("David's gap" — docs/research/
 * booking-protection-minimum-2026-09-26.md §4/§5). This is the ONLY part of
 * the lightweight design that still reads Paraform profiles, and it is
 * bounded to a small daily budget (default 60) via a rotor cursor that
 * advances across the whole live-set population over multiple days, rather
 * than the old 10-minute, ~100-reads-per-pass profile rotor.
 */
export async function bookTimeRotorCheck({
  now = Date.now(),
  loadLive = loadLiveSet,
  loadRotor = () => kvGet(LITE_KEYS.bookTimeRotor),
  saveRotor = (cursor) => kvSet(LITE_KEYS.bookTimeRotor, { cursor }, 60 * 24 * 3600),
  relationshipStatusLoader = cachedRelationshipStatus,
  applyDecisionsImpl = applyDecisions,
  apply = process.env.BOOKING_STOP_APPLY !== "0",
  budget = Number(process.env.BOOKING_STOP_LITE_BOOKTIME_DAILY_BUDGET || 60),
} = {}) {
  const out = { checked: 0, matched: 0, paused: 0, pauseErrors: [], rows: 0 };
  const liveSet = await loadLive();
  if (!liveSetUsable(liveSet, now)) return out;

  const rows = [];
  for (const [email, entries] of Object.entries(liveSet.byEmail || {})) {
    for (const entry of entries) rows.push({ email, ...entry });
  }
  out.rows = rows.length;
  if (!rows.length || budget <= 0) return out;
  // Stable order so the rotor cursor means the same thing across ticks even
  // though Object.entries() iteration order is not itself a contract here.
  rows.sort((a, b) => (a.ccu < b.ccu ? -1 : a.ccu > b.ccu ? 1 : 0));

  const rotorState = await loadRotor();
  const cursor = Number.isInteger(rotorState?.cursor) ? rotorState.cursor : 0;
  const startAt = cursor % rows.length;
  const seenCu = new Set();
  const slice = [];
  for (let i = 0; i < Math.min(budget, rows.length); i++) {
    const row = rows[(startAt + i) % rows.length];
    if (row.cu && !seenCu.has(row.cu)) { seenCu.add(row.cu); slice.push(row); }
  }

  for (const row of slice) {
    out.checked++;
    let profile = null;
    try {
      profile = await relationshipStatusLoader(row.cu);
    } catch {
      continue;
    }
    const relStatus = profile ? { status: profile.status, at: profile.at } : null;
    const decision = decideLead({
      lead: {
        ccu_id: row.ccu,
        cu_id: row.cu,
        name: row.n || null,
        to_use_email: row.email,
        created_at: row.t,
        is_paused: false,
        is_archived: false,
      },
      seq: { id: row.s, name: row.sn },
      booking: null,
      relStatus,
      now,
    });
    if (decision) {
      out.matched++;
      if (apply) {
        const applied = await applyDecisionsImpl([decision]);
        out.paused += applied.paused || 0;
        if (applied.pauseErrors?.length) out.pauseErrors.push(...applied.pauseErrors);
      }
    }
  }
  await saveRotor((startAt + slice.length) % rows.length);
  return out;
}
