import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { purgeInternals, runPurgeCycle } from "../submissions-v2-purge/purge.mjs";

const env = {
  SUBMISSIONS_V2_PURGE_ENABLED: "true",
  SUBMISSIONS_V2_PURGE_DATABASE_URL: "postgresql://purge.invalid/submissions",
  SUBMISSIONS_V2_PURGE_BLOB_READ_WRITE_TOKEN: "blob-test-token",
};

function fakeSql(handler) {
  const sql = async (strings, ...values) => handler(strings.join("?"), values);
  return sql;
}

test("isolated purge refuses to start unless its independent ceiling and credentials exist", () => {
  assert.throws(() => purgeInternals.configuration({}), (error) => error.code === "purge_disabled");
  assert.throws(() => purgeInternals.configuration({ SUBMISSIONS_V2_PURGE_ENABLED: "true" }), (error) => error.code === "purge_database_not_configured");
});

test("isolated purge deletes only its fresh reference-counted plan before fenced finalization", async () => {
  const calls = [];
  const removed = [];
  const sql = fakeSql(async (query, values) => {
    calls.push([query, values]);
    if (query.includes("claim_routine_object_purges")) return [];
    if (query.includes("claim_restored_manifest_purges")) return [];
    if (query.includes("claim_case_purges")) return [{ id: "deletion-1", purge_fencing_token: 4 }];
    if (query.includes("case_purge_plan")) return [{ plan: { deletion_id: "deletion-1", fencing_token: 4, object_keys: ["submissions/resumes/v2/artifacts/a", "submissions/resumes/v2/artifacts/b", "submissions/resumes/v2/artifacts/a"] } }];
    return [{}];
  });
  const result = await runPurgeCycle({ env, sql, deleteObject: async (key) => removed.push(key) });
  assert.deepEqual(removed, ["submissions/resumes/v2/artifacts/a", "submissions/resumes/v2/artifacts/b"]);
  assert.deepEqual(result, {
    claimed: 1, purged: 1, failed: 0, object_deletes: 2,
    restored_manifests_claimed: 0, restored_manifests_purged: 0,
    routine_claimed: 0, routine_purged: 0,
    routine_by_kind: { private_object_reservation: 0, upload_reservation: 0, quarantined_supplement: 0 },
  });
  assert.ok(calls.some(([query]) => query.includes("finalize_case_purge")));
  assert.equal(calls.some(([query]) => query.includes("release_case_purge")), false);
});

test("a private-object failure releases the exact purge fence without finalizing", async () => {
  const calls = [];
  const sql = fakeSql(async (query) => {
    calls.push(query);
    if (query.includes("claim_routine_object_purges")) return [];
    if (query.includes("claim_restored_manifest_purges")) return [];
    if (query.includes("claim_case_purges")) return [{ id: "deletion-2", purge_fencing_token: 8 }];
    if (query.includes("case_purge_plan")) return [{ plan: { deletion_id: "deletion-2", fencing_token: 8, object_keys: ["submissions/resumes/v2/artifacts/fail"] } }];
    return [{}];
  });
  const result = await runPurgeCycle({ env, sql, deleteObject: async () => { throw Object.assign(new Error("failed"), { code: "blob_delete_failed" }); } });
  assert.equal(result.failed, 1);
  assert.ok(calls.some((query) => query.includes("release_case_purge")));
  assert.equal(calls.some((query) => query.includes("finalize_case_purge")), false);
});

test("a poisoned purge plan cannot delete outside the V2 private namespace", async () => {
  const calls = [];
  let deletes = 0;
  const sql = fakeSql(async (query) => {
    calls.push(query);
    if (query.includes("claim_case_purges")) return [{ id: "deletion-poisoned", purge_fencing_token: 9 }];
    if (query.includes("case_purge_plan")) return [{ plan: { deletion_id: "deletion-poisoned", fencing_token: 9, object_keys: ["another-product/private.pdf"] } }];
    if (query.includes("claim_restored_manifest_purges") || query.includes("claim_routine_object_purges")) return [];
    return [{}];
  });
  const result = await runPurgeCycle({ env, sql, deleteObject: async () => { deletes += 1; } });
  assert.equal(deletes, 0);
  assert.equal(result.failed, 1);
  assert.ok(calls.some((query) => query.includes("release_case_purge")));
  assert.equal(calls.some((query) => query.includes("finalize_case_purge")), false);
});

test("isolated purge owns routine orphan cleanup and fences finalization", async () => {
  const calls = [];
  const removed = [];
  const sql = fakeSql(async (query) => {
    calls.push(query);
    if (query.includes("claim_case_purges") || query.includes("claim_restored_manifest_purges")) return [];
    if (query.includes("claim_routine_object_purges")) return [{
      purge_kind: "upload_reservation", record_id: "11111111-1111-1111-1111-111111111111",
      object_path: "submissions/resumes/v2/supplements/22222222-2222-2222-2222-222222222222", fencing_token: 7,
    }];
    return [{}];
  });
  const result = await runPurgeCycle({ env, sql, deleteObject: async (pathname) => removed.push(pathname) });
  assert.equal(result.routine_claimed, 1);
  assert.equal(result.routine_purged, 1);
  assert.equal(result.routine_by_kind.upload_reservation, 1);
  assert.deepEqual(removed, ["submissions/resumes/v2/supplements/22222222-2222-2222-2222-222222222222"]);
  assert.ok(calls.some((query) => query.includes("finalize_routine_object_purge")));
  assert.equal(calls.some((query) => query.includes("release_routine_object_purge")), false);
});

test("migration exposes purge operations only through the isolated session guard", async () => {
  const source = await readFile(new URL("../migrations/submissions-v2/005_isolated_case_purge.sql", import.meta.url), "utf8");
  assert.match(source, /session_user <> 'submissions_v2_purge'/u);
  assert.match(source, /revoke all on function submissions_v2\.finalize_case_purge/u);
  assert.match(source, /not exists\s*\(\s*select 1 from submissions_v2\.candidate_role_pairs/u);
  assert.match(source, /pair_signal_links/u);
  assert.match(source, /unnest\(deletable_source_ids\).*subject_id = source_id::text/su);
  assert.match(source, /notification\.pair_id = pair_row\.id/u);
  assert.doesNotMatch(source, /reservation\.owner_ref = pair_row\.id::text/u);
  assert.doesNotMatch(source, /reservation\.owner_ref = source_id::text/u);
  assert.match(source, /Delete only the\s+-- exact paths owned by records in this case/su);
  assert.match(source, /reason = '\[purged\]'/u);
  const routine = await readFile(new URL("../migrations/submissions-v2/011_isolated_routine_object_purge.sql", import.meta.url), "utf8");
  assert.match(routine, /assert_isolated_purge_session/u);
  assert.match(routine, /grant execute on function submissions_v2\.claim_routine_object_purges[^;]+ to submissions_v2_purge/su);
  assert.doesNotMatch(routine, /to submissions_v2_worker/u);
});
