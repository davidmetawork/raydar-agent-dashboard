import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { checkpointJob, claimJobs, completeJob, database, failJob, heartbeatJob, readRuntimeControls } from "../api/submissions-v2/_lib/db.mjs";
import { effectiveControls, environmentControls } from "../api/submissions-v2/_lib/config.mjs";
import { enabledJobKinds, runWorkerCycleWithProgress, runWorkerLoop } from "./runner.mjs";
import { createWorkerHandlers } from "./worker-handlers.mjs";
import { createRepository } from "../api/submissions-v2/_lib/repository.mjs";
import { createService } from "../api/submissions-v2/_lib/service.mjs";
import { createResumePipelineStore } from "../api/submissions-v2/_lib/resume/pipeline-store.mjs";
import { createBlobBrokerClient } from "./blob-broker-client.mjs";
import { submissionsV2ReleaseManifest } from "../api/submissions-v2/_lib/release-manifest.mjs";
import {
  createWorkerProgressStore,
  livenessSnapshot,
  safeWorkerErrorClass,
  unavailableReadiness,
} from "./worker-progress.mjs";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw Object.assign(new Error(`${name} is required for the isolated Submissions V2 worker.`), { code: `${name.toLowerCase()}_required` });
  return value;
}

const workerEnv = {
  ...process.env,
  SUBMISSIONS_V2_DATABASE_URL: required("SUBMISSIONS_V2_WORKER_DATABASE_URL"),
  SUBMISSIONS_V2_BLOB_BROKER_URL: required("SUBMISSIONS_V2_BLOB_BROKER_URL"),
  SUBMISSIONS_V2_BLOB_BROKER_KEY: required("SUBMISSIONS_V2_BLOB_BROKER_KEY"),
};
// The shared read-only Paraform adapter reads these process-local names; the
// isolated worker maps only its dedicated V2 credential and disables n8n fallback.
process.env.PARAFORM_SESSION_COOKIE = required("SUBMISSIONS_V2_PARAFORM_SESSION_COOKIE");
process.env.PARAFORM_COOKIE = "";
process.env.N8N_BASE_URL = "";
process.env.N8N_API_KEY = "";
if (process.env.SUBMISSIONS_V2_PARAFORM_SESSION_COOKIE_NAME) {
  process.env.PARAFORM_SESSION_COOKIE_NAME = process.env.SUBMISSIONS_V2_PARAFORM_SESSION_COOKIE_NAME;
}

const workerSql = database(workerEnv);
const workerRepository = createRepository({ sql: workerSql, env: workerEnv });
const workerBlobs = createBlobBrokerClient({ env: workerEnv });
const workerService = createService({ repository: workerRepository, env: workerEnv, blob: workerBlobs });
const workerResumeStore = createResumePipelineStore({ sql: workerSql, repository: workerRepository, env: workerEnv, blobs: workerBlobs });
const handlers = createWorkerHandlers({
  env: workerEnv, sql: workerSql, repository: workerRepository,
  service: workerService, resumeStore: workerResumeStore,
});

const workerId = process.env.SUBMISSIONS_V2_WORKER_ID || `worker-${randomUUID()}`;
const port = Math.max(1, Number(process.env.PORT) || 8080);
const controller = new AbortController();
const processStartedAt = new Date();
const schedulerEnabled = workerEnv.SUBMISSIONS_V2_SCHEDULER_ENABLED !== "false";
const progress = createWorkerProgressStore({
  sql: workerSql,
  workerId,
  processStartedAt,
});
const options = {
  workerId,
  // Handlers are executed sequentially, and a Curated batch can legitimately
  // run for several minutes; claim only the job being actively heartbeated so
  // later work never ages behind it with an unused lease.
  limit: 1,
  handlers,
  env: workerEnv,
  readRuntimeControls: () => readRuntimeControls(workerSql),
  claimJobs: (input) => claimJobs(input, workerSql),
  completeJob: (input) => completeJob(input, workerSql),
  failJob: (input) => failJob(input, workerSql),
  checkpointJob: (input) => checkpointJob(input, workerSql),
  heartbeatJob: (input) => heartbeatJob(input, workerSql),
  scheduleJobs: schedulerEnabled ? () => workerService.tick({ recoverResumes: true }) : null,
};
let lastCycle = null;
let cycleRunning = false;
const processProgress = {
  lastAttemptedCycleAt: null,
  lastSuccessfulCycleAt: null,
  lastErrorClass: null,
};
const { schema_version, algorithm, digest, file_count } = submissionsV2ReleaseManifest();
const release = { schema_version, algorithm, digest, file_count };

