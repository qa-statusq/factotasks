/**
 * Task helpers shared by the task routes: field validation, the ownership
 * read the permission rules need, and the "who should hear about this" fan-out.
 */
import { getSupabase } from "./supabase";
import { cleanLine, cleanText, isUuid, oneOf, parseDate, parseLabels, parseNumber, parseUuidList } from "./validate";
import { LIMITS, PRIORITIES, TASK_TYPES } from "./domain";
import type { TaskOwnership } from "./task-access";
import type { TaskCard } from "./types";

export interface TaskPatch {
  title?: string;
  description?: string | null;
  type?: string;
  priority?: string;
  due_date?: string | null;
  labels?: string[];
  estimate_hours?: number | null;
  /** Meeting series the task is attached to (null = none). */
  series_id?: string | null;
  /** Where it ships. "both" expands to the platforms the app has (validateTaskRefs). */
  targets?: { app_id: string; platform: "android" | "ios" | "both" }[];
}

/** Validate the editable task fields. `partial` = only keys present in `b`.
 * Returns the cleaned patch + assignee list (undefined = not supplied). */
export function taskPatch(
  b: Record<string, unknown>,
  partial: boolean
): { patch: TaskPatch; assignees?: string[] } | { error: string } {
  const patch: TaskPatch = {};
  const has = (k: string) => !partial || k in b;

  if (has("title")) {
    const title = cleanLine(b.title, LIMITS.title);
    if (!title) return { error: "Give the task a title" };
    patch.title = title;
  }
  if (has("description")) patch.description = cleanText(b.description, LIMITS.description) || null;
  if (has("type") && (partial || b.type !== undefined)) {
    const t = oneOf(b.type, TASK_TYPES);
    if (!t) return { error: "Pick a valid type" };
    patch.type = t;
  }
  if (has("priority") && (partial || b.priority !== undefined)) {
    const p = oneOf(b.priority, PRIORITIES);
    if (!p) return { error: "Pick a valid priority" };
    patch.priority = p;
  }
  if (has("due_date")) {
    if (b.due_date != null && b.due_date !== "" && !parseDate(b.due_date)) return { error: "Due date must be a valid date" };
    patch.due_date = parseDate(b.due_date);
  }
  if (has("labels")) patch.labels = parseLabels(b.labels ?? [], LIMITS.label, LIMITS.labelsPerTask);
  if (has("estimate_hours")) {
    if (b.estimate_hours != null && b.estimate_hours !== "" && parseNumber(b.estimate_hours, 0, 9999) === null) {
      return { error: "Estimate must be a number of hours" };
    }
    patch.estimate_hours = parseNumber(b.estimate_hours, 0, 9999);
  }
  if (has("series_id") && (partial || b.series_id !== undefined)) {
    if (b.series_id != null && b.series_id !== "" && !isUuid(b.series_id)) return { error: "Invalid meeting series" };
    patch.series_id = b.series_id ? String(b.series_id).toLowerCase() : null;
  }
  let assignees: string[] | undefined;
  if (has("assignee_ids")) {
    const ids = parseUuidList(b.assignee_ids ?? [], LIMITS.assigneesPerTask);
    if (!ids) return { error: `Up to ${LIMITS.assigneesPerTask} valid assignees` };
    assignees = ids;
  }
  if (has("targets") && b.targets !== undefined) {
    if (!Array.isArray(b.targets)) return { error: "Invalid targets" };
    const seen = new Set<string>();
    const out: NonNullable<TaskPatch["targets"]> = [];
    for (const raw of (b.targets as unknown[]).slice(0, 60)) {
      const r = (raw ?? {}) as Record<string, unknown>;
      if (!isUuid(r.app_id)) return { error: "Invalid target app" };
      const pl = oneOf(r.platform, ["android", "ios", "both"] as const);
      if (!pl) return { error: "Each target needs Android or iOS" };
      const appId = String(r.app_id).toLowerCase();
      if (!seen.has(`${appId}:${pl}`)) {
        seen.add(`${appId}:${pl}`);
        out.push({ app_id: appId, platform: pl });
      }
    }
    patch.targets = out;
  }
  return { patch, assignees };
}

/** Every target's app must exist, not be archived (for new work), and ship on
 * that platform. "both" expands to the platforms the app has. Assignees must
 * be members of at least one target app (general tasks: anyone). `current`
 * is the task being edited, so unchanged targets / assignees are checked too. */
