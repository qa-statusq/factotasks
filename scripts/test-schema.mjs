// Exercises supabase/schema.sql end-to-end inside PGlite (an in-process
// Postgres) — no Supabase project needed. Loads the schema, seeds a small team,
// walks a task through the approval workflow and calls every aggregate RPC.
// Any SQL syntax/semantic error surfaces here before it can reach production.
//   npm run test-schema
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const db = new PGlite({ extensions: { pg_trgm, pgcrypto } });
const ok = (s) => console.log(`  ✓ ${s}`);
const fail = (s) => {
  console.error(`  ✗ ${s}`);
  process.exitCode = 1;
};
const assert = (cond, msg) => (cond ? ok(msg) : fail(msg));

// Supabase has these roles; PGlite doesn't — create them so the lockdown
// section (REVOKE … FROM anon, authenticated) runs exactly as in production.
await db.exec("create role anon; create role authenticated;");

console.log("\n— schema.sql —");
const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
await db.exec(schema);
ok("loaded without errors");
// Re-run to prove idempotence (every statement is IF NOT EXISTS / OR REPLACE).
await db.exec(schema);
ok("re-ran cleanly (idempotent)");

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const json = async (sql, params) => {
  const row = await one(sql, params);
  const v = row[Object.keys(row)[0]];
  return typeof v === "string" ? JSON.parse(v) : v;
};

console.log("\n— seed —");
const admin = await one(
  "insert into users (email, password_hash, role, first_name, last_name, department) values ('admin@x.com','h','admin','Asha','Patel','management') returning id"
);
const dev = await one(
  "insert into users (email, password_hash, role, first_name, last_name, department, color) values ('dev@x.com','h','member','Rahul','Shah','android','#0ea5e9') returning id"
);
const qa = await one(
  "insert into users (email, password_hash, role, first_name, department) values ('qa@x.com','h','member','Meera','qa') returning id"
);
const app = await one(
  "insert into apps (name, has_android, has_ios, android_package, created_by) values ('SwapMyFace', true, true, 'com.example.swap', $1) returning id",
  [admin.id]
);
await db.query("insert into app_members (app_id, user_id, app_role) values ($1,$2,'developer'), ($1,$3,'qa')", [app.id, dev.id, qa.id]);
const rel = await one(
  "insert into releases (app_id, platform, version_name, build_number, status, planned_date, created_by) values ($1,'android','2.4.0','240','testing', current_date + 3, $2) returning id",
  [app.id, admin.id]
);
const t1 = await one(
  "insert into tasks (app_id, platform, title, description, type, priority, due_date, created_by, labels) values ($1,'android','Fix crash on share sheet','Repro: tap share twice','bug','high', current_date + 2, $2, array['crash','p1']) returning id, number",
  [app.id, dev.id]
);
await db.query("insert into task_targets (task_id, app_id, platform, release_id) values ($1,$2,'android',$3)", [t1.id, app.id, rel.id]);
const t2 = await one(
  "insert into tasks (title, type, priority, created_by) values ('Prepare Q4 marketing deck','marketing','medium',$1) returning id, number",
  [admin.id]
);
await db.query("insert into task_assignees (task_id, user_id, assigned_by) values ($1,$2,$3), ($4,$3,$3)", [t1.id, dev.id, admin.id, t2.id]);
assert(t1.number === 1 && t2.number === 2, `task numbers are sequential (T-${t1.number}, T-${t2.number})`);
const rev0 = await json("select value from app_settings where key = 'rev'");
assert(rev0 > 0, `rev counter bumped by triggers (rev=${rev0})`);
// A string-valued counter (as a careless manual edit could leave it) must not block writes.
await db.query("update app_settings set value = '\"7\"'::jsonb where key = 'rev'");
await db.query("update tasks set priority = 'low' where id = $1", [t2.id]);
assert((await json("select value from app_settings where key = 'rev'")) === 8, "rev trigger tolerates a string-valued counter");
// 022: what a screen paints moves the counter; sign-ins and preferences do not.
await db.query("update users set last_login_at = now(), prefs = '{\"x\":1}'::jsonb where id = $1", [dev.id]);
assert((await json("select value from app_settings where key = 'rev'")) === 8, "a sign-in / preference change leaves the counter alone (022)");
await db.query("update users set title = 'Senior Developer' where id = $1", [dev.id]);
assert((await json("select value from app_settings where key = 'rev'")) === 9, "a changed title moves the counter (022)");
await db.query("update app_settings set value = '{\"mode\":\"always\"}'::jsonb where key = 'approval_policy'");
assert((await json("select value from app_settings where key = 'rev'")) === 10, "a settings change moves the counter once, without re-triggering itself (022)");
await db.query("update app_settings set value = '{\"mode\":\"done_only\"}'::jsonb where key = 'approval_policy'");

