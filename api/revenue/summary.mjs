// GET /api/revenue/summary — everything the homepage renders, in one payload.
//
// SERVING MODEL: this endpoint never waits on Paraform. The activity half is
// warmed into KV every 5 minutes by /api/revenue/refresh and served from that
// copy; the revenue half is read straight from our own ledger and is therefore
// current the instant someone saves a deal. A cold cache (first request after a
// deploy, or a cron outage) refreshes inline once, single-flighted through a
// lock so a burst of viewers cannot stampede Paraform.
//
// This is the fix for the 45-second Analytics wait: the wait was caused by
// fetching Paraform inline on every request.

import { cors, isEditor, privateJson, requireAuth } from "./_lib/core.mjs";
import { buildActivity } from "./_lib/activity.mjs";
import {
  claimActivityLock, kvConfigured, listDeals, readActivity, readMeta, writeActivity,
} from "./_lib/store.mjs";
import { DEFAULT_TARGET_CENTS, summarize } from "./_lib/model.mjs";

export const config = { maxDuration: 60 };

// Older than this and a viewer will refresh it inline rather than show it.
const STALE_SECONDS = 15 * 60;

export function createSummaryHandler({
  corsHandler = cors,
  authHandler = requireAuth,
  kvReady = kvConfigured,
  deals = listDeals,
  meta = readMeta,
  activity = readActivity,
  persistActivity = writeActivity,
  lock = claimActivityLock,
  build = buildActivity,
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    if (req.method !== "GET") return privateJson(res, 405, { ok: false, error: "GET only" });
    if (!(await authHandler(req, res))) return;
    if (!kvReady()) return privateJson(res, 503, { ok: false, error: "state_store_not_configured" });

    const at = now();
    try {
      const [ledger, settings, cached] = await Promise.all([deals(), meta(), activity()]);

      let payload = cached.payload;
      let refreshedAt = cached.refreshedAt;
      let stale = false;

      const ageSeconds = refreshedAt ? Math.floor(at.getTime() / 1000) - refreshedAt : Infinity;
      if (ageSeconds > STALE_SECONDS) {
        // Only one request rebuilds; everyone else serves what we have and says
        // so, rather than queueing behind a provider call.
        if (await lock().catch(() => false)) {
          try {
            payload = await build({ now: at });
            refreshedAt = Math.floor(at.getTime() / 1000);
            await persistActivity(payload, refreshedAt);
          } catch (error) {
            console.error("revenue_activity_build_failed", { error: String(error?.message || error) });
            stale = Boolean(cached.payload);
          }
        } else {
          stale = Boolean(cached.payload);
        }
      }

      const targetCents = Number.isInteger(settings?.targetCents) ? settings.targetCents : DEFAULT_TARGET_CENTS;
      const revenue = summarize(ledger, {
        now: at,
        targetCents,
        paraformHiresByMonth: payload?.hiresByMonth || null,
      });

      return privateJson(res, 200, {
        ok: true,
        revenue,
        activity: payload || null,
        activityRefreshedAt: refreshedAt ? new Date(refreshedAt * 1000).toISOString() : null,
        activityStale: stale || Boolean(payload?.errors?.length),
        canEdit: Boolean(req.canEditRevenue),
        viewer: req.authedEmail || null,
        generatedAt: at.toISOString(),
      });
    } catch (error) {
      console.error("revenue_summary_failed", { error: String(error?.message || error) });
      return privateJson(res, 500, { ok: false, error: "summary_failed" });
    }
  };
}

// Authenticate, then stamp whether this viewer may edit — the page uses it to
// decide which controls to render. It is a UI hint only; every mutating
// endpoint re-checks server-side.
async function authAndStampEditor(req, res) {
  if (!(await requireAuth(req, res))) return false;
  req.canEditRevenue = isEditor(req.authedEmail);
  return true;
}

const handler = createSummaryHandler({ authHandler: authAndStampEditor });

export default handler;
export { handler };
