import { cors, indexIds, loadJobs, requireRunnerKey, storeConfigured } from "./_lib/core.mjs";

// GET (x-runner-key) -> { ok:true, jobs:[...] }: up to 3 jobs still in
// status "queued", OLDEST first, full records so the runner needs no second
// read. The runner marks a job "claimed" via /api/prepdoc/report before
// working it; this endpoint never mutates.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!requireRunnerKey(req, res)) return;
  try {
    const ids = await indexIds(); // newest first
    const jobs = await loadJobs(ids);
    const queued = jobs.filter((j) => j.status === "queued").reverse().slice(0, 3); // oldest first
    return res.status(200).json({ ok: true, jobs: queued });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "queue_read_failed", detail: String(e.message || e).slice(0, 200) });
  }
}
