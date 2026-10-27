import type { Recording } from "@/lib/types";

/**
 * The upload half of the recorder: one chunk at a time to the panel, which
 * relays it to the storage's resumable upload. Each chunk reports its own
 * progress, is retried on its own, and resumes from wherever the storage
 * actually stands after a dropped connection.
 */
export const CHUNK = 2 * 1024 * 1024;
/** Send what has piled up at least this often, so a closed tab loses a few seconds at most. */
export const FLUSH_MS = 5000;
/** Every chunk but the last must be a multiple of this (the storage's rule). */
export const GRAIN = 256 * 1024;

interface PutResult {
  ok: boolean;
  done?: boolean;
  received?: number;
  recording?: Recording;
  error?: string;
  status: number;
}

/** PUT one chunk with upload progress (XHR is the only browser API that reports it). */
function putChunk(url: string, body: Blob, headers: Record<string, string>, onProgress: (loaded: number) => void): Promise<PutResult> {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.withCredentials = true;
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => {
      let j: Partial<PutResult> = {};
      try {
        j = JSON.parse(x.responseText || "{}");
      } catch {
        /* not json */
      }
      resolve({ ...j, ok: x.status >= 200 && x.status < 300, status: x.status });
    };
    x.onerror = () => resolve({ ok: false, status: 0 });
    x.ontimeout = () => resolve({ ok: false, status: 408 });
    x.timeout = 10 * 60_000;
    x.send(body);
  });
}

export type ChunkOutcome = { ok: true; done: boolean; recording?: Recording } | { ok: false; error: string };

/**
 * Send `body` starting at byte `at` of the recording. `total` is null while
 * recording (more will follow) and the final size for the last chunk.
 * `onProgress(sent)` reports the absolute byte position reached so far.
 * Retries up to six times, re-reading where the storage stands in between.
 */
export async function sendChunk(recordingId: string, body: Blob, at: number, total: number | null, durationSec: number | null, onProgress: (sent: number, at: number, size: number) => void): Promise<ChunkOutcome> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const from = at;
    const part = body;
    const r = await putChunk(
      `/api/recordings/${recordingId}/chunk`,
      part,
      { "content-type": "application/octet-stream", "x-chunk-offset": String(from), "x-chunk-total": total == null ? "*" : String(total), ...(durationSec != null ? { "x-duration-sec": String(Math.round(durationSec)) } : {}) },
      (loaded) => onProgress(from + Math.min(loaded, part.size), from, part.size)
    );
    if (r.ok) {
      // The storage kept less than was sent: send the rest from where it stands.
      if (typeof r.received === "number" && !r.done && r.received !== at + body.size) {
        const keep = body.slice(Math.max(0, r.received - at));
        if (!keep.size) return { ok: true, done: false };
        at = r.received;
        body = keep;
        continue;
      }
      return { ok: true, done: !!r.done, recording: r.recording };
    }
    if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return { ok: false, error: r.error || "The upload was refused" };
    await new Promise((res) => setTimeout(res, 1500 * attempt));
    const st = await fetch(`/api/recordings/${recordingId}/chunk`, { credentials: "same-origin" })
      .then((x) => (x.ok ? (x.json() as Promise<{ done?: boolean; received?: number; recording?: Recording | null }>) : null))
      .catch(() => null);
    if (st?.done) return { ok: true, done: true, recording: st.recording ?? undefined };
    if (typeof st?.received === "number" && st.received > at) {
      body = body.slice(st.received - at);
      at = st.received;
      if (!body.size && total == null) return { ok: true, done: false };
    }
  }
  return { ok: false, error: "The connection kept failing" };
}
