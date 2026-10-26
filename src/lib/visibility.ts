/**
 * What a signed-in person may see. Admins see the whole workspace. A member's
 * world is the apps they belong to: those apps, their releases, tasks that
 * target them, plus general (no-app) tasks they are assigned to or created.
 * Nothing else — not even a task they are assigned to on another app. The rule
 * lives in SQL (task_visible / visible_task_ids / visible_app_ids) so lists and
 * aggregates agree; these helpers call it and fail CLOSED on a database error
 * (a member is shown nothing rather than everything).
 */
import { getSupabase } from "./supabase";
import type { SessionUser } from "./auth";

/** null = unrestricted (admin); otherwise the app ids the member belongs to. */
export async function visibleAppIds(u: SessionUser): Promise<string[] | null> {
  if (u.role === "admin") return null;
  const { data } = await getSupabase().from("app_members").select("app_id").eq("user_id", u.uid);
  return (data || []).map((r) => r.app_id as string);
}

export async function canSeeApp(u: SessionUser, appId: string): Promise<boolean> {
  const ids = await visibleAppIds(u);
  return ids === null || ids.includes(appId);
}

/** null = unrestricted; otherwise the task ids this member may see. */
export async function visibleTaskIds(u: SessionUser): Promise<string[] | null> {
  if (u.role === "admin") return null;
  const { data, error } = await getSupabase().rpc("visible_task_ids", { p_user: u.uid });
  if (error) {
    console.error("[visibility] visible_task_ids:", error);
    return [];
  }
  return ((data as string[] | { visible_task_ids: string }[] | null) || []).map((r) => (typeof r === "string" ? r : r.visible_task_ids));
}

export async function canSeeTask(u: SessionUser, taskId: string): Promise<boolean> {
  if (u.role === "admin") return true;
  const { data, error } = await getSupabase().rpc("task_visible", { p_task: taskId, p_user: u.uid });
  if (error) {
    console.error("[visibility] task_visible:", error);
    return false;
  }
  return data === true;
}

/** A PostgREST `.in("id", …)` list that matches nothing when the member sees nothing. */
export const NONE_ID = "00000000-0000-0000-0000-000000000000";
