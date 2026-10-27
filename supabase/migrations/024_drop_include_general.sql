-- =====================================================================
-- 024 — The "include general tasks" setting is gone.
-- Since 010 a general (no-app) task joins a meeting only when it is attached to the
-- series or added to that meeting by hand; the per-scope switch has changed nothing
-- since. The panel no longer reads or writes it.
-- RUN THIS ONLY AFTER the build that stops using it is live (the previous build
-- still selects the column). Everything here is also in supabase/schema.sql.
-- =====================================================================

-- 1. The meeting pack without the field
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
                                          'series_id', m.series_id, 'app_ids', to_jsonb(m.app_ids), 'auto_close', m.auto_close) from m),
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

-- 2. The columns
alter table meetings drop column if exists include_general;
alter table meeting_series drop column if exists include_general;
