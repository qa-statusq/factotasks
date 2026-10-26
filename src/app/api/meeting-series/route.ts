import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanLine, isUniqueViolation, parseUuidList } from "@/lib/validate";
import { pickDistinctColor, SERIES_COLORS } from "@/lib/colors";
import { SERIES_SELECT, shapeSeries, SERIES_NAME_MAX } from "@/lib/meetings";
import { memberSeriesIds } from "@/lib/series-access";
import type { MeetingSeries } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Every series with its rollups: how many meetings, when the last one was, which one is open. */
export async function GET() {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const sb = getSupabase();
  if (u.role !== "admin") {
    // Members get every series by name (to attach a task to one from the task form) and the full
    // shape of the series they take part in.
    const mine = new Set(await memberSeriesIds(u.uid));
    const { data, error } = await sb.from("meeting_series").select(SERIES_SELECT).order("created_at");
    if (error) return serverError(error);
    return NextResponse.json({
      series: (data || []).map((r) => (mine.has(r.id as string) ? { ...shapeSeries(r), member: true } : { id: r.id, name: r.name, color: r.color, app_ids: [], include_general: true, app_order: [] })),
    });
  }
  const [series, meetings] = await Promise.all([
    sb.from("meeting_series").select(SERIES_SELECT).order("created_at"),
    sb.from("meetings").select("id, series_id, held_at, status").order("held_at", { ascending: false }).limit(1000),
  ]);
  if (series.error) return serverError(series.error);
  if (meetings.error) return serverError(meetings.error);
  const out: MeetingSeries[] = (series.data || []).map((r) => ({ ...shapeSeries(r as Record<string, unknown>), member_ids: [], meeting_count: 0, last_held_at: null, open_meeting_id: null }));
  const byId = new Map(out.map((s) => [s.id, s]));
  const { data: members } = await sb.from("meeting_series_members").select("series_id, user_id");
  for (const row of members || []) byId.get(row.series_id as string)?.member_ids?.push(row.user_id as string);
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
  const wanted = b.member_ids === undefined ? [] : parseUuidList(b.member_ids, 100);
  if (wanted === null) return fail("Invalid people list");
  const auto_close = b.auto_close === undefined ? true : b.auto_close === true;
  const sb = getSupabase();
  // Only real teammates can take part; admins run every series already.
  const { data: people } = wanted.length ? await sb.from("users").select("id").in("id", wanted).eq("role", "member") : { data: [] as { id: string }[] };
  const member_ids = (people ?? []).map((x) => x.id as string);
  const { data: existing } = await sb.from("meeting_series").select("color");
  const color = pickDistinctColor((existing || []).map((r) => r.color as string), SERIES_COLORS);
  const { data, error } = await sb.from("meeting_series").insert({ name, color, app_ids, include_general, app_order, auto_close, created_by: u.uid }).select(SERIES_SELECT).single();
  if (error) return isUniqueViolation(error) ? fail("A series with that name already exists", 409) : serverError(error);
  const s = shapeSeries(data as Record<string, unknown>);
  if (member_ids.length) {
    const { error: mErr } = await sb.from("meeting_series_members").upsert(member_ids.map((user_id) => ({ series_id: s.id, user_id, added_by: u.uid })), { onConflict: "series_id,user_id", ignoreDuplicates: true });
    if (mErr) console.error("[series] members not saved:", mErr);
  }
  after(() => logActivity({ action: "meeting.series.create", entityType: "meeting_series", entityId: s.id, summary: `Created meeting series “${s.name}”` }));
  return NextResponse.json({ series: { ...s, member_ids } });
}
