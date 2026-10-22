"use client";

import { tabMemGet, tabMemRemove } from "@/lib/compat";

import Link from "next/link";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCachedFetch } from "@/lib/client-cache";
import { useDocumentTitle } from "@/lib/use-document-title";
import { buildAgenda, notesByTask, type AgendaGroup } from "@/lib/meeting-agenda";
import { istTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import { STATUS_META, NOTE_KIND_META, PLATFORM_META, RELEASE_STATUS_META, taskRef } from "@/lib/domain";
import { toneClass } from "@/components/status-menu";
import { dueInfo } from "@/components/task-list";
import { AppTile } from "@/components/ui/task-chips";
import { IconX, IconMaximize, IconChevronLeft, IconChevronRight, IconPrint, IconAndroid, IconApple } from "@/components/ui/icons";
import type { MeetingNote, MeetingPack, TaskCard } from "@/lib/types";

/**
 * The meeting as slides. A fixed 16:9 stage (letterboxed on a laptop, edge to
 * edge on a projector) and every measurement in cqw — 1cqw = 1% of the slide
 * width — so the proportions never change with the screen. Each content
 * slide, cover and close included: an ink title band, a heading row, a framed
 * white panel holding one table, and a footer line. One template throughout.
 */
type Pack = MeetingPack & { workspace_name: string };
type Release = MeetingPack["releases"][number];
const TASKS_PER_SLIDE = 6;
const RELEASES_PER_SLIDE = 3;
const MINUTES_PER_SLIDE = 6;

const fmtDay = (iso: string) => istTime(iso).replace(/, \d\d:\d\d(:\d\d)? (am|pm) IST$/, "");
const fmtWhen = (iso: string) => istTime(iso).replace(/:\d\d (am|pm) IST$/, " $1");
const ymdPretty = (ymd: string) => new Date(ymd + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Slides hold a HEIGHT budget, not a row count: a row with a description and
 * notes takes the room of two plain rows. `cost` is in plain-row units. */
function chunkByCost<T>(list: T[], cost: (x: T) => number, budget: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const x of list) {
    const c = Math.min(budget, cost(x));
    if (cur.length && used + c > budget) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(x);
    used += c;
  }
  if (cur.length) out.push(cur);
  return out;
}
const NOTES_SHOWN_PER_TASK = 3;
const taskRowCost = (t: TaskCard, noteCount: number) => 1 + (t.description?.trim() ? 0.6 : 0) + Math.min(noteCount, NOTES_SHOWN_PER_TASK) * 0.45 + (noteCount > NOTES_SHOWN_PER_TASK ? 0.3 : 0) + (t.requested_status ? 0.35 : 0);
const minuteRowCost = (n: MeetingNote) => 1 + Math.min(3, Math.floor(n.body.length / 140)) * 0.5;

interface Slide {
  key: string;
  render: (n: number, total: number) => React.ReactNode;
}

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

function Deck() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const sp = useSearchParams();
  const printMode = sp.get("print") === "1";
  const { data, loading, error, refresh } = useCachedFetch<Pack>(`/api/meetings/${id}`);
  useDocumentTitle(data ? `${data.meeting.title} · Present · FactoTasks` : "Present · FactoTasks");
  const [rawIndex, setIndex] = useState(0);
  const touchX = useRef<number | null>(null);
  // Controls fade after a moment of stillness and come back on any movement,
  // so nothing sits over the slide while it is being presented.
  const [chrome, setChrome] = useState(true);
  const idleTimer = useRef(0);
  const wake = useCallback(() => {
    setChrome(true);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setChrome(false), 2500);
  }, []);
  useEffect(() => {
    // Starts visible; only arm the first fade here (no state write in the effect).
    idleTimer.current = window.setTimeout(() => setChrome(false), 2500);
    return () => window.clearTimeout(idleTimer.current);
  }, []);

  const slides = useMemo<Slide[]>(() => (data ? buildSlides(data) : []), [data]);
  const total = slides.length;
  const last = Math.max(0, total - 1);
  const index = Math.min(Math.max(0, rawIndex), last);
  const go = useCallback((n: number) => setIndex(Math.max(0, Math.min(last, n))), [last]);
  const next = useCallback(() => setIndex((i) => Math.min(last, Math.max(0, i) + 1)), [last]);
  const prev = useCallback(() => setIndex((i) => Math.max(0, Math.min(last, i) - 1)), [last]);
  // Back to the meeting page without leaving the deck in history behind it.
  // Opened from the meeting page in this tab → Back returns there (no dangling deck entry); otherwise land on it.
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
        case " ":
        case "PageDown":
          e.preventDefault();
          next();
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          prev();
          break;
        case "Home":
          e.preventDefault();
          go(0);
          break;
        case "End":
          e.preventDefault();
          go(last);
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "Escape":
          if (!document.fullscreenElement) exit();
          break;
      }
    };
    const onAny = (e: KeyboardEvent) => {
      wake();
      onKey(e);
    };
    window.addEventListener("keydown", onAny);
    return () => window.removeEventListener("keydown", onAny);
  }, [next, prev, go, last, exit, toggleFullscreen, wake]);

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
            <button type="button" onClick={() => refresh()} className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-white">Try again</button>
            <Link href={`/meetings/${id}`} className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-ink">Back</Link>
          </span>
        </span>
      </Shell>
    );
  if (!data) return null;

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
      <div className="deck-stage relative overflow-hidden bg-canvas text-ink shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_30px_80px_rgba(0,0,0,0.6)]" style={{ width: "min(100vw, calc(100vh * 16 / 9))", height: "min(100vh, calc(100vw * 9 / 16))" }}>
        {slides.map((s, i) => (
          <section key={s.key} className={cn("deck-slide absolute inset-0 flex flex-col transition-opacity duration-200", i === index ? "opacity-100" : "pointer-events-none opacity-0")} aria-hidden={i !== index}>
            {s.render(i + 1, total)}
          </section>
        ))}
        <button type="button" onClick={prev} className="deck-chrome absolute inset-y-[15%] left-0 w-1/5 cursor-w-resize opacity-0" aria-label="Previous slide" tabIndex={-1} />
        <button type="button" onClick={next} className="deck-chrome absolute inset-y-[15%] right-0 w-1/5 cursor-e-resize opacity-0" aria-label="Next slide" tabIndex={-1} />
      </div>

      {/* Controls live outside the stage so they never print or cover content. */}
      <div className={cn("deck-chrome absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-xl border border-white/10 bg-[#1f1f1c]/90 p-0.5 text-white/70 backdrop-blur transition-opacity duration-300", !chrome && "pointer-events-none opacity-0")}>
        <button type="button" onClick={() => window.open(`/meetings/${id}/print`, "_blank", "noopener")} className="rounded-lg p-2 hover:bg-white/10 hover:text-white" aria-label="Print" title="Minutes as an A4 document — print or save as PDF">
          <IconPrint size={17} />
        </button>
        <button type="button" onClick={toggleFullscreen} className="rounded-lg p-2 hover:bg-white/10 hover:text-white" aria-label="Full screen" title="Full screen (f)">
          <IconMaximize size={17} />
        </button>
        <button type="button" onClick={exit} className="rounded-lg p-2 hover:bg-white/10 hover:text-white" aria-label="Exit" title="Exit (Esc)">
          <IconX size={19} />
        </button>
      </div>
      <div className={cn("deck-chrome absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-[#1f1f1c]/90 px-2 py-1 text-[12px] text-white/70 backdrop-blur transition-opacity duration-300", !chrome && "pointer-events-none opacity-0")}>
        <button type="button" onClick={prev} disabled={index === 0} className="rounded-full p-1 hover:bg-white/10 hover:text-white disabled:opacity-30" aria-label="Previous">
          <IconChevronLeft size={16} />
        </button>
        <span className="tabular-nums">
          {index + 1} / {total}
        </span>
        <button type="button" onClick={next} disabled={index === last} className="rounded-full p-1 hover:bg-white/10 hover:text-white disabled:opacity-30" aria-label="Next">
          <IconChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------- slides ----------------------------------- */

