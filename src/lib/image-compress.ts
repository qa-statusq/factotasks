"use client";

/**
 * Browser-side downscale for photo/screenshot uploads. A phone screenshot is
 * 2–5 MB of PNG; nobody needs that to review a bug. Re-encoding at ≤1920px
 * as WebP (JPEG where WebP encoding is unsupported) typically lands at
 * 150–400 KB — which is what keeps the free storage/egress tiers free.
 *
 * Only PNG/JPEG/WebP above the threshold are touched; GIFs (animation),
 * SVGs and small images pass through untouched. Any failure (old engine,
 * decode error) returns the original file: a downscale is an optimisation,
 * never a gate.
 */
const MAX_EDGE = 1920;
const THRESHOLD_BYTES = 350 * 1024;
const QUALITY = 0.85;

export async function compressImage(file: File): Promise<File> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size <= THRESHOLD_BYTES) return file;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", QUALITY));
    // Engines without WebP encoding hand back a PNG blob (or null): fall back to JPEG.
    let out = blob && blob.type === "image/webp" ? blob : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
    if (!out || out.size >= file.size) out = null;
    if (!out) return file;
    const ext = out.type === "image/webp" ? "webp" : "jpg";
    const name = file.name.replace(/\.[^.]+$/, "") + `.${ext}`;
    return new File([out], name, { type: out.type, lastModified: Date.now() });
  } catch {
    return file;
  }
}
