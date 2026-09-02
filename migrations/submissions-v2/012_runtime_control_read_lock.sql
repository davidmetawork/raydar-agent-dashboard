-- Preserve the runtime-control transaction fence without granting deployment
-- roles direct UPDATE rights on the control singleton.

create or replace function submissions_v2.lock_runtime_controls()
returns submissions_v2.runtime_controls
language sql
security definer
set search_path = pg_catalog, submissions_v2
as $$
  select controls
    from submissions_v2.runtime_controls controls
   where controls.singleton = true
   for share
$$;

revoke all on function submissions_v2.lock_runtime_controls() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'submissions_v2_api') then
    grant execute on function submissions_v2.lock_runtime_controls() to submissions_v2_api;
  end if;
  if exists (select 1 from pg_roles where rolname = 'submissions_v2_worker') then
    grant execute on function submissions_v2.lock_runtime_controls() to submissions_v2_worker;
  end if;
end;
$$;