function buildSlides(p: Pack): Slide[] {
  const slides: Slide[] = [];
  const m = p.meeting;
  const agenda = buildAgenda(p);
  const notes = notesByTask(p.notes);
  const appMeta = new Map(p.apps.map((a) => [a.id, a]));
  const windowText = p.previous_meeting ? `${fmtDay(p.previous_meeting)} – ${fmtDay(m.held_at)}` : `7 days to ${fmtDay(m.held_at)}`;
  const frame = (n: number, total: number) => ({ meeting: m, workspace: p.workspace_name, n, total });

  /* Cover */
  slides.push({
    key: "cover",
    render: (n, total) => (
      <Frame {...frame(n, total)} bare>
        <div className="grid flex-1 grid-cols-[1.15fr_1fr] items-center gap-[5cqw]">
          <div className="min-w-0">
            <p className="text-[1.15cqw] font-semibold uppercase tracking-[0.22em] text-ink-subtle">Minutes of meeting{p.series ? ` · ${p.series.name}` : ""}</p>
            <h1 className="mt-[1.2cqw] break-words text-[4.6cqw] font-bold leading-[1.05] tracking-[-0.03em] text-ink">{m.title}</h1>
            <dl className="mt-[2.4cqw] grid grid-cols-[auto_1fr] gap-x-[1.8cqw] gap-y-[0.7cqw] text-[1.35cqw]">
              <dt className="text-ink-subtle">Held</dt>
              <dd className="text-ink">{fmtWhen(m.held_at)} IST</dd>
              <dt className="text-ink-subtle">Covering</dt>
              <dd className="text-ink">{windowText}</dd>
              <dt className="text-ink-subtle">Scope</dt>
              <dd className="text-ink">{m.app_ids?.length ? `${p.apps.map((a) => a.name).join(", ")}${m.include_general !== false ? " + general tasks" : ""}` : "All apps & general tasks"}</dd>
              <dt className="text-ink-subtle">Status</dt>
              <dd className="text-ink">{m.status === "finalized" ? "Closed · minutes locked" : "Open · live figures"}</dd>
            </dl>
          </div>
          <div className="min-w-0">
            <div className="grid grid-cols-4 gap-[0.8cqw]">
              <Tile n={p.done.length} label="Done" tone="emerald" />
              <Tile n={p.pending.length} label="Pending" />
              <Tile n={p.carried.length} label="Carried" tone={p.carried.length ? "amber" : undefined} />
              <Tile n={p.overdue.length} label="Overdue" tone={p.overdue.length ? "red" : undefined} />
            </div>
            <div className={cn(PANEL, "mt-[1.4cqw]")}>
              <p className={PANEL_LABEL}>Agenda</p>
              {agenda.length === 0 ? (
                <p className="px-[1.3cqw] py-[1.2cqw] text-[1.25cqw] text-ink-muted">Nothing changed since the last meeting.</p>
              ) : (
                <ul className="divide-y divide-line/70 px-[1.3cqw]">
                  {agenda.slice(0, 7).map((g) => (
                    <li key={g.key} className="flex items-center gap-[1cqw] py-[0.8cqw] text-[1.25cqw]">
                      <AppTile name={g.name} color={g.color} iconUrl={g.iconUrl} className="h-[2.2cqw] w-[2.2cqw] rounded-[0.5cqw] text-[0.9cqw]" />
                      <span className="min-w-0 flex-1 truncate font-semibold text-ink">{g.name}</span>
                      <span className="shrink-0 tabular-nums text-ink-muted">
                        {g.pending.length} pending · <span className="text-emerald-700">{g.done.length} done</span>
                        {g.releases.length ? ` · ${g.releases.length} release${g.releases.length === 1 ? "" : "s"}` : ""}
                      </span>
                    </li>
                  ))}
                  {agenda.length > 7 && <li className="py-[0.8cqw] text-[1.05cqw] text-ink-subtle">+ {agenda.length - 7} more</li>}
                </ul>
              )}
            </div>
          </div>
        </div>
      </Frame>
    ),
  });

  /* One section per app: releases first, then tasks. */
  for (const g of agenda) {
    const meta = appMeta.get(g.key);
    const app = { group: g, platforms: meta ? { android: meta.has_android, ios: meta.has_ios } : undefined };

    if (g.releases.length) {
      chunk(g.releases, RELEASES_PER_SLIDE).forEach((part, i, all) => {
        slides.push({
          key: `rel-${g.key}-${i}`,
          render: (n, total) => (
            <Frame {...frame(n, total)} app={app} section="Releases" part={all.length > 1 ? `${i + 1} / ${all.length}` : undefined}>
              <ReleaseTable releases={part} />
            </Frame>
          ),
        });
      });
    }

    const rows: { t: TaskCard; done: boolean }[] = [...g.pending.map((t) => ({ t, done: false })), ...g.done.map((t) => ({ t, done: true }))];
    if (!rows.length) continue;
    const parts = chunkByCost(rows, (r) => taskRowCost(r.t, (notes.get(r.t.id) || []).length), TASKS_PER_SLIDE);
    parts.forEach((part, i) => {
      slides.push({
        key: `app-${g.key}-${i}`,
        render: (n, total) => (
          <Frame {...frame(n, total)} app={app} section="Tasks" part={parts.length > 1 ? `${i + 1} / ${parts.length}` : undefined}>
            <TaskTable rows={part} notes={notes} firstPendingIndex={part.findIndex((r) => !r.done)} firstDoneIndex={part.findIndex((r) => r.done)} counts={{ pending: g.pending.length, done: g.done.length }} />
          </Frame>
        ),
      });
    });
  }

  if (agenda.length === 0) {
    slides.push({
      key: "empty",
      render: (n, total) => (
        <Frame {...frame(n, total)} title="Nothing on the agenda">
          <p className="flex flex-1 items-center justify-center text-[1.8cqw] text-ink-muted">No tasks were created, completed or released since the last meeting.</p>
        </Frame>
      ),
    });
  }

  /* Approvals waiting on an admin. */
  if (p.approvals.length) {
    chunkByCost(p.approvals, (t) => taskRowCost(t, 0), TASKS_PER_SLIDE).forEach((part, i, all) => {
      slides.push({
        key: `approvals-${i}`,
        render: (n, total) => (
          <Frame {...frame(n, total)} title="Awaiting approval" subtitle={`${p.approvals.length} status change${p.approvals.length === 1 ? "" : "s"} waiting for an admin`} part={all.length > 1 ? `${i + 1} / ${all.length}` : undefined}>
            <TaskTable rows={part.map((t) => ({ t, done: false }))} notes={notes} showApp />
          </Frame>
        ),
      });
    });
  }

  /* Minutes: every note, in the order it was written, plus the general remarks. */
  const minutes = [...p.notes].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (minutes.length || m.notes) {
    const parts = chunkByCost(minutes, minuteRowCost, MINUTES_PER_SLIDE);
    if (!parts.length) parts.push([]);
    parts.forEach((part, i, all) => {
      slides.push({
        key: `minutes-${i}`,
        render: (n, total) => (
          <Frame {...frame(n, total)} title="Minutes" subtitle="Decisions, action items, blockers and notes recorded in this meeting" part={all.length > 1 ? `${i + 1} / ${all.length}` : undefined}>
            {i === 0 && m.notes && (
              <div className="mb-[1.2cqw] rounded-[0.8cqw] border border-line bg-surface px-[1.6cqw] py-[1.1cqw]">
                <p className="mb-[0.4cqw] text-[0.95cqw] font-semibold uppercase tracking-[0.18em] text-ink-subtle">Agenda & remarks</p>
                <p className="line-clamp-5 whitespace-pre-wrap break-words text-[1.3cqw] leading-relaxed text-ink">{m.notes}</p>
              </div>
            )}
            {part.length > 0 && <MinutesTable notes={part} />}
          </Frame>
        ),
      });
    });
  }

  /* Close */
  slides.push({
    key: "end",
    render: (n, total) => (
      <Frame {...frame(n, total)} title="Next steps" subtitle="What carries into the next meeting">
        <div className="grid flex-1 grid-cols-[1fr_1.2fr] items-center gap-[5cqw]">
          <div>
            <p className="text-[1.15cqw] font-semibold uppercase tracking-[0.22em] text-ink-subtle">Carried forward</p>
            <p className="mt-[1cqw] text-[6cqw] font-bold leading-none tracking-[-0.03em] text-ink tabular-nums">{p.pending.length}</p>
            <p className="mt-[0.6cqw] text-[1.6cqw] text-ink-muted">open task{p.pending.length === 1 ? "" : "s"}</p>
            {p.overdue.length > 0 && <p className="mt-[1.6cqw] text-[1.3cqw] font-medium text-red-600">{p.overdue.length} already past due.</p>}
            <p className="mt-[2.4cqw] text-[1.15cqw] text-ink-subtle">Minutes and notes stay on the meeting page.</p>
          </div>
          {p.pending.length > 0 ? (
            <div className={PANEL}>
              <p className={PANEL_LABEL}>Still open</p>
              <ul className="divide-y divide-line/70 px-[1.3cqw]">
                {[...p.pending]
                  .sort((a, b) => (b.carry ?? 0) - (a.carry ?? 0) || a.number - b.number)
                  .slice(0, 7)
                  .map((t) => (
                    <li key={t.id} className="flex items-center gap-[1cqw] py-[0.85cqw] text-[1.25cqw]">
                      <span className="shrink-0 tabular-nums text-ink-subtle">{taskRef(t.number)}</span>
                      <span className="min-w-0 flex-1 truncate font-medium text-ink">{t.title}</span>
                      <span className="shrink-0 text-ink-muted">{t.assignees.map((a) => a.name.split(" ")[0]).join(", ")}</span>
                      {typeof t.carry === "number" && t.carry > 0 && <CarryChip carry={t.carry} />}
                    </li>
                  ))}
                {p.pending.length > 7 && <li className="py-[0.85cqw] text-[1.05cqw] text-ink-subtle">+ {p.pending.length - 7} more</li>}
              </ul>
            </div>
          ) : (
            <div className={cn(PANEL, "flex items-center justify-center px-[2cqw] py-[3cqw] text-center")}>
              <p className="text-[2cqw] font-semibold text-emerald-700">Everything is closed. Nice work.</p>
            </div>
          )}
        </div>
      </Frame>
    ),
  });

  return slides;
}

