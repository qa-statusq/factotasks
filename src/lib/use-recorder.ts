"use client";

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { postJson, deleteJson } from "@/lib/http";
import { mutate, mutatePrefix } from "@/lib/client-cache";
import { tabMemGet, tabMemRemove, tabMemSet } from "@/lib/compat";
import type { Recording } from "@/lib/types";
import { IDLE, type RecordMode, type RecorderState } from "@/lib/recorder/types";
import { openCapture, recorderOptions, screenRecordingSupported, audioRecordingSupported, type Capture } from "@/lib/recorder/capture";
import { CHUNK, FLUSH_MS, GRAIN, sendChunk, type ChunkOutcome } from "@/lib/recorder/upload";

export type { RecorderPhase, RecordMode, RecorderState } from "@/lib/recorder/types";
export { screenRecordingSupported, audioRecordingSupported } from "@/lib/recorder/capture";

/**
 * One recorder for the whole panel. It lives above the pages, so a recording
 * started on the meeting page keeps running when the deck opens, and the
 * recording dock follows the presenter to every screen of this tab.
 *
 * The file is UPLOADED WHILE RECORDING — every chunk goes to the meeting's
 * upload as soon as it exists — so Stop only sends the last few seconds and a
 * meeting of any length is saved within moments. What is captured lives in
 * lib/recorder/capture.ts, how a chunk travels in lib/recorder/upload.ts; this
 * file is the state that ties them together.
 *
 * Laptop browsers only for screen capture; audio-only works on phones too.
 */
const PENDING_KEY = "ft_rec_pending";
const KEEP_COPY_UP_TO = 1024 * 1024 * 1024; // keep a local copy for the fallback download up to 1 GB

interface RecorderApi {
  state: RecorderState;
  start: (meetingId: string, title: string, mode?: RecordMode) => Promise<void>;
  stop: () => void;
  retry: () => void;
  /** Clear a finished or failed card. Does nothing while recording or saving. */
  dismiss: () => void;
}

const Ctx = createContext<RecorderApi>({ state: IDLE, start: async () => undefined, stop: () => undefined, retry: () => undefined, dismiss: () => undefined });

export function useRecorder(): RecorderApi {
  return useContext(Ctx);
}

