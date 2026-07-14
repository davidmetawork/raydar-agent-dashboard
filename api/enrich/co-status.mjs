import { cors, requireAuth } from "./_lib/core.mjs";
import { contactoutConfigured, coGetBatch } from "./_lib/contactout.mjs";

// GET ?id=<jobId> → polls the ContactOut v2 batch job. Results come back keyed by
// the exact LinkedIn URL we submitted; the page maps URL → candidate.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  if (!contactoutConfigured()) return res.status(200).json({ ok: false, error: "no_contactout_key" });
  const id = req.query?.id || (typeof req.url === "string" ? new URL(req.url, "http://x").searchParams.get("id") : null);
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  try {
    const r = await coGetBatch(id);
    res.status(200).json({ ok: true, ...r });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.code || "error", detail: String(e.message || e).slice(0, 200) });
  }
}
