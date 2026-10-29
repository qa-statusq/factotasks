import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid } from "@/lib/validate";
import { canSeeTask } from "@/lib/visibility";
import { streamFile, trashFile, DriveError } from "@/lib/google-drive";

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL = 600; // seconds

async function load(taskId: string, attId: string) {
  const sb = getSupabase();
  const { data, error } = await sb.from("task_attachments").select("id, task_id, uploaded_by, file_name, mime, size_bytes, storage_path, drive_file_id").eq("id", attId).eq("task_id", taskId).maybeSingle();
  return { att: data as (Record<string, unknown> & { drive_file_id?: string | null }) | null, error };
}

/** Printable ASCII only — what the plain filename= parameter may carry. */
function asciiName(name: string): string {
  let out = "";
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    out += c >= 0x20 && c <= 0x7e && ch !== '"' && ch !== "\\" ? ch : "_";
  }
  return out;
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
  if (att.drive_file_id) {
    // On the Shared Drive: streamed through the panel (Range passes through, so video can seek).
    if (sp.get("json")) return NextResponse.json({ url: `/api/tasks/${id}/attachments/${attId}${asDownload ? "?download=1" : ""}`, expires_in: null });
    try {
      const up = await streamFile(att.drive_file_id as string, asDownload ? null : req.headers.get("range"));
      const headers = new Headers();
      headers.set("content-type", (att.mime as string) || "application/octet-stream");
      for (const h of ["content-length", "content-range", "etag"]) {
        const v = up.headers.get(h);
        if (v) headers.set(h, v);
      }
      headers.set("accept-ranges", "bytes");
      // A stored attachment never changes under its id: the browser keeps it (fetched once, then instant).
      headers.set("cache-control", "private, max-age=604800, immutable");
      headers.set("x-content-type-options", "nosniff");
      const name = att.file_name as string;
      headers.set("content-disposition", `${asDownload ? "attachment" : "inline"}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
      return new Response(up.body, { status: up.status, headers });
    } catch (e) {
      return fail(e instanceof DriveError ? e.message : "Couldn't read the file", 502);
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
      await trashFile(att.drive_file_id as string);
    } catch (e) {
      return fail(e instanceof DriveError ? e.message : "Couldn't remove the file", 502);
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
