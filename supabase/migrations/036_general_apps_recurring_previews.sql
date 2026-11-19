-- 036: General tasks can be about apps; weekly meetings that create themselves; document previews.
-- Safe to run more than once.

-- (036) A general task's apps: no platform, no version, never released. They put the task on
-- those apps (tasks.app_ids) like targets do: app members see it, those apps' meetings carry it.
create table if not exists task_general_apps (
  task_id uuid not null references tasks(id) on delete cascade,
  app_id  uuid not null references apps(id) on delete cascade,
  primary key (task_id, app_id)
);
create index if not exists task_general_apps_app_idx on task_general_apps (app_id);
alter table task_general_apps enable row level security;
drop trigger if exists task_general_apps_rev on task_general_apps;
create trigger task_general_apps_rev after insert or update or delete on task_general_apps for each statement execute function bump_rev();

create or replace function task_sync_app_ids_stmt()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- (036) The apps a task is on: where it ships (targets) and the apps a general task is about.
  update tasks t set app_ids = coalesce((select array_agg(distinct x.app_id order by x.app_id) from (select app_id from task_targets where task_id = t.id union select app_id from task_general_apps where task_id = t.id) x), '{}'::uuid[])
  where t.id in (select task_id from changed_rows);
  return null;
end;
$$;
drop trigger if exists task_general_apps_arrays_ins on task_general_apps;
drop trigger if exists task_general_apps_arrays_del on task_general_apps;
create trigger task_general_apps_arrays_ins after insert on task_general_apps referencing new table as changed_rows for each statement execute function task_sync_app_ids_stmt();
create trigger task_general_apps_arrays_del after delete on task_general_apps referencing old table as changed_rows for each statement execute function task_sync_app_ids_stmt();

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
    -- (036) A general task's apps (no platforms, never released).
    'general_apps', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url) order by a.sort_order, a.name)
      from task_general_apps g join apps a on a.id = g.app_id where g.task_id = t.id
    ), '[]'::jsonb),
    'assignees', coalesce((select jsonb_agg(user_brief(u) order by u.first_name, u.email)
                             from task_assignees ta join users u on u.id = ta.user_id
                            where ta.task_id = t.id), '[]'::jsonb),
    'created_by', (select user_brief(u) from users u where u.id = t.created_by),
    'comment_count', (select count(*) from task_comments c where c.task_id = t.id),
    'attachment_count', (select count(*) from task_attachments x where x.task_id = t.id)
  );
$$;

-- (036) Repeats: a weekly meeting the panel creates by itself the day before.
alter table meeting_series add column if not exists recur_weekday smallint check (recur_weekday between 1 and 7);
alter table meeting_series add column if not exists recur_time text check (recur_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
alter table meeting_series add column if not exists recur_last date;

-- (036) An office document's PDF preview, made once on first view and kept beside it.
alter table task_attachments add column if not exists preview_file_id text;
alter table meeting_attachments add column if not exists preview_file_id text;
