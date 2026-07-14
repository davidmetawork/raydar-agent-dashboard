import { cors, requireAuth, fullenrichConfigured, getEnrichment } from "./_lib/core.mjs";
import { contactoutConfigured, coGetBatch } from "./_lib/contactout.mjs";

// GET ?id=<jobId>&provider=co|fe  → polls the given provider's job.
// (One handler for both providers — the dashboard project sits on Vercel's Hobby
//  12-function cap, so endpoints consolidate instead of multiplying.)
//   provider=co → ContactOut v2 batch job; results keyed by the submitted LinkedIn URL
//   provider=fe (default) → FullEnrich bulk enrichment
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  const q = req.query || (typeof req.url === "string" ? Object.fromEntries(new URL(req.url, "http://x").searchParams) : {});
  const id = q.id;
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  try {
    if (q.provider === "co") {
      if (!contactoutConfigured()) return res.status(200).json({ ok: false, error: "no_contactout_key" });
      const r = await coGetBatch(id);
      return res.status(200).json({ ok: true, ...r });
    }
    if (!fullenrichConfigured()) return res.status(200).json({ ok: false, error: "no_fullenrich_key" });
    const r = await getEnrichment(id);
    res.status(200).json({ ok: true, ...r });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.code || "error", detail: String(e.message || e).slice(0, 200) });
  }
}
