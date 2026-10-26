-- =====================================================================
-- 023 — Structure and speed: the meeting pack built once per task, member
--       visibility in SQL, one-pass app counters, statement-level array sync,
--       list-order indexes, dead columns/functions gone, decided-request guards,
--       a job lease, split-part names.
-- Run after 022. Everything here is also in supabase/schema.sql (master).
-- =====================================================================

-- 1. Dead columns and objects
-- (023) Never written since 005 (targets carry the release); never read since 016 (icons come from the stores).
drop index if exists tasks_release_idx;
alter table tasks drop column if exists release_id;
alter table apps drop column if exists icon_path;
drop function if exists task_targets_any(uuid, uuid[]);
drop function if exists task_targets_app(uuid, uuid);
drop function if exists task_targets_backfill();
drop function if exists meeting_pack(uuid);
delete from app_settings where key = 'meeting';

-- 2. Helpers
create or replace function user_brief(u users)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'id', u.id,
    'name', coalesce(nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''), split_part(u.email, '@', 1)),
    'first_name', u.first_name,
    'last_name', u.last_name,
    'email', u.email,
    'color', u.color,
    'department', u.department,
    'is_active', u.is_active
  );
$$;

-- (023) The visibility rule on a row, inlinable: p_user null = everything; otherwise
-- an app task on one of p_apps, or a general task the person is on or created.
create or replace function task_row_visible(t tasks, p_user uuid, p_apps uuid[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_user is null
      or (t.app_ids <> '{}'::uuid[] and t.app_ids && p_apps)
      or (t.app_ids = '{}'::uuid[] and (p_user = any(t.assignee_ids) or t.created_by = p_user));
$$;

create or replace function visible_task_ids(p_user uuid)
returns setof uuid
language sql
stable
set search_path = public
as $$
  with va as (select visible_app_ids(p_user) as ids)
  select t.id from tasks t, va where task_row_visible(t, p_user, va.ids);
$$;

create or replace function task_visible(p_task uuid, p_user uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select task_row_visible(t, p_user, visible_app_ids(p_user)) from tasks t where t.id = p_task;
$$;

-- 3. task_card without the dead release key
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

-- 4. Array sync per statement
-- (023) Keep tasks.app_ids / tasks.assignee_ids in step with their tables — once per
-- statement over the rows it touched, not once per row (one UPDATE of tasks per
-- save instead of one per target or assignee, and one change-counter bump).
create or replace function task_sync_app_ids_stmt()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update tasks t set app_ids = coalesce((select array_agg(distinct x.app_id order by x.app_id) from task_targets x where x.task_id = t.id), '{}'::uuid[])
  where t.id in (select task_id from changed_rows);
  return null;
end;
$$;
drop trigger if exists task_targets_arrays on task_targets;
drop trigger if exists task_targets_arrays_ins on task_targets;
drop trigger if exists task_targets_arrays_upd on task_targets;
drop trigger if exists task_targets_arrays_del on task_targets;
create trigger task_targets_arrays_ins after insert on task_targets referencing new table as changed_rows for each statement execute function task_sync_app_ids_stmt();
create trigger task_targets_arrays_upd after update on task_targets referencing new table as changed_rows for each statement execute function task_sync_app_ids_stmt();
create trigger task_targets_arrays_del after delete on task_targets referencing old table as changed_rows for each statement execute function task_sync_app_ids_stmt();

create or replace function task_sync_assignee_ids_stmt()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update tasks t set assignee_ids = coalesce((select array_agg(distinct x.user_id order by x.user_id) from task_assignees x where x.task_id = t.id), '{}'::uuid[])
  where t.id in (select task_id from changed_rows);
  return null;
end;
$$;
drop trigger if exists task_assignees_arrays on task_assignees;
drop trigger if exists task_assignees_arrays_ins on task_assignees;
drop trigger if exists task_assignees_arrays_upd on task_assignees;
drop trigger if exists task_assignees_arrays_del on task_assignees;
create trigger task_assignees_arrays_ins after insert on task_assignees referencing new table as changed_rows for each statement execute function task_sync_assignee_ids_stmt();
create trigger task_assignees_arrays_upd after update on task_assignees referencing new table as changed_rows for each statement execute function task_sync_assignee_ids_stmt();
create trigger task_assignees_arrays_del after delete on task_assignees referencing old table as changed_rows for each statement execute function task_sync_assignee_ids_stmt();
drop function if exists task_sync_app_ids();
drop function if exists task_sync_assignee_ids();

-- 5. One-pass app counters
create or replace function apps_overview()
returns jsonb
language sql
stable
set search_path = public
as $$
  -- (023) Counters in one pass over tasks (GIN-indexable containment, not a scan per app).
  with per_app as (
    select x.app_id,
           count(*) filter (where t.status not in ('done','cancelled')) as open_tasks,
           count(*) filter (where t.status = 'in_progress') as in_progress,
           count(*) filter (where t.status not in ('done','cancelled') and t.due_date < ist_today()) as overdue,
           count(*) filter (where t.completed_at >= ist_week_start()) as done_week
    from tasks t cross join lateral unnest(t.app_ids) as x(app_id)
    group by x.app_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'name', a.name, 'description', a.description, 'kind', a.kind, 'status', a.status,
    'has_android', a.has_android, 'has_ios', a.has_ios,
    'android_package', a.android_package, 'ios_bundle_id', a.ios_bundle_id, 'appstore_url', a.appstore_url,
    'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url, 'created_at', a.created_at, 'updated_at', a.updated_at,
    'open_tasks',  coalesce(pa.open_tasks, 0),
    'in_progress', coalesce(pa.in_progress, 0),
    'overdue',     coalesce(pa.overdue, 0),
    'done_week',   coalesce(pa.done_week, 0),
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
  from apps a left join per_app pa on pa.app_id = a.id;
$$;

-- 6. The meeting pack (card once; id lists; member view in SQL) and the light id list
create or replace function meeting_pack(p_meeting uuid, p_user uuid default null)
returns jsonb
language sql
stable
set search_path = public
as $$
  with m as (select * from meetings where id = p_meeting),
  -- (023) p_user null = an admin's full view; otherwise the member's: only the tasks,
  -- releases and apps they may see, no per-person workload, no approvals queue.
  va as (select case when p_user is null then '{}'::uuid[] else visible_app_ids(p_user) end as ids),
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
  asof as (select to_at as at, (to_at at time zone 'Asia/Kolkata')::date as today from win),
  -- In scope: app tasks the scope covers, plus any task attached to this
  -- series. General tasks join only by attachment or by being pinned.
  -- (017) An OPEN meeting follows its series' CURRENT scope — an app added to
  -- the series joins the running meeting; a closed one keeps the scope it was
  -- closed with (the API snapshots it on close).
  scope as (
    select sc.app_ids, cardinality(sc.app_ids) = 0 as all_apps, m.series_id
    from m left join meeting_series ms on ms.id = m.series_id,
    lateral (select case when m.status = 'finalized' or ms.id is null then m.app_ids else ms.app_ids end as app_ids) sc
  ),
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
  -- Each task is carded ONCE here; the derived sets below are id lists over these rows.
  pending as (
    select t.id, t.number, t.status, t.due_date, t.created_at, t.app_ids, t.assignee_ids,
           task_card(t) as card, c.carry, (t.id in (select task_id from pinned)) as pinned
    from tasks t join carried c on c.id = t.id, win, asof, scope s, va
    where (((t.app_ids <> '{}'::uuid[] and (s.all_apps or t.app_ids && s.app_ids)) or (t.series_id is not null and t.series_id = s.series_id)) or t.id in (select task_id from pinned))
      and t.created_at <= asof.at
      and t.status not in ('done','cancelled')
      and (t.completed_at is null or t.completed_at > asof.at)
      and task_row_visible(t, p_user, va.ids)
  ),
  done as (
    select t.id, t.number, t.completed_at, t.app_ids, t.assignee_ids,
           task_card(t) as card, (t.id in (select task_id from pinned)) as pinned
    from tasks t, win, scope s, va
    where t.status = 'done'
      and ((t.completed_at > win.from_at and t.completed_at <= win.to_at and ((t.app_ids <> '{}'::uuid[] and (s.all_apps or t.app_ids && s.app_ids)) or (t.series_id is not null and t.series_id = s.series_id)))
           or t.id in (select task_id from pinned))
      and task_row_visible(t, p_user, va.ids)
  ),
  cards as (select id, number, card from pending union all select id, number, card from done),
  notes as (
    select n.*, user_brief(cu) as author, (select user_brief(uu) from users uu where uu.id = n.user_id) as about
    from meeting_notes n left join users cu on cu.id = n.created_by, va
    where n.meeting_id = p_meeting
      and (n.task_id is null or exists (select 1 from tasks t where t.id = n.task_id and task_row_visible(t, p_user, va.ids)))
  )
  select jsonb_build_object(
    'meeting', (select jsonb_build_object('id', m.id, 'title', m.title, 'held_at', m.held_at, 'notes', m.notes,
                                          'status', m.status, 'finalized_at', m.finalized_at,
                                          'series_id', m.series_id, 'app_ids', to_jsonb(m.app_ids), 'include_general', m.include_general, 'auto_close', m.auto_close) from m),
    'series', (select jsonb_build_object('id', s.id, 'name', s.name, 'color', s.color, 'app_order', to_jsonb(s.app_order), 'auto_close', s.auto_close) from meeting_series s, m where s.id = m.series_id),
    'window', (select jsonb_build_object('from', from_at, 'to', to_at) from win),
    'previous_meeting', (select held_at from prev),
    'pinned', coalesce((select jsonb_agg(task_id) from pinned), '[]'::jsonb),
    'done', coalesce((
      select jsonb_agg(d.card || jsonb_build_object('pinned', d.pinned) order by d.completed_at desc)
      from done d
    ), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(p.card || jsonb_build_object('carry', p.carry, 'pinned', p.pinned) order by p.pinned desc, p.carry desc, p.due_date nulls last, p.number)
      from pending p
    ), '[]'::jsonb),
    -- Id lists: the screens count them and mark rows by id; the cards sit in `pending`.
    'carried', coalesce((select jsonb_agg(p.id order by p.carry desc, p.due_date nulls last, p.number) from pending p where p.carry > 0), '[]'::jsonb),
    'new', coalesce((select jsonb_agg(p.id order by p.created_at desc) from pending p, win where p.carry = 0 and p.created_at > win.from_at), '[]'::jsonb),
    'overdue', coalesce((select jsonb_agg(p.id order by p.due_date, p.number) from pending p, asof where p.due_date < asof.today), '[]'::jsonb),
    'approvals', case when p_user is null then coalesce((
      select jsonb_agg(task_card(t) order by t.requested_at)
      from tasks t, scope s where t.requested_status is not null and ((t.app_ids <> '{}'::uuid[] and (s.all_apps or t.app_ids && s.app_ids)) or (t.series_id is not null and t.series_id = s.series_id))
    ), '[]'::jsonb) else '[]'::jsonb end,
    'releases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'app', jsonb_build_object('id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url),
        'platform', r.platform, 'version_name', r.version_name, 'build_number', r.build_number,
        'status', r.status, 'planned_date', r.planned_date, 'released_at', r.released_at, 'description', r.description,
        -- The version's tasks: the card already built when the task is on this meeting, built here otherwise.
        'tasks', coalesce((select jsonb_agg(coalesce(c.card, task_card(t)) order by t.number)
                             from tasks t left join cards c on c.id = t.id
                            where exists (select 1 from task_targets tt where tt.task_id = t.id and tt.release_id = r.id)
                              and task_row_visible(t, p_user, va.ids)), '[]'::jsonb)
      ) order by (r.status = 'released'), coalesce(r.planned_date, (r.released_at at time zone 'Asia/Kolkata')::date) nulls last)
      from releases r join apps a on a.id = r.app_id, win, scope s, va
      where (s.all_apps or r.app_id = any(s.app_ids))
        and (p_user is null or r.app_id = any(va.ids))
        and (
          -- (017) shipped: the release day (IST) falls inside the window, or the
          -- version carries a task that is on this meeting — so a task shown as
          -- released always has its version on the Releases slide
          (r.status = 'released'
             and (((r.released_at at time zone 'Asia/Kolkata')::date >= (win.from_at at time zone 'Asia/Kolkata')::date
                   and (r.released_at at time zone 'Asia/Kolkata')::date <= (win.to_at at time zone 'Asia/Kolkata')::date)
                  or exists (select 1 from task_targets tt where tt.release_id = r.id and tt.task_id in (select id from cards))))
          -- (017) under test right now; planned and in-progress versions wait until they reach testing
          or r.status = 'testing'
        )
    ), '[]'::jsonb),
    -- Per-person workload is a lead's view.
    'people', case when p_user is null then coalesce((
      select jsonb_agg(user_brief(u) || jsonb_build_object(
        'done', (select count(*) from done d where u.id = any(d.assignee_ids)),
        'pending', (select count(*) from pending p where u.id = any(p.assignee_ids)),
        'in_progress', (select count(*) from pending p where u.id = any(p.assignee_ids) and p.status = 'in_progress'),
        'carried', (select count(*) from pending p where u.id = any(p.assignee_ids) and p.carry > 0),
        'overdue', (select count(*) from pending p, asof where u.id = any(p.assignee_ids) and p.due_date < asof.today)
      ) order by u.department, u.first_name, u.email)
      from users u where u.is_active
    ), '[]'::jsonb) else '[]'::jsonb end,
    'apps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'color', a.color, 'icon_url', a.icon_url, 'icon_android_url', a.icon_android_url, 'icon_ios_url', a.icon_ios_url, 'has_android', a.has_android, 'has_ios', a.has_ios,
        'done', (select count(*) from done d where a.id = any(d.app_ids)),
        'pending', (select count(*) from pending p where a.id = any(p.app_ids)),
        'carried', (select count(*) from pending p where a.id = any(p.app_ids) and p.carry > 0)
      ) order by a.sort_order, a.name)
      from apps a, scope s, va where a.status <> 'archived' and (s.all_apps or a.id = any(s.app_ids)) and (p_user is null or a.id = any(va.ids))
    ), '[]'::jsonb),
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id, 'task_id', n.task_id, 'kind', n.kind, 'body', n.body, 'created_at', n.created_at,
        'link_url', n.link_url, 'link_label', n.link_label,
        'author', n.author, 'about', n.about,
        'task', (select jsonb_build_object('id', t.id, 'number', t.number, 'title', t.title, 'status', t.status) from tasks t where t.id = n.task_id)
      ) order by n.created_at)
      from notes n
    ), '[]'::jsonb)
  );
