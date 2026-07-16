import { cors, hasCookie, listPrepRoles, requirePrepAuth, storeConfigured } from "./_lib/core.mjs";

// GET (Google auth) -> { ok:true, roles:[{ role_id, title, company }] }
// Active Paraform roles for the picker. Reuses the sourcing lib's cached,
// rate-limited activeRoles read, wrapped in prepdoc's own 30-minute cache
// (prepdoc:roles-cache).
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requirePrepAuth(req, res))) return;
  if (!hasCookie()) return res.status(503).json({ ok: false, error: "no_cookie" });
  try {
    const roles = await listPrepRoles();
    return res.status(200).json({ ok: true, roles, count: roles.length });
  } catch (e) {
    const expired = e?.code === "AUTH_EXPIRED";
    const limited = e?.code === "ROLE_RATE_LIMIT";
    return res.status(limited ? 429 : expired ? 503 : 500).json({
      ok: false,
      error: limited ? "paraform_role_read_limited" : expired ? "paraform_session_expired" : "roles_unavailable",
      detail: String(e?.message || e).slice(0, 160),
    });
  }
}
