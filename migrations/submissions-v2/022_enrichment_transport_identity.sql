-- Bind both public transport identities before accepting enrichment. Opaque
-- identities and digests remain after case purge to prevent replay resurrection.
create table submissions_v2.enrichment_request_keys (
  event_key text primary key,
  enrichment_id text not null unique,
  request_digest text not null check(request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create trigger enrichment_request_key_immutable before update or delete
  on submissions_v2.enrichment_request_keys for each row
  execute function submissions_v2.reject_source_evidence_mutation();
do $$ begin
  if exists(select 1 from pg_roles where rolname='submissions_v2_api') then
    grant select,insert on submissions_v2.enrichment_request_keys to submissions_v2_api;
  end if;
end $$;
