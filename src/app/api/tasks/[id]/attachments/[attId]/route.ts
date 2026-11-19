import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, storageFail } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid } from "@/lib/validate";
import { canSeeTask } from "@/lib/visibility";
import { deleteFile } from "@/lib/google-drive";
import { serveDriveFile } from "@/lib/serve-file";
import { isOfficeDoc, officePreview } from "@/lib/doc-preview";

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL = 600; // seconds

async function load(taskId: string, attId: string) {
  const sb = getSupabase();
  const { data, error } = await sb.from("task_attachments").select("id, task_id, uploaded_by, file_name, mime, size_bytes, storage_path, drive_file_id, preview_file_id").eq("id", attId).eq("task_id", taskId).maybeSingle();
  return { att: data as (Record<string, unknown> & { drive_file_id?: string | null; preview_file_id?: string | null }) | null, error };
}


/**
 * Download / preview. Default: 302 to a short-lived signed URL (works for
 * <a href>, <img src> and <video src> alike — the bucket is private, the URL
 * dies in 10 minutes). `?json=1` returns { url } instead for scripted use.
 * `?download=1` forces a Content-Disposition attachment with the real name.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; attId: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id, attId } = await params;
  if (!isUuid(id) || !isUuid(attId)) return fail("Attachment not found", 404);
  const [{ att, error: loadError }, visible] = await Promise.all([load(id, attId), canSeeTask(u, id)]);
  if (loadError) return serverError(loadError);
  if (!att || !visible) return fail("Attachment not found", 404);
  const sp = new URL(req.url).searchParams;
  // SVG can carry scripts: it is always served as a download, never rendered
  // from the storage origin.
  const asDownload = !!sp.get("download") || att.mime === "image/svg+xml";
  // `?preview=1` on a Word / Excel / PowerPoint file: its PDF (made by Google once, then kept).
  if (sp.get("preview") && att.drive_file_id && isOfficeDoc(att.mime as string)) {
    try {
      const pv = await officePreview("task_attachments", { id: att.id as string, mime: att.mime as string, file_name: att.file_name as string, drive_file_id: att.drive_file_id, preview_file_id: att.preview_file_id });
      return await serveDriveFile(req.headers.get("range"), { fileId: pv.id, size: pv.size, mime: "application/pdf", name: `${(att.file_name as string).replace(/\.[^.]+$/, "")}.pdf`, cacheControl: "private, max-age=604800, immutable", extra: { "x-content-type-options": "nosniff" } });
    } catch (e) {
      return storageFail(e, "Couldn't make a preview of this document — download it instead");
    }
  }
  if (att.drive_file_id) {
    // On the Shared Drive: streamed through the panel by byte range, in pieces of at most 16 MiB (lib/serve-file).
    if (sp.get("json")) return NextResponse.json({ url: `/api/tasks/${id}/attachments/${attId}${asDownload ? "?download=1" : ""}`, expires_in: null });
    try {
      return await serveDriveFile(req.headers.get("range"), {
        fileId: att.drive_file_id as string,
        size: Number(att.size_bytes),
        mime: (att.mime as string) || "application/octet-stream",
        name: att.file_name as string,
        download: asDownload,
        // A stored attachment never changes under its id: the browser keeps it (fetched once, then instant).
        cacheControl: "private, max-age=604800, immutable",
        extra: { "x-content-type-options": "nosniff" },
      });
    } catch (e) {
      return storageFail(e, "Couldn't read the file");
    }
  }
  const { data, error } = await getSupabase()
    .storage.from("attachments")
    .createSignedUrl(att.storage_path as string, SIGNED_URL_TTL, asDownload ? { download: att.file_name as string } : undefined);
  if (error || !data?.signedUrl) return serverError(error ?? new Error("no signed url"));
  if (sp.get("json")) return NextResponse.json({ url: data.signedUrl, expires_in: SIGNED_URL_TTL });
  // `?proxy=1`: the bytes through the panel (same origin), for in-page previews of bucket files.
  if (sp.get("proxy")) {
    const up = await fetch(data.signedUrl, { headers: req.headers.get("range") ? { range: req.headers.get("range") as string } : {} });
    const headers = new Headers();
    headers.set("content-type", (att.mime as string) || up.headers.get("content-type") || "application/octet-stream");
    for (const h of ["content-length", "content-range"]) {
      const v = up.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set("cache-control", "private, max-age=600");
    headers.set("x-content-type-options", "nosniff");
    return new Response(up.body, { status: up.status, headers });
  }
  const res = NextResponse.redirect(data.signedUrl, 302);
  // Let the browser reuse the redirect for the signed URL's lifetime so an
  // image grid doesn't re-sign on every re-render.
  res.headers.set("Cache-Control", `private, max-age=${SIGNED_URL_TTL - 30}`);
  return res;
}

/** Remove (uploader or admin). Storage first, then the row. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; attId: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id, attId } = await params;
  if (!isUuid(id) || !isUuid(attId)) return fail("Attachment not found", 404);
  const [{ att, error: loadError }, visible] = await Promise.all([load(id, attId), canSeeTask(u, id)]);
  if (loadError) return serverError(loadError);
  if (!att || !visible) return fail("Attachment not found", 404);
  if (att.uploaded_by !== u.uid && u.role !== "admin") return fail("You can only remove files you uploaded", 403);
  const sb = getSupabase();
  if (att.drive_file_id) {
    try {
      await deleteFile(att.drive_file_id as string);
      if (att.preview_file_id) await deleteFile(att.preview_file_id).catch(() => undefined);
    } catch (e) {
      return storageFail(e, "Couldn't remove the file");
    }
  } else if (att.storage_path) {
    const { error: sErr } = await sb.storage.from("attachments").remove([att.storage_path as string]);
    if (sErr) console.error("[attachments] storage remove failed:", sErr);
  }
  const { error } = await sb.from("task_attachments").delete().eq("id", attId);
  if (error) return serverError(error);
  after(() => logActivity({ action: "task.detach", entityType: "task", entityId: id, summary: `Removed attachment “${att.file_name}”` }));
  return ok();
}
