update submissions_v2.notification_outbox
   set state = 'held', safe_error_code = 'delivery_outcome_unknown',
       safe_error_detail = 'Delivery began before fenced notification leases were installed; operator review is required.'
 where state = 'sending';

alter table submissions_v2.notification_outbox
  add column lease_owner text,
  add column lease_expires_at timestamptz,
  add column fencing_token bigint not null default 0 check (fencing_token >= 0),
  add constraint notification_outbox_lease_check check (
    (state = 'sending' and lease_owner is not null and lease_expires_at is not null)
    or (state <> 'sending' and lease_owner is null and lease_expires_at is null)
  );

create index notification_outbox_sending_lease_idx
  on submissions_v2.notification_outbox (lease_expires_at, id)
  where state = 'sending';
