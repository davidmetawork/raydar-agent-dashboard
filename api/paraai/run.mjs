import { cors, notifySlack, requireAuth } from "./_lib/core.mjs";
import { enrollJob, loadJob, prepareJob, refreshMatches, submitJob } from "./_lib/pipeline.mjs";
import { acquireJobLock, releaseJobLock, storeConfigured, takeAlertSlot } from "./_lib/store.mjs";

export const config = { maxDuration: 120 };

const ACTIONS = new Set(["prepare", "submit", "refresh-matches", "enroll", "no-match-enroll"]);
const ALERT_CODES = new Set([
  "AUTH_EXPIRED", "SUBMIT_WRITE_FAILED", "SUBMIT_NOT_VISIBLE", "ENROLL_WRITE_FAILED",
  "ENROLL_NOT_VISIBLE", "GLOBAL_EMAIL_NOT_VISIBLE", "LEAD_EMAIL_NOT_VISIBLE",
  "LIFECYCLE_REGISTRATION_FAILED", "NO_EMAIL",
]);

const statusFor = (code) => {
  if (code === "JOB_NOT_FOUND") return 404;
  if (code === "REVISION_CONFLICT" || code === "INVALID_STATE") return 409;
  if (String(code || "").includes("APPROVAL") || String(code || "").startsWith("PHASE0") || code === "DRY_RUN" || code === "LIFECYCLE_REGISTRATION_REQUIRED") return 503;
  if (String(code || "").includes("WRITE_FAILED") || String(code || "").includes("NOT_VISIBLE") || code === "LIFECYCLE_REGISTRATION_FAILED") return 502;
  return 400;
};

async function alert(error, jobId) {
  const code = String(error?.code || "RUN_FAILED");
  if (!ALERT_CODES.has(code)) return;
  try {
    if (await takeAlertSlot(code === "AUTH_EXPIRED" ? "auth-expired" : `${code}:${jobId}`, code === "AUTH_EXPIRED" ? 12 * 3600 : 3600)) {
      await notifySlack(`🚨 Para AI: ${code} for job ${jobId || "unknown"} — ${String(error?.message || error).slice(0, 180)}. Review https://monitor.raydar.xyz/#paraai`);
    }
  } catch { /* the API response remains the primary, visible failure path */ }
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!(await requireAuth(req, res))) return;
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
  catch { return res.status(400).json({ ok: false, error: "invalid_json" }); }
  const action = String(body.action || "");
  if (!ACTIONS.has(action)) return res.status(400).json({ ok: false, error: "unsupported_action" });
  const jobId = String(body.jobId || body.botId || "").trim();
  if (!jobId) return res.status(400).json({ ok: false, error: "jobId_or_botId_required" });
  let lockToken = null;
  try {
    lockToken = await acquireJobLock(jobId);
    if (!lockToken) return res.status(409).json({ ok: false, error: "job_busy" });
    let job;
    if (action === "prepare") {
      job = await prepareJob({ botId: jobId, candidateUserId: body.candidateUserId, force: body.force === true });
    } else {
      job = await loadJob(jobId);
      if (body.expectedRevision != null && Number(body.expectedRevision) !== Number(job.revision)) {
        return res.status(409).json({ ok: false, error: "revision_conflict", job });
      }
      if (action === "submit") job = await submitJob(job, body);
      if (action === "refresh-matches") job = await refreshMatches(job);
      if (action === "enroll") job = await enrollJob(job, body);
      if (action === "no-match-enroll") job = await enrollJob(job, body, { noMatch: true });
    }
    return res.status(200).json({ ok: true, job });
  } catch (error) {
    await alert(error, jobId);
    return res.status(statusFor(error?.code)).json({
      ok: false,
      error: error?.code || "run_failed",
      detail: String(error?.message || error).slice(0, 300),
      job: error?.job || null,
    });
  } finally {
    if (lockToken) await releaseJobLock(jobId, lockToken).catch(() => {});
  }
}
