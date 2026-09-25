// The 2-minute health tick: probe everything, persist, page tier-1 DOWN transitions.
// Cron-authed. Also runnable by hand with the CRON_SECRET bearer for drills.
import { cronAuth } from "../seq/_lib/core.mjs";
import { runTick } from "./_lib/engine.mjs";
import { alertOnTransitions } from "./_lib/alert.mjs";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const auth = cronAuth(req);
  if (!auth.ok) {
    return res.status(auth.reason === "no_cron_secret" ? 503 : 401)
      .json({ ok: false, error: auth.reason });
  }
  try {
    const { state, transitions, kvOk, stateLoaded, downTicks } = await runTick({});
    let alerts = [];
    // stateLoaded=false: hlth:state could not be read this tick, so every tile
    // looks newly observed and its page key would be fresh. Paging from that
    // would re-post ongoing outages; the next tick pages from the real state.
    if (process.env.HEALTH_ALERTS_ENABLED === "true" && stateLoaded) {
      // One page per tier-1 DOWN incident: no recovery notice and no hourly
      // STILL DOWN re-page (David 2026-09-24/25). The pass reads the tile
      // state, so an incident whose page failed, was acked, or began before
      // alerts were enabled still posts once (see alert.mjs).
      alerts = await alertOnTransitions(transitions, state);
    }
    return res.status(200).json({
      ok: true,
      checkedAt: state.checkedAt,
      overall: state.overall,
      counts: state.counts,
      transitions: transitions.length,
      alerts: alerts.length,
      // What HEALTH_DOWN_TICKS_OVERRIDES actually did: accepted tile ids and
      // tick counts, and any rejected keys with the reason.
      downTicks,
      kvOk,
      stateLoaded,
    });
  } catch (e) {
    console.error("health_tick_failed", { error: String(e?.message || e) });
    return res.status(500).json({ ok: false, error: "tick_failed" });
  }
}
