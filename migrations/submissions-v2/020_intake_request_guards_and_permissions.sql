-- Reserve an immutable request digest before private storage. This closes the
-- concurrent changed-body window between initial lookup and final receipt.
create table submissions_v2.intake_request_guards (
  event_id text primary key,
  mailbox_id text not null,
  provider_message_id text not null,
  request_digest text not null check(request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique(mailbox_id,provider_message_id)
);
create trigger intake_request_guard_immutable before update or delete on submissions_v2.intake_request_guards
  for each row execute function submissions_v2.reject_source_evidence_mutation();
do $$ begin
  if exists(select 1 from pg_roles where rolname='submissions_v2_api') then
    grant select,insert on submissions_v2.intake_request_guards,submissions_v2.intake_receipts,submissions_v2.source_enrichments to submissions_v2_api;
  end if;
end $$;
