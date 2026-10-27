import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readCappedBody } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid } from "@/lib/validate";
import { uploadChunk, uploadStatus, DriveError, DRIVE_CHUNK_BYTES } from "@/lib/google-drive";
import { loadRecording, canUpload, publicRecording, RECORDING_SELECT, shapeRecording } from "@/lib/recordings";

export const dynamic = "force-dynamic";

/**
 * One chunk of the file, relayed to the Drive upload session.
 *   headers: x-chunk-offset (bytes already sent), x-chunk-total ("*" while the
 *   recording still runs, the real size with the last chunk), x-duration-sec
 *   (with the last chunk); body: the chunk (≤ 8 MiB, a multiple of 256 KiB
 *   unless it is the last; may be empty with a total to close the upload).
 * Replies { received } while more is needed, { done: true, recording } once
 * Google has the whole file. GET returns where the upload stands, so a
 * browser that lost its connection can resume.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Recording not found", 404);
  const rec = await loadRecording(id);
  if (!rec || !canUpload(u, rec)) return fail("Recording not found", 404);
  if (rec.status !== "uploading" || !rec.upload_uri) return fail("This recording is not being uploaded", 409);
  const offset = Number(req.headers.get("x-chunk-offset") ?? "NaN");
  const totalRaw = req.headers.get("x-chunk-total") ?? (rec.size_bytes ? String(rec.size_bytes) : "*");
  const total = totalRaw === "*" ? null : Number(totalRaw);
  if (!Number.isInteger(offset) || offset < 0) return fail("Bad chunk offset");
  if (total === 0 && offset === 0) {
    // Stopped before the capture produced a byte: there is no recording to keep.
    await getSupabase().from("meeting_recordings").delete().eq("id", id);
    return NextResponse.json({ done: true, empty: true, received: 0, recording: null });
  }
  if (total != null && (!Number.isInteger(total) || total <= 0 || offset > total)) return fail("Bad total size");
  // Never buffer more than one chunk, whatever the request declares.
  const body = await readCappedBody(req, DRIVE_CHUNK_BYTES);
  if (!body) return fail("Chunk too large");
  const last = total != null && offset + body.byteLength === total;
  if (!body.byteLength && !last) return fail("Empty chunk");
  if (total != null && offset + body.byteLength > total) return fail("Chunk runs past the end of the file");
  if (!last && body.byteLength % (256 * 1024) !== 0) return fail("Chunk must be a multiple of 256 KiB");
  const durationRaw = req.headers.get("x-duration-sec");
  const duration = durationRaw ? Number(durationRaw) : null;

  try {
    const r = await uploadChunk(rec.upload_uri, body, offset, total);
    const sb = getSupabase();
    if (!r.done) {
      // Size and length so far, so the meeting's card shows a recording that is really happening
      // (every ~30 s: each write moves the change counter that every open tab watches).
      if (Date.parse(rec.updated_at) < Date.now() - 30_000) {
        after(async () => {
          await sb.from("meeting_recordings").update({ size_bytes: r.received, ...(duration != null && Number.isFinite(duration) && duration >= 0 ? { duration_sec: Math.round(duration) } : {}) }).eq("id", id);
        });
      }
      return NextResponse.json({ done: false, received: r.received });
    }
    const { data: saved, error } = await sb
      .from("meeting_recordings")
      .update({
        status: "ready",
        drive_file_id: r.file?.id ?? null,
        upload_uri: null,
        size_bytes: r.file?.size ? Number(r.file.size) : (total ?? rec.size_bytes),
        ...(duration != null && Number.isFinite(duration) && duration >= 0 ? { duration_sec: Math.round(duration) } : {}),
      })
      .eq("id", id)
      .select(RECORDING_SELECT)
      .single();
    if (error) return serverError(error);
    after(() => logActivity({ action: "meeting.record", entityType: "meeting", entityId: rec.meeting_id, summary: `Recording saved: “${rec.name}”` }));
    return NextResponse.json({ done: true, received: total ?? offset + body.byteLength, recording: saved ? publicRecording(shapeRecording(saved as unknown as Record<string, unknown>)) : null });
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) {
      await getSupabase().from("meeting_recordings").update({ status: "failed", upload_uri: null }).eq("id", id);
      return fail("The upload session expired — record again", 410);
    }
    return fail(e instanceof DriveError ? e.message : "Couldn't save this part of the recording", 502);
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Recording not found", 404);
  const rec = await loadRecording(id);
  if (!rec || !canUpload(u, rec)) return fail("Recording not found", 404);
  if (rec.status !== "uploading" || !rec.upload_uri) return NextResponse.json({ done: rec.status === "ready", received: rec.status === "ready" ? rec.size_bytes : 0, recording: rec.status === "ready" ? publicRecording(rec) : null });
  try {
    const s = await uploadStatus(rec.upload_uri, rec.size_bytes || null);
    return NextResponse.json({ done: s.done, received: s.received });
  } catch (e) {
    return fail(e instanceof DriveError ? e.message : "Couldn't check the upload", 502);
  }
}
