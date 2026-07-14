import { cors, requireAuth, hasCookie, fullenrichConfigured, findEmaillessCandidates, startEnrichment, toEnrichFields, FE_BULK_MAX } from "./_lib/core.mjs";
import { contactoutConfigured, usableLinkedinUrl, toCoEmailType, coStartBatch, CO_BATCH_MAX } from "./_lib/contactout.mjs";

// POST { sequenceId, fields, limit? } → kicks off the enrichment WATERFALL for the
// sequence's emailless leads:
//   stage 1 (cheap)  — ContactOut, for every lead with a usable linkedin.com/in|pub URL
//   stage 2 (pricey) — FullEnrich, fired by the page (via /api/enrich/fe-start) for
//                      ContactOut's misses + leads with no usable LinkedIn URL
// Degrades honestly: no ContactOut key → straight-to-FullEnrich exactly as before;
// no FullEnrich key → ContactOut only, stage-2 pool surfaced as unresolved.
// `limit` (optional int) caps how many candidates enter the run — a cautious-first-run
// / testing knob; the cut is reported in `limited`, never silent.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!hasCookie()) return res.status(200).json({ ok: false, error: "no_cookie" });
  if (!contactoutConfigured() && !fullenrichConfigured()) {
    return res.status(200).json({ ok: false, error: "no_provider_keys" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const sequenceId = body.sequenceId;
    if (!sequenceId) return res.status(400).json({ ok: false, error: "sequenceId required" });
    const fields = body.fields;
    const enrichFields = toEnrichFields(fields); // FullEnrich field names

    const { sequence, totalLeads, toEnrich, onFile, skipped } = await findEmaillessCandidates(sequenceId);
    const limit = Number.isInteger(body.limit) && body.limit > 0 ? body.limit : null;
    const pool = limit ? toEnrich.slice(0, limit) : toEnrich;
    const limited = toEnrich.length - pool.length;

    const slim = (c) => ({ cuid: c.cuid, ctcuid: c.ctcuid, name: c.name, firstName: c.firstName, lastName: c.lastName, linkedinUrl: c.linkedinUrl, company: c.company });
    const onFileOut = onFile.map((c) => ({ ...slim(c), email: c.email }));
    const base = { ok: true, sequence, totalLeads, emailless: toEnrich.length + onFile.length, skipped, limited, onFile: onFileOut };

    if (!pool.length) {
      return res.status(200).json({ ...base, provider: null, candidates: [], enrichmentId: null, note: onFile.length ? "" : "No emailless candidates." });
    }

    // ---- stage-1 split: ContactOut takes everyone with a usable LinkedIn URL ----
    const coPool = [], fePool = [];
    for (const c of pool) {
      const url = contactoutConfigured() ? usableLinkedinUrl(c.linkedinUrl) : null;
      if (url) coPool.push({ ...c, linkedinUrl: url });
      else fePool.push(c);
    }

    let coSkipped = null; // set when ContactOut was wanted but its submit failed → FE takes everyone
    if (coPool.length) {
      try {
        const { jobId, submitted } = await coStartBatch(coPool.map((c) => c.linkedinUrl), {
          emailType: toCoEmailType(fields),
          includePhone: Array.isArray(fields) && fields.includes("phone"),
        });
        return res.status(200).json({
          ...base,
          provider: "contactout",
          coJobId: jobId,
          coSubmitted: submitted,
          coOverflow: Math.max(0, coPool.length - CO_BATCH_MAX),
          coCandidates: coPool.map(slim),
          feCandidates: fePool.map(slim), // joins stage 2 alongside ContactOut misses
        });
      } catch (e) {
        // CO submit died (out of credits / API error). Don't dead-end the run if the
        // fallback provider exists — degrade to FullEnrich for the WHOLE pool, loudly.
        if (!fullenrichConfigured()) throw e;
        coSkipped = e.code === "CO_OUT_OF_CREDITS" ? "out_of_credits" : String(e.message || e).slice(0, 120);
        fePool.unshift(...coPool);
      }
    }

    // ---- FullEnrich directly (no CO key, zero usable URLs, or CO submit failed) ----
    if (!fullenrichConfigured()) return res.status(200).json({ ...base, ok: false, error: "no_fullenrich_key" });
    const batch = fePool.slice(0, FE_BULK_MAX);
    const { enrichmentId, submitted } = await startEnrichment(`Raydar · ${sequence}`, batch, enrichFields);
    return res.status(200).json({
      ...base,
      provider: "fullenrich",
      coSkipped,
      enrichmentId, submitted,
      overflow: Math.max(0, fePool.length - FE_BULK_MAX),
      candidates: batch.map(slim),
    });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    const co403 = e.code === "CO_OUT_OF_CREDITS";
    res.status(200).json({ ok: false, error: expired ? "expired" : co403 ? "co_out_of_credits" : "error", detail: String(e.message || e).slice(0, 200) });
  }
}
