-- The authenticated API records an attested, exact role only when a human
-- resolves a needs_role source. It must not receive mutation authority over
-- the immutable offered-role ledger after that insert.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'submissions_v2_api') then
    grant select, insert on submissions_v2.source_offered_roles to submissions_v2_api;
    revoke update, delete, truncate on submissions_v2.source_offered_roles from submissions_v2_api;
  end if;
end;
$$;
