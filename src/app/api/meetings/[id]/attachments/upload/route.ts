import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject, storageFail } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid } from "@/lib/validate";
import { LIMITS } from "@/lib/domain";
import { rateLimited } from "@/lib/rate-limit";
import { cleanFileName, imageSize, isImageMime, mimeByName, resolveMime } from "@/lib/attachments";
import { createUploadSession, deleteFile, driveConfigured, ensureFolder, findByAppProperty, streamFile } from "@/lib/google-drive";
import { issueTicket, readTicket } from "@/lib/upload-ticket";
import { MEETING_FILES_FOLDER, MEETING_FILE_SELECT, cleanMeetingNote, countMeetingFiles, meetingForUser, meetingGroup, shapeMeetingFile } from "@/lib/meeting-files";

export const dynamic = "force-dynamic";

const STAMP = "ft_upload";
const MB = 1024 * 1024;

function sameOrigin(req: NextRequest): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return new URL(origin).host === host ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Start a LARGE upload to a meeting (over 24 MB, up to 500 MB). Body {name, size, note?, group?}.
 * Same flow as task files (see /api/tasks/[id]/attachments/upload): a resumable
 * session in the Shared Drive the browser sends the bytes to itself, and a signed
 * ticket to finish with. Replies { url, token, chunk }.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Meeting not found", 404);
  const b = await readJsonObject(req);
  const name = cleanFileName(typeof b.name === "string" ? b.name : "");
  const size = Number(b.size);
  if (!Number.isInteger(size) || size <= 0) return fail("That file is empty");
  if (size > LIMITS.attachmentBytes) return fail(`Files must be under ${Math.round(LIMITS.attachmentBytes / MB)} MB`, 413);
  const mime = mimeByName(name);
  if (!mime) return fail("That file type isn't allowed (images, PDF, text, office documents, zip, video, APK/AAB)");
  if (!driveConfigured()) return fail("File storage isn't set up on this server yet", 400);
  const origin = sameOrigin(req);
  if (!origin) return fail("Upload from the panel itself", 403);
  const [limited, m, count] = await Promise.all([rateLimited(u.uid, "upload", 40, 60), meetingForUser(u, id), countMeetingFiles(id)]);
  if (limited) return limited;
  if (!m) return fail("Meeting not found", 404);
  if (count >= LIMITS.attachmentsPerMeeting) return fail(`A meeting can hold up to ${LIMITS.attachmentsPerMeeting} files`);
  const { token, nonce } = issueTicket({ t: id, u: u.uid, s: size, f: name, m: cleanMeetingNote(b.note), g: meetingGroup(b.group) });
  try {
    const folder = await ensureFolder(MEETING_FILES_FOLDER);
    const url = await createUploadSession(`${m.title} — ${name}`, mime, size, { parent: folder, origin, appProperties: { [STAMP]: nonce } });
    return NextResponse.json({ url, token, chunk: 32 * MB });
  } catch (e) {
    return storageFail(e, "Couldn't start the upload");
  }
}

/** Finish a large upload: find the stamped file, check its size and real type, record it. Body {token}. Safe to repeat. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Meeting not found", 404);
  const b = await readJsonObject(req);
  const ticket = readTicket(b.token);
  if (!ticket || ticket.t !== id || ticket.u !== u.uid) return fail("This upload has expired — add the file again", 410);
  const m = await meetingForUser(u, id);
  if (!m) return fail("Meeting not found", 404);
  let file: Awaited<ReturnType<typeof findByAppProperty>>;
  try {
    file = await findByAppProperty(STAMP, ticket.n);
  } catch (e) {
    return storageFail(e, "Couldn't check the upload");
  }
  if (!file) return fail("The file didn't finish uploading — add it again", 409);
  const sb = getSupabase();
  const { data: existing } = await sb.from("meeting_attachments").select(MEETING_FILE_SELECT).eq("meeting_id", id).eq("drive_file_id", file.id).maybeSingle();
  if (existing) return NextResponse.json({ attachment: shapeMeetingFile(existing as Record<string, unknown>) });
  const reject = async (msg: string, status = 400) => {
    await deleteFile(file.id).catch(() => undefined);
    return fail(msg, status);
  };
  if (file.size !== ticket.s) return reject("The upload arrived incomplete — add the file again", 409);
  let head: Uint8Array;
  try {
    const r = await streamFile(file.id, "bytes=0-65535");
    head = new Uint8Array(await r.arrayBuffer()).subarray(0, 65536);
  } catch (e) {
    return storageFail(e, "Couldn't check the upload");
  }
  const mime = resolveMime(head, ticket.f, null);
  if (!mime) return reject("That file type isn't allowed (images, PDF, text, office documents, zip, video, APK/AAB)");
  const dims = isImageMime(mime) ? imageSize(head, mime) : null;
  const { data, error } = await sb
    .from("meeting_attachments")
    .insert({ meeting_id: id, uploaded_by: u.uid, file_name: ticket.f, mime, size_bytes: file.size, drive_file_id: file.id, width: dims?.width ?? null, height: dims?.height ?? null, note: ticket.m ?? null, group_id: meetingGroup(ticket.g) })
    .select(MEETING_FILE_SELECT)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "P0006") return reject(`A meeting can hold up to ${LIMITS.attachmentsPerMeeting} files`);
    await deleteFile(file.id).catch(() => undefined);
    return serverError(error);
  }
  after(() => logActivity({ action: "meeting.attach", entityType: "meeting", entityId: id, summary: `Added “${ticket.f}” to ${m.title}`, metadata: { bytes: file.size } }));
  return NextResponse.json({ attachment: shapeMeetingFile(data as Record<string, unknown>) });
}
