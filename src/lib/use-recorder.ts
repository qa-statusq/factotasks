"use client";

import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState } from "react";
import { postJson } from "@/lib/http";
import { mutate, mutatePrefix } from "@/lib/client-cache";
import { tabMemGet, tabMemRemove, tabMemSet } from "@/lib/compat";
import type { Recording } from "@/lib/types";

/**
 * One recorder for the whole panel. It lives above the pages, so a recording
 * started on the meeting page keeps running when the deck opens, and the
 * recording dock follows the presenter to every screen of this tab.
 *
 * Two modes: the whole screen (every tab and window) with system sound and
 * the microphone, or the microphone alone. Either way the file is UPLOADED
 * WHILE RECORDING — every 8 MiB goes to the meeting's Google Drive upload as
 * soon as it exists — so Stop only sends the last few seconds and a meeting
 * of any length is saved within moments. Each chunk reports its own progress,
 * is retried on its own, and a dropped connection resumes where Google stands.
 *
 * Laptop browsers only for screen capture; audio-only works on phones too.
 */
export type RecorderPhase = "idle" | "starting" | "recording" | "finishing" | "done" | "error";
export type RecordMode = "screen" | "audio";

export interface RecorderState {
  meetingId: string | null;
  title: string;
  mode: RecordMode;
  phase: RecorderPhase;
  /** Seconds recorded so far. */
  seconds: number;
  /** Bytes produced by the recorder, and bytes Google has (plus the part of the current chunk in flight). */
  recordedBytes: number;
  sentBytes: number;
  /** 0..1 — how much of what was recorded has reached the storage. */
  progress: number;
  /** 0..1 — after Stop: how much of the part still to send has gone (never reaches 1 before the file is confirmed). */
  finishProgress: number;
  error: string | null;
  saved: Recording | null;
  /** The whole recording as a file when saving failed, so it can still be downloaded. */
  blob: Blob | null;
  /** A word on how it ended, e.g. after a reload. */
  note: string | null;
}

const IDLE: RecorderState = { meetingId: null, title: "", mode: "screen", phase: "idle", seconds: 0, recordedBytes: 0, sentBytes: 0, progress: 0, finishProgress: 0, error: null, saved: null, blob: null, note: null };
const PENDING_KEY = "ft_rec_pending";
const VIDEO_MIMES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
const AUDIO_MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const CHUNK = 2 * 1024 * 1024;
const FLUSH_MS = 5000; // send what has piled up at least this often, so a closed tab loses a few seconds at most
const GRAIN = 256 * 1024; // every chunk but the last must be a multiple of this (Google's rule)
const KEEP_COPY_UP_TO = 1024 * 1024 * 1024; // keep a local copy for the fallback download up to 1 GB

export function screenRecordingSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined";
}
export function audioRecordingSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}
/** @deprecated use screenRecordingSupported */
export const recorderSupported = screenRecordingSupported;

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

interface SendResult {
  ok: boolean;
  done?: boolean;
  received?: number;
  recording?: Recording;
  error?: string;
  status: number;
}