console.log("\n— workflow —");
// member starts work
let r = await one("select * from task_apply_status($1,'in_progress',$2,'change',null,null)", [t1.id, dev.id]);
assert(r.status === "in_progress" && r.started_at, "todo → in_progress sets started_at");
// pretend 2 hours passed in progress
await db.query("update tasks set status_since = now() - interval '2 hours', started_at = now() - interval '2 hours' where id = $1", [t1.id]);
// member requests done
r = await one("select * from task_request_status($1,'done',$2,'Tested on Pixel 7')", [t1.id, dev.id]);
assert(r.requested_status === "done" && r.status === "in_progress", "request parks requested_status without changing status");
// admin rejects
r = await one("select * from task_clear_request($1,$2,'reject','Also test on Android 10')", [t1.id, admin.id]);
assert(r.requested_status === null && r.status === "in_progress", "reject clears the request");
// member requests again, admin approves (back-dated to request time)
await db.query("update tasks set status_since = now() - interval '3 hours' where id = $1", [t1.id]);
r = await one("select * from task_request_status($1,'done',$2,null)", [t1.id, dev.id]);
r = await one("select * from task_apply_status($1,'done',$2,'approve','LGTM',$3)", [t1.id, admin.id, r.requested_at]);
assert(r.status === "done" && r.completed_at && r.approved_at && r.approved_by === admin.id, "approve applies done + approved_by");
assert(Number(r.active_seconds) >= 3 * 3600 - 5 && Number(r.active_seconds) <= 3 * 3600 + 60, `active_seconds banked (${r.active_seconds}s ≈ 3h)`);
// reopen clears completion
r = await one("select * from task_apply_status($1,'todo',$2,'change','reopened',null)", [t1.id, admin.id]);
assert(r.completed_at === null && r.approved_at === null, "reopen clears completed/approved");
r = await one("select * from task_apply_status($1,'done',$2,'change',null,null)", [t1.id, admin.id]);
assert(r.status === "done", "direct done by admin");
const log = await db.query("select kind, from_status, to_status from task_status_log where task_id = $1 order by created_at", [t1.id]);
assert(log.rows.length === 7, `status log has ${log.rows.length} entries (expected 7)`);
try {
  await one("select * from task_apply_status(gen_random_uuid(),'done',$1,'change',null,null)", [admin.id]);
  fail("unknown task should raise");
} catch (e) {
  assert(/task not found/.test(String(e.message)), "unknown task raises 'task not found'");
}

try {
  await one("select * from task_clear_request($1,$2,'reject',null)", [t1.id, admin.id]);
  fail("reject without a pending request should raise");
} catch (e) {
  assert(/no pending request/.test(String(e.message)), "task_clear_request refuses when nothing is pending (023)");
}
await one("select * from task_request_status($1,'done',$2,null)", [t1.id, dev.id]);
try {
  await one("select * from task_request_status($1,'done',$2,null)", [t1.id, dev.id]);
  fail("the same request twice should raise");
} catch (e) {
  assert(/already requested/.test(String(e.message)), "task_request_status refuses a duplicate request (023)");
}
await one("select * from task_clear_request($1,$2,'withdraw',null)", [t1.id, dev.id]);

console.log("\n— RPCs —");
const card = await json("select task_card(t) from tasks t where t.id = $1", [t1.id]);
assert(card.number === 1 && card.assignees.length === 1 && card.app.name === "SwapMyFace" && card.release === undefined, "task_card embeds app/assignees (no dead release key, 023)");
assert(card.targets.length === 1 && card.targets[0].platform === "android" && card.targets[0].release.version_name === "2.4.0" && card.release_progress.total === 1 && card.release_progress.released === 0, "task_card: targets carry the release with progress");
assert(JSON.stringify(await json("select app_ids from tasks where id = $1", [t1.id])) === JSON.stringify([app.id]), "tasks.app_ids kept by the statement-level trigger (023)");
assert(Array.isArray(card.labels) && card.labels[0] === "crash", "task_card labels as JSON array");

