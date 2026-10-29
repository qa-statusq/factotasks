"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCachedFetch } from "@/lib/client-cache";
import { useDocumentTitle } from "@/lib/use-document-title";
import { tabMemGet, tabMemRemove } from "@/lib/compat";
import { cn } from "@/lib/cn";
import { AppTile, EagerIconsContext } from "@/components/ui/task-chips";
import { useRecorder, screenRecordingSupported } from "@/lib/use-recorder";
import { canRecordMeeting } from "@/components/recording-controls";
import { fmtClock } from "@/lib/recordings";
import { IconCircleDot, IconX, IconMaximize, IconChevronLeft, IconChevronRight, IconPrint, IconApps, IconUserCheck, IconMessage, IconArrowRight } from "@/components/ui/icons";
import { buildSlides, Mark, DeckTaskContext, type Slide } from "./deck-slides";
import { CommentsViewer } from "@/components/comments-viewer";
import { AttachmentViewer, kindOf } from "@/components/attachment-viewer";
import { istDate } from "@/lib/time";
import type { DeckPack, TaskAttachment, TaskCard, TaskComment } from "@/lib/types";
import { useDeckKeys, useIdleChrome } from "./use-deck-controls";

/**
 * The meeting as slides. A fixed 16:9 stage (letterboxed on a laptop, edge to
 * edge on a projector) and every measurement in cqw — 1cqw = 1% of the slide
 * width — so the proportions never change with the screen. One slide per
 * section: cover, each app (releases, then tasks), work that spans apps,
 * approvals, minutes, carried forward. A section's table scrolls inside its
 * panel under a sticky header instead of splitting into "1 / 2" slides, and
 * the app strip at the bottom jumps straight to any section.
 */
