import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject, memberJson } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanText, isNoData, isUuid } from "@/lib/validate";
import { STATUS_META, isTaskStatus, taskRef, LIMITS } from "@/lib/domain";
import { canSeeTask } from "@/lib/visibility";
import { loadOwnership, loadCard, involved } from "@/lib/tasks";
import { canChangeStatus } from "@/lib/task-access";
import { getSettings, needsApproval } from "@/lib/settings";
import { adminIds, notifyUsers } from "@/lib/notify";
import { displayName } from "@/lib/name";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Move a task's status. Admins apply directly; members apply directly or park
 * a REQUEST, depending on the approval policy. Body: { status, note? }.
 * Response: { task, mode: "applied" | "requested" }.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Task not found", 404);
  const limited = await rateLimited(u.uid, "status", 60, 60);
  if (limited) return limited;

  const b = await readJsonObject(req);
  const to = b.status;
  if (!isTaskStatus(to)) return fail("Pick a valid status");
  const note = cleanText(b.note, LIMITS.note) || null;

  const [own, visible, settings] = await Promise.all([loadOwnership(id), canSeeTask(u, id), getSettings(true)]);
  if (!own || !visible) return fail("Task not found", 404);
  if (!canChangeStatus(u, own)) return fail("Only an admin, the creator or an assignee can change this task's status", 403);
  if (to === own.status && !own.requested_status) return fail(`Already ${STATUS_META[to].label.toLowerCase()}`);

  const sb = getSupabase();
  const actor = displayName(u.firstName, u.lastName) || u.email;
  const isAdmin = u.role === "admin";
  const direct = isAdmin || !needsApproval(settings.approval_policy, to);

  if (direct) {
    const { error } = await sb.rpc("task_apply_status", { p_task: id, p_to: to, p_actor: u.uid, p_kind: "change", p_note: note, p_completed_at: null });
    if (error) return isNoData(error) ? fail("Task not found", 404) : (error as { code?: string }).code === "P0004" ? fail(`Already ${STATUS_META[to].label.toLowerCase()}`) : serverError(error);
    const card = await loadCard(id);
    after(async () => {
      await logActivity({
        action: "task.status",
        entityType: "task",
        entityId: id,
        summary: `${taskRef(own.number)} → ${STATUS_META[to].label}${note ? ` — ${note}` : ""}`,
        metadata: { number: own.number, from: own.status, to },
      });
      // Admin moved someone's task (or a request was superseded): tell them.
      await notifyUsers({
        userIds: involved(own),
        kind: "task.status",
        taskId: id,
        actorId: u.uid,
        message: `${actor} marked ${taskRef(own.number)} “${own.title}” as ${STATUS_META[to].label}`,
      });
    });
    return memberJson(u, { task: card, mode: "applied" });
  }

  // Member → approval request.
  const { error } = await sb.rpc("task_request_status", { p_task: id, p_to: to, p_actor: u.uid, p_note: note });
  if (error) return isNoData(error) ? fail("Task not found", 404) : serverError(error);
  const card = await loadCard(id);
  after(async () => {
    await logActivity({
      action: "task.request",
      entityType: "task",
      entityId: id,
      summary: `Requested ${taskRef(own.number)} → ${STATUS_META[to].label}${note ? ` — ${note}` : ""}`,
      metadata: { number: own.number, from: own.status, to },
    });
    await notifyUsers({
      userIds: await adminIds(),
      kind: "task.requested",
      taskId: id,
      actorId: u.uid,
      message: `${actor} wants ${taskRef(own.number)} “${own.title}” marked ${STATUS_META[to].label} — needs your approval`,
    });
  });
  return memberJson(u, { task: card, mode: "requested" });
}
