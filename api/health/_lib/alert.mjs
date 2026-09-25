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
import { hGet, hSet, hSetNx, K } from "./kv.mjs";

const RE_PAGE_SECONDS = 60 * 60;

// `channel` overrides the alert channel (the daily digest passes its own, so
// routine summaries never land in the critical-only #notify channel).
export async function sendSlack(text, { channel: channelOverride = "" } = {}) {
  const token = process.env.SLACK_BOT_TOKEN || "";
  const channel = channelOverride || process.env.HEALTH_SLACK_CHANNEL || process.env.SLACK_CHANNEL_ID_ALERTS || "";
  const webhook = process.env.SLACK_WEBHOOK_URL || "";
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

/**
 * Pages tier-1 DOWN transitions. Nothing else posts, by policy (David,
 * 2026-09-24/25: one critical-only #notify channel, one post per incident).
 *
 * Deliberately absent, and pinned by test/health-alert-one-post.test.mjs:
 *  - no RECOVERED notice: a recovery is a success, and success posts are
 *    removed rather than moved. It was also the unthrottled half: it fired on
 *    every DOWN exit, even for DOWN episodes whose page the flap slot had
 *    suppressed (about 11 recoveries against 5 pages on 2026-09-23).
 *  - no hourly STILL DOWN re-page: a problem posts once, when it starts. The
 *    tile stays red on monitor.raydar.xyz/health until it clears.
 *
 * The DOWN page keeps its 1h NX slot per tile, so a tile flapping in and out
 * of DOWN inside an hour still posts once.
 */
export async function alertOnTransitions(transitions, state) {
  const sent = [];
  for (const t of transitions) {
    const tile = state.tiles[t.id] || {};
    if (tile.ackUntil) continue; // acknowledged: never alert
    if (t.to !== "DOWN" || t.tier !== 1) continue;
    const won = await hSetNx(K.alertSent(t.id, "DOWN"), { at: t.at }, RE_PAGE_SECONDS);
    if (won === "OK" || won === true) {
      await sendSlack(
        `🔴 DOWN: ${t.name} — ${t.reason || "no reason given"}\n`
        + `since ${t.at} · https://monitor.raydar.xyz/health`,
      );
      sent.push({ id: t.id, kind: "page" });
    }
  }
  return sent;
}

export async function lastDelivery() {
  return hGet(K.lastDelivered);
}
