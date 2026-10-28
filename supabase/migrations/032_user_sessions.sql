-- 032: Signed-in sessions, one row per sign-in. Profile → "Signed-in devices"
-- lists them and can end one, or every other one. Locked down like every table:
-- RLS on, no policies, no grants to anon/authenticated (only the server reads it).
-- Safe to run more than once. Existing sign-ins (tokens issued before this) keep
-- working and are ended by "Sign out of all other devices".
-- (032) One row per sign-in, so a person can see where they are signed in and
-- end one session without ending the others. The session token carries the
-- row's id; a revoked row (or one from an older token_version) no longer
-- verifies. Rows older than the 7-day token life are swept by the daily job.
create table if not exists user_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  token_version int not null default 0,
  user_agent    text,
  ip            text,
  created_at    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  revoked_at    timestamptz
);
create index if not exists user_sessions_user_idx on user_sessions (user_id, created_at desc);

alter table user_sessions enable row level security;
revoke all on user_sessions from anon, authenticated;
