import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid, oneOf, parseUuidList } from "@/lib/validate";
import { APP_ROLES } from "@/lib/domain";

export const dynamic = "force-dynamic";

/**
 * Replace the app's member set (admin only): body { members: [{ user_id, app_role }] }.
 * A full replace (delete + insert) keeps the API one call and the UI one save;
 * the set is tiny and the operation is idempotent.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await params;
  if (!isUuid(id)) return fail("App not found", 404);
  const b = await readJsonObject(req);
  const members = Array.isArray(b.members) ? (b.members as Record<string, unknown>[]) : null;
  if (!members) return fail("members must be a list");
  const ids = parseUuidList(members.map((m) => m.user_id), 60);
  if (!ids) return fail("Invalid member list");
  const rows = members
    .map((m) => ({ app_id: id, user_id: String(m.user_id).toLowerCase(), app_role: oneOf(m.app_role, APP_ROLES) ?? "developer" }))
    .filter((r, i, arr) => arr.findIndex((x) => x.user_id === r.user_id) === i);

  const sb = getSupabase();
  const { data: app } = await sb.from("apps").select("name").eq("id", id).maybeSingle();
  if (!app) return fail("App not found", 404);
  // A diff, never delete-all-then-insert: a failed insert can't leave the app
  // with nobody on it (which would hide it from every member).
  const { data: before } = await sb.from("app_members").select("user_id").eq("app_id", id);
  const keepIds = new Set(rows.map((r) => r.user_id));
  const gone = (before || []).map((m) => m.user_id as string).filter((uid) => !keepIds.has(uid));
  if (rows.length) {
    const { error } = await sb.from("app_members").upsert(rows, { onConflict: "app_id,user_id" });
    if (error) return serverError(error);
  }
  if (gone.length) {
    const { error: delErr } = await sb.from("app_members").delete().eq("app_id", id).in("user_id", gone);
    if (delErr) return serverError(delErr);
  }
  // People taken off the app lose their assignments on its tasks, unless
  // the task also targets another app they still belong to. Otherwise they
  // would stay assigned to work they can no longer see.
  const keep = new Set(rows.map((r) => r.user_id));
  const removed = (before || []).map((m) => m.user_id as string).filter((uid) => !keep.has(uid));
  if (removed.length) {
    for (const uid of removed) {
      // Start from THEIR assignments (a short list), not the app's whole task set.
      const { data: theirs } = await sb.from("task_assignees").select("task_id").eq("user_id", uid);
      const assigned = [...new Set((theirs || []).map((r) => r.task_id as string))];
      if (!assigned.length) continue;
      const [{ data: targets }, { data: stillIn }] = await Promise.all([
        sb.from("task_targets").select("task_id, app_id").in("task_id", assigned),
        sb.from("app_members").select("app_id").eq("user_id", uid),
      ]);
      const mine = new Set((stillIn || []).map((m) => m.app_id as string));
      const onThisApp = new Set((targets || []).filter((t) => t.app_id === id).map((t) => t.task_id as string));
      const keptElsewhere = new Set((targets || []).filter((t) => mine.has(t.app_id as string)).map((t) => t.task_id as string));
      const drop = assigned.filter((t) => onThisApp.has(t) && !keptElsewhere.has(t));
      if (drop.length) await sb.from("task_assignees").delete().eq("user_id", uid).in("task_id", drop);
    }
  }
  await logActivity({ action: "app.members", entityType: "app", entityId: id, summary: `Updated members of “${app.name}” (${rows.length} people)` });
  return ok();
}
