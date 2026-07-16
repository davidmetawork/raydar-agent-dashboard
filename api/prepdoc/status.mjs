import { cors, indexIds, loadJobs, requirePrepAuth, storeConfigured } from "./_lib/core.mjs";

// GET (Google auth) -> { ok:true, jobs:[...] }: the newest 50 job records,
// newest first. Job records never contain PDF payloads (see report.mjs).
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requirePrepAuth(req, res))) return;
  try {
    const ids = (await indexIds()).slice(0, 50);
    const jobs = await loadJobs(ids);
    return res.status(200).json({ ok: true, jobs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "status_read_failed", detail: String(e.message || e).slice(0, 200) });
  }
}
