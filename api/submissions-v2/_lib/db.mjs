import postgres from "postgres";

let sharedDatabase = null;
let sharedDatabaseUrl = "";

function configuredUrl(env = process.env) {
  const url = String(env.SUBMISSIONS_V2_DATABASE_URL || "").trim();
  if (!/^postgres(?:ql)?:\/\//i.test(url)) {
    const error = new Error("Submissions V2 database is not configured");
    error.code = "submissions_v2_database_not_configured";
    error.status = 503;
    throw error;
  }
  return url;
}

export function createDatabase({ databaseUrl = configuredUrl(), max = 5 } = {}) {
  return postgres(databaseUrl, {
    max,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    transform: { undefined: null },
    onnotice: () => {},
  });
}

export function database(env = process.env) {
  const url = configuredUrl(env);
  if (!sharedDatabase || sharedDatabaseUrl !== url) {
    sharedDatabase = createDatabase({ databaseUrl: url });
    sharedDatabaseUrl = url;
  }
  return sharedDatabase;
}

export async function closeDatabase() {
  if (!sharedDatabase) return;
  const current = sharedDatabase;
  sharedDatabase = null;
  sharedDatabaseUrl = "";
  await current.end({ timeout: 5 });
}

export async function withTransaction(callback, sql = database()) {
  return sql.begin(async (transaction) => callback(transaction));
}

export async function readRuntimeControls(sql = database()) {
  const rows = await sql`
    select control_epoch, ui_enabled, ingestion_enabled, generation_enabled,
           master_inbox_enabled, curated_enabled, actor_email, reason, changed_at
      from submissions_v2.runtime_controls
     where singleton = true
     limit 1
  `;
  if (rows.length !== 1) {
    const error = new Error("Submissions V2 runtime controls are unavailable");
    error.code = "submissions_v2_controls_unavailable";
    error.status = 503;
    throw error;
  }
  return rows[0];
}

export async function setRuntimeControls({
  actorEmail,
  reason,
  ui,
  ingestion,
  generation,
  masterInbox,
  curated,
}, sql = database()) {
  const rows = await sql`
    select * from submissions_v2.set_runtime_controls(
      ${actorEmail}, ${reason}, ${ui}, ${ingestion}, ${generation}, ${masterInbox}, ${curated}
    )
  `;
  return rows[0] || null;
}

export async function claimJobs({
  workerId,
  kinds = [],
  limit = 1,
  leaseSeconds = 60,
  controlEpoch,
}, sql = database()) {
  const rows = await sql`
    select * from submissions_v2.claim_jobs(
      ${workerId},
      ${sql.array(kinds)},
      ${Math.max(1, Math.min(50, Number(limit) || 1))},
      ${Math.max(15, Math.min(900, Number(leaseSeconds) || 60))},
      ${Number(controlEpoch)}
    )
  `;
  return rows;
}

export async function claimSourceCursor({
  sourceKey,
  workerId,
  leaseSeconds = 60,
  controlEpoch,
}, sql = database()) {
  const rows = await sql`
    select * from submissions_v2.claim_source_cursor(
      ${sourceKey}, ${workerId},
      ${Math.max(15, Math.min(900, Number(leaseSeconds) || 60))},
      ${Number(controlEpoch)}
    )
  `;
  return rows[0] || null;
}

export async function heartbeatSourceCursor({
  sourceKey,
  workerId,
  fencingToken,
  controlEpoch,
  leaseSeconds = 60,
}, sql = database()) {
  const rows = await sql`
    select * from submissions_v2.heartbeat_source_cursor(
      ${sourceKey}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)},
      ${Math.max(15, Math.min(900, Number(leaseSeconds) || 60))}
    )
  `;
  return rows[0] || null;
}

export async function commitSourceCursor({
  sourceKey,
  workerId,
  fencingToken,
  controlEpoch,
  checkpoint,
  fullSuccess = false,
}, sql = database()) {
  const rows = await sql`
    select * from submissions_v2.commit_source_cursor(
      ${sourceKey}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)},
      ${sql.json(checkpoint || {})}, ${Boolean(fullSuccess)}
    )
  `;
  return rows[0] || null;
}

export async function releaseSourceCursor({
  sourceKey,
  workerId,
  fencingToken,
  controlEpoch,
}, sql = database()) {
  const rows = await sql`
    select * from submissions_v2.release_source_cursor(
      ${sourceKey}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)}
    )
  `;
  return rows[0] || null;
}

export async function heartbeatJob({
  jobId,
  workerId,
  fencingToken,
  controlEpoch,
  leaseSeconds = 60,
}, sql = database()) {
  const rows = await sql`
    select * from submissions_v2.heartbeat_job(
      ${jobId}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)},
      ${Math.max(15, Math.min(900, Number(leaseSeconds) || 60))}
    )
  `;
  return rows[0] || null;
}

export async function checkpointJob({
  jobId,
  workerId,
  fencingToken,
  controlEpoch,
  checkpoint = {},
}, sql = database()) {
  const rows = await sql`
    select * from submissions_v2.checkpoint_job(
      ${jobId}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)},
      ${sql.json(checkpoint)}
    )
  `;
  return rows[0] || null;
}

export async function completeJob({
  jobId,
  workerId,
  fencingToken,
  controlEpoch,
  checkpoint = {},
}, sql = database()) {
  const rows = await sql`
    select * from submissions_v2.complete_job(
      ${jobId}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)},
      ${sql.json(checkpoint)}
    )
  `;
  return rows[0] || null;
}

export async function failJob({
  jobId,
  workerId,
  fencingToken,
  controlEpoch,
  errorCode,
  safeError,
  retry = true,
  retryDelaySeconds = 30,
  checkpoint = {},
}, sql = database()) {
  const rows = await sql`
    select * from submissions_v2.fail_job(
      ${jobId}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)},
      ${errorCode}, ${safeError}, ${Boolean(retry)},
      ${Math.max(0, Math.min(86400, Number(retryDelaySeconds) || 0))},
      ${sql.json(checkpoint)}
    )
  `;
  return rows[0] || null;
}
