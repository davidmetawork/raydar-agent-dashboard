import { cors, requirePrepAuth, storeConfigured, hasCookie } from "./_lib/core.mjs";
import { trpcGet } from "../seq/_lib/core.mjs";
import { searchCandidates } from "./_lib/candidate-search-core.mjs";

// GET ?q=<term>&limit=8 (Google session) -> { ok, query, results:[identity cards] }
// Served directly with the dashboard's Paraform session (same credential the
// roles dropdown uses) so the picker works independently of the Fly runner.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requirePrepAuth(req, res))) return;
  if (!hasCookie()) return res.status(503).json({ ok: false, error: "no_cookie" });
  try {
    const payload = await searchCandidates(req.query?.q, {
      trpcGet,
      limit: req.query?.limit,
    });
    return res.status(200).json({ ok: true, ...payload });
  } catch (e) {
    if (e?.code === "AUTH_EXPIRED") {
      return res.status(503).json({ ok: false, error: "paraform_session_expired" });
    }
    return res.status(502).json({ ok: false, error: "search_failed", detail: String(e.message || e).slice(0, 200) });
  }
}
