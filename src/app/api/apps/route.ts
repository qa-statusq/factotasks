import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireAccessUser } from "@/lib/guard";
import { visibleAppIds } from "@/lib/visibility";
import { getAuthenticatedUser } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { serverError, readJsonObject, fail, memberJson } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUniqueViolation, oneOf, parseUuidList } from "@/lib/validate";
import { APP_COLORS, APP_ROLES } from "@/lib/domain";
import { pickDistinctColor } from "@/lib/colors";
import { appPatch } from "@/lib/apps";
import { resolveAppIcon, backfillAppIcons } from "@/lib/app-icon";

export const dynamic = "force-dynamic";

/** Every app with live counts, members and latest/next release — one RPC. */
export async function GET() {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const sb = getSupabase();
  const { data, error } = await sb.rpc("apps_overview");
  if (error) return serverError(error);
  const allowed = await visibleAppIds(u);
  // Members see only the apps they belong to.
  const apps = ((data ?? []) as { id: string; icon_url?: string | null; android_package?: string | null; ios_bundle_id?: string | null }[]).filter((a) => allowed === null || allowed.includes(a.id));
  // Fill in store icons for apps that don't have one yet (fire-and-forget).
  backfillAppIcons(apps, async (id, icon_url) => sb.from("apps").update({ icon_url }).eq("id", id));
  return memberJson(u, { apps });
}

/** Add an app (admin only). Optional initial members. */
export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const me = await getAuthenticatedUser();
  const b = await readJsonObject(req);
  const v = appPatch(b, false);
  if ("error" in v) return fail(v.error);
  const patch = v.patch;
  if (patch.has_android === false && patch.has_ios === false) return fail("An app needs at least one platform");
  if (patch.has_android === undefined) patch.has_android = true;
  if (patch.has_ios === undefined) patch.has_ios = false;

  const sb = getSupabase();
  // Colours are never chosen by hand: take the palette entry its siblings use least.
  const { data: existing } = await sb.from("apps").select("color");
  patch.color = pickDistinctColor((existing || []).map((r) => r.color as string), APP_COLORS);
  const { data: app, error } = await sb
    .from("apps")
    .insert({ ...patch, created_by: me?.uid ?? null })
    .select("id, name")
    .single();
  if (error) {
    if (isUniqueViolation(error)) return NextResponse.json({ error: "An app with that name already exists" }, { status: 409 });
    return serverError(error);
  }

  // Initial members: [{ user_id, app_role }]
  const members = Array.isArray(b.members) ? (b.members as Record<string, unknown>[]) : [];
  const ids = parseUuidList(members.map((m) => m.user_id), 50);
  if (members.length && ids) {
    const rows = members
      .map((m) => ({ app_id: app.id, user_id: String(m.user_id).toLowerCase(), app_role: oneOf(m.app_role, APP_ROLES) ?? "developer" }))
      .filter((r, i, arr) => arr.findIndex((x) => x.user_id === r.user_id) === i);
    const { error: mErr } = await sb.from("app_members").insert(rows);
    if (mErr) console.error("[apps] initial members failed:", mErr);
  }

  // Store icon, best effort — the listing is public, so no key is needed.
  const icon = await resolveAppIcon(patch.android_package as string | null, patch.ios_bundle_id as string | null);
  if (icon) await sb.from("apps").update({ icon_url: icon }).eq("id", app.id);

  await logActivity({ action: "app.create", entityType: "app", entityId: app.id, summary: `Added app “${app.name}”` });
  return NextResponse.json({ app: { id: app.id, name: app.name } });
}
