import { cors, getRoleWorkspace, requireSourcingAccess } from "./_lib/core.mjs";

const ROLE_ID = /^[a-zA-Z0-9_-]{6,80}$/;

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!(await requireSourcingAccess(req, res))) return;
  const query = req.query || (typeof req.url === "string" ? Object.fromEntries(new URL(req.url, "http://local").searchParams) : {});
  const roleId = String(query.roleId || "").trim();
  if (!ROLE_ID.test(roleId)) return res.status(400).json({ ok: false, error: "valid roleId required" });
  try {
    return res.status(200).json({ ok: true, ...(await getRoleWorkspace(roleId)) });
  } catch (error) {
    const expired = error?.code === "AUTH_EXPIRED";
    return res.status(expired ? 503 : 500).json({
      ok: false,
      error: expired ? "paraform_session_expired" : "role_unavailable",
      detail: String(error?.message || error).slice(0, 160),
    });
  }
}
