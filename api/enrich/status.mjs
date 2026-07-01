import { cors, requireAuth, fullenrichConfigured, getEnrichment } from "./_lib/core.mjs";

// GET ?id=<enrichmentId> → polls FullEnrich and returns normalized per-candidate results.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  if (!fullenrichConfigured()) return res.status(200).json({ ok: false, error: "no_fullenrich_key" });
  const id = req.query?.id || (typeof req.url === "string" ? new URL(req.url, "http://x").searchParams.get("id") : null);
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  try {
    const r = await getEnrichment(id);
    res.status(200).json({ ok: true, ...r });
  } catch (e) {
    res.status(200).json({ ok: false, error: "error", detail: String(e.message || e).slice(0, 200) });
  }
}
