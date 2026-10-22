import { getSupabase } from "./supabase";
import type { SessionUser } from "./auth";
import { cleanLine, cleanText, isUuid, oneOf, parseDate, parseUuidList } from "./validate";
import { LIMITS, PLATFORM_META, RELEASE_STATUSES, taskRef } from "./domain";
import { USER_BRIEF_COLS, embedded, embeddedUser } from "./users";
import { notifyUsers } from "./notify";
import { displayName } from "./name";
import type { Release, ReleaseTaskLite } from "./types";

export interface ReleasePatch {
  app_id?: string;
  platform?: "android" | "ios";
  version_name?: string;
  build_number?: string | null;
  status?: string;
  planned_date?: string | null;
  released_at?: string | null;
  description?: string | null;
  notes?: string | null;
}

/** Validate release fields. `partial` = only keys present in `b`. */
export function releasePatch(b: Record<string, unknown>, partial: boolean): { patch: ReleasePatch } | { error: string } {
  const p: ReleasePatch = {};
  const has = (k: string) => !partial || k in b;
  if (has("app_id")) {
    if (!isUuid(b.app_id)) return { error: "Pick an app" };
    p.app_id = String(b.app_id).toLowerCase();
  }
  if (has("platform")) {
    const pl = oneOf(b.platform, ["android", "ios"] as const);
    if (!pl) return { error: "Pick Android or iOS" };
    p.platform = pl;
  }
  if (has("version_name")) {
    const v = cleanLine(b.version_name, LIMITS.versionName).replace(/^v/i, "");
    if (!v) return { error: "Enter the version (e.g. 2.4.0)" };
    p.version_name = v;
  }
  if (has("build_number")) p.build_number = cleanLine(b.build_number, LIMITS.buildNumber) || null;
  if (has("status") && (partial || b.status != null)) {
    const s = oneOf(b.status, RELEASE_STATUSES);
    if (!s) return { error: "Pick a valid status" };
    p.status = s;
  }
  if (has("planned_date")) {
    if (b.planned_date != null && b.planned_date !== "" && !parseDate(b.planned_date)) return { error: "Release date must be a valid date" };
    p.planned_date = parseDate(b.planned_date);
  }
  if (has("released_at")) {
    if (b.released_at == null || b.released_at === "") p.released_at = null;
    else {
      const t = Date.parse(String(b.released_at));
      if (Number.isNaN(t)) return { error: "Release time must be a valid date" };
      p.released_at = new Date(t).toISOString();
    }
  }
  if (has("description")) p.description = cleanText(b.description, LIMITS.releaseText) || null;
  if (has("notes")) p.notes = cleanText(b.notes, LIMITS.releaseText) || null;
  return { patch: p };
}

/** `task_ids` in a create/edit body: the full set of tasks in this version. */
export function parseTaskIds(b: Record<string, unknown>): string[] | null | { error: string } {
  if (!("task_ids" in b)) return null;
  const ids = parseUuidList(b.task_ids, 200);
  return ids === null ? { error: "Invalid task list" } : ids;
}

/** Who may add / edit a release (and ask for "released"): admins, and the
 * members of that app. Admin approval remains the gate for members. */
export async function canManageApp(u: SessionUser, appId: string): Promise<boolean> {
  if (u.role === "admin") return true;
  const { data } = await getSupabase().from("app_members").select("user_id").eq("app_id", appId).eq("user_id", u.uid).maybeSingle();
  return !!data;
}

/** Columns + embeds every release read uses. */
export const RELEASE_SELECT = `id, app_id, platform, version_name, build_number, status, planned_date, released_at, description, notes, created_at, updated_at, requested_status, requested_at, request_note, app:apps(id, name, color, icon_url, has_android, has_ios), creator:users!releases_created_by_fkey(${USER_BRIEF_COLS}), requester:users!releases_requested_by_fkey(${USER_BRIEF_COLS}), task_targets(released_at, task:tasks(id, number, title, status, description))`;

