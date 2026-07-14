import { cors, requireAuth, hasCookie, fullenrichConfigured, findEmaillessCandidates, startEnrichment, toEnrichFields, FE_BULK_MAX } from "./_lib/core.mjs";

// POST { sequenceId, cuids:[...], fields }
// Stage 2 of the waterfall: FullEnrich for the candidates ContactOut couldn't find,
// plus leads with no usable LinkedIn URL. The page calls this automatically once the
// ContactOut job completes.
//
// SECURITY: the client sends only candidate IDs — the actual enrichment inputs
// (name/company/LinkedIn) are re-derived server-side from the sequence's live
// emailless leads. A caller can therefore only ever spend credits on genuinely
// emailless leads of a real sequence, never on an arbitrary supplied list.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!hasCookie()) return res.status(200).json({ ok: false, error: "no_cookie" });
  if (!fullenrichConfigured()) return res.status(200).json({ ok: false, error: "no_fullenrich_key" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const sequenceId = body.sequenceId;
    const cuids = Array.isArray(body.cuids) ? body.cuids.filter((x) => typeof x === "string" && x) : [];
    if (!sequenceId || !cuids.length) return res.status(400).json({ ok: false, error: "sequenceId and cuids required" });

    const { sequence, toEnrich } = await findEmaillessCandidates(sequenceId);
    const want = new Set(cuids);
    const pool = toEnrich.filter((c) => want.has(c.cuid));
    const unknown = cuids.length - pool.length; // ids not (or no longer) emailless in this sequence
    if (!pool.length) return res.status(200).json({ ok: true, enrichmentId: null, submitted: 0, unknown, note: "none of the requested candidates are still emailless in this sequence" });

    const batch = pool.slice(0, FE_BULK_MAX);
    const { enrichmentId, submitted } = await startEnrichment(`Raydar · ${sequence || "enrich"} (fallback)`, batch, toEnrichFields(body.fields));
    res.status(200).json({
      ok: true, enrichmentId, submitted, unknown,
      overflow: Math.max(0, pool.length - FE_BULK_MAX),
    });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 200) });
  }
}
