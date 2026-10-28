import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject, memberJson } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanLine, cleanText, isUuid, parseUuidList } from "@/lib/validate";
import { LIMITS } from "@/lib/domain";
import { getSettings } from "@/lib/settings";
import { loadMeeting } from "@/lib/meetings";
import { canAccessMeeting, closeOverdueMeetings } from "@/lib/series-access";

export const dynamic = "force-dynamic";

/** The whole MOM in one call (meeting_pack RPC) + workspace name for the deck. Admins, and the people of its series. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Meeting not found", 404);
  await closeOverdueMeetings();
  const cur = await loadMeeting(id);
  if (!cur) return fail("Meeting not found", 404);
  if (!(await canAccessMeeting(u, cur))) return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
  // A member's view (their tasks, their apps' releases, no workload, no approvals) is built in SQL.
  const [{ data, error }, settings] = await Promise.all([getSupabase().rpc("meeting_pack", { p_meeting: id, ...(u.role === "admin" ? {} : { p_user: u.uid }) }), getSettings()]);
  if (error) return serverError(error);
  const pack = data as (Record<string, unknown> & { meeting?: { id?: string } }) | null;
  if (!pack?.meeting?.id) return fail("Meeting not found", 404);
  return memberJson(u, { ...pack, workspace_name: settings.workspace_name });
}

/** Edit title / time / general minutes, close or reopen (admin). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  if (u.role !== "admin") return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return fail("Meeting not found", 404);
  const cur = await loadMeeting(id);
  if (!cur) return fail("Meeting not found", 404);
  const b = await readJsonObject(req);
  const patch: Record<string, unknown> = {};
  const changes: string[] = [];
  if ("title" in b) {
    const t = cleanLine(b.title, LIMITS.meetingTitle);
    if (!t) return fail("Title can't be empty");
    patch.title = t;
    changes.push("title");
  }
  if ("held_at" in b) {
    const t = Date.parse(String(b.held_at));
    if (Number.isNaN(t)) return fail("Meeting time must be a valid date");
    patch.held_at = new Date(t).toISOString();
    changes.push("time");
  }
  if ("notes" in b) {
    patch.notes = cleanText(b.notes, LIMITS.meetingNotes) || null;
    changes.push("minutes");
  }
  if ("series_id" in b) {
    if (!isUuid(b.series_id)) return fail("Pick a series");
    const { data: s } = await getSupabase().from("meeting_series").select("id").eq("id", b.series_id).maybeSingle();
    if (!s) return fail("Series not found", 404);
    patch.series_id = b.series_id;
    changes.push("series");
  }
  if ("app_ids" in b) {
    const ids = parseUuidList(b.app_ids, 50);
    if (ids === null) return fail("Invalid app list");
    patch.app_ids = ids;
    changes.push("scope");
  }
  if ("auto_close" in b) {
    patch.auto_close = b.auto_close === null ? null : b.auto_close === true;
    changes.push("closing");
  }
  if (b.status === "finalized" && cur.status !== "finalized") {
    patch.status = "finalized";
    patch.finalized_at = new Date().toISOString();
    changes.push("closed");
    // Closing freezes the scope the meeting was run with (while open it follows its series).
    const sid = (patch.series_id as string | undefined) ?? (cur as { series_id?: string | null }).series_id ?? null;
    if (sid && !("app_ids" in patch)) {
      const { data: ser } = await getSupabase().from("meeting_series").select("app_ids").eq("id", sid).maybeSingle();
      if (ser) patch.app_ids = ser.app_ids ?? [];
    }
  } else if (b.status === "open" && cur.status !== "open") {
    patch.status = "open";
    patch.finalized_at = null;
    // Reopened by hand = stays open until closed by hand; otherwise the sweep would close it again at once.
    if (!("auto_close" in patch)) patch.auto_close = false;
    changes.push("reopened");
  }
  // Asking for the state the meeting is already in is not an error (a retried request, two admins).
  if (!Object.keys(patch).length) return typeof b.status === "string" && b.status === cur.status ? ok({ unchanged: true }) : fail("Nothing to update");
  const { error } = await getSupabase().from("meetings").update(patch).eq("id", id);
  if (error) return serverError(error);
  after(() => logActivity({ action: "meeting.update", entityType: "meeting", entityId: id, summary: `Updated meeting “${(patch.title as string) || cur.title}” (${changes.join(", ")})` }));
  return ok();
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  if (u.role !== "admin") return NextResponse.json({ error: "Meetings are managed by admins" }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return fail("Meeting not found", 404);
  // One round trip: delete and read back the title for the activity log.
  const { data: gone, error } = await getSupabase().from("meetings").delete().eq("id", id).select("title").maybeSingle();
  if (error) return serverError(error);
  if (!gone) return fail("Meeting not found", 404);
  after(() => logActivity({ action: "meeting.delete", entityType: "meeting", entityId: id, summary: `Deleted meeting “${gone.title}”` }));
  return ok();
}
