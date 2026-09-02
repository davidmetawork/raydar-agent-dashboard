-- The worker validates its source lease inside repository transactions, so it
-- needs execute access to the pure source-to-control mapping helper.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'submissions_v2_worker') then
    grant execute on function submissions_v2.source_control_enabled(text, submissions_v2.runtime_controls)
      to submissions_v2_worker;
  end if;
end;
$$;
