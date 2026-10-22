-- =====================================================================
-- 005 — Task targets: one task, many app × platform releases
-- Run after 004. Everything here is also in supabase/schema.sql (master).
--
--  * task_targets      : where a task must ship (app × platform), each with its
--                        own release link and release date.
--  * tasks.status      : new value 'partial' = released on some targets, not all.
--  * task_card         : carries `targets` and `release_progress`.
--  * meeting_pack /    : scope, per-app counts and a release's tasks resolve
--    apps_overview       through targets, not the single tasks.app_id.
-- =====================================================================

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
-- Backfill from the old single app/platform/release columns. Idempotent; the
-- 005 migration calls it once, and the API keeps targets in sync from then on.
create or replace function task_targets_backfill()
returns void
language sql
set search_path = public
as $$
insert into task_targets (task_id, app_id, platform, release_id, released_at)
select t.id, t.app_id, p.platform,
       case when r.id is not null and r.platform = p.platform then r.id end,
       case when r.id is not null and r.platform = p.platform and r.status = 'released' then r.released_at end
from tasks t
join apps a on a.id = t.app_id
cross join lateral (
  select unnest(case
    when t.platform = 'android' then array['android']
    when t.platform = 'ios' then array['ios']
    else array_remove(array[case when a.has_android then 'android' end, case when a.has_ios then 'ios' end], null)
  end) as platform
) p
left join releases r on r.id = t.release_id
where t.app_id is not null
on conflict do nothing;
$$;
select task_targets_backfill();

drop trigger if exists task_targets_rev on task_targets;
create trigger task_targets_rev after insert or update or delete on task_targets for each statement execute function bump_rev();
alter table task_targets enable row level security;
revoke all on task_targets from anon, authenticated;

create or replace function task_targets_app(p_task uuid, p_app uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (select 1 from task_targets tt where tt.task_id = p_task and tt.app_id = p_app);
$$;

create or replace function task_targets_any(p_task uuid, p_apps uuid[])
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (select 1 from task_targets tt where tt.task_id = p_task and tt.app_id = any(p_apps));
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
    'app', (select jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'has_android', a.has_android, 'has_ios', a.has_ios)
              from apps a where a.id = t.app_id),
    'release', (select jsonb_build_object('id', r.id, 'version_name', r.version_name, 'platform', r.platform, 'status', r.status)
                  from releases r where r.id = t.release_id),
    'targets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'app', jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url),
        'platform', tt.platform,
        'release', (select jsonb_build_object('id', r.id, 'version_name', r.version_name, 'platform', r.platform, 'status', r.status, 'planned_date', r.planned_date)
                      from releases r where r.id = tt.release_id),
        'released_at', tt.released_at
      ) order by a.name, tt.platform)
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

create or replace function apps_overview()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'name', a.name, 'description', a.description, 'kind', a.kind, 'status', a.status,
    'has_android', a.has_android, 'has_ios', a.has_ios,
    'android_package', a.android_package, 'ios_bundle_id', a.ios_bundle_id, 'appstore_url', a.appstore_url,
    'color', a.color, 'icon_path', a.icon_path, 'icon_url', a.icon_url, 'created_at', a.created_at, 'updated_at', a.updated_at,
    'open_tasks',  (select count(*) from tasks t where task_targets_app(t.id, a.id) and t.status not in ('done','cancelled')),
    'in_progress', (select count(*) from tasks t where task_targets_app(t.id, a.id) and t.status = 'in_progress'),
    'overdue',     (select count(*) from tasks t where task_targets_app(t.id, a.id) and t.status not in ('done','cancelled') and t.due_date < ist_today()),
    'done_week',   (select count(*) from tasks t where task_targets_app(t.id, a.id) and t.completed_at >= ist_week_start()),
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
  ) order by (a.status = 'archived'), a.name), '[]'::jsonb)
  from apps a;
$$;

