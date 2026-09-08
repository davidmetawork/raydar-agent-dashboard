import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

import { createDatabase } from "../api/submissions-v2/_lib/db.mjs";
import { createRepository } from "../api/submissions-v2/_lib/repository.mjs";
import { runMigrations } from "../scripts/migrate-submissions-v2.mjs";

const baseDatabaseUrl = process.env.SUBMISSIONS_V2_TEST_DATABASE_URL
  || "postgresql://localhost:5432/raydar_submissions_v2_test";
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");

async function traverse(repository, { page, query = "", limit = 100 }) {
  let cursor = null;
  const cursors = new Set();
  const totals = new Set();
  const pairIds = new Set();
  let rowCount = 0;
  do {
    assert.equal(cursors.has(cursor), false, "cursor traversal must not loop");
    cursors.add(cursor);
    const result = await repository.list({ page, query, limit, cursor });
    totals.add(result.total);
    rowCount += result.rows.length;
    for (const row of result.rows) if (row.pair_id) pairIds.add(row.pair_id);
    cursor = result.next_cursor;
  } while (cursor);
  return { totals, pairIds, rowCount };
}

test("all list categories preserve stable totals through cursor pages and filters", { timeout: 45_000 }, async () => {
  const databaseName = `sv2pg_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(baseDatabaseUrl);
  adminUrl.pathname = "/postgres";
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl.toString(), { max: 1, prepare: false });
  let sql;

  try {
    await admin.unsafe(`create database "${databaseName}"`);
    await runMigrations({ databaseUrl: databaseUrl.toString(), logger: { info() {} } });
    sql = createDatabase({ databaseUrl: databaseUrl.toString(), max: 2 });
    const repository = createRepository({ sql });
    const insertedPairIds = new Set();
    const prefix = `pagination-regression-${randomUUID()}`;
    const baseTime = Date.parse("2026-09-08T00:00:00.000Z");

    await sql.begin(async (tx) => {
      for (let index = 0; index < 313; index += 1) {
        const signalId = randomUUID();
        const pairId = randomUUID();
        const key = `${prefix}-${index}`;
        const receivedAt = new Date(baseTime - (index * 1000));
        await tx`
          insert into submissions_v2.source_events (
            id, source_family, source_version, event_id, direction, received_at,
            content_digest, idempotency_key, envelope
          ) values (
            ${signalId}, 'manual', 'manual.v1', ${`event-${key}`}, 'manual', ${receivedAt},
            ${digest(key)}, ${`source:${key}`}, ${tx.json({ audit_prefix: prefix })}
          )
        `;
        await tx`
          insert into submissions_v2.candidate_role_pairs (
            id, candidate_user_id, role_id, first_signal_id, intent_state,
            workflow_state, original_signal_at, role_state
          ) values (
            ${pairId}, ${`${prefix}-candidate-${index}`}, ${`${prefix}-role-${index}`}, ${signalId}, 'unknown',
            'classifying', ${receivedAt}, 'unknown'
          )
        `;
        await tx`
          insert into submissions_v2.review_items (pair_id, reason_code)
          values (${pairId}, 'role_unclear')
        `;
        await tx`
          update submissions_v2.candidate_role_pairs
             set intent_state='unclear', workflow_state='needs_review', state_version=state_version+1
           where id=${pairId}
        `;
        insertedPairIds.add(pairId);
      }
    });

    const review = await traverse(repository, { page: "needs_review" });
    assert.deepEqual([...review.totals], [313], "each Review page reports one stable list total");
    assert.equal(review.rowCount, 313, "Review traversal reaches every list item exactly once");
    assert.deepEqual(review.pairIds, insertedPairIds, "every inserted Review case appears in the paged list");

    const interestedPairIds = new Set();
    const filteredInterestedPairIds = new Set();
    const interestedCount = 237;
    const filteredCount = 37;
    await sql.begin(async (tx) => {
      for (let index = 0; index < interestedCount; index += 1) {
        const signalId = randomUUID();
        const pairId = randomUUID();
        const key = `${prefix}-interested-${index}`;
        const candidateId = `${key}-candidate`;
        const receivedAt = new Date(baseTime - 86_400_000 - (index * 1000));
        const inFilteredCohort = index < filteredCount;
        const displayName = inFilteredCohort
          ? `Target Cohort Candidate ${index}`
          : `Interested Candidate ${index}`;
        const searchKey = displayName.toLowerCase();
        await tx`
          insert into submissions_v2.candidate_index (
            candidate_user_id, display_name, normalized_name, search_key,
            paraform_profile_url, last_confirmed_at, source_digest
          ) values (
            ${candidateId}, ${displayName}, ${searchKey}, ${searchKey},
            ${`https://www.paraform.com/candidates?candidate=${candidateId}`},
            ${receivedAt}, ${digest(`candidate:${key}`)}
          )
        `;
        await tx`
          insert into submissions_v2.source_events (
            id, source_family, source_version, event_id, direction, received_at,
            content_digest, idempotency_key, envelope
          ) values (
            ${signalId}, 'manual', 'manual.v1', ${`event-${key}`}, 'manual', ${receivedAt},
            ${digest(key)}, ${`source:${key}`}, ${tx.json({ audit_prefix: prefix })}
          )
        `;
        await tx`
          insert into submissions_v2.candidate_role_pairs (
            id, candidate_user_id, role_id, first_signal_id, intent_state,
            workflow_state, original_signal_at, role_state
          ) values (
            ${pairId}, ${candidateId}, ${`${key}-role`}, ${signalId}, 'unknown',
            'classifying', ${receivedAt}, 'unknown'
          )
        `;
        await tx`
          update submissions_v2.candidate_role_pairs
             set intent_state='interested', workflow_state='preparing_resume',
                 state_version=state_version+1
           where id=${pairId}
        `;
        interestedPairIds.add(pairId);
        if (inFilteredCohort) filteredInterestedPairIds.add(pairId);
      }
    });

    const interested = await traverse(repository, { page: "interested", limit: 73 });
    assert.deepEqual([...interested.totals], [interestedCount], "each Interested page reports one stable list total");
    assert.equal(interested.rowCount, interestedCount, "Interested traversal reaches every list item exactly once");
    assert.deepEqual(interested.pairIds, interestedPairIds, "every inserted Interested case appears exactly once");

    const filtered = await traverse(repository, {
      page: "interested", query: "target cohort", limit: 13,
    });
    assert.deepEqual([...filtered.totals], [filteredCount], "filtered pages report the filtered total, not the category total");
    assert.equal(filtered.rowCount, filteredCount, "filtered traversal reaches every matching row exactly once");
    assert.deepEqual(filtered.pairIds, filteredInterestedPairIds, "filtering returns only the matching candidate cohort");

    const notInterestedPairIds = new Set();
    const notInterestedCount = 211;
    await sql.begin(async (tx) => {
      for (let index = 0; index < notInterestedCount; index += 1) {
        const signalId = randomUUID();
        const pairId = randomUUID();
        const negativeId = randomUUID();
        const key = `${prefix}-not-interested-${index}`;
        const candidateId = `${key}-candidate`;
        const receivedAt = new Date(baseTime - 172_800_000 - (index * 1000));
        const displayName = `Not Interested Candidate ${index}`;
        const searchKey = displayName.toLowerCase();
        await tx`
          insert into submissions_v2.candidate_index (
            candidate_user_id, display_name, normalized_name, search_key,
            paraform_profile_url, last_confirmed_at, source_digest
          ) values (
            ${candidateId}, ${displayName}, ${searchKey}, ${searchKey},
            ${`https://www.paraform.com/candidates?candidate=${candidateId}`},
            ${receivedAt}, ${digest(`candidate:${key}`)}
          )
        `;
        await tx`
          insert into submissions_v2.source_events (
            id, source_family, source_version, event_id, direction, received_at,
            content_digest, idempotency_key, envelope
          ) values (
            ${signalId}, 'manual', 'manual.v1', ${`event-${key}`}, 'manual', ${receivedAt},
            ${digest(key)}, ${`source:${key}`}, ${tx.json({ audit_prefix: prefix })}
          )
        `;
        await tx`
          insert into submissions_v2.candidate_role_pairs (
            id, candidate_user_id, role_id, first_signal_id, intent_state,
            workflow_state, original_signal_at, role_state
          ) values (
            ${pairId}, ${candidateId}, ${`${key}-role`}, ${signalId}, 'unknown',
            'classifying', ${receivedAt}, 'unknown'
          )
        `;
        await tx`
          insert into submissions_v2.not_interested_entries (
            id, pair_id, source_event_id, original_negative_at,
            grounded_reason, exact_quote, evidence_digest
          ) values (
            ${negativeId}, ${pairId}, ${signalId}, ${receivedAt},
            'Candidate declined this role.', 'No, thank you.', ${digest(`negative:${key}`)}
          )
        `;
        await tx`
          update submissions_v2.candidate_role_pairs
             set intent_state='not_interested', workflow_state='not_interested',
                 state_version=state_version+1
           where id=${pairId}
        `;
        notInterestedPairIds.add(pairId);
      }
    });

    const notInterested = await traverse(repository, { page: "not_interested", limit: 67 });
    assert.deepEqual([...notInterested.totals], [notInterestedCount], "each Not Interested page reports one stable list total");
    assert.equal(notInterested.rowCount, notInterestedCount, "Not Interested traversal reaches every list item exactly once");
    assert.deepEqual(notInterested.pairIds, notInterestedPairIds, "every inserted Not Interested case appears exactly once");
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => {});
    await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
       where datname=${databaseName} and pid <> pg_backend_pid()
    `.catch(() => {});
    await admin.unsafe(`drop database if exists "${databaseName}"`).catch(() => {});
    await admin.end({ timeout: 5 });
  }
});
