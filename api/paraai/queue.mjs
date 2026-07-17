import { cors, requireAuth } from "./_lib/core.mjs";
import { listJobs, storeConfigured } from "./_lib/store.mjs";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!(await requireAuth(req, res))) return;
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  try {
    const jobs = await listJobs(Number(req.query?.limit || 200));
    const groups = {
      readyToSubmit: jobs.filter((job) => ["ready_to_submit", "needs_identity_review"].includes(job.state)),
      awaiting: jobs.filter((job) => ["submitting", "awaiting_approval", "awaiting_matches", "ready_to_enroll", "ensuring_email", "enrolling", "verifying", "no_email"].includes(job.state)),
      needsReview: jobs.filter((job) => job.state === "needs_review"),
      enrolled: jobs.filter((job) => job.state === "enrolled"),
      errors: jobs.filter((job) => job.state === "error"),
    };
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, generatedAt: new Date().toISOString(), jobs, groups });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "queue_failed", detail: String(error?.message || error).slice(0, 220) });
  }
}
