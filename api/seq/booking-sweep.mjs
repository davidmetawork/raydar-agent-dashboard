// BOOKING SWEEP — hourly reconciliation behind native + legacy webhook paths.
//
// The webhook routes are the fast paths. This is what makes the system
// self-healing, and it exists for three reasons webhooks cannot cover:
//   1. webhook deliveries can be dropped or arrive during a deploy;
//   2. a webhook only knows the address the candidate typed while booking — the
//      sweep also reads Paraform profile addresses, catching people who book
//      from a different mailbox than the one we email;
//   3. the Paraform "Book Time" path sets relationship_status = SCHEDULED_CALL
//      and emits no webhook at all.
//
// It is deliberately a SEPARATE function from guardian.mjs (the protected-recruiter
// guardian). That guardian enforces a hard "never message this recruiter's
// candidates" invariant and must never be able to fail because a booking-source
// call timed out. Separate files, separate crons, separate failure boundaries.
//
// FAIL LOUDLY. The predecessor to this system died for nine days in silence.
// Everything below that alerts is there because of a specific way that happened.
import { cors, requireAuth, hasCookie, cronAuth } from "./_lib/core.mjs";
import {
  runBookingSweep,
  recordSweepAttempt,
  recordSuccessfulSweep,
  sweepAttemptErrorLabel,
  sweepErrorLabel,
  sweepStaleness,
  shouldAlert,
  isSessionActuallyExpired,
  recordSessionExpiredWitness,
  clearSessionExpiredWitness,
  kvConfigured,
  calendlyConfigured,
} from "./_lib/booking-stop.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";
import { withParaformTelemetrySource } from "../_lib/paraform-telemetry-context.mjs";
import { clearNotifySlot, pageNotify, systemHealthOwns } from "../_lib/notify.mjs";

export const config = { maxDuration: 300 };

// #notify switch (dashboard PR 2, 2026-09-25; api/_lib/notify-switch.mjs). Switch off,
// every line below behaves exactly as before (shouldAlert + notifySlack). With
// it set, the sweep posts two things to #notify, each once per incident:
//   - the stale page ("has not completed a full pass"), the ONE persistent
//     signal: cleared by the next successful pass, and skipped only while the
//     sweep's confirmed-expiry witness stands (System Health's
//     paraform-session tile is DOWN on exactly that witness, so it pages; the
//     health engine reads the witness key from KV itself, so a timed-out
//     seq/paraai health probe cannot blind the tile, 2026-09-25 review), and
//     after a recapture until a sweep attempt made since has failed too (only
//     the sweep retires the witness; seq health records a live proof beside
//     it, so a recovery never re-pages the dead-cookie incident, review 3);
//   - booked leads it failed to pause (slot cleared by a clean pass).
// No-cookie and AUTH_EXPIRED are left to System Health's paraform-session
// tile, and the per-pass failure lines (no Calendly, zero leads, budget,
// incomplete membership, snapshot rejected, Calendly truncated, Raydar index,
// generic error) are left to the stale page.
const STALE_KEY = "booking-sweep-stale";
const PAUSE_ERRORS_KEY = "booking-sweep-pause-errors";

/**
 * Pure: does the paraform-session tile already page this stale incident?
 * Only when the sweep's CONFIRMED expiry witness stands, since the tile is DOWN
 * on exactly that. Never decided from the attempt's error label: a substring
 * match on "auth" also caught CALENDLY_AUTH, and an unconfirmed AUTH_EXPIRED
 * (throttling on a live session) leaves the tile OK, so both went silent.
 * (No cookie never reaches the stale check: the handler returns first, and the
 * tile pages cookieSet:false.)
 */