$$;

-- (023) The task ids on a meeting's agenda (pending + done in its window, pinned ones
-- included) without building a single card — the Tasks screen's "Meeting" filter.
create or replace function meeting_task_ids(p_meeting uuid)
returns setof uuid
language sql
stable
set search_path = public
as $$
  with m as (select * from meetings where id = p_meeting),
  prev as (
    select coalesce(mm.finalized_at, mm.held_at) as held_at from meetings mm, m
    where mm.id <> m.id and mm.held_at < m.held_at and mm.series_id is not distinct from m.series_id
    order by mm.held_at desc limit 1
  ),
  win as (
    select coalesce((select held_at from prev), (select held_at from m) - interval '7 days') as from_at,
           case when (select status from m) = 'finalized' then coalesce((select finalized_at from m), (select held_at from m)) else greatest((select held_at from m), now()) end as to_at
  ),
  scope as (
    select sc.app_ids, cardinality(sc.app_ids) = 0 as all_apps, m.series_id
    from m left join meeting_series ms on ms.id = m.series_id,
    lateral (select case when m.status = 'finalized' or ms.id is null then m.app_ids else ms.app_ids end as app_ids) sc
  ),
  pinned as (select task_id from meeting_tasks where meeting_id = p_meeting)
  select t.id from tasks t, win, scope s
  where (((t.app_ids <> '{}'::uuid[] and (s.all_apps or t.app_ids && s.app_ids)) or (t.series_id is not null and t.series_id = s.series_id)) or t.id in (select task_id from pinned))
    and ((t.status not in ('done','cancelled') and t.created_at <= win.to_at and (t.completed_at is null or t.completed_at > win.to_at))
         or (t.status = 'done' and t.completed_at > win.from_at and t.completed_at <= win.to_at)
         or t.id in (select task_id from pinned)
         or t.requested_status is not null);
