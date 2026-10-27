-- =====================================================================
-- FactoTasks — FRESH INSTALL SCHEMA (single script, re-runnable).
--
-- Run this ONCE in the Supabase SQL editor of a NEW project. Every statement
-- is idempotent (`if not exists` / `create or replace`), so re-running it on
-- an existing database is safe and applies any additions without data loss.
--
-- Access model: the app talks to Postgres EXCLUSIVELY through the server with
-- the service_role key (BYPASSRLS). The anon/authenticated PostgREST roles are
-- never used by a client, so every table has RLS enabled with NO policies
-- (= deny-by-default) and every default grant is revoked — if the anon key
-- ever leaks, PostgREST returns nothing. See the LOCKDOWN section at the end.
-- =====================================================================

create extension if not exists pgcrypto;  -- gen_random_uuid()
create extension if not exists pg_trgm;   -- fast ILIKE search on task titles

-- ---------------------------------------------------------------------
-- Shared trigger: bump updated_at on every UPDATE.
-- ---------------------------------------------------------------------
create or replace function touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- TEAM
-- ---------------------------------------------------------------------
create table if not exists users (
  id                   uuid primary key default gen_random_uuid(),
  email                text not null unique,                 -- stored lower-cased
  password_hash        text not null,                        -- scrypt$salt$hash
  role                 text not null default 'member' check (role in ('admin','member')),
  first_name           text,
  last_name            text,
  -- Which part of the mobile team this person belongs to. Free-text `title`
  -- carries the exact designation ("Senior Android Developer").
  department           text not null default 'android'
                       check (department in ('android','ios','flutter','design','qa','backend','web','marketing','management','other')),
  title                text,
  -- Avatar hue (CSS hex). Assigned at invite time from a fixed palette so
  -- every teammate is distinguishable at a glance across the panel.
  color                text not null default '#4f46e5',
  -- Per-person UI preferences (layout, sort, ranges). Free-form, small (012).
  prefs                jsonb not null default '{}',
  is_active            boolean not null default true,        -- deactivated = cannot sign in, history kept
  must_change_password boolean not null default false,
  token_version        int not null default 0,               -- bump = every session of this user dies
  created_at           timestamptz not null default now(),
  last_login_at        timestamptz
);
alter table users add column if not exists prefs jsonb not null default '{}';

