-- 030: Functions created from now on are not executable by everyone.
-- 026's `alter default privileges in schema public revoke execute ... from public`
-- cannot remove PostgreSQL's built-in EXECUTE-to-PUBLIC default (it is global per
-- creating role), so a function added by a later migration would again be callable
-- with the anon key. Revoke it for the role migrations run as (postgres), and keep
-- the server's service_role able to call everything. Existing functions were
-- already locked by 026. Safe to run more than once.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres grant execute on functions to service_role;
