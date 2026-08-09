// GET /api/activity/digest — daily cron. Rebuilds the feed (warming the
// cache) and posts ONE Slack line when there is something a human must act
// on: open needs-reply count, oldest waiting age, gone-quiet count, plus a
// session-death alert. Silent when the queues are empty (Slack only when a
// human must act — the standing rule). Throttled to once per UTC day via KV.

import { cronAuth } from "../seq/_lib/core.mjs";
import { sendSlack } from "../health/_lib/alert.mjs";
import { getJson, setJson } from "./_lib/kv.mjs";
import { buildFeed, FEED_KEY } from "./_lib/feed.mjs";
import { hasCookie, sessionState } from "./_lib/paraform.mjs";
import { hgetallJson } from "./_lib/kv.mjs";
import { applyTriage } from "./feed.mjs";

const TRIAGE_KEY = "activity:v1:triage";
const DAY_KEY = () => `activity:v1:digest:${new Date().toISOString().slice(0, 10)}`;

export default async function handler(req, res) {
  const cron = cronAuth(req);
  if (!cron.ok) { res.status(401).json({ ok: false, error: "cron_auth_required" }); return; }

  if (!hasCookie()) { res.status(200).json({ ok: false, degraded: "no_cookie" }); return; }

  try {
    const already = await getJson(DAY_KEY());
    if (already) { res.status(200).json({ ok: true, skipped: "already_sent_today" }); return; }

    let feed;
    try {
      feed = await buildFeed();
      await setJson(FEED_KEY, feed).catch(() => {});
    } catch (e) {
      const state = await sessionState().catch(() => "error");
      if (state === "expired") {
        const sent = await sendSlack(":rotating_light: Activity tab: the Paraform session is EXPIRED — the queues cannot refresh until David re-authenticates (Chrome login + persist script).").catch(() => false);
        await setJson(DAY_KEY(), { sent: Boolean(sent), kind: "auth_alert" }, { ttlSeconds: 26 * 3600 });
        res.status(200).json({ ok: false, degraded: "paraform_auth", alerted: Boolean(sent) });
        return;
      }
      throw e;
    }

    const triage = await hgetallJson(TRIAGE_KEY).catch(() => ({}));
    const overlaid = applyTriage(feed, triage);
    const open = overlaid.counts.open_needs_reply ?? feed.counts.needs_reply;
    const quiet = overlaid.counts.open_gone_quiet ?? feed.counts.gone_quiet;
    if (open === 0 && quiet === 0) {
      await setJson(DAY_KEY(), { sent: false, kind: "empty" }, { ttlSeconds: 26 * 3600 });
      res.status(200).json({ ok: true, skipped: "queues_empty" });
      return;
    }

    const oldest = overlaid.queues.needs_reply.find((r) => !r.triage);
    const oldestDays = oldest ? ((Date.now() - oldest.waitingSinceMs) / 86400000).toFixed(1) : null;
    const line = `:speech_balloon: Activity queue: *${open}* need a reply` +
      (oldestDays ? ` (oldest waiting ${oldestDays}d)` : "") +
      `, *${quiet}* gone quiet 48h+ — https://monitor.raydar.xyz/#activity`;
    const sent = await sendSlack(line).catch(() => false);
    await setJson(DAY_KEY(), { sent: Boolean(sent), kind: "digest", open, quiet }, { ttlSeconds: 26 * 3600 });
    res.status(200).json({ ok: true, sent: Boolean(sent), open, quiet });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
  }
}
