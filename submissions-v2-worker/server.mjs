import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { checkpointJob, claimJobs, completeJob, database, failJob, heartbeatJob, readRuntimeControls } from "../api/submissions-v2/_lib/db.mjs";
import { runWorkerLoop, workerCycle } from "./runner.mjs";
import { createWorkerHandlers } from "./worker-handlers.mjs";
import { createRepository } from "../api/submissions-v2/_lib/repository.mjs";
import { createService } from "../api/submissions-v2/_lib/service.mjs";
import { createResumePipelineStore } from "../api/submissions-v2/_lib/resume/pipeline-store.mjs";
import { createBlobBrokerClient } from "./blob-broker-client.mjs";
import { submissionsV2ReleaseManifest } from "../api/submissions-v2/_lib/release-manifest.mjs";

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
  scheduleJobs: () => workerService.tick(),
};
let lastCycle = null;
let cycleRunning = false;

function equal(left, right) {
  const a = Buffer.from(String(left || "")); const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

const strongSecret = (value) => Buffer.byteLength(String(value || "").trim(), "utf8") >= 32;

async function cycle() {
  if (cycleRunning) return lastCycle;
  cycleRunning = true;
  try { lastCycle = { at: new Date().toISOString(), ...(await workerCycle(options)) }; return lastCycle; }
  finally { cycleRunning = false; }
}

createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  if (req.url === "/health" && req.method === "GET") {
    const { schema_version, algorithm, digest, file_count } = submissionsV2ReleaseManifest();
    res.statusCode = 200; res.end(JSON.stringify({ ok: true, worker: "submissions-v2", cycle_running: cycleRunning, last_cycle_at: lastCycle?.at || null, release: { schema_version, algorithm, digest, file_count } })); return;
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
