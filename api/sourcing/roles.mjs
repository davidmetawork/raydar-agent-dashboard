import { cors, listSourcingRoles, requireSourcingAccess } from "./_lib/core.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!(await requireSourcingAccess(req, res))) return;
  try {
    const roles = await listSourcingRoles();
    return res.status(200).json({ ok: true, roles, count: roles.length });
  } catch (error) {
    const expired = error?.code === "AUTH_EXPIRED";
    return res.status(expired ? 503 : 500).json({
      ok: false,
      error: expired ? "paraform_session_expired" : "roles_unavailable",
      detail: String(error?.message || error).slice(0, 160),
    });
  }
}
