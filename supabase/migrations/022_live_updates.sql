-- =====================================================================
-- 022 — Live updates reach every screen; admins are never stored as series people
-- Run after 021. Everything here is also in supabase/schema.sql (master).
--
-- Open tabs poll one change counter (app_settings.rev) and re-fetch what is on
-- screen when it moves. Until now only the content tables bumped it; these
-- did not, so a tab learned about them only on its next focus or navigation:
--  * meeting_series_members — a person added to a series sees Meetings appear
--    (and their meetings list fill) without signing in again
--  * users — a changed name / role / title / colour / deactivation reaches the
--    team screen, avatars and the nav of every open tab (sign-ins and personal
--    preferences do not count: they would make every tab refetch for nothing)
--  * app_members — app membership changes reach app screens and task lists
--  * recording_shares — a recording's sharing list stays current for every admin
--  * notifications — the bell catches reminders the daily job creates (inserts
--    only: marking as read is personal)
--  * activity_log — the activity screen follows the log as it is written
--  * app_settings — approval policy / meeting settings reach everyone (the
--    counter row itself is excluded, or the bump would trigger itself)
-- And admins take part in every series by default, so they are never kept in
-- the people list of one.
-- =====================================================================

drop trigger if exists meeting_series_members_rev on meeting_series_members;
create trigger meeting_series_members_rev after insert or update or delete on meeting_series_members for each statement execute function bump_rev();

drop trigger if exists users_rev on users;
create trigger users_rev after insert or delete or update of role, first_name, last_name, department, title, color, is_active on users for each statement execute function bump_rev();

drop trigger if exists app_members_rev on app_members;
create trigger app_members_rev after insert or update or delete on app_members for each statement execute function bump_rev();

drop trigger if exists recording_shares_rev on recording_shares;
create trigger recording_shares_rev after insert or update or delete on recording_shares for each statement execute function bump_rev();

drop trigger if exists notifications_rev on notifications;
create trigger notifications_rev after insert on notifications for each statement execute function bump_rev();

drop trigger if exists activity_log_rev on activity_log;
create trigger activity_log_rev after insert on activity_log for each statement execute function bump_rev();

drop trigger if exists app_settings_rev on app_settings;
create trigger app_settings_rev after insert or update on app_settings for each row when (new.key <> 'rev') execute function bump_rev();

delete from meeting_series_members m using users u where u.id = m.user_id and u.role = 'admin';
