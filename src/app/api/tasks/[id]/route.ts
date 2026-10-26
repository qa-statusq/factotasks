import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject, memberJson } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid } from "@/lib/validate";
import { taskRef } from "@/lib/domain";
import { taskPatch, validateTaskRefs, syncTargets, loadOwnership, loadCard, involved } from "@/lib/tasks";
import { canSeeTask, visibleAppIds, hasTaskSeries, hasNoteLinks } from "@/lib/visibility";
import { canApprove, canChangeStatus, canDeleteTask, canEditTask } from "@/lib/task-access";
import { getSettings, needsApproval } from "@/lib/settings";
import { notifyUsers } from "@/lib/notify";
import { displayName } from "@/lib/name";
import { USER_BRIEF_COLS, embedded, embeddedUser } from "@/lib/users";
import type { TaskCard, TaskDetail } from "@/lib/types";

export const dynamic = "force-dynamic";

const NOTE_COLS = `id, kind, body, created_at, author:users!meeting_notes_created_by_fkey(${USER_BRIEF_COLS}), meeting:meetings(id, title, held_at)` as const;
const NOTE_COLS_WITH_LINKS = `id, kind, body, link_url, link_label, created_at, author:users!meeting_notes_created_by_fkey(${USER_BRIEF_COLS}), meeting:meetings(id, title, held_at)` as const; // once 018 is applied

