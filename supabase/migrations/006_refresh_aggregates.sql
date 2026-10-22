-- =====================================================================
-- 006 — Aggregates refreshed from the master schema
-- Run after 005. Everything here is also in supabase/schema.sql (master).
--
-- The dashboard, apps, team, analytics and report aggregates picked up
-- columns over the last migrations (app icons, targets, series) but only
-- some of them had shipped as migrations. This re-creates all of them so the
-- live database matches the master schema exactly. Idempotent.
-- =====================================================================

create or replace function dashboard_pack(p_user uuid, p_admin boolean)
returns jsonb
language sql
stable
set search_path = public
as $$
  with mine as (
    select t.* from tasks t
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
      'team_open',      (select count(*) from tasks where status not in ('done','cancelled')),
      'team_in_progress', (select count(*) from tasks where status = 'in_progress'),
      'team_on_hold',   (select count(*) from tasks where status = 'on_hold'),
      'team_overdue',   (select count(*) from tasks, today where status not in ('done','cancelled') and due_date < today.d),
      'team_done_week', (select count(*) from tasks where completed_at >= ist_week_start()),
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
      from (select tk.* from tasks tk, today
            where tk.status not in ('done','cancelled') and tk.due_date is not null and tk.due_date < today.d + 7
            order by tk.due_date, tk.number limit 30) t
    ), '[]'::jsonb),
    'recent_done', coalesce((
      select jsonb_agg(task_card(t) order by completed_at desc)
      from (select * from tasks where status = 'done' and completed_at >= now() - interval '7 days'
            order by completed_at desc limit 15) t
    ), '[]'::jsonb),
    'releases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'app', jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url),
        'platform', r.platform, 'version_name', r.version_name, 'status', r.status,
        'planned_date', r.planned_date, 'released_at', r.released_at
      ) order by coalesce(r.planned_date, (r.released_at at time zone 'Asia/Kolkata')::date) nulls last)
      from (select * from releases rr
            where rr.status not in ('released','cancelled','rolled_back')
               or rr.released_at >= now() - interval '14 days'
            order by rr.planned_date nulls last limit 12) r
      join apps a on a.id = r.app_id
    ), '[]'::jsonb)
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
      'apps', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'app_role', m.app_role) order by a.name)
                          from app_members m join apps a on a.id = m.app_id where m.user_id = u.id), '[]'::jsonb)
    ) order by (not u.is_active), u.department, u.first_name, u.email
  ), '[]'::jsonb)
  from users u;
$$;

create or replace function analytics_pack(p_months int default 6)
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
  done as (
    select t.*, to_char(t.completed_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month
    from tasks t, bounds b
    where t.status = 'done' and t.completed_at is not null
      and (t.completed_at at time zone 'Asia/Kolkata') >= b.from_m
  ),
  created as (
    select t.*, to_char(t.created_at at time zone 'Asia/Kolkata', 'YYYY-MM') as month
    from tasks t, bounds b
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
        'releases', (select count(*) from releases r where r.status = 'released' and to_char(r.released_at at time zone 'Asia/Kolkata', 'YYYY-MM') = mo.month)
      ) order by mo.month)
      from months mo
    ), '[]'::jsonb),
    'by_app', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'color', a.color,
        'done', (select count(*) from done d where d.app_id = a.id),
        'open', (select count(*) from tasks t where t.app_id = a.id and t.status not in ('done','cancelled')),
        'overdue', (select count(*) from tasks t where t.app_id = a.id and t.status not in ('done','cancelled') and t.due_date < ist_today()),
        'months', coalesce((select jsonb_object_agg(mo.month, (select count(*) from done d where d.app_id = a.id and d.month = mo.month)) from months mo), '{}'::jsonb)
      ) order by a.name)
      from apps a where a.status <> 'archived'
    ), '[]'::jsonb),
    'general', jsonb_build_object(
      'done', (select count(*) from done d where d.app_id is null),
      'open', (select count(*) from tasks t where t.app_id is null and t.status not in ('done','cancelled')),
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
    'status_now', coalesce((select jsonb_object_agg(status, c) from (select status, count(*) c from tasks group by status) x), '{}'::jsonb),
    'type_done', coalesce((select jsonb_object_agg(type, c) from (select type, count(*) c from done group by type) x), '{}'::jsonb),
    'totals', jsonb_build_object(
      'done', (select count(*) from done),
      'created', (select count(*) from created),
      'open_now', (select count(*) from tasks where status not in ('done','cancelled')),
      'overdue_now', (select count(*) from tasks where status not in ('done','cancelled') and due_date < ist_today()),
      'median_lead_hours', (select round((percentile_cont(0.5) within group (order by extract(epoch from (completed_at - created_at)) / 3600))::numeric, 1) from done),
      'avg_active_hours', (select round(avg(active_seconds) / 3600.0, 1) from done)
    )
  );
$$;

create or replace function report_pack(p_from date, p_to date)
returns jsonb
language sql
stable
set search_path = public
as $$
  with bounds as (
    select (p_from::timestamp at time zone 'Asia/Kolkata') as from_at,
           ((p_to + 1)::timestamp at time zone 'Asia/Kolkata') as to_at
  ),
  done as (
    select t.* from tasks t, bounds b where t.status = 'done' and t.completed_at >= b.from_at and t.completed_at < b.to_at
  ),
  created as (
    select t.* from tasks t, bounds b where t.created_at >= b.from_at and t.created_at < b.to_at
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'totals', jsonb_build_object(
      'created', (select count(*) from created),
      'done', (select count(*) from done),
      'open_now', (select count(*) from tasks where status not in ('done','cancelled')),
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
      from users u where u.is_active
    ), '[]'::jsonb),
    'apps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'color', a.color,
        'done', (select count(*) from done d where d.app_id = a.id),
        'created', (select count(*) from created c where c.app_id = a.id),
        'open', (select count(*) from tasks t where t.app_id = a.id and t.status not in ('done','cancelled')),
        'releases', (select count(*) from releases r, bounds b where r.app_id = a.id and r.released_at >= b.from_at and r.released_at < b.to_at)
      ) order by a.name)
      from apps a where a.status <> 'archived'
    ), '[]'::jsonb)
  );
$$;
