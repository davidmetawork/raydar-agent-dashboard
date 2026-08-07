// The 2-minute health tick: probe everything, persist, alert on transitions.
// Cron-authed. Also runnable by hand with the CRON_SECRET bearer for drills.
import { cronAuth } from "../seq/_lib/core.mjs";
import { runTick } from "./_lib/engine.mjs";
import { alertOnTransitions, repageStillDown } from "./_lib/alert.mjs";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const auth = cronAuth(req);
  if (!auth.ok) {
    return res.status(auth.reason === "no_cron_secret" ? 503 : 401)
      .json({ ok: false, error: auth.reason });
  }
  try {
    const { state, transitions, kvOk } = await runTick({});
    let alerts = [];
    if (process.env.HEALTH_ALERTS_ENABLED === "true") {
      alerts = await alertOnTransitions(transitions, state);
      alerts = alerts.concat(await repageStillDown(state));
    }
    return res.status(200).json({
      ok: true,
      checkedAt: state.checkedAt,
      overall: state.overall,
      counts: state.counts,
      transitions: transitions.length,
      alerts: alerts.length,
      kvOk,
    });
  } catch (e) {
    console.error("health_tick_failed", { error: String(e?.message || e) });
    return res.status(500).json({ ok: false, error: "tick_failed" });
  }
}
