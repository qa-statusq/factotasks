-- =====================================================================
-- 011 — General tasks are private: assignees + creator (+ admins)
-- Run after 010. Everything here is also in supabase/schema.sql (master).
--
-- A general (no-app) task used to be visible to every member. Now a member
-- sees it only when assigned to it or when they created it. App tasks are
-- unchanged (members of the app). task_visible, dashboard_pack,
-- analytics_pack and report_pack all carry the same rule.
-- =====================================================================

create or replace function task_visible(p_task uuid, p_user uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select (t.app_ids <> '{}'::uuid[] and t.app_ids && visible_app_ids(p_user))
      or (t.app_ids = '{}'::uuid[] and (p_user = any(t.assignee_ids) or t.created_by = p_user))
  from tasks t where t.id = p_task;
$$;

create or replace function dashboard_pack(p_user uuid, p_admin boolean)
returns jsonb
language sql
stable
set search_path = public
as $$
  -- What this caller may see: everything for admins, their apps for members.
  with vis as (select t.* from tasks t where p_admin or (t.app_ids <> '{}'::uuid[] and t.app_ids && visible_app_ids(p_user)) or (t.app_ids = '{}'::uuid[] and (p_user = any(t.assignee_ids) or t.created_by = p_user))),
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
  vis as (select t.* from tasks t where p_user is null or (t.app_ids <> '{}'::uuid[] and t.app_ids && visible_app_ids(p_user)) or (t.app_ids = '{}'::uuid[] and (p_user = any(t.assignee_ids) or t.created_by = p_user))),
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
  vis as (select t.* from tasks t where p_user is null or (t.app_ids <> '{}'::uuid[] and t.app_ids && visible_app_ids(p_user)) or (t.app_ids = '{}'::uuid[] and (p_user = any(t.assignee_ids) or t.created_by = p_user))),
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
