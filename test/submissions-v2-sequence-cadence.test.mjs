import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";

import { createDatabase, setRuntimeControls } from "../api/submissions-v2/_lib/db.mjs";
import { createRepository } from "../api/submissions-v2/_lib/repository.mjs";
import { runMigrations } from "../scripts/migrate-submissions-v2.mjs";

const baseDatabaseUrl = process.env.SUBMISSIONS_V2_TEST_DATABASE_URL
  || "postgresql://localhost:5432/raydar_submissions_v2_test";
const databaseName = `sv2cadence_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl.toString(), { max: 1, prepare: false });
let sql;
let repository;
let controls;

async function setControls({ ingestion = true, masterInbox = true } = {}) {
  controls = await setRuntimeControls({
    actorEmail: "test@raydar.xyz",
    reason: "Configure isolated Sequence cadence regression",
    ui: true,
    ingestion,
    generation: true,
    masterInbox,
    curated: true,
  }, sql);
}

async function resetState({ errorClass = "sequence_inbox_catching_up", caughtUp = false } = {}) {
  await sql`delete from submissions_v2.jobs`;
  await sql`delete from submissions_v2.source_health where source_key='sequence_inbox'`;
  await sql`delete from submissions_v2.source_cursors where source_key='sequence_inbox'`;
  await sql`
    insert into submissions_v2.source_cursors(source_key, checkpoint, control_epoch)
    values ('sequence_inbox', ${sql.json({ caught_up: caughtUp, cursor: "cursor" })}, ${controls.control_epoch})
  `;
  if (errorClass !== null) {
    await sql`
      insert into submissions_v2.source_health(source_key, enabled, error_class)
      values ('sequence_inbox', true, ${errorClass})
    `;
  }
}

function sequenceJob(result) {
  return result.jobs.find((job) => job.kind === "reconcile_sequence_inbox") || null;
}

function tick(minuteKey, fiveMinuteKey, options = {}) {
  return repository.scheduleTick({
    minuteKey,
    fiveMinuteKey,
    hourKey: minuteKey.slice(0, 13),
    pacificDayKey: minuteKey.slice(0, 10),
    ...options,
  });
}

async function finish(id) {
  await sql`
    update submissions_v2.jobs
       set state='succeeded', completed_at=clock_timestamp()
     where id=${id}
  `;
}

async function jobRow(id) {
  return (await sql`select * from submissions_v2.jobs where id=${id}`)[0];
}

before(async () => {
  await admin.unsafe(`create database "${databaseName}"`);
  await runMigrations({ databaseUrl: databaseUrl.toString(), logger: { info() {} } });
  sql = createDatabase({ databaseUrl: databaseUrl.toString(), max: 8 });
  repository = createRepository({ sql });
  await setControls();
});

after(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await admin`
    select pg_terminate_backend(pid) from pg_stat_activity
     where datname=${databaseName} and pid <> pg_backend_pid()
  `.catch(() => {});
  await admin.unsafe(`drop database if exists "${databaseName}"`).catch(() => {});
  await admin.end({ timeout: 5 });
});

test("successful partial Sequence pages use minute buckets", async () => {
  await resetState();
  const first = sequenceJob(await tick("2026-09-08T01:31", "2026-09-08T01:30"));
  assert.equal((await jobRow(first.id)).idempotency_key, "tick:sequence_inbox:2026-09-08T01:31");
  await finish(first.id);
  const second = sequenceJob(await tick("2026-09-08T01:32", "2026-09-08T01:30"));
  assert.equal((await jobRow(second.id)).idempotency_key, "tick:sequence_inbox:2026-09-08T01:32");
  assert.notEqual(second.id, first.id);
});

test("caught-up, clear, unavailable, and failed source states retain five-minute buckets", async () => {
  for (const fixture of [
    { errorClass: "sequence_inbox_catching_up", caughtUp: true },
    { errorClass: null, caughtUp: false },
    { errorClass: "paraform_throttled", caughtUp: false },
  ]) {
    await resetState(fixture);
    const first = sequenceJob(await tick("2026-09-08T01:31", "2026-09-08T01:30"));
    assert.equal((await jobRow(first.id)).idempotency_key, "tick:sequence_inbox:2026-09-08T01:30");
    await finish(first.id);
    const sameBucket = sequenceJob(await tick("2026-09-08T01:32", "2026-09-08T01:30"));
    assert.equal(sameBucket.id, first.id);
  }
});

test("a successful caught-up transition restores steady cadence", async () => {
  await resetState();
  const catchup = sequenceJob(await tick("2026-09-08T01:31", "2026-09-08T01:30"));
  await finish(catchup.id);
  await sql`update submissions_v2.source_cursors set checkpoint=${sql.json({ caught_up: true, cursor: "current" })} where source_key='sequence_inbox'`;
  await sql`update submissions_v2.source_health set error_class=null where source_key='sequence_inbox'`;
  const current = sequenceJob(await tick("2026-09-08T01:32", "2026-09-08T01:30"));
  assert.equal((await jobRow(current.id)).idempotency_key, "tick:sequence_inbox:2026-09-08T01:30");
});

test("queued backoff, running, and held Sequence jobs suppress new work", async () => {
  for (const state of ["queued", "running", "held"]) {
    await resetState();
    const id = randomUUID();
    await sql`
      insert into submissions_v2.jobs(
        id, kind, subject_type, subject_id, idempotency_key, required_control,
        scheduled_at, state, lease_owner, lease_expires_at, hold_reason, control_epoch
      ) values (
        ${id}, 'reconcile_sequence_inbox', 'source', 'sequence_inbox', ${`fixture:${state}`}, 'master_inbox',
        clock_timestamp() + interval '1 hour', ${state},
        ${state === "running" ? "other-worker" : null},
        case when ${state}='running' then clock_timestamp() + interval '5 minutes' else null end,
        ${state === "held" ? "control_epoch_changed" : null}, ${controls.control_epoch}
      )
    `;
    const scheduled = sequenceJob(await tick("2026-09-08T01:33", "2026-09-08T01:30"));
    assert.equal(scheduled.id, id, state);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.jobs
       where kind='reconcile_sequence_inbox'
    `)[0].count, 1, state);
  }
});

test("concurrent adjacent-minute schedulers create one active Sequence job", async () => {
  await resetState();
  const [left, right] = await Promise.all([
    tick("2026-09-08T01:34", "2026-09-08T01:30"),
    tick("2026-09-08T01:35", "2026-09-08T01:35"),
  ]);
  const ids = new Set([sequenceJob(left).id, sequenceJob(right).id]);
  assert.equal(ids.size, 1);
  assert.equal((await sql`
    select count(*)::integer as count from submissions_v2.jobs
     where kind='reconcile_sequence_inbox' and state in ('queued','running','held')
  `)[0].count, 1);
});

test("durable and environment source controls suppress catch-up scheduling", async () => {
  for (const durable of [
    { ingestion: false, masterInbox: true },
    { ingestion: true, masterInbox: false },
  ]) {
    await setControls(durable);
    await resetState();
    assert.equal(sequenceJob(await tick("2026-09-08T01:36", "2026-09-08T01:35")), null);
  }
  await setControls();
  for (const controlCeiling of [
    { ingestion: false, master_inbox: true, curated: true },
    { ingestion: true, master_inbox: false, curated: true },
  ]) {
    await resetState();
    assert.equal(sequenceJob(await tick("2026-09-08T01:36", "2026-09-08T01:35", { controlCeiling })), null);
  }
});
