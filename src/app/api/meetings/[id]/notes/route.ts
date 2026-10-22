import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanText, isUuid, oneOf } from "@/lib/validate";
import { LIMITS, NOTE_KINDS, taskRef } from "@/lib/domain";
import { loadMeeting } from "@/lib/meetings";
import { loadOwnership, involved } from "@/lib/tasks";
import { notifyUsers } from "@/lib/notify";
import { displayName } from "@/lib/name";
import { rateLimited } from "@/lib/rate-limit";
import { USER_BRIEF_COLS, embedded, embeddedUser } from "@/lib/users";

export const dynamic = "force-dynamic";

/** Add a minute line: { body, kind?, task_id?, user_id? }. Anyone signed in;
 * closed meetings are read-only. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  if (u.role !== "admin") return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
  if (u.role !== "admin") return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return fail("Meeting not found", 404);
  const limited = await rateLimited(u.uid, "mom", 60, 60);
  if (limited) return limited;
  const m = await loadMeeting(id);
  if (!m) return fail("Meeting not found", 404);
  if (m.status === "finalized" && u.role !== "admin") return fail("This meeting is closed — only an admin can add notes", 403);

  const b = await readJsonObject(req);
  const body = cleanText(b.body, LIMITS.note);
  if (!body) return fail("Write the note first");
  const kind = oneOf(b.kind, NOTE_KINDS) ?? "note";
  const taskId = b.task_id ? (isUuid(b.task_id) ? String(b.task_id).toLowerCase() : null) : null;
  if (b.task_id && !taskId) return fail("Invalid task");
  const aboutId = b.user_id ? (isUuid(b.user_id) ? String(b.user_id).toLowerCase() : null) : null;
  if (b.user_id && !aboutId) return fail("Invalid person");
  const own = taskId ? await loadOwnership(taskId) : null;
  if (taskId && !own) return fail("Task not found", 404);

  const { data, error } = await getSupabase()
    .from("meeting_notes")
    .insert({ meeting_id: id, task_id: taskId, user_id: aboutId, kind, body, created_by: u.uid })
    .select(`id, task_id, kind, body, created_at, author:users!meeting_notes_created_by_fkey(${USER_BRIEF_COLS}), about:users!meeting_notes_user_id_fkey(${USER_BRIEF_COLS}), task:tasks(id, number, title, status)`)
    .single();
  if (error) return serverError(error);

  const actor = displayName(u.firstName, u.lastName) || u.email;
  after(async () => {
    await logActivity({ action: "meeting.note", entityType: "meeting", entityId: id, summary: `${kind} in “${m.title}”${own ? ` on ${taskRef(own.number)}` : ""}: ${body.slice(0, 80)}` });
    if (own) {
      await notifyUsers({ userIds: [...involved(own), aboutId], kind: "task.mom", taskId: own.id, actorId: u.uid, message: `${actor} noted on ${taskRef(own.number)} in the meeting: ${body.slice(0, 100)}` });
    } else if (aboutId) {
      await notifyUsers({ userIds: [aboutId], kind: "meeting.note", actorId: u.uid, message: `${actor} added a meeting ${kind} about you: ${body.slice(0, 100)}` });
    }
  });
  return NextResponse.json({
    note: {
      id: data.id,
      task_id: data.task_id ?? null,
      kind: data.kind,
      body: data.body,
      created_at: data.created_at,
      author: embeddedUser(data.author),
      about: embeddedUser(data.about),
      task: embedded<{ id: string; number: number; title: string; status: string }>(data.task),
    },
  });
}
