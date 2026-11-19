-- 035: A meeting's files carry a note (asked when they are added) and are grouped by
-- upload, so the meeting and its presentation list each upload as one item — its note
-- as the title, a paperclip that opens its files — like a task with attachments.
-- Safe to run more than once.
alter table meeting_attachments add column if not exists note text;
alter table meeting_attachments add column if not exists group_id uuid;
-- Files added before 035 each form their own item.
update meeting_attachments set group_id = id where group_id is null;
create index if not exists meeting_attachments_group_idx on meeting_attachments (meeting_id, group_id);