const dash = await json("select dashboard_pack($1, true)", [admin.id]);
assert(dash.counts.team_done_week >= 1 && dash.counts.team_open === 1, `dashboard_pack counts (open=${dash.counts.team_open}, done_week=${dash.counts.team_done_week})`);
assert(dash.my_tasks.length === 1 && dash.my_tasks[0].number === 2, "dashboard_pack my_tasks (admin owns T-2)");
assert(dash.releases.length === 1 && dash.releases[0].version_name === "2.4.0", "dashboard_pack releases");
const dashDev = await json("select dashboard_pack($1, false)", [dev.id]);
assert(dashDev.approvals.length === 0 && dashDev.counts.my_done_week === 1, "dashboard_pack for a member");

const apps = await json("select apps_overview()");
assert(apps.length === 1 && apps[0].members.length === 2 && apps[0].next_release.version_name === "2.4.0", "apps_overview members + next_release");

const team = await json("select team_overview()");
assert(team.length === 3 && team.find((u) => u.id === dev.id).done_week === 1, "team_overview per-person counts");

// Meetings: last week's meeting, then this week's. T-2 was created before
// last week's meeting → it is carried once; T-1 is done this week.
await db.query("update tasks set created_at = now() - interval '10 days' where id = $1", [t2.id]);
// T-2 is a general task: it reaches the weekly meetings only because it is attached to their series.
const weekly = await one("insert into meeting_series (name) values ('Weekly test series') returning id");
await db.query("update tasks set series_id = $1 where id = $2", [weekly.id, t2.id]);
const m1 = await one("insert into meetings (title, held_at, status, series_id, created_by) values ('Weekly sync', now() - interval '7 days', 'finalized', $1, $2) returning id", [weekly.id, admin.id]);
const m2 = await one("insert into meetings (title, held_at, series_id, created_by) values ('Weekly sync', now(), $1, $2) returning id", [weekly.id, admin.id]);
await db.query("insert into meeting_notes (meeting_id, task_id, kind, body, link_url, link_label, created_by) values ($1,$2,'blocker','Waiting on content from marketing','https://example.com/finding','Crash report',$3)", [m2.id, t2.id, admin.id]);
try {
  await db.query("insert into meeting_notes (meeting_id, kind, body, link_url) values ($1,'note','x','ftp://nope')", [m2.id]);
  fail("a non-http note link should be rejected");
} catch (e) {
  assert(/link_url|check/i.test(String(e.message)), "meeting_notes.link_url must be http(s) (018)");
}
const pack = await json("select meeting_pack($1)", [m2.id]);
assert(pack.done.length === 1 && pack.done[0].number === 1, "meeting_pack: done this week");
assert(pack.carried.length === 1 && pack.pending.find((t) => t.id === pack.carried[0])?.number === 2 && pack.pending.find((t) => t.id === pack.carried[0])?.carry === 1, "meeting_pack: T-2 carried forward once (ids, 023)");
assert(pack.on_hold === undefined && Array.isArray(pack.overdue) && pack.overdue.every((x) => typeof x === "string"), "meeting_pack: overdue/new/carried are id lists, on_hold gone (023)");
assert(pack.new.length === 0 && pack.pending.length === 1, "meeting_pack: pending/new split");
assert(pack.notes.length === 1 && pack.notes[0].task.number === 2, "meeting_pack: notes joined to tasks");
assert(pack.notes[0].link_url === "https://example.com/finding" && pack.notes[0].link_label === "Crash report", "meeting_pack: notes carry their link (018)");
// 021: people of a series, and the closing rule
await db.query("insert into meeting_series_members (series_id, user_id, added_by) values ($1,$2,$3)", [weekly.id, dev.id, admin.id]);
assert((await db.query("select count(*)::int as n from meeting_series_members where series_id = $1 and user_id = $2", [weekly.id, dev.id])).rows[0].n === 1, "meeting_series_members: a person added to a series (021)");
try {
  await db.query("insert into meeting_series_members (series_id, user_id) values ($1,$2)", [weekly.id, dev.id]);
  fail("the same person twice in a series should be rejected");
} catch (e) {
  assert(/duplicate|unique|primary/i.test(String(e.message)), "meeting_series_members: one row per person (021)");
}
assert((await db.query("select auto_close from meeting_series where id = $1", [weekly.id])).rows[0].auto_close === true, "meeting_series.auto_close defaults to true (021)");
assert((await db.query("select auto_close from meetings where id = $1", [m2.id])).rows[0].auto_close === null, "meetings.auto_close defaults to null = follow the series (021)");
await db.query("delete from meeting_series_members where series_id = $1 and user_id = $2", [weekly.id, dev.id]);
// 019: recordings live on the meeting; shares are one row per e-mail.
const recRow = await one("insert into meeting_recordings (meeting_id, name, size_bytes, duration_sec, status, drive_file_id, recorded_by) values ($1,'Weekly sync.webm',4200000,95,'ready','drive-file-1',$2) returning id, status", [m2.id, admin.id]);
assert(recRow.status === "ready", "meeting_recordings: row stored (019)");
await db.query("insert into recording_shares (recording_id, email, permission_id, shared_by) values ($1,'guest@example.com','perm-1',$2)", [recRow.id, admin.id]);
try {
  await db.query("insert into recording_shares (recording_id, email, shared_by) values ($1,'guest@example.com',$2)", [recRow.id, admin.id]);
  fail("the same e-mail twice on one recording should be rejected");
} catch (e) {
  assert(/unique|duplicate/i.test(String(e.message)), "recording_shares: one row per e-mail (019)");
}
try {
  await db.query("insert into meeting_recordings (meeting_id, name, status) values ($1,'x','done')", [m2.id]);
  fail("an unknown recording status should be rejected");
} catch (e) {
  assert(/check|status/i.test(String(e.message)), "meeting_recordings: status is uploading/ready/failed (019)");
}
const m3 = await one("insert into meetings (title, held_at, created_by) values ('Throwaway', now(), $1) returning id", [admin.id]);
await db.query("insert into meeting_recordings (meeting_id, name, status) values ($1,'gone.webm','failed')", [m3.id]);
await db.query("delete from meetings where id = $1", [m3.id]);
assert((await db.query("select count(*)::int as n from meeting_recordings where meeting_id = $1", [m3.id])).rows[0].n === 0, "meeting_recordings: cascade with the meeting (019)");
await db.query("delete from meeting_recordings where id = $1", [recRow.id]);
assert(pack.people.find((p) => p.id === dev.id).done === 1, "meeting_pack: per-person done");
const packDev = await json("select meeting_pack($1, $2)", [m2.id, dev.id]);
assert(packDev.people.length === 0 && packDev.approvals.length === 0 && packDev.done.length === 1 && packDev.pending.every((t) => t.number !== 2), "meeting_pack(p_user): a member's view — no workload, no approvals, only their tasks (023)");
const ids = (await db.query("select meeting_task_ids($1) as id", [m2.id])).rows.map((r) => r.id);
assert(ids.includes(t1.id) && ids.includes(t2.id), "meeting_task_ids: the agenda's ids without cards (023)");
assert((await json("select cron_lease('t', 60)")) === true && (await json("select cron_lease('t', 60)")) === false, "cron_lease: one run at a time (023)");
assert(pack.releases.length === 1 && pack.releases[0].tasks.length === 1 && pack.releases[0].tasks[0].number === 1, "meeting_pack: upcoming release listed with its tasks");
// As of last week's (finalized) meeting only T-2 existed, it was pending and
// had been through no earlier meeting; T-1 was created this week.
const packOld = await json("select meeting_pack($1)", [m1.id]);
assert(packOld.pending.length === 1 && packOld.pending[0].number === 2 && packOld.pending[0].carry === 0 && packOld.done.length === 0,
  "meeting_pack (finalized, as-of its time): only T-2 pending, carry 0, nothing done");

