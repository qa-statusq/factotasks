import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject, memberJson } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUniqueViolation, isUuid, oneOf } from "@/lib/validate";
import { releasePatch, canManageApp, parseTaskIds, setReleaseTasks, applyReleased, RELEASE_SELECT as SELECT, shapeRelease } from "@/lib/releases";
import { getSettings, needsApproval } from "@/lib/settings";
import { visibleAppIds, NONE_ID } from "@/lib/visibility";
import { adminIds, notifyUsers } from "@/lib/notify";
import { displayName } from "@/lib/name";
import { PLATFORM_META } from "@/lib/domain";

export const dynamic = "force-dynamic";

/** ?app=<uuid> ?platform=android|ios ?scope=open|released|requests|all (default all, newest first). */
export async function GET(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const sp = new URL(req.url).searchParams;
  let q = getSupabase().from("releases").select(SELECT).order("created_at", { ascending: false }).limit(300);
  const app = sp.get("app");
  if (isUuid(app)) q = q.eq("app_id", app!.toLowerCase());
  const allowed = await visibleAppIds(u);
  if (allowed !== null) q = q.in("app_id", allowed.length ? allowed : [NONE_ID]);
  const platform = oneOf(sp.get("platform"), ["android", "ios"] as const);
  if (platform) q = q.eq("platform", platform);
  const scope = sp.get("scope") || "all";
  if (scope === "open") q = q.not("status", "in", "(released,cancelled,rolled_back)");
  else if (scope === "released") q = q.eq("status", "released");
  else if (scope === "requests") q = q.not("requested_status", "is", null).order("requested_at", { ascending: true });
  const { data, error } = await q;
  if (error) return serverError(error);
  return memberJson(u, { releases: ((data as unknown as Record<string, unknown>[]) || []).map(shapeRelease) });
}

/**
 * Create a release (admin, or a member of the app).
 * Body: release fields + task_ids? (the tasks in this version).
 * Creating it straight as "released" closes those tasks — or, for a member
 * under an approval policy, parks a request for an admin instead.
 */
export async function POST(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const b = await readJsonObject(req);
  const v = releasePatch(b, false);
  if ("error" in v) return fail(v.error);
  const p = v.patch;
  const ids = parseTaskIds(b);
  if (ids && "error" in ids) return fail(ids.error);
  if (!(await canManageApp(u, p.app_id!))) return fail("Only members of this app can add its releases", 403);
  const sb = getSupabase();
  const { data: app } = await sb.from("apps").select("name, has_android, has_ios").eq("id", p.app_id!).maybeSingle();
  if (!app) return fail("App not found", 404);
  if (p.platform === "android" && !app.has_android) return fail("This app doesn't ship on Android");
  if (p.platform === "ios" && !app.has_ios) return fail("This app doesn't ship on iOS");

  const wantsReleased = p.status === "released";
  const settings = await getSettings(true);
  const mustAsk = wantsReleased && u.role !== "admin" && needsApproval(settings.approval_policy, "done");
  const insert: Record<string, unknown> = { ...p, status: mustAsk ? "submitted" : (p.status ?? "planned"), created_by: u.uid };
  if (mustAsk) Object.assign(insert, { requested_status: "released", requested_by: u.uid, requested_at: new Date().toISOString() });
  if (wantsReleased && !mustAsk) delete insert.released_at; // applyReleased stamps it
  else if (!wantsReleased) delete insert.released_at;

  const { data, error } = await sb.from("releases").insert(insert).select(SELECT).single();
  if (error) {
    if (isUniqueViolation(error)) return NextResponse.json({ error: `v${p.version_name} already exists for ${p.platform} on this app` }, { status: 409 });
    return serverError(error);
  }
  const created = shapeRelease(data as unknown as Record<string, unknown>);
  if (ids) await setReleaseTasks(created.id, created.app_id, created.platform, ids);

  let closed = 0;
  let mode: "applied" | "requested" | "saved" = "saved";
  if (wantsReleased && !mustAsk) {
    const r = await applyReleased({ id: created.id, app_id: created.app_id, platform: created.platform, version_name: created.version_name, planned_date: created.planned_date, released_at: null, app_name: app.name as string }, u, { kind: "change" }).catch((e) => ({ error: e as unknown }));
    if ("error" in r) return serverError(r.error);
    closed = r.closed.length;
    mode = "applied";
  } else if (mustAsk) mode = "requested";

  const { data: fresh } = await sb.from("releases").select(SELECT).eq("id", created.id).maybeSingle();
  const rel = fresh ? shapeRelease(fresh as unknown as Record<string, unknown>) : created;
  const label = `${app.name} ${PLATFORM_META[rel.platform].label} v${rel.version_name}`;
  const actor = displayName(u.firstName, u.lastName) || u.email;
  after(async () => {
    await logActivity({
      action: "release.create",
      entityType: "release",
      entityId: rel.id,
      summary: `Added ${label} (${rel.status})${closed ? ` — ${closed} task${closed === 1 ? "" : "s"} marked done` : ""}`,
      metadata: { changes: { status: { from: null, to: rel.status }, planned_date: { from: null, to: rel.planned_date }, tasks: { from: null, to: ids?.length ?? 0 } }, closed },
    });
    if (mode === "requested") {
      await notifyUsers({ userIds: await adminIds(), kind: "release.requested", actorId: u.uid, message: `${actor} wants ${label} marked released — ${rel.task_count ?? 0} linked task${(rel.task_count ?? 0) === 1 ? "" : "s"} would be closed. Needs your approval` });
    } else if (mode === "applied") {
      const { data: members } = await sb.from("app_members").select("user_id").eq("app_id", rel.app_id);
      await notifyUsers({ userIds: (members || []).map((m) => m.user_id as string), kind: "release.released", actorId: u.uid, message: `${actor} marked ${label} as released` });
    }
  });
  return memberJson(u, { release: rel, mode, closed });
}
