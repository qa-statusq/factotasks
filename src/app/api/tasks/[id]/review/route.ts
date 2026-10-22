import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject, memberJson } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanText, isNoData, isUuid } from "@/lib/validate";
import { STATUS_META, isTaskStatus, taskRef, LIMITS } from "@/lib/domain";
import { loadOwnership, loadCard, involved } from "@/lib/tasks";
import { canApprove } from "@/lib/task-access";
import { notifyUsers } from "@/lib/notify";
import { displayName } from "@/lib/name";

export const dynamic = "force-dynamic";

/**
 * Decide a pending status request. Body: { action: "approve" | "reject" | "withdraw", note? }.
 *  approve/reject — admins. withdraw — the member who asked (or an admin).
 * Approval back-dates completion to the REQUEST time: the work finished when
 * the member said so, not when the admin got to the queue.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Task not found", 404);
  const b = await readJsonObject(req);
  const action = b.action;
  if (action !== "approve" && action !== "reject" && action !== "withdraw") return fail("Invalid action");
  const note = cleanText(b.note, LIMITS.note) || null;

  const own = await loadOwnership(id);
  if (!own) return fail("Task not found", 404);
  if (!own.requested_status || !isTaskStatus(own.requested_status)) return fail("There is no pending request on this task");
  const to = own.requested_status;
  const sb = getSupabase();
  const actor = displayName(u.firstName, u.lastName) || u.email;

  if (action === "withdraw") {
    if (own.requested_by !== u.uid && !canApprove(u)) return fail("Only the requester can withdraw this request", 403);
    const { error } = await sb.rpc("task_clear_request", { p_task: id, p_actor: u.uid, p_kind: "withdraw", p_note: note });
    if (error) return isNoData(error) ? fail("Task not found", 404) : serverError(error);
    after(() => logActivity({ action: "task.withdraw", entityType: "task", entityId: id, summary: `Withdrew request on ${taskRef(own.number)}`, metadata: { number: own.number } }));
    return memberJson(u, { task: await loadCard(id), mode: "withdrawn" });
  }

  if (!canApprove(u)) return fail("Admin access required", 403);

  if (action === "approve") {
    const { error } = await sb.rpc("task_apply_status", {
      p_task: id,
      p_to: to,
      p_actor: u.uid,
      p_kind: "approve",
      p_note: note,
      p_completed_at: to === "done" ? own.requested_at : null, // the request time (009 also defaults to it)
    });
    if (error) {
      if (isNoData(error)) return fail("Task not found", 404);
      // Someone decided, withdrew or changed this request a moment ago.
      if ((error as { code?: string }).code === "P0003") return fail("This request was already decided — refresh to see the task", 409);
      return serverError(error);
    }
    const card = await loadCard(id);
    after(async () => {
      await logActivity({
        action: "task.approve",
        entityType: "task",
        entityId: id,
        summary: `Approved ${taskRef(own.number)} → ${STATUS_META[to].label}${note ? ` — ${note}` : ""}`,
        metadata: { number: own.number, to },
      });
      await notifyUsers({
        userIds: [own.requested_by, ...involved(own)],
        kind: "task.approved",
        taskId: id,
        actorId: u.uid,
        message: `${actor} approved ${taskRef(own.number)} “${own.title}” as ${STATUS_META[to].label}${note ? ` — ${note}` : ""}`,
      });
    });
    return memberJson(u, { task: card, mode: "approved" });
  }

  // reject
  const { error } = await sb.rpc("task_clear_request", { p_task: id, p_actor: u.uid, p_kind: "reject", p_note: note });
  if (error) return isNoData(error) ? fail("Task not found", 404) : serverError(error);
  const card = await loadCard(id);
  after(async () => {
    await logActivity({
      action: "task.reject",
      entityType: "task",
      entityId: id,
      summary: `Rejected ${taskRef(own.number)} → ${STATUS_META[to].label}${note ? ` — ${note}` : ""}`,
      metadata: { number: own.number, to },
    });
    await notifyUsers({
      userIds: [own.requested_by, ...involved(own)],
      kind: "task.rejected",
      taskId: id,
      actorId: u.uid,
      message: `${actor} sent ${taskRef(own.number)} “${own.title}” back${note ? `: ${note}` : " — please review"}`,
    });
  });
  return memberJson(u, { task: card, mode: "rejected" });
}
