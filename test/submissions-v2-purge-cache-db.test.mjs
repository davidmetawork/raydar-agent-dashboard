import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import postgres from "postgres";

import { runMigrations } from "../scripts/migrate-submissions-v2.mjs";
import { runPurgeCycle } from "../submissions-v2-purge/purge.mjs";

const databaseUrl = String(process.env.SUBMISSIONS_V2_PURGE_TEST_DATABASE_URL || "").trim();
const skip = !databaseUrl && "SUBMISSIONS_V2_PURGE_TEST_DATABASE_URL is required";
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const API_TEST_LOGIN = "submissions_v2_api_purge_test";
let adminSql;
let apiSql;
let purgeSql;
let purgeDatabaseUrl;

function exactDedicatedDatabaseUrl(value) {
  const target = new URL(value);
  const localFixture = target.hostname === "127.0.0.1"
    && target.port === "55439"
    && target.pathname === "/submissions_purge_test"
    && target.username === "submissions_dev";
  const ciFixture = process.env.CI === "true"
    && target.hostname === "localhost"
    && target.port === "5432"
    && target.pathname === "/raydar_submissions_purge_test"
    && target.username === "postgres";
  if (!/^postgres(?:ql)?:$/u.test(target.protocol)
    || (!localFixture && !ciFixture)
    || target.search || target.hash) {
    throw new Error("The purge regression requires the dedicated local submissions_purge_test database.");
  }
  return { target, fixture: localFixture ? "local" : "ci" };
}

function roleUrl(base, role) {
  const target = new URL(base);
  target.username = role;
  target.password = "";
  return target.toString();
}

async function source(label) {
  const id = randomUUID();
  await adminSql`
    insert into submissions_v2.source_events(
      id, source_family, source_version, event_id, received_at,
      content_digest, idempotency_key, envelope
    ) values (
      ${id}, 'manual', 'manual.v1', ${`event:${label}:${id}`}, clock_timestamp(),
      ${digest(`source:${label}:${id}`)}, ${`source:${label}:${id}`}, '{}'::jsonb
    )
  `;
  return id;
}

async function pair(candidateId, roleId, signalId) {
  const id = randomUUID();
  await adminSql`
    insert into submissions_v2.candidate_role_pairs(
      id, candidate_user_id, role_id, first_signal_id, intent_state,
      workflow_state, original_signal_at, case_hidden_at
    ) values (
      ${id}, ${candidateId}, ${roleId}, ${signalId}, 'interested',
      'preparing_resume', clock_timestamp(), clock_timestamp()
    )
  `;
  return id;
}

async function cache(candidateId, label, { expired = false } = {}) {
  const sourceId = `resume:${label}`;
  const locator = `paraform:candidate:${candidateId}:${label}`;
  const contentDigest = digest(`bytes:${label}`);
  await adminSql`
    insert into submissions_v2.candidate_original_extraction_cache(
      candidate_user_id, source_id, source_locator, content_digest,
      normalized_text_encrypted, normalized_text_digest, captured_at, expires_at
    ) values (
      ${candidateId}, ${sourceId}, ${locator}, ${contentDigest},
      ${Buffer.from(`encrypted:${label}`)}, ${digest(`normalized:${label}`)},
      clock_timestamp() - interval '2 days',
      case when ${expired} then clock_timestamp() - interval '1 day' else clock_timestamp() + interval '1 day' end
    )
  `;
}

async function enrichment(signalId, candidateId, label) {
  const enrichmentId = `enrichment:${label}:${randomUUID()}`;
  await adminSql`
    insert into submissions_v2.source_enrichments(
      enrichment_id, signal_id, request_digest, contract_key, contract_digest,
      candidate_user_id, ordered_role_ids, evidence, disposition
    ) values (
      ${enrichmentId}, ${signalId}, ${digest(`request:${label}`)}, ${`contract:${label}`},
      ${digest(`contract:${label}`)}, ${candidateId}, ${adminSql.json([`role:${label}`])},
      ${adminSql.json({ bindingKind: "exact_outbound_parent_and_recipient" })}, 'queued'
    )
  `;
  await adminSql`
    insert into submissions_v2.intake_receipts(kind, event_id, request_digest, result)
    values ('enrichment', ${enrichmentId}, ${digest(`request:${label}`)}, ${adminSql.json({ signal_id: signalId })})
  `;
  return enrichmentId;
}