-- DB-backed login throttle + fixed-window rate limiter (serverless-safe).
-- key = "email:<addr>" | "ip:<addr>" | "rl:<action>:<identity>:<bucket>"
create table if not exists auth_throttle (
  key          text primary key,
  fails        int not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
create index if not exists auth_throttle_updated_idx on auth_throttle (updated_at);

-- Atomic "count this attempt and tell me the new total" — one round trip, and
-- a parallel burst can no longer slip past a cap (every caller sees its own
-- post-increment value).
create or replace function throttle_hit(p_key text)
returns bigint
language plpgsql
set search_path = public
as $$
declare n bigint;
begin
  insert into auth_throttle (key, fails, updated_at)
  values (p_key, 1, now())
  on conflict (key) do update set fails = auth_throttle.fails + 1, updated_at = now()
  returning fails into n;
  return n;
end;
$$;

-- Workspace-wide key/value settings (approval policy, meeting weekday, …).
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
-- `rev` is a change counter bumped by triggers on every content table. The
-- client polls ONE tiny row to learn "something changed since I last looked"
-- instead of re-fetching whole screens blindly.
insert into app_settings (key, value) values ('rev', '0'::jsonb) on conflict (key) do nothing;
insert into app_settings (key, value) values ('approval_policy', '{"mode":"done_only"}'::jsonb) on conflict (key) do nothing;

create or replace function bump_rev()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- `#>> '{}'` unwraps a JSON number OR a JSON string ("0") to plain text; a
  -- non-numeric value falls back to 0 instead of failing every content write
  -- (a bad counter must never block creating a task).
  update app_settings
     set value = to_jsonb(coalesce(nullif(regexp_replace(value #>> '{}', '\D', '', 'g'), '')::bigint, 0) + 1),
         updated_at = now()
   where key = 'rev';
  return null;
end;
$$;

-- Every action by every user — the admin's Activity screen + audit trail.
create table if not exists activity_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references users(id) on delete set null,
  user_email  text not null default 'system',  -- denormalized: survives user deletion
  action      text not null,                   -- "task.create", "task.approve", "user.invite", …
  entity_type text,                            -- task | app | release | meeting | user | settings
  entity_id   text,
  summary     text,
  metadata    jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);
create index if not exists activity_created_idx on activity_log (created_at desc, id desc);
create index if not exists activity_user_idx on activity_log (user_id, created_at desc);
create index if not exists activity_entity_idx on activity_log (entity_type, entity_id, created_at desc);

-- ---------------------------------------------------------------------
-- APPS (one row per product; an app can ship on Android AND iOS)
-- ---------------------------------------------------------------------
create table if not exists apps (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  description    text,
  kind           text not null default 'b2c' check (kind in ('b2c','b2b')),
  status         text not null default 'active' check (status in ('active','maintenance','archived')),
  has_android    boolean not null default true,
  has_ios        boolean not null default false,
  android_package text,                         -- com.example.app  → Play Store link
  ios_bundle_id  text,
  appstore_url   text,                          -- App Store needs the numeric id; stored as a full URL
  color          text not null default '#4f46e5',
  icon_url       text,                           -- store listing icon (Play / App Store), fetched automatically
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint apps_platform_chk check (has_android or has_ios)
);
alter table apps add column if not exists icon_url text; -- (001 → 002 upgrade path)
alter table apps add column if not exists sort_order int not null default 0; -- (014) hand-arranged order, Apps screen
alter table apps add column if not exists icon_android_url text; -- (016) Play listing icon
alter table apps add column if not exists icon_ios_url text;     -- (016) App Store artwork; icon_url = Android first, else iOS
create unique index if not exists apps_name_uq on apps (lower(name));
drop trigger if exists apps_touch on apps;
create trigger apps_touch before update on apps for each row execute function touch_updated_at();

-- Who works on which app (many-to-many) and in what capacity.
create table if not exists app_members (
  app_id     uuid not null references apps(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  app_role   text not null default 'developer'
             check (app_role in ('lead','developer','designer','qa','backend','marketing','other')),
  created_at timestamptz not null default now(),
  primary key (app_id, user_id)
);
create index if not exists app_members_user_idx on app_members (user_id);

-- ---------------------------------------------------------------------
-- RELEASES (version-wise, per platform)
-- ---------------------------------------------------------------------
create table if not exists releases (
  id           uuid primary key default gen_random_uuid(),
  app_id       uuid not null references apps(id) on delete cascade,
  platform     text not null check (platform in ('android','ios')),
  version_name text not null,                   -- "2.4.0"
  build_number text,                            -- versionCode / build
  status       text not null default 'planned'
               check (status in ('planned','in_progress','testing','submitted','released','rolled_back','cancelled')),
  planned_date date,
  released_at  timestamptz,
  description  text,                            -- what's in this version
  notes        text,                            -- internal notes / release notes
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (app_id, platform, version_name)
);
create index if not exists releases_app_idx on releases (app_id, platform, created_at desc);
-- A member asking for "released" under an approval policy parks a request here;
-- an admin approves it (release_review), which also closes the linked tasks.
alter table releases add column if not exists requested_status text check (requested_status in ('released'));
alter table releases add column if not exists requested_by uuid references users(id) on delete set null;
alter table releases add column if not exists requested_at timestamptz;
alter table releases add column if not exists request_note text;
create index if not exists releases_requested_idx on releases (requested_at) where requested_status is not null;
create index if not exists releases_released_idx on releases (released_at desc) where released_at is not null;
drop trigger if exists releases_touch on releases;
create trigger releases_touch before update on releases for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------
-- TASKS
-- ---------------------------------------------------------------------
create sequence if not exists task_number_seq;

create table if not exists tasks (
  id               uuid primary key default gen_random_uuid(),
  number           int not null default nextval('task_number_seq') unique, -- human id: T-123
  app_id           uuid references apps(id) on delete set null,          -- NULL = general task
  platform         text check (platform in ('android','ios','both')),    -- only for app tasks
  title            text not null,
  description      text,
  type             text not null default 'feature'
                   check (type in ('feature','bug','improvement','design','qa','release','research','marketing','other')),
  priority         text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  status           text not null default 'todo'
                   check (status in ('todo','in_progress','in_review','on_hold','partial','done','cancelled')),
  status_since     timestamptz not null default now(),   -- when the CURRENT status began
  -- Approval workflow: a member's status change waits here until an admin
  -- approves (status is applied) or rejects (cleared, with a reason).
  requested_status text check (requested_status in ('todo','in_progress','in_review','on_hold','partial','done','cancelled')),
  requested_by     uuid references users(id) on delete set null,
  requested_at     timestamptz,
  request_note     text,
  -- Time tracking (all server-side; the client never writes these):
  started_at       timestamptz,                 -- first time the task entered in_progress
  completed_at     timestamptz,                 -- when the work was finished (= request time if approved later)
  approved_at      timestamptz,                 -- when an admin approved "done"
  approved_by      uuid references users(id) on delete set null,
  active_seconds   bigint not null default 0,   -- total time spent IN in_progress (excluding the current stint)
  due_date         date,
  estimate_hours   numeric(6,2),
  labels           text[] not null default '{}',
  -- Denormalised from task_targets / task_assignees by triggers (009): lets
  -- lists filter "on my apps" / "unassigned" in SQL with a GIN index instead
  -- of shipping id lists around. '{}' = general task / nobody assigned.
  app_ids          uuid[] not null default '{}',
  assignee_ids     uuid[] not null default '{}',
  created_by       uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table tasks add column if not exists app_ids      uuid[] not null default '{}';
alter table tasks add column if not exists assignee_ids uuid[] not null default '{}';
create index if not exists tasks_app_ids_gin      on tasks using gin (app_ids);
create index if not exists tasks_assignee_ids_gin on tasks using gin (assignee_ids);
create index if not exists tasks_updated_id_idx on tasks (updated_at desc, id desc); -- (023) the default list order
create index if not exists tasks_created_id_idx on tasks (created_at desc, id desc); -- (023) sort=created
create index if not exists tasks_app_idx       on tasks (app_id, status);
create index if not exists tasks_creator_idx   on tasks (created_by);
create index if not exists tasks_due_idx       on tasks (due_date) where status not in ('done','cancelled');
create index if not exists tasks_requested_idx on tasks (requested_at) where requested_status is not null;
create index if not exists tasks_completed_idx on tasks (completed_at desc) where completed_at is not null;
create index if not exists tasks_created_idx   on tasks (created_at desc);
-- Upgrades from before 005: widen the status checks for 'partial' (partly released).
alter table tasks drop constraint if exists tasks_status_check;
alter table tasks add constraint tasks_status_check check (status in ('todo','in_progress','in_review','on_hold','partial','done','cancelled'));
alter table tasks drop constraint if exists tasks_requested_status_check;
alter table tasks add constraint tasks_requested_status_check check (requested_status in ('todo','in_progress','in_review','on_hold','partial','done','cancelled'));

-- Where a task ships: one row per app × platform it must land on. A fix for
-- "EPFO" across 4 Android apps and 2 iOS apps is one task with six targets,
-- each linked to its own release and released on its own date. tasks.app_id /
-- tasks.platform stay as a summary (the first app, and android/ios/both) for
-- grouping and older readers. A task with no targets is a general task.
create table if not exists task_targets (
  task_id     uuid not null references tasks(id) on delete cascade,
  app_id      uuid not null references apps(id) on delete cascade,
  platform    text not null check (platform in ('android','ios')),
  release_id  uuid references releases(id) on delete set null,
  released_at timestamptz,
  primary key (task_id, app_id, platform)
);
create index if not exists task_targets_app_idx     on task_targets (app_id, platform);
create index if not exists task_targets_release_idx on task_targets (release_id) where release_id is not null;
create index if not exists tasks_title_trgm    on tasks using gin (title gin_trgm_ops);
drop trigger if exists tasks_touch on tasks;
create trigger tasks_touch before update on tasks for each row execute function touch_updated_at();

create table if not exists task_assignees (
  task_id     uuid not null references tasks(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  assigned_by uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (task_id, user_id)
);
create index if not exists task_assignees_user_idx on task_assignees (user_id);

-- (023) Keep tasks.app_ids / tasks.assignee_ids in step with their tables — once per
-- statement over the rows it touched, not once per row (one UPDATE of tasks per
-- save instead of one per target or assignee, and one change-counter bump).
create or replace function task_sync_app_ids_stmt()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update tasks t set app_ids = coalesce((select array_agg(distinct x.app_id order by x.app_id) from task_targets x where x.task_id = t.id), '{}'::uuid[])
  where t.id in (select task_id from changed_rows);
  return null;
end;
$$;
drop trigger if exists task_targets_arrays on task_targets;
drop trigger if exists task_targets_arrays_ins on task_targets;
drop trigger if exists task_targets_arrays_upd on task_targets;
drop trigger if exists task_targets_arrays_del on task_targets;
create trigger task_targets_arrays_ins after insert on task_targets referencing new table as changed_rows for each statement execute function task_sync_app_ids_stmt();
create trigger task_targets_arrays_upd after update on task_targets referencing new table as changed_rows for each statement execute function task_sync_app_ids_stmt();
create trigger task_targets_arrays_del after delete on task_targets referencing old table as changed_rows for each statement execute function task_sync_app_ids_stmt();

create or replace function task_sync_assignee_ids_stmt()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update tasks t set assignee_ids = coalesce((select array_agg(distinct x.user_id order by x.user_id) from task_assignees x where x.task_id = t.id), '{}'::uuid[])
  where t.id in (select task_id from changed_rows);
  return null;
end;
$$;
drop trigger if exists task_assignees_arrays on task_assignees;
drop trigger if exists task_assignees_arrays_ins on task_assignees;
drop trigger if exists task_assignees_arrays_upd on task_assignees;
drop trigger if exists task_assignees_arrays_del on task_assignees;
create trigger task_assignees_arrays_ins after insert on task_assignees referencing new table as changed_rows for each statement execute function task_sync_assignee_ids_stmt();
create trigger task_assignees_arrays_upd after update on task_assignees referencing new table as changed_rows for each statement execute function task_sync_assignee_ids_stmt();
create trigger task_assignees_arrays_del after delete on task_assignees referencing old table as changed_rows for each statement execute function task_sync_assignee_ids_stmt();

-- Backfill once (idempotent).
update tasks t set app_ids = coalesce((select array_agg(distinct x.app_id order by x.app_id) from task_targets x where x.task_id = t.id), '{}'::uuid[])
where t.app_ids is distinct from coalesce((select array_agg(distinct x.app_id order by x.app_id) from task_targets x where x.task_id = t.id), '{}'::uuid[]);
update tasks t set assignee_ids = coalesce((select array_agg(distinct x.user_id order by x.user_id) from task_assignees x where x.task_id = t.id), '{}'::uuid[])
where t.assignee_ids is distinct from coalesce((select array_agg(distinct x.user_id order by x.user_id) from task_assignees x where x.task_id = t.id), '{}'::uuid[]);

-- Every status event: direct changes, requests, approvals, rejections.
create table if not exists task_status_log (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks(id) on delete cascade,
  kind        text not null check (kind in ('change','request','approve','reject','withdraw')),
  from_status text,
  to_status   text,
  actor_id    uuid references users(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists task_status_log_task_idx on task_status_log (task_id, created_at desc);

create table if not exists task_comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references tasks(id) on delete cascade,
  user_id    uuid references users(id) on delete set null,
  body       text not null,
  created_at timestamptz not null default now(),
  edited_at  timestamptz
);
create index if not exists task_comments_task_idx on task_comments (task_id, created_at);

create table if not exists task_attachments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references tasks(id) on delete cascade,
  uploaded_by  uuid references users(id) on delete set null,
  file_name    text not null,
  mime         text not null,
  size_bytes   int not null,
  storage_path text unique,                   -- object key in the private `attachments` bucket (uploads before 020)
  drive_file_id text,                         -- (020) the file on the Google Shared Drive (uploads since 020)
  width        int,
  height       int,
  created_at   timestamptz not null default now()
);
create index if not exists task_attachments_task_idx on task_attachments (task_id, created_at);

-- ---------------------------------------------------------------------
-- WEEKLY MEETINGS (MOM)
-- ---------------------------------------------------------------------
-- A series groups meetings of one kind ("Weekly sync", "FactoTime release
-- review"). The agenda window and carry-forward are computed WITHIN a series.
create table if not exists meeting_series (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  color      text not null default '#1c1c1a',
  app_ids    uuid[] not null default '{}',   -- default scope for new meetings in this series
  app_order  uuid[] not null default '{}',   -- presentation order of apps in this series' meetings (013)
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table meeting_series add column if not exists app_order uuid[] not null default '{}';
alter table meeting_series add column if not exists auto_close boolean not null default true; -- (021) meetings close by themselves after their day
create unique index if not exists meeting_series_name_idx on meeting_series (lower(name));
drop trigger if exists meeting_series_touch on meeting_series;
create trigger meeting_series_touch before update on meeting_series for each row execute function touch_updated_at();

-- Attached to a meeting series (010): the task joins that series' meetings
-- like an app task — pending until done, done in the window it finished. This
-- is the ONLY way a general (no-app) task reaches a meeting automatically.
-- (Added here, after meeting_series exists, because tasks is created earlier.)
alter table tasks add column if not exists series_id uuid references meeting_series(id) on delete set null;
create index if not exists tasks_series_idx on tasks (series_id) where series_id is not null;

create table if not exists meetings (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  held_at      timestamptz not null,
  series_id    uuid references meeting_series(id) on delete set null,
  app_ids      uuid[] not null default '{}',     -- scope: empty = every app
  notes        text,                            -- general minutes (free text)
  status       text not null default 'open' check (status in ('open','finalized')),
  finalized_at timestamptz,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists meetings_held_idx on meetings (held_at desc);
-- Upgrades from before 003: add the columns, and put old meetings in one series.
alter table meetings add column if not exists series_id uuid references meeting_series(id) on delete set null;
alter table meetings add column if not exists auto_close boolean; -- (021) per-meeting override; null = follow the series
alter table meetings add column if not exists app_ids uuid[] not null default '{}';
-- (024) General tasks join a meeting by attachment or by hand only, so the old per-scope switch is gone.
alter table meetings drop column if exists include_general;
alter table meeting_series drop column if exists include_general;
create unique index if not exists meetings_one_open_per_series on meetings (series_id) where status = 'open'; -- (023)
create index if not exists meetings_series_idx on meetings (series_id, held_at desc);
insert into meeting_series (name) select 'Weekly sync' where not exists (select 1 from meeting_series);
update meetings set series_id = (select id from meeting_series order by created_at limit 1) where series_id is null;
drop trigger if exists meetings_touch on meetings;
create trigger meetings_touch before update on meetings for each row execute function touch_updated_at();

-- A minute line: tied to a task (status remark, decision, blocker) or free-standing.
create table if not exists meeting_notes (
  id         uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  task_id    uuid references tasks(id) on delete cascade,
  user_id    uuid references users(id) on delete set null,   -- person the note concerns (optional)
  kind       text not null default 'note' check (kind in ('note','decision','action','blocker')),
  body       text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table meeting_notes add column if not exists link_url   text check (link_url is null or (length(link_url) <= 2000 and link_url ~* '^https?://'));  -- (018) a finding, doc or ticket behind the note
alter table meeting_notes add column if not exists link_label text check (link_label is null or length(link_label) <= 60);                             -- (018) button text; "Click here" when empty
create index if not exists meeting_notes_meeting_idx on meeting_notes (meeting_id, created_at);
create index if not exists meeting_notes_task_idx on meeting_notes (task_id, created_at desc) where task_id is not null;
drop trigger if exists meeting_notes_touch on meeting_notes;
create trigger meeting_notes_touch before update on meeting_notes for each row execute function touch_updated_at();

-- (019) Recordings of presented meetings (files on the Google Shared Drive) and who they were shared with.
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

-- (021) The team members who take part in a series: they see its meetings and recordings,
-- present / print / record / add tasks and move their own tasks; the rest stays with admins.
create table if not exists meeting_series_members (
  series_id  uuid not null references meeting_series(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  added_by   uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (series_id, user_id)
);
create index if not exists meeting_series_members_user_idx on meeting_series_members (user_id);
drop trigger if exists meeting_series_members_rev on meeting_series_members;
create trigger meeting_series_members_rev after insert or update or delete on meeting_series_members for each statement execute function bump_rev();

-- Tasks pinned to a meeting by hand, regardless of app or date. A task can
-- sit in any number of meetings.
create table if not exists meeting_tasks (
  meeting_id uuid not null references meetings(id) on delete cascade,
  task_id    uuid not null references tasks(id) on delete cascade,
  added_by   uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (meeting_id, task_id)
);
create index if not exists meeting_tasks_task_idx on meeting_tasks (task_id);

-- ---------------------------------------------------------------------
-- IN-APP NOTIFICATIONS
-- ---------------------------------------------------------------------
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  kind       text not null,          -- task.assigned | task.requested | task.approved | task.rejected | task.comment | task.due | release.*
  task_id    uuid references tasks(id) on delete cascade,
  actor_id   uuid references users(id) on delete set null,
  message    text not null,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on notifications (user_id) where read_at is null;

-- Browser push subscriptions (Web Push / VAPID). One row per browser.
create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used  timestamptz
);
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);

-- ---------------------------------------------------------------------
-- CHANGE COUNTER triggers (see app_settings.rev)
-- ---------------------------------------------------------------------
drop trigger if exists tasks_rev on tasks;
create trigger tasks_rev after insert or update or delete on tasks for each statement execute function bump_rev();
drop trigger if exists task_assignees_rev on task_assignees;
create trigger task_assignees_rev after insert or update or delete on task_assignees for each statement execute function bump_rev();
drop trigger if exists task_comments_rev on task_comments;
create trigger task_comments_rev after insert or update or delete on task_comments for each statement execute function bump_rev();
drop trigger if exists task_attachments_rev on task_attachments;
create trigger task_attachments_rev after insert or update or delete on task_attachments for each statement execute function bump_rev();
drop trigger if exists releases_rev on releases;
create trigger releases_rev after insert or update or delete on releases for each statement execute function bump_rev();
drop trigger if exists meetings_rev on meetings;
create trigger meetings_rev after insert or update or delete on meetings for each statement execute function bump_rev();
drop trigger if exists meeting_notes_rev on meeting_notes;
create trigger meeting_notes_rev after insert or update or delete on meeting_notes for each statement execute function bump_rev();
drop trigger if exists task_targets_rev on task_targets;
create trigger task_targets_rev after insert or update or delete on task_targets for each statement execute function bump_rev();
drop trigger if exists meeting_series_rev on meeting_series;
create trigger meeting_series_rev after insert or update or delete on meeting_series for each statement execute function bump_rev();
drop trigger if exists meeting_tasks_rev on meeting_tasks;
create trigger meeting_tasks_rev after insert or update or delete on meeting_tasks for each statement execute function bump_rev();
drop trigger if exists apps_rev on apps;
create trigger apps_rev after insert or update or delete on apps for each statement execute function bump_rev();
-- (022) The rest of what a screen can show. users: only the columns a screen paints
-- (sign-ins and personal preferences would make every tab refetch for nothing);
-- notifications / activity_log: inserts only; app_settings: every row but the counter itself.
drop trigger if exists users_rev on users;
create trigger users_rev after insert or delete or update of role, first_name, last_name, department, title, color, is_active on users for each statement execute function bump_rev();
drop trigger if exists app_members_rev on app_members;
create trigger app_members_rev after insert or update or delete on app_members for each statement execute function bump_rev();
drop trigger if exists recording_shares_rev on recording_shares;
create trigger recording_shares_rev after insert or update or delete on recording_shares for each statement execute function bump_rev();
drop trigger if exists notifications_rev on notifications;
create trigger notifications_rev after insert on notifications for each statement execute function bump_rev();
-- (023) Entity-bound rows ride on their entity's own trigger; sign-ins, sign-outs
-- and the daily job change nothing a screen paints. Only standalone entries
-- (settings, arrange apps…) move the counter.
drop trigger if exists activity_log_rev on activity_log;
create trigger activity_log_rev after insert on activity_log for each row
  when (new.entity_type is null and new.action not like 'auth.%' and new.action not like 'cron.%')
  execute function bump_rev();
drop trigger if exists app_settings_rev on app_settings;
create trigger app_settings_rev after insert or update on app_settings for each row when (new.key <> 'rev' and new.key not like 'lease:%') execute function bump_rev();

-- =====================================================================
-- JSON SHAPES shared by every aggregate RPC below. The server returns these
-- verbatim, so the client sees ONE consistent card shape everywhere.
-- =====================================================================
create or replace function user_brief(u users)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'id', u.id,
    'name', coalesce(nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''), split_part(u.email, '@', 1)),
    'first_name', u.first_name,
    'last_name', u.last_name,
    'email', u.email,
    'color', u.color,
    'department', u.department,
    'is_active', u.is_active
  );
$$;


-- =====================================================================
-- VISIBILITY — a member's world is the apps they belong to. Admins see all.
-- (008: assigned/created tasks on other apps are no longer visible.)
-- =====================================================================
-- Apps a member belongs to.
create or replace function visible_app_ids(p_user uuid)
returns uuid[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(app_id), '{}'::uuid[]) from app_members where user_id = p_user;
$$;

-- (023) The visibility rule on a row, inlinable: p_user null = everything; otherwise
-- an app task on one of p_apps, or a general task the person is on or created.
create or replace function task_row_visible(t tasks, p_user uuid, p_apps uuid[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_user is null
      or (t.app_ids <> '{}'::uuid[] and t.app_ids && p_apps)
      or (t.app_ids = '{}'::uuid[] and (p_user = any(t.assignee_ids) or t.created_by = p_user));
$$;

-- A member sees an app task when it targets one of their apps, and a general
-- (no-app) task only when they are assigned to it or created it (011). Being
-- assigned to a task on an app you were taken off does not keep it visible
-- (the API un-assigns you at that point).
create or replace function task_visible(p_task uuid, p_user uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select task_row_visible(t, p_user, visible_app_ids(p_user)) from tasks t where t.id = p_task;
$$;

create or replace function visible_task_ids(p_user uuid)
returns setof uuid
language sql
stable
set search_path = public
as $$
  with va as (select visible_app_ids(p_user) as ids)
  select t.id from tasks t, va where task_row_visible(t, p_user, va.ids);
$$;

create or replace function task_card(t tasks)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', t.id,
    'number', t.number,
    'title', t.title,
    'description', left(t.description, 600),
    'status', t.status,
    'priority', t.priority,
    'type', t.type,
    'platform', t.platform,
    'due_date', t.due_date,
    'labels', to_jsonb(t.labels),
    'created_at', t.created_at,
    'updated_at', t.updated_at,
    'status_since', t.status_since,
    'started_at', t.started_at,
    'completed_at', t.completed_at,
    'approved_at', t.approved_at,
    'active_seconds', t.active_seconds,
    'estimate_hours', t.estimate_hours,
    'requested_status', t.requested_status,
    'requested_at', t.requested_at,
    'request_note', t.request_note,
    'requested_by', (select user_brief(u) from users u where u.id = t.requested_by),
    'app', (select jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url, 'has_android', a.has_android, 'has_ios', a.has_ios)
              from apps a where a.id = t.app_id),
    'series', (select jsonb_build_object('id', ms.id, 'name', ms.name, 'color', ms.color) from meeting_series ms where ms.id = t.series_id),
    'targets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'app', jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url),
        'platform', tt.platform,
        'release', (select jsonb_build_object('id', r.id, 'version_name', r.version_name, 'platform', r.platform, 'status', r.status, 'planned_date', r.planned_date)
                      from releases r where r.id = tt.release_id),
        'released_at', tt.released_at
      ) order by a.sort_order, a.name, tt.platform)
      from task_targets tt join apps a on a.id = tt.app_id where tt.task_id = t.id
    ), '[]'::jsonb),
    'release_progress', (select jsonb_build_object('released', count(*) filter (where tt.released_at is not null), 'total', count(*))
                           from task_targets tt where tt.task_id = t.id),
    'assignees', coalesce((select jsonb_agg(user_brief(u) order by u.first_name, u.email)
                             from task_assignees ta join users u on u.id = ta.user_id
                            where ta.task_id = t.id), '[]'::jsonb),
    'created_by', (select user_brief(u) from users u where u.id = t.created_by),
    'comment_count', (select count(*) from task_comments c where c.task_id = t.id),
    'attachment_count', (select count(*) from task_attachments x where x.task_id = t.id)
  );
$$;

-- =====================================================================
-- STATUS TRANSITIONS — atomic, with time tracking and the audit log, so the
-- server never does a read-modify-write that two concurrent clicks can race.
-- =====================================================================

-- Apply a status (direct change by an admin/owner, or an approval). Returns the
-- updated row. p_completed_at lets an APPROVAL back-date completion to when the
-- member actually finished (their request time) rather than when the admin
-- clicked approve.
create or replace function task_apply_status(
  p_task uuid, p_to text, p_actor uuid, p_kind text, p_note text default null, p_completed_at timestamptz default null
)
returns tasks
language plpgsql
set search_path = public
as $$
declare
  t tasks;
  n timestamptz := now();
  old_status text;
  active bigint;
  started timestamptz;
  completed timestamptz;
  approved timestamptz;
  approver uuid;
begin
  select * into t from tasks where id = p_task for update;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  old_status := t.status;
  active := t.active_seconds;
  started := t.started_at;
  completed := t.completed_at;
  approved := t.approved_at;
  approver := t.approved_by;

  -- An approval applies THE request on the row, under the lock: if it was
  -- withdrawn, superseded or already decided, this call is stale.
  if p_kind = 'approve' and t.requested_status is distinct from p_to then
    raise exception 'request changed' using errcode = 'P0003';
  end if;
  if p_kind = 'approve' and p_completed_at is null then
    p_completed_at := t.requested_at;
  end if;

  if p_to <> old_status then
    -- Leaving in_progress: bank the stint that just ended.
    if old_status = 'in_progress' then
      active := active + greatest(0, extract(epoch from (n - t.status_since)))::bigint;
    end if;
    if p_to = 'in_progress' and started is null then
      started := n;
    end if;
    if p_to = 'done' then
      completed := coalesce(p_completed_at, n);
      approved := n;
      approver := p_actor;
    elsif old_status = 'done' then
      -- Reopened: the completion no longer stands.
      completed := null;
      approved := null;
      approver := null;
    end if;
  end if;

  update tasks set
    status = p_to,
    status_since = case when p_to <> old_status then n else status_since end,
    active_seconds = active,
    started_at = started,
    completed_at = completed,
    approved_at = approved,
    approved_by = approver,
    requested_status = null, requested_by = null, requested_at = null, request_note = null
  where id = p_task
  returning * into t;

  insert into task_status_log (task_id, kind, from_status, to_status, actor_id, note)
  values (p_task, p_kind, old_status, p_to, p_actor, p_note);
  return t;
end;
$$;

-- A member asks for a status change that needs an admin's approval.
create or replace function task_request_status(p_task uuid, p_to text, p_actor uuid, p_note text default null)
returns tasks
language plpgsql
set search_path = public
as $$
declare t tasks; cur text;
begin
  select requested_status into cur from tasks where id = p_task for update;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  -- (023) The same request twice (a second tab, a retry) is one request.
  if cur = p_to then
    raise exception 'already requested' using errcode = 'P0005';
  end if;
  update tasks set
    requested_status = p_to, requested_by = p_actor, requested_at = now(), request_note = p_note
  where id = p_task
  returning * into t;
  insert into task_status_log (task_id, kind, from_status, to_status, actor_id, note)
  values (p_task, 'request', t.status, p_to, p_actor, p_note);
  return t;
end;
$$;

-- Admin rejects (kind='reject') or the requester withdraws (kind='withdraw').
create or replace function task_clear_request(p_task uuid, p_actor uuid, p_kind text, p_note text default null)
returns tasks
language plpgsql
set search_path = public
as $$
declare t tasks; req text;
begin
  select requested_status into req from tasks where id = p_task for update;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  -- (023) Nothing pending any more: it was approved, withdrawn or rejected a moment ago.
  if req is null then
    raise exception 'no pending request' using errcode = 'P0003';
  end if;
  update tasks set
    requested_status = null, requested_by = null, requested_at = null, request_note = null
  where id = p_task
  returning * into t;
  insert into task_status_log (task_id, kind, from_status, to_status, actor_id, note)
  values (p_task, p_kind, t.status, req, p_actor, p_note);
  return t;
end;
$$;

-- =====================================================================
-- AGGREGATES — each screen is ONE round trip returning a small JSON blob.
-- =====================================================================

-- Start of the current IST week (Monday 00:00 IST) as an absolute instant.
create or replace function ist_week_start()
returns timestamptz
language sql
stable
set search_path = public
as $$
  select (date_trunc('week', now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata';
$$;

create or replace function ist_today()
returns date
language sql
stable
set search_path = public
as $$
  select (now() at time zone 'Asia/Kolkata')::date;
$$;

-- urgent → 0 … low → 3, so every list can sort by priority the same way.
create or replace function priority_rank(p text)
returns int
language sql
immutable
set search_path = public
as $$
  select case p when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end;
$$;

-- Dashboard: my work + team pulse (+ the approval queue for admins).
create or replace function dashboard_pack(p_user uuid, p_admin boolean)
returns jsonb
language sql
stable
set search_path = public
as $$
  -- What this caller may see: everything for admins, their apps for members.
  with va as materialized (select case when p_admin then '{}'::uuid[] else visible_app_ids(p_user) end as ids),
  vis as (select t.* from tasks t, va where p_admin or task_row_visible(t, p_user, va.ids)),
  mine as (
    select t.* from vis t
    where exists (select 1 from task_assignees ta where ta.task_id = t.id and ta.user_id = p_user)
  ),
  open_mine as (select * from mine where status not in ('done','cancelled')),
  today as (select ist_today() as d)
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'my_open',        (select count(*) from open_mine),
      'my_in_progress', (select count(*) from open_mine where status = 'in_progress'),
      'my_due_week',    (select count(*) from open_mine, today where due_date >= today.d and due_date < today.d + 7),
      'my_overdue',     (select count(*) from open_mine, today where due_date < today.d),
      'my_awaiting',    (select count(*) from mine where requested_status is not null),
      'my_done_week',   (select count(*) from mine where completed_at >= ist_week_start()),
      'team_open',      (select count(*) from vis where status not in ('done','cancelled')),
      'team_in_progress', (select count(*) from vis where status = 'in_progress'),
      'team_on_hold',   (select count(*) from vis where status = 'on_hold'),
      'team_overdue',   (select count(*) from vis, today where status not in ('done','cancelled') and due_date < today.d),
      'team_done_week', (select count(*) from vis where completed_at >= ist_week_start()),
      'approvals',      case when p_admin then (select count(*) from tasks where requested_status is not null) else 0 end
    ),
    'my_tasks', coalesce((
      select jsonb_agg(task_card(t) order by priority_rank(t.priority), t.due_date nulls last, t.updated_at desc)
      from (select * from open_mine m
            order by priority_rank(m.priority), m.due_date nulls last, m.updated_at desc
            limit 60) t
    ), '[]'::jsonb),
    'approvals', case when p_admin then coalesce((
      select jsonb_agg(task_card(t) order by requested_at)
      from (select * from tasks where requested_status is not null order by requested_at limit 30) t
    ), '[]'::jsonb) else '[]'::jsonb end,
    'due_soon', coalesce((
      select jsonb_agg(task_card(t) order by due_date, number)
      from (select tk.* from vis tk, today
            where tk.status not in ('done','cancelled') and tk.due_date is not null and tk.due_date < today.d + 7
            order by tk.due_date, tk.number limit 30) t
    ), '[]'::jsonb),
    'recent_done', coalesce((
      select jsonb_agg(task_card(t) order by completed_at desc)
      from (select * from vis where status = 'done' and completed_at >= ist_week_start()
            order by completed_at desc limit 15) t
    ), '[]'::jsonb),
    'releases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'app', jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url),
        'platform', r.platform, 'version_name', r.version_name, 'status', r.status,
        'planned_date', r.planned_date, 'released_at', r.released_at
      ) order by coalesce(r.planned_date, (r.released_at at time zone 'Asia/Kolkata')::date) nulls last)
      from (select * from releases rr
            where (rr.status not in ('released','cancelled','rolled_back')
               or rr.released_at >= now() - interval '14 days')
              and (p_admin or rr.app_id = any(visible_app_ids(p_user)))
            order by rr.planned_date nulls last limit 12) r
      join apps a on a.id = r.app_id
    ), '[]'::jsonb)
  );
$$;

-- Apps list with live counts, members and the latest/next release per platform.
create or replace function apps_overview()
returns jsonb
language sql
stable
set search_path = public
as $$
  -- (023) Counters in one pass over tasks (GIN-indexable containment, not a scan per app).
  with per_app as (
    select x.app_id,
           count(*) filter (where t.status not in ('done','cancelled')) as open_tasks,
           count(*) filter (where t.status = 'in_progress') as in_progress,
           count(*) filter (where t.status not in ('done','cancelled') and t.due_date < ist_today()) as overdue,
           count(*) filter (where t.completed_at >= ist_week_start()) as done_week
    from tasks t cross join lateral unnest(t.app_ids) as x(app_id)
    group by x.app_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'name', a.name, 'description', a.description, 'kind', a.kind, 'status', a.status,
    'has_android', a.has_android, 'has_ios', a.has_ios,
    'android_package', a.android_package, 'ios_bundle_id', a.ios_bundle_id, 'appstore_url', a.appstore_url,
    'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url, 'created_at', a.created_at, 'updated_at', a.updated_at,
    'open_tasks',  coalesce(pa.open_tasks, 0),
    'in_progress', coalesce(pa.in_progress, 0),
    'overdue',     coalesce(pa.overdue, 0),
    'done_week',   coalesce(pa.done_week, 0),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user', user_brief(u), 'app_role', m.app_role) order by m.app_role, u.first_name)
      from app_members m join users u on u.id = m.user_id where m.app_id = a.id
    ), '[]'::jsonb),
    'latest_android', (select jsonb_build_object('id', r.id, 'version_name', r.version_name, 'released_at', r.released_at)
                         from releases r where r.app_id = a.id and r.platform = 'android' and r.status = 'released'
                        order by r.released_at desc nulls last limit 1),
    'latest_ios',     (select jsonb_build_object('id', r.id, 'version_name', r.version_name, 'released_at', r.released_at)
                         from releases r where r.app_id = a.id and r.platform = 'ios' and r.status = 'released'
                        order by r.released_at desc nulls last limit 1),
    'next_release',   (select jsonb_build_object('id', r.id, 'version_name', r.version_name, 'platform', r.platform,
                                                 'status', r.status, 'planned_date', r.planned_date)
                         from releases r where r.app_id = a.id and r.status not in ('released','cancelled','rolled_back')
                        order by r.planned_date nulls last, r.created_at limit 1)
  ) order by (a.status = 'archived'), a.sort_order, a.name), '[]'::jsonb)
  from apps a left join per_app pa on pa.app_id = a.id;
