"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useMemo } from "react";
import { Button, buttonClass } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { PlayerSheet } from "@/components/recordings";
import { useRecorder, screenRecordingSupported, audioRecordingSupported, type RecordMode } from "@/lib/use-recorder";
import { fmtClock, fmtDuration, recordingLabel } from "@/lib/recordings";
import { fmtBytes } from "@/lib/format";
import { istDayKey } from "@/lib/ist";
import { cn } from "@/lib/cn";
import { useLatest } from "@/lib/use-latest";
import { anchorRect } from "@/lib/viewport";
import { IconCircleDot, IconDownload, IconX, IconMic, IconVideo, IconChevronDown, IconPlay, IconCheck, IconPresentation } from "@/components/ui/icons";

/** True on the meeting's day in India and any day after, while the meeting is still open. */
export function canRecordMeeting(m: { status: "open" | "finalized"; held_at: string }): boolean {
  if (m.status !== "open") return false;
  return istDayKey(new Date().toISOString()) >= istDayKey(m.held_at);
}

/** The record menu's width (w-64), for choosing the side it opens to. */
const MENU_WIDTH = 256;

/**
 * "Record meeting" on the meeting page: a menu with the two ways to record.
 * While a recording runs the same spot becomes one chip — a soft red dot,
 * the time as hh:mm:ss and the stop square — nothing else.
 */
export function RecordButton({ meetingId, title, className }: { meetingId: string; title: string; className?: string }) {
  const { state, start, stop } = useRecorder();
  const [open, setOpen] = useState(false);
  // The menu opens towards the side with room: from the button's right edge when
  // a left-anchored menu would run past the screen (phones, where the page clips it).
  const [alignRight, setAlignRight] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!audioRecordingSupported()) return null;
  const mine = state.meetingId === meetingId;
  if (state.phase === "recording" && mine) return <RecordingChip seconds={state.seconds} mode={state.mode} onStop={stop} className={className} />;
  const busy = state.phase === "starting" || state.phase === "recording" || state.phase === "finishing";
  const pick = (mode: RecordMode) => {
    setOpen(false);
    void start(meetingId, title, mode);
  };
  return (
    <span ref={ref} className={cn("relative inline-flex", className)}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          const r = ref.current ? anchorRect(ref.current) : null;
          setAlignRight(!!r && r.left + MENU_WIDTH + 8 > r.vw);
          setOpen((o) => !o);
        }}
        disabled={busy}
        title={busy && !mine ? "Another recording is running" : "Record this meeting"}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconCircleDot size={14} className="text-rose-500" /> Record meeting <IconChevronDown size={13} className="-mr-0.5 text-ink-subtle" />
      </Button>
      {open && (
        <div role="menu" className={cn("absolute top-full z-30 mt-1 w-64 overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-pop", alignRight ? "right-0" : "left-0")}>
          {screenRecordingSupported() && (
            <button type="button" role="menuitem" onClick={() => pick("screen")} className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-canvas">
              <IconVideo size={16} className="mt-0.5 shrink-0 text-ink-muted" />
              <span>
                <span className="block text-[13px] font-medium text-ink">Screen + audio</span>
                <span className="block text-[11.5px] text-ink-subtle">The whole screen, its sound and your microphone</span>
              </span>
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => pick("audio")} className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-canvas">
            <IconMic size={16} className="mt-0.5 shrink-0 text-ink-muted" />
            <span>
              <span className="block text-[13px] font-medium text-ink">Audio only</span>
              <span className="block text-[11.5px] text-ink-subtle">Just the microphone — small file, works on phones</span>
            </span>
          </button>
        </div>
      )}
    </span>
  );
}

/** One chip: ● 00:12:34 ■ — soft red on white; the square stops. */
function RecordingChip({ seconds, mode, onStop, className }: { seconds: number; mode?: RecordMode; onStop?: () => void; className?: string }) {
  return (
    <span className={cn("inline-flex h-8 items-center gap-2 rounded-full bg-rose-50 pl-2.5 text-[12.5px] font-semibold tabular-nums text-rose-700 ring-1 ring-inset ring-rose-200", onStop ? "pr-1" : "pr-2.5", className)} role="status" aria-label={`Recording, ${fmtClock(seconds)}`}>
      <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" aria-hidden />
      {fmtClock(seconds)}
      {mode === "audio" && <IconMic size={12} className="opacity-70" />}
      {onStop && (
        <button type="button" onClick={onStop} className="ml-0.5 flex h-6 w-6 items-center justify-center rounded-full hover:bg-rose-100" aria-label="Stop recording" title="Stop recording">
          <span className="block h-2.5 w-2.5 rounded-[2px] bg-rose-600" aria-hidden />
        </button>
      )}
    </span>
  );
}