export function staleOwnedBySessionTile(staleness, { switchOn = systemHealthOwns() } = {}) {
  if (!switchOn) return false;
  if (!Number.isFinite(Date.parse(String(staleness?.sessionExpiredConfirmedAt || "")))) return false;
  // Recapture (PR 230 review 3): once seq health has seen a live read after
  // the witness, the tile yields, but the failed attempts that make this
  // sweep stale are still the incident the tile already paged. The stale page
  // stays the tile's until a sweep attempt made AFTER that live read has
  // failed too (a new problem: page it). A good pass clears both keys first.
  const liveMs = Date.parse(String(staleness?.sessionLiveSinceWitnessAt || ""));
  if (!Number.isFinite(liveMs)) return true;
  const attemptMs = Date.parse(String(staleness?.latestAttemptAt || ""));
  return !(Number.isFinite(attemptMs) && attemptMs > liveMs);
}

/** A legacy-only line: posted as before while the switch is off, silent once on. */
async function legacyOnly(slot, ttlSeconds, text) {
  if (systemHealthOwns()) return;
  if (await shouldAlert(slot, ttlSeconds)) await notifySlack(text).catch(() => {});
}

/** A critical line: legacy dedupe while off, the 24h #notify slot once on. */
async function critical(slot, ttlSeconds, text, key) {
  if (systemHealthOwns()) {
    await pageNotify(text, { key }).catch(() => {});
    return;
  }
  if (await shouldAlert(slot, ttlSeconds)) await pageNotify(text, { key }).catch(() => {});
}

// A request carrying the cron header but no valid bearer is either an intruder
// or our own assumption about Vercel being wrong. Both must be visible fast.
async function warnOnCronRejection(cron) {
  if (cron.ok || !cron.headerPresent) return;
  await critical(`cron-auth-${cron.reason}`, 3600, `:warning: A request to a scheduled endpoint carried \`x-vercel-cron\` but no valid CRON_SECRET bearer (${cron.reason}). If this coincides with a scheduled tick, the cron is now failing closed and needs the secret checked.`, "cron-auth");
}

