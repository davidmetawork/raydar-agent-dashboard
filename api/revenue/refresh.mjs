// GET /api/revenue/refresh — the 5-minute activity warmer. Cron-authed.
//
// This is the whole reason the homepage paints instantly. It pulls the Paraform
// activity half and the calls-set series into KV on a schedule so that no
// viewer request ever waits on a provider. Without it the page still works
// (summary.mjs refreshes a cold cache inline), it is just slow once.
//
// It lives on THIS project because webview and lifecycle are both at Vercel's
// six-cron ceiling and both deploy only from David's desktop.
//
// A refresh failure is not an outage: the last-good payload stays in KV and
// keeps being served with a stale marker. This endpoint never clears the cache.

import { cronAuth } from "../seq/_lib/core.mjs";
import { buildActivity } from "./_lib/activity.mjs";
import { kvConfigured, writeActivity } from "./_lib/store.mjs";

export const config = { maxDuration: 60 };

export function createRefreshHandler({
  auth = cronAuth,
  kvReady = kvConfigured,
  build = buildActivity,
  persist = writeActivity,
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    const authed = auth(req);
    if (!authed.ok) {
      return res.status(authed.reason === "no_cron_secret" ? 503 : 401).json({ ok: false, error: authed.reason });
    }
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });

    const at = now();
    try {
      const payload = await build({ now: at });
      // Only a payload with at least one live source is worth persisting —
      // overwriting good data with a double failure would turn a transient
      // provider blip into a blank homepage.
      if (!payload.ok) {
        console.error("revenue_refresh_all_sources_failed", { errors: payload.errors });
        return res.status(200).json({ ok: false, persisted: false, errors: payload.errors });
      }
      await persist(payload, Math.floor(at.getTime() / 1000));
      return res.status(200).json({
        ok: true,
        persisted: true,
        at: at.toISOString(),
        paraform: Boolean(payload.paraform),
        calls: Boolean(payload.calls),
        errors: payload.errors,
      });
    } catch (error) {
      console.error("revenue_refresh_failed", { error: String(error?.message || error) });
      return res.status(500).json({ ok: false, error: "refresh_failed" });
    }
  };
}

const handler = createRefreshHandler();
export default handler;
export { handler };