$$;

-- (014) Hand-arranged order of apps: ids in the order shown; anything not
-- listed keeps its place after them. Admin only (the API checks).
create or replace function apps_reorder(p_ids uuid[])
returns void
language sql
set search_path = public
as $$
  update apps a set sort_order = x.ord
  from unnest(p_ids) with ordinality as x(id, ord)
  where a.id = x.id;
$$;

-- (023) Merge a few preference keys into users.prefs atomically (null removes a key),
-- so two quick changes from the same person compose instead of overwriting each other.
create or replace function prefs_merge(p_user uuid, p_patch jsonb)
returns jsonb
language sql
set search_path = public
as $$
  update users
     set prefs = (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
                    from jsonb_each(coalesce(prefs, '{}'::jsonb) || p_patch) as e(k, v)
                   where jsonb_typeof(v) <> 'null')
   where id = p_user
   returning prefs;
$$;

-- (023) A task holds at most 25 attachments, enforced where two uploads at once cannot both slip past.
create or replace function task_attachments_cap()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform 1 from tasks where id = new.task_id for update;
  if (select count(*) from task_attachments where task_id = new.task_id) >= 25 then
    raise exception 'attachment limit' using errcode = 'P0006';
  end if;
  return new;
end;
$$;
drop trigger if exists task_attachments_cap on task_attachments;
create trigger task_attachments_cap before insert on task_attachments for each row execute function task_attachments_cap();