export async function handleBookingSweep(req, res, {
  sweep = runBookingSweep,
  staleness: readStaleness = sweepStaleness,
  confirmExpired = isSessionActuallyExpired,
} = {}) {
  if (cors(req, res)) return;
  const cron = cronAuth(req);
  if (!cron.ok && !(await requireAuth(req, res))) { await warnOnCronRejection(cron); return; }

  const apply = new URL(req.url, "http://x").searchParams.get("dry") !== "1";

  // Preconditions are alerts, not silent no-ops: an unconfigured control is
  // indistinguishable from a working one until someone gets a bad email.
  if (!hasCookie()) {
    if (apply) {
      await recordSweepAttempt({
        status: "failure",
        error: "no_cookie",
      }).catch(() => {});
    }
    // Switch on: the paraform-session tile pages cookieSet:false.
    await legacyOnly("no-cookie", undefined, ":rotating_light: Booking sweep cannot run — PARAFORM_COOKIE is not configured. Booked candidates are receiving sequence nudges.");
    return res.status(200).json({ ok: false, error: "no_cookie" });
  }
  if (!calendlyConfigured()) {
    if (apply) {
      await recordSweepAttempt({
        status: "failure",
        error: "no_calendly_token",
      }).catch(() => {});
    }
    await legacyOnly("no-calendly", undefined, ":rotating_light: Booking sweep cannot run — no Calendly token configured. Calendly bookings will not stop sequence nudges.");
    return res.status(200).json({ ok: false, error: "no_calendly_token" });
  }

  // Staleness check runs BEFORE the sweep so a run that is itself about to fail
  // still surfaces that nothing has succeeded recently.
  let staleness = await readStaleness();
  if (staleness.stale && kvConfigured() && !staleOwnedBySessionTile(staleness)) {
    const since = staleness.lastAt ? `since ${staleness.lastAt}` : "ever";
    await critical("sweep-stale", undefined, `:rotating_light: Booking sweep has not completed a full pass ${since}. Candidates who book are not being removed from sequences. Check monitor.raydar.xyz/api/seq/booking-sweep.`, STALE_KEY);
  }

  try {
    if (apply) await recordSweepAttempt({ status: "running" });
    const result = await sweep({ apply });
    if (apply && !result.ok) {
      await recordSweepAttempt({
        status: "failure",
        result,
        error: sweepAttemptErrorLabel(result),
      });
      staleness = await readStaleness();
    }

    // A pass that sees zero active leads is a FAILURE, not a clean run. Two
    // "successful" n8n runs (2026-07-10/11) returned activeLeads:0 because a
    // Paraform API change had silently emptied the membership read, and a naive
    // is-it-green alert would have passed both.
    if (!result.ok && result.error === "zero_active_leads") {
      await legacyOnly("zero-leads", undefined, ":rotating_light: Booking sweep read ZERO active leads across every sequence — that is a broken membership read, not an empty pipeline. Not recording this pass as successful.");
      return res.status(200).json({ ...result, staleness });
    }
    // A pass that ran out of its own budget is the loud version of the failure
    // that used to be silent: before this, the platform killed the function
    // mid-flight, the attempt record stayed "running" forever, and health could
    // not tell a dead pass from one still in progress. Someone has to act — the
    // pass is not going to get faster on its own.
    if (result.budgetExceeded) {
      await legacyOnly("sweep-budget", 3600, `:rotating_light: Booking sweep ran out of its ${Math.round(result.budgetMs / 1000)}s budget during the *${result.budgetExceededIn}* stage and stopped itself. Booked candidates may still be receiving sequence email. This does not recover on its own — the pass needs less work per run.`);
    }

    if (!result.ok && result.error === "incomplete_membership") {
      await legacyOnly("incomplete-membership", 3600, ":rotating_light: Booking sweep could not prove complete membership for every covered scheduling-link sequence. No partial lead index was published and the pass was not recorded healthy.");
      return res.status(200).json({ ...result, staleness });
    }

    if (!result.ok && result.error === "membership_snapshot_unavailable") {
      await legacyOnly("membership-snapshot-unavailable", 3600, ":rotating_light: Booking sweep rejected the immutable Paraform membership snapshot (missing, stale, drifted, or incomplete). It made zero pauses and recorded no successful pass.");
      return res.status(200).json({ ...result, staleness });
    }

    if (result.calendlyTruncated) {
      await legacyOnly("calendly-truncated", undefined, ":warning: Booking sweep hit the Calendly pagination ceiling — some bookings may not have been read this pass.");
    }

    if (result.raydarError) {
      await legacyOnly("raydar-booking-index", 3600, ":rotating_light: Booking sweep could not prove a complete Raydar scheduler booking index. The pass is unhealthy and native bookings may not stop sequence mail until the source recovers.");
    }

    if (apply && result.pauseErrors.length) {
      await critical("pause-errors", 3600, `:warning: Booking sweep failed to pause ${result.pauseErrors.length} booked lead(s). They are still receiving sequence email.`, PAUSE_ERRORS_KEY);
    } else if (apply && result.ok && systemHealthOwns()) {
      // A clean pass ends the pause-error incident: the next one pages again.
      await clearNotifySlot(PAUSE_ERRORS_KEY).catch(() => {});
    }

    // A pass that paused booked candidates is the control WORKING: a success,
    // so it posts nothing (2026-09-25, one-channel rule; it used to post
    // "Booking stop paused N" with no dedupe). The count is in the response.

    if (result.ok && apply) {
      await recordSuccessfulSweep(result);
      await recordSweepAttempt({ status: "success", result });
      staleness = await readStaleness();
      // The stale incident is over: the next one pages again. A good pass
      // also proves the Paraform session is live.
      await clearSessionExpiredWitness().catch(() => {});
      if (systemHealthOwns()) await clearNotifySlot(STALE_KEY).catch(() => {});
    }

    // Never return candidate detail in an HTTP response — counts only.
    return res.status(200).json({
      ok: result.ok,
      apply,
      budgetMs: result.budgetMs,
      budgetExceeded: result.budgetExceeded,
      budgetExceededIn: result.budgetExceededIn,
      profileCutShort: result.profileCutShort,
      sequences: result.sequences,
      membershipSnapshotSchema: result.membershipSnapshotSchema,
      membershipSnapshotGeneration: result.membershipSnapshotGeneration,
      membershipSnapshotOldestFetchedAt:
        result.membershipSnapshotOldestFetchedAt,
      membershipSnapshotAgeMinutes:
        result.membershipSnapshotAgeMs == null
          ? null
          : Math.round(result.membershipSnapshotAgeMs / 60000),
      membershipSnapshotCurrent: result.membershipSnapshotCurrent,
      sequenceCatalogCount: result.sequenceCatalogCount,
      sequenceScopeScanned: result.sequenceScopeScanned,
      definitionSequencesRead: result.definitionSequencesRead,
      linkSequences: result.linkSequences,
      enabledLinkSequences: result.enabledLinkSequences,
      coveredEnabledLinkSequences: result.coveredEnabledLinkSequences,
      excludedColdSequences: result.excludedColdSequences,
      excludedColdEnabledLinkSequences:
        result.excludedColdEnabledLinkSequences,
      bookingStopPolicy: result.bookingStopPolicy,
      linkScopeComplete: result.linkScopeComplete,
      activeLeads: result.activeLeads,
      calendlyEvents: result.calendlyEvents,
      calendlyCacheHits: result.calendlyCacheHits,
      calendlyTruncated: result.calendlyTruncated,
      raydarEnabled: result.raydarEnabled,
      raydarConfigured: result.raydarConfigured,
      raydarItems: result.raydarItems,
      raydarBookings: result.raydarBookings,
      raydarPages: result.raydarPages,
      raydarComplete: result.raydarComplete,
      raydarError: result.raydarError,
      profilesRead: result.profilesRead,
      profileCoverage: result.profileCoverage,
      profileRotor: `${result.profileRotorFrom}/${result.profileRotorOf}`,
      matched: result.decisions.length,
      paused: result.paused,
      pauseErrors: result.pauseErrors,
      durationMs: result.durationMs,
      staleness,
      ranAt: new Date().toISOString(),
    });
  } catch (e) {
    if (apply) {
      await recordSweepAttempt({
        status: "failure",
        error: sweepErrorLabel(e),
      }).catch(() => {});
    }
    // Never report (or alert) an expiry on the strength of one 401: Paraform
    // answers 401 to bursts. Confirm with spaced probes first, or a busy pass
    // cries wolf about the cookie and the real alarm stops being believed.
    const expired = e?.code === "AUTH_EXPIRED" && (await confirmExpired());
    if (e?.code === "AUTH_EXPIRED" && !expired) {
      // Throttling on a session verified live: any old witness is wrong now.
      await clearSessionExpiredWitness().catch(() => {});
      return res.status(200).json({ ok: false, error: "throttled", detail: "Paraform rate-limited this pass; session verified live. Next run retries.", ranAt: new Date().toISOString() });
    }
    if (expired) {
      // The paraform-session tile reads this witness from KV each tick and
      // yields to a live read seq health records after it (2026-09-25).
      await recordSessionExpiredWitness().catch(() => {});
    }
    if (expired) {
      await legacyOnly("auth-expired", undefined, ":rotating_light: Booking sweep hit AUTH_EXPIRED — the Paraform session cookie needs recapture. Booked candidates are unprotected until then.");
    } else {
      await legacyOnly("sweep-error", 3600, `:rotating_light: Booking sweep failed: ${String(e?.message || e).slice(0, 160)}`);
    }
    return res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e?.message || e).slice(0, 200) });
  }
}

export default function handler(req, res) {
  return withParaformTelemetrySource("dashboard-booking", () => handleBookingSweep(req, res));
}