/** Resolve a task id OR its human number (T-12 → /tasks/12) to the uuid. */
async function resolveId(idOrNumber: string): Promise<string | null> {
  if (isUuid(idOrNumber)) return idOrNumber.toLowerCase();
  const m = /^(?:T-?)?(\d{1,9})$/i.exec(idOrNumber);
  if (!m) return null;
  const { data } = await getSupabase().from("tasks").select("id").eq("number", Number(m[1])).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/** Full task: card + description + timeline + comments + attachments + MOM
 * notes, and what THIS caller may do. Five independent reads in parallel. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id: raw } = await params;
  const id = await resolveId(raw);
  if (!id) return fail("Task not found", 404);
  const sb = getSupabase();

  const isAdmin = u.role === "admin";
  const none = Promise.resolve({ data: [] as never[], error: null });
  const links = isAdmin && (await hasNoteLinks()); // 018 columns, once applied
  const [main, log, comments, attachments, notes, pins, settings, visible] = await Promise.all([
    sb.from("tasks").select(`task_card, description, created_by, status, approver:users!tasks_approved_by_fkey(${USER_BRIEF_COLS})`).eq("id", id).maybeSingle(),
    sb.from("task_status_log").select(`id, kind, from_status, to_status, note, created_at, actor:users(${USER_BRIEF_COLS})`).eq("task_id", id).order("created_at", { ascending: false }).limit(200),
    sb.from("task_comments").select(`id, body, created_at, edited_at, author:users(${USER_BRIEF_COLS})`).eq("task_id", id).order("created_at", { ascending: true }).limit(500),
    sb.from("task_attachments").select(`id, file_name, mime, size_bytes, width, height, created_at, uploader:users(${USER_BRIEF_COLS})`).eq("task_id", id).order("created_at", { ascending: true }),
    isAdmin ? sb.from("meeting_notes").select((links ? NOTE_COLS_WITH_LINKS : NOTE_COLS) as typeof NOTE_COLS_WITH_LINKS).eq("task_id", id).order("created_at", { ascending: false }).limit(100) : none,
    isAdmin ? sb.from("meeting_tasks").select("created_at, meeting:meetings(id, title, held_at, status, series:meeting_series(name, color))").eq("task_id", id).order("created_at", { ascending: false }).limit(50) : none,
    getSettings(),
    canSeeTask(u, id),
  ]);
  if (main.error) return serverError(main.error);
  if (!main.data || !visible) return fail("Task not found", 404);
  for (const r of [log, comments, attachments, notes, pins]) if (r.error) return serverError(r.error);

  const card = main.data.task_card as TaskCard;
  const ownership = { created_by: main.data.created_by as string | null, status: main.data.status as string, assignee_ids: card.assignees.map((a) => a.id) };
  const detail: TaskDetail = {
    ...card,
    description: (main.data.description as string | null) ?? null,
    approved_by: embeddedUser(main.data.approver),
    log: (log.data || []).map((r) => ({
      id: r.id as string,
      kind: r.kind as TaskDetail["log"][number]["kind"],
      from_status: (r.from_status as TaskCard["status"] | null) ?? null,
      to_status: (r.to_status as TaskCard["status"] | null) ?? null,
      note: (r.note as string | null) ?? null,
      created_at: r.created_at as string,
      actor: embeddedUser(r.actor),
    })),
    comments: (comments.data || []).map((r) => ({
      id: r.id as string,
      body: r.body as string,
      created_at: r.created_at as string,
      edited_at: (r.edited_at as string | null) ?? null,
      author: embeddedUser(r.author),
    })),
    attachments: (attachments.data || []).map((r) => ({
      id: r.id as string,
      file_name: r.file_name as string,
      mime: r.mime as string,
      size_bytes: r.size_bytes as number,
      width: (r.width as number | null) ?? null,
      height: (r.height as number | null) ?? null,
      created_at: r.created_at as string,
      uploaded_by: embeddedUser(r.uploader),
    })),
    meeting_notes: (notes.data || []).map((r) => ({
      id: r.id as string,
      kind: r.kind as TaskDetail["meeting_notes"][number]["kind"],
      body: r.body as string,
      link_url: (r.link_url as string | null) ?? null,
      link_label: (r.link_label as string | null) ?? null,
      created_at: r.created_at as string,
      author: embeddedUser(r.author),
      meeting: embedded<{ id: string; title: string; held_at: string }>(r.meeting) ?? { id: "", title: "Meeting", held_at: r.created_at as string },
    })),
    meetings: (pins.data || [])
      .map((r) => embedded<{ id: string; title: string; held_at: string; status: "open" | "finalized"; series: unknown }>(r.meeting))
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => ({ id: m.id, title: m.title, held_at: m.held_at, status: m.status, series: embedded<{ name: string; color: string }>(m.series) }))
      .sort((a, b) => b.held_at.localeCompare(a.held_at)),
    can: {
      edit: canEditTask(u, ownership),
      delete: canDeleteTask(u, ownership),
      status: canChangeStatus(u, ownership),
      approve: canApprove(u),
      // Members: would a move to "done" wait for approval under the policy?
      needs_approval: u.role !== "admin" && needsApproval(settings.approval_policy, "done"),
    },
  };
  return memberJson(u, { task: detail });
}

/** Edit fields (admin, creator or assignee). Status changes go via /status. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id: raw } = await params;
  const id = await resolveId(raw);
  if (!id) return fail("Task not found", 404);
  const own = await loadOwnership(id);
  if (!own) return fail("Task not found", 404);
  if (!canEditTask(u, own)) return fail("You can only edit tasks you created or are assigned to", 403);

  const b = await readJsonObject(req);
  const v = taskPatch(b, true);
  if ("error" in v) return fail(v.error);
  if (Object.keys(v.patch).length === 0 && !v.assignees) return fail("Nothing to update");
  if (!(await canSeeTask(u, id))) return fail("Task not found", 404);
  const refErr = await validateTaskRefs(v.patch, v.assignees, { id }, await visibleAppIds(u));
  if (refErr) return fail(refErr);

  const sb = getSupabase();
  const { targets, ...cols } = v.patch;
  if ("series_id" in cols && !(await hasTaskSeries())) {
    if (cols.series_id) return fail("Attaching tasks to meetings needs the latest database update (migration 010)");
    delete cols.series_id;
  }
  if (Object.keys(cols).length) {
    const { error } = await sb.from("tasks").update(cols).eq("id", id);
    if (error) return serverError(error);
  }
  if (targets) await syncTargets(id, targets);
  let added: string[] = [];
  if (v.assignees) {
    const next = new Set(v.assignees);
    const cur = new Set(own.assignee_ids);
    added = [...next].filter((x) => !cur.has(x));
    const removed = [...cur].filter((x) => !next.has(x));
    if (removed.length) await sb.from("task_assignees").delete().eq("task_id", id).in("user_id", removed);
    if (added.length) await sb.from("task_assignees").insert(added.map((uid) => ({ task_id: id, user_id: uid, assigned_by: u.uid })));
  }
  const card = await loadCard(id);
  const actor = displayName(u.firstName, u.lastName) || u.email;
  const fields = [...Object.keys(v.patch), ...(v.assignees ? ["assignees"] : [])];
  after(async () => {
    await logActivity({ action: "task.update", entityType: "task", entityId: id, summary: `Edited ${taskRef(own.number)} (${fields.join(", ")})`, metadata: { number: own.number } });
    if (added.length) {
      await notifyUsers({ userIds: added, kind: "task.assigned", taskId: id, actorId: u.uid, message: `${actor} assigned you ${taskRef(own.number)} “${own.title}”` });
    }
  });
  return memberJson(u, { task: card });
}

/** Delete (admin; creator while still "todo"). */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id: raw } = await params;
  const id = await resolveId(raw);
  if (!id) return fail("Task not found", 404);
  const own = await loadOwnership(id);
  if (!own) return fail("Task not found", 404);
  if (!canDeleteTask(u, own)) return fail("Only an admin can delete a task once work has started", 403);
  // Attachments in storage go first (the DB rows cascade with the task).
  const sb = getSupabase();
  const { data: files } = await sb.from("task_attachments").select("storage_path").eq("task_id", id);
  if (files?.length) {
    const { error: sErr } = await sb.storage.from("attachments").remove(files.map((f) => f.storage_path as string));
    if (sErr) console.error("[tasks] attachment cleanup failed:", sErr);
  }
  const { error } = await sb.from("tasks").delete().eq("id", id);
  if (error) return serverError(error);
  after(() =>
    logActivity({ action: "task.delete", entityType: "task", entityId: id, summary: `Deleted ${taskRef(own.number)} “${own.title}”`, metadata: { number: own.number } })
  );
  // Involved people (minus the actor) hear about it.
  after(() =>
    notifyUsers({ userIds: involved(own), kind: "task.deleted", taskId: null, actorId: u.uid, message: `${displayName(u.firstName, u.lastName) || u.email} deleted ${taskRef(own.number)} “${own.title}”` })
  );
  return ok();
}
