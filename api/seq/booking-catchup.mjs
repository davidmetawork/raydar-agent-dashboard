// BOOKING CATCH-UP — once a day: reconcile the Scheduler + Calendly booking
// indexes against what the webhook/worker path already resolved (0 Paraform
// unless it finds a real, previously-missed match), plus a small bounded
// daily check against Paraform's own Book Time page (item 5). Replaces the
// 10-minute booking-sweep.mjs pass, including its ~100-profile-reads-per-pass
// rotor.
import { cors, requireAuth, hasCookie, cronAuth, ensureParaformSession } from "./_lib/core.mjs";
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
import {
  LITE_KEYS,
  kvSet,
  kvConfigured,
} from "./_lib/booking-protection-store.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";
import { withParaformTelemetrySource } from "../_lib/paraform-telemetry-context.mjs";

export const config = { maxDuration: 120 };

// The Book Time rotor starts no new profile read after this much of the run.
// The last read can still wait 6.5 s for the pacer and take up to 20 s, and
// a match then costs a paced pause and read-back; the rest of maxDuration is
// left for that and for recording the run. A 401 that the pacer has to
// confirm (about 70 s of paced probes, ESTIMATED) can still outlast it: the
// rotor saves its cursor after every read, so a killed run loses only the
// read in flight, and the attempt record stays "started".
// At the pacer's 6.5 s spacing this allows about 10 profile reads a run
// (ESTIMATED), well under BOOKING_STOP_LITE_BOOKTIME_DAILY_BUDGET's default
// of 60, which cannot fit in 120 s. Each run records bookTime.checked and
// durationMs; retune from those.
export const BOOKTIME_START_BUDGET_MS = 80_000;

const ATTEMPT_TTL_SECONDS = 3 * 24 * 3600;

// /api/seq/health reports this key as bookingProtectionLite.catchup
// (lastAttemptStatus, lastAttemptAt). It is written once as "started" when
// the run begins and again when it ends, so a run the platform kills at
// maxDuration shows as a "started" that never finished, not as the previous
// day's result.
async function recordAttempt(status, extra = {}) {
  if (!kvConfigured()) return;
  await kvSet(LITE_KEYS.catchupAttempt, {
    status,
    at: new Date().toISOString(),
    ...extra,
  }, ATTEMPT_TTL_SECONDS).catch(() => {});
}

function indexCounts(result) {
  if (!result) return null;
  return {
    checked: result.checked ?? 0,
    matched: result.matched ?? 0,
    paused: result.paused ?? 0,
    pauseErrors: result.pauseErrors?.length ?? 0,
  };
}

/**
 * The one-word outcome of a run:
 *   - failure: the index reconciliation threw;
 *   - skipped: there is no usable live set, so nothing was checked;
 *   - partial: it ran, but something it should have checked or paused was
 *     not (an index read error, a pause error, a Book Time error, or a
 *     rotor stopped by a Paraform refusal);
 *   - success: everything it set out to check was checked.
 */
export function catchupAttemptStatus(out) {
  if (!out?.ok) return "failure";
  if (!out.indexes?.liveSetReady) return "skipped";
  const bookTime = out.bookTime;
  if (
    out.indexes.raydarError
    || out.indexes.calendlyError
    || out.indexes.raydar?.pauseErrors?.length
    || out.indexes.calendly?.pauseErrors?.length
    || out.bookTimeError
    || bookTime?.pauseErrors?.length
    || bookTime?.readErrors
    || bookTime?.stoppedBy === "refused"
  ) return "partial";
  return "success";
}