// Series: a second series' meeting the day before must NOT shorten the weekly
// window, and carry-forward counts only meetings of the same series. A task
// pinned to a scoped meeting shows up even though its app is out of scope.
const ser = await one("insert into meeting_series (name) values ('Release review') returning id");
const other = await one("insert into meetings (title, held_at, series_id, app_ids, created_by) values ('Review', now() - interval '1 day', $1, '{}', $2) returning id", [ser.id, admin.id]);
const packSame = await json("select meeting_pack($1)", [m2.id]);
assert(packSame.done.length === 1 && packSame.carried.length === 1, "meeting_pack: other-series meeting does not change the weekly window");
const packOther = await json("select meeting_pack($1)", [other.id]);
assert(!packOther.pending.some((t) => t.number === 2), "meeting_pack: an attached general task stays in its own series");
// (017) An open meeting follows its SERIES' scope, so the narrow scope lives on a series of its own.
const serScoped = await one("insert into meeting_series (name, app_ids, include_general) values ('Scoped review', array[gen_random_uuid()], false) returning id, app_ids");
const scoped = await one("insert into meetings (title, held_at, series_id, app_ids, include_general, created_by) values ('Scoped', now(), $1, $2, false, $3) returning id", [serScoped.id, serScoped.app_ids, admin.id]);
const packScoped = await json("select meeting_pack($1)", [scoped.id]);
assert(packScoped.pending.length === 0 && packScoped.done.length === 0 && packScoped.apps.length === 0, "meeting_pack: scope filters tasks, done and apps");
await db.query("insert into meeting_tasks (meeting_id, task_id, added_by) values ($1, $2, $3)", [scoped.id, t2.id, admin.id]);
const packPinned = await json("select meeting_pack($1)", [scoped.id]);
assert(packPinned.pending.length === 1 && packPinned.pending[0].pinned === true && packPinned.pinned.length === 1, "meeting_pack: pinned task appears in a scoped meeting");
const gen = await one("insert into tasks (title, type, priority, created_by) values ('Renew Play console billing', 'bug', 'low', $1) returning id", [admin.id]);
const packNoGen = await json("select meeting_pack($1)", [scoped.id]);
assert(packNoGen.pending.length === 1, "meeting_pack: a general task is not swept into a meeting by scope");
await db.query("update meetings set include_general = true where id = $1", [scoped.id]);
assert((await json("select meeting_pack($1)", [scoped.id])).pending.length === 1, "meeting_pack: include_general no longer pulls general tasks in");
await db.query("update tasks set series_id = $1 where id = $2", [serScoped.id, gen.id]);
const packGen = await json("select meeting_pack($1)", [scoped.id]);
assert(packGen.pending.length === 2 && packGen.pending.some((t) => !t.app && t.series?.id === serScoped.id), "meeting_pack: a general task attached to the series joins its meetings");
assert((await json("select meeting_pack($1)", [m2.id])).pending.every((t) => t.id !== gen.id), "meeting_pack: attachment is per series");
await db.query("update tasks set series_id = null where id = $1", [gen.id]);

