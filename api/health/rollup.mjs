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
  const ok = state.overall !== "DOWN" && !stale;
  return res.status(ok ? 200 : 503).json({
    ok,
    overall: stale ? "UNKNOWN" : state.overall,
    counts: state.counts,
    checkedAt: state.checkedAt,
    ...(stale ? { error: "stale_state" } : {}),
  });
}