function equal(left, right) {
  const a = Buffer.from(String(left || "")); const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

const strongSecret = (value) => Buffer.byteLength(String(value || "").trim(), "utf8") >= 32;

async function cycle() {
  if (cycleRunning) return lastCycle;
  cycleRunning = true;
  processProgress.lastAttemptedCycleAt = new Date().toISOString();
  try {
    lastCycle = await runWorkerCycleWithProgress(options, { progress });
    if (lastCycle?.ok !== false) {
      processProgress.lastSuccessfulCycleAt = new Date().toISOString();
      processProgress.lastErrorClass = null;
    } else {
      processProgress.lastErrorClass = safeWorkerErrorClass(
        lastCycle?.jobs?.find((row) => row.state !== "succeeded")?.error || lastCycle?.held,
      );
    }
    return lastCycle;
  } catch (error) {
    processProgress.lastErrorClass = safeWorkerErrorClass(error);
    throw error;
  }
  finally { cycleRunning = false; }
}

function live() {
  return livenessSnapshot({ workerId, processStartedAt, cycleRunning, release });
}

async function ready() {
  try {
    const durable = await readRuntimeControls(workerSql);
    const controls = effectiveControls(environmentControls(workerEnv), durable);
    const result = await progress.readReadiness({
      enabledKinds: enabledJobKinds(controls),
      staleAfterMs: Math.max(30_000, Number(workerEnv.SUBMISSIONS_V2_WORKER_READY_MAX_AGE_SECONDS || 420) * 1000),
    });
    const operationalControlsEnabled = Boolean(
      controls.ingestion || controls.generation || controls.master_inbox || controls.curated,
    );
    return {
      ...result,
      operating_mode: !operationalControlsEnabled
        ? "paused"
        : schedulerEnabled ? "scheduled" : "manual",
      scheduler_enabled: schedulerEnabled,
      controls: {
        readable: controls.readable,
        control_epoch: controls.control_epoch,
        ingestion: controls.ingestion,
        generation: controls.generation,
        master_inbox: controls.master_inbox,
        curated: controls.curated,
      },
      release,
    };
  } catch (error) {
    return {
      ...unavailableReadiness(error, {
        workerId,
        processStartedAt,
        cycleRunning,
        ...processProgress,
      }),
      operating_mode: schedulerEnabled ? "scheduled" : "manual",
      scheduler_enabled: schedulerEnabled,
      release,
    };
  }
}

createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  if (req.url === "/live" && req.method === "GET") {
    res.statusCode = 200; res.end(JSON.stringify(live())); return;
  }
  if ((req.url === "/ready" || req.url === "/health") && req.method === "GET") {
    const readiness = await ready();
    res.statusCode = readiness.ready ? 200 : 503;
    res.end(JSON.stringify(req.url === "/health"
      ? { ok: readiness.ready, liveness: live(), readiness }
      : readiness));
    return;
  }
  if (req.url === "/tick" && req.method === "POST") {
    const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!strongSecret(process.env.SUBMISSIONS_V2_WORKER_KEY) || !equal(supplied, process.env.SUBMISSIONS_V2_WORKER_KEY)) { res.statusCode = strongSecret(process.env.SUBMISSIONS_V2_WORKER_KEY) ? 401 : 503; res.end(JSON.stringify({ ok: false, error: strongSecret(process.env.SUBMISSIONS_V2_WORKER_KEY) ? "worker_auth_required" : "worker_auth_not_configured" })); return; }
    try { res.statusCode = 200; res.end(JSON.stringify(await cycle())); } catch { res.statusCode = 503; res.end(JSON.stringify({ ok: false, error: "worker_cycle_failed" })); }
    return;
  }
  res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: "not_found" }));
}).listen(port, "0.0.0.0");

runWorkerLoop(options, { signal: controller.signal, cycleImpl: cycle }).catch(() => process.exitCode = 1);
for (const name of ["SIGTERM", "SIGINT"]) process.on(name, () => controller.abort());
