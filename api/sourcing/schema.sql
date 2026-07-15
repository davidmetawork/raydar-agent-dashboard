-- PostgreSQL schema for the Paraform-native Sourcing workspace.
--
-- Contains orchestration state only: stable Paraform IDs, normalized hashes,
-- structured feedback, and audit metadata. Full candidate profiles stay in
-- Paraform. RLS is enabled with no browser policies, so only a server-held
-- service credential can access these tables when the schema is provisioned.

create extension if not exists pgcrypto;

create table if not exists sourcing_role_config (
  paraform_role_id text primary key,
  review_project_id text not null,
  sequence_id text,
  active_rubric_version_id uuid,
  owner_email text,
  candidate_cap integer not null default 100 check (candidate_cap between 1 and 500),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(trim(paraform_role_id)) >= 6),
  check (length(trim(review_project_id)) >= 6),
  check (sequence_id is null or length(trim(sequence_id)) >= 6)
);

create table if not exists sourcing_rubric_version (
  id uuid primary key default gen_random_uuid(),
  paraform_role_id text not null references sourcing_role_config(paraform_role_id),
  version integer not null check (version > 0),
  parent_version_id uuid references sourcing_rubric_version(id),
  criteria jsonb not null,
  source_snapshot jsonb not null default '{}'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (paraform_role_id, version)
);

alter table sourcing_role_config
  drop constraint if exists sourcing_role_config_active_rubric_version_id_fkey;
alter table sourcing_role_config
  add constraint sourcing_role_config_active_rubric_version_id_fkey
  foreign key (active_rubric_version_id) references sourcing_rubric_version(id);

create table if not exists sourcing_run (
  id uuid primary key default gen_random_uuid(),
  paraform_role_id text not null references sourcing_role_config(paraform_role_id),
  rubric_version_id uuid not null references sourcing_rubric_version(id),
  status text not null default 'draft'
    check (status in ('draft','ready','running','review','complete','failed','cancelled')),
  candidate_cap integer not null check (candidate_cap between 1 and 500),
  discovered_count integer not null default 0 check (discovered_count >= 0),
  deduped_count integer not null default 0 check (deduped_count >= 0),
  review_count integer not null default 0 check (review_count >= 0),
  idempotency_key text not null unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text
);

create table if not exists sourcing_lane (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references sourcing_run(id) on delete cascade,
  lane_key text not null,
  rationale text,
  filter_snapshot jsonb not null,
  native_session_id text,
  native_search_id text,
  result_count integer not null default 0 check (result_count >= 0),
  created_at timestamptz not null default now(),
  unique (run_id, lane_key)
);

create table if not exists sourcing_candidate (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references sourcing_run(id) on delete cascade,
  lane_id uuid references sourcing_lane(id),
  paraform_candidate_id text not null,
  paraform_candidate_user_id text,
  linkedin_identity_hash text,
  state text not null default 'discovered'
    check (state in (
      'discovered','dedup_blocked','in_review','good','maybe','bad',
      'project_queued','project_filed','enrollment_queued',
      'enrollment_blocked','enrolled'
    )),
  dedup_reason text,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, paraform_candidate_id)
);

create index if not exists sourcing_candidate_pf_user_idx
  on sourcing_candidate(paraform_candidate_user_id)
  where paraform_candidate_user_id is not null;
create index if not exists sourcing_candidate_linkedin_hash_idx
  on sourcing_candidate(linkedin_identity_hash)
  where linkedin_identity_hash is not null;

create table if not exists sourcing_feedback_event (
  id uuid primary key default gen_random_uuid(),
  sourcing_candidate_id uuid not null references sourcing_candidate(id) on delete cascade,
  paraform_role_id text not null references sourcing_role_config(paraform_role_id),
  rubric_version_id uuid not null references sourcing_rubric_version(id),
  verdict text not null check (verdict in ('good','maybe','bad')),
  reason text check (reason in (
    'wrong_title','too_junior','too_senior','wrong_industry','weak_company',
    'missing_skill','location','job_hopper','duplicate_or_known','other'
  )),
  note text check (note is null or length(note) <= 1000),
  actor_email text not null,
  created_at timestamptz not null default now(),
  check ((verdict = 'bad' and reason is not null) or (verdict <> 'bad' and reason is null))
);

create index if not exists sourcing_feedback_role_created_idx
  on sourcing_feedback_event(paraform_role_id, created_at desc);

create table if not exists sourcing_filter_proposal (
  id uuid primary key default gen_random_uuid(),
  paraform_role_id text not null references sourcing_role_config(paraform_role_id),
  source_run_id uuid not null references sourcing_run(id),
  source_rubric_version_id uuid not null references sourcing_rubric_version(id),
  scope text not null check (scope in ('rubric','dedup')),
  reason text not null,
  evidence_count integer not null check (evidence_count > 0),
  proposed_delta jsonb not null,
  status text not null default 'proposed'
    check (status in ('proposed','accepted','edited','rejected')),
  proposed_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  decision_note text
);

create table if not exists sourcing_enrollment (
  id uuid primary key default gen_random_uuid(),
  sourcing_candidate_id uuid not null references sourcing_candidate(id),
  review_project_id text not null,
  sequence_id text not null,
  idempotency_key text not null unique,
  status text not null default 'queued'
    check (status in ('queued','project_filed','enrolled','blocked','failed')),
  blocked_reason text,
  attempted_at timestamptz,
  verified_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now()
);

alter table sourcing_role_config enable row level security;
alter table sourcing_rubric_version enable row level security;
alter table sourcing_run enable row level security;
alter table sourcing_lane enable row level security;
alter table sourcing_candidate enable row level security;
alter table sourcing_feedback_event enable row level security;
alter table sourcing_filter_proposal enable row level security;
alter table sourcing_enrollment enable row level security;
