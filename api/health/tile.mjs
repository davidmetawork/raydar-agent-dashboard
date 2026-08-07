// Drill-down for one tile: transitions, 24h samples, uptime windows.
import { cors, requireAuth } from "../seq/_lib/core.mjs";
import { hGet, K } from "./_lib/kv.mjs";
import { byId } from "./_lib/catalog.mjs";

/**
 * % of the window not spent DOWN, reconstructed from the transition log.
 *
 * Transitions (31d retention) are the only history long enough to answer a
 * 7d/30d question — the sample ring buffer holds 24h, so deriving a "30d"
 * number from it would just be 24h wearing a bigger label.
 *
 * UNKNOWN/DEGRADED count as up: the number answers "was it working", not
 * "was it perfect". Windows are clipped to the start of known history, and
 * `null` means we have not been watching long enough to say.
 */
export function uptimeFromTransitions(transitions, tile, windowMin, now) {
  if (!tile?.state) return null;
  const windowStart = now - windowMin * 60000;
  // Walk backwards from now, newest transition first, building [start,end)
  // segments of known state.
  const segments = [];
  let cursor = now;
  let curState = tile.state;
  for (const tr of transitions) {
    const at = Date.parse(tr.t);
    if (!Number.isFinite(at) || at > cursor) continue;
    segments.push({ start: at, end: cursor, state: curState });
    cursor = at;
    curState = tr.from;
  }
  // Before the oldest transition we only know the state at that instant, so
  // history starts there. With no transitions at all, it starts at `since`.
  const historyStart = transitions.length ? cursor : Date.parse(tile.since);
  if (!Number.isFinite(historyStart)) return null;
  if (!transitions.length) segments.push({ start: historyStart, end: now, state: curState });

  const from = Math.max(windowStart, historyStart);
  const span = now - from;
  if (span <= 0) return null;
  let downMs = 0;
  for (const seg of segments) {
    if (seg.state !== "DOWN") continue;
    const overlap = Math.min(seg.end, now) - Math.max(seg.start, from);
    if (overlap > 0) downMs += overlap;
  }
  return {
    pct: Math.round((1 - downMs / span) * 10000) / 100,
    observedMin: Math.round(span / 60000),
    clipped: historyStart > windowStart,
  };
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
  const trans = transitions || [];
  const tile = state?.tiles?.[id] || null;
  const now = Date.now();
  return res.status(200).json({
    ok: true,
    id,
    name: check.name,
    registry: check.registry || null,
    note: check.note || null,
    probeUrl: typeof check.probe?.url === "string" ? check.probe.url : null,
    tile,
    transitions: trans.slice(0, 20),
    uptime: {
      day: uptimeFromTransitions(trans, tile, 1440, now),
      week: uptimeFromTransitions(trans, tile, 1440 * 7, now),
      month: uptimeFromTransitions(trans, tile, 1440 * 30, now),
      samples: list.length,
    },
  });
}
