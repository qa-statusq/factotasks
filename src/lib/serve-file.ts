import { streamFile } from "./google-drive";
import { LIMITS } from "./domain";

/**
 * Serve a Shared Drive file through the panel — the ONE place that answers
 * file bytes (recordings, task files, meeting files).
 *
 * Every answer is at most LIMITS.servePieceBytes (16 MiB). The hosting
 * platform cuts a single response at 32 MiB, which is what broke long
 * recordings: a download stopped at ~34 MB and a seek far into a video asked
 * for "everything from here on" and never got it. Players and our own
 * downloader always ask by byte range, and a 206 with the real total in
 * Content-Range tells them to come back for the rest — so a file of any size
 * plays, seeks and downloads in pieces that each fit.
 *
 * `head` optionally replaces the file's first `replaces` bytes (a WebM
 * recording gets a Duration and a seek index written in); every later byte is
 * shifted by the difference, and ranges are mapped accordingly.
 */
export interface ServeOptions {
  fileId: string;
  /** Size of the stored file in bytes. */
  size: number;
  mime: string;
  name: string;
  download?: boolean;
  cacheControl: string;
  head?: { bytes: Uint8Array; replaces: number } | null;
  /** Extra response headers (e.g. nosniff). */
  extra?: Record<string, string>;
}

/** Printable ASCII only — what the plain filename= parameter may carry. */
export function asciiName(name: string): string {
  let out = "";
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    out += c >= 0x20 && c <= 0x7e && ch !== '"' && ch !== "\\" ? ch : "_";
  }
  return out;
}

export async function serveDriveFile(rangeHeader: string | null, o: ServeOptions): Promise<Response> {
  const PIECE = LIMITS.servePieceBytes;
  const head = o.head ?? null;
  const delta = head ? head.bytes.length - head.replaces : 0;
  const total = o.size + delta;
  const headers = new Headers();
  headers.set("content-type", o.mime || "application/octet-stream");
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", o.cacheControl);
  headers.set("content-disposition", `${o.download ? "attachment" : "inline"}; filename="${asciiName(o.name)}"; filename*=UTF-8''${encodeURIComponent(o.name)}`);
  for (const [k, v] of Object.entries(o.extra ?? {})) headers.set(k, v);

  // Which bytes: the asked range (open-ended or too long → cut to one piece), or the whole file when it fits in one.
  let a = 0;
  let b = total - 1;
  let partial = false;
  const m = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    partial = true;
    if (m[1]) {
      a = Number(m[1]);
      if (m[2]) b = Math.min(total - 1, Number(m[2]));
    } else a = Math.max(0, total - Number(m[2])); // the last N bytes
    if (a > b || a >= total) {
      headers.set("content-range", `bytes */${total}`);
      return new Response(null, { status: 416, headers });
    }
  }
  if (b - a + 1 > PIECE) {
    b = a + PIECE - 1;
    partial = true;
  }
  if (total === 0) return new Response(null, { status: 200, headers });

  // Bytes from the replaced head (if any), then the rest straight from Drive.
  const headLen = head ? head.bytes.length : 0;
  const headPart = head && a < headLen ? head.bytes.subarray(a, Math.min(b + 1, headLen)) : null;
  const needRest = b + 1 > headLen;
  const restFrom = Math.max(a, headLen) - delta; // offsets in the stored file
  const restTo = b - delta;
  const up = needRest ? await streamFile(o.fileId, `bytes=${restFrom}-${restTo}`) : null;
  const body =
    !headPart && up
      ? up.body
      : new ReadableStream<Uint8Array>({
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
  if (partial) headers.set("content-range", `bytes ${a}-${b}/${total}`);
  return new Response(body, { status: partial ? 206 : 200, headers });
}