-- (023) Remove a person unless they are the last active admin — one statement under a lock.
create or replace function user_delete_guarded(p_id uuid)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  lock table users in share row exclusive mode;
  if exists (select 1 from users where id = p_id and role = 'admin' and is_active)
     and not exists (select 1 from users where role = 'admin' and is_active and id <> p_id) then
    return false;
  end if;
  delete from users where id = p_id;
  return found;
end;
$$;

-- (023) A short lease for jobs that must not overlap (two instances, a scheduler
-- retry): the first caller within p_ttl_sec gets true, the others false.
create or replace function cron_lease(p_name text, p_ttl_sec int)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  insert into app_settings (key, value) values ('lease:' || p_name, to_jsonb(now()))
  on conflict (key) do update set value = excluded.value, updated_at = now()
    where (app_settings.value #>> '{}')::timestamptz < now() - make_interval(secs => p_ttl_sec);
  return found;
end;
$$;

-- (016) Task numbers stay a straight series: once test rows are removed, the
-- next task continues from the highest number in use.
create or replace function task_sequence_reset()
returns bigint
language plpgsql
set search_path = public
as $$
begin
  lock table tasks in exclusive mode;
  return setval('task_number_seq', coalesce((select max(number) from tasks), 1), (select count(*) from tasks) > 0);
end;
$$;

-- (016) Close the gaps: renumber every task 1..n in creation order and
-- rewrite the T-numbers quoted in descriptions, comments, minutes, activity
-- and notifications. Run by hand, once; it returns how many tasks moved.
create or replace function tasks_renumber()
returns int
language plpgsql
set search_path = public
as $$
declare
  r record;
  moved int := 0;
begin
  lock table tasks in exclusive mode;   -- (023) nothing is created or renumbered meanwhile
  create temp table _renum (id uuid primary key, old_n int, new_n int) on commit drop;
  insert into _renum select id, number, row_number() over (order by created_at, number) from tasks;
  -- Only the number changes: no touch/bump triggers, no "recently updated" shuffle.
  alter table tasks disable trigger user;
  update tasks t set number = t.number + 1000000;   -- clear the way (never collides: numbers are far below)
  update tasks t set number = x.new_n from _renum x where x.id = t.id;
  alter table tasks enable trigger user;
  for r in select * from _renum where old_n <> new_n loop
    -- two phases ("T#") so T-44 → T-14 can never be re-mapped by the old T-14's rule
    update tasks set description = regexp_replace(description, '\mT-' || r.old_n || '\M', 'T#' || r.new_n, 'g') where description ~ ('\mT-' || r.old_n || '\M');
    update task_comments set body = regexp_replace(body, '\mT-' || r.old_n || '\M', 'T#' || r.new_n, 'g') where body ~ ('\mT-' || r.old_n || '\M');
    update meeting_notes set body = regexp_replace(body, '\mT-' || r.old_n || '\M', 'T#' || r.new_n, 'g') where body ~ ('\mT-' || r.old_n || '\M');
    update activity_log set summary = regexp_replace(summary, '\mT-' || r.old_n || '\M', 'T#' || r.new_n, 'g') where summary ~ ('\mT-' || r.old_n || '\M');
    update activity_log set metadata = jsonb_set(metadata, '{number}', to_jsonb(r.new_n)) where metadata->>'number' = r.old_n::text;
    update notifications set message = regexp_replace(message, '\mT-' || r.old_n || '\M', 'T#' || r.new_n, 'g') where message ~ ('\mT-' || r.old_n || '\M');
    moved := moved + 1;
  end loop;
  update tasks set description = replace(description, 'T#', 'T-') where description like '%T#%';
  update task_comments set body = replace(body, 'T#', 'T-') where body like '%T#%';
  update meeting_notes set body = replace(body, 'T#', 'T-') where body like '%T#%';
  update activity_log set summary = replace(summary, 'T#', 'T-') where summary like '%T#%';
  update notifications set message = replace(message, 'T#', 'T-') where message like '%T#%';
  perform task_sequence_reset();
  return moved;
end;
$$;

-- Team directory with workload per person.
create or replace function team_overview()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(
    user_brief(u) || jsonb_build_object(
      'role', u.role, 'title', u.title, 'created_at', u.created_at, 'last_login_at', u.last_login_at,
      'must_change_password', u.must_change_password,
      'open',        (select count(*) from task_assignees ta join tasks t on t.id = ta.task_id where ta.user_id = u.id and t.status not in ('done','cancelled')),
      'in_progress', (select count(*) from task_assignees ta join tasks t on t.id = ta.task_id where ta.user_id = u.id and t.status = 'in_progress'),
      'overdue',     (select count(*) from task_assignees ta join tasks t on t.id = ta.task_id where ta.user_id = u.id and t.status not in ('done','cancelled') and t.due_date < ist_today()),
      'done_week',   (select count(*) from task_assignees ta join tasks t on t.id = ta.task_id where ta.user_id = u.id and t.completed_at >= ist_week_start()),
      'apps', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url, 'app_role', m.app_role) order by a.sort_order, a.name)
                          from app_members m join apps a on a.id = m.app_id where m.user_id = u.id), '[]'::jsonb)
    ) order by (not u.is_active), u.department, u.first_name, u.email
  ), '[]'::jsonb)
  from users u;
