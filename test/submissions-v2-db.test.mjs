import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import {
  claimSourceCursor,
  commitSourceCursor,
  checkpointJob,
  claimJobs,
  completeJob,
  createDatabase,
  heartbeatJob,
  heartbeatSourceCursor,
  readRuntimeControls,
  setRuntimeControls,
} from "../api/submissions-v2/_lib/db.mjs";
import {
  PairStateError,
  assertPairState,
  nextPairState,
} from "../api/submissions-v2/_lib/state.mjs";
import { runMigrations } from "../scripts/migrate-submissions-v2.mjs";
import { createRepository, repositoryInternals } from "../api/submissions-v2/_lib/repository.mjs";
import { createService } from "../api/submissions-v2/_lib/service.mjs";
import { createResumePipelineStore } from "../api/submissions-v2/_lib/resume/pipeline-store.mjs";

const databaseUrl = process.env.SUBMISSIONS_V2_TEST_DATABASE_URL
  || "postgresql://localhost:5432/raydar_submissions_v2_test";
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
let sql;

async function sourceEvent({ family = "manual", key = randomUUID(), receivedAt = new Date() } = {}) {
  const id = randomUUID();
  const isEmail = family === "email";
  await sql`
    insert into submissions_v2.source_events (
      id, source_family, source_version, event_id, provider, mailbox_id,
      provider_message_id, direction, received_at, content_digest, idempotency_key
    ) values (
      ${id}, ${family}, ${isEmail ? "submissions.email_reply.v1" : "manual.v1"}, ${`event-${key}`},
      ${isEmail ? "gmail" : null}, ${isEmail ? "mailbox-test" : null},
      ${isEmail ? `message-${key}` : null}, ${isEmail ? "inbound" : "manual"},
      ${receivedAt}, ${digest(key)}, ${`source:${key}`}
    )
  `;
  return id;
}

async function preparingPair({ candidate = `candidate-${randomUUID()}`, role = `role-${randomUUID()}` } = {}) {
  const signal = await sourceEvent();
  const id = randomUUID();
  await sql`
    insert into submissions_v2.candidate_role_pairs (
      id, candidate_user_id, role_id, first_signal_id, intent_state,
      workflow_state, original_signal_at, role_state
    ) values (
      ${id}, ${candidate}, ${role}, ${signal}, 'interested',
      'preparing_resume', clock_timestamp(), 'active'
    )
  `;
  return { id, signal, candidate, role };
}

