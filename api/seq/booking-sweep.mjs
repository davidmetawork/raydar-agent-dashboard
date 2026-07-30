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
  kvConfigured,
  calendlyConfigured,
} from "./_lib/booking-stop.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";

export const config = { maxDuration: 300 };



// A request carrying the cron header but no valid bearer is either an intruder
// or our own assumption about Vercel being wrong. Both must be visible fast.
async function warnOnCronRejection(cron) {
  if (cron.ok || !cron.headerPresent) return;
  if (await shouldAlert(`cron-auth-${cron.reason}`, 3600)) {
    await notifySlack(`:warning: A request to a scheduled endpoint carried \`x-vercel-cron\` but no valid CRON_SECRET bearer (${cron.reason}). If this coincides with a scheduled tick, the cron is now failing closed and needs the secret checked.`).catch(() => {});
  }
}

export default async function handler(req, res) {
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
    if (await shouldAlert("no-cookie")) {
      await notifySlack(":rotating_light: Booking sweep cannot run — PARAFORM_COOKIE is not configured. Booked candidates are receiving sequence nudges.").catch(() => {});
    }
    return res.status(200).json({ ok: false, error: "no_cookie" });
  }
  if (!calendlyConfigured()) {
    if (apply) {
      await recordSweepAttempt({
        status: "failure",
        error: "no_calendly_token",
      }).catch(() => {});
    }
    if (await shouldAlert("no-calendly")) {
      await notifySlack(":rotating_light: Booking sweep cannot run — no Calendly token configured. Calendly bookings will not stop sequence nudges.").catch(() => {});
    }
    return res.status(200).json({ ok: false, error: "no_calendly_token" });
  }

  // Staleness check runs BEFORE the sweep so a run that is itself about to fail
  // still surfaces that nothing has succeeded recently.
  const staleness = await sweepStaleness();
  if (staleness.stale && kvConfigured() && (await shouldAlert("sweep-stale"))) {
    const since = staleness.lastAt ? `since ${staleness.lastAt}` : "ever";
    await notifySlack(`:rotating_light: Booking sweep has not completed a full pass ${since}. Candidates who book are not being removed from sequences. Check monitor.raydar.xyz/api/seq/booking-sweep.`).catch(() => {});
  }

  try {
    if (apply) await recordSweepAttempt({ status: "running" });
    const result = await runBookingSweep({ apply });
    if (apply && !result.ok) {
      await recordSweepAttempt({
        status: "failure",
        result,
        error: sweepAttemptErrorLabel(result),
      });
    }

    // A pass that sees zero active leads is a FAILURE, not a clean run. Two
    // "successful" n8n runs (2026-07-10/11) returned activeLeads:0 because a
    // Paraform API change had silently emptied the membership read, and a naive
    // is-it-green alert would have passed both.
    if (!result.ok && result.error === "zero_active_leads") {
      if (await shouldAlert("zero-leads")) {
        await notifySlack(":rotating_light: Booking sweep read ZERO active leads across every sequence — that is a broken membership read, not an empty pipeline. Not recording this pass as successful.").catch(() => {});
      }
      return res.status(200).json({ ...result, staleness });
    }
    // A pass that ran out of its own budget is the loud version of the failure
    // that used to be silent: before this, the platform killed the function
    // mid-flight, the attempt record stayed "running" forever, and health could
    // not tell a dead pass from one still in progress. Someone has to act — the
    // pass is not going to get faster on its own.
    if (result.budgetExceeded && (await shouldAlert("sweep-budget", 3600))) {
      await notifySlack(`:rotating_light: Booking sweep ran out of its ${Math.round(result.budgetMs / 1000)}s budget during the *${result.budgetExceededIn}* stage and stopped itself. Booked candidates may still be receiving sequence email. This does not recover on its own — the pass needs less work per run.`).catch(() => {});
    }

    if (!result.ok && result.error === "incomplete_membership") {
      if (await shouldAlert("incomplete-membership", 3600)) {
        await notifySlack(":rotating_light: Booking sweep could not prove complete membership for every covered scheduling-link sequence. No partial lead index was published and the pass was not recorded healthy.").catch(() => {});
      }
      return res.status(200).json({ ...result, staleness });
    }

    if (result.calendlyTruncated && (await shouldAlert("calendly-truncated"))) {
      await notifySlack(":warning: Booking sweep hit the Calendly pagination ceiling — some bookings may not have been read this pass.").catch(() => {});
    }

    if (result.raydarError && (await shouldAlert("raydar-booking-index", 3600))) {
      await notifySlack(":rotating_light: Booking sweep could not prove a complete Raydar scheduler booking index. The pass is unhealthy and native bookings may not stop sequence mail until the source recovers.").catch(() => {});
    }

    if (apply && result.pauseErrors.length && (await shouldAlert("pause-errors", 3600))) {
      await notifySlack(`:warning: Booking sweep failed to pause ${result.pauseErrors.length} booked lead(s). They are still receiving sequence email.`).catch(() => {});
    }

    // Actionable-only: a pass that paused nothing is silent. A pass that paused
    // someone means outreach was about to embarrass us, and is worth one line.
    if (apply && result.paused > 0) {
      const bySeq = {};
      for (const d of result.decisions) bySeq[d.sequence] = (bySeq[d.sequence] || 0) + 1;
      const lines = Object.entries(bySeq).map(([s, n]) => `• ${s} — ${n}`);
      await notifySlack(`:pause_button: Booking stop paused ${result.paused} booked candidate(s):\n${lines.join("\n")}`).catch(() => {});
    }

    if (result.ok && apply) {
      await recordSuccessfulSweep(result);
      await recordSweepAttempt({ status: "success", result });
    }

    // Never return candidate detail in an HTTP response — counts only.
    return res.status(200).json({
      ok: result.ok,
      apply,
      budgetMs: result.budgetMs,
      budgetExceeded: result.budgetExceeded,
      budgetExceededIn: result.budgetExceededIn,
      sequences: result.sequences,
      sequenceCatalogCount: result.sequenceCatalogCount,
      sequenceScopeScanned: result.sequenceScopeScanned,
      linkSequences: result.linkSequences,
      enabledLinkSequences: result.enabledLinkSequences,
      coveredEnabledLinkSequences: result.coveredEnabledLinkSequences,
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
    const expired = e?.code === "AUTH_EXPIRED" && (await isSessionActuallyExpired());
    if (e?.code === "AUTH_EXPIRED" && !expired) {
      return res.status(200).json({ ok: false, error: "throttled", detail: "Paraform rate-limited this pass; session verified live. Next run retries.", ranAt: new Date().toISOString() });
    }
    if (expired && (await shouldAlert("auth-expired"))) {
      await notifySlack(":rotating_light: Booking sweep hit AUTH_EXPIRED — the Paraform session cookie needs recapture. Booked candidates are unprotected until then.").catch(() => {});
    } else if (!expired && (await shouldAlert("sweep-error", 3600))) {
      await notifySlack(`:rotating_light: Booking sweep failed: ${String(e?.message || e).slice(0, 160)}`).catch(() => {});
    }
    return res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e?.message || e).slice(0, 200) });
  }
}
