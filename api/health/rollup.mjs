// PUBLIC minimal rollup — the external dead-man target (UptimeRobot).
//
// Deliberately exposes no system names, URLs or reasons: it is unauthenticated,
// so it says only whether Raydar is healthy, never what Raydar is made of.
// 503 when overall is DOWN **or** the state is stale — a tick that stopped
// running is exactly the silent failure this endpoint exists to catch.
import { hGet, K } from "./_lib/kv.mjs";

const STALE_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const state = await hGet(K.state);
  if (!state) {
    return res.status(503).json({ ok: false, overall: "UNKNOWN", error: "no_state" });
  }
  const age = Date.now() - Date.parse(state.checkedAt);
  const stale = !(age < STALE_MS);
  // 503 on: a candidate-facing (tier-1) system DOWN, or a tick that stopped.
  // Deliberately NOT on tier-2/3 degradation — see engine.mjs on criticalDown.
  const critical = Number(state.criticalDown ?? (state.overall === "DOWN" ? 1 : 0));
  const ok = critical === 0 && !stale;
  return res.status(ok ? 200 : 503).json({
    ok,
    overall: stale ? "UNKNOWN" : state.overall,
    criticalDown: critical,
    counts: state.counts,
    checkedAt: state.checkedAt,
    ...(stale ? { error: "stale_state" } : {}),
  });
}
