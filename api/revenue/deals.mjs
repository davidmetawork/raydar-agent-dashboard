// GET /api/revenue/deals            — the ledger rows
// GET /api/revenue/deals?format=csv — the same rows as a CSV download
//
// The CSV is not a convenience feature. KV has no backup and no point-in-time
// recovery, and this project's Upstash database was deleted once already with
// its history unrecoverable. Being able to pull the whole ledger out in one
// click is what keeps a provider incident from being a data loss.

import { cors, privateJson, requireAuth } from "./_lib/core.mjs";
import { kvConfigured, listDeals, readAudit } from "./_lib/store.mjs";
import { toCsv } from "./_lib/model.mjs";

export const config = { maxDuration: 30 };

export function createDealsHandler({
  corsHandler = cors,
  authHandler = requireAuth,
  kvReady = kvConfigured,
  deals = listDeals,
  audit = readAudit,
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    if (req.method !== "GET") return privateJson(res, 405, { ok: false, error: "GET only" });
    if (!(await authHandler(req, res))) return;
    if (!kvReady()) return privateJson(res, 503, { ok: false, error: "state_store_not_configured" });

    try {
      const rows = await deals();

      if (String(req.query?.format || "") === "csv") {
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="raydar-revenue-${stamp}.csv"`);
        return res.status(200).send(toCsv(rows));
      }

      const withAudit = String(req.query?.audit || "") === "1";
      return privateJson(res, 200, {
        ok: true,
        deals: rows,
        count: rows.length,
        audit: withAudit ? await audit(100).catch(() => []) : undefined,
      });
    } catch (error) {
      console.error("revenue_deals_failed", { error: String(error?.message || error) });
      return privateJson(res, 500, { ok: false, error: "deals_failed" });
    }
  };
}

const handler = createDealsHandler();
export default handler;
export { handler };
