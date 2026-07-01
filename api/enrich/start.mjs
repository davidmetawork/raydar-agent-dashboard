import { cors, requireAuth, hasCookie, fullenrichConfigured, findEmaillessCandidates, startEnrichment, toEnrichFields, FE_BULK_MAX } from "./_lib/core.mjs";

// POST { sequenceId } → finds emailless candidates in the sequence and kicks off a
// FullEnrich bulk lookup. Returns the enrichment id to poll + the candidate list.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!hasCookie()) return res.status(200).json({ ok: false, error: "no_cookie" });
  if (!fullenrichConfigured()) return res.status(200).json({ ok: false, error: "no_fullenrich_key" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const sequenceId = body.sequenceId;
    if (!sequenceId) return res.status(400).json({ ok: false, error: "sequenceId required" });
    const enrichFields = toEnrichFields(body.fields); // which of personal/work/phone to look up

    const { sequence, totalLeads, toEnrich, onFile, skipped } = await findEmaillessCandidates(sequenceId);
    const onFileOut = onFile.map((c) => ({ cuid: c.cuid, ctcuid: c.ctcuid, name: c.name, linkedinUrl: c.linkedinUrl, company: c.company, email: c.email }));

    if (!toEnrich.length) {
      // nothing to look up — either fully covered, or only on-file emails to copy across
      return res.status(200).json({
        ok: true, sequence, totalLeads, emailless: onFile.length, skipped,
        onFile: onFileOut, candidates: [], enrichmentId: null,
        note: onFile.length ? "" : "No emailless candidates.",
      });
    }
    const batch = toEnrich.slice(0, FE_BULK_MAX);
    const { enrichmentId, submitted } = await startEnrichment(`Raydar · ${sequence}`, batch, enrichFields);
    res.status(200).json({
      ok: true, sequence, totalLeads,
      emailless: toEnrich.length + onFile.length, submitted, skipped,
      overflow: Math.max(0, toEnrich.length - FE_BULK_MAX),
      enrichmentId,
      onFile: onFileOut,
      candidates: batch.map((c) => ({ cuid: c.cuid, ctcuid: c.ctcuid, name: c.name, linkedinUrl: c.linkedinUrl, company: c.company })),
    });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 200) });
  }
}