/** Counts only: no names or addresses go into the attempt record. */
export function catchupAttemptRecord(out, { startedAt, finishedAt }) {
  const bookTime = out.bookTime;
  return {
    startedAt: new Date(startedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    liveSetReady: Boolean(out.indexes?.liveSetReady),
    indexesError: out.indexesError ?? null,
    raydar: indexCounts(out.indexes?.raydar),
    raydarError: out.indexes?.raydarError ?? null,
    calendly: indexCounts(out.indexes?.calendly),
    calendlyError: out.indexes?.calendlyError ?? null,
    bookTime: bookTime ? {
      rows: bookTime.rows ?? 0,
      checked: bookTime.checked ?? 0,
      matched: bookTime.matched ?? 0,
      paused: bookTime.paused ?? 0,
      pauseErrors: bookTime.pauseErrors?.length ?? 0,
      readErrors: bookTime.readErrors ?? 0,
      stoppedBy: bookTime.stoppedBy ?? null,
      stopReason: bookTime.stopReason ?? null,
      cursor: bookTime.cursor ?? null,
    } : null,
    bookTimeError: out.bookTimeError ?? null,
    bookTimeSkipped: out.bookTimeSkipped ?? null,
  };
}

export async function runCatchup({
  startedAt = Date.now(),
  clock = () => Date.now(),
  pace = createPacer(),
  catchUp = catchUpBookingIndexes,
  bookTime = bookTimeRotorCheck,
  cookiePresent = hasCookie,
  record = recordAttempt,
  alert = shouldAlert,
  notify = (text) => notifySlack(text).catch(() => {}),
} = {}) {
  await record("started", { startedAt: new Date(startedAt).toISOString() });

  const out = { ok: true, indexes: null, bookTime: null };
  // One pacer per invocation, shared by both the index reconciliation and the
  // Book Time rotor below — item 6's <=10/min, one-in-flight ceiling applies
  // across every Paraform call this daily job makes, not per sub-step.
  const pacedApplyDecisionsImpl = (decisions) =>
    applyDecisions(decisions, pacedApplyDecisionsOverrides(pace));
  try {
    out.indexes = await catchUp({
      applyDecisionsImpl: pacedApplyDecisionsImpl,
    });
    if (
      (out.indexes.raydarError || out.indexes.calendlyError)
      && (await alert("booking-catchup-index-error", 6 * 3600))
    ) {
      await notify(`:warning: Booking catch-up could not fully reconcile bookings (raydar: ${out.indexes.raydarError || "ok"}, calendly: ${out.indexes.calendlyError || "ok"}).`);
    }
    const raydarPauseErrors = out.indexes.raydar?.pauseErrors?.length || 0;
    const calendlyPauseErrors = out.indexes.calendly?.pauseErrors?.length || 0;
    if ((raydarPauseErrors || calendlyPauseErrors) && (await alert("booking-catchup-pause-errors", 6 * 3600))) {
      await notify(`:warning: Booking catch-up failed to pause ${raydarPauseErrors + calendlyPauseErrors} previously-missed lead(s); retried next run.`);
    }
    const caughtRaydar = out.indexes.raydar?.paused || 0;
    const caughtCalendly = out.indexes.calendly?.paused || 0;
    if (caughtRaydar + caughtCalendly > 0) {
      await notify(`:pause_button: Booking catch-up paused ${caughtRaydar + caughtCalendly} candidate(s) the webhook path had missed.`);
    }
  } catch (error) {
    out.ok = false;
    out.indexesError = String(error?.message || error).slice(0, 200);
  }

  if (cookiePresent()) {
    try {
      out.bookTime = await bookTime({
        relationshipStatusLoader: pacedRelationshipStatusLoader(pace),
        applyDecisionsImpl: pacedApplyDecisionsImpl,
        deadlineAt: startedAt + BOOKTIME_START_BUDGET_MS,
        clock,
      });
      if (out.bookTime.pauseErrors?.length && (await alert("booking-catchup-booktime-errors", 6 * 3600))) {
        await notify(`:warning: Booking catch-up's Book Time check failed to pause ${out.bookTime.pauseErrors.length} lead(s); retried next run.`);
      }
      if (out.bookTime.paused > 0) {
        await notify(`:pause_button: Booking catch-up's Book Time check paused ${out.bookTime.paused} candidate(s) who booked on Paraform's own page.`);
      }
    } catch (error) {
      out.bookTimeError = String(error?.message || error).slice(0, 200);
    }
  } else {
    out.bookTimeSkipped = "no_cookie";
  }

  out.attemptStatus = catchupAttemptStatus(out);
  await record(out.attemptStatus, catchupAttemptRecord(out, { startedAt, finishedAt: clock() }));
  return out;
}

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
  const startedAt = Date.now();
  await ensureParaformSession();

  const out = await runCatchup({ startedAt });
  return res.status(200).json({ ...out, ranAt: new Date().toISOString() });
}

export default function handler(req, res) {
  return withParaformTelemetrySource("dashboard-booking", () => handleBookingCatchup(req, res));
}
