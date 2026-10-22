-- =====================================================================
-- Wipe the workspace back to a clean panel.
-- Keeps: the schema, app_settings (policy, workspace name) and ONE admin
-- account (admin@factohr.com — change the e-mail below if needed).
-- Removes: every app, task, release, meeting, series, note, comment,
-- attachment row, notification, activity entry, push device, lockout and
-- every other user. Task numbers restart at T-1.
--
-- Run ONCE in the Supabase SQL editor. There is no undo.
-- Attachment FILES in the storage bucket are not rows: empty the
-- "attachments" bucket from Storage → attachments → select all → delete.
-- =====================================================================
begin;

delete from notifications;
delete from activity_log;
delete from push_subscriptions;
delete from auth_throttle;
delete from meeting_notes;
delete from meeting_tasks;
delete from meetings;
delete from meeting_series;
delete from task_attachments;
delete from task_comments;
delete from task_status_log;
delete from task_assignees;
delete from task_targets;
delete from tasks;
delete from releases;
delete from app_members;
delete from apps;
delete from users where email <> 'admin@factohr.com';

-- Task numbering starts over, and the live-update counter with it.
alter sequence task_number_seq restart with 1;
update app_settings set value = '0'::jsonb where key = 'rev';

commit;

-- What is left (expect one row):
select email, role, is_active from users;
