// GET /api/health/upcoming — the cached "upcoming calls" array from the
// screener-feed health probe (webview's /api/status), Google-session gated
// like every browser API (pattern: api/health/state.mjs).
//
// C6 (2026-09-24 Paraform reduction pass): calls-today.html's Upcoming panel
// used to fetch https://webview-lake.vercel.app/api/status directly from
// every open browser tab every 30s — uncounted, human-multiplied. This
// endpoint makes zero new outbound calls of its own: it only serves what the
// 2-minute health tick already fetched for the screener-feed tile (see
// api/health/_lib/engine.mjs), so N open tabs now cost the same one fetch
// per 2-minute tick regardless of how many people are watching.
import { cors, requireAuth } from "../seq/_lib/core.mjs";
import { hGet, K } from "./_lib/kv.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  res.setHeader("cache-control", "no-store");
  const cached = await hGet(K.upcoming);
  if (!cached || !Array.isArray(cached.upcoming)) {
    return res.status(200).json({ ok: true, upcoming: [], fetchedAt: null });
  }
  return res.status(200).json({
    ok: true,
    upcoming: cached.upcoming,
    fetchedAt: cached.fetchedAt || null,
  });
}
