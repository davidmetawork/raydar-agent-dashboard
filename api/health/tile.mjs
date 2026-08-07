// Drill-down for one tile: transitions, 24h samples, uptime windows.
import { cors, requireAuth } from "../seq/_lib/core.mjs";
import { hGet, K } from "./_lib/kv.mjs";
import { byId } from "./_lib/catalog.mjs";

/** % of the window not spent DOWN. UNKNOWN/DEGRADED count as up: the number
 *  answers "was it working", not "was it perfect". */
function uptimeFromSamples(samples, windowMin, nowMin) {
  const inWindow = samples.filter((s) => nowMin - s.t <= windowMin);
  if (!inWindow.length) return null;
  const down = inWindow.filter((s) => s.s === "D").length;
  return Math.round(((inWindow.length - down) / inWindow.length) * 10000) / 100;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
  const id = String(q.id || "");
  const check = byId.get(id);
  if (!check) return res.status(404).json({ ok: false, error: "unknown_tile" });
  const [transitions, samples, state] = await Promise.all([
    hGet(K.trans(id)), hGet(K.samples(id)), hGet(K.state),
  ]);
  const list = samples || [];
  const nowMin = Math.floor(Date.now() / 60000);
  return res.status(200).json({
    ok: true,
    id,
    name: check.name,
    registry: check.registry || null,
    note: check.note || null,
    probeUrl: typeof check.probe?.url === "string" ? check.probe.url : null,
    tile: state?.tiles?.[id] || null,
    transitions: (transitions || []).slice(0, 20),
    uptime: {
      day: uptimeFromSamples(list, 1440, nowMin),
      week: uptimeFromSamples(list, 1440 * 7, nowMin),
      month: uptimeFromSamples(list, 1440 * 30, nowMin),
      samples: list.length,
    },
  });
}
