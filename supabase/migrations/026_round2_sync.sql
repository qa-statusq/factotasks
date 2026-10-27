-- 026: Round-2 sweep — live functions match supabase/schema.sql again.
--
--  1. work_seconds() becomes an exact closed form (difference of a cumulative
--     working clock) that the planner inlines: same results, ~10x faster
--     analytics. Checked equal to 025's day-walk on 25 081 spans.
--  2. task_apply_status():
--     - an approval banks active time up to the member's REQUEST, not the
--       admin's click (waiting for review is not work);
--     - a plain change to the status the task already has raises P0004, so a
--       double submit never logs or notifies twice.
--  3. dashboard_pack, analytics_pack and tasks_renumber are re-created from
--     schema.sql. Migration 023 never carried round 1's visibility rewrite
--     (task_row_visible + materialized app list) for the packs, nor the table
--     lock for tasks_renumber, and 025 rebuilt analytics_pack from 016.
--     analytics_pack now leaves out per-person figures for a member's request
--     (the API dropped them anyway).
--  4. prefs_merge enforces the 60-key cap on the merged row (parallel requests
--     could pass the route's check on a stale copy).
--  4b. report_pack is dropped: nothing has called /api/reports since Reports
--     moved into Analytics.
--  5. Functions are no longer executable through PUBLIC (which anon inherits);
--     only the server's service_role may call them.
--  6. Active time is recalculated from task_status_log with the rules above:
--     only applied changes count (requests, rejections and withdrawals do not
--     move a task), and an approved stint ends at the request it approved.
-- Safe to run more than once.

-- 1) Working time
create or replace function work_seconds(p_from timestamptz, p_to timestamptz)
returns bigint
language sql
stable
parallel safe
as $$
  -- W(t) = working seconds from Monday 1970-01-05 00:00 IST to t (IST has no
  -- DST, so whole weeks are exactly 5 x 9 h); the span is W(to) - W(from).
  -- One expression with no FROM and no SET clause, so the planner inlines it
  -- into analytics queries (026: ~10x faster than walking the days).
  select case when p_to > p_from then (
    ( ((p_to   at time zone 'Asia/Kolkata')::date - date '1970-01-05')::bigint / 7 * 162000
    + least(((p_to   at time zone 'Asia/Kolkata')::date - date '1970-01-05') % 7, 5) * 32400
    + case when ((p_to   at time zone 'Asia/Kolkata')::date - date '1970-01-05') % 7 < 5 then
          least(greatest(extract(epoch from (p_to   at time zone 'Asia/Kolkata')::time) - 32400, 0), 14400)
        + least(greatest(extract(epoch from (p_to   at time zone 'Asia/Kolkata')::time) - 49500, 0), 18000) else 0 end)
  - ( ((p_from at time zone 'Asia/Kolkata')::date - date '1970-01-05')::bigint / 7 * 162000
    + least(((p_from at time zone 'Asia/Kolkata')::date - date '1970-01-05') % 7, 5) * 32400
    + case when ((p_from at time zone 'Asia/Kolkata')::date - date '1970-01-05') % 7 < 5 then
          least(greatest(extract(epoch from (p_from at time zone 'Asia/Kolkata')::time) - 32400, 0), 14400)
        + least(greatest(extract(epoch from (p_from at time zone 'Asia/Kolkata')::time) - 49500, 0), 18000) else 0 end)
  )::bigint else 0 end
$$;

-- 2) Status changes
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
  -- (026) A plain change to the status it already has is a double submit:
  -- refuse it so it never logs or notifies twice (the route answers "Already …").
  if p_kind = 'change' and p_to = old_status and t.requested_status is null then
    raise exception 'no change' using errcode = 'P0004';
  end if;

  if p_to <> old_status then
    -- Leaving in_progress: bank the WORKING time of the stint that just ended.
    -- (026) An approval ends it when the member asked, not when the admin clicked:
    -- waiting for review is not time spent working.
    if old_status = 'in_progress' then
      active := active + work_seconds(t.status_since,
        case when p_kind = 'approve' and t.requested_at is not null then greatest(t.status_since, t.requested_at) else n end);
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

-- 2b) Preferences: the 60-key cap is enforced in the merge itself
create or replace function prefs_merge(p_user uuid, p_patch jsonb)
returns jsonb
language sql
set search_path = public
as $$
  -- (026) At most 60 keys, checked on the merged row under the update's own lock,
  -- so parallel requests cannot slip past a cap read from a stale copy. Over the
  -- cap: nothing changes and the result is null (the route answers 400).
  update users
     set prefs = m.merged
    from (select (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
                    from jsonb_each(coalesce(u.prefs, '{}'::jsonb) || p_patch) as e(k, v)
                   where jsonb_typeof(v) <> 'null') as merged
            from users u where u.id = p_user for update) m
   where users.id = p_user
     and (select count(*) from jsonb_object_keys(m.merged)) <= 60
   returning users.prefs;
$$;

-- 3) Packs and renumbering, exactly as in schema.sql
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

-- 4) Unused since Reports moved into Analytics
drop function if exists report_pack(date, date, uuid);
drop function if exists report_pack(date, date);

-- 5) Only the server's role may execute functions
revoke execute on all functions in schema public from public;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to service_role;

-- 6) Active time, recalculated in working time from the applied status changes.
--    Only active_seconds changes; the touch/live-update triggers stay off for
--    this statement so no task jumps to the top of "Recently updated".
alter table tasks disable trigger user;
update tasks t set active_seconds = x.secs
from (
  select tk.id as task_id,
         coalesce(sum(work_seconds(s.since, s.until)) filter (where s.status = 'in_progress'), 0) as secs
  from tasks tk
  left join (
    select a.task_id, a.status, a.since,
           -- an approval ends the stint at the request it approved
           case when a.kind = 'approve'
                then greatest(a.since, coalesce((select max(r.created_at) from task_status_log r
                                                  where r.task_id = a.task_id and r.kind = 'request' and r.created_at <= a.at), a.at))
                else a.at end as until
    from (
      select l.task_id, l.kind, l.created_at as at,
             coalesce(lag(l.to_status) over w, l.from_status) as status,
             coalesce(lag(l.created_at) over w, tk2.created_at) as since
      from task_status_log l
      join tasks tk2 on tk2.id = l.task_id
      where l.kind in ('change', 'approve') and l.from_status is distinct from l.to_status
      window w as (partition by l.task_id order by l.created_at, l.id)
    ) a
  ) s on s.task_id = tk.id
  group by tk.id
) x
where x.task_id = t.id and t.active_seconds is distinct from x.secs;
alter table tasks enable trigger user;
