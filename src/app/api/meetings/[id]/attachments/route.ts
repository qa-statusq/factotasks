import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, ok, serverError, readCappedBody, readJsonObject, storageFail } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid } from "@/lib/validate";
import { LIMITS } from "@/lib/domain";
import { rateLimited } from "@/lib/rate-limit";
import { MAX_INLINE_BYTES, cleanFileName, imageSize, isImageMime, resolveMime } from "@/lib/attachments";
import { driveConfigured, ensureFolder, uploadBytes, deleteFile } from "@/lib/google-drive";
import { MEETING_FILES_FOLDER, MEETING_FILE_SELECT, cleanMeetingNote, countMeetingFiles, meetingForUser, meetingGroup, shapeMeetingFile } from "@/lib/meeting-files";

export const dynamic = "force-dynamic";
// A file of up to 24 MB over a slow mobile connection needs more than the default budget.
export const maxDuration = 60;

const MB = 1024 * 1024;

/** The meeting's files, in the order they were added (or arranged). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Meeting not found", 404);
  const [m, rows] = await Promise.all([meetingForUser(u, id), getSupabase().from("meeting_attachments").select(MEETING_FILE_SELECT).eq("meeting_id", id).order("created_at", { ascending: true })]);
  if (!m) return fail("Meeting not found", 404);
  // Before migration 034 there is no table yet: an empty list, not an error.
  if (rows.error) return NextResponse.json({ attachments: [], enabled: false });
  return NextResponse.json({ attachments: (rows.data || []).map((r) => shapeMeetingFile(r as Record<string, unknown>)), enabled: driveConfigured() });
}

/**
 * Add ONE file (multipart field `file`, up to 24 MB — bigger ones use
 * ./upload), with `note` (the item's title) and `group` (the upload it is part
 * of). The type is sniffed from the bytes, never taken from the name.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Meeting not found", 404);
  const declaredLen = Number(req.headers.get("content-length") || 0);
  if (declaredLen > MAX_INLINE_BYTES + 64 * 1024) return fail(`Files must be under ${Math.round(MAX_INLINE_BYTES / MB)} MB`, 413);
  if (!driveConfigured()) return fail("File storage isn't set up on this server yet", 400);
  const [limited, m, count, raw] = await Promise.all([rateLimited(u.uid, "upload", 40, 60), meetingForUser(u, id), countMeetingFiles(id), readCappedBody(req, MAX_INLINE_BYTES + 64 * 1024)]);
  if (limited) return limited;
  if (!m) return fail("Meeting not found", 404);
  if (count >= LIMITS.attachmentsPerMeeting) return fail(`A meeting can hold up to ${LIMITS.attachmentsPerMeeting} files`);
  if (!raw) return fail(`Files must be under ${Math.round(MAX_INLINE_BYTES / MB)} MB`, 413);
  let form: FormData;
  try {
    form = await new Response(raw, { headers: { "content-type": req.headers.get("content-type") || "" } }).formData();
  } catch {
    return fail("Send the file as multipart/form-data");
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) return fail("No file received");
  const note = cleanMeetingNote(form.get("note"));
  const group = meetingGroup(form.get("group"));
  if (file.size === 0) return fail("That file is empty");
  if (file.size > MAX_INLINE_BYTES) return fail(`Files must be under ${Math.round(MAX_INLINE_BYTES / MB)} MB`, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = cleanFileName((file as File).name || "file");
  const mime = resolveMime(bytes, name, file.type || null);
  if (!mime) return fail("That file type isn't allowed (images, PDF, text, office documents, zip, video, APK/AAB)");
  const dims = isImageMime(mime) ? imageSize(bytes, mime) : null;

  let driveFileId: string;
  try {
    const folder = await ensureFolder(MEETING_FILES_FOLDER);
    driveFileId = await uploadBytes(`${m.title} — ${name}`, mime, bytes, folder);
  } catch (e) {
    return storageFail(e, "Couldn't store the file");
  }
  const { data, error } = await getSupabase()
    .from("meeting_attachments")
    .insert({ meeting_id: id, uploaded_by: u.uid, file_name: name, mime, size_bytes: bytes.length, drive_file_id: driveFileId, width: dims?.width ?? null, height: dims?.height ?? null, note, group_id: group })
    .select(MEETING_FILE_SELECT)
    .single();
  if (error) {
    await deleteFile(driveFileId).catch(() => undefined);
    if ((error as { code?: string }).code === "P0006") return fail(`A meeting can hold up to ${LIMITS.attachmentsPerMeeting} files`);
    return serverError(error);
  }
  after(() => logActivity({ action: "meeting.attach", entityType: "meeting", entityId: id, summary: `Added “${name}” to ${m.title}`, metadata: { bytes: bytes.length } }));
  return NextResponse.json({ attachment: shapeMeetingFile(data as Record<string, unknown>) });
}

/**
 * Put a batch the person just added into the order they picked it (files
 * upload several at a time and are recorded as they finish). Their own files
 * from the last hour only — the same rule as task files.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Meeting not found", 404);
  const b = await readJsonObject(req);
  const order = Array.isArray(b.order) ? b.order : null;
  if (!order || order.length < 2 || order.length > LIMITS.attachmentsPerMeeting || !order.every(isUuid) || new Set(order).size !== order.length) return fail("Invalid order");
  const sb = getSupabase();
  const [m, rows] = await Promise.all([meetingForUser(u, id), sb.from("meeting_attachments").select("id, created_at").eq("meeting_id", id).eq("uploaded_by", u.uid).gte("created_at", new Date(Date.now() - 3600_000).toISOString()).in("id", order)]);
  if (!m) return fail("Meeting not found", 404);
  if (rows.error) return serverError(rows.error);
  if ((rows.data || []).length !== order.length) return fail("Those files can no longer be reordered", 409);
  const first = Math.min(...(rows.data || []).map((r) => Date.parse(r.created_at as string)));
  const results = await Promise.all(order.map((attId: string, i: number) => sb.from("meeting_attachments").update({ created_at: new Date(first + i).toISOString() }).eq("id", attId)));
  const failed = results.find((r) => r.error);
  if (failed) return serverError(failed.error);
  return ok();
}
