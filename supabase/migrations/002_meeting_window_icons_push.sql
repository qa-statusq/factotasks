-- =====================================================================
-- 002 — Meeting window up to "now", app store icons, browser push
-- Run after 001. Everything here is also in supabase/schema.sql (master).
-- =====================================================================

-- 1) App icons fetched from Google Play / the App Store.
alter table apps add column if not exists icon_url text;

-- 2) Push subscriptions for browser notifications.
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

alter table push_subscriptions enable row level security;
revoke all on push_subscriptions from anon, authenticated;

-- 3) Cards and packs carry the app icon; an OPEN meeting's window runs to now().
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
    'open_tasks',  (select count(*) from tasks t where t.app_id = a.id and t.status not in ('done','cancelled')),
    'in_progress', (select count(*) from tasks t where t.app_id = a.id and t.status = 'in_progress'),
    'overdue',     (select count(*) from tasks t where t.app_id = a.id and t.status not in ('done','cancelled') and t.due_date < ist_today()),
    'done_week',   (select count(*) from tasks t where t.app_id = a.id and t.completed_at >= ist_week_start()),
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
  prev as (
    select mm.held_at from meetings mm, m where mm.held_at < m.held_at order by mm.held_at desc limit 1
  ),
  win as (
    select coalesce((select held_at from prev), (select held_at from m) - interval '7 days') as from_at,
           case when (select status from m) = 'finalized' then (select held_at from m) else greatest((select held_at from m), now()) end as to_at,
           (select status from m) as mstatus
  ),
  -- For an OPEN meeting the "as of" instant is NOW (live view); for a finalized
  -- one it is the meeting time, so history never drifts after the fact.
  asof as (select to_at as at from win),
  carried as (
    select t.id,
      (select count(*) from meetings mm, m
         where mm.held_at < m.held_at and mm.held_at >= t.created_at
           and (t.completed_at is null or t.completed_at > mm.held_at)) as carry
    from tasks t
  ),
  -- `t` is the WHOLE task row as a composite (so task_card(p.t) type-checks);
  -- `carry` rides alongside it.
  pending as (
    select t as t, c.carry from tasks t join carried c on c.id = t.id, win, asof
    where t.created_at <= asof.at
      and t.status not in ('done','cancelled')
      and (t.completed_at is null or t.completed_at > asof.at)
  ),
  notes as (
    select n.*, user_brief(cu) as author, (select user_brief(uu) from users uu where uu.id = n.user_id) as about
    from meeting_notes n left join users cu on cu.id = n.created_by
    where n.meeting_id = p_meeting
  )
  select jsonb_build_object(
    'meeting', (select jsonb_build_object('id', m.id, 'title', m.title, 'held_at', m.held_at, 'notes', m.notes,
                                          'status', m.status, 'finalized_at', m.finalized_at) from m),
    'window', (select jsonb_build_object('from', from_at, 'to', to_at) from win),
    'previous_meeting', (select held_at from prev),
    'done', coalesce((
      select jsonb_agg(task_card(t) order by t.completed_at desc)
      from tasks t, win where t.status = 'done' and t.completed_at > win.from_at and t.completed_at <= win.to_at
    ), '[]'::jsonb),
    'carried', coalesce((
      select jsonb_agg(task_card(p.t) || jsonb_build_object('carry', p.carry) order by p.carry desc, (p.t).due_date nulls last, (p.t).number)
      from pending p where p.carry > 0
    ), '[]'::jsonb),
    'new', coalesce((
      select jsonb_agg(task_card(p.t) || jsonb_build_object('carry', p.carry) order by (p.t).created_at desc)
      from pending p, win where p.carry = 0 and (p.t).created_at > win.from_at
    ), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(task_card(p.t) || jsonb_build_object('carry', p.carry) order by p.carry desc, (p.t).due_date nulls last, (p.t).number)
      from pending p
    ), '[]'::jsonb),
    'on_hold', coalesce((
      select jsonb_agg(task_card(p.t) || jsonb_build_object('carry', p.carry) order by (p.t).number)
      from pending p where (p.t).status = 'on_hold'
    ), '[]'::jsonb),
    'overdue', coalesce((
      select jsonb_agg(task_card(p.t) || jsonb_build_object('carry', p.carry) order by (p.t).due_date, (p.t).number)
      from pending p, asof where (p.t).due_date < (asof.at at time zone 'Asia/Kolkata')::date
    ), '[]'::jsonb),
    'approvals', coalesce((
      select jsonb_agg(task_card(t) order by t.requested_at)
      from tasks t where t.requested_status is not null
    ), '[]'::jsonb),
    'releases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'app', jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url),
        'platform', r.platform, 'version_name', r.version_name, 'build_number', r.build_number,
        'status', r.status, 'planned_date', r.planned_date, 'released_at', r.released_at, 'description', r.description
      ) order by (r.status = 'released'), coalesce(r.planned_date, (r.released_at at time zone 'Asia/Kolkata')::date) nulls last)
      from releases r join apps a on a.id = r.app_id, win
      where (r.released_at > win.from_at and r.released_at <= win.to_at + interval '1 day')
         or (r.status not in ('released','cancelled','rolled_back')
             and (r.planned_date is null or r.planned_date <= (win.to_at at time zone 'Asia/Kolkata')::date + 21))
    ), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(user_brief(u) || jsonb_build_object(
        'done', (select count(*) from task_assignees ta join tasks t on t.id = ta.task_id, win
                  where ta.user_id = u.id and t.status = 'done' and t.completed_at > win.from_at and t.completed_at <= win.to_at),
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
        'done', (select count(*) from tasks t, win where t.app_id = a.id and t.status = 'done' and t.completed_at > win.from_at and t.completed_at <= win.to_at),
        'pending', (select count(*) from pending p where (p.t).app_id = a.id),
        'carried', (select count(*) from pending p where (p.t).app_id = a.id and p.carry > 0)
      ) order by a.name)
      from apps a where a.status <> 'archived'
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

