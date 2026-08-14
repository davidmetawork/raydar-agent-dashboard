// POST /api/revenue/import — bulk-load pasted rows from the revenue sheet.
// Editors only.
//
// TWO-STEP BY DESIGN. `{text}` alone returns a parse PREVIEW and writes
// nothing; only `{text, confirm:true}` commits. A bulk write into a
// compensation ledger should never be one click away from a paste.
//
// WHY PASTE RATHER THAN A SERVER-SIDE SHEET READ: the ledger holds client and
// candidate names. Keeping the import as an operator paste means no candidate
// data has to live in this repo, in a fixture, or in a service account's
// permanent read scope.
//
// Rows that cannot be read EXACTLY are reported as skips with a reason, never
// coerced. The sheet's own quirks are handled explicitly: bare "Nov 15" dates,
// "Pending"/"-" paid values, blank spacer rows, and the trailing totals block.

import { cors, privateJson, readJsonBody, requireAuth, requireEditor } from "./_lib/core.mjs";
import { appendAudit, kvConfigured, listDeals, newDealId, putDeals } from "./_lib/store.mjs";
import { normalizeDeal, parseImport } from "./_lib/model.mjs";

export const config = { maxDuration: 60 };

const MAX_TEXT_BYTES = 500_000;
const MAX_ROWS = 1000;

/** Same signing month + client + amount = the same deal. Cheap idempotency for a re-paste. */
const fingerprint = (deal) =>
  [deal.offerSignedAt, String(deal.client || "").toLowerCase().trim(), deal.dealSizeCents].join("|");

export function createImportHandler({
  corsHandler = cors,
  authHandler = requireAuth,
  editorGuard = requireEditor,
  kvReady = kvConfigured,
  existingDeals = listDeals,
  write = putDeals,
  logAudit = appendAudit,
  makeId = newDealId,
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    if (req.method !== "POST") return privateJson(res, 405, { ok: false, error: "POST only" });
    if (!(await authHandler(req, res))) return;
    if (!kvReady()) return privateJson(res, 503, { ok: false, error: "state_store_not_configured" });
    if (!editorGuard(req, res)) return;

    const parsed = readJsonBody(req);
    if (parsed.error) return privateJson(res, 400, { ok: false, error: parsed.error });

    const text = String(parsed.body.text || "");
    if (!text.trim()) return privateJson(res, 400, { ok: false, error: "no_text" });
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      return privateJson(res, 413, { ok: false, error: "text_too_large" });
    }

    const at = now();
    const stamp = at.toISOString();
    const actor = String(req.authedEmail || "").trim().toLowerCase() || "unknown";

    try {
      const result = parseImport(text, { now: at, defaultYear: parsed.body.defaultYear });
      if (result.error) {
        return privateJson(res, 400, { ok: false, error: "unrecognised_columns", detail: result.error, headers: result.headers });
      }
      if (result.rows.length > MAX_ROWS) {
        return privateJson(res, 413, { ok: false, error: "too_many_rows", rows: result.rows.length });
      }

      const current = await existingDeals();
      const seen = new Set(current.map(fingerprint));

      const ready = [];
      const duplicates = [];
      const invalid = [];
      for (const row of result.rows) {
        const { deal, errors } = normalizeDeal(row, { id: makeId(), now: stamp, actor });
        if (errors) { invalid.push({ client: row.client, reason: errors.join("; ") }); continue; }
        const key = fingerprint(deal);
        if (seen.has(key)) { duplicates.push({ client: deal.client, offerSignedAt: deal.offerSignedAt }); continue; }
        seen.add(key);
        ready.push({ ...deal, source: "offplatform" });
      }

      const preview = {
        ok: true,
        wouldImport: ready.length,
        duplicates: duplicates.length,
        skipped: result.skipped,
        invalid,
        deals: ready,
        totalCents: ready.reduce((total, deal) => total + deal.dealSizeCents, 0),
      };

      if (parsed.body.confirm !== true) return privateJson(res, 200, { ...preview, committed: false });

      if (ready.length) await write(ready);
      await logAudit({
        at: stamp, who: actor, action: "import", dealId: null,
        before: null,
        after: { imported: ready.length, duplicates: duplicates.length, skipped: result.skipped.length },
      });
      return privateJson(res, 200, { ...preview, committed: true, imported: ready.length });
    } catch (error) {
      console.error("revenue_import_failed", { error: String(error?.message || error) });
      return privateJson(res, 500, { ok: false, error: "import_failed" });
    }
  };
}

const handler = createImportHandler();
export default handler;
export { handler };
