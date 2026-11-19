import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { fail, storageFail } from "@/lib/api";
import { isUuid } from "@/lib/validate";
import { loadRecording } from "@/lib/recordings";
import { canAccessSeries } from "@/lib/series-access";
import { readSeekIndex, recordingHead } from "@/lib/recording-index";
import { serveDriveFile } from "@/lib/serve-file";

export const dynamic = "force-dynamic";

/**
 * The video itself, streamed from Drive through the panel's own sign-in —
 * members never need Google access. Answers by byte range in pieces of at
 * most 16 MiB (see lib/serve-file), so playing, seeking anywhere and
 * downloading work for a recording of any length. A WebM from the browser's
 * recorder gets its Duration and seek index written into the header on the
 * way out. `?download=1` sends it as a file with its real name (admins).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Recording not found", 404);
  const rec = await loadRecording(id);
  if (!rec || rec.status !== "ready" || !rec.drive_file_id) return fail("Recording not found", 404);
  if (!(await canAccessSeries(u, rec.meeting?.series?.id))) return fail("Recording not found", 404);
  const download = !!new URL(req.url).searchParams.get("download");
  if (download && u.role !== "admin") return fail("Only admins download recordings", 403);
  try {
    const { index } = await readSeekIndex(id);
    const head = await recordingHead({ id, drive_file_id: rec.drive_file_id, mime: rec.mime, duration_sec: rec.duration_sec }, index);
    return await serveDriveFile(req.headers.get("range"), {
      fileId: rec.drive_file_id,
      size: rec.size_bytes,
      mime: rec.mime || "video/webm",
      name: rec.name,
      download,
      cacheControl: "private, no-store",
      head,
    });
  } catch (e) {
    return storageFail(e, "Couldn't read the recording");
  }
}