$$;

-- The weekly meeting pack: everything the MOM / presentation view shows, in one
-- call. Window = (previous meeting's held_at, this meeting's held_at] — and
-- while the meeting is still OPEN the end of the window is max(held_at, now()),
-- so a meeting created today shows everything up to this minute. For the very
-- first meeting the window is the 7 days before it. "Carried" = how many
-- EARLIER meetings this still-pending task has already been through.
create or replace function meeting_pack(p_meeting uuid, p_user uuid default null)
returns jsonb
language sql
stable
set search_path = public
as $$
  with m as (select * from meetings where id = p_meeting),
  -- (023) p_user null = an admin's full view; otherwise the member's: only the tasks,
  -- releases and apps they may see, no per-person workload, no approvals queue.
  va as (select case when p_user is null then '{}'::uuid[] else visible_app_ids(p_user) end as ids),
  -- The previous meeting of the SAME series (null series = its own series).
  -- Windows tile on CLOSE instants: a meeting's window runs from when the
  -- previous one was closed (its held_at if still open) to its own close
  -- (now, while it is open), so work done during the meeting stays in it.
  prev as (
    select coalesce(mm.finalized_at, mm.held_at) as held_at from meetings mm, m
    where mm.id <> m.id and mm.held_at < m.held_at and mm.series_id is not distinct from m.series_id
    order by mm.held_at desc limit 1
  ),
  win as (
    select coalesce((select held_at from prev), (select held_at from m) - interval '7 days') as from_at,
           case when (select status from m) = 'finalized' then coalesce((select finalized_at from m), (select held_at from m)) else greatest((select held_at from m), now()) end as to_at,
           (select status from m) as mstatus
  ),
  -- For an OPEN meeting the "as of" instant is NOW (live view); for a finalized
  -- one it is the meeting time, so history never drifts after the fact.
  asof as (select to_at as at, (to_at at time zone 'Asia/Kolkata')::date as today from win),
  -- In scope: app tasks the scope covers, plus any task attached to this
  -- series. General tasks join only by attachment or by being pinned.
  -- (017) An OPEN meeting follows its series' CURRENT scope — an app added to
  -- the series joins the running meeting; a closed one keeps the scope it was
  -- closed with (the API snapshots it on close).
  scope as (
    select sc.app_ids, cardinality(sc.app_ids) = 0 as all_apps, m.series_id
    from m left join meeting_series ms on ms.id = m.series_id,
    lateral (select case when m.status = 'finalized' or ms.id is null then m.app_ids else ms.app_ids end as app_ids) sc
  ),
  pinned as (select task_id from meeting_tasks where meeting_id = p_meeting),
  carried as (
    select t.id,
      (select count(*) from meetings mm, m
         where mm.id <> m.id and mm.held_at < m.held_at and mm.series_id is not distinct from m.series_id
           and mm.held_at >= t.created_at
           and (t.completed_at is null or t.completed_at > mm.held_at)) as carry
    from tasks t
    where t.status not in ('done','cancelled')   -- only pending rows need a carry count
  ),
  -- Each task is carded ONCE here; the derived sets below are id lists over these rows.
  pending as (
    select t.id, t.number, t.status, t.due_date, t.created_at, t.app_ids, t.assignee_ids,
           task_card(t) as card, c.carry, (t.id in (select task_id from pinned)) as pinned
    from tasks t join carried c on c.id = t.id, win, asof, scope s, va
    where (((t.app_ids <> '{}'::uuid[] and (s.all_apps or t.app_ids && s.app_ids)) or (t.series_id is not null and t.series_id = s.series_id)) or t.id in (select task_id from pinned))
      and t.created_at <= asof.at
      and t.status not in ('done','cancelled')
      and (t.completed_at is null or t.completed_at > asof.at)
      and task_row_visible(t, p_user, va.ids)
  ),
  done as (
    select t.id, t.number, t.completed_at, t.app_ids, t.assignee_ids,
           task_card(t) as card, (t.id in (select task_id from pinned)) as pinned
    from tasks t, win, scope s, va
    where t.status = 'done'
      and ((t.completed_at > win.from_at and t.completed_at <= win.to_at and ((t.app_ids <> '{}'::uuid[] and (s.all_apps or t.app_ids && s.app_ids)) or (t.series_id is not null and t.series_id = s.series_id)))
           or t.id in (select task_id from pinned))
      and task_row_visible(t, p_user, va.ids)
  ),
  cards as (select id, number, card from pending union all select id, number, card from done),
  notes as (
    select n.*, user_brief(cu) as author, (select user_brief(uu) from users uu where uu.id = n.user_id) as about
    from meeting_notes n left join users cu on cu.id = n.created_by, va
    where n.meeting_id = p_meeting
      and (n.task_id is null or exists (select 1 from tasks t where t.id = n.task_id and task_row_visible(t, p_user, va.ids)))
  )
  select jsonb_build_object(
    'meeting', (select jsonb_build_object('id', m.id, 'title', m.title, 'held_at', m.held_at, 'notes', m.notes,
                                          'status', m.status, 'finalized_at', m.finalized_at,
                                          'series_id', m.series_id, 'app_ids', to_jsonb(m.app_ids), 'auto_close', m.auto_close) from m),
    'series', (select jsonb_build_object('id', s.id, 'name', s.name, 'color', s.color, 'app_order', to_jsonb(s.app_order), 'auto_close', s.auto_close) from meeting_series s, m where s.id = m.series_id),
    'window', (select jsonb_build_object('from', from_at, 'to', to_at) from win),
    'previous_meeting', (select held_at from prev),
    'pinned', coalesce((select jsonb_agg(task_id) from pinned), '[]'::jsonb),
    'done', coalesce((
      select jsonb_agg(d.card || jsonb_build_object('pinned', d.pinned) order by d.completed_at desc)
      from done d
    ), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(p.card || jsonb_build_object('carry', p.carry, 'pinned', p.pinned) order by p.pinned desc, p.carry desc, p.due_date nulls last, p.number)
      from pending p
    ), '[]'::jsonb),
    -- Id lists: the screens count them and mark rows by id; the cards sit in `pending`.
    'carried', coalesce((select jsonb_agg(p.id order by p.carry desc, p.due_date nulls last, p.number) from pending p where p.carry > 0), '[]'::jsonb),
    'new', coalesce((select jsonb_agg(p.id order by p.created_at desc) from pending p, win where p.carry = 0 and p.created_at > win.from_at), '[]'::jsonb),
    'overdue', coalesce((select jsonb_agg(p.id order by p.due_date, p.number) from pending p, asof where p.due_date < asof.today), '[]'::jsonb),
    'approvals', case when p_user is null then coalesce((
      select jsonb_agg(task_card(t) order by t.requested_at)
      from tasks t, scope s where t.requested_status is not null and ((t.app_ids <> '{}'::uuid[] and (s.all_apps or t.app_ids && s.app_ids)) or (t.series_id is not null and t.series_id = s.series_id))
    ), '[]'::jsonb) else '[]'::jsonb end,
    'releases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'app', jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url),
        'platform', r.platform, 'version_name', r.version_name, 'build_number', r.build_number,
        'status', r.status, 'planned_date', r.planned_date, 'released_at', r.released_at, 'description', r.description,
        -- The version's tasks: the card already built when the task is on this meeting, built here otherwise.
        'tasks', coalesce((select jsonb_agg(coalesce(c.card, task_card(t)) order by t.number)
                             from tasks t left join cards c on c.id = t.id
                            where exists (select 1 from task_targets tt where tt.task_id = t.id and tt.release_id = r.id)
                              and task_row_visible(t, p_user, va.ids)), '[]'::jsonb)
      ) order by (r.status = 'released'), coalesce(r.planned_date, (r.released_at at time zone 'Asia/Kolkata')::date) nulls last)
      from releases r join apps a on a.id = r.app_id, win, scope s, va
      where (s.all_apps or r.app_id = any(s.app_ids))
        and (p_user is null or r.app_id = any(va.ids))
        and (
          -- (017) shipped: the release day (IST) falls inside the window, or the
          -- version carries a task that is on this meeting — so a task shown as
          -- released always has its version on the Releases slide
          (r.status = 'released'
             and (((r.released_at at time zone 'Asia/Kolkata')::date >= (win.from_at at time zone 'Asia/Kolkata')::date
                   and (r.released_at at time zone 'Asia/Kolkata')::date <= (win.to_at at time zone 'Asia/Kolkata')::date)
                  or exists (select 1 from task_targets tt where tt.release_id = r.id and tt.task_id in (select id from cards))))
          -- (017) under test right now; planned and in-progress versions wait until they reach testing
          or r.status = 'testing'
        )
    ), '[]'::jsonb),
    -- Per-person workload is a lead's view.
    'people', case when p_user is null then coalesce((
      select jsonb_agg(user_brief(u) || jsonb_build_object(
        'done', (select count(*) from done d where u.id = any(d.assignee_ids)),
        'pending', (select count(*) from pending p where u.id = any(p.assignee_ids)),
        'in_progress', (select count(*) from pending p where u.id = any(p.assignee_ids) and p.status = 'in_progress'),
        'carried', (select count(*) from pending p where u.id = any(p.assignee_ids) and p.carry > 0),
        'overdue', (select count(*) from pending p, asof where u.id = any(p.assignee_ids) and p.due_date < asof.today)
      ) order by u.department, u.first_name, u.email)
      from users u where u.is_active
    ), '[]'::jsonb) else '[]'::jsonb end,
    'apps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url, 'has_android', a.has_android, 'has_ios', a.has_ios,
        'done', (select count(*) from done d where a.id = any(d.app_ids)),
        'pending', (select count(*) from pending p where a.id = any(p.app_ids)),
        'carried', (select count(*) from pending p where a.id = any(p.app_ids) and p.carry > 0)
      ) order by a.sort_order, a.name)
      from apps a, scope s, va where a.status <> 'archived' and (s.all_apps or a.id = any(s.app_ids)) and (p_user is null or a.id = any(va.ids))
    ), '[]'::jsonb),
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id, 'task_id', n.task_id, 'kind', n.kind, 'body', n.body, 'created_at', n.created_at,
        'link_url', n.link_url, 'link_label', n.link_label,
        'author', n.author, 'about', n.about,
        'task', (select jsonb_build_object('id', t.id, 'number', t.number, 'title', t.title, 'status', t.status) from tasks t where t.id = n.task_id)
      ) order by n.created_at)
      from notes n
    ), '[]'::jsonb)
  );
