// Health alerting. Slack only, transitions only, tier-1 only for immediate pages.
//
// Spec: docs/PRD-SYSTEM-HEALTH-TAB-2026-08-07.md §10 (main repo).
//
// Delivery is modeled on webview's slackReliable() (main repo
// webview/api/_lib/raydar.js): a 2026-06-25 audit found callers ignoring the
// return value, so a transient 5xx silently dropped the one page operators
// rely on. Three tries, then a loud console.error AND a recorded failure so
// the slack-transport tile turns red — alerting is itself a monitored system.
//
// Standing directive (docs/agent-memory/feedback_notify_only_actionable.md):
// alert only when a human must act; routine self-healing stays silent.
import { hDel, hGet, hSet, hSetNx, K } from "./kv.mjs";
import { notifyChannel, notifySwitchOn } from "../../_lib/notify-switch.mjs";

const RE_PAGE_SECONDS = 60 * 60;

// `channel` overrides the alert channel (the daily digest passes its own, so
// routine summaries never land in the critical-only #notify channel).
// `botTokenFirst` (the #notify switch, 2026-09-25): when a bot token and a
// channel are both present, post by token to that channel even if
// SLACK_WEBHOOK_URL is set. A webhook's channel is fixed by the webhook, so
// without this an override would silently land wherever the webhook points.
export async function sendSlack(text, { channel: channelOverride = "", botTokenFirst = false } = {}) {
  const token = process.env.SLACK_BOT_TOKEN || "";
  const channel = channelOverride || process.env.HEALTH_SLACK_CHANNEL || process.env.SLACK_CHANNEL_ID_ALERTS || "";
  const webhook = botTokenFirst && token && channel ? "" : process.env.SLACK_WEBHOOK_URL || "";
  if (!webhook && !(token && channel)) {
    console.error("health_alert_undeliverable", { reason: "no slack config" });
    await hSet(K.lastDelivered, { at: new Date().toISOString(), failed: true, reason: "unconfigured" });
    return false;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (webhook) {
        const r = await fetch(webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(10_000),
        });
        if (r.ok) {
          await hSet(K.lastDelivered, { at: new Date().toISOString(), failed: false });
          return true;
        }
      } else {
        const r = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ channel, text }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = await r.json().catch(() => null);
        if (body?.ok) {
          await hSet(K.lastDelivered, { at: new Date().toISOString(), failed: false });
          return true;
        }
      }
    } catch {
      // fall through to retry
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  console.error("health_alert_undeliverable", { text: text.slice(0, 120) });
  await hSet(K.lastDelivered, { at: new Date().toISOString(), failed: true, reason: "retries_exhausted" });
  return false;
}

// An incident's page claim. Short on purpose: it is held only while a send is
// in flight, then replaced by the long "delivered" marker. If the function is
// killed mid-send (maxDuration), the claim lapses and a later tick retries.
const PAGE_CLAIM_SECONDS = 5 * 60;
// How long a delivered page is remembered for its incident (the incident
// record's own lifetime, TRANS_TTL in engine.mjs).
const PAGED_TTL_SECONDS = 31 * 24 * 3600;

const claimed = (result) => result === "OK" || result === true;

/** The incident a DOWN tile belongs to. The engine keeps `incidentAt` on the
 *  tile for as long as it is away from OK; a tile born DOWN has no incident
 *  pointer, so its `since` stands in (constant while it stays DOWN). */
export const pageIncidentKey = (tile) => tile?.incidentAt || tile?.since || "unknown";

