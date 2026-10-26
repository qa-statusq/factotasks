import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanLine, isUuid } from "@/lib/validate";
import { LIMITS } from "@/lib/domain";
import { MEETING_SELECT, selectSeries, shapeMeeting, shapeSeries, defaultTitle, ensureDefaultSeries } from "@/lib/meetings";
import { memberSeriesIds, closeOverdueMeetings } from "@/lib/series-access";

export const dynamic = "force-dynamic";

/** Meetings, newest first: every one for admins, those of their series for members. */
export async function GET() {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  await closeOverdueMeetings();
  let q = getSupabase().from("meetings").select(MEETING_SELECT).order("held_at", { ascending: false }).limit(200);
  if (u.role !== "admin") {
    const mine = await memberSeriesIds(u.uid);
    if (!mine.length) return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
    q = q.in("series_id", mine);
  }
  const { data, error } = await q;
  if (error) return serverError(error);
  const meetings = ((data as unknown as Record<string, unknown>[]) || []).map(shapeMeeting);
  return NextResponse.json({ meetings });
}

/** Create a meeting (admin). Body: { series_id?, held_at?, title?, force? }.
 * held_at is when the team actually meets (defaults to now). The title is the
 * series name plus the date unless given; the scope is the series' scope. */
export async function POST(req: NextRequest) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  if (u.role !== "admin") return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
  if (u.role !== "admin") return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
  const b = await readJsonObject(req);
  let heldAt: Date;
  if (b.held_at) {
    const t = Date.parse(String(b.held_at));
    if (Number.isNaN(t)) return fail("Meeting time must be a valid date");
    heldAt = new Date(t);
  } else heldAt = new Date();
  const sb = getSupabase();
  let series;
  if (b.series_id !== undefined) {
    if (!isUuid(b.series_id)) return fail("Pick a series");
    const { data } = await selectSeries((sel) => sb.from("meeting_series").select(sel).eq("id", b.series_id).maybeSingle());
    if (!data) return fail("Series not found", 404);
    series = shapeSeries(data as Record<string, unknown>);
  } else series = await ensureDefaultSeries(u.uid);
  const app_ids = series.app_ids;
  const include_general = series.include_general;
  const title = cleanLine(b.title, LIMITS.meetingTitle) || defaultTitle(heldAt, series.name);

  // One open meeting per series keeps "since the last meeting" unambiguous.
  const { data: open } = await sb.from("meetings").select("id, title").eq("status", "open").eq("series_id", series.id).limit(1).maybeSingle();
  if (open && b.force !== true) {
    return NextResponse.json({ error: `“${open.title}” is still open in this series — close it first, or confirm to create another.`, open_id: open.id }, { status: 409 });
  }
  const { data, error } = await sb
    .from("meetings")
    .insert({ title, held_at: heldAt.toISOString(), created_by: u.uid, series_id: series.id, app_ids, include_general })
    .select(MEETING_SELECT)
    .single();
  if (error) return serverError(error);
  const m = shapeMeeting(data as unknown as Record<string, unknown>);
  after(() => logActivity({ action: "meeting.create", entityType: "meeting", entityId: m.id, summary: `Created meeting “${m.title}”` }));
  return NextResponse.json({ meeting: m });
}
