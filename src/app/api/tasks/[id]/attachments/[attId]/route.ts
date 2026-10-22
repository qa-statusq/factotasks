import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid } from "@/lib/validate";
import { canSeeTask } from "@/lib/visibility";

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL = 600; // seconds

async function load(taskId: string, attId: string) {
  const { data } = await getSupabase().from("task_attachments").select("id, task_id, uploaded_by, file_name, mime, storage_path").eq("id", attId).eq("task_id", taskId).maybeSingle();
  return data;
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
  const [att, visible] = await Promise.all([load(id, attId), canSeeTask(u, id)]);
  if (!att || !visible) return fail("Attachment not found", 404);
  const sp = new URL(req.url).searchParams;
  // SVG can carry scripts: it is always served as a download, never rendered
  // from the storage origin.
  const asDownload = !!sp.get("download") || att.mime === "image/svg+xml";
  const { data, error } = await getSupabase()
    .storage.from("attachments")
    .createSignedUrl(att.storage_path as string, SIGNED_URL_TTL, asDownload ? { download: att.file_name as string } : undefined);
  if (error || !data?.signedUrl) return serverError(error ?? new Error("no signed url"));
  if (sp.get("json")) return NextResponse.json({ url: data.signedUrl, expires_in: SIGNED_URL_TTL });
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
  const [att, visible] = await Promise.all([load(id, attId), canSeeTask(u, id)]);
  if (!att || !visible) return fail("Attachment not found", 404);
  if (att.uploaded_by !== u.uid && u.role !== "admin") return fail("You can only remove files you uploaded", 403);
  const sb = getSupabase();
  const { error: sErr } = await sb.storage.from("attachments").remove([att.storage_path as string]);
  if (sErr) console.error("[attachments] storage remove failed:", sErr);
  const { error } = await sb.from("task_attachments").delete().eq("id", attId);
  if (error) return serverError(error);
  await logActivity({ action: "task.detach", entityType: "task", entityId: id, summary: `Removed attachment “${att.file_name}”` });
  return ok();
}
