import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readJsonObject, storageFail } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid } from "@/lib/validate";
import { LIMITS, taskRef } from "@/lib/domain";
import { canSeeTask } from "@/lib/visibility";
import { loadOwnership, involved } from "@/lib/tasks";
import { notifyUsers } from "@/lib/notify";
import { displayName } from "@/lib/name";
import { rateLimited } from "@/lib/rate-limit";
import { ATTACHMENTS_FOLDER, MAX_INLINE_BYTES, cleanFileName, imageSize, isImageMime, mimeByName, resolveMime } from "@/lib/attachments";
import { USER_BRIEF_COLS, embeddedUser } from "@/lib/users";
import { createUploadSession, deleteFile, driveConfigured, ensureFolder, findByAppProperty, streamFile } from "@/lib/google-drive";
import { issueTicket, readTicket } from "@/lib/upload-ticket";

export const dynamic = "force-dynamic";

const STAMP = "ft_upload";
const MB = 1024 * 1024;

/** Only the panel's own pages may receive an upload session (Google answers that origin with CORS). */
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
 * Start a LARGE upload (over the one-request size, up to 500 MB). Body {name, size}.
 * The same checks as a normal upload run first; then a resumable session is opened in
 * the Shared Drive for exactly this many bytes, and the browser sends the file there
 * itself, in pieces, with real progress — nothing big passes through the panel.
 * Replies { url, token, chunk }: the session, the ticket for finishing, the piece size.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Task not found", 404);
  const b = await readJsonObject(req);
  const name = cleanFileName(typeof b.name === "string" ? b.name : "");
  const size = Number(b.size);
  if (!Number.isInteger(size) || size <= 0) return fail("That file is empty");
  if (size > LIMITS.attachmentBytes) return fail(`Files must be under ${Math.round(LIMITS.attachmentBytes / MB)} MB`, 413);
  const mime = mimeByName(name);
  if (!mime) return fail("That file type isn't allowed (images, PDF, text, office documents, zip, video, APK/AAB)");
  if (!driveConfigured()) return fail(`Files over ${Math.round(MAX_INLINE_BYTES / MB)} MB need the team storage to be set up`, 400);
  const origin = sameOrigin(req);
  if (!origin) return fail("Upload from the panel itself", 403);

  const sb = getSupabase();
  const [limited, own, visible, counted] = await Promise.all([
    rateLimited(u.uid, "upload", 40, 60),
    loadOwnership(id),
    canSeeTask(u, id),
    sb.from("task_attachments").select("id", { count: "exact", head: true }).eq("task_id", id),
  ]);
  if (limited) return limited;
  if (!own || !visible) return fail("Task not found", 404);
  if ((counted.count ?? 0) >= LIMITS.attachmentsPerTask) return fail(`A task can hold up to ${LIMITS.attachmentsPerTask} attachments`);

  const { token, nonce } = issueTicket({ t: id, u: u.uid, s: size, f: name });
  try {
    const folder = await ensureFolder(ATTACHMENTS_FOLDER);
    const url = await createUploadSession(`${taskRef(own.number)} — ${name}`, mime, size, { parent: folder, origin, appProperties: { [STAMP]: nonce } });
    // 32 MiB pieces (a multiple of 256 KiB, as Google requires): few round trips, and a
    // dropped connection only re-sends the piece it was on.
    return NextResponse.json({ url, token, chunk: 32 * MB });
  } catch (e) {
    return storageFail(e, "Couldn't start the upload");
  }
}

/**
 * Finish a large upload. Body {token}. The file the ticket stamped is looked up in the
 * Shared Drive, its size checked against the ticket and its first bytes sniffed exactly
 * like a normal upload; a file that fails is deleted. Then it is recorded on the task.
 * Replies { attachment } (the same shape as a normal upload). Safe to repeat.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Task not found", 404);
  const b = await readJsonObject(req);
  const ticket = readTicket(b.token);
  if (!ticket || ticket.t !== id || ticket.u !== u.uid) return fail("This upload has expired — add the file again", 410);

  const sb = getSupabase();
  const [own, visible] = await Promise.all([loadOwnership(id), canSeeTask(u, id)]);
  if (!own || !visible) return fail("Task not found", 404);

  let file: Awaited<ReturnType<typeof findByAppProperty>>;
  try {
    file = await findByAppProperty(STAMP, ticket.n);
  } catch (e) {
    return storageFail(e, "Couldn't check the upload");
  }
  if (!file) return fail("The file didn't finish uploading — add it again", 409);

  const SELECT = `id, file_name, mime, size_bytes, width, height, created_at, uploader:users(${USER_BRIEF_COLS})`;
  const shape = (r: Record<string, unknown>) => ({
    id: r.id as string,
    file_name: r.file_name as string,
    mime: r.mime as string,
    size_bytes: r.size_bytes as number,
    width: (r.width as number | null) ?? null,
    height: (r.height as number | null) ?? null,
    created_at: r.created_at as string,
    uploaded_by: embeddedUser(r.uploader),
  });
  // Already recorded (a retried finish): answer with the same row.
  const { data: existing } = await sb.from("task_attachments").select(SELECT).eq("task_id", id).eq("drive_file_id", file.id).maybeSingle();
  if (existing) return NextResponse.json({ attachment: shape(existing as Record<string, unknown>) });

  const reject = async (msg: string, status = 400) => {
    await deleteFile(file.id).catch(() => undefined);
    return fail(msg, status);
  };
  if (file.size !== ticket.s) return reject("The upload arrived incomplete — add the file again", 409);
  // The real type, from the file's own first bytes (never the name or the browser's word).
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
    .from("task_attachments")
    .insert({ task_id: id, uploaded_by: u.uid, file_name: ticket.f, mime, size_bytes: file.size, storage_path: null, drive_file_id: file.id, width: dims?.width ?? null, height: dims?.height ?? null })
    .select(SELECT)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "P0006") return reject(`A task can hold up to ${LIMITS.attachmentsPerTask} attachments`);
    await deleteFile(file.id).catch(() => undefined);
    return serverError(error);
  }

  const actor = displayName(u.firstName, u.lastName) || u.email;
  after(async () => {
    await logActivity({ action: "task.attach", entityType: "task", entityId: id, summary: `Attached “${ticket.f}” to ${taskRef(own.number)}`, metadata: { number: own.number, bytes: file.size } });
    await notifyUsers({ userIds: involved(own), kind: "task.attachment", taskId: id, actorId: u.uid, message: `${actor} attached “${ticket.f}” to ${taskRef(own.number)}` });
  });
  return NextResponse.json({ attachment: shape(data as Record<string, unknown>) });
}
