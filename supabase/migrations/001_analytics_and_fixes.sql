-- =====================================================================
-- 001 — Analytics, task_card description, hardened rev counter, report dates
-- Run ONCE on a database created from the ORIGINAL schema.sql (2026-10-21).
-- Everything here is also in supabase/schema.sql (the master); safe to re-run.
-- =====================================================================

-- 1) The change counter must never block a write, whatever is in it.
create or replace function bump_rev()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update app_settings
     set value = to_jsonb(coalesce(nullif(regexp_replace(value #>> '{}', '\D', '', 'g'), '')::bigint, 0) + 1),
         updated_at = now()
   where key = 'rev';
  return null;
end;
$$;
update app_settings set value = '0'::jsonb where key = 'rev' and jsonb_typeof(value) <> 'number';

-- 2) task_card carries a short description (lists, meeting deck).
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
    'app', (select jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'has_android', a.has_android, 'has_ios', a.has_ios)
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

-- 3) report_pack: day buckets as plain dates.
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

-- 4) analytics_pack: NEW.
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
