import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { fail, serverError, readCappedBody, storageFail } from "@/lib/api";
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
import { driveConfigured, ensureFolder, uploadBytes, trashFile } from "@/lib/google-drive";

const ATTACHMENTS_FOLDER = "Task attachments";

/** Just this task's attachments (the presentation's paperclip) — one round trip, not the whole task. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Task not found", 404);
  const [rows, visible] = await Promise.all([
    getSupabase().from("task_attachments").select(`id, file_name, mime, size_bytes, width, height, created_at, uploader:users(${USER_BRIEF_COLS})`).eq("task_id", id).order("created_at", { ascending: true }),
    canSeeTask(u, id),
  ]);
  if (!visible) return fail("Task not found", 404);
  if (rows.error) return serverError(rows.error);
  return NextResponse.json({
    attachments: (rows.data || []).map((r) => ({
      id: r.id as string,
      file_name: r.file_name as string,
      mime: r.mime as string,
      size_bytes: r.size_bytes as number,
      width: (r.width as number | null) ?? null,
      height: (r.height as number | null) ?? null,
      created_at: r.created_at as string,
      uploaded_by: embeddedUser(r.uploader),
    })),
  });
}

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
  const t0 = performance.now();
  // Cheap pre-check on the declared length before reading the body.
  const declaredLen = Number(req.headers.get("content-length") || 0);
  if (declaredLen > MAX_ATTACHMENT_BYTES + 64 * 1024) return fail(`Files must be under ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`, 413);

  const sb = getSupabase();
  // The four checks run together, AND while the file is still arriving (they used to run one
  // after another, and only then was the body read): one database round trip instead of four,
  // hidden behind the upload itself. Read at most the size limit (plus the form's framing).
  const [limited, own, visible, counted, raw] = await Promise.all([
    rateLimited(u.uid, "upload", 40, 60),
    loadOwnership(id),
    canSeeTask(u, id),
    sb.from("task_attachments").select("id", { count: "exact", head: true }).eq("task_id", id),
    readCappedBody(req, MAX_ATTACHMENT_BYTES + 64 * 1024),
  ]);
  const tReceived = performance.now();
  if (limited) return limited;
  if (!own || !visible) return fail("Task not found", 404);
  if ((counted.count ?? 0) >= LIMITS.attachmentsPerTask) return fail(`A task can hold up to ${LIMITS.attachmentsPerTask} attachments`);
  if (!raw) return fail(`Files must be under ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`, 413);
  let form: FormData;
  try {
    form = await new Response(raw, { headers: { "content-type": req.headers.get("content-type") || "" } }).formData();
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
  const tStore = performance.now();
  if (toDrive) {
    try {
      const folder = await ensureFolder(ATTACHMENTS_FOLDER);
      driveFileId = await uploadBytes(`${taskRef(own.number)} — ${originalName}`, mime, bytes, folder);
    } catch (e) {
      return storageFail(e, "Couldn't store the file");
    }
  } else {
    key = `tasks/${id}/${crypto.randomUUID()}.${extFor(mime, originalName)}`;
    const { error: upErr } = await sb.storage.from("attachments").upload(key, bytes, { contentType: mime, upsert: false, cacheControl: "3600" });
    if (upErr) {
      console.error("[attachments] upload failed:", upErr);
      return fail("Couldn't store the file — is the “attachments” bucket created? (supabase/storage.sql)", 502);
    }
  }

  const tStored = performance.now();
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
  // Where the time went, readable in the browser's network panel (standard Server-Timing).
  const tDone = performance.now();
  const timing = `receive;desc="file + checks";dur=${Math.round(tReceived - t0)}, store;desc="storage";dur=${Math.round(tStored - tStore)}, record;desc="database";dur=${Math.round(tDone - tStored)}`;
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
  }, { headers: { "Server-Timing": timing } });
}
