/**
 * What a signed-in person may see. Admins see the whole workspace. A member's
 * world is the apps they belong to: those apps, their releases, tasks that
 * target them, plus general (no-app) tasks. Nothing else — not even a task
 * they are assigned to on another app. The rule lives in SQL (task_visible / visible_task_ids /
 * visible_app_ids, migration 007) so lists and aggregates agree; these helpers
 * call it, with a plain-query fallback so a panel whose database has not been
 * migrated yet still answers correctly (and never shows more).
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
  if (error) return [...(await computeVisible(u.uid))];
  return ((data as string[] | { visible_task_ids: string }[] | null) || []).map((r) => (typeof r === "string" ? r : r.visible_task_ids));
}

export async function canSeeTask(u: SessionUser, taskId: string): Promise<boolean> {
  if (u.role === "admin") return true;
  const { data, error } = await getSupabase().rpc("task_visible", { p_task: taskId, p_user: u.uid });
  if (error) return (await computeVisible(u.uid)).has(taskId);
  return data === true;
}

/** The same rule as task_visible(), in queries, for a database without 007. */
async function computeVisible(uid: string): Promise<Set<string>> {
  const sb = getSupabase();
  const [all, targets, members] = await Promise.all([
    sb.from("tasks").select("id"),
    sb.from("task_targets").select("task_id, app_id"),
    sb.from("app_members").select("app_id").eq("user_id", uid),
  ]);
  const myApps = new Set((members.data || []).map((m) => m.app_id as string));
  const targeted = new Set<string>();
  const out = new Set<string>();
  for (const t of targets.data || []) {
    targeted.add(t.task_id as string);
    if (myApps.has(t.app_id as string)) out.add(t.task_id as string);
  }
  for (const t of all.data || []) if (!targeted.has(t.id as string)) out.add(t.id as string);
  return out;
}

/** tasks.app_ids / tasks.assignee_ids (migration 009) let the list filter in
 * SQL instead of shipping every visible id in the URL. Probed once a minute
 * so a panel ahead of its database still works. */
let arrays: { at: number; ok: boolean } | null = null;
export async function hasTaskArrays(): Promise<boolean> {
  if (arrays && Date.now() - arrays.at < 60_000) return arrays.ok;
  const { error } = await getSupabase().from("tasks").select("app_ids, assignee_ids").limit(1);
  arrays = { at: Date.now(), ok: !error };
  return arrays.ok;
}

/** tasks.series_id (migration 010). Probed once a minute. */
let seriesCol: { at: number; ok: boolean } | null = null;
export async function hasTaskSeries(): Promise<boolean> {
  if (seriesCol && Date.now() - seriesCol.at < 60_000) return seriesCol.ok;
  const { error } = await getSupabase().from("tasks").select("series_id").limit(1);
  seriesCol = { at: Date.now(), ok: !error };
  return seriesCol.ok;
}

/** A PostgREST `.in("id", …)` list that matches nothing when the member sees nothing. */
export const NONE_ID = "00000000-0000-0000-0000-000000000000";