/** PUT one chunk with upload progress (XHR is the only browser API that reports it). */
function putChunk(url: string, body: Blob, headers: Record<string, string>, onProgress: (loaded: number) => void): Promise<SendResult> {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.withCredentials = true;
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => {
      let j: Partial<SendResult> = {};
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

export function RecorderProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RecorderState>(IDLE);
  const patch = useCallback((p: Partial<RecorderState>) => setState((s) => ({ ...s, ...p })), []);
  const meeting = useRef<{ id: string; title: string } | null>(null);
  const starting = useRef(false);

  const rec = useRef<MediaRecorder | null>(null);
  const streams = useRef<MediaStream[]>([]);
  const audioCtx = useRef<AudioContext | null>(null);
  const timer = useRef(0);
  const startedAt = useRef(0);
  const mime = useRef("video/webm");
  // Upload bookkeeping: everything recorded (fallback download), what is queued, what Google has.
  const all = useRef<Blob[]>([]);
  const allBytes = useRef(0);
  const queue = useRef<Blob[]>([]);
  const queued = useRef(0);
  const offset = useRef(0);
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
    for (const s of streams.current) s.getTracks().forEach((t) => t.stop());
    streams.current = [];
    void audioCtx.current?.close().catch(() => undefined);
    audioCtx.current = null;
    rec.current = null;
  }, []);
  useEffect(() => () => releaseMedia(), [releaseMedia]);

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
        setState({ ...IDLE, meetingId: pending.meetingId ?? null, title: pending.title ?? "", phase: "done", seconds: pending.seconds ?? 0, recordedBytes: r.data.recording.size_bytes, sentBytes: r.data.recording.size_bytes, progress: 1, saved: r.data.recording, note: "the page was reloaded while recording, so it ends there" });
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

  /** Send one chunk; retries with a status check in between. */
  const send = useCallback(
    async (body: Blob, at: number, total: number | null, durationSec: number | null): Promise<{ ok: true; done: boolean; recording?: Recording } | { ok: false; error: string }> => {
      const id = recordingId.current;
      if (!id) return { ok: false, error: "No upload in progress" };
      for (let attempt = 1; attempt <= 6; attempt++) {
        const r = await putChunk(
          `/api/recordings/${id}/chunk`,
          body,
          { "content-type": "application/octet-stream", "x-chunk-offset": String(at), "x-chunk-total": total == null ? "*" : String(total), ...(durationSec != null ? { "x-duration-sec": String(Math.round(durationSec)) } : {}) },
          (loaded) => {
            const sent = at + Math.min(loaded, body.size);
            const recorded = Math.max(sent, offset.current + queued.current + Math.max(0, at + body.size - offset.current));
            const left = recorded - finishBase.current;
            patch({ sentBytes: sent, progress: recorded ? sent / recorded : 0, finishProgress: left > 0 ? Math.min(0.95, (sent - finishBase.current) / left) : 0.95 });
          }
        );
        if (r.ok) {
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
        const st = await fetch(`/api/recordings/${id}/chunk`, { credentials: "same-origin" }).then((x) => (x.ok ? (x.json() as Promise<{ done?: boolean; received?: number }>) : null)).catch(() => null);
        if (st?.done) return { ok: true, done: true };
        if (typeof st?.received === "number" && st.received > at) {
          body = body.slice(st.received - at);
          at = st.received;
          if (!body.size && total == null) return { ok: true, done: false };
        }
      }
      return { ok: false, error: "The connection kept failing" };
    },
    [patch]
  );

  /** Push queued bytes to Google: full 8 MiB chunks while recording, everything that is left once stopped. */
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
        // A full chunk, or whatever 256 KiB multiples have piled up after a few seconds — so a tab that
        // vanishes loses only the last seconds, not the last 8 MiB.
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
        const r = await send(body, at, total, final ? seconds : null);
        if (!r.ok) {
          failed.current = true;
          patch({ phase: "error", error: `Couldn't save the recording: ${r.error}.`, blob: fallbackBlob() });
          return;
        }
        offset.current = at + take;
        const recorded = offset.current + queued.current;
        const left = recorded - finishBase.current;
        patch({ sentBytes: offset.current, recordedBytes: recorded, progress: recorded ? offset.current / recorded : 0, finishProgress: left > 0 ? Math.min(0.95, (offset.current - finishBase.current) / left) : 0.95 });
        if (r.done) {
          patch({ phase: "done", progress: 1, sentBytes: recorded, saved: r.recording ?? null, blob: null });
          all.current = [];
          allBytes.current = 0;
          recordingId.current = null;
          refreshLists();
          return;
        }
        if (final) {
          // Everything sent but Google wants the closing request (the file was an exact multiple of the chunk size).
          const close = await send(new Blob([], { type: mime.current }), offset.current, offset.current, seconds);
          if (close.ok && close.done) {
            patch({ phase: "done", progress: 1, saved: close.recording ?? null, blob: null });
            all.current = [];
            allBytes.current = 0;
            recordingId.current = null;
            refreshLists();
          } else if (!close.ok) {
            failed.current = true;
            patch({ phase: "error", error: `Couldn't finish saving: ${close.error}`, blob: fallbackBlob() });
          }
          return;
        }
      }
    } finally {
      pumping.current = false;
    }
  }, [patch, send, refreshLists, fallbackBlob]);

  /** Runs when the recorder stops for any reason: Stop here, "Stop sharing" in Chrome's bar, or the device vanishing. */
  const finish = useCallback(() => {
    stopped.current = true;
    releaseMedia();
    if (!finishBase.current) finishBase.current = offset.current;
    patch({ phase: "finishing", finishProgress: 0 });
    void pump();
  }, [patch, pump, releaseMedia]);

  const stop = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    stopped.current = true;
    finishBase.current = offset.current;
    patch({ phase: "finishing", finishProgress: 0 });
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
      stopped.current = false;
      failed.current = false;
      recordingId.current = null;
      creating.current = null;
      finishBase.current = 0;
      try {
        const tracks: MediaStreamTrack[] = [];
        let display: MediaStream | null = null;
        if (mode === "screen") {
          // The WHOLE screen by default — every browser tab and every other window — with any sound it makes.
          display = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 20, max: 30 }, ...({ displaySurface: "monitor" } as object) },
            audio: true,
            ...({ selfBrowserSurface: "include", surfaceSwitching: "include", systemAudio: "include", monitorTypeSurfaces: "include" } as object),
          });
          streams.current.push(display);
          tracks.push(...display.getVideoTracks());
        }
        let mic: MediaStream | null = null;
        try {
          mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
          streams.current.push(mic);
        } catch (e) {
          if (mode === "audio") throw e;
          mic = null;
        }
        const audioSources = [display, mic].filter((s): s is MediaStream => !!s && s.getAudioTracks().length > 0);
        if (audioSources.length === 1) tracks.push(...audioSources[0].getAudioTracks());
        else if (audioSources.length > 1) {
          // Mix tab sound and the mic into one track so the file has a single audio stream.
          const ctx = new AudioContext();
          audioCtx.current = ctx;
          const dest = ctx.createMediaStreamDestination();
          for (const s of audioSources) ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest);
          tracks.push(...dest.stream.getAudioTracks());
        }
        mime.current = (mode === "audio" ? AUDIO_MIMES : VIDEO_MIMES).find((m) => MediaRecorder.isTypeSupported(m)) ?? (mode === "audio" ? "audio/webm" : "video/webm");
        const stream = new MediaStream(tracks);
        // Slides are mostly still: 1.5 Mbit/s keeps a two-hour meeting near 1.3 GB and still crisp.
        const r = new MediaRecorder(stream, mode === "audio" ? { mimeType: mime.current, audioBitsPerSecond: 96_000 } : { mimeType: mime.current, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 96_000 });
        r.ondataavailable = (e) => {
          if (!e.data.size) return;
          keepCopy(e.data);
          queue.current.push(e.data);
          queued.current += e.data.size;
          patch({ recordedBytes: offset.current + queued.current });
          void pump();
        };
        r.onstop = finish;
        r.onerror = finish;
        rec.current = r;
        // "Stop sharing" in the browser's own bar ends the recorder, which lands in finish() through onstop.
        display?.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (rec.current && rec.current.state !== "inactive") rec.current.stop();
        });
        // Recording starts NOW; the Drive upload is opened alongside and the first chunks wait for it.
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
            if (rec.current && rec.current.state !== "inactive") rec.current.stop();
            releaseMedia();
            setState({ ...IDLE, meetingId, title, mode, phase: "error", error: started.data?.error || "Couldn't start saving the recording", blob: fallbackBlob() });
            return null;
          }
          recordingId.current = started.data.recording.id;
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
    [patch, pump, releaseMedia, finish, keepCopy, fallbackBlob]
  );

  /** After a failure: upload the kept file from scratch as a new recording. */
  const retry = useCallback(async () => {
    const blob = state.blob;
    const m = meeting.current;
    if (!blob || !m) return;
    failed.current = false;
    finishBase.current = 0;
    patch({ phase: "finishing", error: null, progress: 0, finishProgress: 0, sentBytes: 0, recordedBytes: blob.size });
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
      patch({ sentBytes: at, progress: at / blob.size, finishProgress: Math.min(0.95, at / blob.size) });
      if (r.done) {
        patch({ phase: "done", progress: 1, saved: r.recording ?? null, blob: null });
        refreshLists();
        return;
      }
    }
  }, [patch, send, state.blob, state.seconds, refreshLists]);

  const dismiss = useCallback(() => {
    setState((s) => (s.phase === "recording" || s.phase === "finishing" || s.phase === "starting" ? s : IDLE));
  }, []);

  const api: RecorderApi = { state, start, stop, retry, dismiss };
  // The handlers read refs when CALLED (events), never during render; the compiler lint cannot see that through the context value.
  // eslint-disable-next-line react-hooks/refs
  return createElement(Ctx.Provider, { value: api }, children);
}
