begin;

alter table submissions_v2.resume_supplements
  add column if not exists quarantined boolean not null default false;

alter table submissions_v2.resume_supplements
  drop constraint if exists resume_supplements_quarantine_shape;

alter table submissions_v2.resume_supplements
  add constraint resume_supplements_quarantine_shape check (
    not quarantined or (
      supplement_kind = 'evidence'
      and object_key is not null
      and scan_state = 'pending'
      and parse_state = 'pending'
      and active
      and deleted_at is null
      and deletion_actor is null
    )
  );

create index if not exists resume_supplements_quarantine_age_idx
  on submissions_v2.resume_supplements (created_at, id)
  where quarantined;

commit;
