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

// A row that makes the rotor stop (its read refused, or its pause failed)
// on this many runs in a row is passed over, so one row Paraform always
// refuses cannot hold the rotor for good.
export const ROTOR_ROW_REFUSAL_LIMIT = 2;

// Errors the pacer raises without sending anything. They say nothing about
// the row, so they never count toward passing it over.
const UNSENT_CODES = new Set(["PARAFORM_PACED_BACKOFF", "PARAFORM_SESSION_DEAD", "KV_UNAVAILABLE"]);

/**
 * Paraform's own "Book Time" page sets relationship_status = SCHEDULED_CALL
 * and emits no webhook at all ("David's gap" — docs/research/
 * booking-protection-minimum-2026-09-26.md §4/§5). This is the ONLY part of
 * the lightweight design that still reads Paraform profiles, and it is
 * bounded to a small daily budget (default 60) via a rotor cursor that
 * advances across the whole live-set population over multiple days, rather
 * than the old 10-minute, ~100-reads-per-pass profile rotor.
 *
 * Rows are sorted by ccu, and the cursor is saved as the ccu of the next row
 * to look at (`next`), so it survives the live set being rebuilt between
 * runs: leads added or removed overnight do not move it. A cursor saved
 * before this change (only a position) is still read once. It is saved
 * before every profile read and at the end, so a run the platform kills
 * part-way keeps what it checked. `deadlineAt` (epoch ms, optional) stops
 * the run starting new rows past it; the catch-up route sets it from its
 * own maxDuration, which fits far fewer reads than the default budget. One
 * profile read serves every row of that candidate in the run (one candidate
 * can be in several sequences), so `budget` counts reads (started, including
 * any the pacer refused), not rows.
 *
 * The run stops, leaving the cursor on the row, when:
 *   - a read is refused by the pacer or Paraform (a backoff in force, a
 *     401, 403, 429 or 5xx, a dead session, a transport failure): every
 *     later read in the same run would be refused too;
 *   - a pause fails: the next run retries it, instead of a lap later.
 * A row that stops the run on ROTOR_ROW_REFUSAL_LIMIT runs in a row, with
 * a request actually sent each time, is then passed over (`passedRefused`,
 * or `passedPauseFailures` for a booked lead that could not be paused); the
 * count is saved with the cursor as `refused`. A read that fails for that
 * row alone (a tRPC error, a 400 or 404) is counted in `readErrors` and
 * passed over at once. The pacer backs off after any failed call, so the
 * read after it usually stops the run with `PARAFORM_PACED_BACKOFF`.
 */