create or replace function meeting_pack(p_meeting uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  with m as (select * from meetings where id = p_meeting),
  -- The previous meeting of the SAME series (null series = its own series).
  prev as (
    select mm.held_at from meetings mm, m
    where mm.id <> m.id and mm.held_at < m.held_at and mm.series_id is not distinct from m.series_id
    order by mm.held_at desc limit 1
  ),
  win as (
    select coalesce((select held_at from prev), (select held_at from m) - interval '7 days') as from_at,
           case when (select status from m) = 'finalized' then (select held_at from m) else greatest((select held_at from m), now()) end as to_at,
           (select status from m) as mstatus
  ),
  -- For an OPEN meeting the "as of" instant is NOW (live view); for a finalized
  -- one it is the meeting time, so history never drifts after the fact.
  asof as (select to_at as at from win),
  scope as (select app_ids, cardinality(app_ids) = 0 as all_apps, include_general as with_general from m),
  pinned as (select task_id from meeting_tasks where meeting_id = p_meeting),
  carried as (
    select t.id,
      (select count(*) from meetings mm, m
         where mm.id <> m.id and mm.held_at < m.held_at and mm.series_id is not distinct from m.series_id
           and mm.held_at >= t.created_at
           and (t.completed_at is null or t.completed_at > mm.held_at)) as carry
    from tasks t
  ),
  -- `t` is the WHOLE task row as a composite (so task_card(p.t) type-checks);
  -- `carry` and `pinned` ride alongside it.
  pending as (
    select t as t, c.carry, (t.id in (select task_id from pinned)) as pinned
    from tasks t join carried c on c.id = t.id, win, asof, scope s
    where (s.all_apps or task_targets_any(t.id, s.app_ids) or (not exists (select 1 from task_targets x where x.task_id = t.id) and s.with_general) or t.id in (select task_id from pinned))
      and t.created_at <= asof.at
      and t.status not in ('done','cancelled')
      and (t.completed_at is null or t.completed_at > asof.at)
  ),
  done as (
    select t as t, (t.id in (select task_id from pinned)) as pinned
    from tasks t, win, scope s
    where t.status = 'done'
      and ((t.completed_at > win.from_at and t.completed_at <= win.to_at and (s.all_apps or task_targets_any(t.id, s.app_ids) or (not exists (select 1 from task_targets x where x.task_id = t.id) and s.with_general)))
           or t.id in (select task_id from pinned))
  ),
  notes as (
    select n.*, user_brief(cu) as author, (select user_brief(uu) from users uu where uu.id = n.user_id) as about
    from meeting_notes n left join users cu on cu.id = n.created_by
    where n.meeting_id = p_meeting
  )
  select jsonb_build_object(
    'meeting', (select jsonb_build_object('id', m.id, 'title', m.title, 'held_at', m.held_at, 'notes', m.notes,
                                          'status', m.status, 'finalized_at', m.finalized_at,
                                          'series_id', m.series_id, 'app_ids', to_jsonb(m.app_ids), 'include_general', m.include_general) from m),
    'series', (select jsonb_build_object('id', s.id, 'name', s.name, 'color', s.color) from meeting_series s, m where s.id = m.series_id),
    'window', (select jsonb_build_object('from', from_at, 'to', to_at) from win),
    'previous_meeting', (select held_at from prev),
    'pinned', coalesce((select jsonb_agg(task_id) from pinned), '[]'::jsonb),
    'done', coalesce((
      select jsonb_agg(task_card(d.t) || jsonb_build_object('pinned', d.pinned) order by (d.t).completed_at desc)
      from done d
    ), '[]'::jsonb),
    'carried', coalesce((
      select jsonb_agg(task_card(p.t) || jsonb_build_object('carry', p.carry, 'pinned', p.pinned) order by p.carry desc, (p.t).due_date nulls last, (p.t).number)
      from pending p where p.carry > 0
    ), '[]'::jsonb),
    'new', coalesce((
      select jsonb_agg(task_card(p.t) || jsonb_build_object('carry', p.carry, 'pinned', p.pinned) order by (p.t).created_at desc)
      from pending p, win where p.carry = 0 and (p.t).created_at > win.from_at
    ), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(task_card(p.t) || jsonb_build_object('carry', p.carry, 'pinned', p.pinned) order by p.pinned desc, p.carry desc, (p.t).due_date nulls last, (p.t).number)
      from pending p
    ), '[]'::jsonb),
    'on_hold', coalesce((
      select jsonb_agg(task_card(p.t) || jsonb_build_object('carry', p.carry, 'pinned', p.pinned) order by (p.t).number)
      from pending p where (p.t).status = 'on_hold'
    ), '[]'::jsonb),
    'overdue', coalesce((
      select jsonb_agg(task_card(p.t) || jsonb_build_object('carry', p.carry, 'pinned', p.pinned) order by (p.t).due_date, (p.t).number)
      from pending p, asof where (p.t).due_date < (asof.at at time zone 'Asia/Kolkata')::date
    ), '[]'::jsonb),
    'approvals', coalesce((
      select jsonb_agg(task_card(t) order by t.requested_at)
      from tasks t, scope s where t.requested_status is not null and (s.all_apps or task_targets_any(t.id, s.app_ids) or (not exists (select 1 from task_targets x where x.task_id = t.id) and s.with_general))
    ), '[]'::jsonb),
    'releases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'app', jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url),
        'platform', r.platform, 'version_name', r.version_name, 'build_number', r.build_number,
        'status', r.status, 'planned_date', r.planned_date, 'released_at', r.released_at, 'description', r.description,
        'tasks', coalesce((select jsonb_agg(task_card(t) order by t.number) from tasks t where exists (select 1 from task_targets tt where tt.task_id = t.id and tt.release_id = r.id)), '[]'::jsonb)
      ) order by (r.status = 'released'), coalesce(r.planned_date, (r.released_at at time zone 'Asia/Kolkata')::date) nulls last)
      from releases r join apps a on a.id = r.app_id, win, scope s
      where (s.all_apps or r.app_id = any(s.app_ids))
        and ((r.released_at > win.from_at and r.released_at <= win.to_at + interval '1 day')
          or (r.status not in ('released','cancelled','rolled_back')
              and (r.planned_date is null or r.planned_date <= (win.to_at at time zone 'Asia/Kolkata')::date + 21)))
    ), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(user_brief(u) || jsonb_build_object(
        'done', (select count(*) from task_assignees ta join done d on (d.t).id = ta.task_id where ta.user_id = u.id),
        'pending', (select count(*) from task_assignees ta join pending p on (p.t).id = ta.task_id where ta.user_id = u.id),
        'in_progress', (select count(*) from task_assignees ta join pending p on (p.t).id = ta.task_id where ta.user_id = u.id and (p.t).status = 'in_progress'),
        'carried', (select count(*) from task_assignees ta join pending p on (p.t).id = ta.task_id where ta.user_id = u.id and p.carry > 0),
        'overdue', (select count(*) from task_assignees ta join pending p on (p.t).id = ta.task_id, asof
                     where ta.user_id = u.id and (p.t).due_date < (asof.at at time zone 'Asia/Kolkata')::date)
      ) order by u.department, u.first_name, u.email)
      from users u where u.is_active
    ), '[]'::jsonb),
    'apps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'has_android', a.has_android, 'has_ios', a.has_ios,
        'done', (select count(*) from done d where task_targets_app((d.t).id, a.id)),
        'pending', (select count(*) from pending p where task_targets_app((p.t).id, a.id)),
        'carried', (select count(*) from pending p where task_targets_app((p.t).id, a.id) and p.carry > 0)
      ) order by a.name)
      from apps a, scope s where a.status <> 'archived' and (s.all_apps or a.id = any(s.app_ids))
    ), '[]'::jsonb),
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id, 'task_id', n.task_id, 'kind', n.kind, 'body', n.body, 'created_at', n.created_at,
        'author', n.author, 'about', n.about,
        'task', (select jsonb_build_object('id', t.id, 'number', t.number, 'title', t.title, 'status', t.status) from tasks t where t.id = n.task_id)
      ) order by n.created_at)
      from notes n
    ), '[]'::jsonb)
  );
$$;
