import postgres from "postgres";

let sharedDatabase = null;
let sharedDatabaseKey = "";

const DEFAULT_STATEMENT_TIMEOUT_MS = 240_000;
const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 30_000;

function boundedTimeout(value, fallback, { min, max }) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function sessionDeadlines(env = process.env, overrides = {}) {
  return {
    statementTimeoutMs: boundedTimeout(
      overrides.statementTimeoutMs ?? env.SUBMISSIONS_V2_DB_STATEMENT_TIMEOUT_MS,
      DEFAULT_STATEMENT_TIMEOUT_MS,
      { min: 50, max: 280_000 },
    ),
    idleTransactionTimeoutMs: boundedTimeout(
      overrides.idleTransactionTimeoutMs ?? env.SUBMISSIONS_V2_DB_IDLE_TRANSACTION_TIMEOUT_MS,
      DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS,
      { min: 100, max: 60_000 },
    ),
  };
}

async function applyTransactionDeadlines(transaction, deadlines) {
  await transaction`
    select set_config('statement_timeout', ${`${deadlines.statementTimeoutMs}ms`}, true),
           set_config('idle_in_transaction_session_timeout', ${`${deadlines.idleTransactionTimeoutMs}ms`}, true)
  `;
}

function bindTransactionDeadlines(sql, deadlines) {
  const begin = sql.begin.bind(sql);
  sql.begin = (options, callback) => {
    const hasOptions = typeof options === "string";
    const transactionOptions = hasOptions ? options : null;
    const transactionCallback = hasOptions ? callback : options;
    if (typeof transactionCallback !== "function") throw new TypeError("A transaction callback is required");
    const boundedCallback = async (transaction) => {
      await applyTransactionDeadlines(transaction, deadlines);
      const result = transactionCallback(transaction);
      return Array.isArray(result) ? Promise.all(result) : result;
    };
    return transactionOptions === null ? begin(boundedCallback) : begin(transactionOptions, boundedCallback);
  };
  return sql;
}

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

export function createDatabase({
  databaseUrl = configuredUrl(),
  max = 5,
  env = process.env,
  statementTimeoutMs,
  idleTransactionTimeoutMs,
} = {}) {
  const deadlines = sessionDeadlines(env, { statementTimeoutMs, idleTransactionTimeoutMs });
  const sql = postgres(databaseUrl, {
    max,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    transform: { undefined: null },
    onnotice: () => {},
  });
  return bindTransactionDeadlines(sql, deadlines);
}

export function database(env = process.env) {
  const url = configuredUrl(env);
  const deadlines = sessionDeadlines(env);
  const key = `${url}\0${deadlines.statementTimeoutMs}\0${deadlines.idleTransactionTimeoutMs}`;
  if (!sharedDatabase || sharedDatabaseKey !== key) {
    sharedDatabase = createDatabase({ databaseUrl: url, env });
    sharedDatabaseKey = key;
  }
  return sharedDatabase;
}

export async function closeDatabase() {
  if (!sharedDatabase) return;
  const current = sharedDatabase;
  sharedDatabase = null;
  sharedDatabaseKey = "";
  await current.end({ timeout: 5 });
}

export const databaseInternals = Object.freeze({
  DEFAULT_STATEMENT_TIMEOUT_MS,
  DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS,
  sessionDeadlines,
  applyTransactionDeadlines,
  bindTransactionDeadlines,
});

export async function withTransaction(callback, sql = database()) {
  return sql.begin(async (transaction) => callback(transaction));
}

export async function readRuntimeControls(sql = database()) {
  const rows = await withTransaction((transaction) => transaction`
    select control_epoch, ui_enabled, ingestion_enabled, generation_enabled,
           master_inbox_enabled, curated_enabled, actor_email, reason, changed_at
      from submissions_v2.runtime_controls
     where singleton = true
     limit 1
  `, sql);
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
  const rows = await withTransaction((transaction) => transaction`
    select * from submissions_v2.set_runtime_controls(
      ${actorEmail}, ${reason}, ${ui}, ${ingestion}, ${generation}, ${masterInbox}, ${curated}
    )
  `, sql);
  return rows[0] || null;
}

