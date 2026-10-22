import { getSupabase } from "./supabase";
import { pushToUsers } from "./push";

/**
 * Notifications: an in-app inbox row for every recipient PLUS a browser push
 * to each of their subscribed devices (phones included, when the panel is
 * installed). Best-effort: never throws, never blocks the action that
 * triggered it (callers wrap it in after()). The actor never notifies
 * themself; recipients are de-duplicated.
 */
export async function notifyUsers(input: {
  userIds: (string | null | undefined)[];
  kind: string;
  taskId?: string | null;
  actorId?: string | null;
  message: string;
  /** Push title (defaults per kind). */
  title?: string;
  /** Tap target; defaults to the task page when there is one. */
  url?: string;
}): Promise<void> {
  try {
    const seen = new Set<string>();
    const rows = [];
    for (const id of input.userIds) {
      if (!id || id === input.actorId || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        user_id: id,
        kind: input.kind,
        task_id: input.taskId ?? null,
        actor_id: input.actorId ?? null,
        message: input.message.slice(0, 300),
      });
    }
    if (!rows.length) return;
    await getSupabase().from("notifications").insert(rows);
    await pushToUsers([...seen], {
      title: input.title ?? TITLE_FOR[input.kind] ?? "FactoTasks",
      body: input.message.slice(0, 180),
      url: input.url ?? (input.taskId ? `/tasks/${input.taskId}` : "/notifications"),
      tag: input.taskId ? `task-${input.taskId}` : input.kind,
    });
  } catch (e) {
    console.error("[notify] failed:", input.kind, e);
  }
}

const TITLE_FOR: Record<string, string> = {
  "task.assigned": "New task for you",
  "task.requested": "Approval needed",
  "task.approved": "Approved",
  "task.rejected": "Sent back",
  "task.comment": "New comment",
  "task.status": "Status changed",
  "task.attachment": "New attachment",
  "task.deleted": "Task deleted",
  "task.due": "Due date reminder",
  "task.mom": "Meeting note",
  "meeting.note": "Meeting note",
  "release.requested": "Release approval needed",
  "release.rejected": "Release sent back",
  "release.released": "Released",
};

/** Every admin's id (for "needs your approval" fan-out). */
export async function adminIds(): Promise<string[]> {
  const { data } = await getSupabase().from("users").select("id").eq("role", "admin").eq("is_active", true);
  return (data || []).map((r) => r.id as string);
}

/** Trim notifications older than `days` (best-effort housekeeping). */
export async function purgeOldNotifications(days = 60): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    await getSupabase().from("notifications").delete().lt("created_at", cutoff);
  } catch (e) {
    console.error("[notify] purge failed:", e);
  }
}
