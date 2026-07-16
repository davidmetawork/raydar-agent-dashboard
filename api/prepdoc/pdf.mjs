import { cors, getJob, getPdf, JOB_ID_RE, requirePrepAuth, storeConfigured } from "./_lib/core.mjs";

// GET ?id=<jobId> (Google auth) -> the stored PDF as application/pdf,
// content-disposition attachment. 404 when no PDF is stored (never was, or
// the 30-day TTL expired). The page fetches this with the Authorization
// header and hands the blob to the browser as a download.
const queryOf = (req) => req.query ||
  (typeof req.url === "string" ? Object.fromEntries(new URL(req.url, "http://local").searchParams) : {});

function safeFilename(name, id) {
  const base = String(name || "").replace(/[^\w.-]+/g, "_").replace(/^[_.]+|[_.]+$/g, "").slice(0, 100);
  const chosen = base || `prep-${String(id).slice(0, 8)}`;
  return chosen.toLowerCase().endsWith(".pdf") ? chosen : chosen + ".pdf";
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requirePrepAuth(req, res))) return;
  try {
    const id = String(queryOf(req).id || "").trim();
    if (!JOB_ID_RE.test(id)) return res.status(400).json({ ok: false, error: "valid id required" });
    const [job, b64] = await Promise.all([getJob(id), getPdf(id)]);
    if (!b64) return res.status(404).json({ ok: false, error: "pdf_not_found" });
    const buf = Buffer.from(b64, "base64");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(job && job.pdf_filename, id)}"`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "pdf_read_failed", detail: String(e.message || e).slice(0, 200) });
  }
}
