import { cors, requirePrepAuth, storeConfigured, hasCookie } from "./_lib/core.mjs";
import { BASE, headers, trpcGet } from "../seq/_lib/core.mjs";
import { searchCandidates } from "./_lib/candidate-search-core.mjs";

// Authed Paraform REST GET (not tRPC) — the active role pipeline lives at
// /role/{id}/user_applications, a plain REST route on the same origin/cookie.
async function restGet(path) {
  const r = await fetch(`${BASE}${path}`, { headers: headers(), signal: AbortSignal.timeout(20000) });
  if (r.status === 401) { const e = new Error("AUTH_EXPIRED"); e.code = "AUTH_EXPIRED"; throw e; }
  if (!r.ok) throw new Error(`rest ${r.status}`);
  return r.json();
}

// GET ?q=<term>&role_id=&limit=8 (Google session) -> { ok, query, roleScoped, results }
// Served with the dashboard's Paraform session. With a role selected, also
// scans that role's active pipeline so applicants (not just CRM/sourced
// candidates) are findable.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requirePrepAuth(req, res))) return;
  if (!hasCookie()) return res.status(503).json({ ok: false, error: "no_cookie" });
  try {
    const payload = await searchCandidates(req.query?.q, {
      trpcGet,
      restGet,
      limit: req.query?.limit,
      roleId: req.query?.role_id,
    });
    return res.status(200).json({ ok: true, ...payload });
  } catch (e) {
    if (e?.code === "AUTH_EXPIRED") {
      return res.status(503).json({ ok: false, error: "paraform_session_expired" });
    }
    return res.status(502).json({ ok: false, error: "search_failed", detail: String(e.message || e).slice(0, 200) });
  }
}