// Visibility: an outsider (no app membership, nothing assigned) sees only general tasks.
const outsider = await one("insert into users (email, password_hash, first_name, last_name, role) values ('out@x.test', 'x', 'Out', 'Sider', 'member') returning id");
const visOut = (await db.query("select visible_task_ids($1) as id", [outsider.id])).rows.map((r) => r.id);
assert(!visOut.includes(t1.id) && !visOut.includes(t2.id), "visibility: outsider sees neither another app's task nor someone else's general task");
assert((await one("select task_visible($1, $2) as v", [t2.id, admin.id])).v === true, "visibility: a general task is visible to its assignee");
await db.query("update tasks set created_by = $1 where id = $2", [outsider.id, t2.id]);
assert((await one("select task_visible($1, $2) as v", [t2.id, outsider.id])).v === true, "visibility: a general task is visible to its creator");
await db.query("update tasks set created_by = $1 where id = $2", [admin.id, t2.id]);
assert((await one("select task_visible($1, $2) as v", [t1.id, dev.id])).v === true, "visibility: app member sees the app's task");
await db.query("delete from app_members where user_id = $1 and app_id = $2", [dev.id, app.id]);
assert((await one("select task_visible($1, $2) as v", [t1.id, dev.id])).v === false, "visibility: assignee taken off the app no longer sees its task");
await db.query("insert into app_members (app_id, user_id, app_role) values ($1, $2, 'developer')", [app.id, dev.id]);
const dashOut = await json("select dashboard_pack($1, false)", [outsider.id]);
assert(dashOut.counts.team_open === visOut.length - (await one("select count(*)::int as n from tasks where id = any($1::uuid[]) and status in ('done','cancelled')", [visOut])).n, "dashboard_pack: member team counts are scoped");
const anOut = await json("select analytics_pack((ist_today() - 180)::date, ist_today(), $1)", [outsider.id]);
assert(anOut.by_app.length === 0 && anOut.totals.done === 0, "analytics_pack: member sees no app they do not belong to");
await db.query("delete from users where id = $1", [outsider.id]);

