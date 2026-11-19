/**
 * Seek index for browser-recorded WebM.
 *
 * MediaRecorder writes WebM as a live stream: no Cues (seek index). A player
 * asked to jump to 1:00:00 then has to read the file from where it is up to
 * that point to find the right cluster — over the network that is the
 * "loads forever" seek. This module walks a recording ONCE (streamed, never
 * held in memory), notes where every cluster that starts on a video keyframe
 * begins and at what time, and builds a Cues element from that. The stream
 * route then serves the file with the Cues placed just before the first
 * cluster, so any player seeks with one range request.
 *
 * Self-contained (no app imports) so it can run in a script too.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CLUSTER = 0x1f43b675;
const ID_CUES = 0x1c53bb6b;
const ID_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
/** Elements that live directly in the Segment: seeing one ends an unknown-size cluster. */
const LEVEL1 = new Set([ID_CLUSTER, ID_CUES, ID_INFO, ID_TRACKS, 0x114d9b74 /* SeekHead */, 0x1254c367 /* Tags */, 0x1043a770 /* Chapters */, 0x1941a469 /* Attachments */, 0xec /* Void */]);

export interface WebmSeekIndex {
  v: 1;
  /** Track the cue points refer to (the video track, or the audio one for sound-only files). */
  track: number;
  /** Absolute offset of the first Cluster in the ORIGINAL file (the Cues go right before it). */
  firstCluster: number;
  /** Absolute offset where the Segment's data starts (cluster positions are relative to it). */
  segmentData: number;
  /** Flat pairs: [time in TimecodeScale units (normally ms), cluster offset relative to segmentData, …]. */
  points: number[];
}

/** Pulls bytes from a stream with a small rolling buffer; positions are absolute file offsets. */
class Reader {
  private buf = new Uint8Array(0);
  private at = 0; // index into buf
  pos = 0; // absolute offset of buf[at]
  private done = false;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }
  private async pull(): Promise<boolean> {
    if (this.done) return false;
    const { done, value } = await this.reader.read();
    if (done || !value) {
      this.done = true;
      return false;
    }
    const rest = this.buf.subarray(this.at);
    const next = new Uint8Array(rest.length + value.length);
    next.set(rest, 0);
    next.set(value, rest.length);
    this.buf = next;
    this.at = 0;
    return true;
  }
  /** Make at least n bytes available; false at end of file. */
  async need(n: number): Promise<boolean> {
    while (this.buf.length - this.at < n) if (!(await this.pull())) return false;
    return true;
  }
  peek(i: number): number {
    return this.buf[this.at + i];
  }
  /** Skip n bytes, reading (and dropping) whatever is not buffered yet. */
  async skip(n: number): Promise<boolean> {
    let left = n;
    for (;;) {
      const have = this.buf.length - this.at;
      if (have >= left) {
        this.at += left;
        this.pos += left;
        return true;
      }
      left -= have;
      this.pos += have;
      this.buf = new Uint8Array(0);
      this.at = 0;
      if (!(await this.pull())) return false;
    }
  }
  /** Read an EBML variable-size integer at the cursor without consuming it. Returns null at EOF/garbage. */
  async vint(offset: number, keepMarker: boolean): Promise<{ value: number; length: number; unknown: boolean } | null> {
    if (!(await this.need(offset + 1))) return null;
    const first = this.peek(offset);
    let length = 1;
    let mask = 0x80;
    while (length <= 8 && !(first & mask)) {
      length++;
      mask >>= 1;
    }
    if (length > 8 || !(await this.need(offset + length))) return null;
    let value = keepMarker ? first : first & (mask - 1);
    let allOnes = (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < length; i++) {
      const byte = this.peek(offset + i);
      value = value * 256 + byte;
      if (byte !== 0xff) allOnes = false;
    }
    return { value, length, unknown: !keepMarker && allOnes };
  }
  /** Element header at the cursor: id, data size and header length (not consumed). */
  async header(): Promise<{ id: number; size: number; unknown: boolean; len: number } | null> {
    const id = await this.vint(0, true);
    if (!id) return null;
    const size = await this.vint(id.length, false);
    if (!size) return null;
    return { id: id.value, size: size.value, unknown: size.unknown, len: id.length + size.length };
  }
  async uint(n: number): Promise<number | null> {
    if (!(await this.need(n))) return null;
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + this.peek(i);
    return v;
  }
}

/**
 * Walk a WebM (streamed) and return its seek index, or null when the file is
 * not a WebM we understand or already carries Cues (nothing to add then).
 */
