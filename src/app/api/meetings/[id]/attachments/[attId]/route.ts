import { NextRequest, NextResponse, after } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { getSupabase } from "@/lib/supabase";
import { ok, fail, serverError, storageFail } from "@/lib/api";
import { logActivity } from "@/lib/activity";
import { isUuid } from "@/lib/validate";
import { deleteFile } from "@/lib/google-drive";
import { serveDriveFile } from "@/lib/serve-file";
import { meetingForUser } from "@/lib/meeting-files";
import { isOfficeDoc, officePreview } from "@/lib/doc-preview";

export const dynamic = "force-dynamic";

async function load(meetingId: string, attId: string) {
  const { data, error } = await getSupabase().from("meeting_attachments").select("id, meeting_id, uploaded_by, file_name, mime, size_bytes, drive_file_id, preview_file_id").eq("id", attId).eq("meeting_id", meetingId).maybeSingle();
  return { att: data as { id: string; uploaded_by: string | null; file_name: string; mime: string; size_bytes: number; drive_file_id: string; preview_file_id: string | null } | null, error };
}

/** The file, by byte range in pieces of at most 16 MiB (lib/serve-file). `?download=1` saves it with its name. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; attId: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id, attId } = await params;
  if (!isUuid(id) || !isUuid(attId)) return fail("File not found", 404);
  const [{ att, error }, m] = await Promise.all([load(id, attId), meetingForUser(u, id)]);
  if (error) return serverError(error);
  if (!att || !m) return fail("File not found", 404);
  const sp = new URL(req.url).searchParams;
  // `?preview=1` on a Word / Excel / PowerPoint file: its PDF (made by Google once, then kept).
  if (sp.get("preview") && isOfficeDoc(att.mime)) {
    try {
      const pv = await officePreview("meeting_attachments", att);
      return await serveDriveFile(req.headers.get("range"), { fileId: pv.id, size: pv.size, mime: "application/pdf", name: `${att.file_name.replace(/\.[^.]+$/, "")}.pdf`, cacheControl: "private, max-age=604800, immutable", extra: { "x-content-type-options": "nosniff" } });
    } catch (e) {
      return storageFail(e, "Couldn't make a preview of this document — download it instead");
    }
  }
  try {
    return await serveDriveFile(req.headers.get("range"), {
      fileId: att.drive_file_id,
      size: Number(att.size_bytes),
      mime: att.mime || "application/octet-stream",
      name: att.file_name,
      // SVG can carry scripts: always a download, never rendered from the panel's origin.
      download: !!sp.get("download") || att.mime === "image/svg+xml",
      cacheControl: "private, max-age=604800, immutable",
      extra: { "x-content-type-options": "nosniff" },
    });
  } catch (e) {
    return storageFail(e, "Couldn't read the file");
  }
}

/** Remove (whoever added it, or an admin): deleted for good from storage, then the row. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; attId: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id, attId } = await params;
  if (!isUuid(id) || !isUuid(attId)) return fail("File not found", 404);
  const [{ att, error: loadError }, m] = await Promise.all([load(id, attId), meetingForUser(u, id)]);
  if (loadError) return serverError(loadError);
  if (!att || !m) return fail("File not found", 404);
  if (att.uploaded_by !== u.uid && u.role !== "admin") return fail("You can only remove files you added", 403);
  try {
    await deleteFile(att.drive_file_id);
    if (att.preview_file_id) await deleteFile(att.preview_file_id).catch(() => undefined);
  } catch (e) {
    return storageFail(e, "Couldn't remove the file");
  }
  const { error } = await getSupabase().from("meeting_attachments").delete().eq("id", attId);
  if (error) return serverError(error);
  after(() => logActivity({ action: "meeting.detach", entityType: "meeting", entityId: id, summary: `Removed “${att.file_name}” from ${m.title}` }));
  return ok();
}
