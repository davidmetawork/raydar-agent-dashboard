create table submissions_v2.upload_reservations (
  id uuid primary key,
  pair_id uuid not null references submissions_v2.candidate_role_pairs(id) on delete restrict,
  command_id uuid not null unique references submissions_v2.api_commands(id) on delete restrict,
  object_key text not null unique,
  actor_email text not null,
  expected_pair_version bigint not null check (expected_pair_version >= 0),
  mime_type text not null,
  original_name text not null,
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  expires_at timestamptz not null,
  state text not null default 'pending' check (state in ('pending', 'completed', 'purged')),
  supplement_id uuid unique references submissions_v2.resume_supplements(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  purged_at timestamptz,
  purge_actor text,
  check (expires_at > created_at),
  check ((state = 'pending' and supplement_id is null and completed_at is null and purged_at is null and purge_actor is null)
      or (state = 'completed' and supplement_id is not null and completed_at is not null and purged_at is null and purge_actor is null)
      or (state = 'purged' and supplement_id is null and completed_at is null and purged_at is not null and purge_actor is not null))
);

create index upload_reservations_cleanup_idx
  on submissions_v2.upload_reservations (expires_at, id)
  where state = 'pending';
