import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { serverError, readJsonObject, fail, memberJson } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { decodeCursor, encodeCursor, tsIdKeysetDesc } from "@/lib/keyset";
import { isUuid, oneOf } from "@/lib/validate";
import { OPEN_STATUSES, PRIORITIES, TASK_STATUSES, TASK_TYPES, taskRef } from "@/lib/domain";
import { visibleAppIds, NONE_ID } from "@/lib/visibility";
import { istToday } from "@/lib/ist";
import { canAccessMeeting, canAccessSeries } from "@/lib/series-access";
import { rateLimited } from "@/lib/rate-limit";
import { taskPatch, validateTaskRefs, syncTargets, linkTargetToRelease, loadCard } from "@/lib/tasks";
import { notifyUsers } from "@/lib/notify";
import { displayName } from "@/lib/name";
import type { TaskCard } from "@/lib/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const MAX_PAGE = 100;

/** Escape LIKE wildcards in user text so "100%" searches for a literal "100%". */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Task list. Filters compose freely:
 *   scope=open|all|done|closed|mine|approvals   (default open)
 *   status=a,b   app=<uuid>|general   assignee=<uuid>|me|none   priority=…  type=…
 *   platform=…   label=…   release=<uuid>   due=overdue|today|week|none
 *   q=<text or T-12>   sort=updated|created|due|priority|number
 * Keyset-paginated on (updated_at, id) / (number) for the default sorts; the
 * due/priority sorts (nullable, non-unique keys) use range paging over the
 * already-filtered, bounded set.
 */