$$;

-- 7. Decided-request guards
create or replace function task_clear_request(p_task uuid, p_actor uuid, p_kind text, p_note text default null)
returns tasks
language plpgsql
set search_path = public
as $$
declare t tasks; req text;
begin
  select requested_status into req from tasks where id = p_task for update;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  -- (023) Nothing pending any more: it was approved, withdrawn or rejected a moment ago.
  if req is null then
    raise exception 'no pending request' using errcode = 'P0003';
  end if;
  update tasks set
    requested_status = null, requested_by = null, requested_at = null, request_note = null
  where id = p_task
  returning * into t;
  insert into task_status_log (task_id, kind, from_status, to_status, actor_id, note)
  values (p_task, p_kind, t.status, req, p_actor, p_note);
  return t;
end;
$$;

create or replace function task_request_status(p_task uuid, p_to text, p_actor uuid, p_note text default null)
returns tasks
language plpgsql
set search_path = public
as $$
declare t tasks; cur text;
begin
  select requested_status into cur from tasks where id = p_task for update;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  -- (023) The same request twice (a second tab, a retry) is one request.
  if cur = p_to then
    raise exception 'already requested' using errcode = 'P0005';
  end if;
  update tasks set
    requested_status = p_to, requested_by = p_actor, requested_at = now(), request_note = p_note
  where id = p_task
  returning * into t;
  insert into task_status_log (task_id, kind, from_status, to_status, actor_id, note)
  values (p_task, 'request', t.status, p_to, p_actor, p_note);
  return t;