/** Quiet badge for lists: "● Recording · 00:00:12". */
export function RecordingBadge({ seconds, className }: { seconds: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-rose-700 ring-1 ring-inset ring-rose-200", className)}>
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-500" aria-hidden /> Recording · {fmtClock(seconds)}
    </span>
  );
}

const SAVED_SHOWN_MS = 12_000;

/**
 * The saving bar. Most of the file went up while recording, so after Stop only
 * a small tail is sent (shown for real, 0–60%); the storage then needs a
 * moment to close a file of this size, which no request reports on — that
 * part is paced by a size-based estimate and eases towards 98% until the
 * file is confirmed. Animated per frame, so it never sits still or jumps.
 */
function useSavingBar(active: boolean, startedAt: number, uploadFraction: number, totalBytes: number): number {
  const [shown, setShown] = useState(0);
  const target = useRef(0);
  // Live inputs are read through a ref: a progress event must feed the running loop, not restart it at 0.
  const live = useLatest({ uploadFraction, totalBytes });
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let first = true;
    let last = performance.now();
    const tick = () => {
      if (first) {
        first = false;
        target.current = 0;
        setShown(0);
      }
      const now = performance.now();
      const elapsed = now - startedAt;
      const expectedMs = 2200 + (live.current.totalBytes / 30_000_000) * 1000; // ~2 s fixed + 30 MB/s of closing work
      const paced = 1 - Math.exp(-elapsed / (expectedMs * 0.6));
      target.current = Math.min(0.98, 0.6 * Math.min(1, live.current.uploadFraction) + 0.38 * paced);
      const dt = Math.min(100, now - last);
      last = now;
      setShown((cur) => (target.current > cur ? Math.min(target.current, cur + (target.current - cur) * Math.min(1, dt / 180)) : cur));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, startedAt, live]);
  return active ? shown : 0;
}

/**
 * What the panel shows about its own recording:
 *  - while recording: a small dock at the bottom centre (never behind sticky
 *    headers, never where the offline strip lives) with the time and Stop;
 *    hidden on the deck, whose own band already shows the time;
 *  - after Stop: a centred "Saving recording" dialog with real progress;
 *  - once saved: the same dialog with Play and "View in meeting", which
 *    closes itself after a moment;
 *  - on failure: the dialog with Try again and a download of the file.
 */