export async function GET(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const sp = new URL(req.url).searchParams;
  const sb = getSupabase();

  const scope = sp.get("scope") || "open";
  const sort = oneOf(sp.get("sort"), ["updated", "created", "due", "priority", "number"] as const) ?? (scope === "done" || scope === "closed" ? "updated" : "updated");
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(sp.get("limit")) || PAGE_SIZE));
  const cursor = decodeCursor(sp.get("cursor"));
  const offset = Math.max(0, Number(sp.get("offset")) || 0);

  const assignee = sp.get("assignee");
  const assigneeId = assignee === "me" ? u.uid : isUuid(assignee) ? assignee!.toLowerCase() : scope === "mine" ? u.uid : null;

  // The computed column task_card() is the card; the bare columns exist only
  // so the keyset cursor can be built from the LAST row without re-parsing
  // JSON. Filtering by assignee needs an INNER embed of task_assignees. The
  // select is typed as a plain string on purpose: postgrest-js tries to parse
  // literal select strings at the type level and chokes on the embed syntax.
  // App / platform / release filters go through task_targets (a task can ship
  // on many apps); an INNER embed keeps only tasks with a matching target.
  const appParam = sp.get("app");
  const platformParam = oneOf(sp.get("platform"), ["android", "ios"] as const);
  const releaseParam = sp.get("release");
  const needTargets = isUuid(appParam) || !!platformParam || isUuid(releaseParam);
  const SELECT: string = ["task_card, updated_at, created_at, id, number", assigneeId ? "task_assignees!inner(user_id)" : "", needTargets ? "task_targets!inner(app_id, platform, release_id)" : ""].filter(Boolean).join(", ");
  let q = sb.from("tasks").select(SELECT);

  // ---- visibility (members: general tasks + tasks on their apps) ----
  if (u.role !== "admin") {
    const apps = (await visibleAppIds(u)) ?? [];
    // App tasks on their apps, plus general tasks they are assigned to or created.
    const general = `and(app_ids.eq.{},or(assignee_ids.cs.{${u.uid}},created_by.eq.${u.uid}))`;
    q = apps.length ? q.or(`app_ids.ov.{${apps.join(",")}},${general}`) : q.or(general);
  }

  // ---- status ----
  const statusParam = (sp.get("status") || "").split(",").map((s) => s.trim()).filter((s) => (TASK_STATUSES as readonly string[]).includes(s));
  if (statusParam.length) q = q.in("status", statusParam);
  else if (scope === "open" || scope === "mine") q = q.in("status", [...OPEN_STATUSES]);
  else if (scope === "done") q = q.eq("status", "done");
  else if (scope === "closed") q = q.in("status", ["done", "cancelled"]);
  if (scope === "approvals") {
    if (u.role !== "admin") return fail("Admin access required", 403);
    q = q.not("requested_status", "is", null);
  }

  // ---- who / what ----
  if (assigneeId) q = q.eq("task_assignees.user_id", assigneeId);
  if (assignee === "none") q = q.eq("assignee_ids", "{}");
  if (appParam === "general") q = q.is("app_id", null);
  else if (isUuid(appParam)) q = q.eq("task_targets.app_id", appParam!.toLowerCase());
  if (isUuid(releaseParam)) q = q.eq("task_targets.release_id", releaseParam!.toLowerCase());
  // Meeting-wise: everything on that meeting's agenda (pending, done in its
  // window, awaiting approval, pinned), resolved through the same pack the
  // meeting page uses so the two never disagree.
  const meeting = sp.get("meeting");
  if (isUuid(meeting)) {
    // Admins, and the members of the meeting's series (their list is already cut to what they may see).
    const { data: mt } = await sb.from("meetings").select("series_id").eq("id", meeting).maybeSingle();
    const allowed = !!mt && (await canAccessMeeting(u, mt as { series_id?: string | null }));
    const { data: rows } = allowed ? await sb.rpc("meeting_task_ids", { p_meeting: meeting }) : { data: null };
    const ids = ((rows as (string | { meeting_task_ids: string })[] | null) ?? []).map((r) => (typeof r === "string" ? r : r.meeting_task_ids));
    q = q.in("id", ids.length ? ids : [NONE_ID]);
  }
  const priority = oneOf(sp.get("priority"), PRIORITIES);
  if (priority) q = q.eq("priority", priority);
  const type = oneOf(sp.get("type"), TASK_TYPES);
  if (type) q = q.eq("type", type);
  if (platformParam) q = q.eq("task_targets.platform", platformParam);
  const label = (sp.get("label") || "").trim().toLowerCase().slice(0, 24);
  if (label) q = q.contains("labels", [label]);
  const creator = sp.get("creator");
  if (creator === "me") q = q.eq("created_by", u.uid);
  else if (isUuid(creator)) q = q.eq("created_by", creator!.toLowerCase());

  // ---- kind (app / general) and meeting-series attachment ----
  // tasks.app_id is the summary column: null exactly when there are no targets.
  const kind = oneOf(sp.get("kind"), ["app", "general"] as const);
  if (kind === "app") q = q.not("app_id", "is", null);
  else if (kind === "general") q = q.is("app_id", null);
  const series = sp.get("series");
  if (series) {
    if (series === "none") q = q.is("series_id", null);
    else if (series === "any") q = q.not("series_id", "is", null);
    else if (isUuid(series)) q = q.eq("series_id", series!.toLowerCase());
  }

  // ---- due ----
  const due = sp.get("due");
  const today = istToday();
  if (due === "overdue") q = q.lt("due_date", today);
  else if (due === "today") q = q.eq("due_date", today);
  else if (due === "week") q = q.gte("due_date", today).lt("due_date", new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10));
  else if (due === "none") q = q.is("due_date", null);
  else if (due === "any") q = q.not("due_date", "is", null);

  // ---- search ----
  const text = (sp.get("q") || "").trim().slice(0, 120);
  if (text) {
    const m = /^#?T?-?(\d{1,9})$/i.exec(text);
    if (m) q = q.eq("number", Number(m[1]));
    else q = q.ilike("title", `%${likeEscape(text)}%`);
  }

  // ---- order + paging ----
  const keyset = sort === "updated" || sort === "created" || sort === "number";
  if (sort === "updated") {
    q = q.order("updated_at", { ascending: false }).order("id", { ascending: false });
    if (cursor?.c && cursor.i) q = q.or(tsIdKeysetDesc("updated_at", { c: cursor.c, i: cursor.i }));
  } else if (sort === "created") {
    q = q.order("created_at", { ascending: false }).order("id", { ascending: false });
    if (cursor?.c && cursor.i) q = q.or(tsIdKeysetDesc("created_at", { c: cursor.c, i: cursor.i }));
  } else if (sort === "number") {
    q = q.order("number", { ascending: false });
    if (typeof cursor?.n === "number") q = q.lt("number", cursor.n);
  } else if (sort === "due") {
    q = q.order("due_date", { ascending: true, nullsFirst: false }).order("number", { ascending: false }).range(offset, offset + limit);
  } else {
    // priority: urgent first. Ordering by a CASE isn't expressible through
    // PostgREST, so sort the (bounded) page server-side after fetching.
    q = q.order("updated_at", { ascending: false }).range(offset, offset + limit);
  }
  if (keyset) q = q.limit(limit + 1);

  const { data, error } = await q;
  if (error) return serverError(error);
  const rows = (data || []) as unknown as { task_card: TaskCard; updated_at: string; created_at: string; id: string; number: number }[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  let tasks = page.map((r) => r.task_card);
  if (sort === "priority") {
    const rank: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
    tasks = [...tasks].sort((a, b) => rank[a.priority] - rank[b.priority] || (a.due_date || "9").localeCompare(b.due_date || "9"));
  }
  const last = page[page.length - 1];
  let nextCursor: string | null = null;
  if (hasMore && last) {
    if (sort === "updated") nextCursor = encodeCursor({ c: last.updated_at, i: last.id });
    else if (sort === "created") nextCursor = encodeCursor({ c: last.created_at, i: last.id });
    else if (sort === "number") nextCursor = encodeCursor({ n: last.number });
  }
  return memberJson(u, { tasks, hasMore, nextCursor, nextOffset: keyset ? null : hasMore ? offset + limit : null });
}