end;
$$;

-- (023) Merge a few preference keys into users.prefs atomically (null removes a key),
-- so two quick changes from the same person compose instead of overwriting each other.
create or replace function prefs_merge(p_user uuid, p_patch jsonb)
returns jsonb
language sql
set search_path = public
as $$
  update users
     set prefs = (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
                    from jsonb_each(coalesce(prefs, '{}'::jsonb) || p_patch) as e(k, v)
                   where jsonb_typeof(v) <> 'null')
   where id = p_user
   returning prefs;
$$;

-- 8. Job lease
-- (023) A short lease for jobs that must not overlap (two instances, a scheduler
-- retry): the first caller within p_ttl_sec gets true, the others false.
create or replace function cron_lease(p_name text, p_ttl_sec int)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  insert into app_settings (key, value) values ('lease:' || p_name, to_jsonb(now()))
  on conflict (key) do update set value = excluded.value, updated_at = now()
    where (app_settings.value #>> '{}')::timestamptz < now() - make_interval(secs => p_ttl_sec);
  return found;
end;
$$;

-- 9. Change counter: only what a screen paints
-- (023) Entity-bound rows ride on their entity's own trigger; sign-ins, sign-outs
-- and the daily job change nothing a screen paints. Only standalone entries
-- (settings, arrange apps…) move the counter.
drop trigger if exists activity_log_rev on activity_log;
create trigger activity_log_rev after insert on activity_log for each row
  when (new.entity_type is null and new.action not like 'auth.%' and new.action not like 'cron.%')
  execute function bump_rev();
drop trigger if exists app_settings_rev on app_settings;
create trigger app_settings_rev after insert or update on app_settings for each row when (new.key <> 'rev' and new.key not like 'lease:%') execute function bump_rev();

-- 10. Indexes
-- (023) The default task list is ORDER BY updated_at desc, id desc (status as a filter);
-- sort=created the same on created_at. The old (status, updated_at) index could not
-- walk a five-status IN-list in order.
create index if not exists tasks_updated_id_idx on tasks (updated_at desc, id desc);
create index if not exists tasks_created_id_idx on tasks (created_at desc, id desc);
drop index if exists tasks_open_idx;
drop index if exists users_active_idx;
drop index if exists releases_open_idx;
-- One open meeting per series, enforced where it counts.
create unique index if not exists meetings_one_open_per_series on meetings (series_id) where status = 'open';

-- 11. Maintenance tools lock first
-- (023) The maintenance tools take the table lock first, so a task created meanwhile
-- can neither be skipped by the renumbering nor collide with the reset sequence.
create or replace function task_sequence_reset()
returns bigint
language plpgsql
set search_path = public
as $$
begin
  lock table tasks in exclusive mode;
  return setval('task_number_seq', coalesce((select max(number) from tasks), 1), (select count(*) from tasks) > 0);
end;
$$;

