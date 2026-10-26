import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid, parseNumber } from "@/lib/validate";
import { uploadStatus, uploadChunk, DriveError } from "@/lib/google-drive";
import { loadRecording, canUpload, publicRecording } from "@/lib/recordings";

export const dynamic = "force-dynamic";

/**
 * Close an upload with whatever has already arrived — the browser calls this
 * (as a beacon) when the tab is closed or reloaded mid-recording, and again
 * when the panel comes back, so the part recorded until then is kept as the
 * recording instead of being lost. Idempotent: a finished recording is
 * simply returned.
 *   body: { duration_sec? }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Recording not found", 404);
  const rec = await loadRecording(id);
  if (!rec || !canUpload(u, rec)) return fail("Recording not found", 404);
  if (rec.status === "ready") return NextResponse.json({ done: true, recording: publicRecording(rec) });
  if (rec.status !== "uploading" || !rec.upload_uri) return fail("This recording can't be recovered", 410);
  const b = await readJsonObject(req).catch(() => ({}) as Record<string, unknown>);
  const duration = parseNumber(b.duration_sec, 0, 12 * 3600);
  const sb = getSupabase();
  try {
    const st = await uploadStatus(rec.upload_uri, rec.size_bytes || null);
    let file = st.file;
    if (!st.done) {
      if (st.received <= 0) {
        await sb.from("meeting_recordings").update({ status: "failed", upload_uri: null }).eq("id", id);
        return fail("Nothing of this recording had been saved yet", 410);
      }
      const closed = await uploadChunk(rec.upload_uri, new ArrayBuffer(0), st.received, st.received);
      if (!closed.done) return fail("Couldn't close the recording", 502);
      file = closed.file;
    }
    const { error } = await sb
      .from("meeting_recordings")
      .update({ status: "ready", drive_file_id: file?.id ?? null, upload_uri: null, size_bytes: file?.size ? Number(file.size) : st.received, ...(duration != null ? { duration_sec: Math.round(duration) } : {}) })
      .eq("id", id);
    if (error) return serverError(error);
    const fresh = await loadRecording(id);
    after(() => logActivity({ action: "meeting.record", entityType: "meeting", entityId: rec.meeting_id, summary: `Recording saved after an interruption: “${rec.name}”` }));
    return NextResponse.json({ done: true, recovered: !st.done, recording: fresh ? publicRecording(fresh) : null });
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) {
      await sb.from("meeting_recordings").update({ status: "failed", upload_uri: null }).eq("id", id);
      return fail("The upload had already expired", 410);
    }
    return fail(e instanceof DriveError ? e.message : "Couldn't close the recording", 502);
  }
}