$$;

-- (023) The task ids on a meeting's agenda (pending + done in its window, pinned ones
-- included) without building a single card — the Tasks screen's "Meeting" filter.
create or replace function meeting_task_ids(p_meeting uuid)
returns setof uuid
language sql
stable
set search_path = public
as $$
  with m as (select * from meetings where id = p_meeting),
  prev as (
    select coalesce(mm.finalized_at, mm.held_at) as held_at from meetings mm, m
    where mm.id <> m.id and mm.held_at < m.held_at and mm.series_id is not distinct from m.series_id
    order by mm.held_at desc limit 1
  ),
  win as (
    select coalesce((select held_at from prev), (select held_at from m) - interval '7 days') as from_at,
           case when (select status from m) = 'finalized' then coalesce((select finalized_at from m), (select held_at from m)) else greatest((select held_at from m), now()) end as to_at
  ),
  scope as (
    select sc.app_ids, cardinality(sc.app_ids) = 0 as all_apps, m.series_id
    from m left join meeting_series ms on ms.id = m.series_id,
    lateral (select case when m.status = 'finalized' or ms.id is null then m.app_ids else ms.app_ids end as app_ids) sc
  ),
  pinned as (select task_id from meeting_tasks where meeting_id = p_meeting)
  select t.id from tasks t, win, scope s
  where (((t.app_ids <> '{}'::uuid[] and (s.all_apps or t.app_ids && s.app_ids)) or (t.series_id is not null and t.series_id = s.series_id)) or t.id in (select task_id from pinned))
    and ((t.status not in ('done','cancelled') and t.created_at <= win.to_at and (t.completed_at is null or t.completed_at > win.to_at))
         or (t.status = 'done' and t.completed_at > win.from_at and t.completed_at <= win.to_at)
         or t.id in (select task_id from pinned)
         or t.requested_status is not null);
