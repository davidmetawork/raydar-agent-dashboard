alter table submissions_v2.first_response_claims
  drop constraint first_response_claims_pkey,
  drop constraint first_response_claims_event_id_role_id_key,
  add column id uuid not null default gen_random_uuid(),
  add column released_at timestamptz,
  add column release_reason text,
  add constraint first_response_claims_pkey primary key (id),
  add constraint first_response_claims_event_role_uq unique (event_id, role_id),
  add constraint first_response_claims_release_shape check (
    (released_at is null and release_reason is null)
    or (released_at is not null and release_reason in ('unmentioned_role', 'not_applied')
        and signal_id is not null and committed_at is not null)
  );

create unique index first_response_claims_active_pair_uq
  on submissions_v2.first_response_claims(candidate_user_id, role_id)
  where released_at is null;

create or replace function submissions_v2.guard_first_response_claim()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  if new.candidate_user_id is distinct from old.candidate_user_id
     or new.role_id is distinct from old.role_id
     or new.event_id is distinct from old.event_id
     or new.source_family is distinct from old.source_family
     or new.claimed_at is distinct from old.claimed_at then
    raise exception using errcode='55000', message='first-response claim identity is immutable';
  end if;
  if old.signal_id is not null and new.signal_id is distinct from old.signal_id then
    raise exception using errcode='55000', message='first-response signal binding is immutable';
  end if;
  if old.committed_at is not null and new.committed_at is distinct from old.committed_at then
    raise exception using errcode='55000', message='first-response commitment is immutable';
  end if;
  if old.released_at is not null
     and (new.released_at is distinct from old.released_at or new.release_reason is distinct from old.release_reason) then
    raise exception using errcode='55000', message='first-response release audit is immutable';
  end if;
  return new;
end;
$$;

create trigger first_response_claims_immutable
before update on submissions_v2.first_response_claims
for each row execute function submissions_v2.guard_first_response_claim();

revoke execute on function submissions_v2.guard_first_response_claim() from public;

alter table submissions_v2.source_events
  add constraint source_events_body_object_path_check check (
    encrypted_body_object_key is null or encrypted_body_object_key ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'
  ),
  add constraint source_events_sender_object_path_check check (
    encrypted_sender_object_key is null or encrypted_sender_object_key ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'
  );

alter table submissions_v2.resume_stage_runs
  add constraint resume_stage_runs_output_object_path_check check (
    output_object_key is null or output_object_key ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'
  );

alter table submissions_v2.resume_supplements
  add constraint resume_supplements_object_path_check check (
    object_key is null or object_key ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'
  ),
  add constraint resume_supplements_extracted_object_path_check check (
    extracted_text_object_key is null or extracted_text_object_key ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'
  );

alter table submissions_v2.resume_artifacts
  add constraint resume_artifacts_object_path_check check (
    private_object_key ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'
  );

alter table submissions_v2.case_deletions
  add constraint case_deletions_manifest_object_path_check check (
    encrypted_manifest_object_key='[purged]'
    or encrypted_manifest_object_key ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'
  );

alter table submissions_v2.upload_reservations
  add constraint upload_reservations_object_path_check check (
    object_key ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'
  );

alter table submissions_v2.private_object_reservations
  add constraint private_object_reservations_object_path_check check (
    object_key ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'
  );

alter table submissions_v2.download_tickets
  add constraint download_tickets_object_path_check check (
    pathname ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'
  );

-- Pair ownership is part of every generation-owned record's identity; a
-- compromised writer must not attach pair B's generation or object to pair A.
alter table submissions_v2.resume_generations
  add constraint resume_generations_id_pair_uq unique (id, pair_id);
alter table submissions_v2.resume_artifacts
  add constraint resume_artifacts_generation_pair_fk
  foreign key (generation_id, pair_id)
  references submissions_v2.resume_generations(id, pair_id) on delete restrict;
alter table submissions_v2.resume_supplements
  add constraint resume_supplements_generation_pair_fk
  foreign key (generation_id, pair_id)
  references submissions_v2.resume_generations(id, pair_id) on delete restrict;