export function RecorderOverlay() {
  const { state, stop, retry, dismiss } = useRecorder();
  const pathname = usePathname();
  const presenting = /^\/meetings\/[^/]+\/present$/.test(pathname ?? "");
  const { phase } = state;
  const { toast } = useToast();
  const [player, setPlayer] = useState(false);
  const [hold, setHold] = useState(false);
  const bar = useSavingBar(phase === "finishing", state.finishStartedAt, state.finishProgress / 0.95, state.recordedBytes);
  // The kept file's download link: one URL per file, revoked when the file goes (a blob can be hundreds of MB).
  const blobUrl = useMemo(() => (state.blob ? URL.createObjectURL(state.blob) : null), [state.blob]);
  useEffect(() => () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }, [blobUrl]);

  // A recording that never started (no microphone, no screen, permission refused) is a passing message, not a card.
  const startFailure = phase === "error" && !state.blob;
  useEffect(() => {
    if (!startFailure) return;
    toast(state.error || "Couldn't start recording", "error");
    dismiss();
  }, [startFailure, state.error, toast, dismiss]);

  // The saved dialog leaves on its own unless the pointer is on it (or the player is open).
  useEffect(() => {
    if (phase !== "done" || hold || player) return;
    const t = window.setTimeout(dismiss, SAVED_SHOWN_MS);
    return () => window.clearTimeout(t);
  }, [phase, hold, player, dismiss]);

  if (phase === "idle" || phase === "starting" || startFailure) return null;
  const pct = Math.round(bar * 100);
  const label = state.saved ? recordingLabel(state.saved) : state.title;

  if (phase === "recording") {
    if (presenting) return null;
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
        <div role="status" aria-live="polite" className="pointer-events-auto flex h-10 max-w-full items-center gap-3 rounded-full border border-line bg-surface pl-3.5 pr-1.5 text-[12.5px] text-ink shadow-[0_6px_24px_rgba(0,0,0,0.12)]">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-rose-500" aria-hidden />
          <span className="shrink-0 font-semibold tabular-nums">{fmtClock(state.seconds)}</span>
          <span className="hidden h-4 w-px shrink-0 bg-line sm:block" aria-hidden />
          <span className="hidden min-w-0 max-w-[34rem] truncate text-ink-muted sm:block" title={state.title}>
            Recording {state.mode === "audio" ? "audio" : "the screen"} · {state.title}
          </span>
          <span className="hidden w-[4.5rem] shrink-0 text-right tabular-nums text-ink-subtle md:inline">{fmtBytes(state.recordedBytes)}</span>
          <button type="button" onClick={stop} className="ml-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line bg-canvas px-2.5 text-[12px] font-medium text-ink hover:bg-rose-50 hover:text-rose-700">
            <span className="block h-2 w-2 rounded-[2px] bg-rose-500" aria-hidden /> Stop
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] w-[22rem] max-w-[calc(100vw-2rem)]">
        <div
          role="dialog"
          aria-live="polite"
          aria-label={phase === "finishing" ? "Saving recording" : phase === "done" ? "Recording saved" : "Recording problem"}
          onPointerEnter={() => setHold(true)}
          onPointerLeave={() => setHold(false)}
          className="pointer-events-auto w-full rounded-xl border border-line bg-surface p-3.5 text-ink shadow-[0_8px_28px_rgba(0,0,0,0.14)]"
        >
          {phase === "finishing" && (
            <>
              <div className="flex items-center gap-2.5">
                <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-ink" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold leading-tight">Saving recording…</p>
                  <p className="truncate text-[11.5px] text-ink-subtle">
                    {fmtDuration(state.seconds)} · {fmtBytes(state.recordedBytes)} · keep this tab open
                  </p>
                </div>
                <span className="w-9 text-right text-[11.5px] tabular-nums text-ink-subtle">{pct}%</span>
              </div>
              <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-line/70">
                <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-300 ease-out" style={{ width: `${Math.max(4, pct)}%` }} />
              </div>
            </>
          )}
          {phase === "done" && (
            <>
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                  <IconCheck size={13} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold leading-tight">Recording saved</p>
                  <p className="truncate text-[11.5px] text-ink-subtle">
                    {label} · {fmtDuration(state.saved?.duration_sec ?? state.seconds)} · {fmtBytes(state.saved?.size_bytes ?? state.recordedBytes)}
                  </p>
                  {state.note && <p className="mt-1 text-[11.5px] text-ink-subtle">{state.note}</p>}
                </div>
                <button type="button" onClick={dismiss} className="-mr-1 -mt-1 rounded-md p-1 text-ink-subtle hover:bg-canvas hover:text-ink" aria-label="Dismiss" title="Dismiss">
                  <IconX size={14} />
                </button>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-[2.1rem]">
                {state.saved && (
                  <button type="button" onClick={() => setPlayer(true)} className={buttonClass("secondary", "sm", "h-7 px-2.5 text-[12px]")}>
                    <IconPlay size={12} /> Play recording
                  </button>
                )}
                {state.meetingId && (
                  <Link href={`/meetings/${state.meetingId}#recordings`} onClick={dismiss} className={buttonClass("secondary", "sm", "h-7 px-2.5 text-[12px]")}>
                    <IconPresentation size={12} /> View in meeting
                  </Link>
                )}
              </div>
            </>
          )}
          {phase === "error" && (
            <>
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600">
                  <IconX size={13} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold leading-tight">{state.blob ? "Couldn't save the recording" : "Recording didn't start"}</p>
                  <p className="text-[11.5px] text-ink-subtle">{state.error}</p>
                </div>
                <button type="button" onClick={dismiss} className="-mr-1 -mt-1 rounded-md p-1 text-ink-subtle hover:bg-canvas hover:text-ink" aria-label="Dismiss" title="Dismiss">
                  <IconX size={14} />
                </button>
              </div>
              {state.blob && (
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-[2.1rem]">
                  <Button size="sm" onClick={retry} className="h-7 px-2.5 text-[12px]">Try again</Button>
                  <a href={blobUrl ?? undefined} download={`${state.title}.${state.mode === "audio" ? "weba" : "webm"}`} className={buttonClass("secondary", "sm", "h-7 px-2.5 text-[12px]")}>
                    <IconDownload size={12} /> Download ({fmtBytes(state.blob.size)})
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {player && state.saved && <PlayerSheet r={state.saved} onClose={() => setPlayer(false)} />}
    </>
  );
}