export async function scanWebm(stream: ReadableStream<Uint8Array>): Promise<WebmSeekIndex | null> {
  const r = new Reader(stream.getReader());
  {
    const ebml = await r.header();
    if (!ebml || ebml.id !== ID_EBML || ebml.unknown) return null;
    await r.skip(ebml.len + ebml.size);
    const seg = await r.header();
    if (!seg || seg.id !== ID_SEGMENT) return null;
    await r.skip(seg.len);
    const segmentData = r.pos;
    const tracks: { num: number; type: number }[] = [];
    let firstCluster = -1;
    let videoTrack = 0;
    const points: number[] = [];
    let pending: { header: Awaited<ReturnType<Reader["header"]>> } | null = null;
    for (;;) {
      const h = pending?.header ?? (await r.header());
      pending = null;
      if (!h) break;
      if (h.id === ID_CUES) return null; // already seekable
      if (h.id === ID_TRACKS && !h.unknown) {
        // Small: read it whole to learn which track is video.
        await r.skip(h.len);
        const end = r.pos + h.size;
        while (r.pos < end) {
          const e = await r.header();
          if (!e) return null;
          if (e.id === ID_TRACK_ENTRY) {
            await r.skip(e.len);
            const entryEnd = r.pos + e.size;
            let num = 0;
            let type = 0;
            while (r.pos < entryEnd) {
              const c = await r.header();
              if (!c) return null;
              if (c.id === ID_TRACK_NUMBER || c.id === ID_TRACK_TYPE) {
                await r.skip(c.len);
                const v = await r.uint(c.size);
                if (v === null) return null;
                if (c.id === ID_TRACK_NUMBER) num = v;
                else type = v;
                await r.skip(c.size);
              } else await r.skip(c.len + c.size);
            }
            tracks.push({ num, type });
          } else await r.skip(e.len + e.size);
        }
        videoTrack = tracks.find((t) => t.type === 1)?.num ?? tracks.find((t) => t.type === 2)?.num ?? 1;
        continue;
      }
      if (h.id !== ID_CLUSTER) {
        if (h.unknown) return null;
        await r.skip(h.len + h.size);
        continue;
      }
      // A cluster: where it starts, its time, and whether its first block of the cue track is a keyframe.
      const clusterAt = r.pos;
      if (firstCluster < 0) firstCluster = clusterAt;
      await r.skip(h.len);
      const end = h.unknown ? Infinity : r.pos + h.size;
      let clusterTime = -1;
      let decided = false;
      while (r.pos < end) {
        const c = await r.header();
        if (!c) break;
        if (h.unknown && LEVEL1.has(c.id)) {
          pending = { header: c };
          break;
        }
        if (c.id === ID_TIMECODE) {
          await r.skip(c.len);
          clusterTime = (await r.uint(c.size)) ?? -1;
          await r.skip(c.size);
          continue;
        }
        if (!decided && clusterTime >= 0 && (c.id === ID_SIMPLE_BLOCK || c.id === ID_BLOCK_GROUP)) {
          // SimpleBlock: track (vint), relative time (int16), flags (0x80 = keyframe).
          let blockAt = c.len;
          if (c.id === ID_BLOCK_GROUP) {
            const inner = await r.vint(c.len, true);
            const innerSize = inner ? await r.vint(c.len + inner.length, false) : null;
            if (!inner || !innerSize || inner.value !== ID_BLOCK) {
              await r.skip(c.len + c.size);
              continue;
            }
            blockAt = c.len + inner.length + innerSize.length;
          }
          const track = await r.vint(blockAt, false);
          if (track && (await r.need(blockAt + track.length + 3)) && track.value === videoTrack) {
            const rel = ((r.peek(blockAt + track.length) << 8) | r.peek(blockAt + track.length + 1)) << 16 >> 16;
            const flags = r.peek(blockAt + track.length + 2);
            // A BlockGroup has no keyframe flag; it is a keyframe when it carries no ReferenceBlock — treat as one.
            const key = c.id === ID_BLOCK_GROUP || (flags & 0x80) !== 0;
            if (key) points.push(clusterTime + rel, clusterAt - segmentData);
            decided = true;
          }
        }
        await r.skip(c.len + c.size);
      }
    }
    if (firstCluster < 0 || points.length < 2) return null;
    return { v: 1, track: videoTrack, firstCluster, segmentData, points };
  }
}

function uintBytes(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

/** Size field in exactly 8 bytes (so the Cues' own size never depends on the numbers inside). */
function size8(value: number): Uint8Array {
  const out = uintBytes(value, 8);
  out[0] = 0x01;
  return out;
}

/**
 * The Cues element for an index, with every cluster position moved by `shift`
 * bytes (what was inserted before the clusters). Fixed-width numbers: the
 * element's length depends only on how many points there are.
 */
export function buildCues(index: WebmSeekIndex, shift: number): Uint8Array {
  const n = index.points.length / 2;
  const point = 27; // CuePoint: BB 99 | CueTime B3 88 +8 | CueTrackPositions B7 8D { F7 81 +1, F1 88 +8 }
  const body = n * point;
  const out = new Uint8Array(4 + 8 + body);
  out.set([0x1c, 0x53, 0xbb, 0x6b], 0);
  out.set(size8(body), 4);
  let p = 12;
  for (let i = 0; i < n; i++) {
    const time = index.points[i * 2];
    const pos = index.points[i * 2 + 1] + shift;
    out.set([0xbb, 0x99, 0xb3, 0x88], p);
    out.set(uintBytes(Math.max(0, time), 8), p + 4);
    out.set([0xb7, 0x8d, 0xf7, 0x81, index.track & 0x7f, 0xf1, 0x88], p + 12);
    out.set(uintBytes(pos, 8), p + 19);
    p += point;
  }
  return out;
}

/** How long the Cues for this index will be, without building them. */
export const cuesLength = (index: WebmSeekIndex) => 12 + (index.points.length / 2) * 27;
