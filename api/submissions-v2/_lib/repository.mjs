import { createHash } from "node:crypto";
import { database } from "./db.mjs";
import { beginCommand, completeCommand, failCommand } from "./command-store.mjs";
import { exactSlackChannel } from "./notifications.mjs";
import { gmailSignalUrl } from "./presentation.mjs";

const PAGE_STATES = new Set(["interested", "needs_review", "not_interested"]);
const REVIEW_REASONS = new Set([
  "candidate_not_found", "candidate_ambiguous", "reply_unclear_or_conditional",
  "candidate_question", "role_unclear", "role_unavailable",
  "candidate_original_resume_missing", "classification_failed", "resume_preparation_failed",
]);

const clean = (value, limit = 500) => String(value ?? "").trim().slice(0, limit);
const digest = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");
const boundedLimit = (value, fallback = 100, maximum = 100) => Math.max(1, Math.min(maximum, Number(value) || fallback));
const pairAdvisoryLockKey = (candidateId, roleId) => JSON.stringify([String(candidateId), String(roleId)]);
const ACTIVE_GENERATION_STATES = Object.freeze([
  "queued", "collecting", "extracting", "strategizing", "validating", "rendering", "archiving", "held",
]);
const UUID_OID = 2950;

function ownerDisplayName(value) {
  const local = clean(value, 200).split("@", 1)[0];
  if (!local) return "Unassigned";
  return local.split(/[^A-Za-z0-9]+/u).filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`).join(" ") || "Unassigned";
}

function instant(value) {
  return value == null ? null : new Date(value).toISOString();
}

function deletionSnapshot({ pair, artifacts = [], supplements = [], generations = [], jobs = [], objectKeys = [] }) {
  return {
    manifest_version: 1,
    pair: {
      id: pair.id,
      candidate_user_id: pair.candidate_user_id,
      role_id: pair.role_id,
      first_signal_id: pair.first_signal_id,
      state_version: Number(pair.state_version),
      intent_state: pair.intent_state,
      workflow_state: pair.workflow_state,
      submission_status: pair.submission_status,
      current_artifact_id: pair.current_artifact_id,
      resume_ready_at: instant(pair.resume_ready_at),
      case_hidden_at: instant(pair.case_hidden_at),
    },
    artifacts: artifacts.map((row) => ({
      id: row.id,
      current_state: row.current_state,
      deleted_at: instant(row.deleted_at),
      private_object_key: row.private_object_key,
      digest: row.digest,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    supplements: supplements.map((row) => ({
      id: row.id,
      active: Boolean(row.active),
      quarantined: Boolean(row.quarantined),
      deleted_at: instant(row.deleted_at),
      deletion_actor: row.deletion_actor,
      object_key: row.object_key,
      extracted_text_object_key: row.extracted_text_object_key,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    active_generations: generations.map((row) => ({
      id: row.id,
      status: row.status,
      stage: row.stage,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    active_jobs: jobs.map((row) => ({
      id: row.id,
      state: row.state,
      kind: row.kind,
      fencing_token: Number(row.fencing_token),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    private_object_keys: [...new Set(objectKeys.filter(Boolean).map(String))].sort(),
  };
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function problem(code, message, status = 422, current = null) {
  return Object.assign(new Error(message), { code, status, ...(current ? { current } : {}) });
}

export function encodeCursor(row) {
  if (!row?.sort_at || !row?.sort_id) return null;
  return Buffer.from(JSON.stringify({ at: new Date(row.sort_at).toISOString(), id: String(row.sort_id) })).toString("base64url");
}

export function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!Number.isFinite(Date.parse(parsed?.at)) || !/^[0-9a-f-]{36}$/i.test(String(parsed?.id || ""))) throw new Error();
    return { at: new Date(parsed.at).toISOString(), id: parsed.id };
  } catch {
    throw problem("cursor_invalid", "The list cursor is invalid.", 400);
  }
}

function pairCurrent(row) {
  if (!row) return null;
  return {
    case_id: row.id,
    state_version: Number(row.state_version),
    intent_state: row.intent_state,
    workflow_state: row.workflow_state,
    submission_status: row.submission_status,
  };
}

async function lockPair(tx, pairId, expectedVersion) {
  const rows = await tx`select * from submissions_v2.candidate_role_pairs where id=${pairId} and case_hidden_at is null for update`;
  const pair = rows[0];
  if (!pair) throw problem("pair_not_found", "The candidate-role item was not found.", 404);
  if (Number(pair.state_version) !== Number(expectedVersion)) {
    throw problem("stale_pair_version", "The candidate-role item changed before this action was committed.", 409, pairCurrent(pair));
  }
  return pair;
}

async function command(tx, input, work) {
  const requiredControls = Array.isArray(input.requiredControls) ? input.requiredControls : ["ui"];
  if (requiredControls.length) {
    const current = (await tx`select * from submissions_v2.lock_runtime_controls()`)[0];
    const columns = {
      ui: "ui_enabled",
      ingestion: "ingestion_enabled",
      generation: "generation_enabled",
      master_inbox: "master_inbox_enabled",
      curated: "curated_enabled",
    };
    if (!current || requiredControls.some((name) => !columns[name] || current[columns[name]] !== true)) {
      throw problem("submissions_v2_control_disabled", "Submissions V2 is disabled for this action.", 503);
    }
  }
  const started = await beginCommand(tx, input);
  if (started.replay) return { ...started.result, replay: true };
  const result = await work(started.command);
  await completeCommand(tx, started.command.id, result, result?.case_id);
  return result;
}

async function controls(tx) {
  const rows = await tx`select * from submissions_v2.lock_runtime_controls()`;
  if (!rows.length) throw problem("submissions_v2_controls_unavailable", "Submissions V2 controls are unavailable.", 503);
  return rows[0];
}

export async function assertWorkerFence(tx, execution, requiredControl) {
  const jobId = clean(execution?.jobId, 100);
  const workerId = clean(execution?.workerId, 200);
  const fencingToken = Number(execution?.fencingToken);
  const controlEpoch = Number(execution?.controlEpoch);
  if (!jobId || !workerId || !Number.isInteger(fencingToken) || !Number.isInteger(controlEpoch)) {
    throw problem("execution_fence_required", "A current worker execution fence is required.", 409);
  }
  const rows = await tx`
    select j.id from submissions_v2.jobs j
    cross join submissions_v2.lock_runtime_controls() c
     where j.id=${jobId} and j.state='running' and j.lease_owner=${workerId}
       and j.fencing_token=${fencingToken} and j.control_epoch=${controlEpoch}
       and j.required_control=${requiredControl}
       and j.lease_expires_at >= clock_timestamp() and c.control_epoch=${controlEpoch}
       and submissions_v2.job_control_enabled(j.required_control, c)
     for share of j
  `;
  if (!rows.length) throw problem("execution_fence_lost", "The worker lease or runtime control changed before results could be applied.", 409);
  return true;
}

export async function assertSourceFence(tx, sourceFence, expectedSourceKey) {
  const sourceKey = clean(sourceFence?.sourceKey, 200);
  const workerId = clean(sourceFence?.workerId, 200);
  const fencingToken = Number(sourceFence?.fencingToken);
  const controlEpoch = Number(sourceFence?.controlEpoch);
  if (sourceKey !== expectedSourceKey || !workerId || !Number.isInteger(fencingToken) || !Number.isInteger(controlEpoch)) {
    throw problem("source_fence_required", "A current source reconciliation fence is required.", 409);
  }
  const rows = await tx`
    select cursor.source_key
      from submissions_v2.source_cursors cursor
      cross join submissions_v2.lock_runtime_controls() controls
     where cursor.source_key=${sourceKey} and cursor.lease_owner=${workerId}
       and cursor.fencing_token=${fencingToken} and cursor.control_epoch=${controlEpoch}
       and cursor.lease_expires_at >= clock_timestamp() and controls.control_epoch=${controlEpoch}
       and submissions_v2.source_control_enabled(cursor.source_key, controls)
     for share of cursor
  `;
  if (!rows.length) throw problem("source_fence_lost", "The source reconciliation lease changed before results could be applied.", 409);
  return true;
}

export async function assertGenerationFence(tx, execution, generationId) {
  await assertWorkerFence(tx, execution, "generation");
  const rows = await tx`
    select generation.*
      from submissions_v2.resume_generations generation
      join submissions_v2.candidate_role_pairs pair on pair.id=generation.pair_id
      join submissions_v2.jobs job on job.id=${clean(execution?.jobId, 100)}::uuid
     where generation.id=${generationId}
       and generation.status in ('queued','collecting','extracting','strategizing','validating','rendering','archiving')
       and pair.case_hidden_at is null and pair.state_version=generation.expected_pair_version
       and job.subject_type='pair' and job.subject_id=pair.id::text
     for share of generation, pair, job
  `;
  if (!rows.length) {
    throw problem("generation_execution_fence_lost", "The resume generation or candidate-role item changed before worker results could be persisted.", 409);
  }
  return rows[0];
}

async function enqueue(tx, {
  kind, subjectType, subjectId, commandId = null, idempotencyKey,
  requiredControl, priority = 100, maxAttempts = 3, checkpoint = {}, scheduledAt = null,
}) {
  const activeControls = await controls(tx);
  const controlColumn = {
    ui: "ui_enabled",
    ingestion: "ingestion_enabled",
    generation: "generation_enabled",
    master_inbox: "master_inbox_enabled",
    curated: "curated_enabled",
  }[requiredControl];
  if (requiredControl !== "always" && (!controlColumn || activeControls[controlColumn] !== true)) {
    throw problem("submissions_v2_control_disabled", "Submissions V2 is disabled for this queued action.", 503);
  }
  const rows = await tx`
    insert into submissions_v2.jobs(
      kind, subject_type, subject_id, command_id, idempotency_key, required_control,
      priority, max_attempts, checkpoint, control_epoch, scheduled_at
    ) values (
      ${kind}, ${subjectType}, ${subjectId}, ${commandId}, ${idempotencyKey}, ${requiredControl},
      ${priority}, ${maxAttempts}, ${tx.json(checkpoint)}, ${activeControls.control_epoch},
      coalesce(${scheduledAt}, clock_timestamp())
    )
    on conflict (kind, idempotency_key) do nothing
    returning *
  `;
  if (rows.length) return rows[0];
  const existing = await tx`select * from submissions_v2.jobs where kind=${kind} and idempotency_key=${idempotencyKey}`;
  return existing[0] || null;
}

async function pairEvent(tx, pair, {
  actorType = "human", actorId, source, eventType, expectedVersion = null,
  previous = null, note = null, reasonCode = null, idempotencyKey, metadata = {},
}) {
  await tx`
    insert into submissions_v2.pair_events(
      pair_id, actor_type, actor_id, source, event_type,
      from_intent_state, to_intent_state, from_workflow_state, to_workflow_state,
      from_submission_status, to_submission_status, expected_version, new_version,
      note, reason_code, idempotency_key, metadata
    ) values (
      ${pair.id}, ${actorType}, ${actorId}, ${source}, ${eventType},
      ${previous?.intent_state || null}, ${pair.intent_state},
      ${previous?.workflow_state || null}, ${pair.workflow_state},
      ${previous?.submission_status || null}, ${pair.submission_status},
      ${expectedVersion}, ${expectedVersion === null ? null : Number(expectedVersion) + 1},
      ${note}, ${reasonCode}, ${idempotencyKey}, ${tx.json(metadata)}
    )
  `;
}

async function queueResume(tx, pair, commandRow, triggerKind = "initial") {
  return enqueue(tx, {
    kind: "prepare_resume",
    subjectType: "pair",
    subjectId: pair.id,
    commandId: commandRow?.id || null,
    idempotencyKey: `resume:${triggerKind}:${commandRow?.id || pair.first_signal_id}`,
    requiredControl: "generation",
    priority: triggerKind === "regenerate" ? 40 : 50,
    maxAttempts: 3,
    checkpoint: { trigger_kind: triggerKind, expected_pair_version: Number(pair.state_version) },
  });
}

function signalUrlFromEnvelope(envelope = {}) {
  const value = clean(envelope.signal_url, 2_000);
  return gmailSignalUrl(value) || (/^https:\/\/monitor\.raydar\.xyz\/master-inbox#conversation=[A-Za-z0-9._~%-]+$/.test(value) ? value : null);
}

async function loadCaseDeletionSnapshot(query, pairId, { lock = false } = {}) {
  const pairRows = lock
    ? await query`select * from submissions_v2.candidate_role_pairs where id=${pairId} for update`
    : await query`select * from submissions_v2.candidate_role_pairs where id=${pairId}`;
  const pair = pairRows[0];
  if (!pair) throw problem("pair_not_found", "The candidate-role item was not found.", 404);
  const artifacts = lock
    ? await query`
        select id, current_state, deleted_at, private_object_key, digest
          from submissions_v2.resume_artifacts where pair_id=${pairId} order by id for update
      `
    : await query`
        select id, current_state, deleted_at, private_object_key, digest
          from submissions_v2.resume_artifacts where pair_id=${pairId} order by id
      `;
  const supplements = lock
    ? await query`
        select id, active, quarantined, deleted_at, deletion_actor, object_key, extracted_text_object_key
          from submissions_v2.resume_supplements where pair_id=${pairId} order by id for update
      `
    : await query`
        select id, active, quarantined, deleted_at, deletion_actor, object_key, extracted_text_object_key
          from submissions_v2.resume_supplements where pair_id=${pairId} order by id
      `;
  const generations = lock
    ? await query`
        select id, status, stage from submissions_v2.resume_generations
         where pair_id=${pairId}
           and status in ('queued','collecting','extracting','strategizing','validating','rendering','archiving','held')
         order by id for update
      `
    : await query`
        select id, status, stage from submissions_v2.resume_generations
         where pair_id=${pairId}
           and status in ('queued','collecting','extracting','strategizing','validating','rendering','archiving','held')
         order by id
      `;
  const jobs = lock
    ? await query`
        select id, state, kind, fencing_token from submissions_v2.jobs
         where subject_type='pair' and subject_id=${pairId}::text and state in ('queued','running','held')
         order by id for update
      `
    : await query`
        select id, state, kind, fencing_token from submissions_v2.jobs
         where subject_type='pair' and subject_id=${pairId}::text and state in ('queued','running','held')
         order by id
      `;
  const objectRows = await query`
    select se.encrypted_body_object_key as object_key
      from submissions_v2.source_events se
      join submissions_v2.candidate_role_pairs p on p.first_signal_id=se.id
     where p.id=${pairId} and se.encrypted_body_object_key is not null
    union
    select se.encrypted_sender_object_key
      from submissions_v2.source_events se
      join submissions_v2.candidate_role_pairs p on p.first_signal_id=se.id
     where p.id=${pairId} and se.encrypted_sender_object_key is not null
    union
    select rs.output_object_key
      from submissions_v2.resume_stage_runs rs
      join submissions_v2.resume_generations rg on rg.id=rs.generation_id
     where rg.pair_id=${pairId} and rs.output_object_key is not null
    union
    select reservation.object_key
      from submissions_v2.upload_reservations reservation
     where reservation.pair_id=${pairId} and reservation.state <> 'purged'
    union
    select reservation.object_key
      from submissions_v2.private_object_reservations reservation
      join submissions_v2.resume_generations generation on reservation.owner_ref=generation.id::text
     where generation.pair_id=${pairId} and reservation.state <> 'purged'
  `;
  return deletionSnapshot({
    pair,
    artifacts,
    supplements,
    generations,
    jobs,
    objectKeys: [
      ...objectRows.map((row) => row.object_key),
      ...artifacts.map((row) => row.private_object_key),
      ...supplements.flatMap((row) => [row.object_key, row.extracted_text_object_key]),
    ],
  });
}

export function createRepository({ sql = database(), env = process.env } = {}) {
  const notificationDestination = () => exactSlackChannel(env.SUBMISSIONS_V2_SLACK_CHANNEL_ID);
  // This digest is deliberately deployment-independent: rotating the case-
  // recovery HMAC key must never resurrect a permanently purged candidate.
  const candidateSuppressionHmac = (candidateId) => digest(`submissions-v2-candidate-suppression:v1\0${candidateId}`);
  const recordPrivacyDrop = async (tx, { idempotencyKey, metricKey, droppedRoleCount }) => {
    const count = Math.max(1, Number(droppedRoleCount) || 1);
    const eventDigest = digest(`submissions-v2-privacy-event:v1\0${idempotencyKey}`);
    const inserted = await tx`
      insert into submissions_v2.privacy_safe_events(event_digest, metric_key, dropped_role_count)
      values (${eventDigest}, ${metricKey}, ${count})
      on conflict (event_digest, metric_key) do nothing returning event_digest
    `;
    if (inserted.length) {
      await tx`
        insert into submissions_v2.privacy_safe_metrics(metric_key, event_count, dropped_role_count)
        values (${metricKey}, 1, ${count})
        on conflict (metric_key) do update set
          event_count=privacy_safe_metrics.event_count+1,
          dropped_role_count=privacy_safe_metrics.dropped_role_count+excluded.dropped_role_count,
          updated_at=clock_timestamp()
      `;
    }
    return inserted.length > 0;
  };
  const reserveFirstResponse = async (tx, { candidateId, roleId, eventId, sourceFamily }) => {
    await tx`
      insert into submissions_v2.first_response_claims(candidate_user_id, role_id, event_id, source_family)
      values (${candidateId}, ${roleId}, ${eventId}, ${sourceFamily})
      on conflict do nothing
    `;
    const claim = (await tx`
      select * from submissions_v2.first_response_claims
       where candidate_user_id=${candidateId} and role_id=${roleId} and released_at is null for update
    `)[0];
    return claim?.event_id === eventId && claim?.source_family === sourceFamily ? claim : null;
  };
  return {
    async list({ page, query = "", cursor = null, limit = 100 }) {
      if (!PAGE_STATES.has(page)) throw problem("page_invalid", "The requested submissions page is invalid.", 400);
      const take = boundedLimit(limit);
      const after = decodeCursor(cursor);
      const needle = clean(query, 200).toLowerCase();
      const pattern = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;

      let rows;
      if (page === "needs_review") {
        rows = await sql`
          with review_rows as (
            select
              p.id as pair_id, p.first_signal_id as signal_id, p.state_version, p.candidate_user_id,
              c.display_name as candidate_name, null::text as provisional_name,
              c.paraform_profile_url as candidate_url, c.linkedin_url, c.raydar_url,
              p.role_id, r.company_name, r.role_title,
              concat_ws(' · ', r.company_name, r.role_title) as role_label,
              r.destination_url as role_url, 1::bigint as offered_role_count, '[]'::jsonb as offered_roles,
              se.envelope->>'signal_url' as signal_url,
              p.original_signal_at as signal_at, p.workflow_state,
              coalesce(rv.reasons, '[]'::jsonb) as review_reasons,
              '[]'::jsonb as resume_cautions, g.status as generation_status,
              p.submission_status, null::text as negative_reason, null::text as corrected_destination,
              r.last_confirmed_at as role_last_confirmed_at, sh.last_success_at as source_last_success_at,
              p.original_signal_at as sort_at, p.id as sort_id
            from submissions_v2.candidate_role_pairs p
            left join submissions_v2.candidate_index c on c.candidate_user_id=p.candidate_user_id
            left join submissions_v2.role_index r on r.role_id=p.role_id
            join submissions_v2.source_events se on se.id=p.first_signal_id
            left join lateral (
              select jsonb_agg(jsonb_build_object('reason_code', reason_code, 'safe_detail', safe_detail) order by opened_at, id) as reasons
              from submissions_v2.review_items where pair_id=p.id and action_state='open'
            ) rv on true
            left join lateral (
              select coalesce(active.id, latest.id) as id,
                     case when active.status is not null then active.status
                          when pending_job.id is not null then 'queued'
                          else latest.status end as status
                from (select 1) seed
                left join lateral (
                  select id, status from submissions_v2.resume_generations
                   where pair_id=p.id order by generation_version desc limit 1
                ) latest on true
                left join lateral (
                  select id, status from submissions_v2.resume_generations
                   where pair_id=p.id and status in ('queued','collecting','extracting','strategizing','validating','rendering','archiving')
                   order by generation_version desc limit 1
                ) active on true
                left join lateral (
                  select id from submissions_v2.jobs
                   where kind='prepare_resume' and subject_type='pair' and subject_id=p.id::text
                     and state in ('queued','running')
                   order by created_at desc limit 1
                ) pending_job on true
            ) g on true
            left join lateral (
              select max(last_success_at) as last_success_at from submissions_v2.source_health where enabled
            ) sh on true
            where p.workflow_state='needs_review' and p.case_hidden_at is null
              and (${needle}='' or coalesce(c.search_key,'') like ${pattern} escape '\\')
            union all
            select
              null::uuid as pair_id, se.id as signal_id, 0::bigint as state_version, null::text as candidate_user_id,
              null::text as candidate_name, se.sender_display_name as provisional_name,
              null::text as candidate_url, null::text as linkedin_url, null::text as raydar_url,
              offered.role_id, offered.company_snapshot as company_name, offered.role_label_snapshot as role_title,
              offered.role_label_snapshot as role_label, offered.role_url_snapshot as role_url,
              offered.count as offered_role_count, offered.roles as offered_roles, se.envelope->>'signal_url' as signal_url,
              se.received_at as signal_at, 'needs_review'::text as workflow_state,
              rv.reasons as review_reasons, '[]'::jsonb as resume_cautions, null::text as generation_status,
              'none'::text as submission_status, null::text as negative_reason, null::text as corrected_destination,
              null::timestamptz as role_last_confirmed_at, sh.last_success_at as source_last_success_at,
              se.received_at as sort_at, se.id as sort_id
            from submissions_v2.source_events se
            join lateral (
              select min(role_id) as role_id, min(company_snapshot) as company_snapshot,
                     min(role_label_snapshot) as role_label_snapshot, min(role_url_snapshot) as role_url_snapshot,
                     count(*)::bigint as count,
                     jsonb_agg(jsonb_build_object(
                       'role_id', role_id, 'company', company_snapshot, 'title', role_label_snapshot, 'url', role_url_snapshot
                     ) order by offered_order, role_id) as roles
                from submissions_v2.source_offered_roles where signal_id=se.id
            ) offered on true
            join lateral (
              select jsonb_agg(jsonb_build_object('reason_code', reason_code, 'safe_detail', safe_detail) order by opened_at, id) as reasons
                from submissions_v2.review_items where unresolved_signal_id=se.id and action_state='open'
            ) rv on rv.reasons is not null
            left join lateral (
              select max(last_success_at) as last_success_at from submissions_v2.source_health where enabled
            ) sh on true
            where (${needle}='' or lower(coalesce(se.sender_display_name,'')) like ${pattern} escape '\\')
          ), paged as (
            select *, count(*) over()::bigint as total_count from review_rows
             where (${after?.at || null}::timestamptz is null or (sort_at, sort_id) < (${after?.at || null}::timestamptz, ${after?.id || null}::uuid))
             order by sort_at desc, sort_id desc limit ${take + 1}
          ) select * from paged
        `;
      } else if (page === "not_interested") {
        rows = await sql`
          select
            p.id as pair_id, ni.source_event_id as signal_id, p.state_version, p.candidate_user_id,
            c.display_name as candidate_name, null::text as provisional_name,
            c.paraform_profile_url as candidate_url, c.linkedin_url, c.raydar_url,
            p.role_id, r.company_name, r.role_title, concat_ws(' · ', r.company_name, r.role_title) as role_label,
            r.destination_url as role_url, 1::bigint as offered_role_count, '[]'::jsonb as offered_roles, se.envelope->>'signal_url' as signal_url,
            ni.original_negative_at as signal_at, p.workflow_state, '[]'::jsonb as review_reasons,
            '[]'::jsonb as resume_cautions, null::text as generation_status, p.submission_status,
            ni.grounded_reason as negative_reason, ni.corrected_destination,
            r.last_confirmed_at as role_last_confirmed_at, sh.last_success_at as source_last_success_at,
            ni.original_negative_at as sort_at, ni.id as sort_id,
            count(*) over()::bigint as total_count
          from submissions_v2.not_interested_entries ni
          join submissions_v2.candidate_role_pairs p on p.id=ni.pair_id
          left join submissions_v2.candidate_index c on c.candidate_user_id=p.candidate_user_id
          left join submissions_v2.role_index r on r.role_id=p.role_id
          join submissions_v2.source_events se on se.id=ni.source_event_id
          left join lateral (select max(last_success_at) as last_success_at from submissions_v2.source_health where enabled) sh on true
          where p.case_hidden_at is null
            and (${needle}='' or coalesce(c.search_key,'') like ${pattern} escape '\\')
            and (${after?.at || null}::timestamptz is null or (ni.original_negative_at, ni.id) < (${after?.at || null}::timestamptz, ${after?.id || null}::uuid))
          order by ni.original_negative_at desc, ni.id desc limit ${take + 1}
        `;
      } else {
        rows = await sql`
          select
            p.id as pair_id, p.first_signal_id as signal_id, p.state_version, p.candidate_user_id,
            c.display_name as candidate_name, null::text as provisional_name,
            c.paraform_profile_url as candidate_url, c.linkedin_url, c.raydar_url,
            p.role_id, r.company_name, r.role_title, concat_ws(' · ', r.company_name, r.role_title) as role_label,
            r.destination_url as role_url, 1::bigint as offered_role_count, '[]'::jsonb as offered_roles, se.envelope->>'signal_url' as signal_url,
            p.original_signal_at as signal_at, p.workflow_state, '[]'::jsonb as review_reasons,
            coalesce(caution.cautions, '[]'::jsonb) as resume_cautions, g.status as generation_status,
            g.stage as generation_stage, g.safe_error_code as preparation_error_code,
            g.safe_error_detail as preparation_error_detail,
            p.submission_status, current_artifact.id as current_artifact_id, current_artifact.artifact_version,
            (current_artifact.id is not null) as artifact_ready, r.active as role_active,
            null::text as negative_reason, null::text as corrected_destination,
            r.last_confirmed_at as role_last_confirmed_at, sh.last_success_at as source_last_success_at,
            p.original_signal_at as sort_at, p.id as sort_id,
            count(*) over()::bigint as total_count
          from submissions_v2.candidate_role_pairs p
          left join submissions_v2.candidate_index c on c.candidate_user_id=p.candidate_user_id
          left join submissions_v2.role_index r on r.role_id=p.role_id
          join submissions_v2.source_events se on se.id=p.first_signal_id
          left join lateral (
            select coalesce(active.id, latest.id) as id,
                   case when active.status is not null then active.status
                        when pending_job.id is not null then 'queued'
                        when latest.status is not null then latest.status
                        when latest_job.state in ('failed','held','cancelled') then latest_job.state
                        else null end as status,
                   case when active.status is not null then active.stage
                        when pending_job.id is not null then case when pending_job.state='running' then 'starting' else 'queued' end
                        when latest.status is not null then latest.stage
                        else latest_job.state end as stage,
                   case when active.status is not null or pending_job.id is not null then null
                        when latest.status in ('failed','held','cancelled') then latest.safe_failure_code
                        when latest_job.state in ('failed','held','cancelled') then coalesce(latest_job.safe_error_code, latest_job.hold_reason)
                        else null end as safe_error_code,
                   case when active.status is not null or pending_job.id is not null then null
                        when latest.status in ('failed','held','cancelled') then latest.safe_failure_detail
                        when latest_job.state in ('failed','held','cancelled') then latest_job.safe_error_detail
                        else null end as safe_error_detail
              from (select 1) seed
              left join lateral (
                select id, status, stage, safe_failure_code, safe_failure_detail
                  from submissions_v2.resume_generations
                 where pair_id=p.id order by generation_version desc limit 1
              ) latest on true
              left join lateral (
                select id, status, stage from submissions_v2.resume_generations
                 where pair_id=p.id and status in ('queued','collecting','extracting','strategizing','validating','rendering','archiving')
                 order by generation_version desc limit 1
              ) active on true
              left join lateral (
                select id, state from submissions_v2.jobs
                 where kind='prepare_resume' and subject_type='pair' and subject_id=p.id::text
                   and state in ('queued','running')
                 order by created_at desc limit 1
              ) pending_job on true
              left join lateral (
                select state, safe_error_code, safe_error_detail, hold_reason
                  from submissions_v2.jobs
                 where kind='prepare_resume' and subject_type='pair' and subject_id=p.id::text
                 order by created_at desc limit 1
              ) latest_job on true
          ) g on true
          left join submissions_v2.resume_artifacts current_artifact
            on current_artifact.id=p.current_artifact_id and current_artifact.pair_id=p.id
           and current_artifact.kind='pdf' and current_artifact.validation_status='passed'
           and current_artifact.current_state='current' and current_artifact.deleted_at is null
           and current_artifact.archived_at is not null and current_artifact.archive_readback_at is not null
          left join lateral (
            select jsonb_agg(jsonb_build_object('source_key', source_key, 'safe_detail', remediation, 'impact', accuracy_impact) order by source_key) as cautions
              from submissions_v2.resume_sources where generation_id=g.id and status <> 'present'
          ) caution on true
          left join lateral (select max(last_success_at) as last_success_at from submissions_v2.source_health where enabled) sh on true
          where p.workflow_state in ('preparing_resume','interested') and p.case_hidden_at is null
            and (${needle}='' or coalesce(c.search_key,'') like ${pattern} escape '\\')
            and (${after?.at || null}::timestamptz is null or (p.original_signal_at, p.id) < (${after?.at || null}::timestamptz, ${after?.id || null}::uuid))
          order by p.original_signal_at desc, p.id desc limit ${take + 1}
        `;
      }
      const hasMore = rows.length > take;
      const visible = rows.slice(0, take);
      return {
        rows: visible,
        total: Number(visible[0]?.total_count || 0),
        next_cursor: hasMore ? encodeCursor(visible.at(-1)) : null,
      };
    },

    async counts() {
      const rows = await sql`
        select
          (select count(*) from submissions_v2.candidate_role_pairs where workflow_state in ('preparing_resume','interested') and case_hidden_at is null)::bigint as interested,
          ((select count(*) from submissions_v2.candidate_role_pairs where workflow_state='needs_review' and case_hidden_at is null)
           + (select count(distinct unresolved_signal_id) from submissions_v2.review_items where unresolved_signal_id is not null and action_state='open'))::bigint as needs_review,
          (select count(*) from submissions_v2.not_interested_entries ni join submissions_v2.candidate_role_pairs p on p.id=ni.pair_id where p.case_hidden_at is null)::bigint as not_interested,
          ((select count(*) from submissions_v2.candidate_role_pairs where workflow_state in ('preparing_resume','interested') and submission_status <> 'proven' and case_hidden_at is null)
           + (select count(*) from submissions_v2.candidate_role_pairs where workflow_state='needs_review' and case_hidden_at is null)
           + (select count(distinct unresolved_signal_id) from submissions_v2.review_items where unresolved_signal_id is not null and action_state='open'))::bigint as actionable
      `;
      return rows[0] || { interested: 0, needs_review: 0, not_interested: 0, actionable: 0 };
    },

    async health() {
      const rows = await sql`
        select
          coalesce(bool_or(enabled and (delayed_since is not null or error_class is not null)), false) as delayed,
          max(last_success_at) as last_success_at,
          jsonb_object_agg(source_key, jsonb_build_object(
            'enabled', enabled, 'last_success_at', last_success_at, 'delayed_since', delayed_since,
            'quota_state', quota_state, 'error_class', error_class, 'safe_error_detail', safe_error_detail
          ) order by source_key) filter (where source_key is not null) as sources
        from submissions_v2.source_health
      `;
      return { ...(rows[0] || {}), database: "current" };
    },

    async searchCandidates({ query, limit = 50 }) {
      const needle = clean(query, 200).toLowerCase();
      if (needle.length < 2) return [];
      const pattern = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
      return sql`
        select candidate_user_id as id, display_name as name,
               concat_ws(' · ', case when has_recorded_call then 'Recorded call' end, owner_email) as headline,
               paraform_profile_url as url
          from submissions_v2.candidate_index
         where active and search_key like ${pattern} escape '\\'
         order by similarity(search_key, ${needle}) desc, display_name, candidate_user_id
         limit ${boundedLimit(limit, 50, 50)}
      `;
    },

    async searchRoles({ query, limit = 50 }) {
      const needle = clean(query, 200).toLowerCase();
      if (needle.length < 2) return [];
      const pattern = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
      return sql`
        select role_id as id, company_name as company, role_title as title, destination_url as url
          from submissions_v2.role_index
         where active and search_key like ${pattern} escape '\\'
         order by similarity(search_key, ${needle}) desc, company_name, role_title, role_id
         limit ${boundedLimit(limit, 50, 50)}
      `;
    },

    async pair(pairId) {
      const rows = await sql`
        select p.*, c.display_name as candidate_name, c.paraform_profile_url as candidate_url,
               c.linkedin_url, c.raydar_url, r.company_name, r.role_title, r.destination_url,
               r.active as role_active, r.last_confirmed_at as role_last_confirmed_at,
               a.private_object_key as artifact_object_key, a.digest as artifact_digest,
               a.artifact_version, a.validation_status as artifact_validation_status,
               (a.id is not null) as artifact_ready
          from submissions_v2.candidate_role_pairs p
          left join submissions_v2.candidate_index c on c.candidate_user_id=p.candidate_user_id
          left join submissions_v2.role_index r on r.role_id=p.role_id
          left join submissions_v2.resume_artifacts a
            on a.id=p.current_artifact_id and a.pair_id=p.id and a.kind='pdf'
           and a.validation_status='passed' and a.current_state='current' and a.deleted_at is null
           and a.archived_at is not null and a.archive_readback_at is not null
         where p.id=${pairId} and p.case_hidden_at is null
      `;
      return rows[0] || null;
    },

    async jobs({ pairId = null, state = null, limit = 50 }) {
      return sql`
        select j.id, j.kind, j.subject_type, j.subject_id, j.state, j.priority,
               j.attempt_count, j.max_attempts, j.safe_error_code, j.safe_error_detail,
               j.hold_reason, j.scheduled_at, j.created_at, j.updated_at, j.started_at, j.completed_at
          from submissions_v2.jobs j
         where (${pairId}::text is null or (j.subject_type='pair' and j.subject_id=${pairId}::text))
           and (${state}::text is null or j.state=${state})
           and (j.subject_type <> 'pair' or exists (
             select 1 from submissions_v2.candidate_role_pairs p
              where p.id::text=j.subject_id and p.case_hidden_at is null
           ))
         order by j.created_at desc, j.id desc limit ${boundedLimit(limit, 50, 100)}
      `;
    },

    async sourceByIdempotency(idempotencyKey) {
      const rows = await sql`select * from submissions_v2.source_events where idempotency_key=${idempotencyKey}`;
      return rows[0] || null;
    },

    async sourceByProvider(mailboxId, providerMessageId) {
      const rows = await sql`
        select * from submissions_v2.source_events
         where source_family='email' and mailbox_id=${mailboxId} and provider_message_id=${providerMessageId}
      `;
      return rows[0] || null;
    },

    async source(signalId) {
      const rows = await sql`select * from submissions_v2.source_events where id=${signalId}`;
      return rows[0] || null;
    },

    async sourceForClassification({ signalId, candidateId = null, roleIds = [], executionFence }) {
      return sql.begin(async (tx) => {
        await assertWorkerFence(tx, executionFence, "master_inbox");
        const source = (await tx`select * from submissions_v2.source_events where id=${signalId} for update`)[0];
        if (!source) return null;
        if (["resolved", "ignored_later"].includes(source.processing_state)) {
          return { ...source, offered_roles: [], classification_skipped: true };
        }
        const resolvedCandidateId = clean(candidateId, 200)
          || source.envelope?.candidate_resolution?.candidate_user_id
          || source.envelope?.candidate_resolution?.candidate?.candidate_user_id;
        if (!resolvedCandidateId) throw problem("candidate_not_found", "The candidate has not been resolved.", 409);
        const requestedRoleIds = new Set((Array.isArray(roleIds) ? roleIds : []).map((value) => clean(value, 200)).filter(Boolean));
        const offeredRoles = await tx`
          select offered.role_id, offered.company_snapshot as company,
                 offered.role_label_snapshot as title, offered.role_url_snapshot as url
            from submissions_v2.source_offered_roles offered
            join submissions_v2.first_response_claims claim
              on claim.signal_id=offered.signal_id and claim.role_id=offered.role_id
             and claim.candidate_user_id=${resolvedCandidateId} and claim.released_at is null
           where offered.signal_id=${signalId}
             and (${requestedRoleIds.size === 0} or offered.role_id=any(${tx.array([...requestedRoleIds], 25)}))
             and not exists (
               select 1 from submissions_v2.candidate_role_pairs pair
                where pair.candidate_user_id=${resolvedCandidateId} and pair.role_id=offered.role_id
                  and not (
                    pair.first_signal_id=${signalId} and pair.case_hidden_at is null
                    and pair.intent_state='unclear' and pair.workflow_state='needs_review'
                    and exists (
                      select 1 from submissions_v2.review_items review
                       where review.pair_id=pair.id and review.reason_code='classification_failed'
                         and review.action_state='open'
                    )
                  )
             )
           order by offered.offered_order, offered.role_id
        `;
        if (!offeredRoles.length) {
          await tx`
            update submissions_v2.source_events
               set processing_state='ignored_later', processed_at=clock_timestamp(),
                   safe_error_code=null, safe_error_detail=null
             where id=${signalId}
          `;
          await recordPrivacyDrop(tx, {
            idempotencyKey: source.idempotency_key,
            metricKey: "later_signal_dropped",
            droppedRoleCount: Math.max(1, requestedRoleIds.size),
          });
          return { ...source, processing_state: "ignored_later", offered_roles: [], classification_skipped: true };
        }
        return { ...source, offered_roles: offeredRoles, classification_skipped: false };
      });
    },

    async claimEmailFirstResponse({ eventId, idempotencyKey, candidateId, offeredRoles = [] }) {
      return sql.begin(async (tx) => {
        const activeControls = (await tx`select * from submissions_v2.lock_runtime_controls()`)[0];
        if (!activeControls?.ingestion_enabled || !activeControls?.master_inbox_enabled) {
          throw problem("submissions_v2_control_disabled", "Submissions V2 email intake is disabled.", 503);
        }
        const roles = [...new Map(offeredRoles.map((role) => [clean(role.role_id, 200), role])).entries()]
          .filter(([roleId]) => Boolean(roleId)).sort(([left], [right]) => left.localeCompare(right));
        const eligibleRoleIds = [];
        let droppedRoleCount = 0;
        for (const [roleId] of roles) {
          await tx`select pg_advisory_xact_lock(hashtextextended(${pairAdvisoryLockKey(candidateId, roleId)}, 0))`;
          const pair = (await tx`
            select id from submissions_v2.candidate_role_pairs
             where candidate_user_id=${candidateId} and role_id=${roleId} for update
          `)[0];
          if (pair) {
            droppedRoleCount += 1;
            continue;
          }
          const claim = await reserveFirstResponse(tx, { candidateId, roleId, eventId, sourceFamily: "email" });
          if (claim) eligibleRoleIds.push(roleId);
          else droppedRoleCount += 1;
        }
        if (droppedRoleCount > 0) {
          await recordPrivacyDrop(tx, {
            idempotencyKey,
            metricKey: eligibleRoleIds.length ? "later_role_dropped" : "later_signal_dropped",
            droppedRoleCount,
          });
        }
        return {
          eligible_role_ids: eligibleRoleIds,
          dropped_role_count: droppedRoleCount,
          ignored_later: eligibleRoleIds.length === 0,
        };
      });
    },

    async candidateMatches(event) {
      const current = clean(event.sender_match_hmac?.digest ?? event.sender_match_hmac?.value ?? event.sender_match_hmac, 500);
      const previous = clean(event.previous_sender_match_hmac?.digest ?? event.previous_sender_match_hmac?.value ?? event.previous_sender_match_hmac, 500);
      if (!current && !previous) return { candidate: null, ambiguous: false };
      const rows = await sql`
        select * from submissions_v2.candidate_index
         where active and (
           (${current} <> '' and (email_match_hmac_current=${current} or email_match_hmac_previous=${current}))
           or (${previous} <> '' and (email_match_hmac_current=${previous} or email_match_hmac_previous=${previous}))
         )
         order by has_recorded_call desc, last_call_at desc nulls last, candidate_user_id
      `;
      if (rows.length <= 1) return { candidate: rows[0] || null, ambiguous: false };
      const withCalls = rows.filter((row) => row.has_recorded_call);
      return withCalls.length === 1
        ? { candidate: withCalls[0], ambiguous: false }
        : { candidate: null, ambiguous: true };
    },

    async reservePrivateObject({ reservationId, objectKey, purpose, ownerRef, expectedDigest, expiresAt, executionFence = null, generationId = null }) {
      const allowed = new Set(["source_event", "case_manifest", "resume_checkpoint", "resume_artifact", "supplement_text"]);
      if (!allowed.has(purpose) || !/^[a-f0-9]{64}$/iu.test(String(expectedDigest || ""))) {
        throw problem("private_object_reservation_invalid", "The private-object reservation is invalid.", 400);
      }
      return sql.begin(async (tx) => {
        if (executionFence || generationId) {
          if (!executionFence || !generationId) throw problem("generation_execution_fence_required", "A generation-bound private write requires its execution fence.", 409);
          await assertGenerationFence(tx, executionFence, generationId);
        }
        await tx`
          insert into submissions_v2.private_object_reservations(
            id, object_key, purpose, owner_ref, expected_digest, expires_at,
            write_owner, write_lease_expires_at, write_fencing_token
          ) values (
            ${reservationId}, ${objectKey}, ${purpose}, ${ownerRef}, ${String(expectedDigest).toLowerCase()}, ${new Date(expiresAt).toISOString()},
            ${reservationId}, clock_timestamp() + interval '15 minutes', 1
          ) on conflict (object_key) do nothing
        `;
        let reservation = (await tx`
          select *, write_lease_expires_at > clock_timestamp() as write_lease_active
            from submissions_v2.private_object_reservations where object_key=${objectKey} for update
        `)[0];
        if (!reservation || reservation.purpose !== purpose || reservation.owner_ref !== String(ownerRef)
          || reservation.expected_digest !== String(expectedDigest).toLowerCase()
          || !new Set(["pending", "committed"]).has(reservation.state)) {
          throw problem("private_object_reservation_conflict", "The private-object path is reserved for different content.", 409);
        }
        if (reservation.state === "pending" && reservation.write_owner !== String(reservationId)) {
          if (reservation.write_lease_active) {
            throw problem("private_object_write_in_progress", "The private-object path already has an active writer.", 409);
          }
          reservation = (await tx`
            update submissions_v2.private_object_reservations
               set write_owner=${reservationId}, write_lease_expires_at=clock_timestamp() + interval '15 minutes',
                   write_fencing_token=write_fencing_token+1
             where id=${reservation.id} and state='pending'
            returning *
          `)[0];
        }
        return reservation;
      });
    },

    async commitPrivateObjectReservation({ reservationId, objectKey, expectedDigest, writeFencingToken }) {
      const rows = await sql`
        update submissions_v2.private_object_reservations
           set state='committed', committed_at=coalesce(committed_at, clock_timestamp()),
               write_owner=null, write_lease_expires_at=null
         where id=${reservationId} and object_key=${objectKey} and expected_digest=${String(expectedDigest).toLowerCase()}
           and (state='committed' or (state='pending' and write_fencing_token=${Number(writeFencingToken)}
             and write_lease_expires_at >= clock_timestamp()))
        returning *
      `;
      if (!rows.length) throw problem("private_object_reservation_fence_lost", "The private-object reservation was lost.", 409);
      return rows[0];
    },

    async renewPrivateObjectWrite({ reservationId, objectKey, expectedDigest, writeFencingToken, executionFence = null, generationId = null }) {
      return sql.begin(async (tx) => {
        if (executionFence || generationId) {
          if (!executionFence || !generationId) throw problem("generation_execution_fence_required", "A generation-bound private write requires its execution fence.", 409);
          await assertGenerationFence(tx, executionFence, generationId);
        }
        const rows = await tx`
          update submissions_v2.private_object_reservations
             set write_lease_expires_at=clock_timestamp() + interval '15 minutes'
           where id=${reservationId} and object_key=${objectKey}
             and expected_digest=${String(expectedDigest).toLowerCase()} and state='pending'
             and write_fencing_token=${Number(writeFencingToken)}
          returning *
        `;
        if (!rows.length) throw problem("private_object_write_fence_lost", "The private-object writer lost its fence before storage began.", 409);
        return rows[0];
      });
    },

    async recordEmailSource({ event, safeEnvelope, privateObjectKey, objectReservationId, objectWriteFencingToken, objectDigest, processingState, safeErrorCode = null, safeErrorDetail = null, candidateResolution = null }) {
      return sql.begin(async (tx) => {
        const activeControls = (await tx`select * from submissions_v2.lock_runtime_controls()`)[0];
        if (!activeControls?.ingestion_enabled || !activeControls?.master_inbox_enabled) {
          throw problem("submissions_v2_control_disabled", "Submissions V2 email intake is disabled.", 503);
        }
        const currentHmac = event.sender_match_hmac && typeof event.sender_match_hmac === "object" ? event.sender_match_hmac : null;
        const previousHmac = event.previous_sender_match_hmac && typeof event.previous_sender_match_hmac === "object" ? event.previous_sender_match_hmac : null;
        const inserted = await tx`
          insert into submissions_v2.source_events(
            source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
            provider_thread_id, outbound_message_id, direction, sent_at, received_at,
            encrypted_body_object_key, content_digest,
            sender_match_hmac_current, sender_match_hmac_current_version,
            sender_match_hmac_previous, sender_match_hmac_previous_version,
            sender_display_name, machine_flag, machine_reason, processing_state,
            safe_error_code, safe_error_detail, idempotency_key, envelope
          ) values (
            'email', ${event.schema_version}, ${event.event_id}, ${event.provider}, ${event.mailbox_id}, ${event.provider_message_id},
            ${event.provider_thread_id}, ${event.outbound_message_id}, 'inbound', ${event.sent_at}, ${event.received_at},
            ${privateObjectKey}, ${event.content_digest.toLowerCase()},
            ${clean(currentHmac?.digest ?? currentHmac?.value, 500) || null}, ${clean(currentHmac?.key_version ?? currentHmac?.version, 100) || null},
            ${clean(previousHmac?.digest ?? previousHmac?.value, 500) || null}, ${clean(previousHmac?.key_version ?? previousHmac?.version, 100) || null},
            ${event.sender_display_name}, ${event.machine_message}, ${event.machine_message ? "machine_message" : null}, ${processingState},
            ${safeErrorCode}, ${safeErrorDetail}, ${event.idempotency_key},
            ${tx.json({ ...safeEnvelope, candidate_resolution: candidateResolution })}
          ) on conflict (idempotency_key) do nothing returning *
        `;
        const source = inserted[0] || (await tx`select * from submissions_v2.source_events where idempotency_key=${event.idempotency_key} for share`)[0];
        if (!source) throw problem("source_record_failed", "The source event could not be recorded.", 503);
        const committed = await tx`
          update submissions_v2.private_object_reservations
           set state='committed', committed_at=coalesce(committed_at, clock_timestamp()),
               write_owner=null, write_lease_expires_at=null
           where id=${objectReservationId} and object_key=${privateObjectKey}
             and purpose='source_event' and owner_ref=${event.event_id}
             and expected_digest=${String(objectDigest || "").toLowerCase()}
             and (state='committed' or (state='pending' and write_fencing_token=${Number(objectWriteFencingToken)}
               and write_lease_expires_at >= clock_timestamp()))
          returning id
        `;
        if (!committed.length) {
          const reservation = (await tx`select * from submissions_v2.private_object_reservations where id=${objectReservationId} for share`)[0];
          if (!reservation || reservation.object_key !== privateObjectKey
            || reservation.purpose !== 'source_event' || reservation.owner_ref !== event.event_id
            || reservation.expected_digest !== String(objectDigest || "").toLowerCase()
            || reservation.state !== 'committed') {
            throw problem("private_object_reservation_fence_lost", "The source-event private-object reservation was lost.", 409);
          }
        }
        if (!inserted.length) return { source, existing: true, job: null };
        for (const [index, role] of event.offered_roles.entries()) {
          await tx`
            insert into submissions_v2.source_offered_roles(
              signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, offered_order, content_digest
            ) values (${source.id}, ${role.role_id}, ${role.company || null}, ${role.title || role.role_id}, ${role.url || null}, ${index}, ${digest(JSON.stringify(role))})
          `;
        }
        if (processingState === "ready") {
          const claimed = await tx`
            update submissions_v2.first_response_claims
               set signal_id=${source.id}, committed_at=coalesce(committed_at, clock_timestamp())
             where candidate_user_id=${candidateResolution?.candidate_user_id}
               and event_id=${event.event_id} and source_family='email'
               and released_at is null
               and role_id=any(${tx.array(event.offered_roles.map((role) => role.role_id), 25)})
               and (signal_id is null or signal_id=${source.id})
            returning role_id
          `;
          if (claimed.length !== event.offered_roles.length) {
            throw problem("first_response_claim_lost", "The first-response privacy claim changed before intake committed.", 409);
          }
        }
        if (processingState === "unsupported_version") {
          await tx`
            insert into submissions_v2.notification_outbox(kind, destination_id, safe_payload, dedupe_key)
            values (
              'unsupported_source_version', ${notificationDestination()},
              ${tx.json({ source_family: event.source_family, source_version: event.schema_version, monitor_url: "https://monitor.raydar.xyz/#submissions-v2" })},
              ${`unsupported-source-version:${event.source_family}:${event.schema_version}`}
            ) on conflict (dedupe_key) do nothing
          `;
        }
        if (processingState === "ready") {
          const job = await enqueue(tx, {
            kind: "classify_email_reply", subjectType: "signal", subjectId: source.id,
            idempotencyKey: `classify:${source.id}`, requiredControl: "master_inbox", priority: 20,
            checkpoint: { signal_id: source.id },
          });
          return { source, existing: false, job };
        }
        if (["needs_candidate", "needs_role"].includes(processingState)) {
          const reasonCode = processingState === "needs_candidate"
            ? (candidateResolution?.ambiguous ? "candidate_ambiguous" : "candidate_not_found")
            : "role_unclear";
          await tx`
            insert into submissions_v2.review_items(unresolved_signal_id, reason_code, safe_detail, evidence)
            values (${source.id}, ${reasonCode}, ${safeErrorDetail}, ${tx.json({ source_family: event.source_family, source_event_id: source.id })})
            on conflict do nothing
          `;
        }
        return { source, existing: false, job: null };
      });
    },

    async applyClassifiedSignal({ signalId, candidateId = null, decisions, attempts = [], actorId = "submissions-v2-worker", executionFence }) {
      return sql.begin(async (tx) => {
        await assertWorkerFence(tx, executionFence, "master_inbox");
        const sourceRows = await tx`select * from submissions_v2.source_events where id=${signalId} for update`;
        const source = sourceRows[0];
        if (!source) throw problem("source_not_found", "The source event was not found.", 404);
        if (["resolved", "ignored_later"].includes(source.processing_state)) return { signal_id: signalId, existing: true, pairs: [] };
        const resolvedCandidateId = candidateId || source.envelope?.candidate_resolution?.candidate_user_id || source.envelope?.candidate_resolution?.candidate?.candidate_user_id;
        if (!resolvedCandidateId) throw problem("candidate_not_found", "The candidate has not been resolved.", 409);
        const candidateRows = await tx`select * from submissions_v2.candidate_index where candidate_user_id=${resolvedCandidateId} and active`;
        if (!candidateRows.length) throw problem("candidate_not_found", "The candidate is no longer available in Paraform.", 409);
        const offered = await tx`select * from submissions_v2.source_offered_roles where signal_id=${signalId} order by offered_order, role_id`;
        const offeredByRole = new Map(offered.map((role) => [role.role_id, role]));
        if (!Array.isArray(decisions) || !decisions.length || decisions.some((item) => !offeredByRole.has(item.role_id))) {
          throw problem("classification_binding_invalid", "The classification did not bind only to offered roles.", 422);
        }
        const executionId = clean(executionFence?.jobId, 100);
        if (!/^[0-9a-f-]{36}$/iu.test(executionId)) throw problem("classification_execution_required", "Classification audit requires its worker execution id.", 409);
        const attemptOffset = Number((await tx`
          select coalesce(max(attempt), 0)::integer as value
            from submissions_v2.classification_attempts where signal_id=${signalId}
        `)[0]?.value || 0);
        for (const [index, attempt] of attempts.slice(0, 3).entries()) {
          const reason = clean(attempt.reason, 100);
          const outcome = attempt.outcome === "accepted" ? "passed"
            : reason === "quote_not_verbatim" ? "invalid_quote"
              : attempt.outcome === "invalid" ? "invalid_schema" : "technical_failure";
          await tx`
            insert into submissions_v2.classification_attempts(
              signal_id, attempt, execution_id, attempt_in_execution,
              model_pin, prompt_pin, fallback_reason, structured_result,
              exact_quote, input_tokens, output_tokens, cost_micros, duration_ms, outcome,
              safe_error_code, safe_error_detail
            ) values (
              ${signalId}, ${attemptOffset + index + 1}, ${executionId}, ${index + 1},
              ${clean(attempt.model, 200) || "unknown"},
              'submissions-v2-interest-classifier-2026-08-31.v1', ${index ? "primary_not_accepted" : null},
              ${tx.json({ decisions })}, ${clean(decisions[0]?.quote, 2_000) || null},
              ${Number(attempt.usage?.input_tokens) || null}, ${Number(attempt.usage?.output_tokens) || null},
              ${Math.max(0, Math.min(20_000, Math.round(Number(attempt.cost_usd || 0) * 1_000_000)))},
              ${Math.max(0, Math.min(30_000, Number(attempt.duration_ms) || 0))}, ${outcome},
              ${outcome === "passed" ? null : reason || "classifier_attempt_failed"},
              ${outcome === "passed" ? null : reason || "Classifier attempt did not pass validation"}
            ) on conflict (signal_id, execution_id, attempt_in_execution) do nothing
          `;
        }
        const results = [];
        let createdCount = 0;
        let appliedCount = 0;
        let recoveredCount = 0;
        const appliedRoleIds = [];
        for (const decision of decisions) {
          const role = offeredByRole.get(decision.role_id);
          const roleRows = await tx`select * from submissions_v2.role_index where role_id=${decision.role_id}`;
          const roleCurrent = roleRows[0] || null;
          const roleUnavailable = !roleCurrent?.active;
          const effectiveLabel = roleUnavailable && decision.label === "interested" ? "needs_review" : decision.label;
          const bindingResult = roleUnavailable ? "role_unavailable" : "exact_offered_role";
          await tx`select pg_advisory_xact_lock(hashtextextended(${pairAdvisoryLockKey(resolvedCandidateId, decision.role_id)}, 0))`;
          const existing = await tx`
            select * from submissions_v2.candidate_role_pairs
             where candidate_user_id=${resolvedCandidateId} and role_id=${decision.role_id} for update
          `;
          // The first candidate response owns this candidate-role pair forever;
          // later replies, including replies racing a soft deletion, stay detached.
          let recoveringFailure = false;
          let previousPair = null;
          if (existing.length) {
            const current = existing[0];
            const recoveryRows = current.first_signal_id === signalId && current.case_hidden_at === null
              ? await tx`
                  select review.id
                    from submissions_v2.review_items review
                    join submissions_v2.pair_signal_links link
                      on link.pair_id=review.pair_id and link.signal_id=${signalId}
                     and link.role_id=${decision.role_id} and link.link_kind='classification_failure'
                   where review.pair_id=${current.id} and review.reason_code='classification_failed'
                     and review.action_state='open'
                   for update of review
                `
              : [];
            if (!recoveryRows.length || current.workflow_state !== "needs_review" || current.intent_state !== "unclear") {
              results.push({ created: false, state: "ignored_later" });
              continue;
            }
            recoveringFailure = true;
            previousPair = current;
          }
          await tx`
            insert into submissions_v2.signal_role_decisions(
              signal_id, role_id, candidate_user_id, decision_label, exact_quote, binding_result,
              primary_model_pin, fallback_model_pin, selected_model_pin, prompt_pin, schema_version, validation
            ) values (
              ${signalId}, ${decision.role_id}, ${resolvedCandidateId}, ${effectiveLabel}, ${clean(decision.quote, 10_000) || null}, ${bindingResult},
              'gpt-5.4-nano-2026-03-17', 'gpt-5.4-2026-03-05', ${clean(attempts.find((item) => item.outcome === "accepted")?.model, 200) || "gpt-5.4-nano-2026-03-17"},
              'submissions-v2-interest-classifier-2026-08-31.v1', 'submissions.email_reply.v1',
              ${tx.json({ quote_validated: true, offered_role_bound: true })}
            ) on conflict (signal_id, role_id) do nothing
          `;
          const intent = effectiveLabel === "interested" || (roleUnavailable && decision.label === "interested")
            ? "interested" : effectiveLabel === "not_interested" ? "not_interested" : "unclear";
          const workflow = effectiveLabel === "interested" ? "preparing_resume" : effectiveLabel;
          let pair;
          if (recoveringFailure) {
            pair = (await tx`
              update submissions_v2.candidate_role_pairs
                 set intent_state=${intent}, workflow_state=${workflow},
                     role_state=${roleCurrent?.active ? "active" : "unavailable"},
                     role_checked_at=clock_timestamp(), state_version=state_version+1
               where id=${previousPair.id} and state_version=${previousPair.state_version}
               returning *
            `)[0];
            if (!pair) throw problem("stale_pair_version", "The candidate-role item changed before classification recovery was applied.", 409, pairCurrent(previousPair));
            recoveredCount += 1;
          } else {
            const pairRows = await tx`
              insert into submissions_v2.candidate_role_pairs(
                candidate_user_id, role_id, first_signal_id, intent_state, workflow_state,
                owner_email, original_signal_at, role_state, role_checked_at
              ) values (
                ${resolvedCandidateId}, ${decision.role_id}, ${signalId}, ${intent}, ${workflow},
                ${candidateRows[0].owner_email}, ${source.received_at},
                ${roleCurrent?.active ? "active" : "unavailable"}, clock_timestamp()
              ) on conflict (candidate_user_id, role_id) do nothing returning *
            `;
            if (!pairRows.length) {
              const winner = (await tx`
                select * from submissions_v2.candidate_role_pairs
                 where candidate_user_id=${resolvedCandidateId} and role_id=${decision.role_id} for update
              `)[0];
              if (!winner) throw problem("pair_creation_conflict", "The candidate-role item could not be created safely.", 409);
              results.push({ created: false, state: "ignored_later" });
              continue;
            }
            pair = pairRows[0];
            await tx`
              insert into submissions_v2.pair_signal_links(pair_id, signal_id, role_id, link_kind)
              values (${pair.id}, ${signalId}, ${decision.role_id}, 'classified_reply')
              on conflict do nothing
            `;
            createdCount += 1;
          }
          appliedCount += 1;
          appliedRoleIds.push(decision.role_id);
          if (workflow === "needs_review") {
            const reasonCode = roleUnavailable && decision.label === "interested" ? "role_unavailable" : (REVIEW_REASONS.has(decision.review_reason) ? decision.review_reason : "reply_unclear_or_conditional");
            await tx`
              insert into submissions_v2.review_items(pair_id, reason_code, safe_detail, evidence)
              values (${pair.id}, ${reasonCode}, ${reasonCode === "role_unavailable" ? "The exact offered role is not currently active." : null},
                      ${tx.json({ signal_id: signalId, exact_quote_digest: digest(decision.quote) })})
            `;
          } else if (workflow === "not_interested") {
            const groundedReason = clean(decision.negative_reason, 500) || "No reason provided";
            await tx`
              insert into submissions_v2.not_interested_entries(
                pair_id, source_event_id, original_negative_at, grounded_reason, exact_quote,
                evidence_digest, notification_dedupe_key
              ) values (
                ${pair.id}, ${signalId}, ${source.received_at}, ${groundedReason}, ${clean(decision.quote, 10_000)},
                ${source.content_digest}, ${`not-interested:${pair.id}:${signalId}`}
              )
            `;
            await tx`
              insert into submissions_v2.notification_outbox(kind, destination_id, safe_payload, dedupe_key, pair_id)
              values (
                'not_interested', ${notificationDestination()},
                ${tx.json({ candidate_name: candidateRows[0].display_name, company: roleCurrent?.company_name || role.company_snapshot, role_title: roleCurrent?.role_title || role.role_label_snapshot, owner_name: ownerDisplayName(pair.owner_email), monitor_url: "https://monitor.raydar.xyz/#submissions-v2" })},
                ${`not-interested:${pair.id}:${signalId}`}, ${pair.id}
              ) on conflict (dedupe_key) do nothing
            `;
          } else {
            await enqueue(tx, {
              kind: "prepare_resume", subjectType: "pair", subjectId: pair.id,
              idempotencyKey: `resume:initial:${signalId}:${decision.role_id}`, requiredControl: "generation", priority: 50,
              checkpoint: { trigger_kind: "initial", expected_pair_version: Number(pair.state_version) },
            });
          }
          if (recoveringFailure) {
            await tx`
              update submissions_v2.review_items
                 set action_state='resolved', resolved_at=clock_timestamp(), resolved_by=${actorId},
                     resolution_note='The approved classifier retry produced a grounded result.'
               where pair_id=${pair.id} and reason_code='classification_failed' and action_state='open'
            `;
          }
          await pairEvent(tx, pair, {
            actorType: "worker", actorId, source: "master_inbox", eventType: recoveringFailure ? "classification_recovered" : "first_signal_applied",
            reasonCode: workflow === "needs_review" ? (!roleCurrent?.active ? "role_unavailable" : decision.review_reason) : null,
            idempotencyKey: recoveringFailure ? `pair:classification-recovered:${signalId}:${decision.role_id}` : `pair:${signalId}:${decision.role_id}`,
          metadata: { source_family: source.source_family, decision_label: effectiveLabel, classified_label: decision.label },
          });
          results.push({ pair_id: pair.id, created: !recoveringFailure, recovered: recoveringFailure, state: pair.workflow_state });
        }
        const decidedRoleIds = decisions.map((decision) => decision.role_id);
        await tx`
          update submissions_v2.first_response_claims
             set released_at=clock_timestamp(),
                 release_reason=case
                   when role_id=any(${tx.array(decidedRoleIds, 25)}) then 'not_applied'
                   else 'unmentioned_role'
                 end
           where signal_id=${signalId} and released_at is null
             and (${appliedRoleIds.length === 0} or not (role_id=any(${tx.array(appliedRoleIds, 25)})))
        `;
        await tx`
          update submissions_v2.source_events
             set processing_state=${appliedCount ? "resolved" : "ignored_later"}, processed_at=clock_timestamp(), safe_error_code=null, safe_error_detail=null
           where id=${signalId}
        `;
        await tx`
          update submissions_v2.review_items
             set action_state='resolved', resolved_at=clock_timestamp(), resolved_by=${actorId},
                 resolution_note='Candidate and role binding completed during classification.'
           where unresolved_signal_id=${signalId} and action_state='open'
        `;
        return { signal_id: signalId, existing: false, pairs: results, created_count: createdCount, recovered_count: recoveredCount };
      });
    },

    async routeClassificationFailure({ signalId, attempts = [], spent = 0, actorId = "submissions-v2-worker", safeDetail = "Both approved classifier paths failed safely.", executionFence }) {
      return sql.begin(async (tx) => {
        await assertWorkerFence(tx, executionFence, "master_inbox");
        const sourceRows = await tx`select * from submissions_v2.source_events where id=${signalId} for update`;
        const source = sourceRows[0];
        if (!source) throw problem("source_not_found", "The source event was not found.", 404);
        const candidateId = source.envelope?.candidate_resolution?.candidate_user_id || source.envelope?.candidate_resolution?.candidate?.candidate_user_id;
        const offered = await tx`select * from submissions_v2.source_offered_roles where signal_id=${signalId}`;
        const candidate = candidateId ? (await tx`select * from submissions_v2.candidate_index where candidate_user_id=${candidateId} and active`)[0] : null;
        const pairs = [];
        let routedCount = 0;
        const executionId = clean(executionFence?.jobId, 100);
        if (!/^[0-9a-f-]{36}$/iu.test(executionId)) throw problem("classification_execution_required", "Classification audit requires its worker execution id.", 409);
        const attemptOffset = Number((await tx`
          select coalesce(max(attempt), 0)::integer as value
            from submissions_v2.classification_attempts where signal_id=${signalId}
        `)[0]?.value || 0);
        for (const [index, attempt] of attempts.slice(0, 3).entries()) {
          const reason = clean(attempt.reason, 100) || "classifier_attempt_failed";
          const outcome = reason.includes("timeout") ? "timeout"
            : attempt.outcome === "invalid" ? (reason === "quote_not_verbatim" ? "invalid_quote" : "invalid_schema")
              : Number(spent) >= 0.02 && index === attempts.slice(0, 3).length - 1 ? "budget_exhausted" : "technical_failure";
          await tx`
            insert into submissions_v2.classification_attempts(
              signal_id, attempt, execution_id, attempt_in_execution,
              model_pin, prompt_pin, fallback_reason,
              input_tokens, output_tokens, cost_micros, duration_ms, outcome,
              safe_error_code, safe_error_detail
            ) values (
              ${signalId}, ${attemptOffset + index + 1}, ${executionId}, ${index + 1},
              ${clean(attempt.model, 200) || "unknown"},
              'submissions-v2-interest-classifier-2026-08-31.v1', ${index ? "primary_not_accepted" : null},
              ${Number(attempt.usage?.input_tokens) || null}, ${Number(attempt.usage?.output_tokens) || null},
              ${Math.max(0, Math.min(20_000, Math.round(Number(attempt.cost_usd || 0) * 1_000_000)))},
              ${Math.max(0, Math.min(30_000, Number(attempt.duration_ms) || 0))}, ${outcome},
              ${reason}, ${reason}
            ) on conflict (signal_id, execution_id, attempt_in_execution) do nothing
          `;
        }
        if (["quarantined", "resolved", "ignored_later"].includes(source.processing_state)) {
          const boundPairs = await tx`
            select pair_id
              from submissions_v2.pair_signal_links
             where signal_id=${signalId} and link_kind='classification_failure'
             order by pair_id
          `;
          return { signal_id: signalId, pairs: boundPairs.map((row) => row.pair_id), existing: true };
        }
        if (candidateId) {
          for (const role of offered) {
            await tx`select pg_advisory_xact_lock(hashtextextended(${pairAdvisoryLockKey(candidateId, role.role_id)}, 0))`;
            let pair = (await tx`select * from submissions_v2.candidate_role_pairs where candidate_user_id=${candidateId} and role_id=${role.role_id} for update`)[0];
            if (pair) continue;
            if (!pair) {
              pair = (await tx`
                insert into submissions_v2.candidate_role_pairs(
                  candidate_user_id, role_id, first_signal_id, intent_state, workflow_state, owner_email, original_signal_at
                ) values (${candidateId}, ${role.role_id}, ${signalId}, 'unclear', 'needs_review', ${candidate?.owner_email || null}, ${source.received_at}) returning *
              `)[0];
              await tx`
                insert into submissions_v2.review_items(pair_id, reason_code, safe_detail, evidence)
                values (${pair.id}, 'classification_failed', ${clean(safeDetail, 500)}, ${tx.json({ signal_id: signalId })})
              `;
              await pairEvent(tx, pair, { actorType: "worker", actorId, source: "master_inbox", eventType: "classification_failed", reasonCode: "classification_failed", idempotencyKey: `pair:classification-failed:${signalId}:${role.role_id}` });
              await tx`
                insert into submissions_v2.notification_outbox(kind, destination_id, safe_payload, dedupe_key, pair_id)
                values ('classification_failed', ${notificationDestination()},
                        ${tx.json({ candidate_name: candidate?.display_name || "Candidate", company: role.company_snapshot || null, role_title: role.role_label_snapshot || null, owner_name: ownerDisplayName(pair.owner_email), monitor_url: "https://monitor.raydar.xyz/#submissions-v2" })}, ${`classification-failed:${signalId}:${role.role_id}`}, ${pair.id})
                on conflict (dedupe_key) do nothing
              `;
              routedCount += 1;
            }
            await tx`
              insert into submissions_v2.pair_signal_links(pair_id, signal_id, role_id, link_kind)
              values (${pair.id}, ${signalId}, ${role.role_id}, 'classification_failure')
              on conflict do nothing
            `;
            pairs.push(pair.id);
          }
        } else {
          await tx`
            insert into submissions_v2.review_items(unresolved_signal_id, reason_code, safe_detail, evidence)
            values (${signalId}, 'classification_failed', ${clean(safeDetail, 500)}, ${tx.json({ signal_id: signalId })})
            on conflict do nothing
          `;
          routedCount += 1;
        }
        await tx`
          update submissions_v2.source_events
             set processing_state=${routedCount ? "quarantined" : "ignored_later"}, processed_at=clock_timestamp(),
                 safe_error_code=${routedCount ? "classification_failed" : null},
                 safe_error_detail=${routedCount ? clean(safeDetail, 500) : null}
           where id=${signalId}
        `;
        return { signal_id: signalId, pairs };
      });
    },

    async addCandidate({ actorEmail, idempotencyKey, candidateId, roleId, sourcePairId = null, action = "add_candidate" }) {
      return sql.begin(async (tx) => command(tx, {
        actorEmail, action, idempotencyKey, input: { candidateId, roleId, sourcePairId },
      }, async (commandRow) => {
        if (sourcePairId) {
          const sourcePair = await tx`select * from submissions_v2.candidate_role_pairs where id=${sourcePairId} and case_hidden_at is null for share`;
          if (!sourcePair.length || sourcePair[0].candidate_user_id !== candidateId) throw problem("duplicate_source_invalid", "The source candidate could not be confirmed.", 409);
        }
        const candidates = await tx`select * from submissions_v2.candidate_index where candidate_user_id=${candidateId} and active`;
        if (!candidates.length) throw problem("candidate_not_found", "The candidate must already exist in Paraform.", 404);
        const roles = await tx`select * from submissions_v2.role_index where role_id=${roleId} and active`;
        if (!roles.length) throw problem("role_unavailable", "The selected Paraform role is not active.", 409);
        await tx`select pg_advisory_xact_lock(hashtextextended(${pairAdvisoryLockKey(candidateId, roleId)}, 0))`;
        const prior = await tx`select * from submissions_v2.candidate_role_pairs where candidate_user_id=${candidateId} and role_id=${roleId} for update`;
        if (prior.length) return { existing: true, case_id: prior[0].id, state: prior[0].workflow_state, state_version: Number(prior[0].state_version) };
        const manualEventId = `manual:${commandRow.id}`;
        const firstResponseClaim = await reserveFirstResponse(tx, {
          candidateId, roleId, eventId: manualEventId, sourceFamily: "manual",
        });
        if (!firstResponseClaim) {
          throw problem("first_response_pending", "An earlier candidate response for this role is still being processed.", 409);
        }
        const sourceDigest = digest(JSON.stringify({ action, candidateId, roleId, actorEmail, commandId: commandRow.id }));
        const source = (await tx`
          insert into submissions_v2.source_events(
            source_family, source_version, event_id, provider, direction, received_at,
            content_digest, processing_state, processed_at, idempotency_key, envelope
          ) values (
            'manual', 'submissions.manual.v1', ${manualEventId}, 'monitor', 'manual', clock_timestamp(),
            ${sourceDigest}, 'resolved', clock_timestamp(), ${`manual:${commandRow.id}`},
            ${tx.json({ actor_email: actorEmail, candidate_user_id: candidateId, role_id: roleId, source_pair_id: sourcePairId })}
          ) returning *
        `)[0];
        await tx`
          insert into submissions_v2.source_offered_roles(signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, content_digest)
          values (${source.id}, ${roleId}, ${roles[0].company_name}, ${roles[0].role_title}, ${roles[0].destination_url}, ${digest(roleId)})
        `;
        await tx`
          update submissions_v2.first_response_claims
             set signal_id=${source.id}, committed_at=clock_timestamp()
             where candidate_user_id=${candidateId} and role_id=${roleId}
             and event_id=${manualEventId} and signal_id is null and released_at is null
        `;
        const pairRows = await tx`
          insert into submissions_v2.candidate_role_pairs(
            candidate_user_id, role_id, first_signal_id, intent_state, workflow_state, owner_email, original_signal_at, role_state, role_checked_at
          ) values (${candidateId}, ${roleId}, ${source.id}, 'interested', 'preparing_resume', ${candidates[0].owner_email || actorEmail}, ${source.received_at}, 'active', clock_timestamp())
          on conflict (candidate_user_id, role_id) do nothing returning *
        `;
        if (!pairRows.length) {
          const winner = (await tx`select * from submissions_v2.candidate_role_pairs where candidate_user_id=${candidateId} and role_id=${roleId} for update`)[0];
          await tx`update submissions_v2.source_events set processing_state='ignored_later', processed_at=clock_timestamp() where id=${source.id}`;
          return { existing: true, case_id: winner.id, state: winner.workflow_state, state_version: Number(winner.state_version) };
        }
        const pair = pairRows[0];
        await tx`
          insert into submissions_v2.pair_signal_links(pair_id, signal_id, role_id, link_kind)
          values (${pair.id}, ${source.id}, ${roleId}, 'manual')
          on conflict do nothing
        `;
        await pairEvent(tx, pair, {
          actorId: actorEmail, source: action, eventType: "pair_created", idempotencyKey: `pair:${commandRow.id}`,
          metadata: { source_pair_id: sourcePairId },
        });
        const job = await queueResume(tx, pair, commandRow, "initial");
        return { existing: false, case_id: pair.id, state: pair.workflow_state, state_version: Number(pair.state_version), job_id: job?.id || null };
      }));
    },

    async transition({ actorEmail, idempotencyKey, pairId, expectedVersion, destination, note, action }) {
      return sql.begin(async (tx) => command(tx, {
        actorEmail, action, idempotencyKey, expectedVersion, pairId,
        input: { pairId, expectedVersion, destination, note },
      }, async (commandRow) => {
        const current = await lockPair(tx, pairId, expectedVersion);
        if (current.submission_status === "proven") throw problem("proven_pair_immutable", "A proven submission cannot be reclassified.", 409, pairCurrent(current));
        if (destination === "needs_review") {
          const updated = (await tx`
            update submissions_v2.candidate_role_pairs
               set intent_state='unclear', workflow_state='needs_review', state_version=state_version+1
             where id=${pairId} and state_version=${expectedVersion} returning *
          `)[0];
          await tx`
            insert into submissions_v2.review_items(pair_id, reason_code, safe_detail, evidence)
            values (${pairId}, 'reply_unclear_or_conditional', ${clean(note, 500)}, ${tx.json({ correction: true })})
            on conflict do nothing
          `;
          await tx`
            update submissions_v2.not_interested_entries
               set corrected_destination='needs_review', corrected_at=clock_timestamp(), corrected_by=${actorEmail},
                   correction_note=${clean(note, 500)}, active_projection=false
             where pair_id=${pairId} and active_projection
          `;
          await pairEvent(tx, updated, { actorId: actorEmail, source: action, eventType: "classification_corrected", expectedVersion, previous: current, note, reasonCode: "reply_unclear_or_conditional", idempotencyKey: `pair:${commandRow.id}` });
          return { case_id: pairId, state: updated.workflow_state, state_version: Number(updated.state_version) };
        }
        if (!new Set(["interested", "not_interested"]).has(destination)) throw problem("destination_invalid", "The correction destination is invalid.", 400);
        await tx`
          update submissions_v2.review_items
             set action_state='resolved', resolved_at=clock_timestamp(), resolved_by=${actorEmail}, resolution_note=${clean(note, 500)}
           where pair_id=${pairId} and action_state='open'
        `;
        const nextWorkflow = destination === "interested" ? "preparing_resume" : "not_interested";
        const updated = (await tx`
          update submissions_v2.candidate_role_pairs
             set intent_state=${destination}, workflow_state=${nextWorkflow}, state_version=state_version+1
           where id=${pairId} and state_version=${expectedVersion} returning *
        `)[0];
        if (!updated) throw problem("stale_pair_version", "The candidate-role item changed before this action was committed.", 409, pairCurrent(current));
        if (destination === "not_interested") {
          const originalSource = (await tx`select * from submissions_v2.source_events where id=${current.first_signal_id}`)[0];
          const candidate = (await tx`select display_name from submissions_v2.candidate_index where candidate_user_id=${current.candidate_user_id}`)[0];
          const role = (await tx`select company_name, role_title, destination_url from submissions_v2.role_index where role_id=${current.role_id}`)[0];
          const correctionDigest = digest(JSON.stringify({ pairId, actorEmail, note: clean(note, 500), commandId: commandRow.id }));
          const correctionSource = (await tx`
            insert into submissions_v2.source_events(
              source_family, source_version, event_id, provider, direction, received_at,
              content_digest, processing_state, processed_at, idempotency_key, envelope
            ) values (
              'manual', 'submissions.manual-correction.v1', ${`manual-correction:${commandRow.id}`}, 'monitor', 'manual', clock_timestamp(),
              ${correctionDigest}, 'resolved', clock_timestamp(), ${`manual-correction:${commandRow.id}`},
              ${tx.json({ actor_email: actorEmail, correction_of_signal_id: current.first_signal_id, signal_url: signalUrlFromEnvelope(originalSource?.envelope) })}
            ) returning *
          `)[0];
          await tx`
            insert into submissions_v2.source_offered_roles(
              signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, content_digest
            ) values (
              ${correctionSource.id}, ${current.role_id}, ${role?.company_name || null}, ${role?.role_title || current.role_id},
              ${role?.destination_url || null}, ${digest(current.role_id)}
            )
          `;
          const notificationKey = `not-interested:${pairId}:${correctionSource.id}`;
          await tx`
            insert into submissions_v2.not_interested_entries(
              pair_id, source_event_id, original_negative_at, grounded_reason, evidence_digest, notification_dedupe_key
            ) values (${pairId}, ${correctionSource.id}, clock_timestamp(), ${clean(note, 500)}, ${correctionDigest}, ${notificationKey})
          `;
          await tx`
            insert into submissions_v2.notification_outbox(kind, destination_id, safe_payload, dedupe_key, pair_id)
            values (
              'not_interested', ${notificationDestination()},
              ${tx.json({ candidate_name: candidate?.display_name, company: role?.company_name, role_title: role?.role_title, owner_name: ownerDisplayName(current.owner_email), monitor_url: "https://monitor.raydar.xyz/#submissions-v2" })},
              ${notificationKey}, ${pairId}
            ) on conflict (dedupe_key) do nothing
          `;
        } else {
          await tx`
            update submissions_v2.not_interested_entries
               set corrected_destination='interested', corrected_at=clock_timestamp(), corrected_by=${actorEmail},
                   correction_note=${clean(note, 500)}, active_projection=false
             where pair_id=${pairId} and active_projection
          `;
          await queueResume(tx, updated, commandRow, "retry");
        }
        await pairEvent(tx, updated, { actorId: actorEmail, source: action, eventType: "classification_corrected", expectedVersion, previous: current, note, idempotencyKey: `pair:${commandRow.id}` });
        return { case_id: pairId, state: updated.workflow_state, state_version: Number(updated.state_version) };
      }));
    },

    async keepReview({ actorEmail, idempotencyKey, pairId, expectedVersion, note }) {
      return sql.begin(async (tx) => command(tx, {
        actorEmail, action: "resolve_review", idempotencyKey, expectedVersion, pairId,
        input: { pairId, expectedVersion, destination: "needs_review", note },
      }, async (commandRow) => {
        const current = await lockPair(tx, pairId, expectedVersion);
        if (current.workflow_state !== "needs_review") throw problem("pair_not_in_review", "The item is no longer in Needs Review.", 409, pairCurrent(current));
        await pairEvent(tx, current, { actorId: actorEmail, source: "resolve_review", eventType: "review_retained", note, idempotencyKey: `pair:${commandRow.id}`, metadata: { expected_version: Number(expectedVersion) } });
        return { case_id: pairId, state: current.workflow_state, state_version: Number(current.state_version) };
      }));
    },

    async enqueuePairAction({ actorEmail, idempotencyKey, pairId, expectedVersion, action, kind, requiredControl = "generation", checkpoint = {} }) {
      return sql.begin(async (tx) => command(tx, {
        actorEmail, action, idempotencyKey, expectedVersion, pairId,
        input: { pairId, expectedVersion, checkpoint },
      }, async (commandRow) => {
        const current = await lockPair(tx, pairId, expectedVersion);
        if (action === "retry_preparation" || action === "recheck") {
          const allowedReasons = action === "recheck"
            ? ["candidate_original_resume_missing"]
            : ["candidate_original_resume_missing", "resume_preparation_failed"];
          const openReviews = await tx`
            select reason_code from submissions_v2.review_items
             where pair_id=${pairId} and action_state='open'
             for update
          `;
          if (current.intent_state !== "interested" || current.workflow_state !== "needs_review"
            || openReviews.length < 1 || openReviews.some((row) => !allowedReasons.includes(row.reason_code))) {
            throw problem("resume_retry_not_eligible", "Resume preparation can be retried only for an Interested item blocked by a resume issue.", 409, pairCurrent(current));
          }
        }
        const job = await enqueue(tx, {
          kind, subjectType: "pair", subjectId: pairId, commandId: commandRow.id,
          idempotencyKey: `${kind}:${commandRow.id}`, requiredControl,
          checkpoint: { ...checkpoint, expected_pair_version: Number(expectedVersion) },
        });
        await pairEvent(tx, current, { actorId: actorEmail, source: action, eventType: `${action}_requested`, idempotencyKey: `pair:${commandRow.id}`, metadata: { job_id: job?.id || null } });
        return { case_id: pairId, state: current.workflow_state, state_version: Number(current.state_version), job_id: job?.id || null };
      }));
    },

    async enqueueSignalAction({ actorEmail, idempotencyKey, signalId, action, kind = "classify_email_reply" }) {
      return sql.begin(async (tx) => command(tx, {
        actorEmail, action, idempotencyKey, input: { signalId },
      }, async (commandRow) => {
        const sourceRows = await tx`select * from submissions_v2.source_events where id=${signalId} for update`;
        const source = sourceRows[0];
        if (!source) throw problem("source_not_found", "The source event was not found.", 404);
        if (action === "retry_classification") {
          const openFailure = await tx`
            select review.id
              from submissions_v2.review_items review
              left join submissions_v2.pair_signal_links link
                on link.pair_id=review.pair_id and link.signal_id=${signalId}
               and link.link_kind='classification_failure'
             where review.action_state='open' and review.reason_code='classification_failed'
               and (review.unresolved_signal_id=${signalId} or link.signal_id=${signalId})
             for update of review
          `;
          if (source.processing_state !== "quarantined" || source.safe_error_code !== "classification_failed" || !openFailure.length) {
            throw problem("classification_retry_not_eligible", "Only an open classifier failure can be retried.", 409);
          }
        }
        const job = await enqueue(tx, {
          kind, subjectType: "signal", subjectId: signalId, commandId: commandRow.id,
          idempotencyKey: `${kind}:${commandRow.id}`, requiredControl: "master_inbox", priority: 20,
          checkpoint: { signal_id: signalId, requested_by: actorEmail },
        });
        return { signal_id: signalId, job_id: job?.id || null, processing_state: source.processing_state };
      }));
    },

    async reserveUploadIntent({ actorEmail, idempotencyKey, pairId, expectedVersion, reservationId, objectKey, contentType, size, filename, expiresAt }) {
      return sql.begin(async (tx) => command(tx, {
        actorEmail, action: "create_upload_intent", idempotencyKey, expectedVersion, pairId,
        input: { pairId, expectedVersion, contentType, size, filename },
      }, async (commandRow) => {
        await lockPair(tx, pairId, expectedVersion);
        const rows = await tx`
          insert into submissions_v2.upload_reservations(
            id, pair_id, command_id, object_key, actor_email, expected_pair_version,
            mime_type, original_name, size_bytes, expires_at
          ) values (
            ${reservationId}, ${pairId}, ${commandRow.id}, ${objectKey}, ${actorEmail}, ${expectedVersion},
            ${contentType}, ${filename}, ${size}, ${new Date(expiresAt).toISOString()}
          ) returning *
        `;
        return { reservation_id: rows[0].id, object_key: rows[0].object_key, expires_at: rows[0].expires_at };
      }));
    },

    async addSupplement({ actorEmail, idempotencyKey, pairId, expectedVersion, reservationId, objectKey, mimeType, originalName, sizeBytes, digestValue, evidenceBasis, sourceNote }) {
      return sql.begin(async (tx) => command(tx, {
        actorEmail, action: "complete_upload", idempotencyKey, expectedVersion, pairId,
        input: { pairId, expectedVersion, reservationId, objectKey, mimeType, originalName, sizeBytes, digestValue, evidenceBasis, sourceNote },
      }, async () => {
        await lockPair(tx, pairId, expectedVersion);
        const reservation = (await tx`
          select * from submissions_v2.upload_reservations
           where id=${reservationId} and pair_id=${pairId} and actor_email=${actorEmail}
             and state='pending' and expires_at >= clock_timestamp()
           for update
        `)[0];
        if (!reservation
          || reservation.object_key !== objectKey
          || reservation.mime_type !== mimeType
          || reservation.original_name !== originalName
          || Number(reservation.size_bytes) !== Number(sizeBytes)
          || Number(reservation.expected_pair_version) !== Number(expectedVersion)) {
          throw problem("upload_reservation_invalid", "The upload reservation expired or no longer matches this item.", 409);
        }
        const rows = await tx`
          insert into submissions_v2.resume_supplements(
            pair_id, supplement_kind, object_key, creator_email, mime_type, original_name,
            size_bytes, digest, scan_state, parse_state, evidence_basis, source_or_correction_note, active, quarantined
          ) values (
            ${pairId}, 'evidence', ${objectKey}, ${actorEmail}, ${mimeType}, ${originalName},
            ${sizeBytes}, ${digestValue}, 'pending', 'pending', ${evidenceBasis}, ${sourceNote}, true, true
          ) returning id
        `;
        await tx`
          update submissions_v2.upload_reservations
             set state='completed', supplement_id=${rows[0].id}, completed_at=clock_timestamp()
           where id=${reservationId} and state='pending'
        `;
        return { supplement_id: rows[0].id };
      }));
    },

    async regenerate({ actorEmail, idempotencyKey, pairId, expectedVersion, evidenceEncrypted = null, evidenceDigest = null, evidenceBasis, sourceNote, instructionsEncrypted = null, uploads = [] }) {
      return sql.begin(async (tx) => command(tx, {
        actorEmail, action: "regenerate", idempotencyKey, expectedVersion, pairId,
        input: { pairId, expectedVersion, evidenceDigest, evidenceBasis, sourceNote, uploads, instructionDigest: instructionsEncrypted ? digest(instructionsEncrypted) : null },
      }, async (commandRow) => {
        const current = await lockPair(tx, pairId, expectedVersion);
        if (current.workflow_state !== "interested" || !current.current_artifact_id) throw problem("pair_not_resume_ready", "Only an Interested candidate with a ready resume can be regenerated.", 409, pairCurrent(current));
        const activeRegeneration = await tx`
          select id::text from submissions_v2.resume_generations
           where pair_id=${pairId} and status in ('queued','collecting','extracting','strategizing','validating','rendering','archiving')
          union all
          select id::text from submissions_v2.jobs
           where kind='prepare_resume' and subject_type='pair' and subject_id=${pairId}
             and state in ('queued','running')
          limit 1
        `;
        if (activeRegeneration.length) {
          throw problem("resume_regeneration_in_progress", "This resume is already being regenerated.", 409, pairCurrent(current));
        }
        if (evidenceEncrypted) {
          await tx`
            insert into submissions_v2.resume_supplements(
              pair_id, supplement_kind, text_value_encrypted, creator_email, digest,
              scan_state, parse_state, evidence_basis, source_or_correction_note
            ) values (${pairId}, 'evidence', ${evidenceEncrypted}, ${actorEmail}, ${evidenceDigest}, 'not_applicable', 'parsed', ${evidenceBasis}, ${sourceNote})
          `;
        }
        if (uploads.length) {
          const valid = await tx`
            select id, size_bytes from submissions_v2.resume_supplements
             where pair_id=${pairId} and id = any(${tx.array(uploads, UUID_OID)})
               and supplement_kind='evidence' and object_key is not null and active
               and quarantined and quarantine_cleanup_state='pending'
             for update
          `;
          if (valid.length !== new Set(uploads).size) throw problem("supplement_invalid", "One or more uploaded files do not belong to this candidate-role item.", 409);
          const totalBytes = valid.reduce((sum, row) => sum + Number(row.size_bytes || 0), 0);
          if (totalBytes > 25 * 1024 * 1024) throw problem("supplement_total_size_exceeded", "The combined evidence files must be 25 MB or smaller.", 400);
          const acceptedUploads = await tx`
            update submissions_v2.resume_supplements set quarantined=false
             where pair_id=${pairId} and id = any(${tx.array(uploads, UUID_OID)})
               and active and quarantined and quarantine_cleanup_state='pending'
            returning id
          `;
          if (acceptedUploads.length !== valid.length) throw problem("supplement_cleanup_race", "One or more uploaded files entered cleanup before regeneration began.", 409);
        }
        const job = await enqueue(tx, {
          kind: "prepare_resume", subjectType: "pair", subjectId: pairId, commandId: commandRow.id,
          idempotencyKey: `resume:regenerate:${commandRow.id}`, requiredControl: "generation", priority: 40,
          checkpoint: {
            trigger_kind: "regenerate", expected_pair_version: Number(expectedVersion),
            instruction_encrypted: instructionsEncrypted ? Buffer.from(instructionsEncrypted).toString("base64") : null,
            supplement_ids: uploads,
          },
        });
        await pairEvent(tx, current, { actorId: actorEmail, source: "regenerate", eventType: "regeneration_requested", idempotencyKey: `pair:${commandRow.id}`, metadata: { job_id: job?.id || null, supplement_ids: uploads } });
        return { case_id: pairId, state: current.workflow_state, state_version: Number(current.state_version), job_id: job?.id || null };
      }));
    },

    async issueDownload({ actorEmail, idempotencyKey, pairId, expectedVersion, ticketId, expiresAt }) {
      return sql.begin(async (tx) => command(tx, {
        actorEmail, action: "download_resume", idempotencyKey, expectedVersion, pairId,
        input: { pairId, expectedVersion },
      }, async () => {
        const pair = await lockPair(tx, pairId, expectedVersion);
        if (pair.workflow_state !== "interested" || !pair.current_artifact_id) throw problem("resume_not_ready", "The current resume is not ready for download.", 409, pairCurrent(pair));
        const artifacts = await tx`
          select * from submissions_v2.resume_artifacts
           where id=${pair.current_artifact_id} and pair_id=${pairId} and kind='pdf'
             and current_state='current' and validation_status='passed' and archived_at is not null and archive_readback_at is not null
        `;
        if (!artifacts.length) throw problem("resume_not_ready", "The current resume did not pass archive validation.", 409, pairCurrent(pair));
        await tx`
          insert into submissions_v2.download_tickets(
            ticket_id, actor_email, artifact_id, pair_id, disposition, pathname, expires_at
          ) values (
            ${ticketId}, ${actorEmail}, ${artifacts[0].id}, ${pairId}, 'attachment',
            ${artifacts[0].private_object_key}, ${new Date(expiresAt).toISOString()}
          )
        `;
        await tx`
          insert into submissions_v2.download_audit(
            ticket_id, user_email, artifact_id, pair_id, disposition, signed_url_expires_at, result, request_digest
          ) values (${ticketId}, ${actorEmail}, ${artifacts[0].id}, ${pairId}, 'attachment', ${new Date(expiresAt).toISOString()}, 'issued', ${digest(`${actorEmail}:${ticketId}:${artifacts[0].id}`)})
        `;
        const candidate = (await tx`select display_name from submissions_v2.candidate_index where candidate_user_id=${pair.candidate_user_id}`)[0];
        const role = (await tx`select company_name, role_title from submissions_v2.role_index where role_id=${pair.role_id}`)[0];
        return { ticket_id: ticketId, expires_at: new Date(expiresAt).toISOString(), artifact: artifacts[0], candidate_user_id: pair.candidate_user_id, candidate_name: candidate?.display_name || null, role_id: pair.role_id, company_name: role?.company_name || null, role_title: role?.role_title || null };
      }));
    },

    async auditDownloadFailure({ ticketId = null, actorEmail, artifactId, pairId, disposition = "attachment", code, requestDigest }) {
      await sql`
        insert into submissions_v2.download_audit(ticket_id, user_email, artifact_id, pair_id, disposition, result, safe_error_code, request_digest)
        values (${ticketId}, ${actorEmail}, ${artifactId}, ${pairId}, ${disposition === "archive_retrieval" ? "archive_retrieval" : "attachment"}, 'failed', ${clean(code, 100)}, ${requestDigest})
      `;
    },

    async redeemDownloadTicket({ ticketId, actorEmail, artifactId, pairId, pathname, disposition = "attachment", requestDigest }) {
      return sql.begin(async (tx) => {
        const visible = await tx`
          select artifact.id
            from submissions_v2.resume_artifacts artifact
            join submissions_v2.candidate_role_pairs pair on pair.id=artifact.pair_id
           where artifact.id=${artifactId} and artifact.pair_id=${pairId}
             and artifact.private_object_key=${pathname}
             and artifact.kind='pdf' and artifact.validation_status='passed'
             and artifact.archived_at is not null and artifact.archive_readback_at is not null
             and artifact.deleted_at is null and artifact.current_state in ('current','superseded')
             and pair.case_hidden_at is null
           for share of artifact, pair
        `;
        if (!visible.length) throw problem("artifact_not_found", "The archived resume is unavailable.", 404);
        const rows = await tx`
          update submissions_v2.download_tickets
             set state='redeemed', redeemed_at=clock_timestamp(), redemption_digest=${requestDigest}
           where ticket_id=${ticketId} and state='issued' and expires_at > clock_timestamp()
             and lower(actor_email)=lower(${actorEmail}) and artifact_id=${artifactId} and pair_id=${pairId}
             and pathname=${pathname} and disposition=${disposition === "archive_retrieval" ? "archive_retrieval" : "attachment"}
          returning *
        `;
        if (!rows.length) throw problem("download_ticket_already_used", "The download link was already used or expired; request a new copy.", 410);
        await tx`
          insert into submissions_v2.download_audit(ticket_id, user_email, artifact_id, pair_id, disposition, result, request_digest)
          values (${ticketId}, ${actorEmail}, ${artifactId}, ${pairId}, ${disposition === "archive_retrieval" ? "archive_retrieval" : "attachment"}, 'completed', ${requestDigest})
        `;
        return rows[0];
      });
    },

    async downloadableArtifact({ artifactId, pairId, pathname }) {
      const rows = await sql`
        select a.*, p.candidate_user_id, p.role_id, c.display_name as candidate_name,
               r.company_name, r.role_title
          from submissions_v2.resume_artifacts a
          join submissions_v2.candidate_role_pairs p on p.id=a.pair_id
          left join submissions_v2.candidate_index c on c.candidate_user_id=p.candidate_user_id
          left join submissions_v2.role_index r on r.role_id=p.role_id
         where a.id=${artifactId} and a.pair_id=${pairId} and a.private_object_key=${pathname}
           and a.kind='pdf' and a.validation_status='passed' and a.archived_at is not null
           and a.archive_readback_at is not null and a.deleted_at is null
           and a.current_state in ('current','superseded') and p.case_hidden_at is null
      `;
      return rows[0] || null;
    },

    async openSubmit({ actorEmail, idempotencyKey, pairId, expectedVersion }) {
      return sql.begin(async (tx) => command(tx, {
        actorEmail, action: "submit_open", idempotencyKey, expectedVersion, pairId,
        input: { pairId, expectedVersion },
      }, async (commandRow) => {
        const current = await lockPair(tx, pairId, expectedVersion);
        if (current.workflow_state !== "interested" || !current.current_artifact_id) throw problem("pair_not_submit_ready", "Only an Interested candidate with a ready resume can be submitted.", 409, pairCurrent(current));
        const artifacts = await tx`
          select id from submissions_v2.resume_artifacts
           where id=${current.current_artifact_id} and pair_id=${pairId} and kind='pdf'
             and current_state='current' and validation_status='passed' and deleted_at is null
             and archived_at is not null and archive_readback_at is not null
        `;
        if (!artifacts.length) throw problem("pair_not_submit_ready", "The current resume did not pass archive validation.", 409, pairCurrent(current));
        const roles = await tx`select * from submissions_v2.role_index where role_id=${current.role_id} and active`;
        if (!roles.length) throw problem("role_unavailable", "The Paraform role is no longer active.", 409, pairCurrent(current));
        const exactUrl = `https://www.paraform.com/browse?role=${encodeURIComponent(current.role_id)}`;
        if (current.submission_status === "opened") return { case_id: pairId, state_version: Number(current.state_version), redirect_url: exactUrl, submission_status: "opened" };
        const updated = (await tx`
          update submissions_v2.candidate_role_pairs
             set submission_status='opened', submission_opened_at=clock_timestamp(), state_version=state_version+1
           where id=${pairId} and state_version=${expectedVersion} returning *
        `)[0];
        if (!updated) throw problem("stale_pair_version", "The candidate-role item changed before this action was committed.", 409, pairCurrent(current));

        for (const delayMinutes of [5, 30, 120]) {
          await enqueue(tx, {
            kind: "proof_reconcile", subjectType: "pair", subjectId: pairId,
            commandId: commandRow.id, idempotencyKey: `proof:${commandRow.id}:${delayMinutes}m`,
            requiredControl: "ingestion", priority: 12,
            scheduledAt: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
            checkpoint: { opened_pair_id: pairId, delay_minutes: delayMinutes },
          });
        }
        await pairEvent(tx, updated, { actorId: actorEmail, source: "submit_open", eventType: "paraform_role_opened", expectedVersion, previous: current, idempotencyKey: `pair:${commandRow.id}`, metadata: { navigation_only: true, role_id: current.role_id } });
        return { case_id: pairId, state_version: Number(updated.state_version), redirect_url: exactUrl, submission_status: "opened" };
      }));
    },

    async archive({ candidateId, roleId, limit = 50 }) {
      return sql`
        select p.id as case_id, p.candidate_user_id, p.role_id, p.workflow_state, p.submission_status,
               a.id as artifact_id, a.artifact_version, a.kind, a.digest, a.size_bytes, a.page_count,
               a.validation_status, a.current_state, a.archived_at, a.created_at
          from submissions_v2.candidate_role_pairs p
          join submissions_v2.resume_artifacts a on a.pair_id=p.id
         where p.candidate_user_id=${candidateId} and p.role_id=${roleId}
           and p.case_hidden_at is null
         order by a.artifact_version desc, a.kind limit ${boundedLimit(limit, 50, 100)}
      `;
    },

    async issueArchiveRetrieval({ actorEmail, candidateId = null, roleId = null, artifactId = null, date = null, version = null, ticketId, expiresAt }) {
      return sql.begin(async (tx) => {
        const filterDigest = digest(JSON.stringify({ candidateId, roleId, artifactId, date, version }));
        const dateStart = date ? `${date}T00:00:00.000Z` : null;
        const dateEnd = date ? new Date(Date.parse(dateStart) + 24 * 60 * 60 * 1_000).toISOString() : null;
        const rows = await tx`
          select a.*, p.candidate_user_id, p.role_id, c.display_name as candidate_name,
                 r.company_name, r.role_title
            from submissions_v2.resume_artifacts a
            join submissions_v2.candidate_role_pairs p on p.id=a.pair_id
            left join submissions_v2.candidate_index c on c.candidate_user_id=p.candidate_user_id
            left join submissions_v2.role_index r on r.role_id=p.role_id
           where a.kind='pdf' and a.validation_status='passed' and a.archived_at is not null
             and a.archive_readback_at is not null and a.deleted_at is null
             and a.current_state in ('current','superseded') and p.case_hidden_at is null
             and (${candidateId}::text is null or p.candidate_user_id=${candidateId})
             and (${roleId}::text is null or p.role_id=${roleId})
             and (${artifactId}::uuid is null or a.id=${artifactId}::uuid)
             and (${version}::integer is null or a.artifact_version=${version}::integer)
             and (${dateStart}::timestamptz is null or (a.created_at >= ${dateStart}::timestamptz and a.created_at < ${dateEnd}::timestamptz))
           order by a.created_at desc, a.artifact_version desc, a.id desc limit 1
           for share of a, p
        `;
        const artifact = rows[0];
        if (!artifact) {
          await tx`
            insert into submissions_v2.archive_lookup_audit(actor_email, filter_digest, result)
            values (${actorEmail}, ${filterDigest}, 'not_found')
          `;
          return null;
        }
        await tx`
          insert into submissions_v2.archive_lookup_audit(
            actor_email, filter_digest, result, artifact_id, pair_id
          ) values (${actorEmail}, ${filterDigest}, 'matched', ${artifact.id}, ${artifact.pair_id})
        `;
        await tx`
          insert into submissions_v2.download_tickets(
            ticket_id, actor_email, artifact_id, pair_id, disposition, pathname, expires_at
          ) values (
            ${ticketId}, ${actorEmail}, ${artifact.id}, ${artifact.pair_id}, 'archive_retrieval',
            ${artifact.private_object_key}, ${new Date(expiresAt).toISOString()}
          )
        `;
        await tx`
          insert into submissions_v2.download_audit(
            ticket_id, user_email, artifact_id, pair_id, disposition, signed_url_expires_at, result, request_digest
          ) values (
            ${ticketId}, ${actorEmail}, ${artifact.id}, ${artifact.pair_id}, 'archive_retrieval', ${new Date(expiresAt).toISOString()}, 'issued',
            ${digest(JSON.stringify({ actorEmail, candidateId, roleId, artifactId, date, version, ticketId }))}
          )
        `;
        return { artifact, ticket_id: ticketId, expires_at: new Date(expiresAt).toISOString() };
      });
    },

    async runtimeControls() {
      const rows = await sql`select * from submissions_v2.runtime_controls where singleton=true`;
      return rows[0] || null;
    },

    async setControls({ actorEmail, reason, ui, ingestion, generation, masterInbox, curated, idempotencyKey = null }) {
      if (!idempotencyKey) {
        const rows = await sql`
          select * from submissions_v2.set_runtime_controls(
            ${actorEmail}, ${reason}, ${ui}, ${ingestion}, ${generation}, ${masterInbox}, ${curated}
          )
        `;
        return rows[0] || null;
      }
      return sql.begin(async (tx) => command(tx, {
        actorEmail, action: "set_controls", idempotencyKey,
        requiredControls: [],
        input: { reason, ui, ingestion, generation, masterInbox, curated },
      }, async () => {
        const rows = await tx`
          select * from submissions_v2.set_runtime_controls(
            ${actorEmail}, ${reason}, ${ui}, ${ingestion}, ${generation}, ${masterInbox}, ${curated}
          )
        `;
        return rows[0] || null;
      }));
    },

    async reserveCaseRetentionCommand({ actorEmail, action, idempotencyKey, pairId, expectedVersion, reason = null }) {
      if (!new Set(["soft_delete_case", "restore_case"]).has(action)) throw problem("case_retention_action_invalid", "The case-retention action is invalid.", 400);
      const input = { pairId, expectedVersion, ...(action === "soft_delete_case" ? { reason } : {}) };
      return sql.begin(async (tx) => {
        const started = await beginCommand(tx, { actorEmail, action, idempotencyKey, expectedVersion, pairId, input });
        if (started.replay) return { replay: true, result: started.result };
        return { replay: false, command_id: started.command.id };
      });
    },

    async failCaseRetentionCommand({ commandId, errorCode }) {
      return sql.begin(async (tx) => failCommand(tx, commandId, clean(errorCode, 100) || "case_retention_failed"));
    },

    async caseDeletionManifest({ pairId, expectedVersion }) {
      const snapshot = await loadCaseDeletionSnapshot(sql, pairId);
      if (snapshot.pair.case_hidden_at) throw problem("case_already_deleted", "The candidate-role item is already hidden by a deletion request.", 409, pairCurrent(snapshot.pair));
      if (Number(snapshot.pair.state_version) !== Number(expectedVersion)) {
        throw problem("stale_pair_version", "The candidate-role item changed before this action was committed.", 409, pairCurrent(snapshot.pair));
      }
      return snapshot;
    },

    async caseDeletionForRestore({ pairId }) {
      const rows = await sql`
        select d.*, p.state_version, p.case_hidden_at
          from submissions_v2.case_deletions d
          join submissions_v2.candidate_role_pairs p on p.id=d.pair_id
         where d.pair_id=${pairId} and d.state='soft_deleted' and p.case_hidden_at is not null
         order by d.requested_at desc, d.id desc limit 1
      `;
      return rows[0] || null;
    },

    async softDeleteCase({
      actorEmail, commandId, pairId, expectedVersion, deletionId,
      requestedAt, recoveryDeadline, encryptedManifestObjectKey, manifestDigest,
      tombstoneCaseHmac, tombstoneCandidateHmac, manifest, objectReservationId, objectWriteFencingToken,
    }) {
      return sql.begin(async (tx) => {
        const commandRows = await tx`
          select * from submissions_v2.api_commands
           where id=${commandId} and actor_email=${actorEmail} and action='soft_delete_case'
           for update
        `;
        const commandRow = commandRows[0];
        if (!commandRow || commandRow.status !== "started") throw problem("command_fence_lost", "The case-deletion command lost its fence.", 409);
        const currentSnapshot = await loadCaseDeletionSnapshot(tx, pairId, { lock: true });
        const current = currentSnapshot.pair;
        if (current.case_hidden_at) throw problem("case_already_deleted", "The candidate-role item is already hidden by a deletion request.", 409, pairCurrent(current));
        if (Number(current.state_version) !== Number(expectedVersion)) {
          throw problem("stale_pair_version", "The candidate-role item changed before this action was committed.", 409, pairCurrent(current));
        }
        if (!manifest?.snapshot || !sameSnapshot(currentSnapshot, manifest.snapshot)) {
          throw problem("case_changed_during_deletion", "The candidate-role item changed while its recovery manifest was being prepared.", 409, pairCurrent(current));
        }

        await tx`
          insert into submissions_v2.case_deletions(
            id, pair_id, admin_actor, reason, requested_at, recovery_deadline,
            encrypted_manifest_object_key, manifest_digest, tombstone_case_hmac, tombstone_candidate_hmac
          ) values (
            ${deletionId}, ${pairId}, ${actorEmail}, 'Administrator-requested case deletion',
            ${requestedAt}, ${recoveryDeadline}, ${encryptedManifestObjectKey},
            ${manifestDigest}, ${tombstoneCaseHmac}, ${tombstoneCandidateHmac}
          )
        `;
        const objectReservation = await tx`
          update submissions_v2.private_object_reservations
             set state='committed', committed_at=coalesce(committed_at, clock_timestamp()),
                 write_owner=null, write_lease_expires_at=null
           where id=${objectReservationId} and object_key=${encryptedManifestObjectKey}
             and expected_digest=${String(manifestDigest).toLowerCase()}
             and (state='committed' or (state='pending' and write_fencing_token=${Number(objectWriteFencingToken)}
               and write_lease_expires_at >= clock_timestamp()))
          returning id
        `;
        if (!objectReservation.length) throw problem("private_object_reservation_fence_lost", "The case-manifest private-object reservation was lost.", 409);

        const updated = (await tx`
          update submissions_v2.candidate_role_pairs
             set case_hidden_at=${requestedAt}, state_version=state_version+1
           where id=${pairId} and state_version=${expectedVersion} and case_hidden_at is null
           returning *
        `)[0];
        if (!updated) throw problem("stale_pair_version", "The candidate-role item changed before this action was committed.", 409, pairCurrent(current));

        await tx`
          update submissions_v2.notification_outbox
             set state='held', safe_error_code='case_soft_deleted',
                 safe_error_detail='The candidate-role case was deleted before this notification started.',
                 lease_owner=null, lease_expires_at=null
           where pair_id=${pairId} and state in ('pending','failed','sending')
        `;

        const affectedArtifacts = currentSnapshot.artifacts.filter((row) => !new Set(["deleted", "purged"]).has(row.current_state));
        for (const artifact of affectedArtifacts) {
          await tx`
            insert into submissions_v2.artifact_deletions(
              artifact_id, admin_actor, reason, soft_deleted_at, purge_after
            ) values (
              ${artifact.id}, ${actorEmail}, 'Case deletion recovery window', ${requestedAt}, ${recoveryDeadline}
            )
          `;
          await tx`
            update submissions_v2.resume_artifacts
               set current_state='deleted', deleted_at=${requestedAt}
             where id=${artifact.id} and current_state=${artifact.current_state}
          `;
        }

        const activeSupplements = currentSnapshot.supplements.filter((row) => row.active && !row.quarantined);
        for (const supplement of activeSupplements) {
          await tx`
            update submissions_v2.resume_supplements
               set active=false, deleted_at=${requestedAt}, deletion_actor=${actorEmail}
             where id=${supplement.id} and active
          `;
        }
        for (const generation of currentSnapshot.active_generations) {
          await tx`
            update submissions_v2.resume_generations
               set status='cancelled', completed_at=${requestedAt},
                   safe_failure_code='case_soft_deleted',
                   safe_failure_detail='An administrator deleted this case during its recovery window.'
             where id=${generation.id}
               and status in ('queued','collecting','extracting','strategizing','validating','rendering','archiving','held')
          `;
        }
        for (const job of currentSnapshot.active_jobs) {
          await tx`select * from submissions_v2.cancel_pair_job(${job.id}, ${pairId}, ${requestedAt})`;
        }

        await pairEvent(tx, updated, {
          actorType: "administrator", actorId: actorEmail, source: "case_retention",
          eventType: "case_soft_deleted", expectedVersion, previous: current,
          note: "Administrator-requested case deletion entered its recovery window.",
          idempotencyKey: `pair:${commandId}`,
          metadata: { deletion_id: deletionId, recovery_deadline: recoveryDeadline },
        });
        await tx`
          insert into submissions_v2.case_deletion_audit(
            deletion_id, tombstone_case_hmac, event_type, actor_email,
            pair_state_version, reason_digest, idempotency_key, metadata
          ) values (
            ${deletionId}, ${tombstoneCaseHmac}, 'soft_deleted', ${actorEmail},
            ${updated.state_version}, ${manifest.reason_digest}, ${`case-delete:${commandId}`},
            ${tx.json({ recovery_deadline: recoveryDeadline })}
          )
        `;
        const result = {
          case_id: pairId, deletion_id: deletionId, state: "soft_deleted",
          state_version: Number(updated.state_version), recovery_deadline: recoveryDeadline,
        };
        await completeCommand(tx, commandId, result);
        return result;
      });
    },

    async restoreCase({ actorEmail, commandId, pairId, expectedVersion, deletionId, manifest }) {
      return sql.begin(async (tx) => {
        const commandRows = await tx`
          select * from submissions_v2.api_commands
           where id=${commandId} and actor_email=${actorEmail} and action='restore_case'
           for update
        `;
        const commandRow = commandRows[0];
        if (!commandRow || commandRow.status !== "started") throw problem("command_fence_lost", "The case-restoration command lost its fence.", 409);
        const deletionRows = await tx`
          select *, recovery_deadline > clock_timestamp() as recoverable
            from submissions_v2.case_deletions
           where id=${deletionId} and pair_id=${pairId} for update
        `;
        const deletion = deletionRows[0];
        if (!deletion || deletion.state !== "soft_deleted") throw problem("case_deletion_not_found", "No recoverable case deletion was found.", 404);
        if (!deletion.recoverable) throw problem("case_recovery_expired", "The 30-day case recovery window has expired.", 410);
        const pairRows = await tx`select * from submissions_v2.candidate_role_pairs where id=${pairId} for update`;
        const current = pairRows[0];
        if (!current || !current.case_hidden_at) throw problem("case_deletion_not_found", "No recoverable case deletion was found.", 404);
        if (Number(current.state_version) !== Number(expectedVersion)) {
          throw problem("stale_pair_version", "The candidate-role item changed before this action was committed.", 409, pairCurrent(current));
        }
        if (manifest?.manifest_version !== 1 || manifest?.deletion_id !== deletionId
          || manifest?.pair_id !== pairId || manifest?.snapshot?.pair?.id !== pairId
          || Number(manifest?.snapshot?.pair?.state_version) + 1 !== Number(expectedVersion)) {
          throw problem("case_manifest_mismatch", "The encrypted recovery manifest does not match this case version.", 409);
        }

        for (const artifact of manifest.snapshot.artifacts || []) {
          if (new Set(["deleted", "purged"]).has(artifact.current_state)) continue;
          const restored = await tx`
            update submissions_v2.resume_artifacts
               set current_state=${artifact.current_state}, deleted_at=${artifact.deleted_at}
             where id=${artifact.id} and pair_id=${pairId} and current_state='deleted'
             returning id
          `;
          if (!restored.length) throw problem("case_restore_artifact_mismatch", "A recoverable artifact no longer matches the deletion manifest.", 409);
          await tx`
            update submissions_v2.artifact_deletions
               set restored_at=clock_timestamp(), restored_by=${actorEmail}
             where artifact_id=${artifact.id} and soft_deleted_at=${deletion.requested_at}
               and restored_at is null and purged_at is null
          `;
        }
        const activeSupplementIds = (manifest.snapshot.supplements || []).filter((row) => row.active && !row.quarantined).map((row) => row.id);
        let restoredSupplementCount = 0;
        for (const supplementId of activeSupplementIds) {
          const restored = await tx`
            update submissions_v2.resume_supplements
               set active=true, deleted_at=null, deletion_actor=null
             where id=${supplementId} and pair_id=${pairId}
               and not active and deleted_at=${deletion.requested_at}
             returning id
          `;
          restoredSupplementCount += restored.length;
        }
        if (restoredSupplementCount !== activeSupplementIds.length) throw problem("case_restore_supplement_mismatch", "Recoverable context no longer matches the deletion manifest.", 409);

        await tx`
          update submissions_v2.case_deletions
             set state='restored', restored_at=clock_timestamp(), restored_by=${actorEmail}
           where id=${deletionId} and state='soft_deleted'
        `;
        const updated = (await tx`
          update submissions_v2.candidate_role_pairs
             set case_hidden_at=null, state_version=state_version+1
           where id=${pairId} and state_version=${expectedVersion} and case_hidden_at is not null
           returning *
        `)[0];
        if (!updated) throw problem("stale_pair_version", "The candidate-role item changed before this action was committed.", 409, pairCurrent(current));

        let job = null;
        if (updated.workflow_state === "preparing_resume") {
          job = await enqueue(tx, {
            kind: "prepare_resume", subjectType: "pair", subjectId: pairId,
            commandId, idempotencyKey: `resume:restore:${deletionId}`,
            requiredControl: "generation", priority: 50, maxAttempts: 3,
            checkpoint: { trigger_kind: "retry", expected_pair_version: Number(updated.state_version), restored_deletion_id: deletionId },
          });
        }
        await pairEvent(tx, updated, {
          actorType: "administrator", actorId: actorEmail, source: "case_retention",
          eventType: "case_restored", expectedVersion, previous: current,
          note: "The administrator restored this case during its recovery window.",
          idempotencyKey: `pair:${commandId}`,
          metadata: { deletion_id: deletionId, resumed_job_id: job?.id || null },
        });
        await tx`
          insert into submissions_v2.case_deletion_audit(
            deletion_id, tombstone_case_hmac, event_type, actor_email,
            pair_state_version, reason_digest, idempotency_key, metadata
          ) values (
            ${deletionId}, ${deletion.tombstone_case_hmac}, 'restored', ${actorEmail},
            ${updated.state_version}, ${digest("restore")}, ${`case-restore:${commandId}`},
            ${tx.json({ resumed_job: Boolean(job) })}
          )
        `;
        const result = {
          case_id: pairId, deletion_id: deletionId, state: "restored",
          state_version: Number(updated.state_version), resumed_job_id: job?.id || null,
        };
        await completeCommand(tx, commandId, result);
        return result;
      });
    },

    async bindUnresolvedSignal({ actorEmail, idempotencyKey, signalId, candidateId, roleIds = [], note }) {
      return sql.begin(async (tx) => command(tx, {
        actorEmail, action: "bind_unresolved_signal", idempotencyKey,
        input: { signalId, candidateId, roleIds, note },
      }, async (commandRow) => {
        const source = (await tx`select * from submissions_v2.source_events where id=${signalId} for update`)[0];
        if (!source) throw problem("source_not_found", "The source event was not found.", 404);
        const allowedReasons = source.processing_state === "needs_candidate"
          ? ["candidate_not_found", "candidate_ambiguous"]
          : source.processing_state === "needs_role"
            ? ["role_unclear"]
            : source.processing_state === "quarantined" && source.safe_error_code === "classification_failed"
              ? ["classification_failed"]
              : [];
        if (!allowedReasons.length) {
          throw problem("source_not_unresolved", "Only an open unresolved source event can be bound to a candidate.", 409);
        }
        const unresolvedRows = await tx`
          select id, reason_code from submissions_v2.review_items
           where unresolved_signal_id=${signalId} and action_state='open'
           for update
        `;
        const unresolved = unresolvedRows.filter((row) => allowedReasons.includes(row.reason_code));
        if (!unresolved.length) throw problem("source_not_unresolved", "The source event no longer has an open binding issue.", 409);
        const priorBindings = await tx`
          select 1 from submissions_v2.signal_role_decisions where signal_id=${signalId}
          union all
          select 1 from submissions_v2.pair_signal_links where signal_id=${signalId}
          limit 1
        `;
        if (priorBindings.length) throw problem("source_already_bound", "The source event already has an immutable candidate-role binding.", 409);
        const candidate = (await tx`select * from submissions_v2.candidate_index where candidate_user_id=${candidateId} and active`)[0];
        if (!candidate) throw problem("candidate_not_found", "The selected candidate is not active in Paraform.", 404);
        let selectedRoles = [...new Set(roleIds.map((value) => clean(value, 200)).filter(Boolean))].slice(0, 20);
        let offered = await tx`
          select role_id, company_snapshot, role_label_snapshot, role_url_snapshot
            from submissions_v2.source_offered_roles
           where signal_id=${signalId} order by offered_order, role_id for share
        `;
        if (source.processing_state === "needs_role") {
          if (!selectedRoles.length) throw problem("role_selection_required", "Select at least one exact active Paraform role.", 409);
          const confirmedRoles = await tx`
            select role_id, company_name, role_title, destination_url
              from submissions_v2.role_index
             where active and role_id=any(${tx.array(selectedRoles, 25)})
             order by role_id
          `;
          if (confirmedRoles.length !== selectedRoles.length) throw problem("role_unavailable", "Every selected role must be active in Paraform.", 409);
          for (const [index, role] of confirmedRoles.entries()) {
            await tx`
              insert into submissions_v2.source_offered_roles(
                signal_id, role_id, company_snapshot, role_label_snapshot,
                role_url_snapshot, offered_order, content_digest
              ) values (
                ${signalId}, ${role.role_id}, ${role.company_name}, ${role.role_title},
                ${role.destination_url}, ${index},
                ${digest(JSON.stringify({ role_id: role.role_id, actor: actorEmail, note: clean(note, 500), attested: true }))}
              ) on conflict (signal_id, role_id) do nothing
            `;
          }
          offered = await tx`
            select role_id, company_snapshot, role_label_snapshot, role_url_snapshot
              from submissions_v2.source_offered_roles
             where signal_id=${signalId} order by offered_order, role_id for share
          `;
        }
        if (!offered.length) throw problem("role_selection_required", "Select at least one exact role.", 409);
        const offeredIds = new Set(offered.map((row) => row.role_id));
        if (!selectedRoles.length) selectedRoles = offered.map((row) => row.role_id);
        if (selectedRoles.some((roleId) => !offeredIds.has(roleId))) {
          throw problem("role_outside_offer", "Select only roles offered in the original sent message.", 409);
        }
        for (const roleId of selectedRoles) {
          await tx`select pg_advisory_xact_lock(hashtextextended(${pairAdvisoryLockKey(candidateId, roleId)}, 0))`;
          const priorPair = (await tx`
            select id from submissions_v2.candidate_role_pairs
             where candidate_user_id=${candidateId} and role_id=${roleId} for update
          `)[0];
          if (priorPair) throw problem("first_response_already_recorded", "This candidate-role item already has its first response.", 409);
          const claim = await reserveFirstResponse(tx, {
            candidateId, roleId, eventId: source.event_id, sourceFamily: "email",
          });
          if (!claim) throw problem("first_response_pending", "An earlier candidate response for this role is still being processed.", 409);
          const committed = await tx`
            update submissions_v2.first_response_claims
               set signal_id=${signalId}, committed_at=coalesce(committed_at, clock_timestamp())
             where id=${claim.id} and released_at is null
               and (signal_id is null or signal_id=${signalId})
            returning id
          `;
          if (committed.length !== 1) throw problem("first_response_claim_lost", "The first-response claim changed before review resolution committed.", 409);
        }
        const updated = await tx`
          update submissions_v2.source_events
             set processing_state='ready', processed_at=null, safe_error_code=null, safe_error_detail=null
           where id=${signalId} and processing_state=${source.processing_state}
          returning id
        `;
        if (updated.length !== 1) throw problem("source_not_unresolved", "The source event changed before its binding was saved.", 409);
        const job = await enqueue(tx, {
          kind: "classify_email_reply", subjectType: "signal", subjectId: signalId,
          commandId: commandRow.id, idempotencyKey: `classify:${commandRow.id}`,
          requiredControl: "master_inbox", priority: 20,
          checkpoint: { signal_id: signalId, candidate_id: candidateId, role_ids: selectedRoles, binding_note: clean(note, 500) },
        });
        return { signal_id: signalId, candidate_id: candidateId, role_ids: selectedRoles, job_id: job?.id || null };
      }));
    },

    async scheduleTick({
      minuteKey,
      fiveMinuteKey = minuteKey,
      hourKey = String(minuteKey || "").slice(0, 13),
      pacificDayKey = String(minuteKey || "").slice(0, 10),
      dailyDigestDue = false,
      nightlyDue = false,
      purgeDue = false,
      controlCeiling = { ingestion: true, master_inbox: true, curated: true },
    }) {
      return sql.begin(async (tx) => {
        const active = await controls(tx);
        const jobs = [];
        const ingestionEnabled = Boolean(controlCeiling?.ingestion && active.ingestion_enabled);
        const masterInboxEnabled = Boolean(ingestionEnabled && controlCeiling?.master_inbox && active.master_inbox_enabled);
        const curatedEnabled = Boolean(ingestionEnabled && controlCeiling?.curated && active.curated_enabled);
        if (masterInboxEnabled) jobs.push(await enqueue(tx, {
          kind: "reconcile_master_inbox", subjectType: "source", subjectId: "master_inbox",
          idempotencyKey: `tick:master_inbox:${fiveMinuteKey}`, requiredControl: "master_inbox", priority: 10,
          checkpoint: { mode: nightlyDue ? "nightly" : "incremental" },
        }));
        if (masterInboxEnabled) jobs.push(await enqueue(tx, {
          kind: "reconcile_sequence_inbox", subjectType: "source", subjectId: "sequence_inbox",
          idempotencyKey: `tick:sequence_inbox:${fiveMinuteKey}`, requiredControl: "master_inbox", priority: 12,
          checkpoint: { mode: nightlyDue ? "nightly" : "incremental" },
        }));
        if (curatedEnabled) jobs.push(await enqueue(tx, {
          kind: "reconcile_curated", subjectType: "source", subjectId: "curated",
          idempotencyKey: `tick:curated:${fiveMinuteKey}`, requiredControl: "curated", priority: 10,
          checkpoint: { mode: nightlyDue ? "nightly" : "incremental" },
        }));
        if (ingestionEnabled) {
          jobs.push(await enqueue(tx, { kind: "proof_reconcile", subjectType: "source", subjectId: "paraform_submissions", idempotencyKey: `tick:proof:${fiveMinuteKey}`, requiredControl: "ingestion", priority: 15 }));
          jobs.push(await enqueue(tx, { kind: "deliver_notification", subjectType: "outbox", subjectId: "notification_outbox", idempotencyKey: `tick:notifications:${fiveMinuteKey}`, requiredControl: "ingestion", priority: 20 }));
          jobs.push(await enqueue(tx, { kind: "source_health", subjectType: "source", subjectId: "all", idempotencyKey: `tick:health:${fiveMinuteKey}`, requiredControl: "ingestion", priority: 30 }));
          jobs.push(await enqueue(tx, { kind: "index_candidates", subjectType: "source", subjectId: "candidate_index", idempotencyKey: `tick:candidates:${hourKey}`, requiredControl: "ingestion", priority: 40 }));
          jobs.push(await enqueue(tx, { kind: "index_roles", subjectType: "source", subjectId: "role_index", idempotencyKey: `tick:roles:${hourKey}`, requiredControl: "ingestion", priority: 40 }));
          if (dailyDigestDue) jobs.push(await enqueue(tx, { kind: "daily_digest", subjectType: "outbox", subjectId: pacificDayKey, idempotencyKey: `tick:digest:${pacificDayKey}`, requiredControl: "ingestion", priority: 60 }));
        }
        if (purgeDue) jobs.push(await enqueue(tx, { kind: "purge", subjectType: "retention", subjectId: pacificDayKey, idempotencyKey: `tick:purge:${pacificDayKey}`, requiredControl: "always", priority: 90 }));
        return { control_epoch: Number(active.control_epoch), jobs: jobs.filter(Boolean).map((job) => ({ id: job.id, kind: job.kind, state: job.state })) };
      });
    },

    async upsertCandidateIndex(rows = [], { cycleId, executionFence, sourceFence } = {}) {
      const cycle = clean(cycleId, 200);
      if (!cycle) throw problem("candidate_reconciliation_cycle_required", "The candidate reconciliation cycle is required.", 400);
      return sql.begin(async (tx) => {
      await assertWorkerFence(tx, executionFence, "ingestion");
      await assertSourceFence(tx, sourceFence, "candidate_index");
      const incoming = rows.slice(0, 500).map((row) => ({
        row,
        suppressionHmac: candidateSuppressionHmac(row.candidate_user_id),
      }));
      for (const candidateId of [...new Set(incoming.map((item) => String(item.row.candidate_user_id)))].sort()) {
        await tx`select pg_advisory_xact_lock(hashtextextended(${candidateId}, 0))`;
      }
      const suppressionRows = incoming.length
        ? await tx`select candidate_hmac from submissions_v2.candidate_index_suppressions`
        : [];
      const suppressed = new Set(suppressionRows.map((row) => row.candidate_hmac));
      let changed = 0;
      let suppressedCount = 0;
      for (const item of incoming) {
        const { row } = item;
        if (suppressed.has(item.suppressionHmac)) {
          suppressedCount += 1;
          continue;
        }
        const result = await tx`
          insert into submissions_v2.candidate_index(
            candidate_user_id, display_name, normalized_name, search_key,
            email_match_hmac_current, email_match_hmac_current_version,
            paraform_profile_url, linkedin_url, raydar_url, owner_email, has_recorded_call,
            provider_updated_at, last_confirmed_at, source_digest, indexed_at, active, reconciliation_cycle
          ) values (
            ${row.candidate_user_id}, ${row.display_name}, ${row.search_key}, ${row.search_key},
            ${row.email_hmac}, ${row.email_hmac_version}, ${row.paraform_url}, ${row.linkedin_url},
            ${row.raydar_url?.startsWith("https://") ? row.raydar_url : `https://monitor.raydar.xyz${row.raydar_url || ""}`},
            ${row.owner_email}, ${Boolean(row.has_recorded_call)}, ${row.provider_updated_at || null},
            ${row.confirmed_at}, ${row.source_digest}, clock_timestamp(), true, ${cycle}
          )
          on conflict (candidate_user_id) do update set
            display_name=excluded.display_name, normalized_name=excluded.normalized_name, search_key=excluded.search_key,
            email_match_hmac_previous=case when candidate_index.email_match_hmac_current is distinct from excluded.email_match_hmac_current then candidate_index.email_match_hmac_current else candidate_index.email_match_hmac_previous end,
            email_match_hmac_previous_version=case when candidate_index.email_match_hmac_current is distinct from excluded.email_match_hmac_current then candidate_index.email_match_hmac_current_version else candidate_index.email_match_hmac_previous_version end,
            email_match_hmac_current=excluded.email_match_hmac_current,
            email_match_hmac_current_version=excluded.email_match_hmac_current_version,
            paraform_profile_url=excluded.paraform_profile_url, linkedin_url=excluded.linkedin_url,
            raydar_url=excluded.raydar_url, owner_email=excluded.owner_email,
            has_recorded_call=excluded.has_recorded_call, provider_updated_at=excluded.provider_updated_at,
            last_confirmed_at=excluded.last_confirmed_at, source_digest=excluded.source_digest,
            indexed_at=clock_timestamp(), active=true, reconciliation_cycle=excluded.reconciliation_cycle
          where excluded.last_confirmed_at >= candidate_index.last_confirmed_at
            and (
              candidate_index.source_digest is distinct from excluded.source_digest
              or candidate_index.last_confirmed_at < excluded.last_confirmed_at
              or candidate_index.reconciliation_cycle is distinct from excluded.reconciliation_cycle
            )
          returning candidate_user_id
        `;
        changed += result.length;
      }
      return { read_count: Math.min(rows.length, 500), changed_count: changed, suppressed_count: suppressedCount };
      });
    },

    async finalizeCandidateIndexCycle({ cycleId, executionFence, sourceFence }) {
      const cycle = clean(cycleId, 200);
      if (!cycle) throw problem("candidate_reconciliation_cycle_required", "The candidate reconciliation cycle is required.", 400);
      return sql.begin(async (tx) => {
      await assertWorkerFence(tx, executionFence, "ingestion");
      await assertSourceFence(tx, sourceFence, "candidate_index");
      const rows = await tx`
        update submissions_v2.candidate_index
           set active=false, indexed_at=clock_timestamp(),
               email_match_hmac_previous=null, email_match_hmac_previous_version=null
         where active and reconciliation_cycle is distinct from ${cycle}
        returning candidate_user_id
      `;
      return { deactivated_count: rows.length, cycle_id: cycle };
      });
    },

    async retirePreviousCandidateHmac({ currentVersion, executionFence, sourceFence }) {
      const version = clean(currentVersion, 100);
      if (!version) throw problem("candidate_hmac_version_required", "The current candidate HMAC version is required.", 400);
      return sql.begin(async (tx) => {
      await assertWorkerFence(tx, executionFence, "ingestion");
      await assertSourceFence(tx, sourceFence, "candidate_index");
      const rows = await tx`
        update submissions_v2.candidate_index
           set email_match_hmac_previous=null, email_match_hmac_previous_version=null, indexed_at=clock_timestamp()
         where active and email_match_hmac_current_version=${version}
           and email_match_hmac_previous is not null
        returning candidate_user_id
      `;
      return { retired_count: rows.length, current_version: version };
      });
    },

    async upsertRoleIndex(rows = [], { deactivateMissing = false, confirmedAt = null, executionFence, sourceFence } = {}) {
      return sql.begin(async (tx) => {
        await assertWorkerFence(tx, executionFence, "ingestion");
        await assertSourceFence(tx, sourceFence, "role_index");
        let changed = 0;
        const ids = [];
        const touchedRoleIds = new Set();
        for (const row of rows.slice(0, 1_000)) {
          ids.push(row.role_id);
          touchedRoleIds.add(row.role_id);
          const result = await tx`
            insert into submissions_v2.role_index(
              role_id, company_name, role_title, search_key, active, destination_url,
              owner_email, provider_updated_at, last_confirmed_at, source_digest, indexed_at
            ) values (
              ${row.role_id}, ${row.company_name}, ${row.role_title}, ${row.search_key}, ${Boolean(row.active)},
              ${row.paraform_url}, ${row.owner_email}, ${row.provider_updated_at || null},
              ${row.confirmed_at}, ${row.source_digest}, clock_timestamp()
            ) on conflict (role_id) do update set
              company_name=excluded.company_name, role_title=excluded.role_title, search_key=excluded.search_key,
              active=excluded.active, destination_url=excluded.destination_url, owner_email=excluded.owner_email,
              provider_updated_at=excluded.provider_updated_at, last_confirmed_at=excluded.last_confirmed_at,
              source_digest=excluded.source_digest, indexed_at=clock_timestamp()
            where excluded.last_confirmed_at >= role_index.last_confirmed_at
              and (
                role_index.source_digest is distinct from excluded.source_digest
                or role_index.last_confirmed_at < excluded.last_confirmed_at
              )
            returning role_id
          `;
          changed += result.length;
        }
        if (deactivateMissing && confirmedAt) {
          const deactivated = await tx`
            update submissions_v2.role_index set active=false, last_confirmed_at=${confirmedAt}, indexed_at=clock_timestamp()
             where active and last_confirmed_at <= ${confirmedAt}
               and not (role_id = any(${tx.array(ids, 25)}))
             returning role_id
          `;
          for (const row of deactivated) touchedRoleIds.add(row.role_id);
          changed += deactivated.length;
        }
        if (touchedRoleIds.size) {
          const indexedPairs = await tx`
            select p.*, r.active as indexed_role_active
              from submissions_v2.candidate_role_pairs p
              join submissions_v2.role_index r on r.role_id=p.role_id
             where p.role_id=any(${tx.array([...touchedRoleIds], 25)})
               and p.case_hidden_at is null
               and (
                 p.role_state is distinct from case when r.active then 'active' else 'unavailable' end
                 or (not r.active and p.intent_state='interested' and p.submission_status<>'proven' and p.workflow_state<>'needs_review')
               )
             order by p.id for update of p
          `;
          for (const pair of indexedPairs) {
            const roleActive = Boolean(pair.indexed_role_active);
            const positiveNeedsReview = !roleActive && pair.intent_state === "interested" && pair.submission_status !== "proven";
            if (positiveNeedsReview) {
              const activeJobs = await tx`
                select id from submissions_v2.jobs
                 where subject_type='pair' and subject_id=${pair.id}::text
                   and state in ('queued','running','held') for update
              `;
              if (activeJobs.length) {
                await tx`
                  update submissions_v2.job_attempts
                     set finished_at=coalesce(finished_at, clock_timestamp()), outcome=coalesce(outcome, 'held'),
                         safe_error_code=coalesce(safe_error_code, 'role_unavailable'),
                         safe_error_detail=coalesce(safe_error_detail, 'The exact Paraform role became unavailable.')
                   where job_id=any(${tx.array(activeJobs.map((job) => job.id), UUID_OID)}) and finished_at is null
                `;
                await tx`
                  update submissions_v2.jobs
                     set state='cancelled', completed_at=clock_timestamp(), lease_owner=null, lease_expires_at=null,
                         safe_error_code='role_unavailable', safe_error_detail='The exact Paraform role became unavailable.',
                         hold_reason='role_unavailable'
                   where id=any(${tx.array(activeJobs.map((job) => job.id), UUID_OID)})
                `;
              }
              const activeGenerations = await tx`
                select id from submissions_v2.resume_generations
                 where pair_id=${pair.id} and status=any(${tx.array(ACTIVE_GENERATION_STATES, 25)}) for update
              `;
              if (activeGenerations.length) {
                await tx`
                  update submissions_v2.resume_stage_runs
                     set status='held', completed_at=clock_timestamp(), safe_error_code='role_unavailable',
                         safe_error_detail='The exact Paraform role became unavailable.'
                   where generation_id=any(${tx.array(activeGenerations.map((generation) => generation.id), UUID_OID)}) and status='running'
                `;
                await tx`
                  update submissions_v2.resume_generations
                     set status='cancelled', stage='cancelled', completed_at=clock_timestamp(),
                         safe_failure_code='role_unavailable', safe_failure_detail='The exact Paraform role became unavailable.'
                   where id=any(${tx.array(activeGenerations.map((generation) => generation.id), UUID_OID)})
                `;
              }
              const updated = (await tx`
                update submissions_v2.candidate_role_pairs
                   set workflow_state='needs_review', role_state='unavailable', role_checked_at=coalesce(${confirmedAt}, clock_timestamp()),
                       state_version=state_version+1
                 where id=${pair.id} and state_version=${pair.state_version} returning *
              `)[0];
              await tx`
                insert into submissions_v2.review_items(pair_id, reason_code, owner_email, safe_detail, evidence)
                values (${pair.id}, 'role_unavailable', ${pair.owner_email}, 'The exact Paraform role is no longer active.', ${tx.json({ role_id: pair.role_id, checked_at: confirmedAt })})
                on conflict do nothing
              `;
              await pairEvent(tx, updated, {
                actorType: "worker", actorId: "submissions-v2-role-indexer", source: "role_index",
                eventType: "role_unavailable", expectedVersion: Number(pair.state_version), previous: pair,
                reasonCode: "role_unavailable", idempotencyKey: `pair:role-unavailable:${pair.id}:${updated.state_version}`,
                metadata: { role_id: pair.role_id, resume_work_fenced: true },
              });
            } else if (roleActive && pair.intent_state === "interested" && pair.workflow_state === "needs_review" && pair.submission_status !== "proven") {
              const cleared = await tx`
                update submissions_v2.review_items
                   set action_state='resolved', resolved_at=clock_timestamp(), resolved_by='submissions-v2-role-indexer',
                       resolution_note='The exact Paraform role returned to the active role index.'
                 where pair_id=${pair.id} and reason_code='role_unavailable' and action_state='open'
                 returning id
              `;
              if (cleared.length) {
                const remaining = (await tx`
                  select count(*)::integer as count from submissions_v2.review_items
                   where pair_id=${pair.id} and action_state='open'
                `)[0];
                const validArtifact = pair.current_artifact_id ? (await tx`
                  select id from submissions_v2.resume_artifacts
                   where id=${pair.current_artifact_id} and pair_id=${pair.id} and kind='pdf'
                     and validation_status='passed' and archive_readback_at is not null and archived_at is not null
                     and deleted_at is null and current_state='current'
                `)[0] : null;
                const nextWorkflow = Number(remaining?.count || 0) > 0
                  ? "needs_review"
                  : validArtifact ? "interested" : "preparing_resume";
                const updated = (await tx`
                  update submissions_v2.candidate_role_pairs
                     set workflow_state=${nextWorkflow}, role_state='active', role_checked_at=coalesce(${confirmedAt}, clock_timestamp()),
                         state_version=state_version+1
                   where id=${pair.id} and state_version=${pair.state_version} returning *
                `)[0];
                let resumedJob = null;
                if (nextWorkflow === "preparing_resume") {
                  resumedJob = await enqueue(tx, {
                    kind: "prepare_resume", subjectType: "pair", subjectId: pair.id,
                    idempotencyKey: `resume:role-return:${pair.id}:${updated.state_version}`,
                    requiredControl: "generation", priority: 50,
                    checkpoint: { trigger_kind: "retry", expected_pair_version: Number(updated.state_version), role_returned: true },
                  });
                }
                await pairEvent(tx, updated, {
                  actorType: "worker", actorId: "submissions-v2-role-indexer", source: "role_index",
                  eventType: "role_returned", expectedVersion: Number(pair.state_version), previous: pair,
                  idempotencyKey: `pair:role-returned:${pair.id}:${updated.state_version}`,
                  metadata: { role_id: pair.role_id, destination: nextWorkflow, resumed_job_id: resumedJob?.id || null },
                });
                continue;
              }
              const updated = (await tx`
                update submissions_v2.candidate_role_pairs
                   set role_state='active', role_checked_at=coalesce(${confirmedAt}, clock_timestamp()),
                       state_version=state_version+1
                 where id=${pair.id} and state_version=${pair.state_version} returning *
              `)[0];
              await pairEvent(tx, updated, {
                actorType: "worker", actorId: "submissions-v2-role-indexer", source: "role_index",
                eventType: "role_reconfirmed", expectedVersion: Number(pair.state_version), previous: pair,
                idempotencyKey: `pair:role-health:${pair.id}:${updated.state_version}`,
                metadata: { role_id: pair.role_id, active: true, review_reason_unchanged: true },
              });
            } else {
              const updated = (await tx`
                update submissions_v2.candidate_role_pairs
                   set role_state=${roleActive ? "active" : "unavailable"}, role_checked_at=coalesce(${confirmedAt}, clock_timestamp()),
                       state_version=state_version+1
                 where id=${pair.id} and state_version=${pair.state_version} returning *
              `)[0];
              await pairEvent(tx, updated, {
                actorType: "worker", actorId: "submissions-v2-role-indexer", source: "role_index",
                eventType: roleActive ? "role_reconfirmed" : "role_health_updated",
                expectedVersion: Number(pair.state_version), previous: pair,
                idempotencyKey: `pair:role-health:${pair.id}:${updated.state_version}`,
                metadata: { role_id: pair.role_id, active: roleActive, submission_proven: pair.submission_status === "proven" },
              });
            }
          }
        }
        return { read_count: Math.min(rows.length, 1_000), changed_count: changed };
      });
    },

    async curatedSnapshots(candidateUserId = null) {
      return sql`
        select * from submissions_v2.curated_snapshots
         where (${candidateUserId}::text is null or candidate_user_id=${candidateUserId})
         order by candidate_user_id, role_id
      `;
    },

    async applyCuratedObservations(observations = [], { seed = false, actorId = "submissions-v2-worker", executionFence, sourceFence } = {}) {
      return sql.begin(async (tx) => {
        await assertWorkerFence(tx, executionFence, "curated");
        await assertSourceFence(tx, sourceFence, "curated");
        const results = [];
        for (const observation of observations.slice(0, 500)) {
          const prior = (await tx`
            select * from submissions_v2.curated_snapshots
             where candidate_user_id=${observation.candidate_user_id} and role_id=${observation.role_id} for update
          `)[0];
          const observedAt = new Date(observation.observed_at || Date.now()).toISOString();
          const observationDigest = /^[a-f0-9]{64}$/i.test(observation.digest || "")
            ? observation.digest.toLowerCase()
            : digest(JSON.stringify(observation));
          if (prior && Date.parse(observedAt) < Date.parse(prior.last_success_at)) {
            results.push({ candidate_user_id: observation.candidate_user_id, role_id: observation.role_id, applied: false, stale: true });
            continue;
          }
          const status = clean(observation.status, 100).toUpperCase();
          const decisiveIntent = status === "APPLIED_TO_ROLE" ? "interested" : status === "NOT_INTERESTED" ? "not_interested" : null;
          const newPending = Boolean(!seed && prior && prior.resolved && decisiveIntent
            && prior.last_confirmed_status !== status);
          const pendingStatus = prior?.resolved === false ? prior.pending_status : newPending ? status : null;
          const pendingDigest = prior?.resolved === false ? prior.pending_digest : newPending ? observationDigest : null;
          const pendingObservedAt = prior?.resolved === false ? prior.pending_observed_at : newPending ? observedAt : null;
          const needsBinding = Boolean(pendingStatus);
          const pendingIntent = pendingStatus === "APPLIED_TO_ROLE" ? "interested" : "not_interested";
          await tx`
            insert into submissions_v2.curated_snapshots(
              candidate_user_id, role_id, last_confirmed_status, digest, first_seen_at, last_success_at,
              resolved, pending_status, pending_digest, pending_observed_at, updated_at
            ) values (
              ${observation.candidate_user_id}, ${observation.role_id}, ${status}, ${observationDigest},
              ${observedAt}, ${observedAt}, ${!needsBinding}, ${pendingStatus}, ${pendingDigest}, ${pendingObservedAt}, clock_timestamp()
            ) on conflict (candidate_user_id, role_id) do update set
              last_confirmed_status=excluded.last_confirmed_status, digest=excluded.digest,
              last_success_at=excluded.last_success_at, resolved=excluded.resolved,
              pending_status=excluded.pending_status, pending_digest=excluded.pending_digest,
              pending_observed_at=excluded.pending_observed_at, updated_at=clock_timestamp()
          `;
          if (!needsBinding) {
            results.push({ candidate_user_id: observation.candidate_user_id, role_id: observation.role_id, applied: false });
            continue;
          }
          await tx`select pg_advisory_xact_lock(hashtextextended(${pairAdvisoryLockKey(observation.candidate_user_id, observation.role_id)}, 0))`;
          const existing = await tx`
            select * from submissions_v2.candidate_role_pairs
             where candidate_user_id=${observation.candidate_user_id} and role_id=${observation.role_id} for update
          `;
          if (existing.length) {
            await tx`
              update submissions_v2.curated_snapshots
                 set resolved=true, pending_status=null, pending_digest=null, pending_observed_at=null, updated_at=clock_timestamp()
               where candidate_user_id=${observation.candidate_user_id} and role_id=${observation.role_id}
            `;
            results.push({ candidate_user_id: observation.candidate_user_id, role_id: observation.role_id, applied: false, existing: true });
            continue;
          }
          const candidate = (await tx`select * from submissions_v2.candidate_index where candidate_user_id=${observation.candidate_user_id} and active`)[0];
          const role = (await tx`select * from submissions_v2.role_index where role_id=${observation.role_id}`)[0];
          if (!candidate) {
            results.push({ candidate_user_id: observation.candidate_user_id, role_id: observation.role_id, applied: false, pending: true, error: "candidate_not_found" });
            continue;
          }
          const curatedEventId = `curated:${observation.candidate_user_id}:${observation.role_id}:${pendingDigest}`;
          const firstResponseClaim = await reserveFirstResponse(tx, {
            candidateId: observation.candidate_user_id,
            roleId: observation.role_id,
            eventId: curatedEventId,
            sourceFamily: "curated",
          });
          if (!firstResponseClaim) {
            await tx`
              update submissions_v2.curated_snapshots
                 set resolved=true, pending_status=null, pending_digest=null, pending_observed_at=null, updated_at=clock_timestamp()
               where candidate_user_id=${observation.candidate_user_id} and role_id=${observation.role_id}
            `;
            results.push({ candidate_user_id: observation.candidate_user_id, role_id: observation.role_id, applied: false, existing_claim: true });
            continue;
          }
          const source = (await tx`
            insert into submissions_v2.source_events(
              source_family, source_version, event_id, provider, direction, received_at,
              content_digest, processing_state, processed_at, idempotency_key, envelope
            ) values (
              'curated', 'submissions.curated.v1', ${curatedEventId},
              'paraform', 'observed', ${pendingObservedAt}, ${pendingDigest}, 'resolved', clock_timestamp(),
              ${`curated:${observation.candidate_user_id}:${observation.role_id}:${pendingDigest}`},
              ${tx.json({ prior_status: prior.last_confirmed_status, decisive_status: pendingStatus })}
            ) returning *
          `)[0];
          await tx`
            insert into submissions_v2.source_offered_roles(signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, content_digest)
            values (${source.id}, ${observation.role_id}, ${role?.company_name || null}, ${role?.role_title || observation.role_id}, ${role?.destination_url || null}, ${pendingDigest})
          `;
          await tx`
            update submissions_v2.first_response_claims
               set signal_id=${source.id}, committed_at=clock_timestamp()
             where candidate_user_id=${observation.candidate_user_id} and role_id=${observation.role_id}
               and event_id=${curatedEventId} and signal_id is null and released_at is null
          `;
          const roleUnavailable = !role?.active;
          const positiveUnavailable = roleUnavailable && pendingIntent === "interested";
          const workflow = positiveUnavailable ? "needs_review" : pendingIntent === "interested" ? "preparing_resume" : "not_interested";
          const intent = pendingIntent;
          const pairRows = await tx`
            insert into submissions_v2.candidate_role_pairs(
              candidate_user_id, role_id, first_signal_id, intent_state, workflow_state,
              owner_email, original_signal_at, role_state, role_checked_at
            ) values (
              ${observation.candidate_user_id}, ${observation.role_id}, ${source.id}, ${intent}, ${workflow},
              ${candidate.owner_email}, ${pendingObservedAt}, ${roleUnavailable ? "unavailable" : "active"}, clock_timestamp()
            ) on conflict (candidate_user_id, role_id) do nothing returning *
          `;
          if (!pairRows.length) {
            const winner = (await tx`
              select * from submissions_v2.candidate_role_pairs
               where candidate_user_id=${observation.candidate_user_id} and role_id=${observation.role_id} for update
            `)[0];
            await tx`update submissions_v2.source_events set processing_state='ignored_later', processed_at=clock_timestamp() where id=${source.id}`;
            await tx`
              update submissions_v2.curated_snapshots
                 set resolved=true, pending_status=null, pending_digest=null, pending_observed_at=null, updated_at=clock_timestamp()
               where candidate_user_id=${observation.candidate_user_id} and role_id=${observation.role_id}
            `;
            results.push({ candidate_user_id: observation.candidate_user_id, role_id: observation.role_id, applied: false, existing: true, pair_id: winner.id });
            continue;
          }
          const pair = pairRows[0];
          await tx`
            insert into submissions_v2.pair_signal_links(pair_id, signal_id, role_id, link_kind)
            values (${pair.id}, ${source.id}, ${observation.role_id}, 'curated')
            on conflict do nothing
          `;
          if (positiveUnavailable) {
            await tx`insert into submissions_v2.review_items(pair_id, reason_code, safe_detail) values (${pair.id}, 'role_unavailable', 'The curated-list role is not currently active.')`;
          } else if (pendingIntent === "interested") {
            await enqueue(tx, { kind: "prepare_resume", subjectType: "pair", subjectId: pair.id, idempotencyKey: `resume:curated:${source.id}`, requiredControl: "generation", priority: 50, checkpoint: { trigger_kind: "initial", expected_pair_version: 1 } });
          } else {
            await tx`
              insert into submissions_v2.not_interested_entries(
                pair_id, source_event_id, original_negative_at, grounded_reason, evidence_digest, notification_dedupe_key
              ) values (${pair.id}, ${source.id}, ${pendingObservedAt}, 'Candidate selected Not Interested on the curated list.', ${pendingDigest}, ${`not-interested:${pair.id}:${source.id}`})
            `;
            await tx`
              insert into submissions_v2.notification_outbox(kind, destination_id, safe_payload, dedupe_key, pair_id)
              values ('not_interested', ${notificationDestination()},
                      ${tx.json({ candidate_name: candidate.display_name, company: role?.company_name, role_title: role?.role_title, owner_name: ownerDisplayName(pair.owner_email), monitor_url: "https://monitor.raydar.xyz/#submissions-v2" })},
                      ${`not-interested:${pair.id}:${source.id}`}, ${pair.id}) on conflict do nothing
            `;
          }
          await pairEvent(tx, pair, { actorType: "worker", actorId, source: "curated", eventType: "first_signal_applied", idempotencyKey: `pair:${source.id}:${observation.role_id}`, metadata: { decisive_status: pendingStatus } });
          await tx`
            update submissions_v2.curated_snapshots
               set resolved=true, pending_status=null, pending_digest=null, pending_observed_at=null, updated_at=clock_timestamp()
             where candidate_user_id=${observation.candidate_user_id} and role_id=${observation.role_id}
          `;
          results.push({ candidate_user_id: observation.candidate_user_id, role_id: observation.role_id, applied: true, pair_id: pair.id, state: pair.workflow_state });
        }
        return results;
      });
    },

    async startResumeGeneration({
      pairId, triggerKind, idempotencyKey, expectedPairVersion, commandId = null,
      primaryModelPin, fallbackModelPin, validatorModelPin, promptPin, templatePin,
      deadlineAt, budgetCents = 200, priorArtifactId = null, executionFence,
    }) {
      return sql.begin(async (tx) => {
        await assertWorkerFence(tx, executionFence, "generation");
        const jobs = await tx`
          select id from submissions_v2.jobs
           where id=${clean(executionFence?.jobId, 100)}::uuid
             and subject_type='pair' and subject_id=${pairId}
           for share
        `;
        if (!jobs.length) throw problem("execution_subject_mismatch", "The active resume worker does not belong to this candidate-role item.", 409);
        const prior = await tx`select * from submissions_v2.resume_generations where idempotency_key=${idempotencyKey}`;
        if (prior.length) {
          if (prior[0].pair_id !== pairId || ![...ACTIVE_GENERATION_STATES, "succeeded"].includes(prior[0].status)) {
            throw problem("generation_fence_lost", "The resume generation is no longer eligible for this worker.", 409);
          }
          if (prior[0].status !== "succeeded") await assertGenerationFence(tx, executionFence, prior[0].id);
          return prior[0];
        }
        const pair = await lockPair(tx, pairId, expectedPairVersion);
        if (triggerKind === "initial" && (pair.intent_state !== "interested" || pair.workflow_state !== "preparing_resume")) {
          throw problem("generation_pair_not_eligible", "Initial resume preparation no longer matches the candidate-role state.", 409, pairCurrent(pair));
        }
        if (triggerKind === "regenerate" && (pair.intent_state !== "interested" || pair.workflow_state !== "interested" || !pair.current_artifact_id)) {
          throw problem("generation_pair_not_eligible", "Resume regeneration requires the current Interested resume.", 409, pairCurrent(pair));
        }
        if (triggerKind === "retry") {
          const retryablePreparing = pair.intent_state === "interested" && pair.workflow_state === "preparing_resume";
          let retryableReview = false;
          if (pair.intent_state === "interested" && pair.workflow_state === "needs_review") {
            const review = (await tx`
              select count(*)::integer as count,
                     coalesce(bool_and(reason_code in ('candidate_original_resume_missing','resume_preparation_failed')), false) as all_allowed
                from submissions_v2.review_items
               where pair_id=${pairId} and action_state='open'
            `)[0];
            retryableReview = Number(review?.count || 0) > 0 && review?.all_allowed === true;
          }
          if (!retryablePreparing && !retryableReview) {
            throw problem("generation_pair_not_eligible", "Resume retry no longer matches an eligible Interested resume issue.", 409, pairCurrent(pair));
          }
        }
        const versions = await tx`select coalesce(max(generation_version),0)::integer + 1 as next from submissions_v2.resume_generations where pair_id=${pairId}`;
        const rows = await tx`
          insert into submissions_v2.resume_generations(
            pair_id, generation_version, trigger_kind, command_id, idempotency_key,
            expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
            validator_model_pin, prompt_pin, template_pin, budget_cents, deadline_at, prior_artifact_id
          ) values (
            ${pairId}, ${versions[0].next}, ${triggerKind}, ${commandId}, ${idempotencyKey},
            ${expectedPairVersion}, ${pair.first_signal_id}, ${primaryModelPin}, ${fallbackModelPin},
            ${validatorModelPin}, ${promptPin}, ${templatePin}, ${budgetCents}, ${deadlineAt}, ${priorArtifactId}
          ) returning *
        `;
        return rows[0];
      });
    },

    async resumeWorkInput(pairId) {
      const pairRows = await sql`
        select p.*, c.display_name as candidate_name, c.paraform_profile_url, c.linkedin_url,
               c.raydar_url, c.has_recorded_call, c.last_call_at,
               r.company_name, r.role_title, r.destination_url, r.active as role_active,
               r.last_confirmed_at as role_last_confirmed_at
          from submissions_v2.candidate_role_pairs p
          left join submissions_v2.candidate_index c on c.candidate_user_id=p.candidate_user_id
          left join submissions_v2.role_index r on r.role_id=p.role_id
         where p.id=${pairId} and p.case_hidden_at is null
      `;
      if (!pairRows.length) return null;
      const [supplements, priorArtifacts] = await Promise.all([
        sql`
          select id, supplement_kind, text_value_encrypted, object_key, extracted_text_object_key,
                 creator_email, created_at, mime_type, original_name, size_bytes, digest,
                 scan_state, parse_state, evidence_basis, source_or_correction_note
            from submissions_v2.resume_supplements
           where pair_id=${pairId} and active and not quarantined order by created_at, id
        `,
        sql`
          select id, generation_id, artifact_version, kind, digest, text_digest, page_count,
                 private_object_key, current_state, archived_at
            from submissions_v2.resume_artifacts
           where pair_id=${pairId} and kind='pdf' and validation_status='passed'
             and current_state in ('current','superseded') and deleted_at is null
           order by artifact_version desc
        `,
      ]);
      return { pair: pairRows[0], supplements, prior_artifacts: priorArtifacts };
    },

    async resumeGeneration(generationId) {
      const rows = await sql`select * from submissions_v2.resume_generations where id=${generationId}`;
      return rows[0] || null;
    },

    async startResumeStageRun({ generationId, stage, attempt, inputDigest }) {
      const rows = await sql`
        insert into submissions_v2.resume_stage_runs(generation_id, stage, attempt, input_digest, status)
        values (${generationId}, ${stage}, ${attempt}, ${inputDigest}, 'running')
        on conflict (generation_id, stage, attempt) do nothing returning *
      `;
      if (rows.length) return rows[0];
      const prior = await sql`select * from submissions_v2.resume_stage_runs where generation_id=${generationId} and stage=${stage} and attempt=${attempt}`;
      if (!prior.length || prior[0].input_digest !== inputDigest) throw problem("stage_run_conflict", "The resume stage attempt was already used for different input.", 409);
      return prior[0];
    },

    async finishResumeStageRun({ generationId, stage, attempt, status, outputObjectKey = null, outputDigest = null, costCents = 0, errorCode = null, safeDetail = null }) {
      if (!new Set(["succeeded", "failed", "held"]).has(status)) throw problem("stage_status_invalid", "The resume stage status is invalid.", 400);
      const rows = await sql`
        update submissions_v2.resume_stage_runs
           set status=${status}, output_object_key=${outputObjectKey}, output_digest=${outputDigest},
               cost_cents=${costCents}, completed_at=clock_timestamp(), safe_error_code=${errorCode}, safe_error_detail=${safeDetail}
         where generation_id=${generationId} and stage=${stage} and attempt=${attempt} and status='running'
         returning *
      `;
      if (!rows.length) throw problem("stage_run_fence_lost", "The resume stage run changed before completion.", 409);
      return rows[0];
    },

    async persistResumeClaims(generationId, claims = []) {
      const rows = [];
      for (const claim of claims) {
        const result = await sql`
          insert into submissions_v2.resume_claims(
            generation_id, claim_key, original_wording, final_wording, claim_kind, retained, final_status
          ) values (
            ${generationId}, ${claim.claim_key || claim.id}, ${claim.original_wording || claim.text},
            ${claim.final_wording || null}, ${claim.claim_kind || claim.kind || "candidate_fact"},
            ${claim.retained !== false}, ${claim.final_status || "pending"}
          ) on conflict (generation_id, claim_key) do nothing returning *
        `;
        if (result.length) rows.push(result[0]);
        else rows.push((await sql`select * from submissions_v2.resume_claims where generation_id=${generationId} and claim_key=${claim.claim_key || claim.id}`)[0]);
      }
      return rows;
    },

    async persistClaimEvidenceLinks(generationId, links = []) {
      const rows = [];
      for (const link of links) {
        const result = await sql`
          insert into submissions_v2.claim_evidence_links(
            claim_id, resume_source_id, candidate_side, exact_locator, exact_excerpt, evidence_digest
          )
          select claim.id, source.id, ${Boolean(link.candidate_side)}, ${link.exact_locator}, ${link.exact_excerpt || null}, ${link.evidence_digest}
            from submissions_v2.resume_claims claim
            join submissions_v2.resume_sources source on source.generation_id=claim.generation_id and source.source_key=${link.source_key}
           where claim.generation_id=${generationId} and claim.claim_key=${link.claim_key}
          on conflict (claim_id, resume_source_id, exact_locator) do nothing returning *
        `;
        if (result.length) rows.push(result[0]);
        else {
          const existing = await sql`
            select link.* from submissions_v2.claim_evidence_links link
            join submissions_v2.resume_claims claim on claim.id=link.claim_id
            join submissions_v2.resume_sources source on source.id=link.resume_source_id
            where claim.generation_id=${generationId} and claim.claim_key=${link.claim_key}
              and source.source_key=${link.source_key} and link.exact_locator=${link.exact_locator}
          `;
          if (!existing.length) throw problem("claim_evidence_binding_failed", "A claim could not be bound to its exact evidence source.", 422);
          rows.push(existing[0]);
        }
      }
      return rows;
    },

    async persistClaimValidations(generationId, validations = []) {
      return sql.begin(async (tx) => {
        const rows = [];
        for (const validation of validations) {
          const result = await tx`
            insert into submissions_v2.claim_validations(
              claim_id, attempt, validator_model_pin, result, rewrite_text, reason, input_digest, output_digest
            )
            select id, ${validation.attempt}, ${validation.validator_model_pin}, ${validation.result},
                   ${validation.rewrite_text || null}, ${validation.reason || null}, ${validation.input_digest}, ${validation.output_digest || null}
              from submissions_v2.resume_claims
             where generation_id=${generationId} and claim_key=${validation.claim_key}
            on conflict (claim_id, attempt) do nothing returning *
          `;
          let saved = result[0];
          if (!saved) {
            const existing = await tx`
              select validation.* from submissions_v2.claim_validations validation
              join submissions_v2.resume_claims claim on claim.id=validation.claim_id
              where claim.generation_id=${generationId} and claim.claim_key=${validation.claim_key}
                and validation.attempt=${validation.attempt}
            `;
            saved = existing[0];
          }
          if (!saved) throw problem("claim_validation_binding_failed", "A validation could not be bound to its resume claim.", 422);
          await tx`
            update submissions_v2.resume_claims
               set final_wording=coalesce(${validation.rewrite_text || null}, final_wording, original_wording),
                   retained=${validation.result !== "removed"}, final_status=${validation.result === "removed" ? "removed" : validation.result === "failed" ? "failed" : "passed"}
             where id=${saved.claim_id}
          `;
          rows.push(saved);
        }
        return rows;
      });
    },

    async updateSupplementProcessing({ supplementId, scanState, parseState, extractedTextObjectKey = null, objectReservation = null, generationId, executionFence }) {
      return sql.begin(async (tx) => {
        await assertGenerationFence(tx, executionFence, generationId);
        const rows = await tx`
          update submissions_v2.resume_supplements
             set scan_state=${scanState}, parse_state=${parseState}, extracted_text_object_key=${extractedTextObjectKey}
           where id=${supplementId} and active returning *
        `;
        if (!rows.length) throw problem("supplement_not_found", "The active resume supplement was not found.", 404);
        if (objectReservation?.id) {
          const committed = await tx`
            update submissions_v2.private_object_reservations
               set state='committed', committed_at=coalesce(committed_at, clock_timestamp()),
                   write_owner=null, write_lease_expires_at=null
             where id=${objectReservation.id} and object_key=${extractedTextObjectKey}
               and expected_digest=${String(objectReservation.digest || "").toLowerCase()}
               and (state='committed' or (state='pending' and write_fencing_token=${Number(objectReservation.write_fencing_token)}
                 and write_lease_expires_at >= clock_timestamp()))
            returning id
          `;
          if (!committed.length) {
            throw problem("private_object_reservation_fence_lost", "The parsed supplement lost its private-object reservation.", 409);
          }
        }
        return rows[0];
      });
    },

    async openedPairsForProof({ limit = 100, before = null } = {}) {
      return sql`
        select p.id, p.candidate_user_id, p.role_id, p.state_version, p.submission_opened_at,
               p.submission_status, r.destination_url
          from submissions_v2.candidate_role_pairs p
          left join submissions_v2.role_index r on r.role_id=p.role_id
         where p.submission_status='opened' and p.workflow_state='interested' and p.case_hidden_at is null
           and (${before}::timestamptz is null or p.submission_opened_at < ${before}::timestamptz)
         order by p.submission_opened_at, p.id limit ${boundedLimit(limit, 100, 100)}
      `;
    },

    async updateResumeGeneration({ generationId, fromStatuses = [], status, stage, spentCents = null, safeFailureCode = null, safeFailureDetail = null, executionFence }) {
      return sql.begin(async (tx) => {
        await assertGenerationFence(tx, executionFence, generationId);
        const rows = await tx`
          update submissions_v2.resume_generations
             set status=${status}, stage=${stage},
                 spent_cents=coalesce(${spentCents}, spent_cents),
                 safe_failure_code=${safeFailureCode}, safe_failure_detail=${safeFailureDetail},
                 started_at=coalesce(started_at, clock_timestamp()),
                 completed_at=case when ${status} in ('succeeded','failed','cancelled','held') then clock_timestamp() else completed_at end
           where id=${generationId}
             and (cardinality(${tx.array(fromStatuses, 25)})=0 or status=any(${tx.array(fromStatuses, 25)}))
           returning *
        `;
        if (!rows.length) throw problem("generation_fence_lost", "The resume generation changed before this update.", 409);
        return rows[0];
      });
    },

    async persistResumeSources(generationId, sources = [], executionFence) {
      return sql.begin(async (tx) => {
        await assertGenerationFence(tx, executionFence, generationId);
        const rows = [];
        for (const source of sources) {
          const inserted = await tx`
          insert into submissions_v2.resume_sources(
            generation_id, source_key, status, requiredness, origin, source_id, source_locator,
            captured_at, source_updated_at, content_digest, normalized_text_digest, item_count,
            accuracy_impact, remediation
          ) values (
            ${generationId}, ${source.source_key}, ${source.status}, ${source.requiredness}, ${source.origin},
            ${source.source_id || null}, ${source.source_locator || null}, ${source.captured_at || null},
            ${source.source_updated_at || null}, ${source.content_digest || null}, ${source.normalized_text_digest || null},
            ${source.item_count ?? null}, ${source.accuracy_impact || null}, ${source.remediation || null}
          ) on conflict (generation_id, source_key) do nothing returning *
          `;
          if (inserted.length) rows.push(inserted[0]);
          else {
            const existing = await tx`select * from submissions_v2.resume_sources where generation_id=${generationId} and source_key=${source.source_key}`;
            rows.push(existing[0]);
          }
        }
        return rows;
      });
    },

    async promoteResumeArtifacts({ generationId, artifacts, checkpointReservation = null, actorId = "submissions-v2-worker", execution }) {
      return sql.begin(async (tx) => {
        const jobId = clean(execution?.jobId, 100);
        const workerId = clean(execution?.workerId, 200);
        const fencingToken = Number(execution?.fencingToken);
        const controlEpoch = Number(execution?.controlEpoch);
        if (!jobId || !workerId || !Number.isInteger(fencingToken) || fencingToken < 1 || !Number.isInteger(controlEpoch) || controlEpoch < 0) {
          throw problem("execution_fence_required", "Artifact publication requires the active worker fence.", 409);
        }
        const fencedJobs = await tx`
          select j.* from submissions_v2.jobs j
          cross join submissions_v2.lock_runtime_controls() c
           where j.id=${jobId}::uuid and j.kind='prepare_resume' and j.state='running'
             and j.lease_owner=${workerId} and j.fencing_token=${fencingToken}
             and j.control_epoch=${controlEpoch} and j.lease_expires_at >= clock_timestamp()
             and c.control_epoch=${controlEpoch}
             and submissions_v2.job_control_enabled(j.required_control, c)
           for update of j
        `;
        if (!fencedJobs.length) throw problem("execution_fence_lost", "Artifact publication stopped because its worker lease or runtime control changed.", 409);
        const generations = await tx`select * from submissions_v2.resume_generations where id=${generationId} for update`;
        const generation = generations[0];
        if (!generation) throw problem("generation_not_found", "The resume generation was not found.", 404);
        if (fencedJobs[0].subject_type !== "pair" || fencedJobs[0].subject_id !== String(generation.pair_id)) {
          throw problem("execution_subject_mismatch", "The active worker fence does not belong to this candidate-role item.", 409);
        }
        if (generation.status === "succeeded") {
          const pair = (await tx`select * from submissions_v2.candidate_role_pairs where id=${generation.pair_id}`)[0];
          const saved = await tx`select * from submissions_v2.resume_artifacts where generation_id=${generationId} order by kind`;
          return { pair, artifacts: saved };
        }
        const pair = await lockPair(tx, generation.pair_id, generation.expected_pair_version);
        const byKind = new Map((artifacts || []).map((artifact) => [artifact.kind, artifact]));
        if (["pdf", "ats", "manifest"].some((kind) => !byKind.has(kind))) throw problem("artifact_set_incomplete", "PDF, ATS, and manifest artifacts are all required.", 422);
        const version = Number(generation.generation_version);
        const stored = [];
        for (const kind of ["pdf", "ats", "manifest"]) {
          const artifact = byKind.get(kind);
          const rows = await tx`
            insert into submissions_v2.resume_artifacts(
              pair_id, generation_id, artifact_version, kind, private_object_key, digest,
              size_bytes, page_count, text_digest, validation_status, archive_readback_at, archived_at, current_state
            ) values (
              ${pair.id}, ${generationId}, ${version}, ${kind}, ${artifact.private_object_key}, ${artifact.digest},
              ${artifact.size_bytes}, ${kind === "pdf" ? artifact.page_count : null}, ${artifact.text_digest || null},
              'passed', ${artifact.archive_readback_at}, ${artifact.archived_at}, 'staged'
            ) on conflict (generation_id, kind) do update set validation_status=resume_artifacts.validation_status
            returning *
          `;
          stored.push(rows[0]);
          const committed = await tx`
            update submissions_v2.private_object_reservations
               set state='committed', committed_at=coalesce(committed_at, clock_timestamp()),
                   write_owner=null, write_lease_expires_at=null
             where id=${artifact.object_reservation_id} and object_key=${artifact.private_object_key}
               and expected_digest=${artifact.digest}
               and (state='committed' or (state='pending' and write_fencing_token=${Number(artifact.object_write_fencing_token)}
                 and write_lease_expires_at >= clock_timestamp()))
            returning id
          `;
          if (!committed.length) throw problem("private_object_reservation_fence_lost", "A resume artifact lost its private-object reservation.", 409);
        }
        if (checkpointReservation?.id) {
          const committedCheckpoint = await tx`
            update submissions_v2.private_object_reservations
               set state='committed', committed_at=coalesce(committed_at, clock_timestamp()),
                   write_owner=null, write_lease_expires_at=null
             where id=${checkpointReservation.id} and object_key=${checkpointReservation.object_key}
               and expected_digest=${checkpointReservation.digest}
               and (state='committed' or (state='pending' and write_fencing_token=${Number(checkpointReservation.write_fencing_token)}
                 and write_lease_expires_at >= clock_timestamp()))
            returning id
          `;
          if (!committedCheckpoint.length) throw problem("private_object_reservation_fence_lost", "The archive checkpoint lost its private-object reservation.", 409);
        }
        await tx`update submissions_v2.resume_artifacts set current_state='superseded' where pair_id=${pair.id} and current_state='current'`;
        await tx`update submissions_v2.resume_artifacts set current_state='current' where generation_id=${generationId}`;
        const pdf = stored.find((artifact) => artifact.kind === "pdf");
        if (generation.trigger_kind === "retry") {
          await tx`
            update submissions_v2.review_items
               set action_state='resolved', resolved_at=clock_timestamp(), resolved_by=${actorId},
                   resolution_note='Resume preparation retry completed successfully.'
             where pair_id=${pair.id} and action_state='open'
               and reason_code in ('candidate_original_resume_missing','resume_preparation_failed')
          `;
          const remainingReview = (await tx`
            select count(*)::integer as count from submissions_v2.review_items
             where pair_id=${pair.id} and action_state='open'
          `)[0];
          if (Number(remainingReview?.count || 0) > 0) {
            throw problem("generation_pair_not_eligible", "Resume publication stopped because another review issue is still open.", 409, pairCurrent(pair));
          }
        }
        const updated = (await tx`
          update submissions_v2.candidate_role_pairs
             set intent_state='interested', workflow_state='interested', current_artifact_id=${pdf.id},
                 resume_ready_at=clock_timestamp(), state_version=state_version+1
           where id=${pair.id} and state_version=${generation.expected_pair_version} returning *
        `)[0];
        if (!updated) throw problem("stale_pair_version", "The candidate-role item changed before artifact promotion.", 409, pairCurrent(pair));
        await tx`update submissions_v2.resume_generations set status='succeeded', stage='complete', completed_at=clock_timestamp() where id=${generationId}`;
        await pairEvent(tx, updated, { actorType: "worker", actorId, source: "resume_generation", eventType: "resume_promoted", expectedVersion: Number(generation.expected_pair_version), previous: pair, idempotencyKey: `pair:resume-promoted:${generationId}`, metadata: { generation_id: generationId, artifact_version: version } });
        return { pair: updated, artifacts: stored };
      });
    },

    async failResumeGeneration({ generationId, reasonCode = "resume_preparation_failed", safeDetail = "Resume preparation exhausted safe recovery.", actorId = "submissions-v2-worker" }) {
      if (!new Set(["candidate_original_resume_missing", "resume_preparation_failed"]).has(reasonCode)) throw problem("resume_failure_reason_invalid", "The resume failure reason is invalid.", 400);
      return sql.begin(async (tx) => {
        const generation = (await tx`select * from submissions_v2.resume_generations where id=${generationId} for update`)[0];
        if (!generation) throw problem("generation_not_found", "The resume generation was not found.", 404);
        if (generation.status === "failed") {
          return (await tx`select * from submissions_v2.candidate_role_pairs where id=${generation.pair_id}`)[0];
        }
        const pair = await lockPair(tx, generation.pair_id, generation.expected_pair_version);
        await tx`
          update submissions_v2.resume_generations
             set status='failed', stage='failed', safe_failure_code=${reasonCode}, safe_failure_detail=${clean(safeDetail, 500)}, completed_at=clock_timestamp()
           where id=${generationId}
        `;
        const updated = (await tx`
          update submissions_v2.candidate_role_pairs
             set intent_state='interested', workflow_state='needs_review', state_version=state_version+1
           where id=${pair.id} and state_version=${generation.expected_pair_version} returning *
        `)[0];
        await tx`
          insert into submissions_v2.review_items(pair_id, reason_code, safe_detail, evidence)
          values (${pair.id}, ${reasonCode}, ${clean(safeDetail, 500)}, ${tx.json({ generation_id: generationId })})
          on conflict do nothing
        `;
        if (reasonCode === "resume_preparation_failed") {
          const candidate = (await tx`select display_name from submissions_v2.candidate_index where candidate_user_id=${pair.candidate_user_id}`)[0];
          const role = (await tx`select company_name, role_title from submissions_v2.role_index where role_id=${pair.role_id}`)[0];
          await tx`
            insert into submissions_v2.notification_outbox(kind, destination_id, safe_payload, dedupe_key, pair_id)
            values ('resume_preparation_failed', ${notificationDestination()},
                    ${tx.json({ candidate_name: candidate?.display_name || "Candidate", company: role?.company_name || null, role_title: role?.role_title || null, owner_name: ownerDisplayName(pair.owner_email), monitor_url: "https://monitor.raydar.xyz/#submissions-v2" })}, ${`resume-failed:${generationId}`}, ${pair.id})
            on conflict do nothing
          `;
        }
        await pairEvent(tx, updated, { actorType: "worker", actorId, source: "resume_generation", eventType: "resume_failed", expectedVersion: Number(generation.expected_pair_version), previous: pair, reasonCode, idempotencyKey: `pair:resume-failed:${generationId}`, metadata: { generation_id: generationId } });
        return updated;
      });
    },

    async recordSourceHealth({ sourceKey, enabled, success = false, delayed = false, quotaState = "clear", retryAt = null, errorClass = null, safeDetail = null }) {
      const rows = await sql`
        insert into submissions_v2.source_health(
          source_key, enabled, last_success_at, delayed_since, quota_state, quota_retry_at,
          error_class, safe_error_detail, last_recovery_at
        ) values (
          ${sourceKey}, ${enabled}, ${success ? new Date().toISOString() : null}, ${delayed ? new Date().toISOString() : null},
          ${quotaState}, ${retryAt}, ${errorClass}, ${safeDetail}, ${success ? new Date().toISOString() : null}
        ) on conflict (source_key) do update set
          enabled=excluded.enabled,
          last_success_at=case when ${success} then clock_timestamp() else source_health.last_success_at end,
          delayed_since=case
            when ${success} then null
            when ${delayed} then coalesce(source_health.delayed_since, clock_timestamp())
            else source_health.delayed_since
          end,
          last_recovery_at=case when ${success} and source_health.delayed_since is not null then clock_timestamp() else source_health.last_recovery_at end,
          quota_state=excluded.quota_state, quota_retry_at=excluded.quota_retry_at,
          error_class=case when ${success} then null when ${errorClass}::text is not null then excluded.error_class else source_health.error_class end,
          safe_error_detail=case when ${success} then null when ${safeDetail}::text is not null then excluded.safe_error_detail else source_health.safe_error_detail end
        returning *
      `;
      return rows[0];
    },

    async applySubmissionProof({ pairId, applicationId, authoritativePath, evidenceDigest, observedAt, checkedAt, actorId = "submissions-v2-worker", executionFence }) {
      return sql.begin(async (tx) => {
        await assertWorkerFence(tx, executionFence, "ingestion");
        const pair = (await tx`select * from submissions_v2.candidate_role_pairs where id=${pairId} for update`)[0];
        if (!pair || pair.workflow_state !== "interested" || pair.case_hidden_at) throw problem("proof_pair_invalid", "Submission proof must bind to a visible Interested candidate-role item.", 409);
        if (pair.submission_status === "proven") return pair;
        await tx`
          insert into submissions_v2.submission_proofs(pair_id, application_id, authoritative_path, evidence_digest, observed_at, source_checked_at)
          values (${pairId}, ${applicationId}, ${authoritativePath}, ${evidenceDigest}, ${observedAt}, ${checkedAt})
          on conflict (pair_id, application_id) do nothing
        `;
        const updated = (await tx`
          update submissions_v2.candidate_role_pairs
             set submission_status='proven', submission_proven_at=${observedAt}, submission_application_id=${applicationId},
                 submission_authoritative_path=${authoritativePath}, submission_evidence_digest=${evidenceDigest}, state_version=state_version+1
           where id=${pairId} and state_version=${pair.state_version} returning *
        `)[0];
        await pairEvent(tx, updated, { actorType: "worker", actorId, source: "proof_reconcile", eventType: "submission_proven", expectedVersion: Number(pair.state_version), previous: pair, idempotencyKey: `pair:proof:${pairId}:${applicationId}`, metadata: { application_id: applicationId, authoritative_path: authoritativePath } });
        return updated;
      });
    },

    async claimNotifications({ workerId, limit = 10, leaseSeconds = 60, executionFence } = {}) {
      const owner = clean(workerId, 200);
      if (!owner) throw problem("notification_worker_required", "The notification worker identity is required.", 400);
      const lease = Math.max(30, Math.min(300, Number(leaseSeconds) || 60));
      return sql.begin(async (tx) => {
        await assertWorkerFence(tx, executionFence, "ingestion");
        return tx`
          with stale as (
            update submissions_v2.notification_outbox
               set state='held', lease_owner=null, lease_expires_at=null,
                   safe_error_code='delivery_outcome_unknown',
                   safe_error_detail='The notification delivery lease expired without a provider receipt; it was held to prevent a duplicate.'
             where state='sending' and lease_expires_at < clock_timestamp()
            returning id
          ), due as (
            select id from submissions_v2.notification_outbox
             where state in ('pending','failed') and next_attempt_at <= clock_timestamp()
               and (pair_id is null or exists (
                 select 1 from submissions_v2.candidate_role_pairs pair
                  where pair.id=notification_outbox.pair_id and pair.case_hidden_at is null
               ))
             order by next_attempt_at, created_at for update skip locked limit ${boundedLimit(limit, 10, 50)}
          )
          update submissions_v2.notification_outbox n
             set state='sending', attempt_count=attempt_count+1,
                 lease_owner=${owner}, lease_expires_at=clock_timestamp() + make_interval(secs => ${lease}),
                 fencing_token=fencing_token+1, safe_error_code=null, safe_error_detail=null
           where n.id in (select id from due) returning n.*
        `;
      });
    },

    async settleNotification({ id, workerId, fencingToken, sent, retryable = false, receipt = null, errorCode = null, safeDetail = null, retryAt = null }) {
      const rows = await sql`
        update submissions_v2.notification_outbox
           set state=${sent ? "sent" : retryable ? "failed" : "held"}, provider_receipt=${receipt}, sent_at=${sent ? new Date().toISOString() : null},
               safe_error_code=${errorCode}, safe_error_detail=${safeDetail}, next_attempt_at=coalesce(${retryAt}, next_attempt_at),
               lease_owner=null, lease_expires_at=null
         where id=${id} and state='sending' and lease_owner=${workerId} and fencing_token=${Number(fencingToken)} returning *
      `;
      if (!rows.length) throw problem("notification_fence_lost", "The notification delivery fence was lost.", 409);
      return rows[0];
    },

    async deliverNotification({ id, workerId, fencingToken, executionFence, deliver }) {
      if (typeof deliver !== "function") throw problem("notification_delivery_required", "The notification delivery callback is required.", 400);
      return sql.begin(async (tx) => {
        await assertWorkerFence(tx, executionFence, "ingestion");
        const preview = (await tx`
          select id, pair_id from submissions_v2.notification_outbox
           where id=${id} and state='sending' and lease_owner=${workerId}
             and fencing_token=${Number(fencingToken)}
        `)[0];
        if (!preview) return { sent: false, cancelled: true };
        if (preview.pair_id) {
          const pair = (await tx`
            select id, case_hidden_at from submissions_v2.candidate_role_pairs
             where id=${preview.pair_id} for share
          `)[0];
          if (!pair || pair.case_hidden_at) {
            await tx`
              update submissions_v2.notification_outbox
                 set state='held', lease_owner=null, lease_expires_at=null,
                     safe_error_code='case_soft_deleted',
                     safe_error_detail='The candidate-role case was deleted before this notification started.'
               where id=${id} and state='sending' and lease_owner=${workerId}
                 and fencing_token=${Number(fencingToken)}
            `;
            return { sent: false, cancelled: true };
          }
        }
        const row = (await tx`
          select * from submissions_v2.notification_outbox
           where id=${id} and state='sending' and lease_owner=${workerId}
             and fencing_token=${Number(fencingToken)} for update
        `)[0];
        if (!row) return { sent: false, cancelled: true };
        const receipt = await deliver(row);
        const updated = await tx`
          update submissions_v2.notification_outbox
             set state='sent', provider_receipt=${receipt}, sent_at=clock_timestamp(),
                 lease_owner=null, lease_expires_at=null
           where id=${id} and state='sending' and lease_owner=${workerId}
             and fencing_token=${Number(fencingToken)} returning id
        `;
        if (!updated.length) throw problem("notification_fence_lost", "The notification delivery fence was lost.", 409);
        return { sent: true, cancelled: false, receipt };
      });
    },

    async dueUploadReservations({ before, limit = 50, workerId } = {}) {
      const cutoff = new Date(before);
      if (!Number.isFinite(cutoff.getTime())) throw problem("upload_reservation_cutoff_invalid", "The upload-reservation cleanup cutoff is invalid.", 400);
      const owner = clean(workerId, 200);
      if (!owner) throw problem("cleanup_worker_required", "The cleanup worker identity is required.", 400);
      return sql.begin(async (tx) => tx`
        with due as (
          select id from submissions_v2.upload_reservations
           where ((state='pending' and expires_at <= least(${cutoff.toISOString()}::timestamptz, clock_timestamp() - interval '24 hours'))
              or (state='cleanup' and cleanup_started_at < clock_timestamp() - interval '15 minutes'))
           order by expires_at, id for update skip locked
           limit ${boundedLimit(limit, 50, 100)}
        )
        update submissions_v2.upload_reservations reservation
           set state='cleanup', cleanup_owner=${owner}, cleanup_started_at=clock_timestamp(),
               cleanup_fencing_token=cleanup_fencing_token+1
          from due where reservation.id=due.id
        returning reservation.id as reservation_id, reservation.pair_id, reservation.object_key,
                  reservation.expires_at, reservation.cleanup_fencing_token
      `);
    },

    async duePrivateObjectReservations({ before, limit = 50, workerId } = {}) {
      const cutoff = new Date(before);
      if (!Number.isFinite(cutoff.getTime())) throw problem("private_object_reservation_cutoff_invalid", "The private-object cleanup cutoff is invalid.", 400);
      const owner = clean(workerId, 200);
      if (!owner) throw problem("cleanup_worker_required", "The cleanup worker identity is required.", 400);
      return sql.begin(async (tx) => tx`
        with due as (
          select id from submissions_v2.private_object_reservations
           where ((state='pending' and (write_lease_expires_at is null or write_lease_expires_at < clock_timestamp())
                    and expires_at <= least(${cutoff.toISOString()}::timestamptz, clock_timestamp() - interval '24 hours'))
              or (state='cleanup' and cleanup_started_at < clock_timestamp() - interval '15 minutes'))
           order by expires_at, id for update skip locked
           limit ${boundedLimit(limit, 50, 100)}
        )
        update submissions_v2.private_object_reservations reservation
           set state='cleanup', cleanup_owner=${owner}, cleanup_started_at=clock_timestamp(),
               cleanup_fencing_token=cleanup_fencing_token+1,
               write_owner=null, write_lease_expires_at=null
          from due where reservation.id=due.id
        returning reservation.id as reservation_id, reservation.object_key, reservation.expected_digest,
                  reservation.purpose, reservation.owner_ref, reservation.expires_at,
                  reservation.cleanup_fencing_token
      `);
    },

    async markPrivateObjectReservationPurged({ reservationId, workerId, fencingToken }) {
      const owner = clean(workerId, 200);
      const rows = await sql`
        update submissions_v2.private_object_reservations
           set state='purged', purged_at=clock_timestamp(), purge_actor=${owner}, cleanup_owner=null
         where id=${reservationId} and state='cleanup' and cleanup_owner=${owner}
           and cleanup_fencing_token=${Number(fencingToken)}
        returning id as reservation_id, object_key
      `;
      if (!rows.length) throw problem("private_object_reservation_purge_fence_lost", "The private-object cleanup fence was lost.", 409);
      return { ...rows[0], purged: true };
    },

    async releasePrivateObjectReservationCleanup({ reservationId, workerId, fencingToken }) {
      const rows = await sql`
        update submissions_v2.private_object_reservations
           set state='pending', cleanup_owner=null, cleanup_started_at=null
         where id=${reservationId} and state='cleanup' and cleanup_owner=${clean(workerId, 200)}
           and cleanup_fencing_token=${Number(fencingToken)} returning id as reservation_id
      `;
      return { released: Boolean(rows.length) };
    },

    async markUploadReservationPurged({ reservationId, workerId, fencingToken }) {
      const owner = clean(workerId, 200);
      const rows = await sql`
        update submissions_v2.upload_reservations
           set state='purged', purged_at=clock_timestamp(), purge_actor=${owner}, cleanup_owner=null
         where id=${reservationId} and state='cleanup' and cleanup_owner=${owner}
           and cleanup_fencing_token=${Number(fencingToken)}
        returning id as reservation_id, pair_id, object_key
      `;
      if (!rows.length) throw problem("upload_reservation_purge_fence_lost", "The upload reservation cleanup fence was lost.", 409);
      return { ...rows[0], purged: true };
    },

    async releaseUploadReservationCleanup({ reservationId, workerId, fencingToken }) {
      const rows = await sql`
        update submissions_v2.upload_reservations
           set state='pending', cleanup_owner=null, cleanup_started_at=null
         where id=${reservationId} and state='cleanup' and cleanup_owner=${clean(workerId, 200)}
           and cleanup_fencing_token=${Number(fencingToken)} returning id as reservation_id
      `;
      return { released: Boolean(rows.length) };
    },

    async dueQuarantinedSupplements({ before, limit = 50, workerId } = {}) {
      const cutoff = new Date(before);
      if (!Number.isFinite(cutoff.getTime())) throw problem("quarantine_cutoff_invalid", "The quarantine cleanup cutoff is invalid.", 400);
      const owner = clean(workerId, 200);
      if (!owner) throw problem("cleanup_worker_required", "The cleanup worker identity is required.", 400);
      return sql.begin(async (tx) => tx`
        with due as (
          select id from submissions_v2.resume_supplements
           where quarantined and active and object_key is not null and private_object_purged_at is null
             and ((quarantine_cleanup_state='pending'
                   and created_at <= least(${cutoff.toISOString()}::timestamptz, clock_timestamp() - interval '24 hours'))
               or (quarantine_cleanup_state='cleanup'
                   and quarantine_cleanup_started_at < clock_timestamp() - interval '15 minutes'))
           order by created_at, id for update skip locked
           limit ${boundedLimit(limit, 50, 100)}
        )
        update submissions_v2.resume_supplements supplement
           set quarantine_cleanup_state='cleanup', quarantine_cleanup_owner=${owner},
               quarantine_cleanup_started_at=clock_timestamp(),
               quarantine_cleanup_fencing_token=quarantine_cleanup_fencing_token+1
          from due where supplement.id=due.id
        returning supplement.id as supplement_id, supplement.pair_id, supplement.object_key,
                  supplement.digest, supplement.created_at, supplement.quarantine_cleanup_fencing_token
      `);
    },

    async markQuarantinedSupplementPurged({ supplementId, workerId, fencingToken }) {
      const owner = clean(workerId, 200);
      return sql.begin(async (tx) => {
        const rows = await tx`
          select s.*, p.intent_state, p.workflow_state, p.submission_status
            from submissions_v2.resume_supplements s
            join submissions_v2.candidate_role_pairs p on p.id=s.pair_id
           where s.id=${supplementId} and s.quarantine_cleanup_state='cleanup'
             and s.quarantine_cleanup_owner=${owner}
             and s.quarantine_cleanup_fencing_token=${Number(fencingToken)} for update of s
        `;
        const supplement = rows[0];
        if (!supplement) throw problem("supplement_quarantine_purge_fence_lost", "The quarantined-supplement cleanup fence was lost.", 409);
        if (!supplement.quarantined) throw problem("supplement_not_quarantined", "Only a quarantined supplement may be purged by this cleanup path.", 409);
        await pairEvent(tx, { ...supplement, id: supplement.pair_id }, {
          actorType: "worker", actorId: owner, source: "supplement_quarantine",
          eventType: "quarantined_supplement_purged", idempotencyKey: `supplement-quarantine-purge:${supplementId}`,
          note: "An expired untrusted upload was removed after private-object deletion.",
          metadata: { supplement_id: supplementId, digest: supplement.digest },
        });
        const updated = await tx`
          update submissions_v2.resume_supplements
             set active=false, deleted_at=coalesce(deleted_at, clock_timestamp()),
                 deletion_actor=coalesce(deletion_actor, ${owner}),
                 private_object_purged_at=clock_timestamp(), private_object_purge_actor=${owner},
                 quarantine_cleanup_state='purged', quarantine_cleanup_owner=null
           where id=${supplementId} and quarantined and active
             and quarantine_cleanup_state='cleanup' and quarantine_cleanup_owner=${owner}
             and quarantine_cleanup_fencing_token=${Number(fencingToken)} returning id
        `;
        if (!updated.length) throw problem("supplement_quarantine_purge_fence_lost", "The quarantined-supplement cleanup fence was lost.", 409);
        return {
          supplement_id: supplementId, pair_id: supplement.pair_id,
          object_key: supplement.object_key, digest: supplement.digest,
          purged: true, already_purged: false,
        };
      });
    },

    async releaseQuarantinedSupplementCleanup({ supplementId, workerId, fencingToken }) {
      const rows = await sql`
        update submissions_v2.resume_supplements
           set quarantine_cleanup_state='pending', quarantine_cleanup_owner=null,
               quarantine_cleanup_started_at=null
         where id=${supplementId} and quarantined and active
           and quarantine_cleanup_state='cleanup' and quarantine_cleanup_owner=${clean(workerId, 200)}
           and quarantine_cleanup_fencing_token=${Number(fencingToken)} returning id as supplement_id
      `;
      return { released: Boolean(rows.length) };
    },

    async duePurges() {
      // Case artifacts are deleted only by the separately credentialed isolated purge service.
      return { artifacts: [], cases: [] };
    },

    async markArtifactPurged({ deletionId, result }) {
      return sql.begin(async (tx) => {
        const rows = await tx`
          update submissions_v2.artifact_deletions set purged_at=clock_timestamp(), purge_result=${clean(result, 500)}
           where id=${deletionId} and restored_at is null and purged_at is null returning *
        `;
        if (!rows.length) throw problem("purge_fence_lost", "The artifact purge fence was lost.", 409);
        await tx`update submissions_v2.resume_artifacts set current_state='purged' where id=${rows[0].artifact_id} and current_state='deleted'`;
        return rows[0];
      });
    },

    // Called only after a separately isolated purge identity has deleted every
    // object and sensitive row named by the encrypted manifest and fresh DB scan.
    signalUrlFromEnvelope,
  };
}

export const repositoryInternals = Object.freeze({
  boundedLimit, deletionSnapshot, sameSnapshot, signalUrlFromEnvelope, pairAdvisoryLockKey, REVIEW_REASONS,
});
