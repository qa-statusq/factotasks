import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { cleanLine, isUuid, parseNumber } from "@/lib/validate";
import { loadMeeting } from "@/lib/meetings";
import { rateLimited } from "@/lib/rate-limit";
import { createUploadSession, driveConfigured, DRIVE_CHUNK_BYTES, DriveError } from "@/lib/google-drive";
import { RECORDING_SELECT, shapeRecording, publicRecording, notConfigured, missingTable, recordingFileName, expireStaleUploads } from "@/lib/recordings";

export const dynamic = "force-dynamic";

/** Largest recording the panel accepts: 4 GB (a two-hour 1080p meeting is ~2 GB). */
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const MIMES = ["video/webm", "video/mp4", "video/x-matroska", "audio/webm", "audio/mp4", "audio/ogg"];

/** The meeting's recordings, newest first. Anyone signed in may watch. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Meeting not found", 404);
  await expireStaleUploads();
  const { data, error } = await getSupabase().from("meeting_recordings").select(RECORDING_SELECT).eq("meeting_id", id).order("created_at", { ascending: false });
  if (missingTable(error)) return NextResponse.json({ recordings: [], enabled: false, chunk_bytes: DRIVE_CHUNK_BYTES, migration: "019" });
  if (error) return serverError(error);
  return NextResponse.json({ recordings: ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => publicRecording(shapeRecording(r))), enabled: driveConfigured(), chunk_bytes: DRIVE_CHUNK_BYTES });
}

/**
 * Start saving a recording: { mime, size_bytes?, duration_sec? } → a row in
 * `uploading` state plus the chunk size to send to PUT /api/recordings/:id/chunk.
 * The size is unknown while the browser records and uploads at the same time;
 * it is given when a kept file is re-sent. Admins only (they run the meetings).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  if (u.role !== "admin") return fail("Only admins record meetings", 403);
  const { id } = await params;
  if (!isUuid(id)) return fail("Meeting not found", 404);
  if (!driveConfigured()) return notConfigured();
  const limited = await rateLimited(u.uid, "record", 120, 3600);
  if (limited) return limited;
  const m = await loadMeeting(id);
  if (!m) return fail("Meeting not found", 404);

  const b = await readJsonObject(req);
  const size = b.size_bytes == null ? null : parseNumber(b.size_bytes, 1, MAX_BYTES);
  if (b.size_bytes != null && !size) return fail("The recording is empty or larger than 4 GB");
  const mimeRaw = cleanLine(b.mime, 80).split(";")[0].trim().toLowerCase();
  const mime = MIMES.includes(mimeRaw) ? mimeRaw : "video/webm";
  const duration = parseNumber(b.duration_sec, 0, 12 * 3600);
  const ext = mime === "video/mp4" ? "mp4" : mime === "video/x-matroska" ? "mkv" : mime === "audio/mp4" ? "m4a" : mime === "audio/ogg" ? "ogg" : mime === "audio/webm" ? "weba" : "webm";

  const sb = getSupabase();
  const { data: existing, error: probe } = await sb.from("meeting_recordings").select("id").eq("meeting_id", id).limit(50);
  if (missingTable(probe)) return fail("Recording needs database migration 019 — ask an admin to run it", 503);
  const count = existing?.length ?? 0;
  const name = recordingFileName(m.title, cleanLine(b.name, 120) || `Recording ${count + 1}`, `.${ext}`);

  let uploadUri: string;
  try {
    uploadUri = await createUploadSession(name, mime, size);
  } catch (e) {
    return fail(e instanceof DriveError ? e.message : "Couldn't start saving the recording", 502);
  }
  const { data, error } = await sb
    .from("meeting_recordings")
    .insert({ meeting_id: id, name, mime, size_bytes: size ?? 0, duration_sec: duration ?? null, status: "uploading", upload_uri: uploadUri, recorded_by: u.uid })
    .select(RECORDING_SELECT)
    .single();
  if (missingTable(error)) return fail("Recording needs database migration 019 — ask an admin to run it", 503);
  if (error) return serverError(error);
  const rec = shapeRecording(data as unknown as Record<string, unknown>);
  after(() => logActivity({ action: "meeting.record", entityType: "meeting", entityId: id, summary: `Recording started for “${m.title}”` }));
  return NextResponse.json({ recording: publicRecording(rec), chunk_bytes: DRIVE_CHUNK_BYTES });
}
