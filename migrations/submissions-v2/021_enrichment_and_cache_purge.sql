-- Late enrichment evidence remains immutable during normal operation, but its
-- source-owned row must not prevent the isolated case purge from deleting the
-- source event after the recovery window closes.
alter table submissions_v2.source_enrichments
  drop constraint source_enrichments_signal_id_fkey;
alter table submissions_v2.source_enrichments
  add constraint source_enrichments_signal_id_fkey
  foreign key (signal_id) references submissions_v2.source_events(id) on delete cascade;

create or replace function submissions_v2.reject_source_evidence_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  if tg_op = 'DELETE'
     and tg_table_name = 'source_enrichments'
     and session_user = 'submissions_v2_purge'
     and current_setting('submissions_v2.approved_purge', true) = 'on' then
    return old;
  end if;
  raise exception using
    errcode = '55000',
    message = 'Source enrichment and intake receipts are immutable';
end;
$$;

-- Releasing the final owner must delete an owner-only binding directly. The
-- earlier update-then-delete implementation could not clear that row because
-- its shape constraint requires at least one reservation or owner.
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
  if p_object_key is null or p_object_key = '[purged]' then return; end if;
  delete from submissions_v2.private_object_bindings item
   where item.object_key = p_object_key
     and item.owner_table = p_owner_table
     and item.owner_column = p_owner_column
     and item.owner_id = p_owner_id
     and item.reservation_id is null;
  update submissions_v2.private_object_bindings item
     set owner_table = null, owner_column = null, owner_id = null, owner_binding_ref = null,
         owner_pair_id = null, updated_at = clock_timestamp()
   where item.object_key = p_object_key
     and item.owner_table = p_owner_table
     and item.owner_column = p_owner_column
     and item.owner_id = p_owner_id;
end;
$$;

-- Deleting a pair makes the case-deletion tombstone's foreign key set its
-- pair id to null. Preserve every other owner invariant while allowing that
-- one transition inside the already fenced isolated purge transaction.
create function submissions_v2.guard_case_deletion_private_object_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  releasing_pair boolean := false;
begin
  if tg_op = 'DELETE' then
    perform submissions_v2.release_private_object_owner(
      old.encrypted_manifest_object_key,
      'case_deletions',
      'encrypted_manifest_object_key',
      old.id
    );
    return old;
  end if;
  if tg_op = 'UPDATE' and new.id is distinct from old.id then
    raise exception using errcode = '55000', message = 'case manifest owner relation is immutable';
  end if;
  if tg_op = 'UPDATE' and new.pair_id is distinct from old.pair_id then
    if old.pair_id is not null
       and new.pair_id is null
       and session_user = 'submissions_v2_purge'
       and current_setting('submissions_v2.approved_purge', true) = 'on' then
      releasing_pair := true;
    else
      raise exception using errcode = '55000', message = 'case manifest owner relation is immutable';
    end if;
  end if;
  if tg_op = 'UPDATE'
     and new.encrypted_manifest_object_key is distinct from old.encrypted_manifest_object_key then
    if new.encrypted_manifest_object_key <> '[purged]'
       or session_user <> 'submissions_v2_purge'
       or current_setting('submissions_v2.approved_purge', true) <> 'on' then
      raise exception using errcode = '55000', message = 'case manifest object ownership is immutable';
    end if;
    perform submissions_v2.release_private_object_owner(
      old.encrypted_manifest_object_key,
      'case_deletions',
      'encrypted_manifest_object_key',
      old.id
    );
  elsif releasing_pair then
    update submissions_v2.private_object_bindings binding
       set owner_pair_id = null, updated_at = clock_timestamp()
     where binding.object_key = new.encrypted_manifest_object_key
       and binding.owner_table = 'case_deletions'
       and binding.owner_column = 'encrypted_manifest_object_key'
       and binding.owner_id = new.id;
  else
    perform submissions_v2.claim_private_object_owner(
      new.encrypted_manifest_object_key,
      'case_deletions',
      'encrypted_manifest_object_key',
      new.id,
      new.pair_id::text,
      new.pair_id
    );
  end if;
  return new;
end;
$$;

drop trigger case_deletions_private_object_owner on submissions_v2.case_deletions;
create trigger case_deletions_private_object_owner
before insert or update or delete on submissions_v2.case_deletions
for each row execute function submissions_v2.guard_case_deletion_private_object_owner();

-- A candidate-original extraction is shared only while at least one case for
-- that candidate remains. Deleting the final pair removes the cache in the
-- same authorized purge transaction; another pair preserves the shared row.
create function submissions_v2.remove_candidate_original_extraction_after_pair_purge()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  if session_user <> 'submissions_v2_purge'
     or current_setting('submissions_v2.approved_purge', true) <> 'on' then
    raise exception using
      errcode = '42501',
      message = 'candidate extraction cleanup requires the isolated purge identity';
  end if;
  delete from submissions_v2.candidate_original_extraction_cache cache
   where cache.candidate_user_id = old.candidate_user_id
     and not exists (
       select 1
         from submissions_v2.candidate_role_pairs remaining
        where remaining.candidate_user_id = old.candidate_user_id
     );
  return old;
end;
$$;

create trigger candidate_pair_extraction_cache_purge
after delete on submissions_v2.candidate_role_pairs
for each row execute function submissions_v2.remove_candidate_original_extraction_after_pair_purge();

-- The isolated purge service also drains expired rows and any orphaned rows
-- left by data that predates the pair-deletion trigger.
create function submissions_v2.purge_candidate_original_extraction_cache(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  deleted_count integer;
begin
  perform submissions_v2.assert_isolated_purge_session();
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = '22023', message = 'invalid candidate extraction purge limit';
  end if;
  with doomed as (
    select cache.candidate_user_id, cache.source_id, cache.source_locator, cache.content_digest
      from submissions_v2.candidate_original_extraction_cache cache
     where cache.expires_at <= clock_timestamp()
        or not exists (
          select 1
            from submissions_v2.candidate_role_pairs pair
           where pair.candidate_user_id = cache.candidate_user_id
        )
     order by (cache.expires_at <= clock_timestamp()) desc, cache.expires_at,
              cache.candidate_user_id, cache.source_id, cache.source_locator, cache.content_digest
     limit p_limit
     for update of cache skip locked
  ), deleted as (
    delete from submissions_v2.candidate_original_extraction_cache cache
     using doomed
     where cache.candidate_user_id = doomed.candidate_user_id
       and cache.source_id = doomed.source_id
       and cache.source_locator = doomed.source_locator
       and cache.content_digest = doomed.content_digest
    returning 1
  )
  select count(*)::integer into deleted_count from deleted;
  return deleted_count;
end;
$$;

revoke all on function submissions_v2.remove_candidate_original_extraction_after_pair_purge() from public;
revoke all on function submissions_v2.release_private_object_owner(text, text, text, uuid) from public;
revoke all on function submissions_v2.guard_case_deletion_private_object_owner() from public;
revoke all on function submissions_v2.purge_candidate_original_extraction_cache(integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'submissions_v2_purge') then
    grant execute on function submissions_v2.purge_candidate_original_extraction_cache(integer)
      to submissions_v2_purge;
  end if;
end;
$$;