export async function bookTimeRotorCheck({
  now = Date.now(),
  loadLive = loadLiveSet,
  loadRotor = () => kvGet(LITE_KEYS.bookTimeRotor),
  saveRotor = (cursor, extra = {}) =>
    kvSet(LITE_KEYS.bookTimeRotor, { cursor, ...extra }, 60 * 24 * 3600),
  relationshipStatusLoader = cachedRelationshipStatus,
  applyDecisionsImpl = applyDecisions,
  apply = process.env.BOOKING_STOP_APPLY !== "0",
  budget = Number(process.env.BOOKING_STOP_LITE_BOOKTIME_DAILY_BUDGET || 60),
  deadlineAt = null,
  clock = () => Date.now(),
} = {}) {
  const out = {
    checked: 0,
    reads: 0,
    matched: 0,
    paused: 0,
    pauseErrors: [],
    readErrors: 0,
    passedRefused: 0,
    passedPauseFailures: 0,
    rows: 0,
    cursor: null,
    next: null,
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
  if (!rows.length) return out;
  // A setting that is not a number reads nothing, as it always has, and is
  // reported so the run is not recorded as a success.
  if (!Number.isFinite(budget)) { out.stoppedBy = "budget_invalid"; return out; }
  if (budget <= 0) { out.stoppedBy = "budget"; return out; }
  const byCcu = (a, b) => (String(a.ccu) < String(b.ccu) ? -1 : String(a.ccu) > String(b.ccu) ? 1 : 0);
  rows.sort(byCcu);

  const rotorState = await loadRotor();
  let startAt = 0;
  if (typeof rotorState?.next === "string") {
    // The first row at or after the saved one; past the end, wrap to 0.
    const at = rows.findIndex((row) => String(row.ccu) >= rotorState.next);
    startAt = at < 0 ? 0 : at;
  } else if (Number.isInteger(rotorState?.cursor)) {
    startAt = ((rotorState.cursor % rows.length) + rows.length) % rows.length;
  }
  // The row a previous run stopped on, and on how many runs in a row. Kept
  // only while that row is still in the live set.
  let refused = typeof rotorState?.refused?.ccu === "string"
    && Number.isInteger(rotorState.refused.count)
    && rows.some((row) => row.ccu === rotorState.refused.ccu)
    ? { ccu: rotorState.refused.ccu, count: rotorState.refused.count }
    : null;
  // `scanned` counts rows passed over in rotor order, including rows with no
  // candidate user id, so a run of those can never hold the cursor in place.
  let scanned = 0;
  let saved = { scanned: 0, refused };
  const rowAt = (offset) => rows[(startAt + offset) % rows.length];
  async function saveProgress() {
    if (scanned === saved.scanned && refused === saved.refused) return;
    const position = (startAt + scanned) % rows.length;
    try {
      await saveRotor(position, { next: String(rows[position].ccu), refused });
      saved = { scanned, refused };
    } catch {
      // Best effort: the next save, or tomorrow's run, covers it.
    }
  }
  function advance(row) {
    scanned++;
    if (refused?.ccu === row.ccu) refused = null;
  }
  // Stop on `row`, or pass it over once it has stopped the rotor on
  // ROTOR_ROW_REFUSAL_LIMIT runs in a row. `sent` is false when nothing
  // reached Paraform: the run stops, and the count does not move. Returns
  // true to stop.
  function stopOrPass(row, reason, { sent }) {
    out.stopReason = reason;
    if (!sent) { out.stoppedBy = "refused"; return true; }
    const count = (refused?.ccu === row.ccu ? refused.count : 0) + 1;
    if (count >= ROTOR_ROW_REFUSAL_LIMIT) {
      out.stopReason = null;
      return false;
    }
    refused = { ccu: row.ccu, count };
    out.stoppedBy = "refused";
    return true;
  }

  // cu -> { profile } or { error }: one read per candidate per run.
  const profiles = new Map();
  while (scanned < rows.length) {
    const row = rowAt(scanned);
    if (!row.cu) { advance(row); continue; }
    if (Number.isFinite(deadlineAt) && clock() >= deadlineAt) { out.stoppedBy = "deadline"; break; }
    let entry = profiles.get(row.cu);
    if (!entry) {
      if (out.reads >= budget) { out.stoppedBy = "budget"; break; }
      await saveProgress();
      out.reads++;
      try {
        entry = { profile: await relationshipStatusLoader(row.cu) };
      } catch (error) {
        const reason = String(error?.code || error?.message || "error").slice(0, 60);
        if (stopsTheRotor(error)) {
          if (stopOrPass(row, reason, { sent: isTransientRefusal(error) })) break;
          out.passedRefused++;
        }
        entry = { error: reason };
      }
      profiles.set(row.cu, entry);
    }
    if (entry.error) {
      out.readErrors++;
      advance(row);
      continue;
    }
    out.checked++;
    const profile = entry.profile;
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
        if (applied.pauseErrors?.length) {
          out.pauseErrors.push(...applied.pauseErrors);
          const sent = applied.pauseErrors.some((e) => !UNSENT_CODES.has(String(e?.reason || "")));
          if (stopOrPass(row, "PAUSE_FAILED", { sent })) break;
          out.passedPauseFailures++;
        }
      }
    }
    advance(row);
  }
  if (!out.stoppedBy) out.stoppedBy = "lap";
  await saveProgress();
  const position = (startAt + saved.scanned) % rows.length;
  out.cursor = position;
  out.next = String(rows[position].ccu);
  return out;
}

// A refusal from the pacer or Paraform, rather than a problem with one row.
// The pacer has already recorded a backoff for it (or, for a backoff, is
// in one), so every later read in this run would be refused as well.
// Anything else is this row's own problem; the pacer backs off after any
// failed call, so if it was really an outage the next read stops the run.
function stopsTheRotor(error) {
  return UNSENT_CODES.has(error?.code) || isTransientRefusal(error);
}
