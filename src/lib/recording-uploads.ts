import { getSupabase } from "@/lib/supabase";
import { uploadStatus, uploadChunk, DriveError } from "@/lib/google-drive";
import { RECORDING_SELECT, shapeRecording, loadRecording, type RecordingRow } from "@/lib/recordings";

/**
 * Close an open upload with whatever has already arrived at the storage. Used when the
 * browser leaves mid-recording (beacon), when the panel comes back, and by the stale sweep.
 *  - nothing arrived → the row is deleted (there is no recording to keep)
 *  - the storage has it all / it can be closed → the row becomes ready
 *  - the storage lost the session → the row is marked failed
 */
export async function closeUpload(rec: RecordingRow, durationSec?: number | null): Promise<{ done: boolean; empty?: boolean; recovered?: boolean; recording: RecordingRow | null }> {
  const sb = getSupabase();
  if (rec.status === "ready") return { done: true, recording: rec };
  if (rec.status !== "uploading" || !rec.upload_uri) return { done: false, recording: rec };
  try {
    const st = await uploadStatus(rec.upload_uri, rec.size_bytes || null);
    let file = st.file;
    if (!st.done) {
      if (st.received <= 0) {
        await sb.from("meeting_recordings").delete().eq("id", rec.id);
        return { done: false, empty: true, recording: null };
      }
      const closed = await uploadChunk(rec.upload_uri, new ArrayBuffer(0), st.received, st.received);
      if (!closed.done) return { done: false, recording: rec };
      file = closed.file;
    }
    const { error } = await sb
      .from("meeting_recordings")
      .update({ status: "ready", drive_file_id: file?.id ?? null, upload_uri: null, size_bytes: file?.size ? Number(file.size) : st.received, ...(durationSec != null ? { duration_sec: Math.round(durationSec) } : {}) })
      .eq("id", rec.id);
    if (error) throw error;
    return { done: true, recovered: !st.done, recording: await loadRecording(rec.id) };
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) {
      await sb.from("meeting_recordings").update({ status: "failed", upload_uri: null }).eq("id", rec.id);
      return { done: false, recording: await loadRecording(rec.id) };
    }
    throw e;
  }
}

/** How long an open upload may sit without a chunk before it counts as abandoned (the browser sends one at least every 5 s). */
const UPLOAD_IDLE_MS = 15 * 60_000;
/** A recording that never received a byte within this time never started (the capture was refused or stopped at once). */
const NEVER_STARTED_MS = 10 * 60_000;

/**
 * Tidy uploads nobody is feeding any more, so the lists never show a "recording" that is not happening:
 * rows that never received a byte are removed, and rows abandoned mid-way keep what arrived.
 */
export async function expireStaleUploads(): Promise<void> {
  const sb = getSupabase();
  const now = Date.now();
  await sb.from("meeting_recordings").delete().eq("status", "uploading").eq("size_bytes", 0).lt("created_at", new Date(now - NEVER_STARTED_MS).toISOString());
  const { data } = await sb.from("meeting_recordings").select(RECORDING_SELECT).eq("status", "uploading").gt("size_bytes", 0).lt("updated_at", new Date(now - UPLOAD_IDLE_MS).toISOString()).limit(10);
  for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
    const rec = shapeRecording(row);
    try {
      await closeUpload(rec, rec.duration_sec ?? null);
    } catch {
      await sb.from("meeting_recordings").update({ status: "failed", upload_uri: null }).eq("id", rec.id);
    }
  }
}
