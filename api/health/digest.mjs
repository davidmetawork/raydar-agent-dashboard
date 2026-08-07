// Daily digest, 08:00 America/Denver. Everything the board knows that did not
// warrant waking anyone: degraded tiles, yesterday's incidents, expiring acks,
// lanes that have never beaten.
//
// When everything is clean it stays quiet on weekdays but ALWAYS speaks on
// Mondays — a digest that can go permanently silent is another silent failure.
import { cronAuth } from "../seq/_lib/core.mjs";
import { hGet, hSet, K } from "./_lib/kv.mjs";
import { sendSlack } from "./_lib/alert.mjs";
import { CATALOG } from "./_lib/catalog.mjs";

export const config = { maxDuration: 60 };

const age = (iso) => {
  const ms = Date.now() - Date.parse(iso || "");
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

export async function buildDigest(state, transitionsById) {
  const tiles = state?.tiles || {};
  const bad = Object.entries(tiles)
    .filter(([, t]) => ["DOWN", "DEGRADED", "UNKNOWN"].includes(t.state) && !t.ackUntil)
    .sort((a, b) => (a[1].state === "DOWN" ? -1 : 1));
  const acked = Object.entries(tiles).filter(([, t]) => t.ackUntil);
  const since = Date.now() - 24 * 3600 * 1000;
  const events = [];
  for (const [id, list] of Object.entries(transitionsById)) {
    for (const t of list || []) {
      if (Date.parse(t.t) >= since) {
        events.push(`${tiles[id]?.name || id}: ${t.from}→${t.to}${t.reason ? ` (${t.reason})` : ""}`);
      }
    }
  }
  const lines = [];
  lines.push(`*Raydar health · ${state?.overall || "UNKNOWN"}*  (${state?.counts?.OK || 0} OK · ${state?.counts?.DEGRADED || 0} degraded · ${state?.counts?.DOWN || 0} down · ${state?.counts?.UNKNOWN || 0} unknown)`);
  if (bad.length) {
    lines.push("", "*Needs attention*");
    for (const [id, t] of bad.slice(0, 20)) {
      lines.push(`• ${t.state === "DOWN" ? "🔴" : t.state === "DEGRADED" ? "🟠" : "🟣"} ${t.name || id} — ${t.reason || ""} (${age(t.since)})`);
    }
  }
  if (events.length) {
    lines.push("", `*Last 24h* (${events.length} changes)`);
    for (const e of events.slice(0, 15)) lines.push(`• ${e}`);
  }
  if (acked.length) {
    lines.push("", "*Acknowledged*");
    for (const [id, t] of acked) lines.push(`• ${t.name || id} — ${t.ackReason} (until ${t.ackUntil})`);
  }
  const neverBeat = CATALOG.filter((c) => c.kind === "beat" && !c.paused
    && tiles[c.id]?.reason === "no beats yet");
  if (neverBeat.length) {
    lines.push("", `*Never reported* — ${neverBeat.map((c) => c.name).join(", ")}`);
  }
  lines.push("", "https://monitor.raydar.xyz/health");
  return lines.join("\n");
}

export default async function handler(req, res) {
  const auth = cronAuth(req);
  if (!auth.ok) {
    return res.status(auth.reason === "no_cron_secret" ? 503 : 401).json({ ok: false, error: auth.reason });
  }
  const state = await hGet(K.state);
  if (!state) return res.status(200).json({ ok: true, skipped: "no_state" });
  const transitionsById = {};
  await Promise.all(CATALOG.map(async (c) => {
    transitionsById[c.id] = await hGet(K.trans(c.id));
  }));
  const quiet = state.overall === "OK"
    && !Object.values(transitionsById).some((l) => (l || []).some((t) => Date.now() - Date.parse(t.t) < 24 * 3600 * 1000));
  const isMonday = new Date().getUTCDay() === 1;
  if (quiet && !isMonday) {
    return res.status(200).json({ ok: true, skipped: "all_clear" });
  }
  const text = await buildDigest(state, transitionsById);
  const delivered = process.env.HEALTH_ALERTS_ENABLED === "true" ? await sendSlack(text) : false;
  await hSet(K.digestSent(new Date().toISOString().slice(0, 10)), { at: new Date().toISOString(), delivered });
  return res.status(200).json({ ok: true, delivered, preview: text.slice(0, 400) });
}
