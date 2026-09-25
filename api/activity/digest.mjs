// GET /api/activity/digest — daily cron. Rebuilds the feed (warming the
// cache) once per UTC day and reports the queue counts in its response.
//
// It posts NOTHING to Slack (2026-09-25, David's one-channel rule). It used to
// post a daily "Activity queue" line (a routine digest, removed rather than
// moved) and an "Activity tab: Paraform session is EXPIRED" line, which
// repeated what the System Health paraform-session tile and the Para AI auth
// circuit already report. Both sendSlack calls went to HEALTH_SLACK_CHANNEL,
// which is now the critical-only #notify, so leaving them in would have put a
// daily routine post into #notify the moment the dashboardReaders pause lifts.
// The queues stay visible on monitor.raydar.xyz/#activity.

import { cronAuth } from "../seq/_lib/core.mjs";
import { getJson, setJson } from "./_lib/kv.mjs";
import { buildFeed, FEED_KEY } from "./_lib/feed.mjs";
import { hasCookie, sessionState } from "./_lib/paraform.mjs";
import { hgetallJson } from "./_lib/kv.mjs";
import { applyTriage } from "./feed.mjs";
import { paraformBackgroundPauseState } from "../_lib/paraform-background-pause.mjs";

const TRIAGE_KEY = "activity:v1:triage";
const DAY_KEY = () => `activity:v1:digest:${new Date().toISOString().slice(0, 10)}`;

export async function handleActivityDigest(req, res, {
  pauseState = () => paraformBackgroundPauseState("dashboardReaders"),
  cronAuthorize = cronAuth,
  cookiePresent = hasCookie,
  readMarker = getJson,
  writeMarker = setJson,
  buildFeedImpl = buildFeed,
  sessionStateImpl = sessionState,
  readTriage = () => hgetallJson(TRIAGE_KEY),
} = {}) {
  const cron = cronAuthorize(req);
  if (!cron.ok) { res.status(401).json({ ok: false, error: "cron_auth_required" }); return; }

  const backgroundPause = await pauseState()
    .catch(() => ({ paused: true, state: "unreadable" }));
  if (backgroundPause?.paused) {
    res.setHeader("Retry-After", "300");
    return res.status(503).json({
      ok: false,
      paused: true,
      error: "paraform_background_paused",
      controlState: backgroundPause.state || "unreadable",
    });
  }
  if (!cookiePresent()) { res.status(200).json({ ok: false, degraded: "no_cookie" }); return; }

  try {
    const already = await readMarker(DAY_KEY());
    if (already) { res.status(200).json({ ok: true, skipped: "already_ran_today" }); return; }

    let feed;
    try {
      feed = await buildFeedImpl();
      await writeMarker(FEED_KEY, feed).catch(() => {});
    } catch (e) {
      const state = await sessionStateImpl().catch(() => "error");
      if (state === "expired") {
        // No Slack: the paraform-session tile and the auth circuit own this.
        await writeMarker(DAY_KEY(), { kind: "paraform_auth" }, { ttlSeconds: 26 * 3600 });
        res.status(200).json({ ok: false, degraded: "paraform_auth" });
        return;
      }
      throw e;
    }

    const triage = await readTriage().catch(() => ({}));
    const overlaid = applyTriage(feed, triage);
    const open = overlaid.counts.open_needs_reply ?? feed.counts.needs_reply;
    const quiet = overlaid.counts.open_gone_quiet ?? feed.counts.gone_quiet;
    await writeMarker(DAY_KEY(), { kind: "warmed", open, quiet }, { ttlSeconds: 26 * 3600 });
    res.status(200).json({ ok: true, warmed: true, open, quiet });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
  }
}

export default async function handler(req, res) {
  return handleActivityDigest(req, res);
}
