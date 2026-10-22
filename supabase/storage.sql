-- =====================================================================
-- FactoTasks — attachment storage bucket. Run AFTER schema.sql.
--
-- One PRIVATE bucket. Nothing in it is ever served through a public URL:
-- the server issues short-lived signed URLs (10 minutes) per download, and
-- uploads go through /api/tasks/[id]/attachments (validated, size-capped,
-- image-downscaled), which writes with the service-role key.
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attachments', 'attachments', false,
  15728640, -- 15 MB hard cap per object (the API enforces the same number)
  array[
    'image/png','image/jpeg','image/webp','image/gif','image/svg+xml',
    'application/pdf','text/plain','text/csv','application/json',
    'application/zip','application/x-zip-compressed',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint',
    'video/mp4','video/quicktime','video/webm',
    'application/vnd.android.package-archive','application/octet-stream'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- No storage policies on purpose: with RLS on storage.objects (Supabase's
-- default) and zero policies, anon/authenticated cannot list, read or write a
-- single object. The service role bypasses RLS, which is the only writer.
