/**
 * MediaRecorder writes WebM as a live stream: the Segment has an unknown size
 * and its Info block carries no Duration, so players show a timeline that
 * grows as the file loads. The panel knows how long the recording ran, so the
 * stream route writes a Duration into the header on the way out — the same
 * fix "fix-webm-duration" applies in the browser, done once per request on
 * the first few kilobytes, with every later byte passed through untouched.
 *
 * `patchWebmHead` returns the rewritten prefix and how many original bytes it
 * replaces; callers map Range offsets by the difference.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

export interface WebmHeadPatch {
  /** The new prefix (original bytes up to Info, then the Info with a Duration). */
  head: Uint8Array;
  /** How many bytes of the original file the prefix replaces. */
  replaces: number;
}

interface Vint {
  value: number;
  length: number;
  unknown: boolean;
}

/** Read an EBML variable-size integer (size field); `keepMarker` for element ids. */
function readVint(b: Uint8Array, at: number, keepMarker: boolean): Vint | null {
  if (at >= b.length) return null;
  const first = b[at];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    length++;
    mask >>= 1;
  }
  if (length > 8 || at + length > b.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[at + i];
    if (b[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function encodeSize(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function sizeLengthFor(value: number): number {
  let length = 1;
  while (value >= Math.pow(2, 7 * length) - 1 && length < 8) length++;
  return length;
}

/**
 * Build the patched prefix for a WebM whose first bytes are `b` (a few KB is
 * plenty). Returns null when the file already has a Duration, is not a WebM
 * live stream, or the Info block lies beyond `b`.
 */
export function patchWebmHead(b: Uint8Array, durationSec: number): WebmHeadPatch | null {
  if (!(durationSec > 0)) return null;
  let p = 0;
  const ebml = readVint(b, p, true);
  if (!ebml || ebml.value !== ID_EBML) return null;
  const ebmlSize = readVint(b, p + ebml.length, false);
  if (!ebmlSize || ebmlSize.unknown) return null;
  p += ebml.length + ebmlSize.length + ebmlSize.value;
  const seg = readVint(b, p, true);
  if (!seg || seg.value !== ID_SEGMENT) return null;
  const segSize = readVint(b, p + seg.length, false);
  if (!segSize) return null;
  p += seg.length + segSize.length;
  // Walk the Segment's children until Info.
  while (p < b.length) {
    const id = readVint(b, p, true);
    if (!id) return null;
    const size = readVint(b, p + id.length, false);
    if (!size || size.unknown) return null;
    const dataAt = p + id.length + size.length;
    if (id.value === ID_INFO) {
      if (dataAt + size.value > b.length) return null;
      // Already has a Duration? Then there is nothing to do.
      let q = dataAt;
      let scale = 1_000_000;
      while (q < dataAt + size.value) {
        const cid = readVint(b, q, true);
        const csize = cid ? readVint(b, q + cid.length, false) : null;
        if (!cid || !csize || csize.unknown) return null;
        if (cid.value === ID_DURATION) return null;
        if (cid.value === ID_TIMECODE_SCALE) {
          let v = 0;
          for (let i = 0; i < csize.value; i++) v = v * 256 + b[q + cid.length + csize.length + i];
          if (v > 0) scale = v;
        }
        q += cid.length + csize.length + csize.value;
      }
      // Duration is a float64 in TimecodeScale units (ns → usually ms).
      const dur = new Uint8Array(2 + 1 + 8);
      dur[0] = 0x44;
      dur[1] = 0x89;
      dur[2] = 0x88;
      new DataView(dur.buffer).setFloat64(3, (durationSec * 1e9) / scale, false);
      const newDataLen = size.value + dur.length;
      const newSizeLen = Math.max(size.length, sizeLengthFor(newDataLen));
      const head = new Uint8Array(p + id.length + newSizeLen + newDataLen);
      head.set(b.subarray(0, p + id.length), 0);
      head.set(encodeSize(newDataLen, newSizeLen), p + id.length);
      head.set(b.subarray(dataAt, dataAt + size.value), p + id.length + newSizeLen);
      head.set(dur, p + id.length + newSizeLen + size.value);
      return { head, replaces: dataAt + size.value };
    }
    if (id.value === 0x1f43b675 /* Cluster: Info never comes after the first cluster */) return null;
    p = dataAt + size.value;
  }
  return null;
}
