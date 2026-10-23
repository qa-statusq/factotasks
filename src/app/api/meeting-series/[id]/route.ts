import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject, EXPECTED_EMBED_MISS } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanLine, isUniqueViolation, isUuid, parseUuidList } from "@/lib/validate";
import { SERIES_NAME_MAX } from "@/lib/meetings";

export const dynamic = "force-dynamic";

/** Rename / change the scope (admin). Colours are automatic. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  if (u.role !== "admin") return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return fail("Series not found", 404);
  const b = await readJsonObject(req);
  const patch: Record<string, unknown> = {};
  if ("name" in b) {
    const name = cleanLine(b.name, SERIES_NAME_MAX);
    if (!name) return fail("Name can't be empty");
    patch.name = name;
  }
  if ("include_general" in b) patch.include_general = b.include_general === true;
  if ("app_ids" in b) {
    const ids = parseUuidList(b.app_ids, 50);
    if (ids === null) return fail("Invalid app list");
    patch.app_ids = ids;
  }
  if ("app_order" in b) {
    const ids = parseUuidList(b.app_order, 60);
    if (ids === null) return fail("Invalid app order");
    patch.app_order = ids;
  }
  if (!Object.keys(patch).length) return fail("Nothing to update");
  let { data, error } = await getSupabase().from("meeting_series").update(patch).eq("id", id).select("id, name").maybeSingle();
  if (error && "app_order" in patch && EXPECTED_EMBED_MISS.has((error as { code?: string }).code ?? "")) {
    // A database without 013 has no app_order column yet: save the rest.
    delete patch.app_order;
    if (!Object.keys(patch).length) return ok();
    ({ data, error } = await getSupabase().from("meeting_series").update(patch).eq("id", id).select("id, name").maybeSingle());
  }
  if (error) return isUniqueViolation(error) ? fail("A series with that name already exists", 409) : serverError(error);
  if (!data) return fail("Series not found", 404);
  // Open meetings of the series follow its scope (closed ones keep theirs).
  if ("app_ids" in patch || "include_general" in patch) {
    const sync: Record<string, unknown> = {};
    if ("app_ids" in patch) sync.app_ids = patch.app_ids;
    if ("include_general" in patch) sync.include_general = patch.include_general;
    const { error: mErr } = await getSupabase().from("meetings").update(sync).eq("series_id", id).eq("status", "open");
    if (mErr) console.error("[series] open meetings not synced:", mErr);
  }
  after(() => logActivity({ action: "meeting.series.update", entityType: "meeting_series", entityId: id, summary: `Updated meeting series “${data.name}”` }));
  return ok();
}

/** Delete a series (admin). Its meetings are kept and simply lose the series. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  if (u.role !== "admin") return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return fail("Series not found", 404);
  const sb = getSupabase();
  const { count } = await sb.from("meeting_series").select("id", { count: "exact", head: true });
  if ((count ?? 0) <= 1) return fail("Keep at least one series");
  const { data, error } = await sb.from("meeting_series").delete().eq("id", id).select("id, name").maybeSingle();
  if (error) return serverError(error);
  if (!data) return fail("Series not found", 404);
  await logActivity({ action: "meeting.series.delete", entityType: "meeting_series", entityId: id, summary: `Deleted meeting series “${data.name}”` });
  return ok();
}
