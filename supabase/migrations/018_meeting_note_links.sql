-- =====================================================================
-- 018 — Meeting notes can carry a link
-- Run after 017. Everything here is also in supabase/schema.sql (master).
--  * meeting_notes.link_url / link_label: a finding, document or ticket
--    behind a minute line. Shown as a button ("Link: Click here", or the
--    label given) on the meeting page, the deck and the printed minutes.
--  * meeting_pack carries both fields on every note.
-- =====================================================================

alter table meeting_notes add column if not exists link_url   text check (link_url is null or (length(link_url) <= 2000 and link_url ~* '^https?://'));
alter table meeting_notes add column if not exists link_label text check (link_label is null or length(link_label) <= 60);

-- The weekly meeting pack: everything the MOM / presentation view shows, in one
-- call. Window = (previous meeting's held_at, this meeting's held_at] — and
-- while the meeting is still OPEN the end of the window is max(held_at, now()),
-- so a meeting created today shows everything up to this minute. For the very
-- first meeting the window is the 7 days before it. "Carried" = how many
-- EARLIER meetings this still-pending task has already been through.
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
          -- (017) shipped: the release day (IST) falls inside the window, or the
          -- version carries a task that is on this meeting — so a task shown as
          -- released always has its version on the Releases slide
          (r.status = 'released'
             and (((r.released_at at time zone 'Asia/Kolkata')::date >= (win.from_at at time zone 'Asia/Kolkata')::date
                   and (r.released_at at time zone 'Asia/Kolkata')::date <= (win.to_at at time zone 'Asia/Kolkata')::date)
                  or exists (select 1 from task_targets tt where tt.release_id = r.id
                               and (tt.task_id in (select (d.t).id from done d) or tt.task_id in (select (p.t).id from pending p)))))
          -- (017) under test right now; planned and in-progress versions wait until they reach testing
          or r.status = 'testing'
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
        'link_url', n.link_url, 'link_label', n.link_label,
        'author', n.author, 'about', n.about,
        'task', (select jsonb_build_object('id', t.id, 'number', t.number, 'title', t.title, 'status', t.status) from tasks t where t.id = n.task_id)
      ) order by n.created_at)
      from notes n
    ), '[]'::jsonb)
  );
$$;
