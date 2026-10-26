-- =====================================================================
-- 020 — Task attachments live on the Google Shared Drive
-- Run after 019. Everything here is also in supabase/schema.sql (master).
--  * task_attachments.drive_file_id: the file on the Shared Drive (new
--    uploads). storage_path stays for files uploaded earlier into the
--    Supabase bucket; the panel serves both.
-- =====================================================================

alter table task_attachments add column if not exists drive_file_id text;
alter table task_attachments alter column storage_path drop not null;
