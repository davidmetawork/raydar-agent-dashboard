alter table submissions_v2.download_audit
  drop constraint download_audit_result_check;
alter table submissions_v2.download_audit
  add constraint download_audit_result_check
  check (result in ('issued', 'completed', 'denied', 'failed'));
