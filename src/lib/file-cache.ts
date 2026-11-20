"use client";

import { LIMITS } from "@/lib/domain";
import { fetchPieces } from "@/lib/fetch-pieces";

/**
 * Files the viewer has opened (or preloaded), kept for the page's life: going
 * back to a picture is instant — no new download, no new decode, the same
 * object URL — and the neighbours of the file on screen are fetched ahead.
 *
 *   - A file that fits one answer (≤ 16 MiB — every picture) is a PLAIN GET of
 *     its own address, the very request a card's thumbnail made: the browser's
 *     HTTP cache usually answers it at once, and keeps it across visits.
 *   - Bigger files come in pieces (lib/fetch-pieces).
 *   - Two asks for the same file share one download; progress reaches both.
 *   - Kept up to ~200 MB in total, least recently used first out.
 */
type Progress = (loaded: number, total: number) => void;
interface Entry {
  blob?: Blob;
  url?: string;
  size: number;
  used: number;
  loading?: Promise<Blob>;
  listeners: Set<Progress>;
  loaded: number;
  total: number;
  ctrl?: AbortController;
}

const LIMIT_BYTES = 200 * 1024 * 1024;
const cache = new Map<string, Entry>();

function evict() {
  let total = 0;
  for (const e of cache.values()) if (e.blob) total += e.blob.size;
  if (total <= LIMIT_BYTES) return;
  const done = [...cache.entries()].filter(([, e]) => e.blob).sort((a, b) => a[1].used - b[1].used);
  for (const [k, e] of done) {
    if (total <= LIMIT_BYTES * 0.8) break;
    total -= e.blob!.size;
    if (e.url) URL.revokeObjectURL(e.url);
    cache.delete(k);
  }
}

async function download(src: string, size: number, e: Entry): Promise<Blob> {
  const report = (loaded: number, total: number) => {
    e.loaded = loaded;
    e.total = total;
    for (const l of e.listeners) l(loaded, total);
  };
  if (size > 0 && size <= LIMITS.servePieceBytes) {
    // One answer: the cacheable plain GET (same request as the thumbnail).
    const r = await fetch(src, { credentials: "same-origin", signal: e.ctrl?.signal });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const total = Number(r.headers.get("content-length") || size);
    const reader = r.body.getReader();
    const parts: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.byteLength;
      report(loaded, total);
    }
    return new Blob(parts as BlobPart[], { type: r.headers.get("content-type") || "" });
  }
  return fetchPieces(src, { signal: e.ctrl?.signal, onProgress: report });
}

/** The file now if it is kept, else null. */
export function cachedFile(src: string): { blob: Blob; url: string } | null {
  const e = cache.get(src);
  if (!e?.blob) return null;
  e.used = Date.now();
  if (!e.url) e.url = URL.createObjectURL(e.blob);
  return { blob: e.blob, url: e.url };
}

/** Load (or join the load of) a file; `size` is what the panel recorded for it (0 if unknown). */
export function loadFile(src: string, size: number, onProgress?: Progress): Promise<{ blob: Blob; url: string }> {
  let e = cache.get(src);
  if (e?.blob) {
    e.used = Date.now();
    if (!e.url) e.url = URL.createObjectURL(e.blob);
    return Promise.resolve({ blob: e.blob, url: e.url });
  }
  if (!e) {
    e = { size, used: Date.now(), listeners: new Set(), loaded: 0, total: size, ctrl: new AbortController() };
    cache.set(src, e);
  }
  const entry = e;
  if (onProgress) {
    entry.listeners.add(onProgress);
    if (entry.loaded) onProgress(entry.loaded, entry.total);
  }
  if (!entry.loading) {
    entry.loading = download(src, size, entry)
      .then((blob) => {
        entry.blob = blob;
        entry.loading = undefined;
        entry.used = Date.now();
        evict();
        return blob;
      })
      .catch((err) => {
        cache.delete(src); // a failed load is tried afresh next time
        throw err;
      });
  }
  return entry.loading.then((blob) => {
    if (onProgress) entry.listeners.delete(onProgress);
    if (!entry.url) entry.url = URL.createObjectURL(blob);
    return { blob, url: entry.url };
  });
}

/** Stop listening; a big download nobody waits for any more is cancelled (small ones finish into the cache). */
export function releaseFile(src: string, onProgress?: Progress) {
  const e = cache.get(src);
  if (!e || e.blob) return;
  if (onProgress) e.listeners.delete(onProgress);
  if (!e.listeners.size && e.size > LIMITS.servePieceBytes) {
    e.ctrl?.abort();
    cache.delete(src);
  }
}

/** Fetch ahead (the next / previous file in the viewer). Quiet on failure. */
export function preloadFile(src: string, size: number) {
  if (cache.has(src) || size > 40 * 1024 * 1024) return;
  void loadFile(src, size).catch(() => undefined);
}
