"use client";

import { LIMITS } from "@/lib/domain";

/**
 * File bytes from the panel, in pieces. The panel answers at most
 * LIMITS.servePieceBytes per request (the host cuts one response at 32 MiB),
 * so anything bigger is fetched as consecutive byte ranges — the first answer
 * says the real total in Content-Range. A piece that fails is retried, so a
 * network blip in the middle of a 400 MB file doesn't start it over.
 */
const PIECE = LIMITS.servePieceBytes;

type Progress = (loaded: number, total: number) => void;

async function piece(url: string, a: number, signal: AbortSignal | undefined, onBytes: (n: number) => void): Promise<{ parts: Uint8Array[]; total: number; type: string; whole: boolean }> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800 * attempt));
    let got = 0;
    try {
      const r = await fetch(url, { credentials: "same-origin", headers: { Range: `bytes=${a}-${a + PIECE - 1}` }, signal });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const whole = r.status === 200;
      const cr = r.headers.get("content-range");
      const total = whole ? Number(r.headers.get("content-length") || 0) : Number(cr?.split("/")[1] || 0);
      const reader = r.body.getReader();
      const parts: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.byteLength;
        onBytes(value.byteLength);
      }
      return { parts, total, type: r.headers.get("content-type") || "", whole };
    } catch (e) {
      onBytes(-got); // this attempt's bytes don't count; the piece starts over
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Download failed");
}

/** The whole file as a Blob (in memory). For previews and the fallback download. */
export async function fetchPieces(url: string, opts: { signal?: AbortSignal; onProgress?: Progress } = {}): Promise<Blob> {
  const parts: BlobPart[] = [];
  let loaded = 0;
  let total = 0;
  let type = "";
  let a = 0;
  for (;;) {
    const p = await piece(url, a, opts.signal, (n) => {
      loaded += n;
      opts.onProgress?.(loaded, total);
    });
    total = p.total || total;
    type = type || p.type;
    // Collapse each piece to a Blob right away: the browser may keep big Blobs on disk, not in the page's memory.
    parts.push(new Blob(p.parts as BlobPart[]));
    const len = p.parts.reduce((s, x) => s + x.byteLength, 0);
    a += len;
    opts.onProgress?.(loaded, total);
    if (p.whole || !len || (total && a >= total)) break;
  }
  return new Blob(parts, { type });
}

type SavePicker = (o: { suggestedName?: string }) => Promise<{ createWritable: () => Promise<{ write: (d: BlobPart) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }> }>;

/**
 * Save a file of any size. Where the browser can write to disk directly
 * (Chrome / Edge on a computer) the person picks where, and each piece goes
 * straight to the file — nothing big is held in memory. Elsewhere the pieces
 * are put together and handed over as a normal download. Call it straight
 * from the click (the save dialog needs the click). Resolves false when the
 * person cancelled the save dialog.
 */
export async function downloadInPieces(url: string, name: string, opts: { signal?: AbortSignal; onProgress?: Progress } = {}): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker && window.isSecureContext) {
    let handle: Awaited<ReturnType<SavePicker>>;
    try {
      handle = await picker({ suggestedName: name });
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return false; // closed the dialog
      return blobDownload(url, name, opts);
    }
    const out = await handle.createWritable();
    try {
      let loaded = 0;
      let total = 0;
      let a = 0;
      for (;;) {
        const p = await piece(url, a, opts.signal, (n) => {
          loaded += n;
          opts.onProgress?.(loaded, total);
        });
        total = p.total || total;
        for (const part of p.parts) await out.write(part as BlobPart);
        const len = p.parts.reduce((s, x) => s + x.byteLength, 0);
        a += len;
        if (p.whole || !len || (total && a >= total)) break;
      }
      await out.close();
      return true;
    } catch (e) {
      await out.abort().catch(() => undefined);
      throw e;
    }
  }
  return blobDownload(url, name, opts);
}

async function blobDownload(url: string, name: string, opts: { signal?: AbortSignal; onProgress?: Progress }): Promise<boolean> {
  const blob = await fetchPieces(url, opts);
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.rel = "noopener";
  // Clicked detached: never put into the page (React owns <body>'s children).
  a.click();
  // Give the browser time to start writing the file before the bytes are released.
  window.setTimeout(() => URL.revokeObjectURL(href), 120_000);
  return true;
}
