import {
  cors, getJob, JOB_ID_RE, JOB_STATUSES, requireRunnerKey, saveJob, storeConfigured, storePdf,
} from "./_lib/core.mjs";

// POST (x-runner-key) { id, status, reason?, history_append?, pdf_base64?,
//                       pdf_filename?, draft_id?, thread_mode? } -> { ok:true }
// The runner's status-report channel. A supplied pdf_base64 is stored under
// prepdoc:pdf:<id> (30-day TTL) and NEVER kept on the job record itself.
const cleanStr = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!requireRunnerKey(req, res)) return;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const id = cleanStr(body.id, 64);
    if (!JOB_ID_RE.test(id)) return res.status(400).json({ ok: false, error: "valid id required" });
    const status = cleanStr(body.status, 20);
    if (!JOB_STATUSES.includes(status)) {
      return res.status(400).json({ ok: false, error: "status must be one of: " + JOB_STATUSES.join(", ") });
    }
    const job = await getJob(id);
    if (!job) return res.status(404).json({ ok: false, error: "job_not_found" });

    const now = new Date().toISOString();
    job.status = status;
    const reason = cleanStr(body.reason, 1000);
    if (reason) job.reason = reason;
    const pdfFilename = cleanStr(body.pdf_filename, 140);
    if (pdfFilename) job.pdf_filename = pdfFilename;
    const draftId = cleanStr(body.draft_id, 200);
    if (draftId) job.draft_id = draftId;
    const threadMode = cleanStr(body.thread_mode, 40);
    if (threadMode) job.thread_mode = threadMode;

    const note = cleanStr(body.history_append, 500);
    job.history = [
      ...(Array.isArray(job.history) ? job.history : []),
      { at: now, status, ...(note ? { note } : {}) },
    ].slice(-50);

    if (typeof body.pdf_base64 === "string" && body.pdf_base64) {
      const b64 = body.pdf_base64.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) {
        return res.status(400).json({ ok: false, error: "pdf_base64 is not valid base64" });
      }
      await storePdf(id, b64);
      job.has_pdf = true; // payload lives under its own key, never on the record
    }

    await saveJob(job);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "report_failed", detail: String(e.message || e).slice(0, 200) });
  }
}
