// BOOKING SWEEP — hourly reconciliation backstop behind the Calendly webhook.
//
// The webhook (calendly-hook.mjs) is the fast path. This is what makes the
// system self-healing, and it exists for three reasons the webhook cannot cover:
//   1. webhook deliveries can be dropped or arrive during a deploy;
//   2. a webhook only knows the address the candidate typed into Calendly — the
//      sweep also reads the candidate's Paraform profile addresses, which is how
//      it catches the people who book from a different mailbox than we email;
//   3. the Paraform "Book Time" path sets relationship_status = SCHEDULED_CALL
//      and emits no webhook at all.
//
// It is deliberately a SEPARATE function from guardian.mjs (the protected-recruiter
// guardian). That guardian enforces a hard "never message this recruiter's
// candidates" invariant and must never be able to fail because a Calendly call
// timed out. Separate files, separate crons, separate failure boundaries.
//
// FAIL LOUDLY. The predecessor to this system died for nine days in silence.
// Everything below that alerts is there because of a specific way that happened.
import { cors, requireAuth, hasCookie } from "./_lib/core.mjs";
import {
  runBookingSweep,
  recordSuccessfulSweep,
  sweepStaleness,
  shouldAlert,
  isSessionActuallyExpired,
  kvConfigured,
  calendlyConfigured,
} from "./_lib/booking-stop.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";

export const config = { maxDuration: 300 };

function isCron(req) {
  if (req.headers["x-vercel-cron"]) return true;
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers["authorization"] || "") === `Bearer ${secret}`) return true;
  return false;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!isCron(req) && !(await requireAuth(req, res))) return;

  const apply = new URL(req.url, "http://x").searchParams.get("dry") !== "1";

  // Preconditions are alerts, not silent no-ops: an unconfigured control is
  // indistinguishable from a working one until someone gets a bad email.
  if (!hasCookie()) {
    if (await shouldAlert("no-cookie")) {
      await notifySlack(":rotating_light: Booking sweep cannot run — PARAFORM_COOKIE is not configured. Booked candidates are receiving sequence nudges.").catch(() => {});
    }
    return res.status(200).json({ ok: false, error: "no_cookie" });
  }
  if (!calendlyConfigured()) {
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
    const result = await runBookingSweep({ apply });

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

    if (result.calendlyTruncated && (await shouldAlert("calendly-truncated"))) {
      await notifySlack(":warning: Booking sweep hit the Calendly pagination ceiling — some bookings may not have been read this pass.").catch(() => {});
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

    if (result.ok && apply) await recordSuccessfulSweep(result);

    // Never return candidate detail in an HTTP response — counts only.
    return res.status(200).json({
      ok: result.ok,
      apply,
      sequences: result.sequences,
      activeLeads: result.activeLeads,
      calendlyEvents: result.calendlyEvents,
      calendlyCacheHits: result.calendlyCacheHits,
      calendlyTruncated: result.calendlyTruncated,
      profilesRead: result.profilesRead,
      profileCoverage: result.profileCoverage,
      matched: result.decisions.length,
      paused: result.paused,
      pauseErrors: result.pauseErrors,
      durationMs: result.durationMs,
      staleness,
      ranAt: new Date().toISOString(),
    });
  } catch (e) {
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
