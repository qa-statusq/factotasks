import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject, memberJson } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanText, isUniqueViolation, isUuid } from "@/lib/validate";
import { releasePatch, canManageApp, parseTaskIds, setReleaseTasks, applyReleased, AlreadyReleased, openReleaseTasks, RELEASE_SELECT, shapeRelease } from "@/lib/releases";
import { getSettings, needsApproval } from "@/lib/settings";
import { canSeeApp } from "@/lib/visibility";
import { adminIds, notifyUsers } from "@/lib/notify";
import { displayName } from "@/lib/name";
import { LIMITS, PLATFORM_META, taskRef } from "@/lib/domain";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Release not found", 404);
  const { data, error } = await getSupabase().from("releases").select(RELEASE_SELECT).eq("id", id).maybeSingle();
  if (error) return serverError(error);
  if (!data) return fail("Release not found", 404);
  if (!(await canSeeApp(u, data.app_id as string))) return fail("Release not found", 404);
  return memberJson(u, { release: shapeRelease(data as unknown as Record<string, unknown>) });
}

/**
 * Edit (admin or app member). Body: release fields + task_ids? + note?.
 * Moving to "released" closes every linked open task (admins, or members
 * when no approval is needed); otherwise it parks a request for an admin.
 * Response: { release, mode: "applied" | "requested" | "saved", closed }.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Release not found", 404);
  const sb = getSupabase();
  const { data: cur } = await sb.from("releases").select("app_id, platform, version_name, build_number, status, planned_date, released_at, description, notes, requested_status, app:apps(name, has_android, has_ios)").eq("id", id).maybeSingle();
  if (!cur) return fail("Release not found", 404);
  if (!(await canManageApp(u, cur.app_id as string))) return fail("Only members of this app can edit its releases", 403);

  const b = await readJsonObject(req);
  delete b.app_id; // a release never moves between apps
  const v = releasePatch(b, true);
  if ("error" in v) return fail(v.error);
  const p = v.patch;
  const ids = parseTaskIds(b);
  if (ids && "error" in ids) return fail(ids.error);
  const note = cleanText(b.note, LIMITS.note) || null;
  if (Object.keys(p).length === 0 && !ids) return fail("Nothing to update");
  const app = (Array.isArray(cur.app) ? cur.app[0] : cur.app) as { name: string; has_android: boolean; has_ios: boolean } | null;
  if (p.platform === "android" && app && !app.has_android) return fail("This app doesn't ship on Android");
  if (p.platform === "ios" && app && !app.has_ios) return fail("This app doesn't ship on iOS");

  if (u.role !== "admin") {
    if (cur.status === "released" && p.status && p.status !== "released") return fail("Only an admin can move a released version back", 403);
    if ("released_at" in p) return fail("Only an admin can change the release date of a shipped version", 403);
  }
  // A status equal to the current one is not a change (a stale form resending it must not "un-release").
  if (p.status && p.status === cur.status) delete p.status;
  const wantsReleased = p.status === "released" && cur.status !== "released";
  // Any other status move settles a pending "released" request: nobody should
  // be able to approve a version that was cancelled meanwhile.
  if (p.status && !wantsReleased && cur.requested_status) Object.assign(p, { requested_status: null, requested_by: null, requested_at: null, request_note: null });
  const settings = await getSettings(true);
  const mustAsk = wantsReleased && u.role !== "admin" && needsApproval(settings.approval_policy, "done");
  if (mustAsk) {
    // Keep the current status; record the request instead.
    delete p.status;
    delete p.released_at;
    Object.assign(p, { requested_status: "released", requested_by: u.uid, requested_at: new Date().toISOString(), request_note: note });
  } else if (wantsReleased) {
    delete p.status; // applyReleased sets status + released_at together
    delete p.released_at;
  } else if (p.status && p.status !== "released" && p.status !== "rolled_back" && !("released_at" in p)) p.released_at = null;
  // Pulling a version back from Released un-ships its targets: they become
  // pending again (and show in the picker), tasks keep whatever status they have.
  const unreleasing = cur.status === "released" && !!p.status && p.status !== "released";
  if (unreleasing) await sb.from("task_targets").update({ released_at: null }).eq("release_id", id);

  // What actually changed, field by field — the history view reads this.
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of ["version_name", "build_number", "platform", "status", "planned_date", "released_at", "description", "notes"] as const) {
    if (k in p && (p as Record<string, unknown>)[k] !== (cur as Record<string, unknown>)[k]) changes[k] = { from: (cur as Record<string, unknown>)[k] ?? null, to: (p as Record<string, unknown>)[k] ?? null };
  }
  if (ids) changes.tasks = { from: null, to: ids.length };
  if (wantsReleased && !mustAsk) changes.status = { from: cur.status, to: "released" };
  if (ids) await setReleaseTasks(id, cur.app_id as string, (p.platform ?? (cur.platform as "android" | "ios")), ids);
  if (Object.keys(p).length) {
    // A status move is decided against the status the form saw: if an approval or another admin moved
    // the version meanwhile, this write must not land on top of it.
    let w = sb.from("releases").update(p).eq("id", id);
    if (p.status) w = w.eq("status", cur.status as string);
    const { data: hit, error } = await w.select("id");
    if (error) {
      if (isUniqueViolation(error)) return NextResponse.json({ error: "That version already exists for this platform" }, { status: 409 });
      return serverError(error);
    }
    if (p.status && !hit?.length) return fail("This version changed a moment ago — refresh and try again", 409);
  }

  let closed: { id: string; number: number; title: string }[] = [];
  let mode: "applied" | "requested" | "saved" = "saved";
  const version = (p.version_name as string | undefined) ?? (cur.version_name as string);
  const platform = (p.platform ?? cur.platform) as "android" | "ios";
  if (wantsReleased && !mustAsk) {
    const r = await applyReleased({ id, app_id: cur.app_id as string, platform, version_name: version, planned_date: (p.planned_date !== undefined ? p.planned_date : (cur.planned_date as string | null)) ?? null, released_at: null, app_name: app?.name ?? "App" }, u, { kind: "change", note }).catch((e) => ({ error: e as unknown }));
    if ("error" in r) return r.error instanceof AlreadyReleased ? fail(r.error.message, 409) : serverError(r.error);
    closed = r.closed;
    mode = "applied";
  } else if (mustAsk) mode = "requested";

  const { data, error } = await sb.from("releases").select(RELEASE_SELECT).eq("id", id).single();
  if (error) return serverError(error);
  const rel = shapeRelease(data as unknown as Record<string, unknown>);
  const label = `${app?.name ?? "App"} ${PLATFORM_META[rel.platform].label} v${rel.version_name}`;
  const actor = displayName(u.firstName, u.lastName) || u.email;
  const pendingCount = mode === "requested" ? (await openReleaseTasks(id)).length : 0;
  after(async () => {
    const what = [...Object.keys(p).filter((k) => !k.startsWith("requested") && k !== "request_note"), ...(ids ? ["tasks"] : [])];
    await logActivity({
      action: mode === "requested" ? "release.request" : "release.update",
      entityType: "release",
      entityId: id,
      summary: mode === "requested" ? `Requested ${label} → released (${pendingCount} task${pendingCount === 1 ? "" : "s"} to close)` : `Updated ${label} (${[...what, ...(mode === "applied" ? ["released"] : [])].join(", ")})${closed.length ? ` — ${closed.map((t) => taskRef(t.number)).join(", ")} marked done` : ""}`,
      metadata: { changes, closed: closed.length, pending: pendingCount },
    });
    if (mode === "requested") {
      await notifyUsers({ userIds: await adminIds(), kind: "release.requested", actorId: u.uid, message: `${actor} wants ${label} marked released — ${pendingCount} task${pendingCount === 1 ? "" : "s"} would be closed. Needs your approval` });
    } else if (mode === "applied") {
      // The whole app team hears when a version actually ships.
      const { data: members } = await sb.from("app_members").select("user_id").eq("app_id", cur.app_id as string);
      await notifyUsers({ userIds: (members || []).map((m) => m.user_id as string), kind: "release.released", actorId: u.uid, message: `${actor} marked ${label} as released${closed.length ? ` — ${closed.map((t) => taskRef(t.number)).join(", ")} marked done` : ""}` });
    }
  });
  return memberJson(u, { release: rel, mode, closed: closed.length });
}

/** Delete (admin only). Linked tasks keep existing — their release link is cleared. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  if (u.role !== "admin") return fail("Admin access required", 403);
  const { id } = await params;
  if (!isUuid(id)) return fail("Release not found", 404);
  const sb = getSupabase();
  const { data: cur } = await sb.from("releases").select("platform, version_name, app:apps(name)").eq("id", id).maybeSingle();
  if (!cur) return fail("Release not found", 404);
  const { error } = await sb.from("releases").delete().eq("id", id);
  if (error) return serverError(error);
  const app = (Array.isArray(cur.app) ? cur.app[0] : cur.app) as { name: string } | null;
  after(() => logActivity({ action: "release.delete", entityType: "release", entityId: id, summary: `Deleted ${app?.name ?? "App"} ${cur.platform} v${cur.version_name}` }));
  return ok();
}