$$;

-- Reports: throughput + durations over a date range (IST calendar days).
drop function if exists report_pack(date, date);
create or replace function report_pack(p_from date, p_to date, p_user uuid default null)
returns jsonb
language sql
stable
set search_path = public
as $$
  with bounds as (
    select (p_from::timestamp at time zone 'Asia/Kolkata') as from_at,
           ((p_to + 1)::timestamp at time zone 'Asia/Kolkata') as to_at
  ),
  -- p_user null = the whole team (admins); otherwise only what that member may see.
  va as materialized (select case when p_user is null then '{}'::uuid[] else visible_app_ids(p_user) end as ids),
  vis as (select t.* from tasks t, va where task_row_visible(t, p_user, va.ids)),
  done as (
    select t.* from vis t, bounds b where t.status = 'done' and t.completed_at >= b.from_at and t.completed_at < b.to_at
  ),
  created as (
    select t.* from vis t, bounds b where t.created_at >= b.from_at and t.created_at < b.to_at
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'totals', jsonb_build_object(
      'created', (select count(*) from created),
      'done', (select count(*) from done),
      'open_now', (select count(*) from vis where status not in ('done','cancelled')),
      'avg_lead_hours', (select round(avg(extract(epoch from (completed_at - created_at)) / 3600)::numeric, 1) from done),
      'avg_active_hours', (select round(avg(active_seconds) / 3600.0, 1) from done),
      'median_lead_hours', (select round((percentile_cont(0.5) within group (order by extract(epoch from (completed_at - created_at)) / 3600))::numeric, 1) from done),
      'avg_approval_hours', (select round(avg(extract(epoch from (approved_at - completed_at)) / 3600)::numeric, 1) from done where approved_at is not null and completed_at is not null)
    ),
    'by_type', coalesce((select jsonb_object_agg(type, c) from (select type, count(*) c from done group by type) x), '{}'::jsonb),
    'by_priority', coalesce((select jsonb_object_agg(priority, c) from (select priority, count(*) c from done group by priority) x), '{}'::jsonb),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('date', d, 'done', dn, 'created', cr) order by d)
      from (
        -- generate_series over dates yields TIMESTAMPS; cast back so the JSON
        -- carries plain YYYY-MM-DD days (the client formats them as such).
        select g.d::date as d,
               (select count(*) from done where (completed_at at time zone 'Asia/Kolkata')::date = g.d::date) dn,
               (select count(*) from created where (created_at at time zone 'Asia/Kolkata')::date = g.d::date) cr
        from generate_series(p_from, p_to, interval '1 day') g(d)
      ) s
    ), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(user_brief(u) || jsonb_build_object(
        'done', (select count(*) from task_assignees ta join done d on d.id = ta.task_id where ta.user_id = u.id),
        'created', (select count(*) from created c where c.created_by = u.id),
        'open', (select count(*) from task_assignees ta join tasks t on t.id = ta.task_id where ta.user_id = u.id and t.status not in ('done','cancelled')),
        'avg_lead_hours', (select round(avg(extract(epoch from (d.completed_at - d.created_at)) / 3600)::numeric, 1)
                             from task_assignees ta join done d on d.id = ta.task_id where ta.user_id = u.id),
        'avg_active_hours', (select round(avg(d.active_seconds) / 3600.0, 1)
                               from task_assignees ta join done d on d.id = ta.task_id where ta.user_id = u.id)
      ) order by u.department, u.first_name, u.email)
      from users u where u.is_active and p_user is null
    ), '[]'::jsonb),
    'apps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'color', a.color,
        'done', (select count(*) from done d where a.id = any(d.app_ids)),
        'created', (select count(*) from created c where a.id = any(c.app_ids)),
        'open', (select count(*) from vis t where a.id = any(t.app_ids) and t.status not in ('done','cancelled')),
        'releases', (select count(*) from releases r, bounds b where r.app_id = a.id and r.released_at >= b.from_at and r.released_at < b.to_at)
      ) order by a.name)
      from apps a where a.status <> 'archived' and (p_user is null or a.id = any(visible_app_ids(p_user)))
    ), '[]'::jsonb)
  );
$$;

