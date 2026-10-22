import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireAccessUser } from "@/lib/guard";
import { canSeeApp } from "@/lib/visibility";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject, memberJson } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUniqueViolation, isUuid } from "@/lib/validate";
import { appPatch } from "@/lib/apps";
import { resolveAppIcon } from "@/lib/app-icon";

export const dynamic = "force-dynamic";

/** One app with the same overview shape as the list (counts, members, releases). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!(await canSeeApp(u, id))) return NextResponse.json({ error: "App not found" }, { status: 404 });
  if (!isUuid(id)) return fail("App not found", 404);
  // apps_overview is the source of truth for the shape; at team scale (a few
  // dozen apps) picking one row out of it costs nothing and keeps ONE shape.
  const { data, error } = await getSupabase().rpc("apps_overview");
  if (error) return serverError(error);
  const app = ((data as { id: string }[]) || []).find((a) => a.id === id);
  if (!app) return fail("App not found", 404);
  return memberJson(u, { app });
}

/** Edit app details (admin only). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await params;
  if (!isUuid(id)) return fail("App not found", 404);
  const b = await readJsonObject(req);
  const v = appPatch(b, true);
  if ("error" in v) return fail(v.error);
  if (Object.keys(v.patch).length === 0 && b.refresh_icon !== true) return fail("Nothing to update");

  const sb = getSupabase();
  const { data: cur } = await sb.from("apps").select("name, has_android, has_ios, android_package, ios_bundle_id, icon_url").eq("id", id).maybeSingle();
  if (!cur) return fail("App not found", 404);
  const android = (v.patch.has_android as boolean | undefined) ?? cur.has_android;
  const ios = (v.patch.has_ios as boolean | undefined) ?? cur.has_ios;
  if (!android && !ios) return fail("An app needs at least one platform");

  // Re-fetch the store icon when a store id changes (or none was found yet).
  const pkg = ("android_package" in v.patch ? v.patch.android_package : cur.android_package) as string | null;
  const bid = ("ios_bundle_id" in v.patch ? v.patch.ios_bundle_id : cur.ios_bundle_id) as string | null;
  const idsChanged = ("android_package" in v.patch && v.patch.android_package !== cur.android_package) || ("ios_bundle_id" in v.patch && v.patch.ios_bundle_id !== cur.ios_bundle_id);
  // The store lookups only run when the ids change or a refresh was asked
  // for — never on an unrelated edit (an archive click must not wait ~12 s
  // on two store timeouts). Clearing both ids clears the icon.
  if ((idsChanged || b.refresh_icon === true) && (pkg || bid)) {
    v.patch.icon_url = (await resolveAppIcon(pkg, bid)) ?? (idsChanged ? null : cur.icon_url);
  } else if (idsChanged && !pkg && !bid) v.patch.icon_url = null;
  const { error } = await sb.from("apps").update(v.patch).eq("id", id);
  if (error) {
    if (isUniqueViolation(error)) return NextResponse.json({ error: "An app with that name already exists" }, { status: 409 });
    return serverError(error);
  }
  await logActivity({
    action: "app.update",
    entityType: "app",
    entityId: id,
    summary: `Updated app “${(v.patch.name as string) || cur.name}” (${Object.keys(v.patch).join(", ")})`,
  });
  return ok();
}

/** Delete an app (admin only). Refused while it still has tasks or releases —
 * archive instead, so history keeps its context. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await params;
  if (!isUuid(id)) return fail("App not found", 404);
  const sb = getSupabase();
  const { data: cur } = await sb.from("apps").select("name").eq("id", id).maybeSingle();
  if (!cur) return fail("App not found", 404);
  const [{ count: tasks }, { count: releases }] = await Promise.all([
    sb.from("tasks").select("id", { count: "exact", head: true }).eq("app_id", id),
    sb.from("releases").select("id", { count: "exact", head: true }).eq("app_id", id),
  ]);
  if ((tasks ?? 0) > 0 || (releases ?? 0) > 0) {
    return fail(`This app still has ${tasks ?? 0} task(s) and ${releases ?? 0} release(s). Archive it instead of deleting.`);
  }
  const { error } = await sb.from("apps").delete().eq("id", id);
  if (error) return serverError(error);
  await logActivity({ action: "app.delete", entityType: "app", entityId: id, summary: `Deleted app “${cur.name}”` });
  return ok();
}
