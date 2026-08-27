import { syncPathARows } from "./_lib/sync.mjs";
import { requireCron, requireHuman, sendError } from "./_lib/http.mjs";
import { storeConfigured } from "./_lib/store.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ ok: false, error: "GET_or_POST_only" });
  }
  const authed = req.method === "GET"
    ? requireCron(req, res)
    : await requireHuman(req, res);
  if (!authed) return;
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  try {
    const result = await syncPathARows({ force: req.method === "POST" });
    return res.status(result.busy ? 202 : 200).json(result);
  } catch (error) {
    return sendError(res, error);
  }
}

