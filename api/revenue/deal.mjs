// POST   /api/revenue/deal  — add a deal        (any signed-in member)
// PATCH  /api/revenue/deal  — edit a deal       (editors only)
// DELETE /api/revenue/deal  — remove a deal     (editors only)
//
// PERMISSIONS, deliberately asymmetric. Adding is open because a missing
// placement is a worse failure than a duplicate one, and friction on entry
// costs us data. Editing and deleting can silently change a number people are
// compensated against, so they stay with David.
//
// PREFER VOIDING TO DELETING. A deal that falls through should be PATCHed to
// status "fell_through": it stops counting toward the goal but stays in the
// ledger and in the history. DELETE exists for genuine mistakes (a typo'd
// duplicate) and always writes the full prior record into the audit log first,
// so even a delete is recoverable from history.

import { cors, privateJson, readJsonBody, requireAuth, requireEditor } from "./_lib/core.mjs";
import {
  appendAudit, deleteDeal, getDeal, kvConfigured, newDealId, putDeal, validDealId,
} from "./_lib/store.mjs";
import { normalizeDeal } from "./_lib/model.mjs";

export const config = { maxDuration: 30 };

export function createDealHandler({
  corsHandler = cors,
  authHandler = requireAuth,
  editorGuard = requireEditor,
  kvReady = kvConfigured,
  read = getDeal,
  write = putDeal,
  remove = deleteDeal,
  logAudit = appendAudit,
  makeId = newDealId,
  now = () => new Date().toISOString(),
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    const method = String(req.method || "").toUpperCase();
    if (!["POST", "PATCH", "DELETE"].includes(method)) {
      return privateJson(res, 405, { ok: false, error: "POST, PATCH or DELETE only" });
    }
    if (!(await authHandler(req, res))) return;
    if (!kvReady()) return privateJson(res, 503, { ok: false, error: "state_store_not_configured" });

    const parsed = readJsonBody(req);
    if (parsed.error) return privateJson(res, 400, { ok: false, error: parsed.error });
    const body = parsed.body;
    const actor = String(req.authedEmail || "").trim().toLowerCase() || "unknown";
    const stamp = now();

    try {
      if (method === "POST") {
        const id = makeId();
        const { deal, errors } = normalizeDeal(body, { id, now: stamp, actor });
        if (errors) return privateJson(res, 400, { ok: false, error: "invalid_deal", details: errors });
        await write(deal);
        await logAudit({ at: stamp, who: actor, action: "create", dealId: id, before: null, after: deal });
        return privateJson(res, 201, { ok: true, deal });
      }

      const id = String(body.id || "").trim();
      if (!validDealId(id)) return privateJson(res, 400, { ok: false, error: "invalid_id" });
      if (!editorGuard(req, res)) return;

      const existing = await read(id);
      if (!existing) return privateJson(res, 404, { ok: false, error: "not_found" });

      if (method === "DELETE") {
        await remove(id);
        // The full prior record goes into the audit log BEFORE we answer, so a
        // deletion is always reconstructible.
        await logAudit({ at: stamp, who: actor, action: "delete", dealId: id, before: existing, after: null });
        return privateJson(res, 200, { ok: true, deleted: id });
      }

      const { deal, errors } = normalizeDeal(body, { id, now: stamp, actor, existing });
      if (errors) return privateJson(res, 400, { ok: false, error: "invalid_deal", details: errors });
      await write(deal);
      await logAudit({ at: stamp, who: actor, action: "update", dealId: id, before: existing, after: deal });
      return privateJson(res, 200, { ok: true, deal });
    } catch (error) {
      console.error("revenue_deal_failed", { method, error: String(error?.message || error) });
      return privateJson(res, 500, { ok: false, error: "deal_write_failed" });
    }
  };
}

const handler = createDealHandler();
export default handler;
export { handler };
