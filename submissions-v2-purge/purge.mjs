import { randomUUID } from "node:crypto";
import { del } from "@vercel/blob";
import postgres from "postgres";

const clean = (value, limit = 200) => String(value ?? "").replace(/[\r\n]+/gu, " ").trim().slice(0, limit);
const PRIVATE_OBJECT_PATH = /^submissions\/resumes\/v2\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/u;

function exactPrivateObjectPath(value) {
  const pathname = String(value || "");
  if (!PRIVATE_OBJECT_PATH.test(pathname)) throw Object.assign(new Error("The purge plan contained an object outside the Submissions V2 namespace."), { code: "purge_path_invalid" });
  return pathname;
}

function configuration(env = process.env) {
  if (String(env.SUBMISSIONS_V2_PURGE_ENABLED || "").toLowerCase() !== "true") {
    throw Object.assign(new Error("The isolated purge ceiling is disabled."), { code: "purge_disabled" });
  }
  const databaseUrl = clean(env.SUBMISSIONS_V2_PURGE_DATABASE_URL, 4_000);
  const blobToken = clean(env.SUBMISSIONS_V2_PURGE_BLOB_READ_WRITE_TOKEN, 4_000);
  if (!/^postgres(?:ql)?:\/\//iu.test(databaseUrl)) throw Object.assign(new Error("The isolated purge database is not configured."), { code: "purge_database_not_configured" });
  if (!blobToken) throw Object.assign(new Error("The private Blob purge token is not configured."), { code: "purge_blob_not_configured" });
  return { databaseUrl, blobToken };
}

export async function runPurgeCycle({
  env = process.env,
  workerId = env.SUBMISSIONS_V2_PURGE_WORKER_ID || `purge-${randomUUID()}`,
  sql: suppliedSql = null,
  deleteObject = null,
  limit = 5,
} = {}) {
  const config = configuration(env);
  const ownSql = !suppliedSql;
  const sql = suppliedSql || postgres(config.databaseUrl, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 10, onnotice: () => {} });
  const remove = deleteObject || ((pathname) => del(pathname, { token: config.blobToken }));
  const summary = {
    claimed: 0, purged: 0, failed: 0, object_deletes: 0,
    restored_manifests_claimed: 0, restored_manifests_purged: 0,
    routine_claimed: 0, routine_purged: 0,
    routine_by_kind: { private_object_reservation: 0, upload_reservation: 0, quarantined_supplement: 0 },
  };
  try {
    const claims = await sql`select * from submissions_v2.claim_case_purges(${workerId}, ${Math.max(1, Math.min(20, Number(limit) || 5))}, 1800)`;
    summary.claimed = claims.length;
    for (const claim of claims) {
      try {
        const plans = await sql`select submissions_v2.case_purge_plan(${claim.id}, ${workerId}, ${claim.purge_fencing_token}) as plan`;
        const plan = plans[0]?.plan;
        if (!plan || String(plan.deletion_id) !== String(claim.id)) throw Object.assign(new Error("The purge plan did not match its claim."), { code: "purge_plan_invalid" });
        const keys = [...new Set((Array.isArray(plan.object_keys) ? plan.object_keys : []).map(exactPrivateObjectPath))];
        for (const pathname of keys) {
          await remove(pathname);
          summary.object_deletes += 1;
        }
        await sql`select submissions_v2.finalize_case_purge(${claim.id}, ${workerId}, ${claim.purge_fencing_token}, ${`deleted_${keys.length}_private_objects`})`;
        summary.purged += 1;
      } catch (error) {
        summary.failed += 1;
        await sql`select submissions_v2.release_case_purge(${claim.id}, ${workerId}, ${claim.purge_fencing_token}, ${clean(error?.code || "purge_failed", 120)})`.catch(() => {});
      }
    }
    const manifestClaims = await sql`select * from submissions_v2.claim_restored_manifest_purges(${workerId}, ${Math.max(1, Math.min(20, Number(limit) || 5))}, 1800)`;
    summary.restored_manifests_claimed = manifestClaims.length;
    for (const claim of manifestClaims) {
      try {
        const plans = await sql`select submissions_v2.restored_manifest_purge_plan(${claim.id}, ${workerId}, ${claim.purge_fencing_token}) as object_key`;
        const objectKey = exactPrivateObjectPath(plans[0]?.object_key);
        await remove(objectKey);
        summary.object_deletes += 1;
        await sql`select submissions_v2.finalize_restored_manifest_purge(${claim.id}, ${workerId}, ${claim.purge_fencing_token})`;
        summary.restored_manifests_purged += 1;
      } catch (error) {
        summary.failed += 1;
        await sql`select submissions_v2.release_restored_manifest_purge(${claim.id}, ${workerId}, ${claim.purge_fencing_token}, ${clean(error?.code || "manifest_purge_failed", 120)})`.catch(() => {});
      }
    }
    const routineClaims = await sql`select * from submissions_v2.claim_routine_object_purges(${workerId}, ${Math.max(1, Math.min(50, Number(limit) || 5))}, 1800)`;
    summary.routine_claimed = routineClaims.length;
    for (const claim of routineClaims) {
      try {
        const pathname = exactPrivateObjectPath(claim.object_path);
        await remove(pathname);
        summary.object_deletes += 1;
        await sql`select submissions_v2.finalize_routine_object_purge(${claim.purge_kind}, ${claim.record_id}, ${workerId}, ${claim.fencing_token})`;
        summary.routine_purged += 1;
        if (Object.hasOwn(summary.routine_by_kind, claim.purge_kind)) summary.routine_by_kind[claim.purge_kind] += 1;
      } catch (error) {
        summary.failed += 1;
        await sql`select submissions_v2.release_routine_object_purge(${claim.purge_kind}, ${claim.record_id}, ${workerId}, ${claim.fencing_token})`.catch(() => {});
      }
    }
    return summary;
  } finally {
    if (ownSql) await sql.end({ timeout: 5 });
  }
}

export const purgeInternals = Object.freeze({ configuration, exactPrivateObjectPath, PRIVATE_OBJECT_PATH });
