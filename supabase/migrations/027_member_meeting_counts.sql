-- 027: A member's Analytics counts only the meetings of the series they take
-- part in (held, notes, decisions, action items, blockers). Admins still see
-- the whole team. Approved by the user on 2026-10-28.
-- analytics_pack is copied from schema.sql; only the `held` set changes.
-- Safe to run more than once.

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
           work_seconds(t.created_at, t.completed_at) / 3600.0 as lead_h,
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
    select t.*, w.age_s, round(w.age_s / 32400.0, 1) as age_days
    from vis t cross join lateral (select work_seconds(t.created_at, now()) as age_s) w
    where t.status not in ('done','cancelled')
  ),
  rel as (
    select r.*, (r.released_at at time zone 'Asia/Kolkata')::date as day
    from releases r, bounds b
    where r.status = 'released' and r.released_at >= b.from_at and r.released_at < b.to_at
      and (p_user is null or r.app_id = any(visible_app_ids(p_user)))
  ),
  -- (027) A member counts only the meetings of the series they take part in.
  held as (
    select m.* from meetings m, bounds b where m.held_at >= b.from_at and m.held_at < b.to_at
      and (p_user is null or m.series_id in (select sm.series_id from meeting_series_members sm where sm.user_id = p_user))
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
    -- (026) Per-person throughput is the team view; a member's pack skips it.
    'by_person', case when p_user is null then coalesce((
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
    ), '[]'::jsonb) end,
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
      -- Working time: 1d = 9 working hours, 1w = 5 working days (45 h).
      jsonb_build_object('key', '<1d', 'n', (select count(*) from done where lead_h < 9)),
      jsonb_build_object('key', '1–3d', 'n', (select count(*) from done where lead_h >= 9 and lead_h < 27)),
      jsonb_build_object('key', '3–5d', 'n', (select count(*) from done where lead_h >= 27 and lead_h < 45)),
      jsonb_build_object('key', '1–2w', 'n', (select count(*) from done where lead_h >= 45 and lead_h < 90)),
      jsonb_build_object('key', '2–4w', 'n', (select count(*) from done where lead_h >= 90 and lead_h < 180)),
      jsonb_build_object('key', '>4w', 'n', (select count(*) from done where lead_h >= 180))
    ),
    'aging', jsonb_build_array(
      -- Working weeks of 5 working days (45 working hours = 162000 s).
      jsonb_build_object('key', '<1w', 'n', (select count(*) from openx where age_s < 162000)),
      jsonb_build_object('key', '1–2w', 'n', (select count(*) from openx where age_s >= 162000 and age_s < 324000)),
      jsonb_build_object('key', '2–4w', 'n', (select count(*) from openx where age_s >= 324000 and age_s < 648000)),
      jsonb_build_object('key', '4–8w', 'n', (select count(*) from openx where age_s >= 648000 and age_s < 1296000)),
      jsonb_build_object('key', '>8w', 'n', (select count(*) from openx where age_s >= 1296000))
    ),
    'oldest_open', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'number', t.number, 'title', t.title, 'status', t.status, 'priority', t.priority, 'age_days', t.age_days, 'age_seconds', t.age_s, 'due_date', t.due_date,
        'app', (select jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url) from apps a where a.id = t.app_ids[1]),
        'assignees', coalesce((select jsonb_agg(user_brief(u) order by u.first_name) from task_assignees ta join users u on u.id = ta.user_id where ta.task_id = t.id), '[]'::jsonb)
      ) order by t.age_s desc, t.number)
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
      'avg_open_age_days', (select round(avg(age_s) / 32400.0, 1) from openx),
      'avg_open_age_seconds', (select round(avg(age_s)) from openx)
    )
  );
$$;