const an = await json("select analytics_pack((ist_today() - 180)::date, ist_today())");
assert(an.range.bucket === "month" && an.periods.length >= 6 && an.totals.done === 1 && an.by_app.length === 1 && an.by_person.length === 3 && typeof an.by_app[0].periods === "object" && Array.isArray(an.cycle_buckets) && Array.isArray(an.aging) && typeof an.releases.released === "number", "analytics_pack range/periods/by_app/by_person/buckets");
const anWeek = await json("select analytics_pack((ist_today() - 27)::date, ist_today())");
assert(anWeek.range.bucket === "week" && anWeek.periods.length >= 4 && anWeek.periods.length <= 5, "analytics_pack: short ranges bucket by week");
await db.query("select apps_reorder(array[$1]::uuid[])", [apps[0].id]);
assert((await json("select apps_overview()"))[0].id === apps[0].id, "apps_reorder keeps the app first");
const rep = await json("select report_pack(current_date - 30, current_date)");
assert(rep.totals.done === 1 && rep.by_day.length === 31 && rep.people.length === 3, "report_pack totals/by_day/people");
assert(rep.by_day.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)), `report_pack by_day dates are plain YYYY-MM-DD (got ${rep.by_day[0]?.date})`);

const hit1 = await one("select throttle_hit('rl:test:u1:1') n");
const hit2 = await one("select throttle_hit('rl:test:u1:1') n");
assert(Number(hit1.n) === 1 && Number(hit2.n) === 2, "throttle_hit increments atomically");

// 009: arrays follow targets / assignees
const arr = await one("select app_ids, assignee_ids from tasks where id = $1", [t1.id]);
assert(arr.app_ids.length === 1 && arr.app_ids[0] === app.id && arr.assignee_ids.includes(dev.id), "tasks.app_ids / assignee_ids kept by triggers");
await db.query("delete from task_assignees where task_id = $1 and user_id = $2", [t1.id, dev.id]);
assert((await one("select assignee_ids from tasks where id = $1", [t1.id])).assignee_ids.length === 0, "assignee_ids shrinks on delete");
await db.query("insert into task_assignees (task_id, user_id, assigned_by) values ($1,$2,$2)", [t1.id, dev.id]);
assert((await one("select count(*)::int as n from tasks where app_ids = '{}'", [])).n >= 1, "general tasks have an empty app_ids");
// approve guard: an approval must match the live request
await db.query("select task_request_status($1,'done',$2,'please')", [t2.id, dev.id]);
try {
  await one("select * from task_apply_status($1,'cancelled',$2,'approve',null,null)", [t2.id, admin.id]);
  fail("approving a different status than requested should raise");
} catch (e) {
  assert(/request changed/.test(String(e.message)), "approve of a changed request raises P0003");
}
const ap = await one("select * from task_apply_status($1,'done',$2,'approve',null,null)", [t2.id, admin.id]);
assert(ap.status === "done" && ap.requested_status === null && ap.completed_at !== null, "approve applies the live request, completed at request time");
await one("select * from task_apply_status($1,'todo',$2,'change','reopen',null)", [t2.id, admin.id]);

const search = await db.query("select number from tasks where title ilike '%crash%'");
assert(search.rows.length === 1, "trigram-indexed ILIKE search");

// Lockdown: anon must see nothing.
await db.exec("set role anon");
try {
  await db.query("select count(*) from tasks");
  fail("anon can read tasks (lockdown broken)");
} catch {
  ok("anon has no access to tasks");
}
await db.exec("reset role");

// (016) renumbering closes gaps and the sequence continues from the top
{
  await db.query("update tasks set number = number + 40 where number = (select max(number) from tasks)");
  const moved = (await one("select tasks_renumber() as n", [])).n;
  const nums = await json("select jsonb_agg(number order by number) from tasks");
  assert(moved >= 1 && nums.every((v, i) => v === i + 1), `tasks_renumber closes gaps (${nums.join(",")})`);
  const fresh = await one("insert into tasks (title, created_by) values ('after renumber', $1) returning number", [admin.id]);
  assert(fresh.number === nums.length + 1, "task_sequence_reset: the next task continues the series");
  const cols = await json("select jsonb_agg(column_name) from information_schema.columns where table_name = 'apps' and column_name in ('icon_android_url','icon_ios_url')");
  assert(cols.length === 2, "apps carry a store icon per platform");
}
console.log(process.exitCode ? "\nFAILED" : "\nAll schema checks passed.");
await db.close();