/**
 * Pages tier-1 DOWN incidents: exactly one delivered post per incident.
 * Nothing else posts, by policy (David, 2026-09-24/25: one critical-only
 * #notify channel, one post per incident).
 *
 * Deliberately absent, and pinned by test/notify-routine-removal.test.mjs:
 *  - no RECOVERED notice: a recovery is a success, and success posts are
 *    removed rather than moved. It was also the unthrottled half: it fired on
 *    every DOWN exit, even for DOWN episodes whose page the flap slot had
 *    suppressed (about 11 recoveries against 5 pages on 2026-09-23).
 *  - no hourly STILL DOWN re-page: a problem posts once. The tile stays red
 *    on monitor.raydar.xyz/health until it clears.
 *
 * The pass reads the tile STATE, not just this tick's transitions, and marks
 * an incident paged only after Slack accepts the post (pinned by
 * test/health-alert-one-post.test.mjs). With the hourly re-page gone, a
 * transition-only pager would lose an incident for good when:
 *  - every Slack try fails (or the tick is killed mid-send): the claim is
 *    released (or lapses) and the next tick sends it;
 *  - the tile went DOWN while acked, while HEALTH_ALERTS_ENABLED was off, or
 *    before it became tier 1: it pages once the ack ends or alerts turn on;
 *  - a second incident starts inside the flap window (below).
 *
 * Flap window: at most one page per tile per hour (the 1h NX slot). A new
 * incident inside that hour is DEFERRED, not dropped: if it is still DOWN
 * when the hour runs out it pages then, and if it clears first it never posts.
 *
 * `transitions` is kept for the call shape; the tile state carries everything
 * the page needs. `send` and `store` are test seams.
 *
 * With the #notify switch on (api/_lib/notify-switch.mjs) the page goes to
 * NOTIFY_SLACK_CHANNEL by bot token, the same channel as every other critical
 * sender, whatever HEALTH_SLACK_CHANNEL says. Switch off: unchanged.
 */
export async function alertOnTransitions(
  transitions,
  state,
  {
    env = process.env,
    send = sendSlack,
    store = { get: hGet, setNx: hSetNx, set: hSet, del: hDel },
  } = {},
) {
  void transitions;
  const sent = [];
  const route = notifySwitchOn(env) ? [{ channel: notifyChannel(env), botTokenFirst: true }] : [];
  for (const [id, tile] of Object.entries(state?.tiles || {})) {
    if (tile?.state !== "DOWN" || tile.tier !== 1) continue;
    if (tile.ackUntil) continue; // acknowledged: page after the ack, if still DOWN
    const incident = pageIncidentKey(tile);
    const pagedKey = K.alertSent(id, `DOWN:${incident}`);
    const at = new Date().toISOString();
    // Already delivered for this incident, or another tick is sending it now.
    if (!claimed(await store.setNx(pagedKey, { at, status: "sending" }, PAGE_CLAIM_SECONDS))) continue;
    const slotKey = K.alertSent(id, "DOWN");
    if (!claimed(await store.setNx(slotKey, { at, incident }, RE_PAGE_SECONDS))) {
      // The slot is this same incident's when an earlier send was cut off
      // before it could release it: carry on and send. Otherwise this tile
      // paged a different incident less than an hour ago: defer, retry later.
      const holder = await store.get(slotKey);
      if (holder?.incident !== incident) {
        await store.del(pagedKey);
        continue;
      }
    }
    const delivered = await send(
      `🔴 DOWN: ${tile.name || id} — ${tile.reason || "no reason given"}\n`
      + `since ${tile.since || at} · https://monitor.raydar.xyz/health`,
      ...route,
    );
    if (delivered === false) {
      // Not delivered: release both so the next tick tries again. The
      // slack-transport tile already records the failure.
      await store.del(pagedKey);
      await store.del(slotKey);
      continue;
    }
    try {
      await store.set(pagedKey, { at, status: "delivered" }, PAGED_TTL_SECONDS);
    } catch (e) {
      // The short claim will lapse and the incident may post a second time,
      // which is the safe side of losing a critical page.
      console.error("health_page_mark_failed", { id, error: String(e?.message || e) });
    }
    sent.push({ id, kind: "page", incident });
  }
  return sent;
}

export async function lastDelivery() {
  return hGet(K.lastDelivered);
}