-- One Blob pathname can have many read references (for example, download
-- tickets), but it must have exactly one storage owner.  This registry is
-- maintained only by SECURITY DEFINER triggers, so an API or worker
-- credential cannot make a due case indirectly delete another case's object.
create table submissions_v2.private_object_bindings (
  object_key text primary key
    check (object_key ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'),
  reservation_kind text check (reservation_kind is null or reservation_kind in ('private', 'upload')),
  reservation_id uuid,
  reservation_purpose text,
  reservation_owner_ref text,
  reservation_pair_id uuid,
  owner_table text check (owner_table is null or owner_table in (
    'source_events', 'resume_stage_runs', 'resume_supplements',
    'resume_artifacts', 'case_deletions'
  )),
  owner_column text,
  owner_id uuid,
  owner_binding_ref text,
  owner_pair_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (
    (reservation_kind is null and reservation_id is null and reservation_purpose is null
      and reservation_owner_ref is null and reservation_pair_id is null)
    or (reservation_kind='private' and reservation_id is not null and reservation_purpose is not null
      and reservation_owner_ref is not null and reservation_pair_id is null)
    or (reservation_kind='upload' and reservation_id is not null and reservation_purpose is null
      and reservation_owner_ref is null and reservation_pair_id is not null)
  ),
  check (
    (owner_table is null and owner_column is null and owner_id is null
      and owner_binding_ref is null and owner_pair_id is null)
    or (owner_table is not null and owner_column is not null and owner_id is not null
      and owner_binding_ref is not null)
  ),
  check (reservation_id is not null or owner_id is not null)
);

revoke all on submissions_v2.private_object_bindings from public;

create or replace function submissions_v2.private_object_binding_compatible(
  p_reservation_kind text,
  p_reservation_purpose text,
  p_reservation_owner_ref text,
  p_reservation_pair_id uuid,
  p_owner_table text,
  p_owner_column text,
  p_owner_binding_ref text,
  p_owner_pair_id uuid
)
returns boolean
language sql
immutable
set search_path = pg_catalog, submissions_v2
as $$
  select case
    when p_owner_table is null or p_reservation_kind is null then true
    when p_owner_table='source_events'
      and p_owner_column in ('encrypted_body_object_key', 'encrypted_sender_object_key')
      then p_reservation_kind='private' and p_reservation_purpose='source_event'
        and p_reservation_owner_ref=p_owner_binding_ref
    when p_owner_table='resume_stage_runs' and p_owner_column='output_object_key'
      then p_reservation_kind='private' and p_reservation_purpose='resume_checkpoint'
        and p_reservation_owner_ref=p_owner_binding_ref
    when p_owner_table='resume_supplements' and p_owner_column='object_key'
      then p_reservation_kind='upload' and p_reservation_pair_id=p_owner_pair_id
    when p_owner_table='resume_supplements' and p_owner_column='extracted_text_object_key'
      then p_reservation_kind='private' and p_reservation_purpose='supplement_text'
        and p_reservation_owner_ref=p_owner_binding_ref
    when p_owner_table='resume_artifacts' and p_owner_column='private_object_key'
      then p_reservation_kind='private' and p_reservation_purpose='resume_artifact'
        and p_reservation_owner_ref=p_owner_binding_ref
    when p_owner_table='case_deletions' and p_owner_column='encrypted_manifest_object_key'
      then p_reservation_kind='private' and p_reservation_purpose='case_manifest'
        and p_reservation_owner_ref=p_owner_binding_ref
    else false
  end
$$;

create or replace function submissions_v2.claim_private_object_reservation_binding()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  binding submissions_v2.private_object_bindings%rowtype;
begin
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.object_key is distinct from old.object_key
       or new.purpose is distinct from old.purpose or new.owner_ref is distinct from old.owner_ref
       or new.expected_digest is distinct from old.expected_digest
       or new.created_at is distinct from old.created_at then
      raise exception using errcode='55000', message='private object reservation identity is immutable';
    end if;
    return new;
  elsif tg_op='DELETE' then
    update submissions_v2.private_object_bindings item
       set reservation_kind=null, reservation_id=null, reservation_purpose=null,
           reservation_owner_ref=null, reservation_pair_id=null, updated_at=clock_timestamp()
     where item.object_key=old.object_key and item.reservation_kind='private'
       and item.reservation_id=old.id;
    delete from submissions_v2.private_object_bindings item
     where item.object_key=old.object_key and item.reservation_id is null and item.owner_id is null;
    return old;
  end if;

  insert into submissions_v2.private_object_bindings(
    object_key, reservation_kind, reservation_id, reservation_purpose, reservation_owner_ref
  ) values (new.object_key, 'private', new.id, new.purpose, new.owner_ref)
  on conflict (object_key) do update
     set reservation_kind='private', reservation_id=new.id,
         reservation_purpose=new.purpose, reservation_owner_ref=new.owner_ref,
         reservation_pair_id=null, updated_at=clock_timestamp()
   where private_object_bindings.reservation_id is null
  returning * into binding;
  if binding.object_key is null then
    select * into binding from submissions_v2.private_object_bindings item
     where item.object_key=new.object_key;
  end if;
  if binding.reservation_kind is distinct from 'private'
     or binding.reservation_id is distinct from new.id
     or binding.reservation_purpose is distinct from new.purpose
     or binding.reservation_owner_ref is distinct from new.owner_ref
     or not submissions_v2.private_object_binding_compatible(
       binding.reservation_kind, binding.reservation_purpose, binding.reservation_owner_ref,
       binding.reservation_pair_id, binding.owner_table, binding.owner_column,
       binding.owner_binding_ref, binding.owner_pair_id
     ) then
    raise exception using errcode='23505', message='private object path is already reserved or owned by another record';
  end if;
  return new;
end;
$$;

create or replace function submissions_v2.claim_upload_object_reservation_binding()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  binding submissions_v2.private_object_bindings%rowtype;
begin
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.object_key is distinct from old.object_key
       or new.pair_id is distinct from old.pair_id or new.command_id is distinct from old.command_id
       or new.actor_email is distinct from old.actor_email
       or new.created_at is distinct from old.created_at then
      raise exception using errcode='55000', message='upload reservation identity is immutable';
    end if;
    return new;
  elsif tg_op='DELETE' then
    update submissions_v2.private_object_bindings item
       set reservation_kind=null, reservation_id=null, reservation_purpose=null,
           reservation_owner_ref=null, reservation_pair_id=null, updated_at=clock_timestamp()
     where item.object_key=old.object_key and item.reservation_kind='upload'
       and item.reservation_id=old.id;
    delete from submissions_v2.private_object_bindings item
     where item.object_key=old.object_key and item.reservation_id is null and item.owner_id is null;
    return old;
  end if;

  insert into submissions_v2.private_object_bindings(
    object_key, reservation_kind, reservation_id, reservation_pair_id
  ) values (new.object_key, 'upload', new.id, new.pair_id)
  on conflict (object_key) do update
     set reservation_kind='upload', reservation_id=new.id, reservation_pair_id=new.pair_id,
         reservation_purpose=null, reservation_owner_ref=null, updated_at=clock_timestamp()
   where private_object_bindings.reservation_id is null
  returning * into binding;
  if binding.object_key is null then
    select * into binding from submissions_v2.private_object_bindings item
     where item.object_key=new.object_key;
  end if;
  if binding.reservation_kind is distinct from 'upload'
     or binding.reservation_id is distinct from new.id
     or binding.reservation_pair_id is distinct from new.pair_id
     or not submissions_v2.private_object_binding_compatible(
       binding.reservation_kind, binding.reservation_purpose, binding.reservation_owner_ref,
       binding.reservation_pair_id, binding.owner_table, binding.owner_column,
       binding.owner_binding_ref, binding.owner_pair_id
     ) then
    raise exception using errcode='23505', message='private object path is already reserved or owned by another record';
  end if;
  return new;
end;
$$;

create or replace function submissions_v2.claim_private_object_owner(
  p_object_key text,
  p_owner_table text,
  p_owner_column text,
  p_owner_id uuid,
  p_owner_binding_ref text,
  p_owner_pair_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  binding submissions_v2.private_object_bindings%rowtype;
begin
  if p_object_key is null then return; end if;
  insert into submissions_v2.private_object_bindings(
    object_key, owner_table, owner_column, owner_id, owner_binding_ref, owner_pair_id
  ) values (
    p_object_key, p_owner_table, p_owner_column, p_owner_id, p_owner_binding_ref, p_owner_pair_id
  )
  on conflict (object_key) do update
     set owner_table=p_owner_table, owner_column=p_owner_column, owner_id=p_owner_id,
         owner_binding_ref=p_owner_binding_ref, owner_pair_id=p_owner_pair_id,
         updated_at=clock_timestamp()
   where private_object_bindings.owner_id is null
  returning * into binding;
  if binding.object_key is null then
    select * into binding from submissions_v2.private_object_bindings item
     where item.object_key=p_object_key;
  end if;
  if binding.owner_table is distinct from p_owner_table
     or binding.owner_column is distinct from p_owner_column
     or binding.owner_id is distinct from p_owner_id
     or binding.owner_binding_ref is distinct from p_owner_binding_ref
     or binding.owner_pair_id is distinct from p_owner_pair_id
     or not submissions_v2.private_object_binding_compatible(
       binding.reservation_kind, binding.reservation_purpose, binding.reservation_owner_ref,
       binding.reservation_pair_id, binding.owner_table, binding.owner_column,
       binding.owner_binding_ref, binding.owner_pair_id
     ) then
    raise exception using errcode='23505', message='private object path already belongs to another record';
  end if;
end;
$$;

create or replace function submissions_v2.release_private_object_owner(
  p_object_key text,
  p_owner_table text,
  p_owner_column text,
  p_owner_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
begin
  if p_object_key is null or p_object_key='[purged]' then return; end if;
  update submissions_v2.private_object_bindings item
     set owner_table=null, owner_column=null, owner_id=null, owner_binding_ref=null,
         owner_pair_id=null, updated_at=clock_timestamp()
   where item.object_key=p_object_key and item.owner_table=p_owner_table
     and item.owner_column=p_owner_column and item.owner_id=p_owner_id;
  delete from submissions_v2.private_object_bindings item
   where item.object_key=p_object_key and item.reservation_id is null and item.owner_id is null;
end;
$$;

create or replace function submissions_v2.guard_private_object_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  generation_pair_id uuid;
begin
  if tg_table_name='source_events' then
    if tg_op='DELETE' then
      perform submissions_v2.release_private_object_owner(old.encrypted_body_object_key, tg_table_name, 'encrypted_body_object_key', old.id);
      perform submissions_v2.release_private_object_owner(old.encrypted_sender_object_key, tg_table_name, 'encrypted_sender_object_key', old.id);
      return old;
    end if;
    if tg_op='UPDATE' and (
      new.id is distinct from old.id or new.event_id is distinct from old.event_id
      or
      new.encrypted_body_object_key is distinct from old.encrypted_body_object_key
      or new.encrypted_sender_object_key is distinct from old.encrypted_sender_object_key
    ) then
      raise exception using errcode='55000', message='source private object ownership is immutable';
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform submissions_v2.claim_private_object_owner(new.encrypted_body_object_key, tg_table_name, 'encrypted_body_object_key', new.id, new.event_id, null);
      perform submissions_v2.claim_private_object_owner(new.encrypted_sender_object_key, tg_table_name, 'encrypted_sender_object_key', new.id, new.event_id, null);
    end if;
    return new;
  elsif tg_table_name='resume_stage_runs' then
    if tg_op='DELETE' then
      perform submissions_v2.release_private_object_owner(old.output_object_key, tg_table_name, 'output_object_key', old.id);
      return old;
    end if;
    if tg_op='UPDATE' and (
      new.id is distinct from old.id or new.generation_id is distinct from old.generation_id
    ) then
      raise exception using errcode='55000', message='resume checkpoint owner relation is immutable';
    end if;
    select generation.pair_id into generation_pair_id
      from submissions_v2.resume_generations generation where generation.id=new.generation_id;
    if tg_op='UPDATE' and old.output_object_key is not null
       and new.output_object_key is distinct from old.output_object_key then
      raise exception using errcode='55000', message='resume checkpoint object ownership is immutable';
    end if;
    if new.output_object_key is not null then
      perform submissions_v2.claim_private_object_owner(new.output_object_key, tg_table_name, 'output_object_key', new.id, new.generation_id::text, generation_pair_id);
    end if;
    return new;
  elsif tg_table_name='resume_supplements' then
    if tg_op='DELETE' then
      perform submissions_v2.release_private_object_owner(old.object_key, tg_table_name, 'object_key', old.id);
      perform submissions_v2.release_private_object_owner(old.extracted_text_object_key, tg_table_name, 'extracted_text_object_key', old.id);
      return old;
    end if;
    if tg_op='UPDATE' and (
      new.id is distinct from old.id or new.pair_id is distinct from old.pair_id
      or new.generation_id is distinct from old.generation_id
    ) then
      raise exception using errcode='55000', message='supplement owner relation is immutable';
    end if;
    if tg_op='UPDATE' and old.object_key is distinct from new.object_key then
      raise exception using errcode='55000', message='supplement private object ownership is immutable';
    end if;
    if tg_op='UPDATE' and old.extracted_text_object_key is not null
       and new.extracted_text_object_key is distinct from old.extracted_text_object_key then
      raise exception using errcode='55000', message='supplement extracted object ownership is immutable';
    end if;
    if new.object_key is not null then
      perform submissions_v2.claim_private_object_owner(new.object_key, tg_table_name, 'object_key', new.id, new.pair_id::text, new.pair_id);
    end if;
    if new.extracted_text_object_key is not null then
      perform submissions_v2.claim_private_object_owner(new.extracted_text_object_key, tg_table_name, 'extracted_text_object_key', new.id, new.id::text, new.pair_id);
    end if;
    return new;
  elsif tg_table_name='resume_artifacts' then
    if tg_op='DELETE' then
      perform submissions_v2.release_private_object_owner(old.private_object_key, tg_table_name, 'private_object_key', old.id);
      return old;
    end if;
    if tg_op='UPDATE' and new.private_object_key is distinct from old.private_object_key then
      raise exception using errcode='55000', message='resume artifact object ownership is immutable';
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform submissions_v2.claim_private_object_owner(new.private_object_key, tg_table_name, 'private_object_key', new.id, new.generation_id::text, new.pair_id);
    end if;
    return new;
  elsif tg_table_name='case_deletions' then
    if tg_op='DELETE' then
      perform submissions_v2.release_private_object_owner(old.encrypted_manifest_object_key, tg_table_name, 'encrypted_manifest_object_key', old.id);
      return old;
    end if;
    if tg_op='UPDATE' and (
      new.id is distinct from old.id or new.pair_id is distinct from old.pair_id
    ) then
      raise exception using errcode='55000', message='case manifest owner relation is immutable';
    end if;
    if tg_op='UPDATE' and new.encrypted_manifest_object_key is distinct from old.encrypted_manifest_object_key then
      if new.encrypted_manifest_object_key <> '[purged]'
         or session_user <> 'submissions_v2_purge'
         or current_setting('submissions_v2.approved_purge', true) <> 'on' then
        raise exception using errcode='55000', message='case manifest object ownership is immutable';
      end if;
      perform submissions_v2.release_private_object_owner(old.encrypted_manifest_object_key, tg_table_name, 'encrypted_manifest_object_key', old.id);
    elsif tg_op in ('INSERT', 'UPDATE') then
      perform submissions_v2.claim_private_object_owner(new.encrypted_manifest_object_key, tg_table_name, 'encrypted_manifest_object_key', new.id, new.pair_id::text, new.pair_id);
    end if;
    return new;
  end if;
  raise exception using errcode='55000', message='unsupported private object owner table';
end;
$$;

create or replace function submissions_v2.backfill_private_object_bindings()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  bound_count integer;
begin
  -- Releases 001-010 stored the internal source UUID after commit; the stable
  -- reservation identity is now the immutable provider event id used before
  -- Blob write, so normalize that one legacy transition before guards attach.
  update submissions_v2.private_object_reservations reservation
     set owner_ref=event.event_id
    from submissions_v2.source_events event
   where reservation.purpose='source_event'
     and reservation.owner_ref=event.id::text
     and event.event_id is not null
     and reservation.object_key in (event.encrypted_body_object_key, event.encrypted_sender_object_key);

  if exists (
    select 1 from submissions_v2.private_object_reservations private
    join submissions_v2.upload_reservations upload on upload.object_key=private.object_key
  ) then
    raise exception using errcode='23505', message='legacy private object path has conflicting reservation owners';
  end if;

  insert into submissions_v2.private_object_bindings(
    object_key, reservation_kind, reservation_id, reservation_purpose, reservation_owner_ref
  )
  select reservation.object_key, 'private', reservation.id, reservation.purpose, reservation.owner_ref
    from submissions_v2.private_object_reservations reservation
  on conflict (object_key) do update
     set reservation_kind='private', reservation_id=excluded.reservation_id,
         reservation_purpose=excluded.reservation_purpose,
         reservation_owner_ref=excluded.reservation_owner_ref,
         reservation_pair_id=null, updated_at=clock_timestamp()
   where private_object_bindings.reservation_id is null;

  insert into submissions_v2.private_object_bindings(
    object_key, reservation_kind, reservation_id, reservation_pair_id
  )
  select reservation.object_key, 'upload', reservation.id, reservation.pair_id
    from submissions_v2.upload_reservations reservation
  on conflict (object_key) do update
     set reservation_kind='upload', reservation_id=excluded.reservation_id,
         reservation_pair_id=excluded.reservation_pair_id,
         reservation_purpose=null, reservation_owner_ref=null, updated_at=clock_timestamp()
   where private_object_bindings.reservation_id is null;

  if exists (
    with owners as (
      select event.encrypted_body_object_key as object_key, 'source_events'::text as owner_table,
             'encrypted_body_object_key'::text as owner_column, event.id as owner_id,
             event.event_id as owner_binding_ref, null::uuid as owner_pair_id
        from submissions_v2.source_events event where event.encrypted_body_object_key is not null
      union all
      select event.encrypted_sender_object_key, 'source_events', 'encrypted_sender_object_key',
             event.id, event.event_id, null::uuid
        from submissions_v2.source_events event where event.encrypted_sender_object_key is not null
      union all
      select stage.output_object_key, 'resume_stage_runs', 'output_object_key', stage.id,
             stage.generation_id::text, generation.pair_id
        from submissions_v2.resume_stage_runs stage
        join submissions_v2.resume_generations generation on generation.id=stage.generation_id
       where stage.output_object_key is not null
      union all
      select supplement.object_key, 'resume_supplements', 'object_key', supplement.id,
             supplement.pair_id::text, supplement.pair_id
        from submissions_v2.resume_supplements supplement where supplement.object_key is not null
      union all
      select supplement.extracted_text_object_key, 'resume_supplements', 'extracted_text_object_key',
             supplement.id, supplement.id::text, supplement.pair_id
        from submissions_v2.resume_supplements supplement where supplement.extracted_text_object_key is not null
      union all
      select artifact.private_object_key, 'resume_artifacts', 'private_object_key', artifact.id,
             artifact.generation_id::text, artifact.pair_id
        from submissions_v2.resume_artifacts artifact
      union all
      select deletion.encrypted_manifest_object_key, 'case_deletions', 'encrypted_manifest_object_key',
             deletion.id, deletion.pair_id::text, deletion.pair_id
        from submissions_v2.case_deletions deletion
       where deletion.encrypted_manifest_object_key <> '[purged]'
    )
    select 1 from owners group by object_key having count(*) > 1
  ) then
    raise exception using errcode='23505', message='legacy private object path has multiple storage owners';
  end if;

  if exists (
    with owners as (
      select event.encrypted_body_object_key as object_key, 'source_events'::text as owner_table,
             'encrypted_body_object_key'::text as owner_column, event.id as owner_id,
             event.event_id as owner_binding_ref, null::uuid as owner_pair_id
        from submissions_v2.source_events event where event.encrypted_body_object_key is not null
      union all
      select event.encrypted_sender_object_key, 'source_events', 'encrypted_sender_object_key',
             event.id, event.event_id, null::uuid
        from submissions_v2.source_events event where event.encrypted_sender_object_key is not null
      union all
      select stage.output_object_key, 'resume_stage_runs', 'output_object_key', stage.id,
             stage.generation_id::text, generation.pair_id
        from submissions_v2.resume_stage_runs stage
        join submissions_v2.resume_generations generation on generation.id=stage.generation_id
       where stage.output_object_key is not null
      union all
      select supplement.object_key, 'resume_supplements', 'object_key', supplement.id,
             supplement.pair_id::text, supplement.pair_id
        from submissions_v2.resume_supplements supplement where supplement.object_key is not null
      union all
      select supplement.extracted_text_object_key, 'resume_supplements', 'extracted_text_object_key',
             supplement.id, supplement.id::text, supplement.pair_id
        from submissions_v2.resume_supplements supplement where supplement.extracted_text_object_key is not null
      union all
      select artifact.private_object_key, 'resume_artifacts', 'private_object_key', artifact.id,
             artifact.generation_id::text, artifact.pair_id
        from submissions_v2.resume_artifacts artifact
      union all
      select deletion.encrypted_manifest_object_key, 'case_deletions', 'encrypted_manifest_object_key',
             deletion.id, deletion.pair_id::text, deletion.pair_id
        from submissions_v2.case_deletions deletion
       where deletion.encrypted_manifest_object_key <> '[purged]'
    )
    select 1
      from owners owner
      join submissions_v2.private_object_bindings binding on binding.object_key=owner.object_key
     where binding.reservation_id is not null
       and not submissions_v2.private_object_binding_compatible(
         binding.reservation_kind, binding.reservation_purpose, binding.reservation_owner_ref,
         binding.reservation_pair_id, owner.owner_table, owner.owner_column,
         owner.owner_binding_ref, owner.owner_pair_id
       )
  ) then
    raise exception using errcode='23514', message='legacy private object reservation does not match its storage owner';
  end if;

  with owners as (
    select event.encrypted_body_object_key as object_key, 'source_events'::text as owner_table,
           'encrypted_body_object_key'::text as owner_column, event.id as owner_id,
           event.event_id as owner_binding_ref, null::uuid as owner_pair_id
      from submissions_v2.source_events event where event.encrypted_body_object_key is not null
    union all
    select event.encrypted_sender_object_key, 'source_events', 'encrypted_sender_object_key',
           event.id, event.event_id, null::uuid
      from submissions_v2.source_events event where event.encrypted_sender_object_key is not null
    union all
    select stage.output_object_key, 'resume_stage_runs', 'output_object_key', stage.id,
           stage.generation_id::text, generation.pair_id
      from submissions_v2.resume_stage_runs stage
      join submissions_v2.resume_generations generation on generation.id=stage.generation_id
     where stage.output_object_key is not null
    union all
    select supplement.object_key, 'resume_supplements', 'object_key', supplement.id,
           supplement.pair_id::text, supplement.pair_id
      from submissions_v2.resume_supplements supplement where supplement.object_key is not null
    union all
    select supplement.extracted_text_object_key, 'resume_supplements', 'extracted_text_object_key',
           supplement.id, supplement.id::text, supplement.pair_id
      from submissions_v2.resume_supplements supplement where supplement.extracted_text_object_key is not null
    union all
    select artifact.private_object_key, 'resume_artifacts', 'private_object_key', artifact.id,
           artifact.generation_id::text, artifact.pair_id
      from submissions_v2.resume_artifacts artifact
    union all
    select deletion.encrypted_manifest_object_key, 'case_deletions', 'encrypted_manifest_object_key',
           deletion.id, deletion.pair_id::text, deletion.pair_id
      from submissions_v2.case_deletions deletion
     where deletion.encrypted_manifest_object_key <> '[purged]'
  )
  insert into submissions_v2.private_object_bindings(
    object_key, owner_table, owner_column, owner_id, owner_binding_ref, owner_pair_id
  )
  select owner.object_key, owner.owner_table, owner.owner_column, owner.owner_id,
         owner.owner_binding_ref, owner.owner_pair_id
    from owners owner
  on conflict (object_key) do update
     set owner_table=excluded.owner_table, owner_column=excluded.owner_column,
         owner_id=excluded.owner_id, owner_binding_ref=excluded.owner_binding_ref,
         owner_pair_id=excluded.owner_pair_id, updated_at=clock_timestamp()
   where private_object_bindings.owner_id is null;

  select count(*)::integer into bound_count from submissions_v2.private_object_bindings;
  return bound_count;
end;
$$;

-- This executes transactionally while upgrading a populated 001-010 schema;
-- any duplicate or mismatched legacy ownership aborts the entire migration.
select submissions_v2.backfill_private_object_bindings();

create trigger private_object_reservations_binding
before insert or update or delete on submissions_v2.private_object_reservations
for each row execute function submissions_v2.claim_private_object_reservation_binding();
create trigger upload_reservations_binding
before insert or update or delete on submissions_v2.upload_reservations
for each row execute function submissions_v2.claim_upload_object_reservation_binding();
create trigger source_events_private_object_owner
before insert or update or delete on submissions_v2.source_events
for each row execute function submissions_v2.guard_private_object_owner();
create trigger resume_stage_runs_private_object_owner
before insert or update or delete on submissions_v2.resume_stage_runs
for each row execute function submissions_v2.guard_private_object_owner();
create trigger resume_supplements_private_object_owner
before insert or update or delete on submissions_v2.resume_supplements
for each row execute function submissions_v2.guard_private_object_owner();
create trigger resume_artifacts_private_object_owner
before insert or update or delete on submissions_v2.resume_artifacts
for each row execute function submissions_v2.guard_private_object_owner();
create trigger case_deletions_private_object_owner
before insert or update or delete on submissions_v2.case_deletions
for each row execute function submissions_v2.guard_private_object_owner();

revoke execute on function submissions_v2.private_object_binding_compatible(text,text,text,uuid,text,text,text,uuid) from public;
revoke execute on function submissions_v2.claim_private_object_reservation_binding() from public;
revoke execute on function submissions_v2.claim_upload_object_reservation_binding() from public;
revoke execute on function submissions_v2.claim_private_object_owner(text,text,text,uuid,text,uuid) from public;
revoke execute on function submissions_v2.release_private_object_owner(text,text,text,uuid) from public;
revoke execute on function submissions_v2.guard_private_object_owner() from public;
revoke execute on function submissions_v2.backfill_private_object_bindings() from public;

create or replace function submissions_v2.claim_routine_object_purges(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer
)
returns table(purge_kind text, record_id uuid, object_path text, fencing_token bigint)
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
begin
  perform submissions_v2.assert_isolated_purge_session();
  if length(btrim(coalesce(p_worker_id, ''))) = 0
     or p_limit < 1 or p_limit > 50
     or p_lease_seconds < 60 or p_lease_seconds > 3600 then
    raise exception using errcode='22023', message='invalid routine purge claim bounds';
  end if;

  return query
  with due as materialized (
    select reservation.id
      from submissions_v2.private_object_reservations reservation
      join submissions_v2.private_object_bindings binding
        on binding.object_key=reservation.object_key
       and binding.reservation_kind='private' and binding.reservation_id=reservation.id
       and binding.owner_id is null
     where reservation.object_key ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'
       and (
         (reservation.state='pending'
           and (reservation.write_lease_expires_at is null or reservation.write_lease_expires_at < clock_timestamp())
           and reservation.expires_at <= clock_timestamp() - interval '24 hours')
         or (reservation.state='cleanup' and reservation.cleanup_started_at < clock_timestamp() - interval '15 minutes')
       )
     order by reservation.expires_at, reservation.id
     for update skip locked
     limit p_limit
  )
  update submissions_v2.private_object_reservations reservation
     set state='cleanup', cleanup_owner=p_worker_id, cleanup_started_at=clock_timestamp(),
         cleanup_fencing_token=reservation.cleanup_fencing_token+1,
         write_owner=null, write_lease_expires_at=null
   where reservation.id in (select due.id from due)
  returning 'private_object_reservation'::text, reservation.id, reservation.object_key,
            reservation.cleanup_fencing_token;

  return query
  with due as materialized (
    select reservation.id
      from submissions_v2.upload_reservations reservation
      join submissions_v2.private_object_bindings binding
        on binding.object_key=reservation.object_key
       and binding.reservation_kind='upload' and binding.reservation_id=reservation.id
       and binding.owner_id is null
     where reservation.object_key ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'
       and (
         (reservation.state='pending' and reservation.expires_at <= clock_timestamp() - interval '24 hours')
         or (reservation.state='cleanup' and reservation.cleanup_started_at < clock_timestamp() - interval '15 minutes')
       )
     order by reservation.expires_at, reservation.id
     for update skip locked
     limit p_limit
  )
  update submissions_v2.upload_reservations reservation
     set state='cleanup', cleanup_owner=p_worker_id, cleanup_started_at=clock_timestamp(),
         cleanup_fencing_token=reservation.cleanup_fencing_token+1
   where reservation.id in (select due.id from due)
  returning 'upload_reservation'::text, reservation.id, reservation.object_key,
            reservation.cleanup_fencing_token;

  return query
  with due as materialized (
    select supplement.id
      from submissions_v2.resume_supplements supplement
      join submissions_v2.private_object_bindings binding
        on binding.object_key=supplement.object_key
       and binding.owner_table='resume_supplements' and binding.owner_column='object_key'
       and binding.owner_id=supplement.id
     where supplement.quarantined and supplement.active and supplement.object_key is not null
       and supplement.object_key ~ '^submissions/resumes/v2/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'
       and supplement.private_object_purged_at is null
       and (
         (supplement.quarantine_cleanup_state='pending' and supplement.created_at <= clock_timestamp() - interval '24 hours')
         or (supplement.quarantine_cleanup_state='cleanup'
             and supplement.quarantine_cleanup_started_at < clock_timestamp() - interval '15 minutes')
       )
     order by supplement.created_at, supplement.id
     for update skip locked
     limit p_limit
  )
  update submissions_v2.resume_supplements supplement
     set quarantine_cleanup_state='cleanup', quarantine_cleanup_owner=p_worker_id,
         quarantine_cleanup_started_at=clock_timestamp(),
         quarantine_cleanup_fencing_token=supplement.quarantine_cleanup_fencing_token+1
   where supplement.id in (select due.id from due)
  returning 'quarantined_supplement'::text, supplement.id, supplement.object_key,
            supplement.quarantine_cleanup_fencing_token;
end;
$$;

create or replace function submissions_v2.finalize_routine_object_purge(
  p_purge_kind text,
  p_record_id uuid,
  p_worker_id text,
  p_fencing_token bigint
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  changed integer := 0;
  supplement submissions_v2.resume_supplements%rowtype;
  pair submissions_v2.candidate_role_pairs%rowtype;
begin
  perform submissions_v2.assert_isolated_purge_session();
  perform set_config('submissions_v2.approved_purge', 'on', true);
  if p_purge_kind='private_object_reservation' then
    update submissions_v2.private_object_reservations reservation
       set state='purged', purged_at=clock_timestamp(), purge_actor=p_worker_id, cleanup_owner=null
     where reservation.id=p_record_id and reservation.state='cleanup'
       and reservation.cleanup_owner=p_worker_id and reservation.cleanup_fencing_token=p_fencing_token;
    get diagnostics changed = row_count;
  elsif p_purge_kind='upload_reservation' then
    update submissions_v2.upload_reservations reservation
       set state='purged', purged_at=clock_timestamp(), purge_actor=p_worker_id, cleanup_owner=null
     where reservation.id=p_record_id and reservation.state='cleanup'
       and reservation.cleanup_owner=p_worker_id and reservation.cleanup_fencing_token=p_fencing_token;
    get diagnostics changed = row_count;
  elsif p_purge_kind='quarantined_supplement' then
    select item.* into supplement
      from submissions_v2.resume_supplements item
     where item.id=p_record_id and item.quarantined and item.active
       and item.quarantine_cleanup_state='cleanup' and item.quarantine_cleanup_owner=p_worker_id
       and item.quarantine_cleanup_fencing_token=p_fencing_token
     for update;
    if supplement.id is not null then
      select item.* into pair from submissions_v2.candidate_role_pairs item where item.id=supplement.pair_id;
      update submissions_v2.resume_supplements item
         set active=false, deleted_at=coalesce(item.deleted_at, clock_timestamp()),
             deletion_actor=coalesce(item.deletion_actor, p_worker_id),
             private_object_purged_at=clock_timestamp(), private_object_purge_actor=p_worker_id,
             quarantine_cleanup_state='purged', quarantine_cleanup_owner=null
       where item.id=supplement.id and item.quarantine_cleanup_state='cleanup'
         and item.quarantine_cleanup_owner=p_worker_id
         and item.quarantine_cleanup_fencing_token=p_fencing_token;
      get diagnostics changed = row_count;
      if changed=1 and pair.id is not null then
        insert into submissions_v2.pair_events(
          pair_id, actor_type, actor_id, source, event_type,
          from_intent_state, to_intent_state, from_workflow_state, to_workflow_state,
          from_submission_status, to_submission_status, note, idempotency_key, metadata
        ) values (
          pair.id, 'system', p_worker_id, 'isolated_purge', 'quarantined_supplement_purged',
          pair.intent_state, pair.intent_state, pair.workflow_state, pair.workflow_state,
          pair.submission_status, pair.submission_status,
          'An expired untrusted upload was removed after isolated private-object deletion.',
          'supplement-quarantine-purge:' || supplement.id::text,
          jsonb_build_object('supplement_id', supplement.id, 'digest', supplement.digest)
        ) on conflict (idempotency_key) do nothing;
      end if;
    end if;
  else
    raise exception using errcode='22023', message='invalid routine purge kind';
  end if;
  if changed <> 1 then
    raise exception using errcode='40001', message='routine purge claim fence lost';
  end if;
  return true;
end;
$$;

create or replace function submissions_v2.release_routine_object_purge(
  p_purge_kind text,
  p_record_id uuid,
  p_worker_id text,
  p_fencing_token bigint
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  changed integer := 0;
begin
  perform submissions_v2.assert_isolated_purge_session();
  if p_purge_kind='private_object_reservation' then
    update submissions_v2.private_object_reservations reservation
       set state='pending', cleanup_owner=null, cleanup_started_at=null
     where reservation.id=p_record_id and reservation.state='cleanup'
       and reservation.cleanup_owner=p_worker_id and reservation.cleanup_fencing_token=p_fencing_token;
    get diagnostics changed = row_count;
  elsif p_purge_kind='upload_reservation' then
    update submissions_v2.upload_reservations reservation
       set state='pending', cleanup_owner=null, cleanup_started_at=null
     where reservation.id=p_record_id and reservation.state='cleanup'
       and reservation.cleanup_owner=p_worker_id and reservation.cleanup_fencing_token=p_fencing_token;
    get diagnostics changed = row_count;
  elsif p_purge_kind='quarantined_supplement' then
    update submissions_v2.resume_supplements supplement
       set quarantine_cleanup_state='pending', quarantine_cleanup_owner=null,
           quarantine_cleanup_started_at=null
     where supplement.id=p_record_id and supplement.quarantine_cleanup_state='cleanup'
       and supplement.quarantine_cleanup_owner=p_worker_id
       and supplement.quarantine_cleanup_fencing_token=p_fencing_token;
    get diagnostics changed = row_count;
  else
    raise exception using errcode='22023', message='invalid routine purge kind';
  end if;
  if changed <> 1 then
    raise exception using errcode='40001', message='routine purge release fence lost';
  end if;
  return true;
end;
$$;

revoke all on function submissions_v2.claim_routine_object_purges(text, integer, integer) from public;
revoke all on function submissions_v2.finalize_routine_object_purge(text, uuid, text, bigint) from public;
revoke all on function submissions_v2.release_routine_object_purge(text, uuid, text, bigint) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname='submissions_v2_purge') then
    grant execute on function submissions_v2.claim_routine_object_purges(text, integer, integer) to submissions_v2_purge;
    grant execute on function submissions_v2.finalize_routine_object_purge(text, uuid, text, bigint) to submissions_v2_purge;
    grant execute on function submissions_v2.release_routine_object_purge(text, uuid, text, bigint) to submissions_v2_purge;
  end if;
end;
$$;

revoke execute on all functions in schema submissions_v2 from public;
