-- 034: Files on a meeting, and a seek index for meeting recordings.
-- Safe to run more than once.

-- (034) A recording's seek index: where each keyframe cluster starts and at what time.
-- Browser-recorded WebM has none, so jumping deep into a long recording made players
-- read the whole file up to that point. Built once per recording by the panel.
alter table meeting_recordings add column if not exists seek_index jsonb;

-- (034) Files attached to a meeting (slides, specs, screenshots) — kept on the team's
-- Shared Drive like task files, shown on the meeting page and in its presentation.
create table if not exists meeting_attachments (
  id            uuid primary key default gen_random_uuid(),
  meeting_id    uuid not null references meetings(id) on delete cascade,
  uploaded_by   uuid references users(id) on delete set null,
  file_name     text not null,
  mime          text not null,
  size_bytes    bigint not null,
  drive_file_id text not null,
  width         int,
  height        int,
  created_at    timestamptz not null default now()
);
create index if not exists meeting_attachments_meeting_idx on meeting_attachments (meeting_id, created_at);
alter table meeting_attachments enable row level security;
drop trigger if exists meeting_attachments_rev on meeting_attachments;
create trigger meeting_attachments_rev after insert or update or delete on meeting_attachments for each statement execute function bump_rev();

-- (034) A meeting holds at most 25 files, enforced where two uploads at once cannot both slip past.
create or replace function meeting_attachments_cap()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform 1 from meetings where id = new.meeting_id for update;
  if (select count(*) from meeting_attachments where meeting_id = new.meeting_id) >= 25 then
    raise exception 'attachment limit' using errcode = 'P0006';
  end if;
  return new;
end;
$$;
drop trigger if exists meeting_attachments_cap on meeting_attachments;
create trigger meeting_attachments_cap before insert on meeting_attachments for each row execute function meeting_attachments_cap();
