-- =====================================================================
-- 009 — Arrays on tasks, approval race guard, meeting windows, app counts
-- Run after 008. Everything here is also in supabase/schema.sql (master).
--
--  * tasks.app_ids / tasks.assignee_ids : kept by triggers; lists filter
--    "on my apps" and "unassigned" in SQL (GIN-indexed) at any size.
--  * task_visible / dashboard_pack / analytics_pack / report_pack : the
--    same rule, on the array.
--  * task_apply_status : an approval checks the request is still the one it
--    read (errcode P0003 otherwise) and completes at the request time.
--  * meeting_pack : the window ends when the meeting was CLOSED, so tasks
--    created or finished during the meeting stay in its minutes; "all apps"
--    always includes general tasks; carry counts only for pending rows.
--  * apps_overview / analytics_pack.by_app / report_pack.apps : per-app
--    counts come from targets (a task on two apps counts for both), fast.
-- =====================================================================

alter table tasks add column if not exists app_ids      uuid[] not null default '{}';
alter table tasks add column if not exists assignee_ids uuid[] not null default '{}';
create index if not exists tasks_app_ids_gin      on tasks using gin (app_ids);
create index if not exists tasks_assignee_ids_gin on tasks using gin (assignee_ids);

-- Keep tasks.app_ids / tasks.assignee_ids in step with their tables (009).
create or replace function task_sync_app_ids()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  tid uuid := coalesce(new.task_id, old.task_id);
begin
  update tasks t set app_ids = coalesce((select array_agg(distinct x.app_id order by x.app_id) from task_targets x where x.task_id = tid), '{}'::uuid[])
  where t.id = tid;
  return null;
end;
$$;
drop trigger if exists task_targets_arrays on task_targets;
create trigger task_targets_arrays after insert or update of app_id or delete on task_targets for each row execute function task_sync_app_ids();

create or replace function task_sync_assignee_ids()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  tid uuid := coalesce(new.task_id, old.task_id);
begin
  update tasks t set assignee_ids = coalesce((select array_agg(distinct x.user_id order by x.user_id) from task_assignees x where x.task_id = tid), '{}'::uuid[])
  where t.id = tid;
  return null;
end;
$$;
drop trigger if exists task_assignees_arrays on task_assignees;
create trigger task_assignees_arrays after insert or update of user_id or delete on task_assignees for each row execute function task_sync_assignee_ids();

-- Backfill once (idempotent).
update tasks t set app_ids = coalesce((select array_agg(distinct x.app_id order by x.app_id) from task_targets x where x.task_id = t.id), '{}'::uuid[])
where t.app_ids is distinct from coalesce((select array_agg(distinct x.app_id order by x.app_id) from task_targets x where x.task_id = t.id), '{}'::uuid[]);
update tasks t set assignee_ids = coalesce((select array_agg(distinct x.user_id order by x.user_id) from task_assignees x where x.task_id = t.id), '{}'::uuid[])
where t.assignee_ids is distinct from coalesce((select array_agg(distinct x.user_id order by x.user_id) from task_assignees x where x.task_id = t.id), '{}'::uuid[]);

create or replace function task_visible(p_task uuid, p_user uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select t.app_ids = '{}'::uuid[] or t.app_ids && visible_app_ids(p_user)
  from tasks t where t.id = p_task;
$$;

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
    'open_tasks',  (select count(*) from tasks t where a.id = any(t.app_ids) and t.status not in ('done','cancelled')),
    'in_progress', (select count(*) from tasks t where a.id = any(t.app_ids) and t.status = 'in_progress'),
    'overdue',     (select count(*) from tasks t where a.id = any(t.app_ids) and t.status not in ('done','cancelled') and t.due_date < ist_today()),
    'done_week',   (select count(*) from tasks t where a.id = any(t.app_ids) and t.completed_at >= ist_week_start()),
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

create or replace function dashboard_pack(p_user uuid, p_admin boolean)
returns jsonb
language sql
stable
set search_path = public
as $$
  -- What this caller may see: everything for admins, their apps for members.
  with vis as (select t.* from tasks t where p_admin or t.app_ids = '{}'::uuid[] or t.app_ids && visible_app_ids(p_user)),
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
        'id', r.id, 'app', jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url),
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

