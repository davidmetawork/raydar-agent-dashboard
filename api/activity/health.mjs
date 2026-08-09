// GET /api/activity/health — feed cache age, Paraform session state
// (serial 3-probe check: burst blips never read as expiry), KV state.

import { cors, requireAuth } from "../seq/_lib/core.mjs";
import { getJson, kvConfigured } from "./_lib/kv.mjs";
import { FEED_KEY } from "./_lib/feed.mjs";
import { hasCookie, sessionState } from "./_lib/paraform.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  try {
    const [cached, paraform] = await Promise.all([
      kvConfigured() ? getJson(FEED_KEY).catch(() => null) : null,
      hasCookie() ? sessionState() : "no_cookie",
    ]);
    res.status(200).json({
      ok: true,
      paraform,
      kv: kvConfigured() ? "configured" : "missing",
      feedCachedAt: cached?.generatedAt || null,
      feedCounts: cached?.counts || null,
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e).slice(0, 180) });
  }
}