async function dueDeletion(pairId, label) {
  const id = randomUUID();
  await adminSql`
    insert into submissions_v2.case_deletions(
      id, pair_id, admin_actor, reason, requested_at, recovery_deadline,
      state, encrypted_manifest_object_key, manifest_digest,
      tombstone_case_hmac, tombstone_candidate_hmac
    ) values (
      ${id}, ${pairId}, 'admin@raydar.xyz', 'Approved test purge',
      clock_timestamp() - interval '32 days', clock_timestamp() - interval '1 day',
      'soft_deleted', ${`submissions/resumes/v2/case_manifests/${id}`}, ${digest(`manifest:${label}`)},
      ${digest(`case:${label}`)}, ${digest(`candidate:${label}`)}
    )
  `;
  return id;
}

function purgeEnv() {
  return {
    SUBMISSIONS_V2_PURGE_ENABLED: "true",
    SUBMISSIONS_V2_PURGE_DATABASE_URL: purgeDatabaseUrl,
    SUBMISSIONS_V2_PURGE_BLOB_READ_WRITE_TOKEN: "isolated-db-test-token",
  };
}

before(async () => {
  if (!databaseUrl) return;
  const { target, fixture } = exactDedicatedDatabaseUrl(databaseUrl);
  await runMigrations({ databaseUrl: target.toString(), logger: { info() {} } });
  adminSql = postgres(target.toString(), { max: 2, prepare: false, onnotice: () => {} });
  await adminSql.unsafe(await readFile(new URL("../scripts/provision-submissions-v2-roles.sql", import.meta.url), "utf8"));
  if (fixture === "ci") {
    purgeDatabaseUrl = target.toString();
    apiSql = postgres(target.toString(), { max: 1, prepare: false, onnotice: () => {} });
    purgeSql = postgres(target.toString(), { max: 1, prepare: false, onnotice: () => {} });
    await apiSql.unsafe("set session authorization submissions_v2_api");
    await purgeSql.unsafe("set session authorization submissions_v2_purge");
  } else {
    await adminSql.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = '${API_TEST_LOGIN}') then
          create role ${API_TEST_LOGIN} login inherit;
        end if;
      end;
      $$;
      alter role ${API_TEST_LOGIN} login inherit;
      grant submissions_v2_api to ${API_TEST_LOGIN};
    `);
    purgeDatabaseUrl = roleUrl(target, "submissions_v2_purge");
    apiSql = postgres(roleUrl(target, API_TEST_LOGIN), { max: 1, prepare: false, onnotice: () => {} });
    purgeSql = postgres(purgeDatabaseUrl, { max: 1, prepare: false, onnotice: () => {} });
  }
  const apiIdentity = (await apiSql`select current_user, session_user`)[0];
  const purgeIdentity = (await purgeSql`select current_user, session_user`)[0];
  assert.deepEqual(apiIdentity, fixture === "ci"
    ? { current_user: "submissions_v2_api", session_user: "submissions_v2_api" }
    : { current_user: API_TEST_LOGIN, session_user: API_TEST_LOGIN });
  assert.deepEqual(purgeIdentity, { current_user: "submissions_v2_purge", session_user: "submissions_v2_purge" });
});

after(async () => {
  await Promise.all([
    adminSql?.end({ timeout: 5 }),
    apiSql?.end({ timeout: 5 }),
    purgeSql?.end({ timeout: 5 }),
  ]);
});

test("real isolated purge deletes enriched sources and retains shared cache until the last pair", { skip }, async () => {
  const candidateId = `purge-candidate:${randomUUID()}`;
  const firstSignal = await source("first");
  const secondSignal = await source("second");
  const firstPair = await pair(candidateId, `role:first:${randomUUID()}`, firstSignal);
  const secondPair = await pair(candidateId, `role:second:${randomUUID()}`, secondSignal);
  const enrichmentId = await enrichment(firstSignal, candidateId, "first");
  await cache(candidateId, "shared");

  await assert.rejects(
    apiSql`delete from submissions_v2.source_enrichments where enrichment_id=${enrichmentId}`,
    (error) => error?.code === "42501",
  );
  assert.equal((await adminSql`select count(*)::integer as count from submissions_v2.source_enrichments where enrichment_id=${enrichmentId}`)[0].count, 1);

  await dueDeletion(firstPair, "first");
  const first = await runPurgeCycle({
    env: purgeEnv(), sql: purgeSql, workerId: "purge-db-regression", limit: 1,
    deleteObject: async () => {},
  });
  assert.equal(first.claimed, 1);
  assert.equal(first.purged, 1);
  assert.equal(first.failed, 0);
  assert.equal((await adminSql`select count(*)::integer as count from submissions_v2.candidate_role_pairs where id=${firstPair}`)[0].count, 0);
  assert.equal((await adminSql`select count(*)::integer as count from submissions_v2.source_events where id=${firstSignal}`)[0].count, 0);
  assert.equal((await adminSql`select count(*)::integer as count from submissions_v2.source_enrichments where enrichment_id=${enrichmentId}`)[0].count, 0);
  assert.equal((await adminSql`select count(*)::integer as count from submissions_v2.intake_receipts where kind='enrichment' and event_id=${enrichmentId}`)[0].count, 1);
  assert.equal((await adminSql`select count(*)::integer as count from submissions_v2.candidate_role_pairs where id=${secondPair}`)[0].count, 1);
  assert.equal((await adminSql`select count(*)::integer as count from submissions_v2.candidate_original_extraction_cache where candidate_user_id=${candidateId}`)[0].count, 1);

  await dueDeletion(secondPair, "second");
  const second = await runPurgeCycle({
    env: purgeEnv(), sql: purgeSql, workerId: "purge-db-regression", limit: 1,
    deleteObject: async () => {},
  });
  assert.equal(second.claimed, 1);
  assert.equal(second.purged, 1);
  assert.equal(second.failed, 0);
  assert.equal((await adminSql`select count(*)::integer as count from submissions_v2.candidate_role_pairs where id=${secondPair}`)[0].count, 0);
  assert.equal((await adminSql`select count(*)::integer as count from submissions_v2.candidate_original_extraction_cache where candidate_user_id=${candidateId}`)[0].count, 0);
});

test("real purge worker drains expired cache in its bounded batches", { skip }, async () => {
  const candidateId = `expired-cache-candidate:${randomUUID()}`;
  const signalId = await source("expired-cache-owner");
  await pair(candidateId, `role:expired-cache:${randomUUID()}`, signalId);
  await adminSql`
    insert into submissions_v2.candidate_original_extraction_cache(
      candidate_user_id, source_id, source_locator, content_digest,
      normalized_text_encrypted, normalized_text_digest, captured_at, expires_at
    )
    select ${candidateId}, 'resume:' || item::text, 'locator:' || item::text,
           encode(public.digest(('bytes:' || item::text)::text, 'sha256'::text), 'hex'),
           convert_to('encrypted:' || item::text, 'utf8'),
           encode(public.digest(('normalized:' || item::text)::text, 'sha256'::text), 'hex'),
           clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day'
      from generate_series(1, 101) item
  `;
  await cache(candidateId, "fresh");

  const first = await runPurgeCycle({
    env: purgeEnv(), sql: purgeSql, workerId: "purge-db-expiry", limit: 1,
    deleteObject: async () => {},
  });
  assert.equal(first.candidate_original_cache_purged, 100);
  assert.equal((await adminSql`select count(*)::integer as count from submissions_v2.candidate_original_extraction_cache where candidate_user_id=${candidateId} and expires_at <= clock_timestamp()`)[0].count, 1);
  assert.equal((await adminSql`select count(*)::integer as count from submissions_v2.candidate_original_extraction_cache where candidate_user_id=${candidateId}`)[0].count, 2);

  const second = await runPurgeCycle({
    env: purgeEnv(), sql: purgeSql, workerId: "purge-db-expiry", limit: 1,
    deleteObject: async () => {},
  });
  assert.equal(second.candidate_original_cache_purged, 1);
  assert.equal((await adminSql`select count(*)::integer as count from submissions_v2.candidate_original_extraction_cache where candidate_user_id=${candidateId}`)[0].count, 1);
  assert.equal((await adminSql`select expires_at > clock_timestamp() as fresh from submissions_v2.candidate_original_extraction_cache where candidate_user_id=${candidateId}`)[0].fresh, true);
});