before(async () => {
  await runMigrations({ databaseUrl, logger: { info() {} } });
  sql = createDatabase({ databaseUrl, max: 8 });
  await sql.unsafe(`
    truncate table
      submissions_v2.private_object_bindings,
      submissions_v2.case_deletion_audit,
      submissions_v2.case_deletions,
      submissions_v2.download_tickets,
      submissions_v2.download_audit,
      submissions_v2.private_object_reservations,
      submissions_v2.notification_outbox,
      submissions_v2.submission_proofs,
      submissions_v2.artifact_deletions,
      submissions_v2.resume_artifacts,
      submissions_v2.claim_validations,
      submissions_v2.claim_evidence_links,
      submissions_v2.resume_claims,
      submissions_v2.resume_supplements,
      submissions_v2.resume_sources,
      submissions_v2.resume_stage_runs,
      submissions_v2.resume_generations,
      submissions_v2.job_attempts,
      submissions_v2.jobs,
      submissions_v2.api_commands,
      submissions_v2.role_index,
      submissions_v2.candidate_index,
      submissions_v2.source_health,
      submissions_v2.source_runs,
      submissions_v2.source_cursors,
      submissions_v2.curated_snapshots,
      submissions_v2.classification_attempts,
      submissions_v2.not_interested_entries,
      submissions_v2.review_items,
      submissions_v2.pair_events,
      submissions_v2.candidate_role_pairs,
      submissions_v2.signal_role_decisions,
      submissions_v2.source_offered_roles,
      submissions_v2.source_events
    restart identity cascade
  `);
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

test("migrations are digest-checked and idempotent", async () => {
  const result = await runMigrations({ databaseUrl, logger: { info() {} } });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, [
    "001_foundation.sql", "002_guards_and_leases.sql",
    "003_case_retention.sql", "004_supplement_quarantine.sql", "005_isolated_case_purge.sql",
    "006_notification_delivery_fences.sql",
    "007_upload_reservations.sql",
    "008_download_completion_audit.sql",
    "009_resilience_and_redemption.sql",
    "010_first_response_privacy_and_audit.sql",
    "011_isolated_routine_object_purge.sql",
  ]);
  const tables = await sql`
    select count(*)::integer as count
      from information_schema.tables
     where table_schema = 'submissions_v2'
  `;
  assert.ok(tables[0].count >= 30);
  assert.equal((await sql`select has_function_privilege('public', 'submissions_v2.set_runtime_controls(text,text,boolean,boolean,boolean,boolean,boolean)', 'EXECUTE') as allowed`)[0].allowed, false);
  const purgeRole = (await sql`select 1 as present from pg_roles where rolname='submissions_v2_purge'`)[0];
  if (purgeRole) {
    assert.equal((await sql`select has_function_privilege('submissions_v2_purge', 'submissions_v2.set_runtime_controls(text,text,boolean,boolean,boolean,boolean,boolean)', 'EXECUTE') as allowed`)[0].allowed, false);
  }
});

test("candidate-role advisory lock keys are collision-safe UTF-8 accepted by Postgres", async () => {
  const key = repositoryInternals.pairAdvisoryLockKey("candidate\u0000with-delimiter", "role/with/slash");
  assert.equal(key.includes("\u0000"), false);
  assert.deepEqual(JSON.parse(key), ["candidate\u0000with-delimiter", "role/with/slash"]);
  const rows = await sql`select hashtextextended(${key}, 0)::text as lock_hash`;
  assert.match(rows[0].lock_hash, /^-?\d+$/u);
});

test("the pure state contract rejects invalid and stale pair transitions", () => {
  const current = {
    intent_state: "interested",
    workflow_state: "preparing_resume",
    submission_status: "none",
    state_version: 4,
  };
  const next = nextPairState(current, {
    workflow_state: "interested",
    current_artifact_id: randomUUID(),
    resume_ready_at: new Date().toISOString(),
  }, 4);
  assert.equal(next.state_version, 5);
  assert.throws(() => nextPairState(current, { workflow_state: "not_interested" }, 3), PairStateError);
  assert.throws(() => assertPairState({
    ...current,
    workflow_state: "interested",
  }), /current artifact/);
  assert.throws(() => assertPairState({
    ...next,
    submission_status: "proven",
    workflow_state: "needs_review",
    intent_state: "unclear",
  }), /proven submission/);
});

test("source evidence is replay-safe and immutable while processing state may advance", async () => {
  const key = randomUUID();
  const id = await sourceEvent({ family: "email", key });
  await assert.rejects(
    sourceEvent({ family: "email", key: `${key}-other` }).then(async (otherId) => {
      await sql`
        update submissions_v2.source_events
           set mailbox_id = 'mailbox-test', provider_message_id = ${`message-${key}`}
         where id = ${otherId}
      `;
    }),
    /source event evidence is immutable|duplicate key/,
  );
  await sql`
    update submissions_v2.source_events
       set processing_state = 'ready', processed_at = clock_timestamp()
     where id = ${id}
  `;
  await assert.rejects(
    sql`update submissions_v2.source_events set content_digest = ${digest("changed")} where id = ${id}`,
    /source event evidence is immutable/,
  );
});

test("email intake cannot commit a source after its private-object write lease expires", async () => {
  const repository = createRepository({ sql });
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable source-object lease regression",
    ui: prior.ui_enabled, ingestion: true, generation: prior.generation_enabled,
    masterInbox: true, curated: prior.curated_enabled,
  }, sql);
  const reservationId = randomUUID();
  const eventId = randomUUID();
  const objectKey = `submissions/resumes/v2/events/${eventId}.json`;
  const objectDigest = digest(`object:${eventId}`);
  await sql`
    insert into submissions_v2.private_object_reservations(
      id, object_key, purpose, owner_ref, expected_digest, state, expires_at,
      write_owner, write_lease_expires_at, write_fencing_token
    ) values (
      ${reservationId}, ${objectKey}, 'source_event', ${eventId}, ${objectDigest}, 'pending',
      clock_timestamp() + interval '1 day', 'expired-writer', clock_timestamp() - interval '1 second', 1
    )
  `;
  const event = {
    schema_version: "submissions.email_reply.v1", event_id: eventId,
    provider: "master_inbox", mailbox_id: "mailbox-test", provider_message_id: `message-${eventId}`,
    provider_thread_id: `thread-${eventId}`, outbound_message_id: `outbound-${eventId}`,
    sent_at: new Date().toISOString(), received_at: new Date().toISOString(),
    content_digest: digest(`content:${eventId}`), sender_display_name: "Candidate",
    sender_match_hmac: null, previous_sender_match_hmac: null, machine_message: false,
    idempotency_key: `source:${eventId}`,
  };
  await assert.rejects(
    repository.recordEmailSource({
      event, safeEnvelope: {}, privateObjectKey: objectKey,
      objectReservationId: reservationId, objectWriteFencingToken: 1,
      objectDigest, processingState: "ready", candidateResolution: null,
    }),
    (error) => error.code === "private_object_reservation_fence_lost",
  );
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.source_events where idempotency_key=${event.idempotency_key}`)[0].count, 0);
  assert.equal((await sql`select state from submissions_v2.private_object_reservations where id=${reservationId}`)[0].state, "pending");
});

test("email intake keeps one immutable provider-event object owner through commit", async () => {
  const repository = createRepository({ sql });
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable source object binding regression",
    ui: prior.ui_enabled, ingestion: true, generation: prior.generation_enabled,
    masterInbox: true, curated: prior.curated_enabled,
  }, sql);
  const eventId = `binding-${randomUUID()}`;
  const objectKey = `submissions/resumes/v2/events/${randomUUID()}`;
  const objectDigest = digest(`object:${eventId}`);
  const reservation = await repository.reservePrivateObject({
    reservationId: randomUUID(), objectKey, purpose: "source_event", ownerRef: eventId,
    expectedDigest: objectDigest, expiresAt: Date.now() + 24 * 60 * 60_000,
  });
  const leased = await repository.renewPrivateObjectWrite({
    reservationId: reservation.id, objectKey, expectedDigest: objectDigest,
    writeFencingToken: reservation.write_fencing_token,
  });
  const event = {
    schema_version: "submissions.email_reply.v1", event_id: eventId,
    provider: "master_inbox", mailbox_id: "mailbox-test", provider_message_id: `message-${eventId}`,
    provider_thread_id: `thread-${eventId}`, outbound_message_id: `outbound-${eventId}`,
    sent_at: new Date().toISOString(), received_at: new Date().toISOString(),
    content_digest: digest(`content:${eventId}`), sender_display_name: "Candidate",
    sender_match_hmac: null, previous_sender_match_hmac: null, machine_message: false,
    idempotency_key: `source:${eventId}`, offered_roles: [],
  };
  const recorded = await repository.recordEmailSource({
    event, safeEnvelope: {}, privateObjectKey: objectKey,
    objectReservationId: reservation.id, objectWriteFencingToken: leased.write_fencing_token,
    objectDigest, processingState: "needs_role", candidateResolution: null,
  });
  const persisted = (await sql`
    select reservation.owner_ref, reservation.state, binding.owner_table,
           binding.owner_id, binding.owner_binding_ref
      from submissions_v2.private_object_reservations reservation
      join submissions_v2.private_object_bindings binding on binding.object_key=reservation.object_key
     where reservation.id=${reservation.id}
  `)[0];
  assert.equal(recorded.source.event_id, eventId);
  assert.deepEqual(persisted, {
    owner_ref: eventId,
    state: "committed",
    owner_table: "source_events",
    owner_id: recorded.source.id,
    owner_binding_ref: eventId,
  });
});

test("exact pair identity, first response, review consistency, and pair ledger are database-enforced", async () => {
  const pair = await preparingPair();
  const laterSignal = await sourceEvent();
  await assert.rejects(
    sql`
      insert into submissions_v2.candidate_role_pairs (
        candidate_user_id, role_id, first_signal_id, intent_state, workflow_state, original_signal_at
      ) values (${pair.candidate}, ${pair.role}, ${laterSignal}, 'interested', 'preparing_resume', clock_timestamp())
    `,
    /duplicate key/,
  );
  await assert.rejects(
    sql`update submissions_v2.candidate_role_pairs set candidate_user_id = 'changed' where id = ${pair.id}`,
    /identity and first signal are immutable/,
  );
  await sql`
    insert into submissions_v2.pair_events (
      pair_id, actor_type, actor_id, source, event_type, expected_version, new_version, idempotency_key
    ) values (${pair.id}, 'human', 'teammate@raydar.xyz', 'manual', 'pair_created', 0, 1, ${randomUUID()})
  `;
  await assert.rejects(
    sql`update submissions_v2.pair_events set event_type = 'rewritten' where pair_id = ${pair.id}`,
    /append-only/,
  );

  const reviewSignal = await sourceEvent();
  const reviewPair = randomUUID();
  await sql.begin(async (transaction) => {
    await transaction`
      insert into submissions_v2.candidate_role_pairs (
        id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state, original_signal_at
      ) values (${reviewPair}, ${`candidate-${randomUUID()}`}, ${`role-${randomUUID()}`},
                ${reviewSignal}, 'interested', 'needs_review', clock_timestamp())
    `;
    await transaction`
      insert into submissions_v2.review_items (pair_id, reason_code, safe_detail)
      values (${reviewPair}, 'candidate_original_resume_missing', 'Original resume is unavailable')
    `;
  });
  await assert.rejects(
    sql`update submissions_v2.review_items set action_state = 'resolved', resolved_at = clock_timestamp(), resolved_by = 'teammate@raydar.xyz' where pair_id = ${reviewPair}`,
    /Needs Review pair requires an open blocking reason/,
  );
});

test("human review can bind a missing-role signal to an exact active Paraform role", async () => {
  const repository = createRepository({ sql });
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable missing-role recovery regression",
    ui: true, ingestion: true, generation: prior.generation_enabled, masterInbox: true,
    curated: prior.curated_enabled,
  }, sql);
  const candidateId = `candidate-role-recovery-${randomUUID()}`;
  const roleId = `role-recovery-${randomUUID()}`;
  const signalId = randomUUID();
  const eventId = `event-role-recovery-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (
      ${candidateId}, 'Role Recovery Candidate', 'role recovery candidate', 'role recovery candidate', true,
      ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
    )
  `;
  await sql`
    insert into submissions_v2.role_index(
      role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
    ) values (
      ${roleId}, 'Recovery Company', 'Recovery Engineer', 'recovery company recovery engineer', true,
      ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)}
    )
  `;
  await sql`
    insert into submissions_v2.source_events(
      id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
      direction, received_at, content_digest, processing_state, safe_error_code,
      safe_error_detail, idempotency_key, envelope
    ) values (
      ${signalId}, 'email', 'submissions.email_reply.v1', ${eventId}, 'master_inbox', 'mailbox-test',
      ${`message-${eventId}`}, 'inbound', clock_timestamp(), ${digest(signalId)}, 'needs_role',
      'role_unclear', 'The exact offered role was not present in the source contract.',
      ${`source:${signalId}`}, ${sql.json({ candidate_resolution: { candidate_user_id: candidateId } })}
    )
  `;
  await sql`
    insert into submissions_v2.review_items(unresolved_signal_id, reason_code, safe_detail)
    values (${signalId}, 'role_unclear', 'Select the exact role confirmed from the source email.')
  `;
  const result = await repository.bindUnresolvedSignal({
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(), signalId,
    candidateId, roleIds: [roleId], note: "Confirmed the role from the linked source email.",
  });
  assert.deepEqual(result.role_ids, [roleId]);
  assert.ok(result.job_id);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.source_offered_roles where signal_id=${signalId} and role_id=${roleId}`)[0].count, 1);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.first_response_claims where signal_id=${signalId} and role_id=${roleId} and released_at is null`)[0].count, 1);
  assert.equal((await sql`select processing_state from submissions_v2.source_events where id=${signalId}`)[0].processing_state, "ready");
  await sql`update submissions_v2.candidate_index set active=false where candidate_user_id=${candidateId}`;
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore controls after missing-role recovery regression",
    ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
});

test("a multi-role reply releases unmentioned roles for their later first response", async () => {
  const repository = createRepository({ sql });
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable multi-role first-response release regression",
    ui: prior.ui_enabled, ingestion: true, generation: true, masterInbox: true,
    curated: prior.curated_enabled,
  }, sql);
  const candidateId = `candidate-multi-${randomUUID()}`;
  const roleA = `role-a-${randomUUID()}`;
  const roleB = `role-b-${randomUUID()}`;
  const signalId = randomUUID();
  const eventId = `event-multi-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (
      ${candidateId}, 'Multi Role Candidate', 'multi role candidate', 'multi role candidate', true,
      ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
    )
  `;
  for (const [roleId, title] of [[roleA, "Role A"], [roleB, "Role B"]]) {
    await sql`
      insert into submissions_v2.role_index(
        role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
      ) values (
        ${roleId}, 'Multi Company', ${title}, ${`multi company ${title.toLowerCase()}`}, true,
        ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)}
      )
    `;
  }
  await sql`
    insert into submissions_v2.source_events(
      id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
      direction, received_at, content_digest, processing_state, idempotency_key, envelope
    ) values (
      ${signalId}, 'email', 'submissions.email_reply.v1', ${eventId}, 'master_inbox', 'mailbox-test',
      ${`message-${eventId}`}, 'inbound', clock_timestamp(), ${digest(signalId)}, 'ready',
      ${`source:${signalId}`}, ${sql.json({ candidate_resolution: { candidate_user_id: candidateId } })}
    )
  `;
  await sql`
    insert into submissions_v2.source_offered_roles(
      signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, offered_order, content_digest
    ) values
      (${signalId}, ${roleA}, 'Multi Company', 'Role A', ${`https://www.paraform.com/browse?role=${roleA}`}, 0, ${digest(`${signalId}:${roleA}`)}),
      (${signalId}, ${roleB}, 'Multi Company', 'Role B', ${`https://www.paraform.com/browse?role=${roleB}`}, 1, ${digest(`${signalId}:${roleB}`)})
  `;
  await sql`
    insert into submissions_v2.first_response_claims(
      candidate_user_id, role_id, event_id, source_family, signal_id, committed_at
    ) values
      (${candidateId}, ${roleA}, ${eventId}, 'email', ${signalId}, clock_timestamp()),
      (${candidateId}, ${roleB}, ${eventId}, 'email', ${signalId}, clock_timestamp())
  `;
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch)
    values (${jobId}, 'classify_email_reply', 'signal', ${signalId}, ${`job:${jobId}`}, 'master_inbox', ${enabled.control_epoch})
  `;
  const claimed = (await claimJobs({
    workerId: "multi-role-worker", kinds: ["classify_email_reply"], limit: 1,
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql))[0];
  await repository.applyClassifiedSignal({
    signalId, candidateId,
    decisions: [{ role_id: roleA, label: "interested", quote: "I am interested in Role A.", review_reason: null, negative_reason: null }],
    attempts: [{ outcome: "accepted", model: "test-model" }],
    executionFence: {
      jobId: claimed.id, workerId: claimed.lease_owner,
      fencingToken: Number(claimed.fencing_token), controlEpoch: Number(enabled.control_epoch),
    },
  });
  const claims = await sql`
    select role_id, released_at is not null as released, release_reason
      from submissions_v2.first_response_claims where signal_id=${signalId} order by role_id
  `;
  assert.deepEqual([...claims], [
    { role_id: roleA, released: false, release_reason: null },
    { role_id: roleB, released: true, release_reason: "unmentioned_role" },
  ]);
  const later = await repository.claimEmailFirstResponse({
    eventId: `later-${randomUUID()}`, idempotencyKey: `later:${randomUUID()}`,
    candidateId, offeredRoles: [{ role_id: roleB }],
  });
  assert.deepEqual(later.eligible_role_ids, [roleB]);
  assert.equal(later.ignored_later, false);
  await sql`update submissions_v2.candidate_index set active=false where candidate_user_id=${candidateId}`;
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore controls after multi-role first-response release regression",
    ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
});

