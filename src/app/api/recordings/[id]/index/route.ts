import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { fail, storageFail } from "@/lib/api";
import { isUuid } from "@/lib/validate";
import { loadRecording } from "@/lib/recordings";
import { canAccessSeries } from "@/lib/series-access";
import { buildSeekIndex, readSeekIndex } from "@/lib/recording-index";

export const dynamic = "force-dynamic";
// Walking a long recording once (hundreds of MB, read straight from storage) takes seconds, not minutes.
export const maxDuration = 300;

/** One build per recording at a time on this instance (two viewers opening it together share it). */
const building = new Map<string, Promise<unknown>>();

/**
 * Make sure a recording can be sought instantly: builds its seek index the
 * first time anyone opens it (or right after it is recorded), then never
 * again. Replies { ready, built }: `built` = it was made just now, so an open
 * player reloads the video to pick it up. The video plays meanwhile.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const u = await requireAccessUser();
  if (u instanceof NextResponse) return u;
  const { id } = await params;
  if (!isUuid(id)) return fail("Recording not found", 404);
  const rec = await loadRecording(id);
  if (!rec || rec.status !== "ready" || !rec.drive_file_id) return fail("Recording not found", 404);
  if (!(await canAccessSeries(u, rec.meeting?.series?.id))) return fail("Recording not found", 404);
  const { index, available } = await readSeekIndex(id);
  if (!available) return NextResponse.json({ ready: false, built: false });
  if (index) return NextResponse.json({ ready: true, built: false });
  try {
    let job = building.get(id);
    if (!job) {
      job = buildSeekIndex({ id, drive_file_id: rec.drive_file_id, mime: rec.mime }).finally(() => building.delete(id));
      building.set(id, job);
    }
    await job;
    return NextResponse.json({ ready: true, built: true });
  } catch (e) {
    return storageFail(e, "Couldn't prepare the recording");
  }
}
