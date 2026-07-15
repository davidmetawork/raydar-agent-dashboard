import {
  cors,
  hasCookie,
  listSourcingProjects,
  listSourcingSequences,
  requireSourcingAuth,
} from "./_lib/core.mjs";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!(await requireSourcingAuth(req, res))) return;
  if (!hasCookie()) return res.status(503).json({ ok: false, error: "no_cookie" });
  try {
    const [projects, sequences] = await Promise.all([listSourcingProjects(), listSourcingSequences()]);
    return res.status(200).json({ ok: true, projects, sequences });
  } catch (error) {
    const expired = error?.code === "AUTH_EXPIRED";
    return res.status(expired ? 503 : 500).json({
      ok: false,
      error: expired ? "paraform_session_expired" : "options_unavailable",
      detail: String(error?.message || error).slice(0, 160),
    });
  }
}
