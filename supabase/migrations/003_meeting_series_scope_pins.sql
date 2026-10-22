-- =====================================================================
-- 003 — Meeting series, per-meeting app scope, and pinned tasks
-- Run after 002. Everything here is also in supabase/schema.sql (master).
--
--  * meeting_series : "Weekly sync", "FactoTime release review", … Each
--                     meeting belongs to one. The agenda window and the
--                     carry-forward count are computed within a series, so
--                     a Tuesday review never shortens Thursday's sync.
--  * meetings.app_ids : optional scope. Empty = every app. Tasks, releases,
--                     approvals and app counters are filtered by it.
--  * meeting_tasks  : tasks pinned to a meeting by hand, regardless of app
--                     or date. A task may be in any number of meetings.
-- =====================================================================

-- 1) Series
create table if not exists meeting_series (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  color      text not null default '#1c1c1a',
  app_ids    uuid[] not null default '{}',   -- default scope for new meetings in this series
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists meeting_series_name_idx on meeting_series (lower(name));
drop trigger if exists meeting_series_touch on meeting_series;
create trigger meeting_series_touch before update on meeting_series for each row execute function touch_updated_at();
drop trigger if exists meeting_series_rev on meeting_series;
create trigger meeting_series_rev after insert or update or delete on meeting_series for each statement execute function bump_rev();
alter table meeting_series enable row level security;
revoke all on meeting_series from anon, authenticated;

-- 2) Meetings: series + scope
alter table meetings add column if not exists series_id uuid references meeting_series(id) on delete set null;
alter table meetings add column if not exists app_ids uuid[] not null default '{}';
create index if not exists meetings_series_idx on meetings (series_id, held_at desc);

-- Existing meetings all join one "Weekly sync" series.
insert into meeting_series (name) select 'Weekly sync' where not exists (select 1 from meeting_series);
update meetings set series_id = (select id from meeting_series order by created_at limit 1) where series_id is null;

-- 3) Pinned tasks
create table if not exists meeting_tasks (
  meeting_id uuid not null references meetings(id) on delete cascade,
  task_id    uuid not null references tasks(id) on delete cascade,
  added_by   uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (meeting_id, task_id)
);
create index if not exists meeting_tasks_task_idx on meeting_tasks (task_id);
drop trigger if exists meeting_tasks_rev on meeting_tasks;
create trigger meeting_tasks_rev after insert or update or delete on meeting_tasks for each statement execute function bump_rev();
alter table meeting_tasks enable row level security;
revoke all on meeting_tasks from anon, authenticated;

-- 4) meeting_pack: window and carry within the series, scope filter, pins.
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
  scope as (select app_ids, cardinality(app_ids) = 0 as all_apps from m),
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
    where (s.all_apps or t.app_id = any(s.app_ids) or t.id in (select task_id from pinned))
      and t.created_at <= asof.at
      and t.status not in ('done','cancelled')
      and (t.completed_at is null or t.completed_at > asof.at)
  ),
  done as (
    select t as t, (t.id in (select task_id from pinned)) as pinned
    from tasks t, win, scope s
    where t.status = 'done'
      and ((t.completed_at > win.from_at and t.completed_at <= win.to_at and (s.all_apps or t.app_id = any(s.app_ids)))
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
                                          'series_id', m.series_id, 'app_ids', to_jsonb(m.app_ids)) from m),
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
      from tasks t, scope s where t.requested_status is not null and (s.all_apps or t.app_id = any(s.app_ids))
    ), '[]'::jsonb),
    'releases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'app', jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url),
        'platform', r.platform, 'version_name', r.version_name, 'build_number', r.build_number,
        'status', r.status, 'planned_date', r.planned_date, 'released_at', r.released_at, 'description', r.description
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
        'done', (select count(*) from done d where (d.t).app_id = a.id),
        'pending', (select count(*) from pending p where (p.t).app_id = a.id),
        'carried', (select count(*) from pending p where (p.t).app_id = a.id and p.carry > 0)
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
