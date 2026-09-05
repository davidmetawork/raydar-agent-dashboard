create table submissions_v2.intake_receipts (
  kind text not null check (kind in ('reply','enrichment')),
  event_id text not null,
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  receipt_id uuid not null default gen_random_uuid(),
  result jsonb not null,
  received_at timestamptz not null default clock_timestamp(),
  primary key (kind,event_id)
);
create table submissions_v2.source_enrichments (
  enrichment_id text primary key,
  signal_id uuid not null references submissions_v2.source_events(id),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  contract_key text not null,
  contract_digest text not null,
  candidate_user_id text not null,
  ordered_role_ids jsonb not null,
  evidence jsonb not null,
  disposition text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index source_enrichments_signal_idx on submissions_v2.source_enrichments(signal_id,created_at);
create function submissions_v2.reject_source_evidence_mutation() returns trigger language plpgsql as $$
begin raise exception 'Source enrichment and intake receipts are immutable'; end $$;
create trigger source_enrichment_immutable before update or delete on submissions_v2.source_enrichments
  for each row execute function submissions_v2.reject_source_evidence_mutation();
create trigger intake_receipt_immutable before update or delete on submissions_v2.intake_receipts
  for each row execute function submissions_v2.reject_source_evidence_mutation();
