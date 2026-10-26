import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid } from "@/lib/validate";
import { LIMITS, taskRef } from "@/lib/domain";
import { canSeeTask } from "@/lib/visibility";
import { loadOwnership, involved } from "@/lib/tasks";
import { notifyUsers } from "@/lib/notify";
import { displayName } from "@/lib/name";
import { rateLimited } from "@/lib/rate-limit";
import { MAX_ATTACHMENT_BYTES, cleanFileName, extFor, imageSize, isImageMime, resolveMime } from "@/lib/attachments";
import { USER_BRIEF_COLS, embeddedUser } from "@/lib/users";
import { driveConfigured, ensureFolder, uploadBytes, trashFile, DriveError } from "@/lib/google-drive";

const ATTACHMENTS_FOLDER = "Task attachments";

export const dynamic = "force-dynamic";
// A 15 MB upload over a slow mobile connection needs more than the default budget.
export const maxDuration = 60;

/**
 * Upload ONE file (multipart field `file`) to the private bucket and record
 * it. Any signed-in user may attach to any task (a QA tester adds a screen
 * recording to a dev's bug). The type is SNIFFED, the key is generated, the
 * size is capped here and again by the bucket.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Task not found", 404);
  const limited = await rateLimited(u.uid, "upload", 40, 60);
  if (limited) return limited;

  // Cheap pre-check on the declared length before reading the body.
  const declaredLen = Number(req.headers.get("content-length") || 0);
  if (declaredLen > MAX_ATTACHMENT_BYTES + 64 * 1024) return fail(`Files must be under ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`, 413);

  const own = await loadOwnership(id);
  if (!own) return fail("Task not found", 404);
  if (!(await canSeeTask(u, id))) return fail("Task not found", 404);
  const sb = getSupabase();
  const { count } = await sb.from("task_attachments").select("id", { count: "exact", head: true }).eq("task_id", id);
  if ((count ?? 0) >= LIMITS.attachmentsPerTask) return fail(`A task can hold up to ${LIMITS.attachmentsPerTask} attachments`);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("Send the file as multipart/form-data");
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) return fail("No file received");
  if (file.size === 0) return fail("That file is empty");
  if (file.size > MAX_ATTACHMENT_BYTES) return fail(`Files must be under ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`, 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const originalName = cleanFileName((file as File).name || "file");
  const mime = resolveMime(bytes, originalName, file.type || null);
  if (!mime) return fail("That file type isn't allowed (images, PDF, text, office documents, zip, video, APK/AAB)");
  const dims = isImageMime(mime) ? imageSize(bytes, mime) : null;

  // Where it goes: the team's Google Shared Drive ("Task attachments" folder) once the panel is set up for it;
  // the Supabase bucket until then (and for every file uploaded before).
  const toDrive = driveConfigured();
  let key: string | null = null;
  let driveFileId: string | null = null;
  if (toDrive) {
    try {
      const folder = await ensureFolder(ATTACHMENTS_FOLDER);
      driveFileId = await uploadBytes(`${taskRef(own.number)} — ${originalName}`, mime, bytes, folder);
    } catch (e) {
      return fail(e instanceof DriveError ? e.message : "Couldn't store the file", 502);
    }
  } else {
    key = `tasks/${id}/${crypto.randomUUID()}.${extFor(mime, originalName)}`;
    const { error: upErr } = await sb.storage.from("attachments").upload(key, bytes, { contentType: mime, upsert: false, cacheControl: "3600" });
    if (upErr) {
      console.error("[attachments] upload failed:", upErr);
      return fail("Couldn't store the file — is the “attachments” bucket created? (supabase/storage.sql)", 502);
    }
  }

  const { data, error } = await sb
    .from("task_attachments")
    .insert({ task_id: id, uploaded_by: u.uid, file_name: originalName, mime, size_bytes: bytes.length, storage_path: key, ...(toDrive ? { drive_file_id: driveFileId } : {}), width: dims?.width ?? null, height: dims?.height ?? null })
    .select(`id, file_name, mime, size_bytes, width, height, created_at, uploader:users(${USER_BRIEF_COLS})`)
    .single();
  if (error) {
    if (key) await sb.storage.from("attachments").remove([key]);
    if (driveFileId) await trashFile(driveFileId).catch(() => undefined);
    if ((error as { code?: string }).code === "P0006") return fail(`A task can hold up to ${LIMITS.attachmentsPerTask} attachments`);
    return serverError(error);
  }

  const actor = displayName(u.firstName, u.lastName) || u.email;
  after(async () => {
    await logActivity({ action: "task.attach", entityType: "task", entityId: id, summary: `Attached “${originalName}” to ${taskRef(own.number)}`, metadata: { number: own.number, bytes: bytes.length } });
    await notifyUsers({ userIds: involved(own), kind: "task.attachment", taskId: id, actorId: u.uid, message: `${actor} attached “${originalName}” to ${taskRef(own.number)}` });
  });
  return NextResponse.json({
    attachment: {
      id: data.id,
      file_name: data.file_name,
      mime: data.mime,
      size_bytes: data.size_bytes,
      width: data.width ?? null,
      height: data.height ?? null,
      created_at: data.created_at,
      uploaded_by: embeddedUser(data.uploader),
    },
  });
}
