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

export async function sendSlack(text) {
  const token = process.env.SLACK_BOT_TOKEN || "";
  const channel = process.env.HEALTH_SLACK_CHANNEL || process.env.SLACK_CHANNEL_ID_ALERTS || "";
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

const dur = (fromIso) => {
  const ms = Date.now() - Date.parse(fromIso || "");
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

/**
 * Fires pages for tier-1 DOWN transitions and recovery notices for any tile
 * leaving DOWN. Everything else is digest-only, by policy.
 */
export async function alertOnTransitions(transitions, state) {
  const sent = [];
  for (const t of transitions) {
    const tile = state.tiles[t.id] || {};
    if (tile.ackUntil) continue; // acknowledged: never alert

    if (t.to === "DOWN" && t.tier === 1) {
      const won = await hSetNx(K.alertSent(t.id, "DOWN"), { at: t.at }, RE_PAGE_SECONDS);
      if (won === "OK" || won === true) {
        await sendSlack(
          `🔴 DOWN: ${t.name} — ${t.reason || "no reason given"}\n`
          + `since ${t.at} · https://monitor.raydar.xyz/health`,
        );
        sent.push({ id: t.id, kind: "page" });
      }
    } else if (t.from === "DOWN" && t.to !== "DOWN") {
      const wasPaged = byTier1(t);
      if (wasPaged) {
        await sendSlack(`🟢 RECOVERED: ${t.name} after ${dur(t.sinceLast)} — now ${t.to}`);
        sent.push({ id: t.id, kind: "recovery" });
      }
    }
  }
  return sent;
}

const byTier1 = (t) => t.tier === 1;

/** Re-page anything still DOWN whose dedupe marker has aged out. */
export async function repageStillDown(state) {
  const sent = [];
  for (const [id, tile] of Object.entries(state.tiles)) {
    if (tile.state !== "DOWN" || tile.tier !== 1 || tile.ackUntil) continue;
    const won = await hSetNx(K.alertSent(id, "DOWN"), { at: new Date().toISOString() }, RE_PAGE_SECONDS);
    if (won === "OK" || won === true) {
      await sendSlack(
        `🔴 STILL DOWN (${dur(tile.since)}): ${tile.name} — ${tile.reason || ""}\n`
        + `https://monitor.raydar.xyz/health`,
      );
      sent.push({ id, kind: "repage" });
    }
  }
  return sent;
}

export async function lastDelivery() {
  return hGet(K.lastDelivered);
}
