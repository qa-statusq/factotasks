import { NextRequest, NextResponse } from "next/server";
import { requireAccessUser } from "@/lib/guard";
import { fail } from "@/lib/api";
import { isUuid } from "@/lib/validate";
import { streamFile, DriveError } from "@/lib/google-drive";
import { loadRecording } from "@/lib/recordings";
import { canAccessSeries } from "@/lib/series-access";
import { patchWebmHead, type WebmHeadPatch } from "@/lib/webm-duration";

export const dynamic = "force-dynamic";

/** Printable ASCII only, no quotes or backslashes — what the plain filename= parameter may carry. */
function asciiName(name: string): string {
  let out = "";
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    out += c >= 0x20 && c <= 0x7e && ch !== '"' && ch !== "\\" ? ch : "_";
  }
  return out;
}

/** Header patches, one per file: a few hundred bytes each, computed once. */
const patches = new Map<string, WebmHeadPatch | null>();
async function headPatch(fileId: string, mime: string, durationSec: number | null): Promise<WebmHeadPatch | null> {
  if (!durationSec || !/webm|matroska/.test(mime)) return null;
  const cached = patches.get(fileId);
  if (cached !== undefined) return cached;
  let patch: WebmHeadPatch | null = null;
  try {
    const head = await streamFile(fileId, "bytes=0-65535");
    patch = patchWebmHead(new Uint8Array(await head.arrayBuffer()), durationSec);
  } catch {
    patch = null;
  }
  if (patches.size > 500) patches.clear();
  patches.set(fileId, patch);
  return patch;
}

/**
 * The video itself, streamed from Drive through the panel's own sign-in —
 * members never need Google access. Range requests pass through, so <video>
 * can seek; `?download=1` sends it as a file with its real name. A WebM from
 * the browser's recorder has no duration in its header, so the known length
 * is written in on the way out and every later byte is shifted accordingly.
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
  const fileId = rec.drive_file_id;
  try {
    const patch = await headPatch(fileId, rec.mime, rec.duration_sec);
    const headers = new Headers();
    headers.set("content-type", rec.mime || "video/webm");
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", "private, no-store");
    if (download) headers.set("content-disposition", `attachment; filename="${asciiName(rec.name)}"; filename*=UTF-8''${encodeURIComponent(rec.name)}`);

    if (!patch) {
      const up = await streamFile(fileId, download ? null : req.headers.get("range"));
      for (const h of ["content-length", "content-range", "etag"]) {
        const v = up.headers.get(h);
        if (v) headers.set(h, v);
      }
      return new Response(up.body, { status: up.status, headers });
    }

    // Patched coordinates: the new head replaces the first `replaces` bytes; everything after shifts by `delta`.
    const delta = patch.head.length - patch.replaces;
    const total = rec.size_bytes + delta;
    const range = download ? null : req.headers.get("range");
    let a = 0;
    let b = total - 1;
    const m = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        a = Number(m[1]);
        if (m[2]) b = Math.min(total - 1, Number(m[2]));
      } else {
        a = Math.max(0, total - Number(m[2]));
      }
      if (a > b || a >= total) {
        headers.set("content-range", `bytes */${total}`);
        return new Response(null, { status: 416, headers });
      }
    }
    const headPart = a < patch.head.length ? patch.head.subarray(a, Math.min(b + 1, patch.head.length)) : null;
    const restFrom = Math.max(a, patch.head.length) - delta; // original offset
    const restTo = b - delta;
    const needRest = b + 1 > patch.head.length;
    const up = needRest ? await streamFile(fileId, `bytes=${restFrom}-${restTo}`) : null;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (headPart?.length) controller.enqueue(headPart);
        if (up?.body) {
          const reader = up.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        }
        controller.close();
      },
      cancel() {
        void up?.body?.cancel().catch(() => undefined);
      },
    });
    headers.set("content-length", String(b - a + 1));
    if (m) headers.set("content-range", `bytes ${a}-${b}/${total}`);
    return new Response(body, { status: m ? 206 : 200, headers });
  } catch (e) {
    return fail(e instanceof DriveError ? e.message : "Couldn't read the recording", 502);
  }
}