create or replace function meeting_pack(p_meeting uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  with m as (select * from meetings where id = p_meeting),
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
  asof as (select to_at as at from win),
  scope as (select app_ids, cardinality(app_ids) = 0 as all_apps, (include_general or cardinality(app_ids) = 0) as with_general from m),
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

drop function if exists analytics_pack(int);
create or replace function analytics_pack(p_months int default 6, p_user uuid default null)
returns jsonb
language sql
stable
set search_path = public
as $$
  with bounds as (
    select date_trunc('month', (now() at time zone 'Asia/Kolkata')) - make_interval(months => greatest(1, least(p_months, 24)) - 1) as from_m
  ),
  months as (
    select to_char(m, 'YYYY-MM') as month, m as m_start, m + interval '1 month' as m_end
    from bounds, generate_series(bounds.from_m, date_trunc('month', (now() at time zone 'Asia/Kolkata')), interval '1 month') g(m)
  ),
  -- p_user null = the whole team (admins); otherwise only what that member may see.
  vis as (select t.* from tasks t where p_user is null or t.app_ids = '{}'::uuid[] or t.app_ids && visible_app_ids(p_user)),
  done as (
    select t.*, to_char(t.completed_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month
    from vis t, bounds b
    where t.status = 'done' and t.completed_at is not null
      and (t.completed_at at time zone 'Asia/Kolkata') >= b.from_m
  ),
  created as (
    select t.*, to_char(t.created_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month
    from vis t, bounds b
    where (t.created_at at time zone 'Asia/Kolkata') >= b.from_m
  )
  select jsonb_build_object(
    'months', coalesce((
      select jsonb_agg(jsonb_build_object(
        'month', mo.month,
        'done', (select count(*) from done d where d.month = mo.month),
        'created', (select count(*) from created c where c.month = mo.month),
        'avg_lead_hours', (select round(avg(extract(epoch from (d.completed_at - d.created_at)) / 3600)::numeric, 1) from done d where d.month = mo.month),
        'avg_active_hours', (select round(avg(d.active_seconds) / 3600.0, 1) from done d where d.month = mo.month),
        'releases', (select count(*) from releases r where r.status = 'released' and to_char(r.released_at at time zone 'Asia/Kolkata', 'YYYY-MM') = mo.month and (p_user is null or r.app_id = any(visible_app_ids(p_user))))
      ) order by mo.month)
      from months mo
    ), '[]'::jsonb),
    'by_app', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'color', a.color,
        'done', (select count(*) from done d where a.id = any(d.app_ids)),
        'open', (select count(*) from vis t where a.id = any(t.app_ids) and t.status not in ('done','cancelled')),
        'overdue', (select count(*) from vis t where a.id = any(t.app_ids) and t.status not in ('done','cancelled') and t.due_date < ist_today()),
        'months', coalesce((select jsonb_object_agg(mo.month, (select count(*) from done d where a.id = any(d.app_ids) and d.month = mo.month)) from months mo), '{}'::jsonb)
      ) order by a.name)
      from apps a where a.status <> 'archived' and (p_user is null or a.id = any(visible_app_ids(p_user)))
    ), '[]'::jsonb),
    'general', jsonb_build_object(
      'done', (select count(*) from done d where d.app_id is null),
      'open', (select count(*) from vis t where t.app_id is null and t.status not in ('done','cancelled')),
      'months', coalesce((select jsonb_object_agg(mo.month, (select count(*) from done d where d.app_id is null and d.month = mo.month)) from months mo), '{}'::jsonb)
    ),
    'by_person', coalesce((
      select jsonb_agg(user_brief(u) || jsonb_build_object(
        'done', (select count(*) from task_assignees ta join done d on d.id = ta.task_id where ta.user_id = u.id),
        'open', (select count(*) from task_assignees ta join tasks t on t.id = ta.task_id where ta.user_id = u.id and t.status not in ('done','cancelled')),
        'in_progress', (select count(*) from task_assignees ta join tasks t on t.id = ta.task_id where ta.user_id = u.id and t.status = 'in_progress'),
        'overdue', (select count(*) from task_assignees ta join tasks t on t.id = ta.task_id where ta.user_id = u.id and t.status not in ('done','cancelled') and t.due_date < ist_today()),
        'avg_lead_hours', (select round(avg(extract(epoch from (d.completed_at - d.created_at)) / 3600)::numeric, 1) from task_assignees ta join done d on d.id = ta.task_id where ta.user_id = u.id),
        'months', coalesce((select jsonb_object_agg(mo.month, (select count(*) from task_assignees ta join done d on d.id = ta.task_id where ta.user_id = u.id and d.month = mo.month)) from months mo), '{}'::jsonb)
      ) order by u.department, u.first_name, u.email)
      from users u where u.is_active
    ), '[]'::jsonb),
    'status_now', coalesce((select jsonb_object_agg(status, c) from (select status, count(*) c from vis group by status) x), '{}'::jsonb),
    'type_done', coalesce((select jsonb_object_agg(type, c) from (select type, count(*) c from done group by type) x), '{}'::jsonb),
    'totals', jsonb_build_object(
      'done', (select count(*) from done),
      'created', (select count(*) from created),
      'open_now', (select count(*) from vis where status not in ('done','cancelled')),
      'overdue_now', (select count(*) from vis where status not in ('done','cancelled') and due_date < ist_today()),
      'median_lead_hours', (select round((percentile_cont(0.5) within group (order by extract(epoch from (completed_at - created_at)) / 3600))::numeric, 1) from done),
      'avg_active_hours', (select round(avg(active_seconds) / 3600.0, 1) from done)
    )
  );
$$;

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
  vis as (select t.* from tasks t where p_user is null or t.app_ids = '{}'::uuid[] or t.app_ids && visible_app_ids(p_user)),
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
