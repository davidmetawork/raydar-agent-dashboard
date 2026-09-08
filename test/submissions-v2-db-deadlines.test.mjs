import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createDatabase, databaseInternals } from "../api/submissions-v2/_lib/db.mjs";

const databaseUrl = process.env.SUBMISSIONS_V2_TEST_DATABASE_URL
  || "postgresql://localhost:5432/raydar_submissions_v2_test";
const tableName = `submissions_v2_deadline_${randomUUID().replaceAll("-", "")}`;
let sql;

before(async () => {
  sql = createDatabase({
    databaseUrl,
    max: 1,
    statementTimeoutMs: 100,
    idleTransactionTimeoutMs: 200,
  });
  await sql.unsafe(`create table ${tableName} (id integer primary key, value text not null, fencing_token integer not null)`);
  await sql.unsafe(`insert into ${tableName}(id, value, fencing_token) values (1, 'original', 7)`);
});

after(async () => {
  await sql?.unsafe(`drop table if exists ${tableName}`).catch(() => {});
  await sql?.end({ timeout: 5 });
});

test("runtime database defaults stay below the worker deadline", () => {
  assert.deepEqual(databaseInternals.sessionDeadlines({}), {
    statementTimeoutMs: 240_000,
    idleTransactionTimeoutMs: 30_000,
  });
  assert.deepEqual(databaseInternals.sessionDeadlines({
    SUBMISSIONS_V2_DB_STATEMENT_TIMEOUT_MS: "999999",
    SUBMISSIONS_V2_DB_IDLE_TRANSACTION_TIMEOUT_MS: "1",
  }), {
    statementTimeoutMs: 280_000,
    idleTransactionTimeoutMs: 100,
  });
});

test("server statement timeout rolls back fenced work and the pool remains reusable", async () => {
  const settings = await sql`select current_setting('statement_timeout') as statement_timeout,
    current_setting('idle_in_transaction_session_timeout') as idle_transaction_timeout`;
  assert.equal(settings[0].statement_timeout, "100ms");
  assert.equal(settings[0].idle_transaction_timeout, "200ms");

  await assert.rejects(sql.begin(async (tx) => {
    const changed = await tx.unsafe(`update ${tableName} set value = 'partial', fencing_token = fencing_token + 1 where id = 1 and fencing_token = 7 returning id`);
    assert.equal(changed.length, 1);
    await tx`select pg_sleep(0.25)`;
  }), (error) => error?.code === "57014");

  const afterTimeout = await sql.unsafe(`select value, fencing_token from ${tableName} where id = 1`);
  assert.deepEqual(afterTimeout[0], { value: "original", fencing_token: 7 });
  const stale = await sql.unsafe(`update ${tableName} set value = 'stale' where id = 1 and fencing_token = 8 returning id`);
  assert.equal(stale.length, 0);
  assert.equal((await sql`select 1 as reusable`)[0].reusable, 1);
});

test("idle transaction timeout rolls back a stalled callback and replaces its connection", async () => {
  await assert.rejects(sql.begin(async (tx) => {
    await tx.unsafe(`update ${tableName} set value = 'idle-partial', fencing_token = fencing_token + 1 where id = 1 and fencing_token = 7`);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await tx`select 1`;
  }));

  const current = await sql.unsafe(`select value, fencing_token from ${tableName} where id = 1`);
  assert.deepEqual(current[0], { value: "original", fencing_token: 7 });
  assert.equal((await sql`select 1 as replacement_connection`)[0].replacement_connection, 1);
});
