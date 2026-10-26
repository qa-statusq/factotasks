import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanLine, isUuid } from "@/lib/validate";
import { renameFile, trashFile, DriveError } from "@/lib/google-drive";
import { loadRecording, loadShares, canManage, canUpload, publicRecording, recordingFileName } from "@/lib/recordings";
import { canAccessSeries } from "@/lib/series-access";

export const dynamic = "force-dynamic";

/** One recording with who it has been shared with. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Recording not found", 404);
  const rec = await loadRecording(id);
  if (!rec || !(await canAccessSeries(u, rec.meeting?.series?.id))) return fail("Recording not found", 404);
  const shares = canManage(u, rec) ? await loadShares(id) : [];
  return NextResponse.json({ recording: { ...publicRecording(rec), shares }, can_manage: canManage(u, rec) });
}

/** Rename: { name } (the Drive file follows). Admins or the recorder. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Recording not found", 404);
  const rec = await loadRecording(id);
  if (!rec) return fail("Recording not found", 404);
  if (!canManage(u, rec)) return fail("Only an admin or the person who recorded can rename it", 403);
  const b = await readJsonObject(req);
  const base = cleanLine(b.name, 120).replace(/\.(webm|weba|mp4|m4a|mkv|ogg)$/i, "");
  if (!base) return fail("Give the recording a name");
  const ext = rec.name.match(/\.(webm|weba|mp4|m4a|mkv|ogg)$/i)?.[0] ?? ".webm";
  const name = recordingFileName(rec.meeting?.title, base, ext);
  if (rec.drive_file_id) {
    try {
      await renameFile(rec.drive_file_id, name);
    } catch (e) {
      return fail(e instanceof DriveError ? e.message : "Couldn't rename the recording", 502);
    }
  }
  const { error } = await getSupabase().from("meeting_recordings").update({ name }).eq("id", id);
  if (error) return serverError(error);
  return ok({ name });
}

/** Remove: the Drive file goes to the Shared Drive's bin, the row disappears. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Recording not found", 404);
  const rec = await loadRecording(id);
  if (!rec) return fail("Recording not found", 404);
  // An admin deletes any recording; the person recording may discard their own one while it is still open.
  if (!canManage(u, rec) && !(rec.status !== "ready" && canUpload(u, rec))) return fail("Only an admin can delete a recording", 403);
  if (rec.drive_file_id) {
    try {
      await trashFile(rec.drive_file_id);
    } catch (e) {
      return fail(e instanceof DriveError ? e.message : "Couldn't delete the recording", 502);
    }
  }
  const { error } = await getSupabase().from("meeting_recordings").delete().eq("id", id);
  if (error) return serverError(error);
  after(() => logActivity({ action: "meeting.record", entityType: "meeting", entityId: rec.meeting_id, summary: `Recording deleted: “${rec.name}”` }));
  return ok();
}