test("a later classified reply never attaches to an existing or hidden first-response pair", async () => {
  const repository = createRepository({ sql });
  const priorControls = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable hidden-pair classification regression",
    ui: priorControls.ui_enabled, ingestion: true, generation: true, masterInbox: true,
    curated: priorControls.curated_enabled,
  }, sql);
  const candidateId = `candidate-${randomUUID()}`;
  const roleId = `role-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key,
      active, paraform_profile_url, last_confirmed_at, source_digest
    ) values (${candidateId}, 'Hidden Candidate', 'hidden candidate', 'hidden candidate',
              true, ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)})
  `;
  await sql`
    insert into submissions_v2.role_index(role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest)
    values (${roleId}, 'Hidden Company', 'Engineer', 'hidden company engineer', true, ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)})
  `;
  const pair = await preparingPair({ candidate: candidateId, role: roleId });
  await sql`update submissions_v2.candidate_role_pairs set case_hidden_at=clock_timestamp(), state_version=state_version+1 where id=${pair.id}`;
  const signalId = randomUUID();
  await sql`
    insert into submissions_v2.source_events(
      id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
      direction, received_at, content_digest, processing_state, idempotency_key, envelope
    ) values (
      ${signalId}, 'email', 'submissions.email_reply.v1', ${`event-${signalId}`}, 'master_inbox',
      'mailbox-test', ${`message-${signalId}`}, 'inbound', clock_timestamp(), ${digest(signalId)},
      'ready', ${`source:${signalId}`}, ${sql.json({ candidate_resolution: { candidate_user_id: candidateId } })}
    )
  `;
  await sql`
    insert into submissions_v2.source_offered_roles(signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, content_digest)
    values (${signalId}, ${roleId}, 'Hidden Company', 'Engineer', ${`https://www.paraform.com/browse?role=${roleId}`}, ${digest(`${signalId}:${roleId}`)})
  `;
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch)
    values (${jobId}, 'classify_email_reply', 'signal', ${signalId}, ${`job:${jobId}`}, 'master_inbox', ${enabled.control_epoch})
  `;
  const claimed = (await claimJobs({ workerId: 'hidden-pair-worker', kinds: ['classify_email_reply'], limit: 1, leaseSeconds: 120, controlEpoch: enabled.control_epoch }, sql))[0];
  const result = await repository.applyClassifiedSignal({
    signalId, candidateId,
    decisions: [{ role_id: roleId, label: 'interested', quote: 'Yes', review_reason: null, negative_reason: null }],
    attempts: [{ outcome: 'accepted', model: 'test-model' }],
    executionFence: { jobId: claimed.id, workerId: claimed.lease_owner, fencingToken: Number(claimed.fencing_token), controlEpoch: Number(enabled.control_epoch) },
  });
  assert.equal(result.created_count, 0);
  assert.equal(result.pairs[0].state, 'ignored_later');
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.pair_signal_links where signal_id=${signalId}`)[0].count, 0);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.signal_role_decisions where signal_id=${signalId}`)[0].count, 0);
  assert.equal((await sql`select processing_state from submissions_v2.source_events where id=${signalId}`)[0].processing_state, 'ignored_later');
  await sql`update submissions_v2.candidate_index set active=false where candidate_user_id=${candidateId}`;
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore controls after hidden-pair classification regression",
    ui: priorControls.ui_enabled, ingestion: priorControls.ingestion_enabled, generation: priorControls.generation_enabled,
    masterInbox: priorControls.master_inbox_enabled, curated: priorControls.curated_enabled,
  }, sql);
});

test("a later hidden-pair email is dropped before Blob storage and classifier access", async () => {
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable intake privacy regression",
    ui: prior.ui_enabled, ingestion: true, generation: prior.generation_enabled,
    masterInbox: true, curated: prior.curated_enabled,
  }, sql);
  const candidateId = `candidate-${randomUUID()}`;
  const roleId = `role-${randomUUID()}`;
  const matchHmac = `match-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      email_match_hmac_current, email_match_hmac_current_version,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (
      ${candidateId}, 'Private Candidate', 'private candidate', 'private candidate', true,
      ${matchHmac}, 'v1', ${`https://www.paraform.com/candidates?candidate=${candidateId}`},
      clock_timestamp(), ${digest(candidateId)}
    )
  `;
  const pair = await preparingPair({ candidate: candidateId, role: roleId });
  await sql`update submissions_v2.candidate_role_pairs set case_hidden_at=clock_timestamp(), state_version=state_version+1 where id=${pair.id}`;
  let blobWrites = 0;
  let classifierCalls = 0;
  const service = createService({
    repository: createRepository({ sql }),
    env: {
      SUBMISSIONS_V2_UI_ENABLED: "true", SUBMISSIONS_V2_INGESTION_ENABLED: "true",
      SUBMISSIONS_V2_GENERATION_ENABLED: "true", SUBMISSIONS_V2_MASTER_INBOX_ENABLED: "true",
      SUBMISSIONS_V2_CURATED_ENABLED: "true",
      SUBMISSIONS_V2_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    },
    classifier: async () => { classifierCalls += 1; return {}; },
    blob: { putPrivateObject: async () => { blobWrites += 1; } },
  });
  const eventId = `privacy-${randomUUID()}`;
  const result = await service.intakeMasterInbox({
    id: eventId, eventKey: `master-inbox:${eventId}:${roleId}`, contractVersion: 1,
    family: "new_match", mailboxId: "privacy-mailbox", providerMessageId: eventId,
    senderMatchHmac: { key_version: "v1", digest: matchHmac }, roleId,
    payload: { receivedAt: new Date().toISOString(), candidateText: "Yes, please submit me.", sentMessageText: "Are you interested?", conversationId: eventId },
  });
  assert.equal(result.processing_state, "ignored_later");
  assert.equal(result.signal_id, null);
  assert.equal(blobWrites, 0);
  assert.equal(classifierCalls, 0);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.source_events where provider_message_id=${eventId}`)[0].count, 0);
  assert.equal((await sql`select event_count from submissions_v2.privacy_safe_metrics where metric_key='later_signal_dropped'`)[0].event_count >= 1, true);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore controls after intake privacy regression",
    ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
});

