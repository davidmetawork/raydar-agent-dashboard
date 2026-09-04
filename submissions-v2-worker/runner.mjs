import { effectiveControls, environmentControls } from "../api/submissions-v2/_lib/config.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safe = (value, limit = 400) => String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, limit);

export const JOB_CONTROLS = Object.freeze({
  index_candidates: "ingestion",
  index_roles: "ingestion",
  reconcile_master_inbox: "master_inbox",
  reconcile_sequence_inbox: "master_inbox",
  reconcile_curated: "curated",
  classify_email_reply: "master_inbox",
  prepare_resume: "generation",
  recheck_pair: "ingestion",
  proof_reconcile: "ingestion",
  deliver_notification: "ingestion",
  source_health: "ingestion",
  daily_digest: "ingestion",
  purge: "always",
});

function enabledKinds(controls) {
  return Object.entries(JOB_CONTROLS).filter(([, control]) => control === "always" || controls[control]).map(([kind]) => kind);
}

export async function runClaimedJob(job, {
  workerId,
  controlEpoch,
  handlers,
  completeJob,
  failJob,
  checkpointJob,
  heartbeatJob = null,
  timeoutMs = 295_000,
  heartbeatMs = 60_000,
  scheduleHeartbeat = setInterval,
  cancelHeartbeat = clearInterval,
}) {
  const handler = handlers[job.kind];
  if (typeof handler !== "function") {
    await failJob({ jobId: job.id, workerId, fencingToken: job.fencing_token, controlEpoch, errorCode: "unknown_job_kind", safeError: "Worker does not support this job kind.", retry: false, checkpoint: job.checkpoint || {} });
    return { id: job.id, state: "failed", error: "unknown_job_kind" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("job_deadline_exceeded")), timeoutMs);
  let heartbeatFailure = null;
  const heartbeat = typeof heartbeatJob === "function" ? scheduleHeartbeat(async () => {
    try {
      const current = await heartbeatJob({ jobId: job.id, workerId, fencingToken: job.fencing_token, controlEpoch, leaseSeconds: 300 });
      if (current === null) {
        heartbeatFailure = Object.assign(new Error("Worker lease or runtime control changed."), { code: "execution_fence_lost", retryable: false });
        controller.abort(heartbeatFailure);
      }
    } catch (error) {
      heartbeatFailure = Object.assign(new Error("Worker lease heartbeat failed."), { code: error?.code || "execution_heartbeat_failed" });
      controller.abort(heartbeatFailure);
    }
  }, Math.max(15_000, heartbeatMs)) : null;
  heartbeat?.unref?.();
  try {
    const context = {
      job,
      workerId,
      fencingToken: Number(job.fencing_token),
      controlEpoch,
      signal: controller.signal,
      checkpoint: async (value) => {
        const current = await checkpointJob({ jobId: job.id, workerId, fencingToken: job.fencing_token, controlEpoch, checkpoint: value });
        if (current === null || current?.state === "held") {
          throw Object.assign(new Error("Worker lease or runtime control changed."), { code: "execution_fence_lost", retryable: false, checkpoint: value });
        }
        return current;
      },
    };
    const result = await handler(context);
    if (controller.signal.aborted) throw heartbeatFailure || controller.signal.reason || new Error("job_deadline_exceeded");
    const completed = await completeJob({ jobId: job.id, workerId, fencingToken: job.fencing_token, controlEpoch, checkpoint: result?.checkpoint || job.checkpoint || {} });
    if (completed === null || completed?.state === "held") return { id: job.id, state: "held", error: "execution_fence_lost" };
    return { id: job.id, state: "succeeded" };
  } catch (error) {
    const nextAttempt = Number(job.attempt_count || 0);
    const maxAttempts = Number(job.max_attempts || 3);
    const retryable = error?.retryable !== false && nextAttempt < maxAttempts;
    await failJob({
      jobId: job.id,
      workerId,
      fencingToken: job.fencing_token,
      controlEpoch,
      errorCode: safe(error?.code || heartbeatFailure?.code || (controller.signal.aborted ? "job_deadline_exceeded" : "job_failed"), 100),
      safeError: safe(error?.safeMessage || error?.message || "Job failed safely."),
      retry: retryable,
      retryDelaySeconds: Math.min(3600, 15 * Math.max(1, nextAttempt) ** 2),
      checkpoint: error?.checkpoint || job.checkpoint || {},
    });
    return { id: job.id, state: retryable ? "retry" : "failed", error: safe(error?.code || heartbeatFailure?.code || "job_failed", 100) };
  } finally {
    clearTimeout(timer);
    if (heartbeat) cancelHeartbeat(heartbeat);
  }
}

export async function workerCycle({
  workerId,
  readRuntimeControls,
  claimJobs,
  handlers,
  completeJob,
  failJob,
  checkpointJob,
  heartbeatJob,
  scheduleJobs = null,
  env = process.env,
  limit = 4,
}) {
  const durable = await readRuntimeControls();
  const controls = effectiveControls(environmentControls(env), durable);
  if (!controls.readable) return { ok: false, held: "controls_unavailable", jobs: [] };
  const kinds = enabledKinds(controls);
  if (!kinds.length) return { ok: true, held: "all_controls_disabled", control_epoch: controls.control_epoch, jobs: [] };
  if (typeof scheduleJobs === "function") await scheduleJobs();
  const jobs = await claimJobs({ workerId, kinds, limit, leaseSeconds: 300, controlEpoch: controls.control_epoch });
  const results = [];
  for (const job of jobs) results.push(await runClaimedJob(job, { workerId, controlEpoch: controls.control_epoch, handlers, completeJob, failJob, checkpointJob, heartbeatJob }));
  return { ok: results.every((row) => row.state === "succeeded"), control_epoch: controls.control_epoch, jobs: results };
}

export async function runWorkerLoop(options, { idleMs = 2_000, errorMs = 10_000, signal, cycleImpl = workerCycle } = {}) {
  while (!signal?.aborted) {
    try {
      const result = await cycleImpl(options);
      if (!result.jobs?.length) await sleep(idleMs);
    } catch {
      await sleep(errorMs);
    }
  }
}