/* ------------------------------ building blocks --------------------------- */

function Mark({ className }: { className?: string }) {
  // The brand mark in its own colours; reads on the ink band and on paper.
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("shrink-0", className)}>
      <rect width="32" height="32" rx="8" fill="#059669" />
      <path d="M9 6.5h14a3 3 0 0 1 0 6h-8v2.5h6.5a2.75 2.75 0 0 1 0 5.5H15v3a3 3 0 0 1-6 0V6.5z" fill="#ffffff" />
      <path d="M18 24.4l2.6 2.6 5.6-6" fill="none" stroke="#ffffff" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


function Frame({
  meeting,
  workspace,
  n,
  total,
  app,
  section,
  title,
  subtitle,
  part,
  bare,
  children,
}: {
  meeting: Pack["meeting"];
  workspace: string;
  n: number;
  total: number;
  app?: { group: AgendaGroup; platforms?: { android: boolean; ios: boolean } };
  section?: string;
  title?: React.ReactNode;
  subtitle?: string;
  part?: string;
  /** Cover-style slide: no heading row, the body fills the page. */
  bare?: boolean;
  children: React.ReactNode;
}) {
  const g = app?.group;
  return (
    <>
      {/* Title band */}
      <div className="flex h-[4.6cqw] shrink-0 items-center justify-between bg-[#1c1c1a] px-[4cqw] text-[1.05cqw] text-white/60">
        <span className="inline-flex min-w-0 items-center gap-[0.8cqw]">
          <Mark className="h-[1.9cqw] w-[1.9cqw] text-white" />
          <span className="truncate font-semibold text-white/90">{meeting.title}</span>
          {!meeting.title.includes(fmtDay(meeting.held_at)) && <span className="shrink-0">· {fmtDay(meeting.held_at)}</span>}
        </span>
        <span className="shrink-0 tabular-nums">
          {n} / {total}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-[4cqw] pb-[2.2cqw] pt-[2cqw]">
        {/* Slide heading */}
        {!bare && (
        <header className="flex shrink-0 items-center gap-[1.4cqw]">
          {g ? (
            <>
              <AppTile name={g.name} color={g.color} iconUrl={g.iconUrl} className="h-[5.4cqw] w-[5.4cqw] rounded-[1.1cqw] text-[2cqw] shadow-xs ring-1 ring-black/5" />
              <div className="min-w-0 flex-1">
                <h2 className="flex flex-wrap items-baseline gap-x-[0.8cqw] text-[2.9cqw] font-bold leading-none tracking-[-0.02em] text-ink">
                  <span className="break-words">{g.name}</span>
                  {section && <span className="font-medium text-ink-subtle">{section}</span>}
                  {part && <span className="text-[1.3cqw] font-medium text-ink-subtle">{part}</span>}
                </h2>
                {app?.platforms && (
                  <p className="mt-[0.7cqw] flex items-center gap-[1.2cqw] text-[1.15cqw] text-ink-muted">
                    {app.platforms.android && (
                      <span className="inline-flex items-center gap-[0.4cqw]">
                        <IconAndroid size={14} className="h-[1.3cqw] w-[1.3cqw] text-[#3ddc84]" /> Android
                      </span>
                    )}
                    {app.platforms.ios && (
                      <span className="inline-flex items-center gap-[0.4cqw]">
                        <IconApple size={14} className="h-[1.3cqw] w-[1.3cqw]" /> iOS
                      </span>
                    )}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-[0.6cqw]">
                <Tile n={g.pending.length} label="Pending" />
                <Tile n={g.carried} label="Carried" tone={g.carried ? "amber" : undefined} />
                <Tile n={g.overdue} label="Overdue" tone={g.overdue ? "red" : undefined} />
                <Tile n={g.done.length} label="Done" tone="emerald" />
                {g.releases.length > 0 && <Tile n={g.releases.length} label="Releases" tone="ink" />}
              </div>
            </>
          ) : (
            <div className="min-w-0">
              <h2 className="text-[2.9cqw] font-bold leading-none tracking-[-0.02em] text-ink">
                {title}
                {part && <span className="ml-[0.8cqw] text-[1.3cqw] font-medium text-ink-subtle">{part}</span>}
              </h2>
              {subtitle && <p className="mt-[0.7cqw] text-[1.15cqw] text-ink-muted">{subtitle}</p>}
            </div>
          )}
        </header>
        )}

        {/* Content panel */}
        <div className={cn("flex min-h-0 flex-1 flex-col", !bare && "mt-[1.6cqw]")}>{children}</div>

        {/* Footer */}
        <div className="mt-[1.2cqw] flex shrink-0 items-center justify-between border-t border-line pt-[0.8cqw] text-[0.95cqw] text-ink-subtle">
          <span>{workspace}</span>
          <span>Minutes of meeting · FactoTasks</span>
        </div>
      </div>
    </>
  );
}

function Tile({ n, label, tone }: { n: number; label: string; tone?: "emerald" | "amber" | "red" | "ink" }) {
  const cls = {
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    amber: "bg-amber-50 text-amber-700 ring-amber-200",
    red: "bg-red-50 text-red-600 ring-red-200",
    ink: "bg-ink text-white ring-ink",
    none: "bg-surface text-ink ring-line",
  }[tone ?? "none"];
  return (
    <div className={cn("min-w-[6cqw] rounded-[0.8cqw] px-[1cqw] py-[0.7cqw] text-center ring-1 ring-inset", cls)}>
      <div className="text-[2.2cqw] font-bold leading-none tabular-nums tracking-[-0.02em]">{n}</div>
      <div className={cn("mt-[0.45cqw] text-[0.8cqw] font-semibold uppercase tracking-[0.14em]", tone === "ink" ? "text-white/70" : "opacity-70")}>{label}</div>
    </div>
  );
}

/* Table styling shared by every content slide */
const PANEL = "overflow-hidden rounded-[1cqw] border border-line bg-surface shadow-[0_1px_0_rgba(0,0,0,0.02)]";
const TH = "bg-canvas px-[1.3cqw] py-[0.9cqw] text-left text-[0.95cqw] font-semibold uppercase tracking-[0.16em] text-ink-subtle";
/* Same look as a table header, for a panel caption that is not a <th>. */
const PANEL_LABEL = "block border-b border-line/70 " + TH;
const TD = "px-[1.3cqw] py-[1.2cqw] align-top text-[1.4cqw] leading-snug";
const BADGE = "inline-block whitespace-nowrap rounded-full px-[0.95cqw] py-[0.35cqw] text-[1.05cqw] font-semibold ring-1 ring-inset";

function SectionRow({ label, count, tone, cols }: { label: string; count: number; tone: "pending" | "done"; cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className={cn("border-y border-line/70 px-[1.3cqw] py-[0.55cqw] text-[0.95cqw] font-semibold uppercase tracking-[0.16em]", tone === "done" ? "bg-emerald-50/60 text-emerald-700" : "bg-canvas/70 text-ink-muted")}>
        {label} · {count}
      </td>
    </tr>
  );
}

function TaskTable({
  rows,
  notes,
  firstPendingIndex = -1,
  firstDoneIndex = -1,
  counts,
  showApp,
}: {
  rows: { t: TaskCard; done: boolean }[];
  notes: Map<string, MeetingNote[]>;
  firstPendingIndex?: number;
  firstDoneIndex?: number;
  counts?: { pending: number; done: number };
  showApp?: boolean;
}) {
  const cols = showApp ? 6 : 5;
  return (
    <div className={PANEL}>
      <table className="w-full border-collapse">
        <colgroup>
          <col style={{ width: "7%" }} />
          {showApp && <col style={{ width: "14%" }} />}
          <col />
          <col style={{ width: "17%" }} />
          <col style={{ width: "11%" }} />
          <col style={{ width: "14%" }} />
        </colgroup>
        <thead>
          <tr>
            <th className={TH}>#</th>
            {showApp && <th className={TH}>App</th>}
            <th className={TH}>Task</th>
            <th className={TH}>Owner</th>
            <th className={TH}>Due</th>
            <th className={cn(TH, "text-right")}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ t, done }, i) => {
            const taskNotes = notes.get(t.id) || [];
            const desc = t.description?.trim();
            const due = dueInfo(t.due_date, t.status);
            return (
              <FragmentRows key={t.id}>
                {counts && i === firstPendingIndex && <SectionRow label="Pending" count={counts.pending} tone="pending" cols={cols} />}
                {counts && i === firstDoneIndex && <SectionRow label="Completed since last meeting" count={counts.done} tone="done" cols={cols} />}
                <tr className="border-b border-line/70 last:border-b-0">
                  <td className={cn(TD, "tabular-nums text-ink-subtle")}>{taskRef(t.number)}</td>
                  {showApp && (
                    <td className={cn(TD, "text-ink-muted")}>
                      <span className="inline-flex items-center gap-[0.5cqw]">
                        <AppTile name={t.app?.name ?? "General"} color={t.app?.color ?? "#94a3b8"} iconUrl={t.app?.icon_url} className="h-[1.8cqw] w-[1.8cqw] rounded-[0.4cqw] text-[0.8cqw]" />
                        <span className="truncate">{t.app?.name ?? "General"}</span>
                      </span>
                    </td>
                  )}
                  <td className={cn(TD, "pr-[2cqw]")}>
                    <div className="flex flex-wrap items-baseline gap-x-[0.8cqw] gap-y-[0.3cqw]">
                      <span className={cn("break-words font-semibold", done ? "text-ink-muted" : "text-ink")}>{t.title}</span>
                      {t.platform && (
                        <span className="inline-flex items-center gap-[0.3cqw] text-[1.05cqw] text-ink-subtle">
                          {t.platform === "android" ? <IconAndroid size={12} className="h-[1.1cqw] w-[1.1cqw] text-[#3ddc84]" /> : <IconApple size={12} className="h-[1.1cqw] w-[1.1cqw]" />}
                          {PLATFORM_META[t.platform].label}
                        </span>
                      )}
                      {(t.targets?.length ?? 0) > 1 && <span className="text-[1.05cqw] text-ink-subtle">{t.targets.length} targets</span>}
                      {t.release_progress && t.release_progress.released > 0 && <span className={cn("shrink-0 rounded-full px-[0.7cqw] py-[0.15cqw] text-[0.95cqw] font-semibold ring-1 ring-inset", t.release_progress.released >= t.release_progress.total ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-teal-50 text-teal-700 ring-teal-200")}>Released {t.release_progress.released}/{t.release_progress.total}</span>}
                      {typeof t.carry === "number" && t.carry > 0 && <CarryChip carry={t.carry} />}
                      {t.pinned && <span className="shrink-0 rounded-full bg-canvas px-[0.7cqw] py-[0.15cqw] text-[0.95cqw] font-semibold text-ink-muted ring-1 ring-inset ring-line">Pinned</span>}
                    </div>
                    {desc && <p className="mt-[0.4cqw] line-clamp-2 whitespace-pre-wrap break-words text-[1.15cqw] leading-snug text-ink-muted">{desc}</p>}
                    {t.requested_status && <p className="mt-[0.4cqw] text-[1.1cqw] text-amber-700">Asked to move to {STATUS_META[t.requested_status].label} — awaiting approval</p>}
                    {taskNotes.length > 0 && (
                      <ul className="mt-[0.9cqw] flex flex-col gap-[0.55cqw] border-l-[0.25cqw] border-line pl-[1cqw]">
                        {taskNotes.slice(0, NOTES_SHOWN_PER_TASK).map((x) => (
                          <li key={x.id} className="flex items-start gap-[0.7cqw] text-[1.2cqw] leading-snug text-ink">
                            <NoteKind kind={x.kind} />
                            <span className="line-clamp-2 min-w-0 whitespace-pre-wrap break-words">{x.body}</span>
                          </li>
                        ))}
                        {taskNotes.length > NOTES_SHOWN_PER_TASK && <li className="text-[1.05cqw] text-ink-subtle">+ {taskNotes.length - NOTES_SHOWN_PER_TASK} more in the minutes</li>}
                      </ul>
                    )}
                  </td>
                  <td className={cn(TD, "text-ink-muted")}>{t.assignees.length ? t.assignees.map((a) => a.name.split(" ")[0]).join(", ") : <span className="text-ink-subtle">Unassigned</span>}</td>
                  <td className={cn(TD, "tabular-nums", due?.tone === "danger" ? "font-semibold text-red-600" : due?.tone === "warning" ? "font-semibold text-amber-700" : "text-ink-muted")}>{t.due_date ? ymdPretty(t.due_date) : <span className="text-ink-subtle">—</span>}</td>
                  <td className={cn(TD, "text-right")}>
                    <span className={cn(BADGE, toneClass(t.status))}>{STATUS_META[t.status].label}</span>
                  </td>
                </tr>
              </FragmentRows>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** React fragments can't take a key inside a map without the long form. */
function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function ReleaseTable({ releases }: { releases: Release[] }) {
  return (
    <div className={PANEL}>
      <table className="w-full border-collapse">
        <colgroup>
          <col style={{ width: "14%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "13%" }} />
          <col style={{ width: "16%" }} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th className={TH}>Version</th>
            <th className={TH}>Platform</th>
            <th className={TH}>Status</th>
            <th className={TH}>Date</th>
            <th className={TH}>Release notes</th>
          </tr>
        </thead>
        <tbody>
          {releases.map((r) => (
            <tr key={r.id} className="border-b border-line/70 last:border-b-0">
              <td className={cn(TD, "font-semibold tabular-nums text-ink")}>
                v{r.version_name}
                {r.build_number && <span className="ml-[0.4cqw] text-[1.05cqw] font-normal text-ink-subtle">({r.build_number})</span>}
              </td>
              <td className={cn(TD, "text-ink-muted")}>
                <span className="inline-flex items-center gap-[0.5cqw]">
                  {r.platform === "android" ? <IconAndroid size={14} className="h-[1.3cqw] w-[1.3cqw] text-[#3ddc84]" /> : <IconApple size={14} className="h-[1.3cqw] w-[1.3cqw]" />}
                  {PLATFORM_META[r.platform].label}
                </span>
              </td>
              <td className={TD}>
                <span className={cn(BADGE, r.status === "released" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-canvas text-ink-muted ring-line")}>{RELEASE_STATUS_META[r.status].label}</span>
              </td>
              <td className={cn(TD, "tabular-nums text-ink-muted")}>{r.status === "released" && r.released_at ? fmtDay(r.released_at) : r.planned_date ? `${ymdPretty(r.planned_date)} (planned)` : "—"}</td>
              <td className={cn(TD, "text-ink-muted")}>
                {r.tasks && r.tasks.length > 0 && (
                  <ul className="mb-[0.5cqw] flex flex-col gap-[0.35cqw]">
                    {r.tasks.slice(0, 5).map((t) => (
                      <li key={t.id} className="leading-snug">
                        <span className="mr-[0.5cqw] tabular-nums text-ink-subtle">{taskRef(t.number)}</span>
                        <span className="font-medium text-ink">{t.title}</span>
                        {t.description && <span className="text-ink-muted"> — {t.description.split("\n")[0].slice(0, 110)}</span>}
                      </li>
                    ))}
                    {r.tasks.length > 5 && <li className="text-[0.85em] text-ink-subtle">+ {r.tasks.length - 5} more</li>}
                  </ul>
                )}
                {r.description ? <p className="line-clamp-3 whitespace-pre-wrap break-words leading-snug">{r.description}</p> : !r.tasks?.length && <span className="text-ink-subtle">No notes</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MinutesTable({ notes }: { notes: MeetingNote[] }) {
  return (
    <div className={PANEL}>
      <table className="w-full border-collapse">
        <colgroup>
          <col style={{ width: "13%" }} />
          <col style={{ width: "30%" }} />
          <col />
          <col style={{ width: "12%" }} />
        </colgroup>
        <thead>
          <tr>
            <th className={TH}>Type</th>
            <th className={TH}>About</th>
            <th className={TH}>Minute</th>
            <th className={TH}>By</th>
          </tr>
        </thead>
        <tbody>
          {notes.map((x) => (
            <tr key={x.id} className="border-b border-line/70 last:border-b-0">
              <td className={TD}>
                <NoteKind kind={x.kind} />
              </td>
              <td className={TD}>
                {x.task ? (
                  <>
                    <span className="mr-[0.5cqw] tabular-nums text-ink-subtle">{taskRef(x.task.number)}</span>
                    <span className="break-words font-medium text-ink">{x.task.title}</span>
                  </>
                ) : x.about ? (
                  <span className="font-medium text-ink">{x.about.name}</span>
                ) : (
                  <span className="text-ink-subtle">General</span>
                )}
              </td>
              <td className={cn(TD, "whitespace-pre-wrap break-words text-ink")}><span className="line-clamp-4">{x.body}</span></td>
              <td className={cn(TD, "text-ink-muted")}>{x.author ? x.author.name.split(" ")[0] : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CarryChip({ carry }: { carry: number }) {
  return (
    <span className={cn("shrink-0 whitespace-nowrap rounded-full px-[0.7cqw] py-[0.15cqw] text-[0.95cqw] font-bold ring-1 ring-inset", carry >= 3 ? "bg-red-50 text-red-700 ring-red-200" : "bg-amber-50 text-amber-700 ring-amber-200")} title={`Pending for ${carry} earlier meeting${carry === 1 ? "" : "s"}`}>
      {carry}× carried
    </span>
  );
}

function NoteKind({ kind }: { kind: MeetingNote["kind"] }) {
  return (
    <span
      className={cn(
        "mt-[0.1cqw] inline-block shrink-0 whitespace-nowrap rounded-[0.4cqw] px-[0.7cqw] py-[0.25cqw] text-[0.9cqw] font-bold uppercase tracking-[0.08em] ring-1 ring-inset",
        kind === "blocker" ? "bg-red-50 text-red-700 ring-red-200" : kind === "decision" ? "bg-ink text-white ring-ink" : kind === "action" ? "bg-sky-50 text-sky-700 ring-sky-200" : "bg-surface text-ink-muted ring-line"
      )}
    >
      {NOTE_KIND_META[kind].label}
    </span>
  );
}
