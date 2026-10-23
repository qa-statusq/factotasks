-- =====================================================================
-- 016 — Store icon per platform; task numbers as one straight series
-- Run after 015. Everything here is also in supabase/schema.sql (master),
-- except the final one-time renumbering call.
--  * apps.icon_android_url / icon_ios_url: the Play icon and the App Store
--    artwork, each shown where that platform is meant; icon_url stays the
--    app's main tile (Android first, else iOS). Every JSON builder carries
--    all three.
--  * task_sequence_reset(): continue numbering from the highest task in use
--    (the API harness calls it after removing its sample rows).
--  * tasks_renumber(): close the gaps left by deleted rows — tasks become
--    T-1..T-n in creation order and every quoted T-number is rewritten.
-- =====================================================================
alter table apps add column if not exists icon_android_url text;
alter table apps add column if not exists icon_ios_url text;


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
    'app', (select jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url, 'has_android', a.has_android, 'has_ios', a.has_ios)
              from apps a where a.id = t.app_id),
    'release', (select jsonb_build_object('id', r.id, 'version_name', r.version_name, 'platform', r.platform, 'status', r.status)
                  from releases r where r.id = t.release_id),
    'series', (select jsonb_build_object('id', ms.id, 'name', ms.name, 'color', ms.color) from meeting_series ms where ms.id = t.series_id),
    'targets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'app', jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url),
        'platform', tt.platform,
        'release', (select jsonb_build_object('id', r.id, 'version_name', r.version_name, 'platform', r.platform, 'status', r.status, 'planned_date', r.planned_date)
                      from releases r where r.id = tt.release_id),
        'released_at', tt.released_at
      ) order by a.sort_order, a.name, tt.platform)
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
    'color', a.color, 'icon_path', a.icon_path, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url, 'created_at', a.created_at, 'updated_at', a.updated_at,
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
  ) order by (a.status = 'archived'), a.sort_order, a.name), '[]'::jsonb)
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
      'apps', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url, 'app_role', m.app_role) order by a.sort_order, a.name)
                          from app_members m join apps a on a.id = m.app_id where m.user_id = u.id), '[]'::jsonb)
    ) order by (not u.is_active), u.department, u.first_name, u.email
  ), '[]'::jsonb)
  from users u;
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
  -- In scope: app tasks the scope covers, plus any task attached to this
  -- series. General tasks join only by attachment or by being pinned.
  scope as (select app_ids, cardinality(app_ids) = 0 as all_apps, series_id from m),
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
    where (((t.app_ids <> '{}'::uuid[] and (s.all_apps or t.app_ids && s.app_ids)) or (t.series_id is not null and t.series_id = s.series_id)) or t.id in (select task_id from pinned))
      and t.created_at <= asof.at
      and t.status not in ('done','cancelled')
      and (t.completed_at is null or t.completed_at > asof.at)
  ),
  done as (
    select t as t, (t.id in (select task_id from pinned)) as pinned
    from tasks t, win, scope s
    where t.status = 'done'
      and ((t.completed_at > win.from_at and t.completed_at <= win.to_at and ((t.app_ids <> '{}'::uuid[] and (s.all_apps or t.app_ids && s.app_ids)) or (t.series_id is not null and t.series_id = s.series_id)))
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
    'series', (select jsonb_build_object('id', s.id, 'name', s.name, 'color', s.color, 'app_order', to_jsonb(s.app_order)) from meeting_series s, m where s.id = m.series_id),
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
      from tasks t, scope s where t.requested_status is not null and ((t.app_ids <> '{}'::uuid[] and (s.all_apps or t.app_ids && s.app_ids)) or (t.series_id is not null and t.series_id = s.series_id))
    ), '[]'::jsonb),
    'releases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'app', jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url),
        'platform', r.platform, 'version_name', r.version_name, 'build_number', r.build_number,
        'status', r.status, 'planned_date', r.planned_date, 'released_at', r.released_at, 'description', r.description,
        'tasks', coalesce((select jsonb_agg(task_card(t) order by t.number) from tasks t where exists (select 1 from task_targets tt where tt.task_id = t.id and tt.release_id = r.id)), '[]'::jsonb)
      ) order by (r.status = 'released'), coalesce(r.planned_date, (r.released_at at time zone 'Asia/Kolkata')::date) nulls last)
      from releases r join apps a on a.id = r.app_id, win, scope s
      where (s.all_apps or r.app_id = any(s.app_ids))
        and (
          -- (015) shipped inside the window, compared by IST DAY: a version dated
          -- the day the window opens belongs to it, whatever the minute.
          (r.released_at is not null
             and (r.released_at at time zone 'Asia/Kolkata')::date >= (win.from_at at time zone 'Asia/Kolkata')::date
             and (r.released_at at time zone 'Asia/Kolkata')::date <= (win.to_at at time zone 'Asia/Kolkata')::date)
          -- still in the pipeline and due soon
          or (r.status not in ('released','cancelled','rolled_back')
              and (r.planned_date is null or r.planned_date <= (win.to_at at time zone 'Asia/Kolkata')::date + 21))
          -- (015) or it carries a task that is on this meeting, so "Released 1/1" on a
          -- task always has its version on the Releases slide
          or exists (select 1 from task_targets tt where tt.release_id = r.id
                       and (tt.task_id in (select (d.t).id from done d) or tt.task_id in (select (p.t).id from pending p)))
        )
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
        'id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url, 'has_android', a.has_android, 'has_ios', a.has_ios,
        'done', (select count(*) from done d where task_targets_app((d.t).id, a.id)),
        'pending', (select count(*) from pending p where task_targets_app((p.t).id, a.id)),
        'carried', (select count(*) from pending p where task_targets_app((p.t).id, a.id) and p.carry > 0)
      ) order by a.sort_order, a.name)
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
  vis as (select t.* from tasks t where p_user is null or (t.app_ids <> '{}'::uuid[] and t.app_ids && visible_app_ids(p_user)) or (t.app_ids = '{}'::uuid[] and (p_user = any(t.assignee_ids) or t.created_by = p_user))),
  done as (
    select t.*, (t.completed_at at time zone 'Asia/Kolkata')::date as day,
           extract(epoch from (t.completed_at - t.created_at)) / 3600 as lead_h,
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
    select t.*, (ist_today() - (t.created_at at time zone 'Asia/Kolkata')::date) as age_days
    from vis t where t.status not in ('done','cancelled')
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
    'by_person', coalesce((
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
    ), '[]'::jsonb),
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
      jsonb_build_object('key', '<1d', 'n', (select count(*) from done where lead_h < 24)),
      jsonb_build_object('key', '1–3d', 'n', (select count(*) from done where lead_h >= 24 and lead_h < 72)),
      jsonb_build_object('key', '3–7d', 'n', (select count(*) from done where lead_h >= 72 and lead_h < 168)),
      jsonb_build_object('key', '1–2w', 'n', (select count(*) from done where lead_h >= 168 and lead_h < 336)),
      jsonb_build_object('key', '2–4w', 'n', (select count(*) from done where lead_h >= 336 and lead_h < 672)),
      jsonb_build_object('key', '>4w', 'n', (select count(*) from done where lead_h >= 672))
    ),
    'aging', jsonb_build_array(
      jsonb_build_object('key', '<7d', 'n', (select count(*) from openx where age_days < 7)),
      jsonb_build_object('key', '7–14d', 'n', (select count(*) from openx where age_days >= 7 and age_days < 14)),
      jsonb_build_object('key', '14–30d', 'n', (select count(*) from openx where age_days >= 14 and age_days < 30)),
      jsonb_build_object('key', '30–60d', 'n', (select count(*) from openx where age_days >= 30 and age_days < 60)),
      jsonb_build_object('key', '>60d', 'n', (select count(*) from openx where age_days >= 60))
    ),
    'oldest_open', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'number', t.number, 'title', t.title, 'status', t.status, 'priority', t.priority, 'age_days', t.age_days, 'due_date', t.due_date,
        'app', (select jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url) from apps a where a.id = t.app_ids[1]),
        'assignees', coalesce((select jsonb_agg(user_brief(u) order by u.first_name) from task_assignees ta join users u on u.id = ta.user_id where ta.task_id = t.id), '[]'::jsonb)
      ) order by t.age_days desc, t.number)
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
      'avg_open_age_days', (select round(avg(age_days)::numeric, 1) from openx)
    )
  );
$$;

-- (016) Task numbers stay a straight series: once test rows are removed, the
-- next task continues from the highest number in use.
create or replace function task_sequence_reset()
returns bigint
language sql
set search_path = public
as $$
  select setval('task_number_seq', coalesce((select max(number) from tasks), 1), (select count(*) from tasks) > 0);
$$;

-- (016) Close the gaps: renumber every task 1..n in creation order and
-- rewrite the T-numbers quoted in descriptions, comments, minutes, activity
-- and notifications. Run by hand, once; it returns how many tasks moved.
create or replace function tasks_renumber()
returns int
language plpgsql
set search_path = public
as $$
declare
  r record;
  moved int := 0;
begin
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

-- One-time: close the gaps in task numbers (safe to re-run; a second run moves nothing).
select tasks_renumber();

