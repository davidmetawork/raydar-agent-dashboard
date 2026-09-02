import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import postgres from "postgres";

import { runMigrations } from "../scripts/migrate-submissions-v2.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsSource = join(here, "../migrations/submissions-v2");
const baseDatabaseUrl = process.env.SUBMISSIONS_V2_TEST_DATABASE_URL
  || "postgresql://localhost:5432/raydar_submissions_v2_test";
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");

test("migration 011 backfills a populated 001-010 database before ownership guards activate", { timeout: 30_000 }, async () => {
  const migrationDir = await mkdtemp(join(tmpdir(), "submissions-v2-upgrade-"));
  const databaseName = `raydar_submissions_v2_upgrade_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(baseDatabaseUrl);
  adminUrl.pathname = "/postgres";
  const upgradeUrl = new URL(baseDatabaseUrl);
  upgradeUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl.toString(), { max: 1, prepare: false });
  let legacy;
  try {
    await admin.unsafe(`create database "${databaseName}"`);
    const files = (await readdir(migrationsSource)).sort();
    for (const file of files.filter((name) => /^00[1-9]_|^010_/u.test(name))) {
      await copyFile(join(migrationsSource, file), join(migrationDir, file));
    }
    await runMigrations({ databaseUrl: upgradeUrl.toString(), migrationsDir: migrationDir, logger: { info() {} } });
    legacy = postgres(upgradeUrl.toString(), { max: 1, prepare: false });

    const signalA = randomUUID();
    const signalB = randomUUID();
    const pairA = randomUUID();
    const pairB = randomUUID();
    const generationB = randomUUID();
    const artifactB = randomUUID();
    const artifactPath = `submissions/resumes/v2/pdf/${artifactB}`;
    for (const [signal, key] of [[signalA, "a"], [signalB, "b"]]) {
      await legacy`
        insert into submissions_v2.source_events(
          id, source_family, source_version, event_id, direction, received_at,
          content_digest, idempotency_key
        ) values (
          ${signal}, 'manual', 'manual.v1', ${`legacy-${key}-${signal}`}, 'manual',
          clock_timestamp(), ${digest(signal)}, ${`legacy-source:${signal}`}
        )
      `;
    }
    for (const [pair, signal, candidate, role] of [
      [pairA, signalA, `candidate-a-${pairA}`, `role-a-${pairA}`],
      [pairB, signalB, `candidate-b-${pairB}`, `role-b-${pairB}`],
    ]) {
      await legacy`
        insert into submissions_v2.candidate_role_pairs(
          id, candidate_user_id, role_id, first_signal_id, intent_state,
          workflow_state, original_signal_at, role_state
        ) values (
          ${pair}, ${candidate}, ${role}, ${signal}, 'interested',
          'preparing_resume', clock_timestamp(), 'active'
        )
      `;
    }
    await legacy`
      insert into submissions_v2.resume_generations(
        id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
        expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
        validator_model_pin, prompt_pin, template_pin, deadline_at
      ) values (
        ${generationB}, ${pairB}, 1, 'initial', ${`legacy-generation:${generationB}`},
        'queued', 'queued', 1, ${signalB}, 'opus-test', 'opus-fallback-test',
        'validator-test', 'prompt-test', 'template-test', clock_timestamp() + interval '5 minutes'
      )
    `;
    await legacy`
      insert into submissions_v2.private_object_reservations(
        id, object_key, purpose, owner_ref, expected_digest, state, expires_at, committed_at
      ) values (
        ${randomUUID()}, ${artifactPath}, 'resume_artifact', ${generationB},
        ${digest("legacy-artifact")}, 'committed', clock_timestamp() + interval '1 day', clock_timestamp()
      )
    `;
    await legacy`
      insert into submissions_v2.resume_artifacts(
        id, pair_id, generation_id, artifact_version, kind, private_object_key,
        digest, size_bytes, validation_status, current_state
      ) values (
        ${artifactB}, ${pairB}, ${generationB}, 1, 'pdf', ${artifactPath},
        ${digest("legacy-artifact")}, 100, 'pending', 'staged'
      )
    `;

    const supplementB = randomUUID();
    const supplementPath = `submissions/resumes/v2/supplements/${supplementB}`;
    await legacy`
      insert into submissions_v2.resume_supplements(
        id, pair_id, supplement_kind, object_key, creator_email, mime_type,
        original_name, size_bytes, digest, scan_state, parse_state,
        evidence_basis, source_or_correction_note
      ) values (
        ${supplementB}, ${pairB}, 'evidence', ${supplementPath}, 'candidate@example.com',
        'application/pdf', 'legacy.pdf', 100, ${digest("legacy-supplement")},
        'pending', 'pending', 'sourced', 'Legacy upgrade fixture'
      )
    `;

    const emailSource = randomUUID();
    const providerEventId = `provider-${randomUUID()}`;
    const emailPath = `submissions/resumes/v2/events/${randomUUID()}`;
    await legacy`
      insert into submissions_v2.source_events(
        id, source_family, source_version, event_id, provider, mailbox_id,
        provider_message_id, direction, received_at, encrypted_body_object_key,
        content_digest, idempotency_key
      ) values (
        ${emailSource}, 'email', 'submissions.email_reply.v1', ${providerEventId},
        'master_inbox', 'legacy-mailbox', ${`message-${providerEventId}`}, 'inbound',
        clock_timestamp(), ${emailPath}, ${digest("legacy-email")}, ${`legacy-email:${providerEventId}`}
      )
    `;
    await legacy`
      insert into submissions_v2.private_object_reservations(
        id, object_key, purpose, owner_ref, expected_digest, state, expires_at, committed_at
      ) values (
        ${randomUUID()}, ${emailPath}, 'source_event', ${emailSource}, ${digest("legacy-email-object")},
        'committed', clock_timestamp() + interval '1 day', clock_timestamp()
      )
    `;
    await legacy.end({ timeout: 5 });
    legacy = null;

    await copyFile(
      join(migrationsSource, "011_isolated_routine_object_purge.sql"),
      join(migrationDir, "011_isolated_routine_object_purge.sql"),
    );
    const upgraded = await runMigrations({
      databaseUrl: upgradeUrl.toString(), migrationsDir: migrationDir, logger: { info() {} },
    });
    assert.deepEqual(upgraded.applied, ["011_isolated_routine_object_purge.sql"]);
    legacy = postgres(upgradeUrl.toString(), { max: 1, prepare: false });

    const bindings = await legacy`
      select object_key, owner_table, owner_id, owner_pair_id, reservation_kind
        from submissions_v2.private_object_bindings
       where object_key in (${artifactPath}, ${supplementPath}, ${emailPath})
       order by object_key
    `;
    assert.equal(bindings.length, 3);
    assert.equal(bindings.find((row) => row.object_key === artifactPath)?.owner_pair_id, pairB);
    assert.equal(bindings.find((row) => row.object_key === supplementPath)?.owner_pair_id, pairB);
    assert.equal((await legacy`
      select owner_ref from submissions_v2.private_object_reservations where object_key=${emailPath}
    `)[0].owner_ref, providerEventId);

    await assert.rejects(
      legacy`
        insert into submissions_v2.resume_supplements(
          id, pair_id, supplement_kind, object_key, creator_email, mime_type,
          original_name, size_bytes, digest, scan_state, parse_state,
          evidence_basis, source_or_correction_note
        ) values (
          ${randomUUID()}, ${pairA}, 'evidence', ${artifactPath}, 'attacker@raydar.xyz',
          'application/pdf', 'poison.pdf', 100, ${digest("upgrade-poison")},
          'pending', 'pending', 'sourced', 'Upgrade poison attempt'
        )
      `,
      /private object path already belongs to another record/,
    );
    await assert.rejects(
      legacy`update submissions_v2.resume_supplements set pair_id=${pairA} where id=${supplementB}`,
      /supplement owner relation is immutable/,
    );
  } finally {
    await legacy?.end({ timeout: 5 }).catch(() => {});
    await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
       where datname=${databaseName} and pid <> pg_backend_pid()
    `.catch(() => {});
    await admin.unsafe(`drop database if exists "${databaseName}"`).catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
    await rm(migrationDir, { recursive: true, force: true });
  }
});
