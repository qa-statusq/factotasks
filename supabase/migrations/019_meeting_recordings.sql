-- =====================================================================
-- 019 — Meeting recordings
-- Run after 018. Everything here is also in supabase/schema.sql (master).
--  * meeting_recordings: a screen + mic recording of a presented meeting,
--    stored as a file in the team's Google Shared Drive (service account).
--    The panel keeps the Drive file id, size, duration and the upload state.
--  * recording_shares: e-mail addresses given read access on the Drive file
--    from the panel (one Drive permission each), so access can be listed
--    and withdrawn.
-- =====================================================================

create table if not exists meeting_recordings (
  id            uuid primary key default gen_random_uuid(),
  meeting_id    uuid not null references meetings(id) on delete cascade,
  name          text not null,
  mime          text not null default 'video/webm',
  size_bytes    bigint not null default 0,
  duration_sec  int,
  status        text not null default 'uploading' check (status in ('uploading','ready','failed')),
  drive_file_id text,                       -- set once Google has the whole file
  upload_uri    text,                       -- resumable session while uploading (server-side only)
  recorded_by   uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists meeting_recordings_meeting_idx on meeting_recordings (meeting_id, created_at desc);
drop trigger if exists meeting_recordings_touch on meeting_recordings;
create trigger meeting_recordings_touch before update on meeting_recordings for each row execute function touch_updated_at();
drop trigger if exists meeting_recordings_rev on meeting_recordings;
create trigger meeting_recordings_rev after insert or update or delete on meeting_recordings for each statement execute function bump_rev();

create table if not exists recording_shares (
  id            uuid primary key default gen_random_uuid(),
  recording_id  uuid not null references meeting_recordings(id) on delete cascade,
  email         text not null,
  permission_id text,                       -- Drive permission, removed on revoke
  message       text,
  shared_by     uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (recording_id, email)
);
create index if not exists recording_shares_recording_idx on recording_shares (recording_id, created_at);

alter table meeting_recordings enable row level security;
alter table recording_shares   enable row level security;
revoke all on meeting_recordings, recording_shares from anon, authenticated;