export async function claimJobs({
  workerId,
  kinds = [],
  limit = 1,
  leaseSeconds = 60,
  controlEpoch,
}, sql = database()) {
  const rows = await withTransaction((transaction) => transaction`
    select * from submissions_v2.claim_jobs(
      ${workerId},
      ${transaction.array(kinds)},
      ${Math.max(1, Math.min(50, Number(limit) || 1))},
      ${Math.max(15, Math.min(900, Number(leaseSeconds) || 60))},
      ${Number(controlEpoch)}
    )
  `, sql);
  return rows;
}

export async function claimSourceCursor({
  sourceKey,
  workerId,
  leaseSeconds = 60,
  controlEpoch,
}, sql = database()) {
  const rows = await withTransaction((transaction) => transaction`
    select * from submissions_v2.claim_source_cursor(
      ${sourceKey}, ${workerId},
      ${Math.max(15, Math.min(900, Number(leaseSeconds) || 60))},
      ${Number(controlEpoch)}
    )
  `, sql);
  return rows[0] || null;
}

export async function heartbeatSourceCursor({
  sourceKey,
  workerId,
  fencingToken,
  controlEpoch,
  leaseSeconds = 60,
}, sql = database()) {
  const rows = await withTransaction((transaction) => transaction`
    select * from submissions_v2.heartbeat_source_cursor(
      ${sourceKey}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)},
      ${Math.max(15, Math.min(900, Number(leaseSeconds) || 60))}
    )
  `, sql);
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
  const rows = await withTransaction((transaction) => transaction`
    select * from submissions_v2.commit_source_cursor(
      ${sourceKey}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)},
      ${transaction.json(checkpoint || {})}, ${Boolean(fullSuccess)}
    )
  `, sql);
  return rows[0] || null;
}

export async function releaseSourceCursor({
  sourceKey,
  workerId,
  fencingToken,
  controlEpoch,
}, sql = database()) {
  const rows = await withTransaction((transaction) => transaction`
    select * from submissions_v2.release_source_cursor(
      ${sourceKey}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)}
    )
  `, sql);
  return rows[0] || null;
}

export async function heartbeatJob({
  jobId,
  workerId,
  fencingToken,
  controlEpoch,
  leaseSeconds = 60,
}, sql = database()) {
  const rows = await withTransaction((transaction) => transaction`
    select * from submissions_v2.heartbeat_job(
      ${jobId}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)},
      ${Math.max(15, Math.min(900, Number(leaseSeconds) || 60))}
    )
  `, sql);
  return rows[0] || null;
}

export async function checkpointJob({
  jobId,
  workerId,
  fencingToken,
  controlEpoch,
  checkpoint = {},
}, sql = database()) {
  const rows = await withTransaction((transaction) => transaction`
    select * from submissions_v2.checkpoint_job(
      ${jobId}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)},
      ${transaction.json(checkpoint)}
    )
  `, sql);
  return rows[0] || null;
}

export async function completeJob({
  jobId,
  workerId,
  fencingToken,
  controlEpoch,
  checkpoint = {},
}, sql = database()) {
  const rows = await withTransaction((transaction) => transaction`
    select * from submissions_v2.complete_job(
      ${jobId}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)},
      ${transaction.json(checkpoint)}
    )
  `, sql);
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
  const rows = await withTransaction((transaction) => transaction`
    select * from submissions_v2.fail_job(
      ${jobId}, ${workerId}, ${Number(fencingToken)}, ${Number(controlEpoch)},
      ${errorCode}, ${safeError}, ${Boolean(retry)},
      ${Math.max(0, Math.min(86400, Number(retryDelaySeconds) || 0))},
      ${transaction.json(checkpoint)}
    )
  `, sql);
  return rows[0] || null;
}
