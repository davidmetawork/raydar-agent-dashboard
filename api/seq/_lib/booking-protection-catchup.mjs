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
import { isTransientRefusal } from "./booking-protection-pace.mjs";
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
 *
 * The cursor is the position of the next live-set row to look at, and it is
 * saved after every profile read, so a run the platform kills part-way
 * keeps what it checked. `deadlineAt` (epoch ms, optional) stops the run
 * starting new reads past it; the catch-up route sets it from its own
 * maxDuration, which fits far fewer reads than the default budget.
 *
 * A read the pacer or Paraform refused (a backoff in force, a refusal, a
 * dead session, a transport failure) stops the run and leaves the cursor
 * on that row: every later read in the same run would be refused too, and
 * skipping them would mark rows as checked that never were. A read that
 * failed for that row alone (a tRPC error, a 400 or 404) is counted in
 * `readErrors` and passed over, so one bad row cannot hold the rotor. The
 * pacer backs off after any failed call, so the read after it stops the
 * run: expect `stoppedBy: "refused"` with `PARAFORM_PACED_BACKOFF` then.
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
  deadlineAt = null,
  clock = () => Date.now(),
} = {}) {
  const out = {
    checked: 0,
    matched: 0,
    paused: 0,
    pauseErrors: [],
    readErrors: 0,
    rows: 0,
    cursor: null,
    stoppedBy: null,
    stopReason: null,
  };
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
  const startAt = ((cursor % rows.length) + rows.length) % rows.length;
  // `scanned` counts rows passed over in rotor order, including rows with no
  // candidate user id and repeats of one already read this run, so a run of
  // such rows can never hold the cursor in place.
  let scanned = 0;
  let savedScanned = 0;
  async function saveProgress() {
    if (scanned === savedScanned) return;
    const next = (startAt + scanned) % rows.length;
    try {
      await saveRotor(next);
      savedScanned = scanned;
    } catch {
      // Best effort: the next save, or tomorrow's run, covers it.
    }
  }

  const seenCu = new Set();
  let reads = 0;
  while (scanned < rows.length) {
    const row = rows[(startAt + scanned) % rows.length];
    if (!row.cu || seenCu.has(row.cu)) { scanned++; continue; }
    if (reads >= budget) { out.stoppedBy = "budget"; break; }
    if (Number.isFinite(deadlineAt) && clock() >= deadlineAt) { out.stoppedBy = "deadline"; break; }
    reads++;
    let profile = null;
    try {
      profile = await relationshipStatusLoader(row.cu);
    } catch (error) {
      if (stopsTheRotor(error)) {
        out.stoppedBy = "refused";
        out.stopReason = String(error?.code || error?.message || "error").slice(0, 60);
        break;
      }
      seenCu.add(row.cu);
      out.checked++;
      out.readErrors++;
      scanned++;
      await saveProgress();
      continue;
    }
    seenCu.add(row.cu);
    out.checked++;
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
    scanned++;
    await saveProgress();
  }
  if (!out.stoppedBy) out.stoppedBy = "lap";
  await saveProgress();
  out.cursor = (startAt + savedScanned) % rows.length;
  return out;
}

// A refusal from the pacer or Paraform, rather than a problem with one row.
// The pacer has already recorded a backoff for it (or, for a backoff, is
// in one), so every later read in this run would be refused as well.
// Anything else is this row's own problem; the pacer backs off after any
// failed call, so if it was really an outage the next read stops the run.
function stopsTheRotor(error) {
  const code = error?.code;
  return code === "PARAFORM_PACED_BACKOFF"
    || code === "PARAFORM_SESSION_DEAD"
    || code === "KV_UNAVAILABLE"
    || isTransientRefusal(error);
}
