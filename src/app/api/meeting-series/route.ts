import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject, EXPECTED_EMBED_MISS } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanLine, isUniqueViolation, parseUuidList } from "@/lib/validate";
import { pickDistinctColor, SERIES_COLORS } from "@/lib/colors";
import { SERIES_SELECT, shapeSeries, SERIES_NAME_MAX } from "@/lib/meetings";
import type { MeetingSeries } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Every series with its rollups: how many meetings, when the last one was, which one is open. */
export async function GET() {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const sb = getSupabase();
  if (u.role !== "admin") {
    // Members only need the names, to attach a task to a series from the
    // task form; meetings themselves stay with admins.
    const { data, error } = await sb.from("meeting_series").select("id, name, color").order("created_at");
    if (error) return serverError(error);
    return NextResponse.json({ series: (data || []).map((r) => ({ id: r.id, name: r.name, color: r.color, app_ids: [], include_general: true, app_order: [] })) });
  }
  const [seriesFirst, meetings] = await Promise.all([
    sb.from("meeting_series").select(SERIES_SELECT).order("created_at"),
    sb.from("meetings").select("id, series_id, held_at, status").order("held_at", { ascending: false }).limit(1000),
  ]);
  let series: { data: Record<string, unknown>[] | null; error: { code?: string; message: string } | null } = seriesFirst as never;
  // A database without 013 has no app_order column yet.
  if (series.error && EXPECTED_EMBED_MISS.has(series.error.code ?? "")) series = (await sb.from("meeting_series").select("id, name, color, app_ids, include_general, created_at").order("created_at")) as never;
  if (series.error) return serverError(series.error);
  if (meetings.error) return serverError(meetings.error);
  const out: MeetingSeries[] = (series.data || []).map((r) => ({ ...shapeSeries(r as Record<string, unknown>), meeting_count: 0, last_held_at: null, open_meeting_id: null }));
  const byId = new Map(out.map((s) => [s.id, s]));
  for (const m of meetings.data || []) {
    const s = m.series_id ? byId.get(m.series_id as string) : undefined;
    if (!s) continue;
    s.meeting_count = (s.meeting_count ?? 0) + 1;
    if (!s.last_held_at) s.last_held_at = m.held_at as string; // rows arrive newest first
    if (m.status === "open" && !s.open_meeting_id) s.open_meeting_id = m.id as string;
  }
  return NextResponse.json({ series: out });
}

/** Create a series (admin). Body: { name, app_ids?, include_general? }. The colour is assigned automatically. */
export async function POST(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  if (u.role !== "admin") return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
  const b = await readJsonObject(req);
  const name = cleanLine(b.name, SERIES_NAME_MAX);
  if (!name) return fail("Give the series a name");
  const app_ids = b.app_ids === undefined ? [] : parseUuidList(b.app_ids, 50);
  if (app_ids === null) return fail("Invalid app list");
  const include_general = b.include_general === undefined ? true : b.include_general === true;
  const app_order = b.app_order === undefined ? [] : parseUuidList(b.app_order, 60);
  if (app_order === null) return fail("Invalid app order");
  const sb = getSupabase();
  const { data: existing } = await sb.from("meeting_series").select("color");
  const color = pickDistinctColor((existing || []).map((r) => r.color as string), SERIES_COLORS);
  let { data, error } = await sb
    .from("meeting_series")
    .insert({ name, color, app_ids, include_general, app_order, created_by: u.uid })
    .select(SERIES_SELECT)
    .single();
  if (error && EXPECTED_EMBED_MISS.has((error as { code?: string }).code ?? "")) {
    // A database without 013: create it without the order column.
    ({ data, error } = await sb.from("meeting_series").insert({ name, color, app_ids, include_general, created_by: u.uid }).select("id, name, color, app_ids, include_general, created_at").single());
  }
  if (error) return isUniqueViolation(error) ? fail("A series with that name already exists", 409) : serverError(error);
  const s = shapeSeries(data as Record<string, unknown>);
  after(() => logActivity({ action: "meeting.series.create", entityType: "meeting_series", entityId: s.id, summary: `Created meeting series “${s.name}”` }));
  return NextResponse.json({ series: s });
}
