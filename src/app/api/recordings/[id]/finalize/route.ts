import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { fail, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid, parseNumber } from "@/lib/validate";
import { DriveError } from "@/lib/google-drive";
import { loadRecording, canUpload, publicRecording } from "@/lib/recordings";
import { closeUpload } from "@/lib/recording-uploads";

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
  try {
    const r = await closeUpload(rec, duration);
    if (r.empty) return fail("Nothing of this recording had been saved yet", 410);
    if (!r.done) return fail(r.recording?.status === "failed" ? "The upload had already expired" : "Couldn't close the recording", r.recording?.status === "failed" ? 410 : 502);
    if (r.recovered) after(() => logActivity({ action: "meeting.record", entityType: "meeting", entityId: rec.meeting_id, summary: `Recording saved after an interruption: “${rec.name}”` }));
    return NextResponse.json({ done: true, recovered: !!r.recovered, recording: r.recording ? publicRecording(r.recording) : null });
  } catch (e) {
    return fail(e instanceof DriveError ? e.message : "Couldn't close the recording", 502);
  }
}
