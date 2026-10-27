/**
 * Attachment hygiene (server side). The browser's declared MIME type is a
 * hint, never the truth: the real type is sniffed from the first bytes, the
 * stored name is cleaned, and the object key is generated (never the user's
 * file name) so a path can never be traversed.
 */
import { LIMITS } from "./domain";

export const MAX_ATTACHMENT_BYTES = LIMITS.attachmentBytes;

/** Extension → MIME for the types we accept (used when sniffing can't tell). */
const BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  apk: "application/vnd.android.package-archive",
  aab: "application/octet-stream",
  ipa: "application/octet-stream",
};

/** Sniff the real type from magic bytes. Returns null when unrecognised. */
function sniffMime(bytes: Uint8Array): string | null {
  const b = bytes;
  const str = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length >= 8 && b[0] === 0x89 && str(1, 3) === "PNG") return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && str(0, 4) === "RIFF" && str(8, 4) === "WEBP") return "image/webp";
  if (b.length >= 6 && (str(0, 6) === "GIF87a" || str(0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 5 && str(0, 5) === "%PDF-") return "application/pdf";
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return "application/zip"; // zip family (docx/xlsx/pptx/apk/aab/ipa too)
  if (b.length >= 12 && str(4, 4) === "ftyp") {
    // ISO-BMFF: the brand tells photos (HEIC/AVIF) from movies (mp4/mov).
    const brand = str(8, 4).toLowerCase();
    if (/^(heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return "image/heic";
    if (/^(avif|avis)$/.test(brand)) return "image/avif";
    return "video/mp4"; // mp4 / mov family
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return null;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const isImageMime = (m: string) => IMAGE_TYPES.has(m);

/**
 * Decide the stored MIME: sniffed type wins; zip-family containers keep the
 * extension-derived office/apk type (a .docx IS a zip); plain-text types are
 * accepted by extension when nothing binary was sniffed. Returns null when the
 * file is not an allowed type.
 */
export function resolveMime(bytes: Uint8Array, fileName: string, declared: string | null): string | null {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  const byExt = BY_EXT[ext] || null;
  const sniffed = sniffMime(bytes);
  if (sniffed === "application/zip") return byExt && (byExt.startsWith("application/vnd.") || byExt === "application/msword" || byExt === "application/octet-stream") ? byExt : "application/zip";
  if (sniffed === "video/mp4") return byExt === "video/quicktime" ? byExt : "video/mp4";
  // Phone photo formats the browsers here can't show: ask for JPEG/PNG instead.
  if (sniffed === "image/heic" || sniffed === "image/avif") return null;
  if (sniffed) return sniffed;
  // Nothing binary recognised: text-ish types by extension only (never trust `declared` alone).
  if (byExt && (byExt.startsWith("text/") || byExt === "application/json" || byExt === "image/svg+xml")) {
    // Reject anything that looks binary for a text extension.
    for (let i = 0; i < Math.min(bytes.length, 512); i++) if (bytes[i] === 0) return null;
    return byExt;
  }
  // Everything else we accept is binary and sniffable; an unrecognised body
  // under a known extension (a .png that isn't a PNG) is rejected, whatever
  // the browser declared. `declared` is deliberately not trusted here.
  void declared;
  return null;
}

/** Pixel size for PNG / JPEG / WebP / GIF, from the headers alone. */
export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mime === "image/png" && bytes.length >= 24) return { width: dv.getUint32(16), height: dv.getUint32(20) };
    if (mime === "image/gif" && bytes.length >= 10) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    if (mime === "image/webp" && bytes.length >= 30) {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
      if (chunk === "VP8L") {
        const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
        return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (chunk === "VP8X") return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
    }
    if (mime === "image/jpeg") {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1];
        const len = dv.getUint16(i + 2);
        // SOF0..SOF15 (except DHT/JPG/DAC) carry the dimensions.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* malformed header — no dimensions, still a valid upload */
  }
  return null;
}

/** Safe display name: strip paths/controls, cap length, keep the extension. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return cleaned || "file";
}

/** Extension for the object key, derived from the RESOLVED mime (never the name). */
export function extFor(mime: string, fileName: string): string {
  for (const [ext, m] of Object.entries(BY_EXT)) if (m === mime) {
    // Prefer the user's own extension when it maps to the same type (jpg vs jpeg, docx vs zip).
    const own = (fileName.split(".").pop() || "").toLowerCase();
    return BY_EXT[own] === mime ? own : ext;
  }
  return "bin";
}

export { fmtBytes as formatBytes } from "./format";
