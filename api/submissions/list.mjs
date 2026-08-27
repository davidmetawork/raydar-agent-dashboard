import { readRowsSnapshot, storeConfigured } from "./_lib/store.mjs";
import { requireHuman, sendError } from "./_lib/http.mjs";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (!(await requireHuman(req, res))) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET_only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  try {
    const snapshot = await readRowsSnapshot();
    if (!snapshot) return res.status(200).json({ ok: true, warming: true, snapshot: null });
    return res.status(200).json({ ok: true, warming: false, snapshot });
  } catch (error) {
    return sendError(res, error);
  }
}