export function RecorderProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RecorderState>(IDLE);
  const patch = useCallback((p: Partial<RecorderState>) => setState((s) => ({ ...s, ...p })), []);
  const meeting = useRef<{ id: string; title: string } | null>(null);
  const starting = useRef(false);

  const rec = useRef<MediaRecorder | null>(null);
  const capture = useRef<Capture | null>(null);
  const timer = useRef(0);
  const startedAt = useRef(0);
  const mime = useRef("video/webm");
  // Upload bookkeeping: everything recorded (fallback download), what is queued, what the storage has.
  const all = useRef<Blob[]>([]);
  const allBytes = useRef(0);
  const queue = useRef<Blob[]>([]);
  const queued = useRef(0);
  const offset = useRef(0);
  /**
   * Every byte the recorder has produced — only ever grows. The size on screen comes from this
   * alone: "sent + queued" dips by a whole chunk while that chunk is in flight (it has left the
   * queue but is not yet confirmed), which made the figure step back for a moment.
   */
  const captured = useRef(0);
  const recordingId = useRef<string | null>(null);
  const creating = useRef<Promise<string | null> | null>(null);
  const stopped = useRef(false);
  const pumping = useRef(false);
  const lastSend = useRef(0);
  /** Bytes confirmed when Stop was pressed: the saving bar measures only what came after. */
  const finishBase = useRef(0);
  const failed = useRef(false);

  const refreshLists = useCallback(() => {
    const m = meeting.current;
    if (m) mutate(`/api/meetings/${m.id}/recordings`);
    mutatePrefix("/api/recordings");
  }, []);

  const releaseMedia = useCallback(() => {
    window.clearInterval(timer.current);
    capture.current?.release();
    capture.current = null;
    rec.current = null;
  }, []);
  useEffect(() => () => releaseMedia(), [releaseMedia]);

  /**
   * The upload gave up (or never opened): stop capturing at once. Without this the
   * screen/microphone stayed captured with no Stop control, the queue kept growing
   * in memory, and a later "Try again" raced the still-running uploader (R2-1).
   */
  const abortCapture = useCallback(() => {
    stopped.current = true;
    const r0 = rec.current;
    if (r0) {
      r0.onstop = null;
      r0.onerror = null;
      r0.ondataavailable = null;
      if (r0.state !== "inactive") r0.stop();
    }
    releaseMedia();
    queue.current = [];
    queued.current = 0;
  }, [releaseMedia]);

  // Leaving the tab mid-recording: warn first; if it still goes (reload, close), close the upload
  // with what has already arrived — a beacon survives the unload — and remember it for when the panel is back.
  useEffect(() => {
    if (state.phase !== "recording" && state.phase !== "finishing") return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    const gone = () => {
      const id = recordingId.current;
      if (!id) return;
      const seconds = Math.floor((performance.now() - startedAt.current) / 1000);
      tabMemSet(PENDING_KEY, JSON.stringify({ id, meetingId: meeting.current?.id, title: meeting.current?.title, seconds, at: Date.now() }));
      navigator.sendBeacon(`/api/recordings/${id}/finalize`, new Blob([JSON.stringify({ duration_sec: seconds })], { type: "application/json" }));
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("pagehide", gone);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("pagehide", gone);
    };
  }, [state.phase]);
  // Back after a reload mid-recording: make sure the upload was closed and show what was kept.
  useEffect(() => {
    const raw = tabMemGet(PENDING_KEY);
    if (!raw) return;
    tabMemRemove(PENDING_KEY);
    let p: { id: string; meetingId?: string; title?: string; seconds?: number } | null = null;
    try {
      p = JSON.parse(raw);
    } catch {
      p = null;
    }
    if (!p?.id) return;
    const pending = p;
    void postJson<{ done?: boolean; recovered?: boolean; recording?: Recording; error?: string }>(`/api/recordings/${pending.id}/finalize`, { duration_sec: pending.seconds ?? null }).then((r) => {
      if (r.ok && r.data?.recording) {
        setState({ ...IDLE, meetingId: pending.meetingId ?? null, title: pending.title ?? "", phase: "done", seconds: pending.seconds ?? 0, recordedBytes: r.data.recording.size_bytes, saved: r.data.recording, note: "the page was reloaded while recording, so it ends there" });
        mutatePrefix("/api/recordings");
        if (pending.meetingId) mutate(`/api/meetings/${pending.meetingId}/recordings`);
      } else {
        setState({ ...IDLE, meetingId: pending.meetingId ?? null, title: pending.title ?? "", phase: "error", error: r.data?.error || "The recording was interrupted by a reload and nothing of it could be kept" });
      }
    });
  }, []);

  const keepCopy = useCallback((b: Blob) => {
    if (allBytes.current > KEEP_COPY_UP_TO) {
      all.current = [];
      return;
    }
    all.current.push(b);
    allBytes.current += b.size;
  }, []);
  const fallbackBlob = useCallback(() => (all.current.length && allBytes.current <= KEEP_COPY_UP_TO ? new Blob(all.current, { type: mime.current }) : null), []);

  /** One chunk to the open upload, with the bars following its bytes. */
  const send = useCallback(
    async (body: Blob, at: number, total: number | null, durationSec: number | null): Promise<ChunkOutcome> => {
      const id = recordingId.current;
      if (!id) return { ok: false, error: "No upload in progress" };
      return sendChunk(id, body, at, total, durationSec, (sent) => {
        const recorded = Math.max(sent, captured.current);
        const left = recorded - finishBase.current;
        patch({ finishProgress: left > 0 ? Math.min(0.95, (sent - finishBase.current) / left) : 0.95 });
      });
    },
    [patch]
  );

  /** Push queued bytes: full chunks while recording, everything that is left once stopped. */
  const pump = useCallback(async () => {
    if (pumping.current || failed.current) return;
    pumping.current = true;
    try {
      if (!recordingId.current) {
        const id = creating.current ? await creating.current : null;
        if (!id) return;
      }
      for (;;) {
        const final = stopped.current && rec.current === null;
        if (final && offset.current + queued.current === 0) {
          // Stopped before the capture produced a byte (a refused screen, "Stop sharing" at once):
          // there is nothing to keep, so the row goes and the message passes.
          const id = recordingId.current;
          recordingId.current = null;
          failed.current = true;
          if (id) void deleteJson(`/api/recordings/${id}`).then(() => refreshLists());
          patch({ phase: "error", error: "Nothing was recorded — it stopped before anything was captured", blob: null, saved: null });
          return;
        }
        // A full chunk, or whatever 256 KiB multiples have piled up after a few seconds — so a tab that
        // vanishes loses only the last seconds, not the last chunk.
        const due = queued.current >= CHUNK || (queued.current >= GRAIN && performance.now() - lastSend.current > FLUSH_MS);
        if (!final && !due) break;
        const take = final ? queued.current : Math.floor(Math.min(queued.current, CHUNK) / GRAIN) * GRAIN;
        if (!final && take === 0) break;
        lastSend.current = performance.now();
        const total = final ? offset.current + queued.current : null;
        const seconds = (performance.now() - startedAt.current) / 1000;
        const parts: Blob[] = [];
        let have = 0;
        while (have < take && queue.current.length) {
          const b = queue.current[0];
          if (have + b.size <= take) {
            parts.push(b);
            have += b.size;
            queue.current.shift();
          } else {
            parts.push(b.slice(0, take - have));
            queue.current[0] = b.slice(take - have);
            have = take;
          }
        }
        queued.current -= take;
        const body = new Blob(parts, { type: mime.current });
        const at = offset.current;
        const r = await send(body, at, total, seconds);
        if (!r.ok) {
          failed.current = true;
          abortCapture();
          patch({ phase: "error", error: `Couldn't save the recording: ${r.error}.`, blob: fallbackBlob() });
          return;
        }
        offset.current = at + take;
        const recorded = captured.current;
        const left = recorded - finishBase.current;
        patch({ recordedBytes: recorded, finishProgress: left > 0 ? Math.min(0.95, (offset.current - finishBase.current) / left) : 0.95 });
        if (r.done) {
          patch({ phase: "done", saved: r.recording ?? null, blob: null });
          all.current = [];
          allBytes.current = 0;
          recordingId.current = null;
          refreshLists();
          return;
        }
        if (final) {
          // Everything sent but the storage wants the closing request (the file was an exact multiple of the chunk size).
          const close = await send(new Blob([], { type: mime.current }), offset.current, offset.current, seconds);
          if (close.ok && close.done) {
            patch({ phase: "done", saved: close.recording ?? null, blob: null });
            all.current = [];
            allBytes.current = 0;
            recordingId.current = null;
            refreshLists();
          } else if (!close.ok) {
            failed.current = true;
            abortCapture();
            patch({ phase: "error", error: `Couldn't finish saving: ${close.error}`, blob: fallbackBlob() });
          }
          return;
        }
      }
    } finally {
      pumping.current = false;
    }
  }, [patch, send, refreshLists, fallbackBlob, abortCapture]);

  /** Runs when the recorder stops for any reason: Stop here, "Stop sharing" in the browser's bar, or the device vanishing. */
  const finish = useCallback(() => {
    stopped.current = true;
    releaseMedia();
    // The recorder also stops when the start itself failed (the upload could not be opened): that
    // failure is already on screen and must not turn into an endless "Saving…".
    if (failed.current) return;
    if (!finishBase.current) finishBase.current = offset.current;
    patch({ phase: "finishing", finishProgress: 0, finishStartedAt: performance.now() });
    void pump();
  }, [patch, pump, releaseMedia]);

  const stop = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    stopped.current = true;
    finishBase.current = offset.current;
    patch({ phase: "finishing", finishProgress: 0, finishStartedAt: performance.now() });
    if (r.state !== "inactive") r.stop(); // onstop → finish()
    else finish();
  }, [patch, finish]);

  const start = useCallback(
    async (meetingId: string, title: string, mode: RecordMode = "screen") => {
      const supported = mode === "audio" ? audioRecordingSupported() : screenRecordingSupported();
      if (!supported) {
        setState({ ...IDLE, meetingId, title, mode, phase: "error", error: mode === "audio" ? "This browser can't record audio" : "This browser can't record the screen — use Chrome or Edge on a laptop" });
        return;
      }
      if (rec.current || starting.current) return;
      starting.current = true;
      meeting.current = { id: meetingId, title };
      setState({ ...IDLE, meetingId, title, mode, phase: "starting" });
      all.current = [];
      allBytes.current = 0;
      queue.current = [];
      queued.current = 0;
      offset.current = 0;
      captured.current = 0;
      stopped.current = false;
      failed.current = false;
      recordingId.current = null;
      creating.current = null;
      finishBase.current = 0;
      try {
        const cap = await openCapture(mode);
        capture.current = cap;
        mime.current = cap.mime;
        const r = new MediaRecorder(cap.stream, recorderOptions(mode, cap.mime));
        r.ondataavailable = (e) => {
          if (!e.data.size) return;
          keepCopy(e.data);
          queue.current.push(e.data);
          queued.current += e.data.size;
          captured.current += e.data.size;
          patch({ recordedBytes: captured.current });
          void pump();
        };
        r.onstop = finish;
        r.onerror = finish;
        rec.current = r;
        // "Stop sharing" in the browser's own bar ends the recorder, which lands in finish() through onstop.
        cap.display?.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (rec.current && rec.current.state !== "inactive") rec.current.stop();
        });
        // Recording starts NOW; the upload is opened alongside and the first chunks wait for it.
        r.start(1000);
        startedAt.current = performance.now();
        lastSend.current = performance.now();
        timer.current = window.setInterval(() => {
          patch({ seconds: Math.floor((performance.now() - startedAt.current) / 1000) });
          void pump();
        }, 1000);
        patch({ phase: "recording", seconds: 0 });
        creating.current = postJson<{ recording?: Recording; error?: string }>(`/api/meetings/${meetingId}/recordings`, { mime: mime.current }).then((started) => {
          if (!started.ok || !started.data?.recording) {
            failed.current = true;
            abortCapture();
            setState({ ...IDLE, meetingId, title, mode, phase: "error", error: started.data?.error || "Couldn't start saving the recording", blob: fallbackBlob() });
            return null;
          }
          recordingId.current = started.data.recording.id;
          refreshLists(); // the meeting's card shows the recording as in progress right away
          void pump();
          return recordingId.current;
        });
      } catch (e) {
        releaseMedia();
        const name = (e as { name?: string } | null)?.name;
        if (name === "NotAllowedError") setState(IDLE);
        else setState({ ...IDLE, meetingId, title, mode, phase: "error", error: name === "NotFoundError" ? (mode === "audio" ? "No microphone was found" : "No screen to capture was found") : "Couldn't start recording" });
      } finally {
        starting.current = false;
      }
    },
    [patch, pump, releaseMedia, finish, keepCopy, fallbackBlob, refreshLists, abortCapture]
  );

  /** After a failure: upload the kept file from scratch as a new recording. */
  const resend = useCallback(async (blob: Blob, m: { id: string; title: string }) => {
    failed.current = false;
    finishBase.current = 0;
    recordingId.current = null; // the failed upload is abandoned; nothing may write to it any more
    queue.current = [];
    queued.current = 0;
    offset.current = 0;
    captured.current = blob.size;
    patch({ phase: "finishing", error: null, finishProgress: 0, finishStartedAt: performance.now(), recordedBytes: blob.size });
    const started = await postJson<{ recording?: Recording; error?: string }>(`/api/meetings/${m.id}/recordings`, { mime: blob.type || mime.current, size_bytes: blob.size, duration_sec: state.seconds });
    if (!started.ok || !started.data?.recording) {
      patch({ phase: "error", error: started.data?.error || "Couldn't start saving the recording" });
      return;
    }
    recordingId.current = started.data.recording.id;
    let at = 0;
    while (at < blob.size) {
      const end = Math.min(blob.size, at + CHUNK);
      const r = await send(blob.slice(at, end), at, blob.size, state.seconds);
      if (!r.ok) {
        patch({ phase: "error", error: `Couldn't save the recording: ${r.error}` });
        return;
      }
      at = end;
      patch({ finishProgress: Math.min(0.95, at / blob.size) });
      if (r.done) {
        patch({ phase: "done", saved: r.recording ?? null, blob: null });
        refreshLists();
        return;
      }
    }
  }, [patch, send, refreshLists, state.seconds]);

  const retrying = useRef(false);
  const retry = useCallback(async () => {
    const blob = state.blob;
    const m = meeting.current;
    // Never while a capture is still live, and once at a time.
    if (!blob || !m || rec.current || retrying.current) return;
    retrying.current = true;
    try {
      await resend(blob, m);
    } finally {
      retrying.current = false;
    }
  }, [state.blob, resend]);


  const dismiss = useCallback(() => {
    // Belt and braces: a dismissed error never leaves a capture running.
    if (failed.current && rec.current) abortCapture();
    setState((s) => (s.phase === "recording" || s.phase === "finishing" || s.phase === "starting" ? s : IDLE));
  }, [abortCapture]);

  // One value per state change: consumers re-render when the recording moves, never because the provider's parent did.
  const api = useMemo<RecorderApi>(() => ({ state, start, stop, retry, dismiss }), [state, start, stop, retry, dismiss]);
  // The handlers read refs when CALLED (events), never during render; the compiler lint cannot see that through the context value.
  // eslint-disable-next-line react-hooks/refs
  return createElement(Ctx.Provider, { value: api }, children);
}