export default function PresentPage() {
  return (
    <Suspense fallback={<Shell>Loading…</Shell>}>
      <Deck />
    </Suspense>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-svh items-center justify-center bg-[#141412] text-base text-white/70">{children}</div>;
}

/** One slide, re-rendered only when its own inputs change — never on the deck's chrome fades or the recording clock. */
const SlideSection = memo(function SlideSection({ slide, n, total, active }: { slide: Slide; n: number; total: number; active: boolean }) {
  return (
    <section className={cn("deck-slide absolute inset-0 flex flex-col transition-opacity duration-200", active ? "opacity-100" : "pointer-events-none opacity-0")} aria-hidden={!active} inert={!active ? true : undefined}>
      {slide.render(n, total)}
    </section>
  );
});

/** The record / stop control in the title band: the only part of the deck that follows the recorder's clock. */
function DeckRecordControls({ meetingId, meeting }: { meetingId: string; meeting: DeckPack["meeting"] }) {
  const recorder = useRecorder();
  const recPhase = recorder.state.phase;
  const recording = recPhase === "recording";
  if (!screenRecordingSupported() || !(recording || canRecordMeeting(meeting))) return null;
  return recording ? (
    <button type="button" onClick={recorder.stop} className="flex h-[52%] shrink-0 items-center gap-[0.6cqw] rounded-full bg-rose-500/20 pl-[1cqw] pr-[0.5cqw] text-[1.25cqw] font-semibold tabular-nums text-rose-100 ring-1 ring-inset ring-rose-300/40 hover:bg-rose-500/30" aria-label="Stop recording" title="Stop recording">
      <span className="h-[0.8cqw] w-[0.8cqw] animate-pulse rounded-full bg-rose-400" aria-hidden /> {fmtClock(recorder.state.seconds)}
      <span className="ml-[0.3cqw] flex h-[2cqw] w-[2cqw] items-center justify-center rounded-full bg-white/10"><span className="block h-[0.9cqw] w-[0.9cqw] rounded-[0.15cqw] bg-rose-300" aria-hidden /></span>
    </button>
  ) : (
    <button type="button" onClick={() => recorder.start(meetingId, meeting.title, "screen")} disabled={recPhase === "starting" || recPhase === "finishing"} className="flex h-[52%] w-[4cqw] shrink-0 items-center justify-center rounded-[0.8cqw] text-white/60 hover:bg-white/10 hover:text-rose-300 disabled:opacity-40" aria-label="Record" title="Record this meeting — screen and microphone, saved to the team's Shared Drive">
      <IconCircleDot className="h-[58%] w-[58%]" />
    </button>
  );
}

function Deck() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const sp = useSearchParams();
  const printMode = sp.get("print") === "1";
  const { data, loading, error, refresh } = useCachedFetch<DeckPack>(`/api/meetings/${id}`);
  useDocumentTitle(data ? `${data.meeting.title} · Present · FactoTasks` : "Present · FactoTasks");
  const [rawIndex, setIndex] = useState(0);
  const touchX = useRef<number | null>(null);
  const { chrome, wake } = useIdleChrome();
  const [jumpOpen, setJumpOpen] = useState(false);
  // A task's attachments or comments, opened from the icons on its slide row. The panel
  // opens at once (loading), the small list arrives a moment later; hovering or touching an
  // icon starts that request early, and each list is fetched once per task.
  const [viewing, setViewing] = useState<{ taskId: string; items: TaskAttachment[] | null } | null>(null);
  const [reading, setReading] = useState<{ task: TaskCard; comments: TaskComment[] | null } | null>(null);
  const lists = useRef(new Map<string, Promise<unknown>>());
  const fetchList = useCallback(<T,>(kind: "attachments" | "comments", taskId: string): Promise<T[]> => {
    const key = `${kind}:${taskId}`;
    let p = lists.current.get(key) as Promise<T[]> | undefined;
    if (!p) {
      p = fetch(`/api/tasks/${taskId}/${kind}`, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: Record<string, T[]>) => d[kind] ?? [])
        .catch((e) => {
          lists.current.delete(key); // a failed load is tried again next time
          throw e;
        });
      lists.current.set(key, p);
    }
    return p;
  }, []);
  const taskActions = useMemo(
    () => ({
      // On hover / touch: fetch the list, and for attachments start downloading the first picture
      // too — the browser keeps it, so the viewer shows it the moment it opens.
      prefetch: (t: TaskCard, kind: "attachments" | "comments") =>
        void fetchList<TaskAttachment>(kind, t.id)
          .then((list) => {
            if (kind !== "attachments") return;
            const first = [...list.filter((a) => kindOf(a.mime, a.file_name) === "image"), ...list][0];
            if (first && kindOf(first.mime, first.file_name) === "image") new Image().src = `/api/tasks/${t.id}/attachments/${first.id}`;
          })
          .catch(() => undefined),
      attachments: (t: TaskCard) => {
        setViewing({ taskId: t.id, items: null });
        fetchList<TaskAttachment>("attachments", t.id).then(
          (items) => setViewing((v) => (v?.taskId === t.id ? { taskId: t.id, items } : v)),
          () => setViewing((v) => (v?.taskId === t.id ? { taskId: t.id, items: [] } : v))
        );
      },
      comments: (t: TaskCard) => {
        setReading({ task: t, comments: null });
        fetchList<TaskComment>("comments", t.id).then(
          (comments) => setReading((v) => (v?.task.id === t.id ? { task: t, comments } : v)),
          () => setReading((v) => (v?.task.id === t.id ? { task: t, comments: [] } : v))
        );
      },
    }),
    [fetchList]
  );

  const slides = useMemo<Slide[]>(() => (data ? buildSlides(data) : []), [data]);
  const total = slides.length;
  const last = Math.max(0, total - 1);
  const index = Math.min(Math.max(0, rawIndex), last);
  const go = useCallback((n: number) => setIndex(Math.max(0, Math.min(last, n))), [last]);
  const next = useCallback(() => setIndex((i) => Math.min(last, Math.max(0, i) + 1)), [last]);
  const prev = useCallback(() => setIndex((i) => Math.max(0, Math.min(last, i) - 1)), [last]);
  const exit = useCallback(() => {
    const from = tabMemGet("ft_deck_from");
    tabMemRemove("ft_deck_from");
    if (from === id) router.back();
    else router.replace(`/meetings/${id}`);
  }, [router, id]);
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  }, []);

  useDeckKeys({ slides, last, next, prev, go, exit, toggleFullscreen, wake, jumpOpen, setJumpOpen });

  // Old links used ?print=1 on the deck; the minutes document is the print view now.
  useEffect(() => {
    if (printMode) router.replace(`/meetings/${id}/print`);
  }, [printMode, router, id]);

  if (loading) return <Shell>Preparing the deck…</Shell>;
  if (error && !data)
    return (
      <Shell>
        <span className="flex flex-col items-center gap-3">
          Couldn&rsquo;t load this meeting.
          <span className="flex gap-2">
            <button type="button" onClick={() => refresh()} className="rounded-lg bg-white px-3 py-1.5 text-[13px] font-semibold text-[#141412]">Try again</button>
            <Link href={`/meetings/${id}`} className="rounded-lg border border-white/30 px-3 py-1.5 text-[13px] font-semibold text-white">Back</Link>
          </span>
        </span>
      </Shell>
    );
  if (!data) return null;

  const jumps = slides.map((s, i) => ({ s, i })).filter((x) => x.s.jump);
  const currentJump = [...jumps].reverse().find((x) => x.i <= index)?.i;
  // Tiles share ~46cqw of the band (nav container units): 3.2cqw each until there are many sections.
  const tile = Math.max(1.9, Math.min(3.2, 46 / Math.max(1, jumps.length)));
  // Width the strip really occupies, in stage units (its container is 70% of the stage):
  // tiles + gaps, two arrows, the counter, the divider, four buttons and the paddings (≈44 nav-cqw of fixed chrome).
  const stripWidth = (44 + jumps.length * (tile + 0.4)) * 0.7;
  const titleMax = Math.max(22, 100 - 4 - stripWidth - 1.5);

  return (
    <div
      className={cn("deck-root fixed inset-0 flex select-none items-center justify-center bg-[#141412]", !chrome && "cursor-none")}
      onMouseMove={wake}
      onClick={wake}
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current === null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (Math.abs(dx) > 50) (dx < 0 ? next : prev)();
      }}
    >
      <style>{`@media print { @page { size: landscape; margin: 0; } }`}</style>
      {/* 16:9 stage */}
      <EagerIconsContext.Provider value={true}>
      <DeckTaskContext.Provider value={taskActions}>
      <div className="deck-stage relative overflow-hidden bg-canvas text-ink shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_30px_80px_rgba(0,0,0,0.6)]" style={{ width: "min(100vw, calc(100vh * 16 / 9))", height: "min(100vh, calc(100vw * 9 / 16))" }}>
        {/* The title band lives once, above every slide, so it never blinks on a slide change. Each slide keeps an invisible copy for print. */}
        <div className="deck-chrome absolute inset-x-0 top-0 flex items-center bg-[#1c1c1a] px-[4cqw] text-[1.05cqw] text-white/60" style={{ height: "9.6%", containerType: "inline-size" }}>
          <span className="inline-flex min-w-0 items-center gap-[0.8cqw]" style={{ maxWidth: `${titleMax}cqw` }}>
            <Mark className="h-[1.9cqw] w-[1.9cqw] text-white" />
            <span className="truncate font-semibold text-white/90">{data.meeting.title}</span>
            {!data.meeting.title.includes(istDate(data.meeting.held_at)) && <span className="shrink-0">· {istDate(data.meeting.held_at)}</span>}
          </span>
        </div>
        {slides.map((s, i) => (
          <SlideSection key={s.key} slide={s} n={i + 1} total={total} active={i === index} />
        ))}
        {/* Section strip in the title band: every section one tap away, never over the content. */}
        <nav className="deck-chrome absolute right-0 top-0 flex items-center justify-end" style={{ height: "9.6%", width: "70%", containerType: "inline-size" }} aria-label="Sections">
          <div className="flex h-full w-full items-center justify-end gap-[0.45cqw] pl-[1cqw] pr-[5.4cqw]">
            <button type="button" onClick={prev} disabled={index === 0} className="flex h-[52%] w-[4cqw] shrink-0 items-center justify-center rounded-[0.8cqw] text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-25" aria-label="Previous slide">
              <IconChevronLeft className="h-[60%] w-[60%]" />
            </button>
            <div className="flex h-full min-w-0 shrink items-center justify-end gap-[0.4cqw]">
              {jumps.map(({ s, i }, k) => {
                const on = i === currentJump;
                const j = s.jump!;
                return (
                  <button key={s.key} type="button" onClick={() => go(i)} title={`${j.label}${j.sub ? ` · ${j.sub}` : ""}${k < 9 ? ` (${k + 1})` : ""}`} aria-current={on ? "step" : undefined} style={{ width: `${tile}cqw`, height: `${tile}cqw` }} className={cn("flex shrink-0 items-center justify-center rounded-[0.8cqw] transition-[opacity,background-color]", on ? "bg-white/20 opacity-100 ring-[0.22cqw] ring-white" : "opacity-55 hover:bg-white/10 hover:opacity-100")}>
                    {j.icon ? (
                      <AppTile name={j.icon.name} color={j.icon.color} iconUrl={j.icon.iconUrl} className="h-[72%] w-[72%] rounded-[0.5cqw] text-[1.2cqw]" />
                    ) : (
                      <span className={cn("flex h-[72%] w-[72%] items-center justify-center rounded-[0.55cqw] text-[1.3cqw] font-bold text-white", j.kind === "shared" ? "bg-teal-600" : j.kind === "general" ? "bg-slate-500" : "bg-white/15")}>
                        {j.kind === "cover" ? <Mark className="h-[85%] w-[85%]" /> : j.kind === "shared" ? "⇄" : j.kind === "general" ? "G" : j.kind === "approvals" ? <IconUserCheck className="h-[62%] w-[62%]" /> : j.kind === "minutes" ? <IconMessage className="h-[62%] w-[62%]" /> : <IconArrowRight className="h-[62%] w-[62%]" />}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <button type="button" onClick={next} disabled={index === last} className="flex h-[52%] w-[4cqw] shrink-0 items-center justify-center rounded-[0.8cqw] text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-25" aria-label="Next slide">
              <IconChevronRight className="h-[60%] w-[60%]" />
            </button>
            <span className="mx-[0.4cqw] shrink-0 whitespace-nowrap text-[1.6cqw] tabular-nums text-white/60">
              {index + 1} / {total}
            </span>
            <span className="mx-[0.5cqw] h-[48%] w-px shrink-0 bg-white/15" aria-hidden />
            <DeckRecordControls meetingId={id} meeting={data.meeting} />
            <button type="button" onClick={() => setJumpOpen((o) => !o)} className={cn("flex h-[52%] w-[4cqw] shrink-0 items-center justify-center rounded-[0.8cqw] text-white/60 hover:bg-white/10 hover:text-white", jumpOpen && "bg-white/15 text-white")} aria-label="Jump to a section" title="Jump to a section (a)">
              <IconApps className="h-[58%] w-[58%]" />
            </button>
            <button type="button" onClick={() => window.open(`/meetings/${id}/print`, "_blank", "noopener")} className="flex h-[52%] w-[4cqw] shrink-0 items-center justify-center rounded-[0.8cqw] text-white/60 hover:bg-white/10 hover:text-white" aria-label="Print" title="Minutes as an A4 document — print or save as PDF">
              <IconPrint className="h-[58%] w-[58%]" />
            </button>
            <button type="button" onClick={toggleFullscreen} className="flex h-[52%] w-[4cqw] shrink-0 items-center justify-center rounded-[0.8cqw] text-white/60 hover:bg-white/10 hover:text-white" aria-label="Full screen" title="Full screen (f)">
              <IconMaximize className="h-[58%] w-[58%]" />
            </button>
            <button type="button" onClick={exit} className="flex h-[52%] w-[4cqw] shrink-0 items-center justify-center rounded-[0.8cqw] text-white/60 hover:bg-white/10 hover:text-white" aria-label="Exit" title="Exit (Esc)">
              <IconX className="h-[66%] w-[66%]" />
            </button>
          </div>
        </nav>
        {/* Thin edge strips inside the slide's side padding — they never sit over content. */}
        <button type="button" onClick={prev} className="deck-chrome absolute inset-y-[12%] left-0 w-[3%] opacity-0" aria-label="Previous slide" tabIndex={-1} />
        <button type="button" onClick={next} className="deck-chrome absolute inset-y-[12%] right-0 w-[3%] opacity-0" aria-label="Next slide" tabIndex={-1} />
      </div>
      </DeckTaskContext.Provider>
      </EagerIconsContext.Provider>

      {viewing && (
        <AttachmentViewer
          items={viewing.items && [...viewing.items.filter((a) => kindOf(a.mime, a.file_name) === "image"), ...viewing.items.filter((a) => kindOf(a.mime, a.file_name) !== "image")]}
          base={`/api/tasks/${viewing.taskId}/attachments`}
          onClose={() => setViewing(null)}
        />
      )}
      {reading && <CommentsViewer task={reading.task} comments={reading.comments} onClose={() => setReading(null)} />}

      {jumpOpen && (
        <div className="absolute inset-0 z-20 flex items-start justify-center bg-black/50 p-6 pt-16" onClick={() => setJumpOpen(false)}>
          <div className="w-full max-w-[760px] rounded-2xl border border-white/10 bg-[#1f1f1c] p-3 text-white shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Jump to">
            <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/50">Jump to · keys 1–9</p>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {jumps.map(({ s, i }, k) => (
                <button key={s.key} type="button" onClick={() => { go(i); setJumpOpen(false); }} className={cn("flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] hover:bg-white/10", i === currentJump && "bg-white/15")}>
                  {s.jump!.icon ? <AppTile name={s.jump!.icon.name} color={s.jump!.icon.color} iconUrl={s.jump!.icon.iconUrl} className="h-7 w-7 rounded-lg text-[10px]" /> : <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10 text-[11px] font-semibold tabular-nums">{k + 1}</span>}
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-medium leading-tight">{s.jump!.label}</span>
                    {s.jump!.sub && <span className="block text-[11px] text-white/50">{s.jump!.sub}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-white/40">{k < 9 ? k + 1 : ""}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

/* ------------------------------- slides ----------------------------------- */