-- Analytics: month-wise throughput, per app and per person, plus the live
-- status mix. p_months = how many months back (incl. the current one).
drop function if exists analytics_pack(int);
drop function if exists analytics_pack(int, uuid);
-- (014) Analytics over an explicit IST date range. Periods are weeks for
-- short ranges and months from ~3 months up. p_user null = whole team.
create or replace function analytics_pack(p_from date, p_to date, p_user uuid default null)
returns jsonb
language sql
stable
set search_path = public
as $$
  with bounds as (
    select p_from as from_d, p_to as to_d,
           (p_from::timestamp at time zone 'Asia/Kolkata') as from_at,
           ((p_to + 1)::timestamp at time zone 'Asia/Kolkata') as to_at,
           case when p_to - p_from >= 84 then 'month' else 'week' end as bucket
  ),
  periods as (
    select case when b.bucket = 'month' then to_char(g, 'YYYY-MM') else to_char(g, 'YYYY-MM-DD') end as key,
           g::date as p_start,
           case when b.bucket = 'month' then (g + interval '1 month')::date else (g + interval '7 days')::date end as p_end
    from bounds b
    cross join lateral generate_series(
      case when b.bucket = 'month' then date_trunc('month', b.from_d::timestamp) else date_trunc('week', b.from_d::timestamp) end,
      b.to_d::timestamp,
      case when b.bucket = 'month' then interval '1 month' else interval '7 days' end
    ) g
  ),
  -- p_user null = the whole team (admins); otherwise only what that member may see.
  va as materialized (select case when p_user is null then '{}'::uuid[] else visible_app_ids(p_user) end as ids),
  vis as (select t.* from tasks t, va where task_row_visible(t, p_user, va.ids)),
  done as (
    select t.*, (t.completed_at at time zone 'Asia/Kolkata')::date as day,
           extract(epoch from (t.completed_at - t.created_at)) / 3600 as lead_h,
           (t.due_date is not null) as has_due,
           (t.due_date is not null and (t.completed_at at time zone 'Asia/Kolkata')::date <= t.due_date) as on_time
    from vis t, bounds b
    where t.status = 'done' and t.completed_at is not null and t.completed_at >= b.from_at and t.completed_at < b.to_at
  ),
  created as (
    select t.*, (t.created_at at time zone 'Asia/Kolkata')::date as day
    from vis t, bounds b where t.created_at >= b.from_at and t.created_at < b.to_at
  ),
  openx as (
    select t.*, (ist_today() - (t.created_at at time zone 'Asia/Kolkata')::date) as age_days
    from vis t where t.status not in ('done','cancelled')
  ),
  rel as (
    select r.*, (r.released_at at time zone 'Asia/Kolkata')::date as day
    from releases r, bounds b
    where r.status = 'released' and r.released_at >= b.from_at and r.released_at < b.to_at
      and (p_user is null or r.app_id = any(visible_app_ids(p_user)))
  ),
  held as (
    select m.* from meetings m, bounds b where m.held_at >= b.from_at and m.held_at < b.to_at
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'bucket', (select bucket from bounds)),
    'periods', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', pe.key, 'start', pe.p_start,
        'done', (select count(*) from done d where d.day >= pe.p_start and d.day < pe.p_end),
        'created', (select count(*) from created c where c.day >= pe.p_start and c.day < pe.p_end),
        'released', (select count(*) from rel r where r.day >= pe.p_start and r.day < pe.p_end),
        'avg_lead_hours', (select round(avg(d.lead_h)::numeric, 1) from done d where d.day >= pe.p_start and d.day < pe.p_end),
        'avg_active_hours', (select round(avg(d.active_seconds) / 3600.0, 1) from done d where d.day >= pe.p_start and d.day < pe.p_end)
      ) order by pe.p_start)
      from periods pe
    ), '[]'::jsonb),
    'by_app', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url,
        'done', (select count(*) from done d where a.id = any(d.app_ids)),
        'created', (select count(*) from created c where a.id = any(c.app_ids)),
        'open', (select count(*) from openx t where a.id = any(t.app_ids)),
        'in_progress', (select count(*) from openx t where a.id = any(t.app_ids) and t.status = 'in_progress'),
        'overdue', (select count(*) from openx t where a.id = any(t.app_ids) and t.due_date < ist_today()),
        'avg_lead_hours', (select round(avg(d.lead_h)::numeric, 1) from done d where a.id = any(d.app_ids)),
        'with_due', (select count(*) from done d where a.id = any(d.app_ids) and d.has_due),
        'on_time', (select count(*) from done d where a.id = any(d.app_ids) and d.on_time),
        'releases', (select count(*) from rel r where r.app_id = a.id),
        'periods', coalesce((select jsonb_object_agg(pe.key, (select count(*) from done d where a.id = any(d.app_ids) and d.day >= pe.p_start and d.day < pe.p_end)) from periods pe), '{}'::jsonb)
      ) order by a.sort_order, a.name)
      from apps a where a.status <> 'archived' and (p_user is null or a.id = any(visible_app_ids(p_user)))
    ), '[]'::jsonb),
    'general', jsonb_build_object(
      'done', (select count(*) from done d where d.app_ids = '{}'::uuid[]),
      'created', (select count(*) from created c where c.app_ids = '{}'::uuid[]),
      'open', (select count(*) from openx t where t.app_ids = '{}'::uuid[]),
      'in_progress', (select count(*) from openx t where t.app_ids = '{}'::uuid[] and t.status = 'in_progress'),
      'overdue', (select count(*) from openx t where t.app_ids = '{}'::uuid[] and t.due_date < ist_today()),
      'avg_lead_hours', (select round(avg(d.lead_h)::numeric, 1) from done d where d.app_ids = '{}'::uuid[]),
      'with_due', (select count(*) from done d where d.app_ids = '{}'::uuid[] and d.has_due),
      'on_time', (select count(*) from done d where d.app_ids = '{}'::uuid[] and d.on_time),
      'releases', 0,
      'periods', coalesce((select jsonb_object_agg(pe.key, (select count(*) from done d where d.app_ids = '{}'::uuid[] and d.day >= pe.p_start and d.day < pe.p_end)) from periods pe), '{}'::jsonb)
    ),
    'by_person', coalesce((
      select jsonb_agg(user_brief(u) || jsonb_build_object(
        'done', (select count(*) from done d where u.id = any(d.assignee_ids)),
        'created', (select count(*) from created c where c.created_by = u.id),
        'open', (select count(*) from openx t where u.id = any(t.assignee_ids)),
        'in_progress', (select count(*) from openx t where u.id = any(t.assignee_ids) and t.status = 'in_progress'),
        'overdue', (select count(*) from openx t where u.id = any(t.assignee_ids) and t.due_date < ist_today()),
        'avg_lead_hours', (select round(avg(d.lead_h)::numeric, 1) from done d where u.id = any(d.assignee_ids)),
        'with_due', (select count(*) from done d where u.id = any(d.assignee_ids) and d.has_due),
        'on_time', (select count(*) from done d where u.id = any(d.assignee_ids) and d.on_time),
        'periods', coalesce((select jsonb_object_agg(pe.key, (select count(*) from done d where u.id = any(d.assignee_ids) and d.day >= pe.p_start and d.day < pe.p_end)) from periods pe), '{}'::jsonb)
      ) order by u.department, u.first_name, u.email)
      from users u where u.is_active
    ), '[]'::jsonb),
    'status_now', coalesce((select jsonb_object_agg(status, c) from (select status, count(*) c from vis group by status) x), '{}'::jsonb),
    'type_mix', coalesce((
      select jsonb_object_agg(k, v) from (
        select type as k, jsonb_build_object('done', (select count(*) from done d where d.type = x.type), 'open', (select count(*) from openx o where o.type = x.type)) as v
        from (select distinct type from vis) x
      ) y
    ), '{}'::jsonb),
    'priority_mix', coalesce((
      select jsonb_object_agg(k, v) from (
        select priority as k, jsonb_build_object('done', (select count(*) from done d where d.priority = x.priority), 'open', (select count(*) from openx o where o.priority = x.priority)) as v
        from (select distinct priority from vis) x
      ) y
    ), '{}'::jsonb),
    'cycle_buckets', jsonb_build_array(
      jsonb_build_object('key', '<1d', 'n', (select count(*) from done where lead_h < 24)),
      jsonb_build_object('key', '1–3d', 'n', (select count(*) from done where lead_h >= 24 and lead_h < 72)),
      jsonb_build_object('key', '3–7d', 'n', (select count(*) from done where lead_h >= 72 and lead_h < 168)),
      jsonb_build_object('key', '1–2w', 'n', (select count(*) from done where lead_h >= 168 and lead_h < 336)),
      jsonb_build_object('key', '2–4w', 'n', (select count(*) from done where lead_h >= 336 and lead_h < 672)),
      jsonb_build_object('key', '>4w', 'n', (select count(*) from done where lead_h >= 672))
    ),
    'aging', jsonb_build_array(
      jsonb_build_object('key', '<7d', 'n', (select count(*) from openx where age_days < 7)),
      jsonb_build_object('key', '7–14d', 'n', (select count(*) from openx where age_days >= 7 and age_days < 14)),
      jsonb_build_object('key', '14–30d', 'n', (select count(*) from openx where age_days >= 14 and age_days < 30)),
      jsonb_build_object('key', '30–60d', 'n', (select count(*) from openx where age_days >= 30 and age_days < 60)),
      jsonb_build_object('key', '>60d', 'n', (select count(*) from openx where age_days >= 60))
    ),
    'oldest_open', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'number', t.number, 'title', t.title, 'status', t.status, 'priority', t.priority, 'age_days', t.age_days, 'due_date', t.due_date,
        'app', (select jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url) from apps a where a.id = t.app_ids[1]),
        'assignees', coalesce((select jsonb_agg(user_brief(u) order by u.first_name) from task_assignees ta join users u on u.id = ta.user_id where ta.task_id = t.id), '[]'::jsonb)
      ) order by t.age_days desc, t.number)
      from (select * from openx order by created_at limit 8) t
    ), '[]'::jsonb),
    'releases', jsonb_build_object(
      'released', (select count(*) from rel),
      'android', (select count(*) from rel where platform = 'android'),
      'ios', (select count(*) from rel where platform = 'ios'),
      'with_plan', (select count(*) from rel where planned_date is not null),
      'on_time', (select count(*) from rel where planned_date is not null and day <= planned_date),
      'avg_slip_days', (select round(avg(day - planned_date)::numeric, 1) from rel where planned_date is not null),
      'apps', (select count(distinct app_id) from rel),
      'pipeline', coalesce((select jsonb_object_agg(status, c) from (select status, count(*) c from releases r where r.status in ('planned','in_progress','testing','submitted') and (p_user is null or r.app_id = any(visible_app_ids(p_user))) group by status) x), '{}'::jsonb),
      'periods', coalesce((select jsonb_object_agg(pe.key, (select count(*) from rel r where r.day >= pe.p_start and r.day < pe.p_end)) from periods pe), '{}'::jsonb)
    ),
    'meetings', jsonb_build_object(
      'held', (select count(*) from held),
      'notes', (select count(*) from meeting_notes n where n.meeting_id in (select id from held)),
      'decisions', (select count(*) from meeting_notes n where n.kind = 'decision' and n.meeting_id in (select id from held)),
      'actions', (select count(*) from meeting_notes n where n.kind = 'action' and n.meeting_id in (select id from held)),
      'blockers', (select count(*) from meeting_notes n where n.kind = 'blocker' and n.meeting_id in (select id from held))
    ),
    'totals', jsonb_build_object(
      'done', (select count(*) from done),
      'created', (select count(*) from created),
      'cancelled', (select count(*) from vis t, bounds b where t.status = 'cancelled' and t.updated_at >= b.from_at and t.updated_at < b.to_at),
      'open_now', (select count(*) from openx),
      'wip_now', (select count(*) from openx where status in ('in_progress','in_review')),
      'blocked_now', (select count(*) from openx where status = 'on_hold'),
      'overdue_now', (select count(*) from openx where due_date < ist_today()),
      'with_due', (select count(*) from done where has_due),
      'on_time', (select count(*) from done where on_time),
      'median_lead_hours', (select round((percentile_cont(0.5) within group (order by lead_h))::numeric, 1) from done),
      'p90_lead_hours', (select round((percentile_cont(0.9) within group (order by lead_h))::numeric, 1) from done),
      'avg_active_hours', (select round(avg(active_seconds) / 3600.0, 1) from done),
      'avg_open_age_days', (select round(avg(age_days)::numeric, 1) from openx)
    )
  );
$$;

-- =====================================================================
-- LOCKDOWN — RLS on every table, no policies, PostgREST grants revoked.
-- =====================================================================
alter table users            enable row level security;
alter table auth_throttle    enable row level security;
alter table app_settings     enable row level security;
alter table activity_log     enable row level security;
alter table apps             enable row level security;
alter table app_members      enable row level security;
alter table releases         enable row level security;
alter table tasks            enable row level security;
alter table task_assignees   enable row level security;
alter table task_status_log  enable row level security;
alter table task_comments    enable row level security;
alter table task_attachments enable row level security;
alter table meetings         enable row level security;
alter table meeting_notes    enable row level security;
alter table task_targets     enable row level security;
alter table meeting_series   enable row level security;
alter table meeting_tasks    enable row level security;
alter table notifications    enable row level security;
alter table push_subscriptions enable row level security;
alter table meeting_recordings enable row level security;
alter table recording_shares   enable row level security;
alter table meeting_series_members enable row level security;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