export function shapeRelease(r: Record<string, unknown>): Release {
  const tasks = (((r.task_targets as { released_at: string | null; task: unknown }[] | null) || [])
    .map((x) => {
      const t = embedded<ReleaseTaskLite>(x.task);
      return t ? { ...t, released_at: x.released_at } : null;
    })
    .filter((t) => !!t) as ReleaseTaskLite[]).sort((a, b) => a.number - b.number);
  return {
    id: r.id as string,
    app_id: r.app_id as string,
    platform: r.platform as Release["platform"],
    version_name: r.version_name as string,
    build_number: (r.build_number as string | null) ?? null,
    status: r.status as Release["status"],
    planned_date: (r.planned_date as string | null) ?? null,
    released_at: (r.released_at as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    created_by: embeddedUser(r.creator),
    app: embedded<Release["app"]>(r.app) ?? undefined,
    tasks,
    task_count: tasks.length,
    done_count: tasks.filter((t) => t.status === "done").length,
    requested_status: (r.requested_status as "released" | null) ?? null,
    requested_by: embeddedUser(r.requester),
    requested_at: (r.requested_at as string | null) ?? null,
    request_note: (r.request_note as string | null) ?? null,
  };
}

/**
 * Make `ids` exactly the set of tasks whose (app, platform) target ships in
 * this release: link the new ones, unlink the ones no longer chosen (never a
 * target that has already shipped).
 */
export async function setReleaseTasks(releaseId: string, appId: string, platform: "android" | "ios", ids: string[]): Promise<void> {
  const sb = getSupabase();
  const { data: cur } = await sb.from("task_targets").select("task_id").eq("release_id", releaseId);
  const current = new Set((cur || []).map((t) => t.task_id as string));
  const wanted = new Set(ids);
  const toClear = [...current].filter((id) => !wanted.has(id));
  const toSet = ids.filter((id) => !current.has(id));
  if (toClear.length) await sb.from("task_targets").update({ release_id: null }).eq("release_id", releaseId).in("task_id", toClear).is("released_at", null);
  if (toSet.length) await sb.from("task_targets").update({ release_id: releaseId }).in("task_id", toSet).eq("app_id", appId).eq("platform", platform).is("released_at", null);
}

/** Targets in this release that have not shipped yet — what a "released" closes. */
export async function openReleaseTasks(releaseId: string): Promise<{ id: string; number: number; title: string }[]> {
  const { data } = await getSupabase().from("task_targets").select("task:tasks(id, number, title)").eq("release_id", releaseId).is("released_at", null);
  return ((data || []).map((r) => embedded<{ id: string; number: number; title: string }>(r.task)).filter((t): t is { id: string; number: number; title: string } => !!t)).sort((a, b) => a.number - b.number);
}

/** When "released" happens: the planned date at noon IST if it has passed, else right now. */
export function releasedAtFor(plannedDate: string | null | undefined, now = new Date()): string {
  if (plannedDate) {
    const noonIst = new Date(`${plannedDate}T06:30:00.000Z`);
    if (noonIst.getTime() <= now.getTime()) return noonIst.toISOString();
  }
  return now.toISOString();
}

export interface ReleaseCore {
  id: string;
  app_id: string;
  platform: "android" | "ios";
  version_name: string;
  planned_date: string | null;
  released_at: string | null;
  app_name: string;
}

/**
 * Apply "released": stamp the release, clear any pending request, and mark
 * every linked open task done (each gets a status-log line naming the
 * version). Returns what was closed so the caller can report it.
 */
export class AlreadyReleased extends Error {
  constructor() {
    super("This version is already released");
  }
}

export async function applyReleased(rel: ReleaseCore, actor: SessionUser, opts: { kind: "change" | "approve"; note?: string | null; completedAt?: string | null }): Promise<{ released_at: string; closed: { id: string; number: number; title: string }[]; partial: { id: string; number: number; title: string }[] }> {
  const sb = getSupabase();
  const released_at = rel.released_at ?? releasedAtFor(rel.planned_date);
  // Conditional: two admins approving at once release it ONCE. The loser
  // sees "already released" instead of a second fan-out to the whole team.
  const { data: hit, error } = await sb
    .from("releases")
    .update({ status: "released", released_at, requested_status: null, requested_by: null, requested_at: null, request_note: null })
    .eq("id", rel.id)
    .neq("status", "released")
    .select("id");
  if (error) throw error;
  if (!hit?.length) throw new AlreadyReleased();
  const label = `${rel.app_name} ${PLATFORM_META[rel.platform].label} v${rel.version_name}`;
  const open = await openReleaseTasks(rel.id);
  await sb.from("task_targets").update({ released_at }).eq("release_id", rel.id).is("released_at", null);
  const actorName = displayName(actor.firstName, actor.lastName) || actor.email;
  const closed: { id: string; number: number; title: string }[] = [];
  const partial: { id: string; number: number; title: string }[] = [];
  if (open.length) {
    const ids = open.map((t) => t.id);
    const [{ data: allTargets }, { data: rows }] = await Promise.all([
      sb.from("task_targets").select("task_id, released_at").in("task_id", ids),
      sb.from("tasks").select("id, status").in("id", ids),
    ]);
    const statusOf = new Map((rows || []).map((r) => [r.id as string, r.status as string]));
    const tally = new Map<string, { total: number; shipped: number }>();
    for (const x of allTargets || []) {
      const c = tally.get(x.task_id as string) ?? { total: 0, shipped: 0 };
      c.total += 1;
      if (x.released_at) c.shipped += 1;
      tally.set(x.task_id as string, c);
    }
    const jobs: (() => Promise<void>)[] = [];
    for (const t of open) {
      const status = statusOf.get(t.id) ?? "todo";
      if (status === "done" || status === "cancelled") continue;
      const { total, shipped } = tally.get(t.id) ?? { total: 0, shipped: 0 };
      const allDone = total > 0 && shipped >= total;
      if (!allDone && status === "partial") continue;
      jobs.push(async () => {
        // Always a plain "change" on the task: the task carries no request of
        // its own here, and the "approve" kind would trip task_apply_status's
        // request guard. opts.kind still labels the release activity.
        const { error: e } = await sb.rpc("task_apply_status", {
          p_task: t.id,
          p_to: allDone ? "done" : "partial",
          p_actor: actor.uid,
          p_kind: "change",
          p_note: `${allDone ? "Shipped" : `Shipped on ${shipped} of ${total} targets`} — ${label}${opts.note ? ` — ${opts.note}` : ""}`,
          p_completed_at: allDone ? (opts.completedAt ?? released_at) : null,
        });
        if (!e) (allDone ? closed : partial).push(t);
      });
    }
    // A few at a time keeps a 40-task release at well under a second.
    const worker = async () => {
      for (let j = jobs.shift(); j; j = jobs.shift()) await j();
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
    closed.sort((a, b) => a.number - b.number);
    partial.sort((a, b) => a.number - b.number);
  }
  const touched = [...closed, ...partial];
  if (touched.length) {
    const { data: who } = await sb.from("task_assignees").select("task_id, user_id").in("task_id", touched.map((t) => t.id));
    const byTask = new Map<string, string[]>();
    for (const w of who || []) byTask.set(w.task_id as string, [...(byTask.get(w.task_id as string) || []), w.user_id as string]);
    await Promise.all(
      touched.map((t) =>
        notifyUsers({
          userIds: byTask.get(t.id) || [],
          kind: "task.status",
          taskId: t.id,
          actorId: actor.uid,
          message: closed.includes(t) ? `${actorName} marked ${taskRef(t.number)} “${t.title}” done — shipped in ${label}` : `${taskRef(t.number)} “${t.title}” shipped in ${label} — other targets still pending`,
        })
      )
    );
  }
  return { released_at, closed, partial };
}
