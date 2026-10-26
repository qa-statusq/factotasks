-- =====================================================================
-- 021 — Meeting series: people, and closing meetings by themselves
-- Run after 020. Everything here is also in supabase/schema.sql (master).
--  * meeting_series_members: the team members who take part in a series.
--    They see that series' meetings (Meetings and Recordings screens), can
--    present, print, record and add tasks, change the status of their own
--    tasks, and watch its recordings — nothing more.
--  * meeting_series.auto_close: meetings of the series close by themselves
--    once their day (India) is over. meetings.auto_close overrides it for
--    one meeting (null = follow the series).
-- =====================================================================

alter table meeting_series add column if not exists auto_close boolean not null default true;
alter table meetings add column if not exists auto_close boolean;

create table if not exists meeting_series_members (
  series_id  uuid not null references meeting_series(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  added_by   uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (series_id, user_id)
);
create index if not exists meeting_series_members_user_idx on meeting_series_members (user_id);
alter table meeting_series_members enable row level security;
revoke all on meeting_series_members from anon, authenticated;