test("classification-failure replay stays terminal until an approved retry recovers the same pair", async () => {
  const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });
  const priorControls = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable classification-failure replay regression",
    ui: priorControls.ui_enabled, ingestion: true, generation: true, masterInbox: true,
    curated: priorControls.curated_enabled,
  }, sql);
  const candidateId = `candidate-${randomUUID()}`;
  const roleId = `role-${randomUUID()}`;
  const signalId = randomUUID();
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (
      ${candidateId}, 'Replay Candidate', 'replay candidate', 'replay candidate', true,
      ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
    )
  `;
  await sql`
    insert into submissions_v2.role_index(
      role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
    ) values (
      ${roleId}, 'Replay Company', 'Replay Role', 'replay company replay role', true,
      ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)}
    )
  `;
  await sql`
    insert into submissions_v2.source_events(
      id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
      direction, received_at, content_digest, processing_state, idempotency_key, envelope
    ) values (
      ${signalId}, 'email', 'submissions.email_reply.v1', ${`event-${signalId}`}, 'master_inbox',
      'mailbox-test', ${`message-${signalId}`}, 'inbound', clock_timestamp(), ${digest(signalId)},
      'ready', ${`source:${signalId}`}, ${sql.json({ candidate_resolution: { candidate_user_id: candidateId } })}
    )
  `;
  await sql`
    insert into submissions_v2.source_offered_roles(
      signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, content_digest
    ) values (
      ${signalId}, ${roleId}, 'Replay Company', 'Replay Role',
      ${`https://www.paraform.com/browse?role=${roleId}`}, ${digest(`${signalId}:${roleId}`)}
    )
  `;
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch)
    values (${jobId}, 'classify_email_reply', 'signal', ${signalId}, ${`job:${jobId}`}, 'master_inbox', ${enabled.control_epoch})
  `;
  const claimed = (await claimJobs({
    workerId: 'classification-replay-worker', kinds: ['classify_email_reply'], limit: 1,
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql))[0];
  const input = {
    signalId,
    attempts: [{ outcome: 'failed', model: 'test-model', reason: 'provider_timeout' }],
    safeDetail: 'Both classifier paths failed safely.',
    executionFence: {
      jobId: claimed.id, workerId: claimed.lease_owner,
      fencingToken: Number(claimed.fencing_token), controlEpoch: Number(enabled.control_epoch),
    },
  };
  const first = await repository.routeClassificationFailure(input);
  const replay = await repository.routeClassificationFailure(input);
  assert.equal(first.existing, undefined);
  assert.equal(replay.existing, true);
  assert.equal((await sql`select processing_state from submissions_v2.source_events where id=${signalId}`)[0].processing_state, 'quarantined');
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.review_items where pair_id=${first.pairs[0]}`)[0].count, 1);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.pair_signal_links where signal_id=${signalId}`)[0].count, 1);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.notification_outbox where pair_id=${first.pairs[0]}`)[0].count, 1);
  const retryJobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch)
    values (${retryJobId}, 'classify_email_reply', 'signal', ${signalId}, ${`job:${retryJobId}`}, 'master_inbox', ${enabled.control_epoch})
  `;
  const retryClaim = (await claimJobs({
    workerId: 'classification-retry-worker', kinds: ['classify_email_reply'], limit: 1,
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql))[0];
  const recovered = await repository.applyClassifiedSignal({
    signalId,
    candidateId,
    decisions: [{ role_id: roleId, label: 'interested', quote: 'Yes, I am interested.', review_reason: null, negative_reason: null }],
    attempts: [{ outcome: 'accepted', model: 'test-model' }],
    executionFence: {
      jobId: retryClaim.id, workerId: retryClaim.lease_owner,
      fencingToken: Number(retryClaim.fencing_token), controlEpoch: Number(enabled.control_epoch),
    },
  });
  assert.equal(recovered.created_count, 0);
  assert.equal(recovered.recovered_count, 1);
  assert.equal(recovered.pairs[0].pair_id, first.pairs[0]);
  assert.equal((await sql`select processing_state from submissions_v2.source_events where id=${signalId}`)[0].processing_state, 'resolved');
  assert.equal((await sql`select workflow_state from submissions_v2.candidate_role_pairs where id=${first.pairs[0]}`)[0].workflow_state, 'preparing_resume');
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.review_items where pair_id=${first.pairs[0]} and action_state='open'`)[0].count, 0);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.jobs where kind='prepare_resume' and subject_id=${first.pairs[0]}::text`)[0].count, 1);
  const attemptAudit = await sql`
    select attempt, execution_id, attempt_in_execution, outcome
      from submissions_v2.classification_attempts where signal_id=${signalId} order by attempt
  `;
  assert.equal(attemptAudit.length, 2);
  assert.equal(attemptAudit[0].outcome, 'timeout');
  assert.equal(attemptAudit[1].outcome, 'passed');
  assert.notEqual(attemptAudit[0].execution_id, attemptAudit[1].execution_id);
  await sql`update submissions_v2.candidate_index set active=false where candidate_user_id=${candidateId}`;
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore controls after classification-failure replay regression",
    ui: priorControls.ui_enabled, ingestion: priorControls.ingestion_enabled, generation: priorControls.generation_enabled,
    masterInbox: priorControls.master_inbox_enabled, curated: priorControls.curated_enabled,
  }, sql);
});