/** Create a task (any signed-in user). */
export async function POST(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const limited = await rateLimited(u.uid, "task", 60, 60);
  if (limited) return limited;
  const b = await readJsonObject(req);
  const v = taskPatch(b, false);
  if ("error" in v) return fail(v.error);
  if (v.patch.series_id && !(await canAccessSeries(u, v.patch.series_id))) return fail("You can attach a task only to a meeting series you take part in");
  const refErr = await validateTaskRefs(v.patch, v.assignees, undefined, await visibleAppIds(u));
  if (refErr) return fail(refErr);

  const sb = getSupabase();
  const { targets, ...cols } = v.patch;
  const { data: row, error } = await sb
    .from("tasks")
    .insert({ ...cols, created_by: u.uid })
    .select("id, number, title")
    .single();
  if (error) return serverError(error);
  const assignees = v.assignees ?? [];
  const [, aRes] = await Promise.all([
    syncTargets(row.id, targets ?? [], true),
    assignees.length ? sb.from("task_assignees").upsert(assignees.map((id) => ({ task_id: row.id, user_id: id, assigned_by: u.uid })), { onConflict: "task_id,user_id", ignoreDuplicates: true }) : Promise.resolve({ error: null }),
  ]);
  if (aRes.error) return serverError(aRes.error);
  // Created from a release sheet: put the matching target in that version.
  if (isUuid(b.release_id)) await linkTargetToRelease(row.id, String(b.release_id));
  const card = await loadCard(row.id);

  const actor = displayName(u.firstName, u.lastName) || u.email;
  after(async () => {
    await logActivity({
      action: "task.create",
      entityType: "task",
      entityId: row.id,
      summary: `Created ${taskRef(row.number)} “${row.title}”`,
      metadata: { number: row.number, assignees: assignees.length },
    });
    await notifyUsers({
      userIds: assignees,
      kind: "task.assigned",
      taskId: row.id,
      actorId: u.uid,
      message: `${actor} assigned you ${taskRef(row.number)} “${row.title}”`,
    });
  });
  return memberJson(u, { task: card });
}