export async function validateTaskRefs(p: TaskPatch, assignees: string[] | undefined, current?: { id: string }, allowedApps?: string[] | null): Promise<string | null> {
  if (p.targets && allowedApps && p.targets.some((t) => !allowedApps.includes(t.app_id))) return "You can only put tasks on apps you belong to";
  const sb = getSupabase();
  if (p.series_id) {
    const { data: ms } = await sb.from("meeting_series").select("id").eq("id", p.series_id).maybeSingle();
    if (!ms) return "That meeting series no longer exists";
  }
  if (!p.targets && !assignees) return null;
  if (p.targets && allowedApps && current) {
    // A member edits only their part of a multi-app task: targets on apps
    // they are not on stay exactly as they are.
    const { data: keep } = await sb.from("task_targets").select("app_id, platform").eq("task_id", current.id);
    for (const t of keep || []) if (!allowedApps.includes(t.app_id as string)) p.targets.push({ app_id: t.app_id as string, platform: t.platform as "android" | "ios" });
  }
  // The app ids the task will target after this change.
  let ids: string[];
  if (p.targets) ids = [...new Set(p.targets.map((t) => t.app_id))];
  else {
    const { data } = await sb.from("task_targets").select("app_id").eq("task_id", current?.id ?? "");
    ids = [...new Set((data || []).map((r) => r.app_id as string))];
  }
  if (ids.length) {
    // Who will be assigned after this change.
    let who = assignees;
    if (!who && current) {
      const { data } = await sb.from("task_assignees").select("user_id").eq("task_id", current.id);
      who = (data || []).map((r) => r.user_id as string);
    }
    if (who?.length) {
      const { data: mem } = await sb.from("app_members").select("user_id").in("app_id", ids).in("user_id", who);
      const ok = new Set((mem || []).map((m) => m.user_id as string));
      const bad = who.filter((id) => !ok.has(id));
      if (bad.length) {
        const [{ data: u }, { data: a }] = await Promise.all([sb.from("users").select("first_name, last_name, email").eq("id", bad[0]).maybeSingle(), sb.from("apps").select("name").in("id", ids)]);
        const name = u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || String(u.email).split("@")[0] : "That person";
        const appNames = (a || []).map((x) => x.name as string).join(" / ");
        return `${name} isn't a member of ${appNames || "this app"} — only app members can be assigned`;
      }
    }
  }
  if (!p.targets) return null;
  if (!ids.length) return null;
  const { data: apps } = await sb.from("apps").select("id, name, status, has_android, has_ios").in("id", ids);
  const byId = new Map((apps || []).map((a) => [a.id as string, a]));
  const out: { app_id: string; platform: "android" | "ios" }[] = [];
  const seen = new Set<string>();
  for (const t of p.targets) {
    const a = byId.get(t.app_id);
    if (!a) return "App not found";
    if (a.status === "archived") return `${a.name} is archived — un-archive it first`;
    const plats: ("android" | "ios")[] = t.platform === "both" ? [...(a.has_android ? ["android" as const] : []), ...(a.has_ios ? ["ios" as const] : [])] : [t.platform];
    if (t.platform === "android" && !a.has_android) return `${a.name} doesn't ship on Android`;
    if (t.platform === "ios" && !a.has_ios) return `${a.name} doesn't ship on iOS`;
    if (!plats.length) return `${a.name} has no platform set`;
    for (const pl of plats) {
      const k = `${t.app_id}:${pl}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ app_id: t.app_id, platform: pl });
      }
    }
  }
  p.targets = out;
  return null;
}

/**
 * Make task_targets exactly `targets`, keeping release links on rows that
 * stay, and refresh the summary columns (tasks.app_id = first app,
 * tasks.platform = android / ios / both) that lists and older readers use.
 */
export async function syncTargets(taskId: string, raw: { app_id: string; platform: "android" | "ios" | "both" }[], fresh = false): Promise<void> {
  // validateTaskRefs has expanded "both" already; anything left is dropped.
  const targets = raw.filter((t): t is { app_id: string; platform: "android" | "ios" } => t.platform !== "both");
  const sb = getSupabase();
  const { data: cur } = fresh ? { data: [] as { app_id: string; platform: string }[] } : await sb.from("task_targets").select("app_id, platform").eq("task_id", taskId);
  const key = (t: { app_id: string; platform: string }) => `${t.app_id}:${t.platform}`;
  const wanted = new Set(targets.map(key));
  const have = new Set((cur || []).map((r) => key(r as { app_id: string; platform: string })));
  const gone = (cur || []).filter((r) => !wanted.has(key(r as { app_id: string; platform: string })));
  const add = targets.filter((t) => !have.has(key(t)));
  await Promise.all(gone.map((r) => sb.from("task_targets").delete().eq("task_id", taskId).eq("app_id", r.app_id as string).eq("platform", r.platform as string)));
  if (add.length) await sb.from("task_targets").upsert(add.map((t) => ({ task_id: taskId, app_id: t.app_id, platform: t.platform })), { onConflict: "task_id,app_id,platform", ignoreDuplicates: true });
  const plats = new Set(targets.map((t) => t.platform));
  await sb
    .from("tasks")
    .update({ app_id: targets[0]?.app_id ?? null, platform: plats.size === 0 ? null : plats.size > 1 ? "both" : [...plats][0] })
    .eq("id", taskId);
}

/** Link ONE target of a task to a version (the target matching the release's app + platform). */
export async function linkTargetToRelease(taskId: string, releaseId: string): Promise<boolean> {
  const sb = getSupabase();
  const { data: rel } = await sb.from("releases").select("app_id, platform").eq("id", releaseId).maybeSingle();
  if (!rel) return false;
  const { data } = await sb.from("task_targets").update({ release_id: releaseId }).eq("task_id", taskId).eq("app_id", rel.app_id as string).eq("platform", rel.platform as string).is("released_at", null).select("task_id");
  return !!data?.length;
}

/** The facts the permission rules need, in one indexed read. */
export async function loadOwnership(taskId: string): Promise<(TaskOwnership & { id: string; number: number; title: string; requested_status: string | null; requested_by: string | null; requested_at: string | null; app_id: string | null; platform: string | null }) | null> {
  const sb = getSupabase();
  const [{ data: t }, { data: a }] = await Promise.all([
    sb.from("tasks").select("id, number, title, created_by, status, requested_status, requested_by, requested_at, app_id, platform").eq("id", taskId).maybeSingle(),
    sb.from("task_assignees").select("user_id").eq("task_id", taskId),
  ]);
  if (!t) return null;
  return { ...t, assignee_ids: (a || []).map((r) => r.user_id as string) };
}

/** Everyone involved in a task (creator + assignees), for notifications. */
export const involved = (t: TaskOwnership) => [t.created_by, ...t.assignee_ids];

/** Fetch ONE task as the shared card shape (computed column `task_card`). */
export async function loadCard(taskId: string): Promise<TaskCard | null> {
  const { data } = await getSupabase().from("tasks").select("task_card").eq("id", taskId).maybeSingle();
  return (data?.task_card as TaskCard | undefined) ?? null;
}