test("human recovery commands reject terminal sources and non-Interested resume retries", async () => {
  const repository = createRepository({ sql });
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable human recovery authority regression",
    ui: true, ingestion: true, generation: true, masterInbox: true, curated: prior.curated_enabled,
  }, sql);
  const terminalSignal = await sourceEvent();
  await sql`update submissions_v2.source_events set processing_state='resolved', processed_at=clock_timestamp() where id=${terminalSignal}`;
  await assert.rejects(
    repository.bindUnresolvedSignal({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
      signalId: terminalSignal, candidateId: "candidate-other", roleIds: [], note: "wrong candidate",
    }),
    (error) => error.code === "source_not_unresolved",
  );

  const pair = await preparingPair();
  await sql`
    update submissions_v2.candidate_role_pairs
       set intent_state='not_interested', workflow_state='not_interested', state_version=state_version+1
     where id=${pair.id}
  `;
  await assert.rejects(
    repository.enqueuePairAction({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
      pairId: pair.id, expectedVersion: 2, action: "retry_preparation",
      kind: "prepare_resume", requiredControl: "generation", checkpoint: { trigger_kind: "retry" },
    }),
    (error) => error.code === "resume_retry_not_eligible",
  );
  const maliciousJobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(
      id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch,
      state, lease_owner, lease_expires_at, fencing_token, attempt_count, started_at
    ) values (
      ${maliciousJobId}, 'prepare_resume', 'pair', ${pair.id}::text, ${randomUUID()}, 'generation',
      ${(await readRuntimeControls(sql)).control_epoch}, 'running', 'malicious-worker',
      clock_timestamp() + interval '2 minutes', 1, 1, clock_timestamp()
    )
  `;
  await assert.rejects(
    repository.startResumeGeneration({
      pairId: pair.id, triggerKind: "retry", idempotencyKey: randomUUID(), expectedPairVersion: 2,
      primaryModelPin: "claude-opus-5", fallbackModelPin: "claude-opus-4.8",
      validatorModelPin: "gpt-5.4", promptPin: "test", templatePin: "test",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      executionFence: {
        jobId: maliciousJobId, workerId: "malicious-worker", fencingToken: 1,
        controlEpoch: (await readRuntimeControls(sql)).control_epoch,
      },
    }),
    (error) => error.code === "generation_pair_not_eligible",
  );
});

test("artifact promotion requires the complete validated PDF, ATS, and manifest set", async () => {
  const pair = await preparingPair();
  const generationId = randomUUID();
  const deadline = new Date(Date.now() + 5 * 60_000);
  await sql`
    insert into submissions_v2.resume_generations (
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, deadline_at
    ) values (
      ${generationId}, ${pair.id}, 1, 'initial', ${randomUUID()}, 'archiving', 'archive',
      1, ${pair.signal}, 'claude-opus-5', 'claude-opus-5', 'gpt-5.4-2026-03-05',
      'resume-v2', 'raydar-resume-v1', ${deadline}
    )
  `;
  const pdfId = randomUUID();
  await sql`
    insert into submissions_v2.resume_artifacts (
      id, pair_id, generation_id, artifact_version, kind, private_object_key, digest,
      size_bytes, page_count, text_digest, validation_status, archive_readback_at,
      archived_at, current_state
    ) values (
      ${pdfId}, ${pair.id}, ${generationId}, 1, 'pdf', ${`submissions/resumes/v2/${pair.id}/resume.pdf`},
      ${digest("pdf")}, 1000, 1, ${digest("text")}, 'passed', clock_timestamp(), clock_timestamp(), 'current'
    )
  `;
  await assert.rejects(
    sql`
      update submissions_v2.candidate_role_pairs
         set workflow_state = 'interested', current_artifact_id = ${pdfId},
             resume_ready_at = clock_timestamp(), state_version = state_version + 1
       where id = ${pair.id}
    `,
    /PDF, ATS, and manifest/,
  );
  for (const kind of ["ats", "manifest"]) {
    await sql`
      insert into submissions_v2.resume_artifacts (
        pair_id, generation_id, artifact_version, kind, private_object_key, digest,
        size_bytes, text_digest, validation_status, archive_readback_at, archived_at, current_state
      ) values (
        ${pair.id}, ${generationId}, 1, ${kind}, ${`submissions/resumes/v2/${pair.id}/${kind}.txt`},
        ${digest(kind)}, 500, ${digest(`${kind}-text`)}, 'passed', clock_timestamp(), clock_timestamp(), 'current'
      )
    `;
  }
  await sql`
    update submissions_v2.candidate_role_pairs
       set workflow_state = 'interested', current_artifact_id = ${pdfId},
           resume_ready_at = clock_timestamp(), state_version = state_version + 1
     where id = ${pair.id}
  `;
  const rows = await sql`select workflow_state from submissions_v2.candidate_role_pairs where id = ${pair.id}`;
  assert.equal(rows[0].workflow_state, "interested");
});

test("download tickets replay one issuance and redeem exactly once", async () => {
  const repository = createRepository({ sql });
  const priorControls = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "test@raydar.xyz", reason: "Enable UI for download command test",
    ui: true, ingestion: priorControls.ingestion_enabled, generation: priorControls.generation_enabled,
    masterInbox: priorControls.master_inbox_enabled, curated: priorControls.curated_enabled,
  }, sql);
  const pair = await preparingPair();
  const generationId = randomUUID();
  const deadline = new Date(Date.now() + 5 * 60_000);
  await sql`
    insert into submissions_v2.resume_generations (
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, deadline_at
    ) values (
      ${generationId}, ${pair.id}, 1, 'initial', ${randomUUID()}, 'succeeded', 'complete',
      1, ${pair.signal}, 'claude-opus-5', 'claude-opus-5', 'gpt-5.4-2026-03-05',
      'resume-v2', 'raydar-resume-v1', ${deadline}
    )
  `;
  let pdfId;
  for (const kind of ["pdf", "ats", "manifest"]) {
    const artifactId = randomUUID();
    if (kind === "pdf") pdfId = artifactId;
    await sql`
      insert into submissions_v2.resume_artifacts (
        id, pair_id, generation_id, artifact_version, kind, private_object_key, digest,
        size_bytes, page_count, text_digest, validation_status, archive_readback_at,
        archived_at, current_state
      ) values (
        ${artifactId}, ${pair.id}, ${generationId}, 1, ${kind},
        ${`submissions/resumes/v2/${pair.id}/${kind}`}, ${digest(kind)}, 500,
        ${kind === "pdf" ? 1 : null}, ${digest(`${kind}-text`)}, 'passed',
        clock_timestamp(), clock_timestamp(), 'current'
      )
    `;
  }
  await sql`
    update submissions_v2.candidate_role_pairs
       set workflow_state='interested', current_artifact_id=${pdfId},
           resume_ready_at=clock_timestamp(), state_version=state_version+1
     where id=${pair.id}
  `;
  const ticketId = randomUUID();
  const expiresAt = Date.now() + 5 * 60_000;
  const first = await repository.issueDownload({
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: `download:${pair.id}`,
    pairId: pair.id, expectedVersion: 2, ticketId, expiresAt,
  });
  const replay = await repository.issueDownload({
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: `download:${pair.id}`,
    pairId: pair.id, expectedVersion: 2, ticketId: randomUUID(), expiresAt: Date.now() + 60_000,
  });
  assert.equal(replay.ticket_id, first.ticket_id);
  await repository.redeemDownloadTicket({
    ticketId, actorEmail: "recruiter@raydar.xyz", artifactId: pdfId, pairId: pair.id,
    pathname: first.artifact.private_object_key, disposition: "attachment", requestDigest: digest("request"),
  });
  await assert.rejects(() => repository.redeemDownloadTicket({
    ticketId, actorEmail: "recruiter@raydar.xyz", artifactId: pdfId, pairId: pair.id,
    pathname: first.artifact.private_object_key, disposition: "attachment", requestDigest: digest("request"),
  }), (error) => error.code === "download_ticket_already_used" && error.status === 410);
  const raceTicketId = randomUUID();
  const raced = await repository.issueDownload({
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: `download-race:${pair.id}`,
    pairId: pair.id, expectedVersion: 2, ticketId: raceTicketId, expiresAt: Date.now() + 5 * 60_000,
  });
  assert.ok(await repository.downloadableArtifact({ artifactId: pdfId, pairId: pair.id, pathname: raced.artifact.private_object_key }));
  await sql`
    update submissions_v2.candidate_role_pairs
       set case_hidden_at=clock_timestamp(), state_version=state_version+1
     where id=${pair.id}
  `;
  await assert.rejects(() => repository.redeemDownloadTicket({
    ticketId: raceTicketId, actorEmail: "recruiter@raydar.xyz", artifactId: pdfId, pairId: pair.id,
    pathname: raced.artifact.private_object_key, disposition: "attachment", requestDigest: digest("race-request"),
  }), (error) => error.code === "artifact_not_found");
  assert.equal((await sql`select state from submissions_v2.download_tickets where ticket_id=${raceTicketId}`)[0].state, "issued");
  const audits = await sql`
    select result from submissions_v2.download_audit where ticket_id=${ticketId} order by requested_at, id
  `;
  assert.deepEqual(audits.map((row) => row.result), ["issued", "completed"]);
  await setRuntimeControls({
    actorEmail: "test@raydar.xyz", reason: "Restore controls after download command test",
    ui: priorControls.ui_enabled, ingestion: priorControls.ingestion_enabled,
    generation: priorControls.generation_enabled, masterInbox: priorControls.master_inbox_enabled,
    curated: priorControls.curated_enabled,
  }, sql);
});

test("DB-time leases use SKIP LOCKED, fencing tokens, and durable control epochs", async () => {
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz",
    reason: "Enable nonproduction generation lease test",
    ui: prior.ui_enabled,
    ingestion: prior.ingestion_enabled,
    generation: true,
    masterInbox: prior.master_inbox_enabled,
    curated: prior.curated_enabled,
  }, sql);
  const jobIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of jobIds.entries()) {
    await sql`
      insert into submissions_v2.jobs (
        id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch, priority
      ) values (${id}, 'resume_prepare', 'pair', ${`pair-${index}`}, ${randomUUID()}, 'generation',
                ${enabled.control_epoch}, ${index})
    `;
  }
  const [left, right] = await Promise.all([
    claimJobs({ workerId: "worker-left", kinds: ["resume_prepare"], limit: 1, leaseSeconds: 60, controlEpoch: enabled.control_epoch }, sql),
    claimJobs({ workerId: "worker-right", kinds: ["resume_prepare"], limit: 1, leaseSeconds: 60, controlEpoch: enabled.control_epoch }, sql),
  ]);
  assert.equal(left.length, 1);
  assert.equal(right.length, 1);
  assert.notEqual(left[0].id, right[0].id);
  const first = left[0];
  assert.equal(await completeJob({
    jobId: first.id,
    workerId: "worker-left",
    fencingToken: first.fencing_token - 1,
    controlEpoch: enabled.control_epoch,
  }, sql), null);
  const heartbeat = await heartbeatJob({
    jobId: first.id,
    workerId: "worker-left",
    fencingToken: first.fencing_token,
    controlEpoch: enabled.control_epoch,
    leaseSeconds: 90,
  }, sql);
  assert.equal(heartbeat.state, "running");
  const completed = await completeJob({
    jobId: first.id,
    workerId: "worker-left",
    fencingToken: first.fencing_token,
    controlEpoch: enabled.control_epoch,
    checkpoint: { stage: "done" },
  }, sql);
  assert.equal(completed.state, "succeeded");

  const running = right[0];
  const disabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz",
    reason: "Fence nonproduction generation lease test",
    ui: enabled.ui_enabled,
    ingestion: enabled.ingestion_enabled,
    generation: false,
    masterInbox: enabled.master_inbox_enabled,
    curated: enabled.curated_enabled,
  }, sql);
  assert.equal(Number(disabled.control_epoch), Number(enabled.control_epoch) + 1);
  const queued = await sql`select state, hold_reason from submissions_v2.jobs where id = ${jobIds[2]}`;
  assert.deepEqual(queued[0], { state: "held", hold_reason: "control_disabled" });
  const fenced = await checkpointJob({
    jobId: running.id,
    workerId: "worker-right",
    fencingToken: running.fencing_token,
    controlEpoch: enabled.control_epoch,
    checkpoint: { stage: "bounded-stage-complete" },
  }, sql);
  assert.equal(fenced.state, "held");
  assert.equal(fenced.hold_reason, "control_disabled");
  assert.equal(await completeJob({
    jobId: running.id,
    workerId: "worker-right",
    fencingToken: running.fencing_token,
    controlEpoch: enabled.control_epoch,
  }, sql), null);
  const audits = await sql`
    select count(*)::integer as count from submissions_v2.runtime_control_events
     where control_epoch in (${enabled.control_epoch}, ${disabled.control_epoch})
  `;
  assert.equal(audits[0].count, 2);
});

test("source checkpoints advance only under the current enabled control epoch", async () => {
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz",
    reason: "Enable nonproduction Curated cursor test",
    ui: prior.ui_enabled,
    ingestion: true,
    generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled,
    curated: true,
  }, sql);
  await sql`
    insert into submissions_v2.source_cursors (
      source_key, activation_cursor, checkpoint, control_epoch
    ) values ('curated', ${sql.json({ activated: true })}, ${sql.json({ offset: 0 })}, ${enabled.control_epoch})
    on conflict (source_key) do update
      set activation_cursor = excluded.activation_cursor,
          checkpoint = excluded.checkpoint,
          control_epoch = excluded.control_epoch,
          lease_owner = null,
          lease_expires_at = null
  `;
  const [left, right] = await Promise.all([
    claimSourceCursor({ sourceKey: "curated", workerId: "source-left", leaseSeconds: 60, controlEpoch: enabled.control_epoch }, sql),
    claimSourceCursor({ sourceKey: "curated", workerId: "source-right", leaseSeconds: 60, controlEpoch: enabled.control_epoch }, sql),
  ]);
  const claim = left || right;
  assert.ok(claim);
  assert.equal(Boolean(left) + Boolean(right), 1);
  assert.equal(await heartbeatSourceCursor({
    sourceKey: "curated",
    workerId: claim.lease_owner,
    fencingToken: Number(claim.fencing_token) - 1,
    controlEpoch: enabled.control_epoch,
  }, sql), null);
  const heartbeat = await heartbeatSourceCursor({
    sourceKey: "curated",
    workerId: claim.lease_owner,
    fencingToken: claim.fencing_token,
    controlEpoch: enabled.control_epoch,
  }, sql);
  assert.equal(heartbeat.lease_owner, claim.lease_owner);
  const committed = await commitSourceCursor({
    sourceKey: "curated",
    workerId: claim.lease_owner,
    fencingToken: claim.fencing_token,
    controlEpoch: enabled.control_epoch,
    checkpoint: { offset: 100 },
    fullSuccess: true,
  }, sql);
  assert.deepEqual(committed.checkpoint, { offset: 100 });
  assert.ok(committed.last_full_success_at);
  assert.equal(committed.lease_owner, null);

  const disabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz",
    reason: "Disable nonproduction Curated cursor test",
    ui: enabled.ui_enabled,
    ingestion: enabled.ingestion_enabled,
    generation: enabled.generation_enabled,
    masterInbox: enabled.master_inbox_enabled,
    curated: false,
  }, sql);
  assert.equal(await claimSourceCursor({
    sourceKey: "curated",
    workerId: "source-disabled",
    leaseSeconds: 60,
    controlEpoch: disabled.control_epoch,
  }, sql), null);
});

test("curated reconciliation is source-fenced, monotonic, and retains an unresolved decisive signal", async () => {
  const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable curated durability regression",
    ui: prior.ui_enabled, ingestion: true, generation: true,
    masterInbox: prior.master_inbox_enabled, curated: true,
  }, sql);
  const candidateId = `curated-candidate-${randomUUID()}`;
  const roleId = `curated-role-${randomUUID()}`;
  await sql`
    insert into submissions_v2.role_index(
      role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
    ) values (${roleId}, 'Curated Company', 'Curated Engineer', 'curated company curated engineer', true,
              ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)})
  `;
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch)
    values (${jobId}, 'reconcile_curated', 'source', 'curated', ${`job:${jobId}`}, 'curated', ${enabled.control_epoch})
  `;
  const claimedJob = (await claimJobs({
    workerId: "curated-durability-worker", kinds: ["reconcile_curated"], limit: 1,
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql))[0];
  const executionFence = {
    jobId: claimedJob.id, workerId: claimedJob.lease_owner,
    fencingToken: Number(claimedJob.fencing_token), controlEpoch: Number(enabled.control_epoch),
  };
  await sql`
    insert into submissions_v2.source_cursors(source_key, control_epoch)
    values ('curated', ${enabled.control_epoch})
    on conflict (source_key) do update set control_epoch=excluded.control_epoch, lease_owner=null, lease_expires_at=null
  `;
  const sourceClaim = await claimSourceCursor({
    sourceKey: "curated", workerId: "curated-durability-worker",
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql);
  const sourceFence = {
    sourceKey: "curated", workerId: sourceClaim.lease_owner,
    fencingToken: Number(sourceClaim.fencing_token), controlEpoch: Number(enabled.control_epoch),
  };
  const observation = (status, at) => ({
    candidate_user_id: candidateId, role_id: roleId, status, observed_at: at,
    digest: digest(`${candidateId}:${roleId}:${status}:${at}`),
  });
  await repository.applyCuratedObservations([observation("PENDING", "2026-09-01T20:00:00.000Z")], {
    seed: true, executionFence, sourceFence,
  });
  const missing = await repository.applyCuratedObservations([observation("APPLIED_TO_ROLE", "2026-09-01T20:05:00.000Z")], {
    executionFence, sourceFence,
  });
  assert.equal(missing[0].pending, true);
  let snapshot = (await repository.curatedSnapshots(candidateId))[0];
  assert.equal(snapshot.resolved, false);
  assert.equal(snapshot.pending_status, "APPLIED_TO_ROLE");
  const neutral = await repository.applyCuratedObservations([observation("PENDING", "2026-09-01T20:10:00.000Z")], {
    executionFence, sourceFence,
  });
  assert.equal(neutral[0].pending, true);
  snapshot = (await repository.curatedSnapshots(candidateId))[0];
  assert.equal(snapshot.last_confirmed_status, "PENDING");
  assert.equal(snapshot.pending_status, "APPLIED_TO_ROLE");
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (${candidateId}, 'Curated Candidate', 'curated candidate', 'curated candidate', true,
              ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)})
  `;
  const recovered = await repository.applyCuratedObservations([observation("PENDING", "2026-09-01T20:15:00.000Z")], {
    executionFence, sourceFence,
  });
  assert.equal(recovered[0].applied, true);
  const pair = (await sql`
    select * from submissions_v2.candidate_role_pairs
     where candidate_user_id=${candidateId} and role_id=${roleId}
  `)[0];
  assert.equal(pair.intent_state, "interested");
  snapshot = (await repository.curatedSnapshots(candidateId))[0];
  assert.equal(snapshot.resolved, true);
  assert.equal(snapshot.pending_status, null);
  const stale = await repository.applyCuratedObservations([observation("NOT_INTERESTED", "2026-09-01T20:01:00.000Z")], {
    executionFence, sourceFence,
  });
  assert.equal(stale[0].stale, true);
  await assert.rejects(
    repository.applyCuratedObservations([observation("NOT_INTERESTED", "2026-09-01T20:20:00.000Z")], {
      executionFence, sourceFence: { ...sourceFence, fencingToken: sourceFence.fencingToken - 1 },
    }),
    (error) => error.code === "source_fence_lost",
  );
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore controls after curated durability regression",
    ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
});

test("candidate reconciliation deactivates missing profiles only after a fenced full cycle", async () => {
  const repository = createRepository({ sql, env: { SUBMISSIONS_V2_RETENTION_HMAC_KEY: "candidate-index-test-key".repeat(3) } });
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable candidate-index reconciliation test",
    ui: prior.ui_enabled, ingestion: true, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
  for (const id of ["candidate-still-present", "candidate-now-missing"]) {
    await sql`
      insert into submissions_v2.candidate_index(
        candidate_user_id, display_name, normalized_name, search_key,
        paraform_profile_url, last_confirmed_at, source_digest, reconciliation_cycle
      ) values (
        ${id}, ${id}, ${id}, ${id}, ${`https://www.paraform.com/candidates?candidate=${id}`},
        clock_timestamp() - interval '1 hour', ${digest(id)}, 'prior-cycle'
      )
    `;
  }
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(
      id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch
    ) values (
      ${jobId}, 'index_candidates', 'source', 'candidate_index', ${randomUUID()}, 'ingestion', ${enabled.control_epoch}
    )
  `;
  const claimed = (await claimJobs({
    workerId: "candidate-index-worker", kinds: ["index_candidates"], limit: 1,
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql))[0];
  const executionFence = {
    jobId: claimed.id, workerId: claimed.lease_owner,
    fencingToken: Number(claimed.fencing_token), controlEpoch: Number(enabled.control_epoch),
  };
  await sql`
    insert into submissions_v2.source_cursors(source_key, control_epoch)
    values ('candidate_index', ${enabled.control_epoch})
    on conflict (source_key) do update set control_epoch=excluded.control_epoch, lease_owner=null, lease_expires_at=null
  `;
  const sourceClaim = await claimSourceCursor({
    sourceKey: "candidate_index", workerId: "candidate-index-worker",
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql);
  const sourceFence = {
    sourceKey: "candidate_index", workerId: sourceClaim.lease_owner,
    fencingToken: Number(sourceClaim.fencing_token), controlEpoch: Number(enabled.control_epoch),
  };
  await assert.rejects(
    repository.upsertCandidateIndex([], {
      cycleId: "stale-cycle", executionFence,
      sourceFence: { ...sourceFence, fencingToken: sourceFence.fencingToken - 1 },
    }),
    (error) => error.code === "source_fence_lost",
  );
  const permanentlyPurgedId = `candidate-permanently-purged-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index_suppressions(candidate_hmac)
    values (${digest(`submissions-v2-candidate-suppression:v1\0${permanentlyPurgedId}`)})
  `;
  const indexed = await repository.upsertCandidateIndex([{
    candidate_user_id: "candidate-still-present", display_name: "Candidate Present",
    search_key: "candidate present", email_hmac: null, email_hmac_version: null,
    paraform_url: "https://www.paraform.com/candidates?candidate=candidate-still-present",
    linkedin_url: null, raydar_url: "/applicants?candidate=candidate-still-present",
    owner_email: null, has_recorded_call: false, confirmed_at: new Date().toISOString(),
    source_digest: digest("candidate-still-present-current"),
  }, {
    candidate_user_id: permanentlyPurgedId, display_name: "Purged Candidate",
    search_key: "purged candidate", email_hmac: null, email_hmac_version: null,
    paraform_url: `https://www.paraform.com/candidates?candidate=${permanentlyPurgedId}`,
    linkedin_url: null, raydar_url: `/applicants?candidate=${permanentlyPurgedId}`,
    owner_email: null, has_recorded_call: false, confirmed_at: new Date().toISOString(),
    source_digest: digest("candidate-permanently-purged-current"),
  }], { cycleId: "full-cycle", executionFence, sourceFence });
  assert.equal(indexed.suppressed_count, 1);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.candidate_index where candidate_user_id=${permanentlyPurgedId}`)[0].count, 0);
  const beforeFinalize = await sql`select active from submissions_v2.candidate_index where candidate_user_id='candidate-now-missing'`;
  assert.equal(beforeFinalize[0].active, true);
  const finalized = await repository.finalizeCandidateIndexCycle({ cycleId: "full-cycle", executionFence, sourceFence });
  assert.ok(finalized.deactivated_count >= 1);
  const rows = await sql`
    select candidate_user_id, active
      from submissions_v2.candidate_index
     where candidate_user_id in ('candidate-still-present', 'candidate-now-missing')
     order by candidate_user_id
  `;
  assert.deepEqual([...rows], [
    { candidate_user_id: "candidate-now-missing", active: false },
    { candidate_user_id: "candidate-still-present", active: true },
  ]);
  await commitSourceCursor({
    sourceKey: "candidate_index", workerId: sourceClaim.lease_owner,
    fencingToken: sourceClaim.fencing_token, controlEpoch: enabled.control_epoch,
    checkpoint: {}, fullSuccess: true,
  }, sql);
});

test("scheduler queues every due reconciliation, index, proof, notification, digest, health, and purge lane", async () => {
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz",
    reason: "Enable nonproduction scheduler coverage test",
    ui: true,
    ingestion: true,
    generation: true,
    masterInbox: true,
    curated: true,
  }, sql);
  const repository = createRepository({ sql });
  const result = await repository.scheduleTick({
    minuteKey: "2026-09-01T15:07",
    fiveMinuteKey: "2026-09-01T15:05",
    hourKey: "2026-09-01T15",
    pacificDayKey: "2026-09-01",
    dailyDigestDue: true,
    nightlyDue: true,
    purgeDue: true,
  });
  assert.deepEqual(new Set(result.jobs.map((job) => job.kind)), new Set([
    "reconcile_master_inbox", "reconcile_curated", "proof_reconcile", "deliver_notification",
    "source_health", "index_candidates", "index_roles", "daily_digest", "purge",
  ]));
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz",
    reason: "Restore nonproduction scheduler coverage test controls",
    ui: prior.ui_enabled,
    ingestion: prior.ingestion_enabled,
    generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled,
    curated: prior.curated_enabled,
  }, sql);
});

test("administrator case deletion is hidden, encrypted-manifest-backed, fenced, recoverable, and append-only audited", async () => {
  const repository = createRepository({ sql });
  const pair = await preparingPair();
  const generationId = randomUUID();
  await sql`
    insert into submissions_v2.resume_generations(
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, deadline_at
    ) values (
      ${generationId}, ${pair.id}, 1, 'initial', ${`generation:${generationId}`}, 'queued', 'queued',
      1, ${pair.signal}, 'opus-test', 'opus-fallback-test', 'validator-test',
      'prompt-test', 'template-test', clock_timestamp() + interval '5 minutes'
    )
  `;
  const artifactId = randomUUID();
  await sql`
    insert into submissions_v2.resume_artifacts(
      id, pair_id, generation_id, artifact_version, kind, private_object_key,
      digest, size_bytes, validation_status, current_state
    ) values (
      ${artifactId}, ${pair.id}, ${generationId}, 1, 'pdf',
      ${`submissions/resumes/v2/artifacts/${artifactId}`}, ${digest("artifact")}, 100,
      'pending', 'staged'
    )
  `;
  const supplementId = randomUUID();
  await sql`
    insert into submissions_v2.resume_supplements(
      id, pair_id, supplement_kind, text_value_encrypted, creator_email,
      digest, scan_state, parse_state, evidence_basis, source_or_correction_note
    ) values (
      ${supplementId}, ${pair.id}, 'evidence', ${Buffer.from("encrypted-context")},
      'admin@raydar.xyz', ${digest("supplement")}, 'clean', 'parsed', 'sourced', 'Candidate supplied context'
    )
  `;
  const controls = await readRuntimeControls(sql);
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(
      id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch
    ) values (
      ${jobId}, 'prepare_resume', 'pair', ${pair.id}, ${`job:${jobId}`}, 'generation', ${controls.control_epoch}
    )
  `;

  const deleteKey = `delete-case:${randomUUID()}`;
  const deleteReservation = await repository.reserveCaseRetentionCommand({
    actorEmail: "admin@raydar.xyz", action: "soft_delete_case", idempotencyKey: deleteKey,
    pairId: pair.id, expectedVersion: 1, reason: "Approved private deletion",
  });
  const snapshot = await repository.caseDeletionManifest({ pairId: pair.id, expectedVersion: 1 });
  const deletionId = randomUUID();
  const requestedAt = "2026-09-01T20:00:00.000Z";
  const recoveryDeadline = "2026-10-01T20:00:00.000Z";
  const manifest = {
    manifest_version: 1, deletion_id: deletionId, pair_id: pair.id,
    requested_at: requestedAt, recovery_deadline: recoveryDeadline,
    reason: "Approved private deletion", reason_digest: digest("Approved private deletion"), snapshot,
  };
  const manifestObjectKey = `submissions/resumes/v2/case_manifests/${deletionId}`;
  const manifestDigest = digest("encrypted-manifest");
  const objectReservation = await repository.reservePrivateObject({
    reservationId: randomUUID(), purpose: "case_manifest", ownerRef: pair.id,
    objectKey: manifestObjectKey, expectedDigest: manifestDigest,
    expiresAt: Date.now() + 24 * 60 * 60_000,
  });
  const deleted = await repository.softDeleteCase({
    actorEmail: "admin@raydar.xyz", commandId: deleteReservation.command_id,
    pairId: pair.id, expectedVersion: 1, deletionId, requestedAt, recoveryDeadline,
    encryptedManifestObjectKey: manifestObjectKey,
    manifestDigest, tombstoneCaseHmac: digest(`hmac:${pair.id}`), tombstoneCandidateHmac: digest(`candidate:${pair.candidate}`), manifest,
    objectReservationId: objectReservation.id, objectWriteFencingToken: objectReservation.write_fencing_token,
  });
  assert.equal(deleted.state, "soft_deleted");
  assert.equal(deleted.state_version, 2);
  assert.equal(await repository.pair(pair.id), null);
  assert.equal((await repository.archive({ candidateId: pair.candidate, roleId: pair.role })).length, 0);
  assert.equal((await repository.jobs({ pairId: pair.id })).length, 0);
  const hidden = (await sql`select * from submissions_v2.candidate_role_pairs where id=${pair.id}`)[0];
  assert.ok(hidden.case_hidden_at);
  assert.equal(Number(hidden.state_version), 2);
  assert.equal((await sql`select current_state from submissions_v2.resume_artifacts where id=${artifactId}`)[0].current_state, "deleted");
  assert.equal((await sql`select active from submissions_v2.resume_supplements where id=${supplementId}`)[0].active, false);
  assert.equal((await sql`select status from submissions_v2.resume_generations where id=${generationId}`)[0].status, "cancelled");
  const cancelledJob = (await sql`select state, fencing_token from submissions_v2.jobs where id=${jobId}`)[0];
  assert.equal(cancelledJob.state, "cancelled");
  assert.equal(Number(cancelledJob.fencing_token), 1);
  const lateStore = createResumePipelineStore({ sql, repository, blobs: {
    putPrivateObject: async () => assert.fail("a cancelled generation must not write private data"),
    readPrivateObject: async () => assert.fail("a cancelled generation must not read private data"),
  } });
  await assert.rejects(() => lateStore.recordStage({
    generationId, stage: "late", attempt: 1, inputDigest: digest("late"), status: "succeeded",
    executionFence: { jobId, workerId: "expired-worker", fencingToken: 0, controlEpoch: Number(controls.control_epoch) },
  }), (error) => ["execution_fence_lost", "generation_execution_fence_lost"].includes(error.code));
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.resume_stage_runs where generation_id=${generationId} and stage='late'`)[0].count, 0);
  assert.equal((await repository.duePurges()).cases.length, 0);

  const deleteReplay = await repository.reserveCaseRetentionCommand({
    actorEmail: "admin@raydar.xyz", action: "soft_delete_case", idempotencyKey: deleteKey,
    pairId: pair.id, expectedVersion: 1, reason: "Approved private deletion",
  });
  assert.equal(deleteReplay.replay, true);
  assert.equal(deleteReplay.result.deletion_id, deletionId);

  const restoreKey = `restore-case:${randomUUID()}`;
  const restoreReservation = await repository.reserveCaseRetentionCommand({
    actorEmail: "admin@raydar.xyz", action: "restore_case", idempotencyKey: restoreKey,
    pairId: pair.id, expectedVersion: 2,
  });
  const recoverable = await repository.caseDeletionForRestore({ pairId: pair.id });
  assert.equal(recoverable.id, deletionId);
  const restoreControls = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "test@raydar.xyz", reason: "Enable generation for case restoration test",
    ui: restoreControls.ui_enabled, ingestion: restoreControls.ingestion_enabled, generation: true,
    masterInbox: restoreControls.master_inbox_enabled, curated: restoreControls.curated_enabled,
  }, sql);
  const restored = await repository.restoreCase({
    actorEmail: "admin@raydar.xyz", commandId: restoreReservation.command_id,
    pairId: pair.id, expectedVersion: 2, deletionId, manifest,
  });
  assert.equal(restored.state, "restored");
  assert.equal(restored.state_version, 3);
  assert.ok(restored.resumed_job_id);
  assert.equal(Number((await repository.pair(pair.id)).state_version), 3);
  await setRuntimeControls({
    actorEmail: "test@raydar.xyz", reason: "Restore controls after case restoration test",
    ui: restoreControls.ui_enabled, ingestion: restoreControls.ingestion_enabled,
    generation: restoreControls.generation_enabled, masterInbox: restoreControls.master_inbox_enabled,
    curated: restoreControls.curated_enabled,
  }, sql);
  assert.equal((await sql`select current_state from submissions_v2.resume_artifacts where id=${artifactId}`)[0].current_state, "staged");
  assert.equal((await sql`select active from submissions_v2.resume_supplements where id=${supplementId}`)[0].active, true);
  const artifactDeletion = (await sql`select * from submissions_v2.artifact_deletions where artifact_id=${artifactId}`)[0];
  assert.ok(artifactDeletion.restored_at);
  assert.equal(artifactDeletion.restored_by, "admin@raydar.xyz");
  const deletion = (await sql`select * from submissions_v2.case_deletions where id=${deletionId}`)[0];
  assert.equal(deletion.state, "restored");
  assert.ok(deletion.restored_at);
  const audit = await sql`select event_type from submissions_v2.case_deletion_audit where deletion_id=${deletionId} order by id`;
  assert.deepEqual(audit.map((row) => row.event_type), ["soft_deleted", "restored"]);
  await assert.rejects(
    sql`update submissions_v2.case_deletion_audit set actor_email='changed@raydar.xyz' where deletion_id=${deletionId}`,
    /permanent append-only audit/,
  );
});

test("a due case cannot claim another pair's object path across storage tables", async () => {
  const pairA = await preparingPair();
  const pairB = await preparingPair();
  const generationB = randomUUID();
  await sql`
    insert into submissions_v2.resume_generations(
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, deadline_at
    ) values (
      ${generationB}, ${pairB.id}, 1, 'initial', ${`owner-regression:${generationB}`},
      'queued', 'queued', 1, ${pairB.signal}, 'opus-test', 'opus-fallback-test',
      'validator-test', 'prompt-test', 'template-test', clock_timestamp() + interval '5 minutes'
    )
  `;
  const crossPairArtifact = randomUUID();
  const crossPairPath = `submissions/resumes/v2/ats/${crossPairArtifact}`;
  await sql`
    insert into submissions_v2.private_object_reservations(
      id, object_key, purpose, owner_ref, expected_digest, state, expires_at, committed_at
    ) values (
      ${randomUUID()}, ${crossPairPath}, 'resume_artifact', ${generationB},
      ${digest("cross-pair-artifact")}, 'committed', clock_timestamp() + interval '1 day', clock_timestamp()
    )
  `;
  await assert.rejects(
    sql`
      insert into submissions_v2.resume_artifacts(
        id, pair_id, generation_id, artifact_version, kind, private_object_key,
        digest, size_bytes, validation_status, current_state
      ) values (
        ${crossPairArtifact}, ${pairA.id}, ${generationB}, 99, 'ats', ${crossPairPath},
        ${digest("cross-pair-artifact")}, 100, 'pending', 'staged'
      )
    `,
    /resume_artifacts_generation_pair_fk|foreign key constraint/,
  );
  await assert.rejects(
    sql`
      insert into submissions_v2.resume_supplements(
        id, pair_id, generation_id, supplement_kind, text_value_encrypted,
        creator_email, digest, scan_state, parse_state, evidence_basis,
        source_or_correction_note
      ) values (
        ${randomUUID()}, ${pairA.id}, ${generationB}, 'generation_instruction',
        ${Buffer.from("encrypted instruction")}, 'recruiter@raydar.xyz',
        ${digest("cross-pair-instruction")}, 'not_applicable', 'not_applicable',
        'sourced', 'Cross-pair instruction attempt'
      )
    `,
    /resume_supplements_generation_pair_fk|foreign key constraint/,
  );
  const artifactB = randomUUID();
  const protectedPath = `submissions/resumes/v2/pdf/${artifactB}`;
  await sql`
    insert into submissions_v2.resume_artifacts(
      id, pair_id, generation_id, artifact_version, kind, private_object_key,
      digest, size_bytes, validation_status, current_state
    ) values (
      ${artifactB}, ${pairB.id}, ${generationB}, 1, 'pdf', ${protectedPath},
      ${digest("protected-artifact")}, 100, 'pending', 'staged'
    )
  `;

  // Simulate an in-place 001-010 upgrade: the owner row exists before the
  // registry, then migration 011 reconstructs and validates it transactionally.
  await sql`delete from submissions_v2.private_object_bindings where object_key=${protectedPath}`;
  await sql`select submissions_v2.backfill_private_object_bindings()`;

  await assert.rejects(
    sql`
      insert into submissions_v2.resume_supplements(
        id, pair_id, supplement_kind, object_key, creator_email, mime_type,
        original_name, size_bytes, digest, scan_state, parse_state,
        evidence_basis, source_or_correction_note
      ) values (
        ${randomUUID()}, ${pairA.id}, 'evidence', ${protectedPath}, 'attacker@raydar.xyz',
        'application/pdf', 'poison.pdf', 100, ${digest("poison")}, 'pending', 'pending',
        'sourced', 'Cross-pair purge poison attempt'
      )
    `,
    /private object path already belongs to another record/,
  );
  await assert.rejects(
    sql`
      insert into submissions_v2.private_object_reservations(
        id, object_key, purpose, owner_ref, expected_digest, expires_at
      ) values (
        ${randomUUID()}, ${protectedPath}, 'case_manifest', ${pairA.id},
        ${digest("poison-reservation")}, clock_timestamp() + interval '1 day'
      )
    `,
    /private object path is already reserved or owned by another record/,
  );

  const movableSupplement = randomUUID();
  const movablePath = `submissions/resumes/v2/supplements/${movableSupplement}`;
  await sql`
    insert into submissions_v2.resume_supplements(
      id, pair_id, supplement_kind, object_key, creator_email, mime_type,
      original_name, size_bytes, digest, scan_state, parse_state,
      evidence_basis, source_or_correction_note
    ) values (
      ${movableSupplement}, ${pairB.id}, 'evidence', ${movablePath}, 'candidate@example.com',
      'application/pdf', 'candidate.pdf', 100, ${digest("movable")}, 'pending', 'pending',
      'sourced', 'Owner relation immutability regression'
    )
  `;
  await assert.rejects(
    sql`update submissions_v2.resume_supplements set pair_id=${pairA.id} where id=${movableSupplement}`,
    /supplement owner relation is immutable/,
  );

  const binding = (await sql`
    select owner_table, owner_column, owner_id, owner_pair_id, reservation_id
      from submissions_v2.private_object_bindings where object_key=${protectedPath}
  `)[0];
  assert.deepEqual(binding, {
    owner_table: "resume_artifacts",
    owner_column: "private_object_key",
    owner_id: artifactB,
    owner_pair_id: pairB.id,
    reservation_id: null,
  });
});

test("quarantined upload cleanup returns only 24-hour-old objects and marks DB state idempotently after deletion", async () => {
  const repository = createRepository({ sql });
  const pair = await preparingPair();
  const oldId = randomUUID();
  const youngId = randomUUID();
  for (const [id, createdAt] of [
    [oldId, new Date(Date.now() - 48 * 60 * 60 * 1_000)],
    [youngId, new Date(Date.now() - 60 * 60 * 1_000)],
  ]) {
    await sql`
      insert into submissions_v2.resume_supplements(
        id, pair_id, supplement_kind, object_key, creator_email, created_at,
        mime_type, original_name, size_bytes, digest, scan_state, parse_state,
        active, quarantined, evidence_basis, source_or_correction_note
      ) values (
        ${id}, ${pair.id}, 'evidence', ${`submissions/resumes/v2/supplements/${id}`},
        'admin@raydar.xyz', ${createdAt}, 'application/pdf', 'upload.pdf', 100,
        ${digest(id)}, 'pending', 'pending', true, true, 'sourced', 'Quarantined upload'
      )
    `;
  }
  const due = await repository.dueQuarantinedSupplements({ before: new Date().toISOString(), limit: 10, workerId: "worker-test" });
  assert.deepEqual([...due].map((row) => row.supplement_id), [oldId]);
  assert.equal(due[0].object_key, `submissions/resumes/v2/supplements/${oldId}`);
  const purged = await repository.markQuarantinedSupplementPurged({ supplementId: oldId, workerId: "worker-test", fencingToken: due[0].quarantine_cleanup_fencing_token });
  assert.equal(purged.purged, true);
  assert.equal(purged.already_purged, false);
  const retained = (await sql`select active, private_object_purged_at from submissions_v2.resume_supplements where id=${oldId}`)[0];
  assert.equal(retained.active, false);
  assert.ok(retained.private_object_purged_at);
  await assert.rejects(
    () => repository.markQuarantinedSupplementPurged({ supplementId: oldId, workerId: "worker-test", fencingToken: due[0].quarantine_cleanup_fencing_token }),
    (error) => error.code === "supplement_quarantine_purge_fence_lost",
  );
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.pair_events where idempotency_key=${`supplement-quarantine-purge:${oldId}`}`)[0].count, 1);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.resume_supplements where id=${youngId}`)[0].count, 1);
});
