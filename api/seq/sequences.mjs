import { cors, requireAuth, hasCookie, listSequences } from "./_lib/core.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  if (!hasCookie()) return res.status(200).json({ ok: false, error: "no_cookie", sequences: [] });
  try {
    res.status(200).json({ ok: true, sequences: await listSequences() });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 160), sequences: [] });
  }
}
