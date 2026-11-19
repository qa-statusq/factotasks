import { getSupabase } from "./supabase";
import { streamFile } from "./google-drive";
import { patchWebmHead } from "./webm-duration";
import { buildCues, cuesLength, scanWebm, type WebmSeekIndex } from "./webm-cues";

/**
 * A recording's seek index lives in meeting_recordings.seek_index (034):
 *   - a WebmSeekIndex once built,
 *   - { v: 1, none: true } when the file needs none (not WebM, already has Cues, too short).
 * Read separately from RECORDING_SELECT so the panel keeps working even before 034 runs.
 */
type Stored = WebmSeekIndex | { v: 1; none: true };

export async function readSeekIndex(recordingId: string): Promise<{ index: Stored | null; available: boolean }> {
  const { data, error } = await getSupabase().from("meeting_recordings").select("seek_index").eq("id", recordingId).maybeSingle();
  if (error) return { index: null, available: false }; // column not there yet (migration 034 not run)
  return { index: ((data as { seek_index?: Stored | null } | null)?.seek_index ?? null) as Stored | null, available: true };
}

/** Walk the stored file once and save its index. Returns what was saved. */
export async function buildSeekIndex(rec: { id: string; drive_file_id: string; mime: string }): Promise<Stored> {
  let stored: Stored = { v: 1, none: true };
  if (/webm|matroska/.test(rec.mime)) {
    const r = await streamFile(rec.drive_file_id, null);
    if (r.body) stored = (await scanWebm(r.body)) ?? { v: 1, none: true };
  }
  await getSupabase().from("meeting_recordings").update({ seek_index: stored }).eq("id", rec.id);
  return stored;
}

export interface HeadPatch {
  bytes: Uint8Array;
  replaces: number;
}

/** Built heads, one per file and index (a few KB each), so a play / seek costs no extra Drive call. */
const heads = new Map<string, HeadPatch | null>();

/**
 * What the start of the served file looks like: the original bytes up to the
 * first cluster with a Duration written into Info and a Cues element added
 * just before the clusters. Falls back to the Duration-only patch when there
 * is no index yet, and to nothing for files that need neither.
 */
export async function recordingHead(rec: { id: string; drive_file_id: string; mime: string; duration_sec: number | null }, index: Stored | null): Promise<HeadPatch | null> {
  if (!/webm|matroska/.test(rec.mime)) return null;
  const withCues = index && !("none" in index) ? index : null;
  const key = `${rec.drive_file_id}:${withCues ? withCues.points.length : 0}:${rec.duration_sec ?? 0}`;
  if (heads.has(key)) return heads.get(key) ?? null;
  let patch: HeadPatch | null = null;
  try {
    if (withCues) {
      const r = await streamFile(rec.drive_file_id, `bytes=0-${withCues.firstCluster - 1}`);
      const orig = new Uint8Array(await r.arrayBuffer()).subarray(0, withCues.firstCluster);
      if (orig.length === withCues.firstCluster) {
        const dur = rec.duration_sec ? patchWebmHead(orig, rec.duration_sec) : null;
        const prefix = dur ? concat(dur.head, orig.subarray(dur.replaces)) : orig;
        // Every cluster moves by what now sits before it: the longer prefix and the Cues themselves.
        const shift = prefix.length + cuesLength(withCues) - withCues.firstCluster;
        patch = { bytes: concat(prefix, buildCues(withCues, shift)), replaces: withCues.firstCluster };
      }
    }
    if (!patch && rec.duration_sec) {
      const r = await streamFile(rec.drive_file_id, "bytes=0-65535");
      const dur = patchWebmHead(new Uint8Array(await r.arrayBuffer()), rec.duration_sec);
      patch = dur ? { bytes: dur.head, replaces: dur.replaces } : null;
    }
  } catch {
    return null; // serve the file as stored rather than fail the request
  }
  if (heads.size > 300) heads.clear();
  heads.set(key, patch);
  return patch;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
