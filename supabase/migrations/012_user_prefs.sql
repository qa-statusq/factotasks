-- =====================================================================
-- 012 — Per-person UI preferences
-- Run after 011. Everything here is also in supabase/schema.sql (master).
-- users.prefs holds small UI choices (tasks layout and sort, history
-- grouping, analytics range) so they follow a person to every device.
-- =====================================================================
alter table users add column if not exists prefs jsonb not null default '{}';
