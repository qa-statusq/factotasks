import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid } from "@/lib/validate";
import { loadMeeting } from "@/lib/meetings";
import { taskRef } from "@/lib/domain";
import { canAccessMeeting } from "@/lib/series-access";
import { canSeeTask } from "@/lib/visibility";

export const dynamic = "force-dynamic";

async function guard(params: Promise<{ id: string }>, req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return { res: u };
  const { id } = await params;
  if (!isUuid(id)) return { res: fail("Meeting not found", 404) };
  const m = await loadMeeting(id);
  if (!m) return { res: fail("Meeting not found", 404) };
  if (!(await canAccessMeeting(u, m))) return { res: NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 }) };
  if (m.status === "finalized" && u.role !== "admin") return { res: fail("This meeting is closed", 403) };
  const b = await readJsonObject(req);
  if (!isUuid(b.task_id)) return { res: fail("Pick a task") };
  const { data: t } = await getSupabase().from("tasks").select("id, number, title").eq("id", b.task_id).maybeSingle();
  if (!t || !(await canSeeTask(u, t.id as string))) return { res: fail("Task not found", 404) };
  return { u, m, t: t as { id: string; number: number; title: string } };
}

/** Pin a task to this meeting. Body: { task_id } */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(params, req);
  if ("res" in g) return g.res;
  const { error } = await getSupabase().from("meeting_tasks").upsert({ meeting_id: g.m.id, task_id: g.t.id, added_by: g.u.uid }, { onConflict: "meeting_id,task_id", ignoreDuplicates: true });
  if (error) return serverError(error);
  after(() => logActivity({ action: "meeting.pin", entityType: "meeting", entityId: g.m.id, summary: `Added ${taskRef(g.t.number)} to “${g.m.title}”` }));
  return ok();
}

/** Unpin (admin). Body: { task_id } */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(params, req);
  if ("res" in g) return g.res;
  if (g.u.role !== "admin") return fail("Only an admin can remove a task from a meeting", 403);
  const { error } = await getSupabase().from("meeting_tasks").delete().eq("meeting_id", g.m.id).eq("task_id", g.t.id);
  if (error) return serverError(error);
  after(() => logActivity({ action: "meeting.unpin", entityType: "meeting", entityId: g.m.id, summary: `Removed ${taskRef(g.t.number)} from “${g.m.title}”` }));
  return ok();
}
