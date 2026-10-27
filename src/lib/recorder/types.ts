import type { Recording } from "@/lib/types";

export type RecorderPhase = "idle" | "starting" | "recording" | "finishing" | "done" | "error";
export type RecordMode = "screen" | "audio";

export interface RecorderState {
  meetingId: string | null;
  title: string;
  mode: RecordMode;
  phase: RecorderPhase;
  /** Seconds recorded so far. */
  seconds: number;
  /** Bytes produced by the recorder so far (only ever grows while recording). */
  recordedBytes: number;
  /** 0..1 — after Stop: how much of the part still to send has gone (never reaches 1 before the file is confirmed). */
  finishProgress: number;
  error: string | null;
  saved: Recording | null;
  /** The whole recording as a file when saving failed, so it can still be downloaded. */
  blob: Blob | null;
  /** A word on how it ended, e.g. after a reload. */
  note: string | null;
  /** When Stop was pressed (ms since page load) — the saving bar paces itself from it. */
  finishStartedAt: number;
}

export const IDLE: RecorderState = { meetingId: null, title: "", mode: "screen", phase: "idle", seconds: 0, recordedBytes: 0, finishProgress: 0, error: null, saved: null, blob: null, note: null, finishStartedAt: 0 };
