-- Candidate-original extraction is reusable only after the current source bytes
-- reconfirm the exact candidate/source/locator/digest tuple. It is derived
-- private data, never an artifact, strategy, validator result, or supplement.
create table submissions_v2.candidate_original_extraction_cache (
  candidate_user_id text not null,
  source_id text not null,
  source_locator text not null,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  normalized_text_encrypted bytea not null,
  normalized_text_digest text not null check (normalized_text_digest ~ '^[0-9a-f]{64}$'),
  page_count integer check (page_count is null or page_count > 0),
  captured_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (candidate_user_id, source_id, source_locator, content_digest),
  check (expires_at > captured_at)
);
create index candidate_original_extraction_cache_expiry_idx
  on submissions_v2.candidate_original_extraction_cache (expires_at);

alter table submissions_v2.resume_stage_runs
  add column reserved_cents integer not null default 0 check (reserved_cents between 0 and 200),
  add column actual_cents integer check (actual_cents is null or actual_cents between 0 and 200),
  add column charge_outcome text not null default 'not_called'
    check (charge_outcome in ('not_called', 'reserved', 'settled', 'unknown')),
  add column reservation_at timestamptz,
  add column settled_at timestamptz,
  add constraint resume_stage_runs_charge_shape check (
    (reserved_cents = 0 and actual_cents is null and charge_outcome = 'not_called'
      and reservation_at is null and settled_at is null)
    or
    (reserved_cents > 0 and charge_outcome in ('reserved', 'unknown')
      and actual_cents is null and reservation_at is not null)
    or
    (reserved_cents > 0 and charge_outcome = 'settled'
      and actual_cents is not null and actual_cents <= reserved_cents
      and reservation_at is not null and settled_at is not null)
  );

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'submissions_v2_worker') then
    grant select, insert, update, delete on submissions_v2.candidate_original_extraction_cache to submissions_v2_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'submissions_v2_purge') then
    grant select, delete on submissions_v2.candidate_original_extraction_cache to submissions_v2_purge;
  end if;
end;
$$;
