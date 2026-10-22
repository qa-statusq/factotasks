-- =====================================================================
-- 008 — Strict member visibility
-- Run after 007. Everything here is also in supabase/schema.sql (master).
--
--  * task_visible : a member sees general tasks and tasks on their apps —
--    nothing else. Being assigned to a task on another app no longer counts
--    (the API only lets app members be assigned, and un-assigns people who
--    are taken off an app).
--  * dashboard_pack : "my tasks" goes through the same rule.
-- =====================================================================

-- A member sees a task when it is general (no app) or targets one of their
-- apps. Nothing else: being assigned to a task on an app you were taken off
-- does not keep it visible (the API un-assigns you at that point).
create or replace function task_visible(p_task uuid, p_user uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select not exists (select 1 from task_targets x where x.task_id = p_task)
      or exists (select 1 from task_targets x join app_members m on m.app_id = x.app_id and m.user_id = p_user where x.task_id = p_task);
$$;

create or replace function dashboard_pack(p_user uuid, p_admin boolean)
returns jsonb
language sql
stable
set search_path = public
as $$
  -- What this caller may see: everything for admins, their apps for members.
  with vis as (select t.* from tasks t where p_admin or task_visible(t.id, p_user)),
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
      from (select * from vis where status = 'done' and completed_at >= now() - interval '7 days'
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
