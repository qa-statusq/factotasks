"use client";

import { tabMemGet, tabMemRemove } from "@/lib/compat";

import Link from "next/link";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCachedFetch } from "@/lib/client-cache";
import { useDocumentTitle } from "@/lib/use-document-title";
import { buildAgenda, notesByTask, deckRows, nameLabels, packPeople, ownerText, targetMatrix, platformsOn, SHARED_KEY, type AgendaGroup } from "@/lib/meeting-agenda";
import { istTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import { STATUS_META, NOTE_KIND_META, PLATFORM_META, RELEASE_STATUS_META, TASK_STATUSES, taskRef, type TaskStatus, type ReleaseStatus } from "@/lib/domain";
import { dueInfo } from "@/components/task-list";
import { AppTile, PlatformGlyph } from "@/components/ui/task-chips";
import { nameInitials } from "@/lib/name";
import { ClampedText } from "@/components/ui/clamped-text";
import { IconX, IconMaximize, IconChevronLeft, IconChevronRight, IconPrint, IconApps, IconUserCheck, IconMessage, IconArrowRight } from "@/components/ui/icons";
import type { MeetingNote, MeetingPack, TaskCard, UserBrief } from "@/lib/types";

/**
 * The meeting as slides. A fixed 16:9 stage (letterboxed on a laptop, edge to
 * edge on a projector) and every measurement in cqw — 1cqw = 1% of the slide
 * width — so the proportions never change with the screen. One slide per
 * section: cover, each app (releases, then tasks), work that spans apps,
 * approvals, minutes, carried forward. A section's table scrolls inside its
 * panel under a sticky header instead of splitting into "1 / 2" slides, and
 * the app strip at the bottom jumps straight to any section.
 */
type Pack = MeetingPack & { workspace_name: string };
type Release = MeetingPack["releases"][number];

const fmtDay = (iso: string) => istTime(iso).replace(/, \d\d:\d\d(:\d\d)? (am|pm) IST$/, "");
const fmtWhen = (iso: string) => istTime(iso).replace(/:\d\d (am|pm) IST$/, " $1");
const ymdPretty = (ymd: string) => new Date(ymd + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const NOTES_SHOWN_PER_TASK = 3;

/* Projector-safe status colours: solid fills, white type, no two alike. */
const DECK_STATUS: Record<TaskStatus, string> = {
  todo: "bg-slate-600 text-white",
  in_progress: "bg-blue-600 text-white",
  in_review: "bg-violet-600 text-white",
  on_hold: "bg-amber-500 text-white",
  partial: "bg-teal-600 text-white",
  done: "bg-emerald-600 text-white",
  cancelled: "bg-red-600 text-white",
};
const DECK_RELEASE: Record<ReleaseStatus, string> = {
  planned: "bg-slate-600 text-white",
  in_progress: "bg-blue-600 text-white",
  testing: "bg-amber-500 text-white",
  submitted: "bg-violet-600 text-white",
  released: "bg-emerald-600 text-white",
  rolled_back: "bg-orange-600 text-white",
  cancelled: "bg-red-600 text-white",
};
const RELEASE_ACCENT: Record<ReleaseStatus, string> = {
  planned: "#475569",
  in_progress: "#2563eb",
  testing: "#f59e0b",
  submitted: "#7c3aed",
  released: "#059669",
  rolled_back: "#ea580c",
  cancelled: "#dc2626",
};

interface Slide {
  key: string;
  render: (n: number, total: number) => React.ReactNode;
  /** Listed in the "jump to" panel and the app strip. */
  jump?: { label: string; icon?: { name: string; color: string; iconUrl: string | null }; sub?: string; short?: string; kind?: "cover" | "general" | "shared" | "approvals" | "minutes" | "next" };
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

/** The scrolling panel of the slide on screen, if it can scroll. */
function activePanel(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>("section.deck-slide:not(.opacity-0) [data-deck-scroll]");
  return el && el.scrollHeight > el.clientHeight + 2 ? el : null;
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
  const [jumpOpen, setJumpOpen] = useState(false);
  const idleTimer = useRef(0);
  const wake = useCallback(() => {
    setChrome(true);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setChrome(false), 3000);
  }, []);
  useEffect(() => {
    idleTimer.current = window.setTimeout(() => setChrome(false), 3000);
    return () => window.clearTimeout(idleTimer.current);
  }, []);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // A focused control keeps Space/Enter for itself ("Show more", the jump grid, the toolbar).
      const el = e.target as HTMLElement | null;
      if (e.key === " " && el && el.closest("button, a, input, textarea, select, [role=button]")) return;
      switch (e.key) {
        case "ArrowDown":
        case "ArrowUp": {
          // Up/down scroll a long section first; at its end they turn the slide.
          const panel = activePanel();
          if (panel) {
            const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 2;
            const atTop = panel.scrollTop <= 0;
            if (e.key === "ArrowDown" && !atBottom) {
              e.preventDefault();
              panel.scrollBy({ top: panel.clientHeight * 0.8, behavior: "smooth" });
              return;
            }
            if (e.key === "ArrowUp" && !atTop) {
              e.preventDefault();
              panel.scrollBy({ top: -panel.clientHeight * 0.8, behavior: "smooth" });
              return;
            }
          }
          e.preventDefault();
          (e.key === "ArrowDown" ? next : prev)();
          break;
        }
        case "ArrowRight":
        case " ":
        case "PageDown":
          e.preventDefault();
          next();
          break;
        case "ArrowLeft":
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
          if (jumpOpen) setJumpOpen(false);
          else if (!document.fullscreenElement) exit();
          break;
        case "a":
        case "A":
        case "j":
        case "J":
          setJumpOpen((o) => !o);
          break;
        default: {
          // 1–9 jump to the nth section of the strip.
          if (/^[1-9]$/.test(e.key)) {
            const jumps = slides.map((s, i) => (s.jump ? i : -1)).filter((i) => i >= 0);
            const target = jumps[Number(e.key) - 1];
            if (target !== undefined) go(target);
          }
        }
      }
    };
    const onAny = (e: KeyboardEvent) => {
      wake();
      onKey(e);
    };
    window.addEventListener("keydown", onAny);
    return () => window.removeEventListener("keydown", onAny);
  }, [next, prev, go, last, exit, toggleFullscreen, wake, jumpOpen, slides]);

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
          <section key={s.key} className={cn("deck-slide absolute inset-0 flex flex-col transition-opacity duration-200", i === index ? "opacity-100" : "pointer-events-none opacity-0")} aria-hidden={i !== index} inert={i !== index ? true : undefined}>
            {s.render(i + 1, total)}
          </section>
        ))}
        {/* Thin edge strips inside the slide's side padding — they never sit over content. */}
        <button type="button" onClick={prev} className="deck-chrome absolute inset-y-[12%] left-0 w-[3%] opacity-0" aria-label="Previous slide" tabIndex={-1} />
        <button type="button" onClick={next} className="deck-chrome absolute inset-y-[12%] right-0 w-[3%] opacity-0" aria-label="Next slide" tabIndex={-1} />
      </div>

      {/* Controls live outside the stage so they never print or cover content. */}
      <div className={cn("deck-chrome absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-xl border border-white/10 bg-[#1f1f1c]/90 p-0.5 text-white/70 backdrop-blur transition-opacity duration-300", !chrome && "pointer-events-none opacity-0")}>
        <button type="button" onClick={() => setJumpOpen((o) => !o)} className={cn("rounded-lg p-2 hover:bg-white/10 hover:text-white", jumpOpen && "bg-white/15 text-white")} aria-label="Jump to a section" title="Jump to a section (a)">
          <IconApps size={17} />
        </button>
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
      {/* Dock: every section one tap away — app tiles with their names, the current one lit. */}
      <nav className={cn("deck-chrome absolute bottom-1.5 left-1/2 z-10 max-w-[96vw] -translate-x-1/2 transition-opacity duration-300", !chrome && "pointer-events-none opacity-0")} aria-label="Sections">
        <div className="flex items-stretch gap-1 rounded-2xl border border-white/10 bg-[#1f1f1c]/95 p-1 text-white/70 shadow-[0_12px_40px_rgba(0,0,0,0.5)] backdrop-blur">
          <button type="button" onClick={prev} disabled={index === 0} className="flex w-8 shrink-0 items-center justify-center rounded-xl hover:bg-white/10 hover:text-white disabled:opacity-30" aria-label="Previous slide">
            <IconChevronLeft size={16} />
          </button>
          <div className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto no-scrollbar">
            {jumps.map(({ s, i }, k) => {
              const on = i === currentJump;
              const j = s.jump!;
              return (
                <button key={s.key} type="button" onClick={() => go(i)} title={`${j.label}${j.sub ? ` · ${j.sub}` : ""}${k < 9 ? ` (${k + 1})` : ""}`} aria-current={on ? "step" : undefined} className={cn("flex w-[66px] shrink-0 flex-col items-center gap-[3px] rounded-xl px-1 py-1 transition-colors", on ? "bg-white text-[#141412]" : "hover:bg-white/10 hover:text-white")}>
                  {j.icon ? (
                    <AppTile name={j.icon.name} color={j.icon.color} iconUrl={j.icon.iconUrl} className="h-5 w-5 rounded-md text-[8px]" />
                  ) : (
                    <span className={cn("flex h-5 w-5 items-center justify-center rounded-md text-[9px] font-bold", on ? "bg-[#141412]/10 text-[#141412]" : "bg-white/15 text-white", j.kind === "shared" && "bg-teal-700 text-white", j.kind === "general" && "bg-slate-500 text-white")}>
                      {j.kind === "cover" ? <Mark className="h-4 w-4" /> : j.kind === "shared" ? "⇄" : j.kind === "general" ? "G" : j.kind === "approvals" ? <IconUserCheck size={12} /> : j.kind === "minutes" ? <IconMessage size={12} /> : <IconArrowRight size={12} />}
                    </span>
                  )}
                  <span className="line-clamp-2 w-full text-center text-[9.5px] font-medium leading-[1.1]">{j.short ?? j.label}</span>
                </button>
              );
            })}
          </div>
          <span className="flex shrink-0 items-center whitespace-nowrap px-1.5 text-[11px] tabular-nums text-white/60">
            {index + 1} / {total}
          </span>
          <button type="button" onClick={next} disabled={index === last} className="flex w-8 shrink-0 items-center justify-center rounded-xl hover:bg-white/10 hover:text-white disabled:opacity-30" aria-label="Next slide">
            <IconChevronRight size={16} />
          </button>
        </div>
      </nav>
    </div>
  );
}

/* ------------------------------- slides ----------------------------------- */

function buildSlides(p: Pack): Slide[] {
  const slides: Slide[] = [];
  const m = p.meeting;
  const agenda = buildAgenda(p, { dedupe: true });
  const notes = notesByTask(p.notes);
  const labels = nameLabels(packPeople(p));
  const appMeta = new Map(p.apps.map((a) => [a.id, a]));
  const windowText = p.previous_meeting ? `${fmtDay(p.previous_meeting)} – ${fmtDay(m.held_at)}` : `7 days to ${fmtDay(m.held_at)}`;
  const frame = (n: number, total: number) => ({ meeting: m, workspace: p.workspace_name, n, total });
  const statusesUsed = new Set<TaskStatus>([...p.pending, ...p.done].map((t) => t.status));

  /* Cover: title and the headline figures across the top; the agenda and the
     meeting's facts beneath — the shape of a report's first page. */
  const scopeTiles = m.app_ids?.length ? p.apps : [];
  slides.push({
    key: "cover",
    jump: { label: "Cover", sub: m.title, short: "Cover", kind: "cover" },
    render: (n, total) => (
      <Frame {...frame(n, total)} bare>
        <div className="flex min-h-0 flex-1 flex-col">
          <header className="flex items-end justify-between gap-[3cqw] border-b border-line pb-[1.5cqw]">
            <div className="min-w-0">
              <p className="text-[1.05cqw] font-semibold uppercase tracking-[0.22em] text-ink-subtle">Minutes of meeting{p.series ? ` · ${p.series.name}` : ""}</p>
              <h1 className="mt-[0.7cqw] max-w-[60cqw] break-words text-[3.2cqw] font-bold leading-[1.08] tracking-[-0.03em] text-ink [text-wrap:balance]">{m.title}</h1>
              <p className="mt-[0.7cqw] text-[1.25cqw] text-ink-muted">
                Held {fmtWhen(m.held_at)} IST · covering {windowText}
                {m.status === "finalized" ? " · closed, minutes locked" : " · open, live figures"}
              </p>
            </div>
            <div className="flex shrink-0 gap-[0.7cqw]">
              <Tile n={p.done.length} label="Done" tone="emerald" />
              <Tile n={p.pending.length} label="Pending" />
              <Tile n={p.carried.length} label="Carried" tone={p.carried.length ? "amber" : undefined} />
              <Tile n={p.overdue.length} label="Overdue" tone={p.overdue.length ? "red" : undefined} />
            </div>
          </header>
          <div className="mt-[1.5cqw] grid min-h-0 flex-1 grid-cols-[1.3fr_1fr] gap-[2cqw]">
            <div className={PANEL_SCROLL} data-deck-scroll>
              <p className={cn(PANEL_LABEL, "sticky top-0 z-[1]")}>Agenda · {agenda.length} section{agenda.length === 1 ? "" : "s"}</p>
              {agenda.length === 0 ? (
                <p className="px-[1.3cqw] py-[1.2cqw] text-[1.25cqw] text-ink-muted">Nothing changed since the last meeting.</p>
              ) : (
                <ol className="divide-y divide-line/70 px-[1.3cqw]">
                  {agenda.map((g, i) => (
                    <li key={g.key} className={cn("flex items-center gap-[0.9cqw] text-ink", agenda.length > 8 ? "py-[0.5cqw] text-[1.1cqw]" : "py-[0.75cqw] text-[1.25cqw]")}>
                      <span className="w-[1.6cqw] shrink-0 text-right text-[0.95cqw] tabular-nums text-ink-subtle">{i + 1}</span>
                      <GroupTile g={g} className={agenda.length > 8 ? "h-[1.9cqw] w-[1.9cqw] rounded-[0.45cqw] text-[0.8cqw]" : "h-[2.2cqw] w-[2.2cqw] rounded-[0.5cqw] text-[0.9cqw]"} />
                      <span className="min-w-0 flex-1 break-words font-semibold leading-tight">{g.name}</span>
                      <span className="flex shrink-0 items-center gap-[0.5cqw] tabular-nums">
                        {g.done.length > 0 && <span className={cn(BADGE_SM, "bg-emerald-600 text-white")}>{g.done.length} done</span>}
                        {g.pending.length > 0 && <span className={cn(BADGE_SM, "bg-slate-200 text-slate-800")}>{g.pending.length} open</span>}
                        {g.releases.length > 0 && <span className={cn(BADGE_SM, "bg-ink text-white")}>{g.releases.length} rel</span>}
                        {!g.done.length && !g.pending.length && !g.releases.length && <span className="text-[1cqw] text-ink-subtle">—</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="flex min-h-0 flex-col gap-[1.2cqw]">
              <div className={PANEL}>
                <p className={PANEL_LABEL}>Scope</p>
                <div className="px-[1.3cqw] py-[1cqw]">
                  {scopeTiles.length ? (
                    <div className="flex flex-wrap gap-[0.5cqw]" title={scopeTiles.map((a) => a.name).join(", ")}>
                      {scopeTiles.map((a) => (
                        <AppTile key={a.id} name={a.name} color={a.color} iconUrl={a.icon_url} className="h-[2.4cqw] w-[2.4cqw] rounded-[0.55cqw] text-[0.95cqw]" />
                      ))}
                    </div>
                  ) : (
                    <p className="text-[1.2cqw] text-ink">Every app</p>
                  )}
                  <p className="mt-[0.6cqw] text-[1.05cqw] text-ink-muted">
                    {scopeTiles.length ? `${scopeTiles.length} app${scopeTiles.length === 1 ? "" : "s"}` : `${p.apps.length} app${p.apps.length === 1 ? "" : "s"}`} · {p.people.length} {p.people.length === 1 ? "person" : "people"}
                    {p.releases.length ? ` · ${p.releases.length} release${p.releases.length === 1 ? "" : "s"}` : ""}
                  </p>
                </div>
              </div>
              <div className={PANEL}>
                <p className={PANEL_LABEL}>Status colours</p>
                <div className="flex flex-wrap gap-[0.5cqw] px-[1.3cqw] py-[1cqw]">
                  {TASK_STATUSES.filter((st) => statusesUsed.has(st) || st === "done" || st === "in_progress" || st === "todo").map((st) => (
                    <span key={st} className={cn(BADGE, DECK_STATUS[st])}>{STATUS_META[st].label}</span>
                  ))}
                </div>
              </div>
              <div className={cn(PANEL, "flex-1")}>
                <p className={PANEL_LABEL}>How to read</p>
                <ul className="flex flex-col gap-[0.45cqw] px-[1.3cqw] py-[1cqw] text-[1.05cqw] leading-snug text-ink-muted">
                  <li>One section per app: its releases, then every task — done first, then in progress, then waiting.</li>
                  <li>Work on several apps sits under <b className="text-ink">Across apps</b> with where each one stands.</li>
                  <li>Carried = still open from an earlier meeting of this series.</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </Frame>
    ),
  });

  /* One section per app: releases first, then every task on one scrolling slide. */
  for (const g of agenda) {
    const shared = g.key === SHARED_KEY;
    const meta = appMeta.get(g.key);
    const app = { group: g, platforms: meta ? { android: meta.has_android, ios: meta.has_ios } : undefined };
    const jump = { label: g.name, icon: shared || g.key === "general" ? undefined : { name: g.name, color: g.color, iconUrl: g.iconUrl }, short: shared ? "Across apps" : g.key === "general" ? "General" : undefined, kind: shared ? ("shared" as const) : g.key === "general" ? ("general" as const) : undefined, sub: `${g.pending.length} open · ${g.done.length} done${g.releases.length ? ` · ${g.releases.length} release${g.releases.length === 1 ? "" : "s"}` : ""}` };
    let jumped = false;
    if (g.releases.length) {
      slides.push({
        key: `rel-${g.key}`,
        jump: ((jumped = true), jump),
        render: (n, total) => (
          <Frame {...frame(n, total)} app={app} section="Releases" part={`${g.releases.length} version${g.releases.length === 1 ? "" : "s"}`}>
            <ReleaseCards releases={g.releases} />
          </Frame>
        ),
      });
    }
    const rows: { t: TaskCard; done: boolean }[] = deckRows(g).map((t) => ({ t, done: t.status === "done" }));
    if (!rows.length) continue;
    slides.push({
      key: `app-${g.key}`,
      jump: jumped ? undefined : ((jumped = true), jump),
      render: (n, total) => (
        <Frame {...frame(n, total)} app={app} section={shared ? undefined : "Tasks"} title={shared ? "Across apps" : undefined} subtitle={shared ? "Work that ships on more than one app — where each one stands" : undefined} part={`${rows.length} task${rows.length === 1 ? "" : "s"}`}>
          <TaskTable rows={rows} notes={notes} labels={labels} currentApp={shared ? undefined : g.key} matrix={shared} />
        </Frame>
      ),
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
    slides.push({
      key: "approvals",
      jump: { label: "Awaiting approval", short: "Approvals", kind: "approvals", sub: `${p.approvals.length} request${p.approvals.length === 1 ? "" : "s"}` },
      render: (n, total) => (
        <Frame {...frame(n, total)} title="Awaiting approval" subtitle={`${p.approvals.length} status change${p.approvals.length === 1 ? "" : "s"} waiting for an admin`}>
          <TaskTable rows={p.approvals.map((t) => ({ t, done: false }))} notes={notes} labels={labels} showApp />
        </Frame>
      ),
    });
  }

  /* Minutes: every note, in the order it was written, plus the general remarks. */
  const minutes = [...p.notes].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (minutes.length || m.notes) {
    slides.push({
      key: "minutes",
      jump: { label: "Minutes", short: "Minutes", kind: "minutes", sub: `${minutes.length} note${minutes.length === 1 ? "" : "s"}` },
      render: (n, total) => (
        <Frame {...frame(n, total)} title="Minutes" subtitle="Decisions, action items, blockers and notes recorded in this meeting" part={minutes.length ? `${minutes.length} note${minutes.length === 1 ? "" : "s"}` : undefined}>
          {m.notes && (
            <div className="mb-[1.2cqw] shrink-0 rounded-[0.8cqw] border border-line bg-surface px-[1.6cqw] py-[1.1cqw]">
              <p className="mb-[0.4cqw] text-[0.95cqw] font-semibold uppercase tracking-[0.18em] text-ink-subtle">Agenda & remarks</p>
              <p className="whitespace-pre-wrap break-words text-[1.3cqw] leading-relaxed text-ink">{m.notes}</p>
            </div>
          )}
          {minutes.length > 0 && <MinutesTable notes={minutes} labels={labels} />}
        </Frame>
      ),
    });
  }

  /* Next steps: everything still open, in the same table as the app slides. */
  const carried = [...p.pending].sort((a, b) => (b.carry ?? 0) - (a.carry ?? 0) || a.number - b.number);
  slides.push({
    key: "end",
    jump: { label: "Next steps", short: "Next steps", kind: "next", sub: `${p.pending.length} open` },
    render: (n, total) => (
      <Frame
        {...frame(n, total)}
        title="Next steps"
        subtitle={carried.length ? `${carried.length} open task${carried.length === 1 ? "" : "s"} carr${carried.length === 1 ? "ies" : "y"} into the next meeting${p.overdue.length ? ` · ${p.overdue.length} already past due` : ""}${p.carried.length ? ` · ${p.carried.length} carried before` : ""}` : "Nothing carries forward — everything is closed."}
        tiles={
          <>
            <Tile n={carried.length} label="Open" />
            <Tile n={p.carried.length} label="Carried" tone={p.carried.length ? "amber" : undefined} />
            <Tile n={p.overdue.length} label="Overdue" tone={p.overdue.length ? "red" : undefined} />
          </>
        }
      >
        {carried.length > 0 ? (
          <TaskTable rows={carried.map((t) => ({ t, done: false }))} notes={notes} labels={labels} showApp />
        ) : (
          <div className={cn(PANEL, "flex flex-1 items-center justify-center px-[2cqw] py-[3cqw] text-center")}>
            <p className="text-[2cqw] font-semibold text-emerald-700">Everything is closed. Nice work.</p>
          </div>
        )}
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

/** An app's tile, or a lettered tile for General / Across apps. */
function GroupTile({ g, className }: { g: AgendaGroup; className?: string }) {
  if (g.key === SHARED_KEY) return <span className={cn("flex shrink-0 items-center justify-center rounded-xl bg-teal-700 font-bold text-white ring-1 ring-inset ring-black/10", className)} aria-hidden>⇄</span>;
  return <AppTile name={g.name} color={g.color} iconUrl={g.iconUrl} className={className} />;
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
  tiles,
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
  /** Figures beside a plain title (the app heading has its own). */
  tiles?: React.ReactNode;
  children: React.ReactNode;
}) {
  const g = app?.group;
  const appHeading = g && !title;
  return (
    <>
      {/* Title band */}
      <div className="flex h-[4.6cqw] shrink-0 items-center justify-between bg-[#1c1c1a] px-[4cqw] text-[1.05cqw] text-white/60">
        <span className="inline-flex min-w-0 items-center gap-[0.8cqw]">
          <Mark className="h-[1.9cqw] w-[1.9cqw] text-white" />
          <span className="truncate font-semibold text-white/90">{meeting.title}</span>
          {!meeting.title.includes(fmtDay(meeting.held_at)) && <span className="shrink-0">· {fmtDay(meeting.held_at)}</span>}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-[4cqw] pb-[2.2cqw] pt-[2cqw]">
        {/* Slide heading */}
        {!bare && (
          <header className="flex shrink-0 items-center gap-[1.4cqw]">
            {appHeading ? (
              <>
                <GroupTile g={g} className="h-[5.4cqw] w-[5.4cqw] rounded-[1.1cqw] text-[2cqw] shadow-xs ring-1 ring-black/5" />
                <div className="min-w-0 flex-1">
                  <h2 className="flex flex-wrap items-baseline gap-x-[0.8cqw] text-[2.7cqw] font-bold leading-[1.1] tracking-[-0.02em] text-ink">
                    <span className="break-words">{g.name}</span>
                    {section && <span className="font-medium text-ink-subtle">{section}</span>}
                    {part && <span className="text-[1.2cqw] font-medium text-ink-subtle">{part}</span>}
                  </h2>
                  {app?.platforms && (
                    <p className="mt-[0.6cqw] flex items-center gap-[1.2cqw] text-[1.15cqw] text-ink-muted">
                      {app.platforms.android && (
                        <span className="inline-flex items-center gap-[0.4cqw]">
                          <PlatformGlyph platform="android" size={14} className="[&>svg]:h-[1.3cqw] [&>svg]:w-[1.3cqw]" /> Android
                        </span>
                      )}
                      {app.platforms.ios && (
                        <span className="inline-flex items-center gap-[0.4cqw]">
                          <PlatformGlyph platform="ios" size={14} className="[&>svg]:h-[1.3cqw] [&>svg]:w-[1.3cqw]" /> iOS
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
              <>
                {g && <GroupTile g={g} className="h-[5.4cqw] w-[5.4cqw] rounded-[1.1cqw] text-[2.4cqw] shadow-xs ring-1 ring-black/5" />}
                <div className="min-w-0 flex-1">
                  <h2 className="text-[2.7cqw] font-bold leading-[1.1] tracking-[-0.02em] text-ink">
                    {title}
                    {part && <span className="ml-[0.8cqw] text-[1.2cqw] font-medium text-ink-subtle">{part}</span>}
                  </h2>
                  {subtitle && <p className="mt-[0.6cqw] text-[1.15cqw] text-ink-muted">{subtitle}</p>}
                </div>
                {g ? (
                  <div className="flex shrink-0 gap-[0.6cqw]">
                    <Tile n={g.pending.length} label="Pending" />
                    <Tile n={g.overdue} label="Overdue" tone={g.overdue ? "red" : undefined} />
                    <Tile n={g.done.length} label="Done" tone="emerald" />
                  </div>
                ) : tiles ? (
                  <div className="flex shrink-0 gap-[0.6cqw]">{tiles}</div>
                ) : null}
              </>
            )}
          </header>
        )}

        {/* Content panel */}
        <div className={cn("flex min-h-0 flex-1 flex-col", !bare && "mt-[1.5cqw]")}>{children}</div>

        {/* Footer */}
        <div className="mt-[1.2cqw] flex shrink-0 items-center justify-between border-t border-line pt-[0.8cqw] text-[0.95cqw] text-ink-subtle">
          <span>{workspace}</span>
          <span>
            Minutes of meeting · FactoTasks · <span className="tabular-nums">{n} / {total}</span>
          </span>
        </div>
      </div>
    </>
  );
}

function Tile({ n, label, tone }: { n: number; label: string; tone?: "emerald" | "amber" | "red" | "ink" }) {
  const cls = {
    emerald: "bg-emerald-600 text-white ring-emerald-600",
    amber: "bg-amber-500 text-white ring-amber-500",
    red: "bg-red-600 text-white ring-red-600",
    ink: "bg-ink text-white ring-ink",
    none: "bg-surface text-ink ring-line",
  }[tone ?? "none"];
  return (
    <div className={cn("min-w-[6cqw] rounded-[0.8cqw] px-[1cqw] py-[0.7cqw] text-center ring-1 ring-inset", cls)}>
      <div className="text-[2.2cqw] font-bold leading-none tabular-nums tracking-[-0.02em]">{n}</div>
      <div className={cn("mt-[0.45cqw] text-[0.8cqw] font-semibold uppercase tracking-[0.14em]", tone ? "text-white/80" : "text-ink-subtle")}>{label}</div>
    </div>
  );
}

/* Table styling shared by every content slide */
const PANEL = "overflow-hidden rounded-[1cqw] border border-line bg-surface shadow-[0_1px_0_rgba(0,0,0,0.02)]";
const TH = "bg-canvas px-[1.3cqw] py-[0.9cqw] text-left text-[0.95cqw] font-semibold uppercase tracking-[0.16em] text-ink-subtle";
/* Same look as a table header, for a panel caption that is not a <th>. */
const PANEL_SCROLL = PANEL.replace("overflow-hidden", "min-h-0 max-h-full overflow-y-auto overflow-x-hidden overscroll-contain");
const PANEL_LABEL = "block border-b border-line/70 " + TH;
const TD = "px-[1.3cqw] py-[1.1cqw] align-top text-[1.35cqw] leading-snug";
const BADGE = "inline-flex items-center whitespace-nowrap rounded-full px-[1cqw] py-[0.4cqw] text-[1.05cqw] font-bold leading-none";
const BADGE_SM = "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-[0.8cqw] py-[0.3cqw] text-[0.95cqw] font-bold leading-none";

function DeckAvatar({ u, className }: { u: UserBrief; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold uppercase text-white", className)} style={{ backgroundColor: u.color || "#64748b", width: "1.9cqw", height: "1.9cqw", fontSize: "0.75cqw" }} aria-hidden>
      {nameInitials(u.first_name, u.last_name, u.email || u.name)}
    </span>
  );
}

/** Avatars with first names — several owners read as a row of chips, not a comma soup. */
function Owners({ users, labels, compact }: { users: UserBrief[]; labels: Map<string, string>; compact?: boolean }) {
  if (!users.length) return <span className="text-ink-subtle">Unassigned</span>;
  if (compact) {
    return (
      <span className="inline-flex shrink-0 items-center gap-[0.4cqw]" title={users.map((u) => u.name).join(", ")}>
        <span className="inline-flex items-center -space-x-[0.4cqw]">
          {users.slice(0, 3).map((u) => (
            <DeckAvatar key={u.id} u={u} className="ring-[0.15cqw] ring-surface" />
          ))}
        </span>
        <span className="text-[1.05cqw] text-ink-muted">{users.length > 1 ? `${ownerText([users[0]], labels)} +${users.length - 1}` : ownerText(users, labels)}</span>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-[0.4cqw]">
      {users.map((u) => (
        <span key={u.id} className="inline-flex items-center gap-[0.4cqw] rounded-full bg-canvas py-[0.2cqw] pl-[0.2cqw] pr-[0.7cqw] text-[1.05cqw] font-medium text-ink ring-1 ring-inset ring-line" title={u.name}>
          <DeckAvatar u={u} />
          {labels.get(u.id) ?? u.name.split(" ")[0]}
        </span>
      ))}
    </span>
  );
}

/** Where a task ships, app by app: one row per app, a fixed column per platform so the chips line up. */
function ShipMatrix({ t }: { t: TaskCard }) {
  const rows = targetMatrix(t);
  if (!rows.length) return <span className="text-ink-subtle">—</span>;
  const cell = (x: TaskCard["targets"][number] | undefined, platform: "android" | "ios") => {
    if (!x) return <span className="flex h-[2.3cqw] items-center justify-center rounded-[0.5cqw] border border-dashed border-line text-[0.9cqw] text-ink-subtle/60" aria-label={`Not on ${PLATFORM_META[platform].label}`}>—</span>;
    const tone = x.released_at ? "bg-emerald-600 text-white ring-emerald-600" : x.release ? "bg-amber-50 text-amber-800 ring-amber-300" : "bg-canvas text-ink-muted ring-line";
    const text = x.released_at ? "Released" : x.release ? `v${x.release.version_name}` : "Pending";
    return (
      <span className={cn("flex h-[2.3cqw] items-center justify-center gap-[0.4cqw] rounded-[0.5cqw] px-[0.5cqw] text-[0.95cqw] font-bold leading-none ring-1 ring-inset", tone)} title={`${PLATFORM_META[platform].label}: ${x.released_at ? `released in v${x.release?.version_name ?? ""}` : x.release ? `in v${x.release.version_name} (${RELEASE_STATUS_META[x.release.status].label})` : "no release yet"}`}>
        <PlatformGlyph platform={platform} size={10} className={cn("[&>svg]:h-[1cqw] [&>svg]:w-[1cqw]", x.released_at && "[&_svg]:text-white")} />
        <span className="truncate">{text}</span>
      </span>
    );
  };
  return (
    <div className="flex flex-col gap-[0.4cqw]">
      <div className="grid grid-cols-[minmax(0,1fr)_7.2cqw_7.2cqw] gap-x-[0.5cqw] text-[0.8cqw] font-semibold uppercase tracking-[0.12em] text-ink-subtle">
        <span />
        <span className="text-center">Android</span>
        <span className="text-center">iOS</span>
      </div>
      {rows.map(({ app, items }) => (
        <div key={app.id} className="grid grid-cols-[minmax(0,1fr)_7.2cqw_7.2cqw] items-center gap-x-[0.5cqw]">
          <span className="flex min-w-0 items-center gap-[0.5cqw]">
            <AppTile name={app.name} color={app.color} iconUrl={app.icon_url} className="h-[1.9cqw] w-[1.9cqw] rounded-[0.45cqw] text-[0.8cqw]" />
            <span className="min-w-0 break-words text-[1.1cqw] font-medium leading-tight text-ink">{app.name}</span>
          </span>
          {cell(items.find((x) => x.platform === "android"), "android")}
          {cell(items.find((x) => x.platform === "ios"), "ios")}
        </div>
      ))}
    </div>
  );
}

function TaskTable({
  rows,
  notes,
  labels,
  currentApp,
  showApp,
  matrix,
}: {
  rows: { t: TaskCard; done: boolean }[];
  notes: Map<string, MeetingNote[]>;
  labels: Map<string, string>;
  /** The app this slide belongs to: the task's platforms on it are shown. */
  currentApp?: string;
  showApp?: boolean;
  /** "Across apps": a column with every app and platform the task ships on. */
  matrix?: boolean;
}) {
  return (
    <div className={PANEL_SCROLL} data-deck-scroll>
      <table className="w-full border-collapse">
        <colgroup>
          <col style={{ width: "6%" }} />
          {showApp && <col style={{ width: "15%" }} />}
          <col />
          {matrix && <col style={{ width: "30%" }} />}
          <col style={{ width: matrix ? "15%" : "19%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "12%" }} />
        </colgroup>
        <thead className="sticky top-0 z-[1] bg-surface shadow-[0_1px_0_rgba(0,0,0,0.06)]">
          <tr>
            <th className={TH}>#</th>
            {showApp && <th className={TH}>App</th>}
            <th className={TH}>Task</th>
            {matrix && <th className={TH}>Ships on</th>}
            <th className={TH}>Owner</th>
            <th className={TH}>Due</th>
            <th className={cn(TH, "text-right")}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ t, done }) => {
            const taskNotes = notes.get(t.id) || [];
            const desc = t.description?.trim();
            const due = dueInfo(t.due_date, t.status);
            const plats = currentApp ? platformsOn(t, currentApp) : [];
            const apps = showApp ? targetMatrix(t).map((x) => x.app) : [];
            return (
              <tr key={t.id} className="border-b border-line/70 last:border-b-0">
                <td className={cn(TD, "tabular-nums text-ink-subtle")}>{taskRef(t.number)}</td>
                {showApp && (
                  <td className={cn(TD, "text-ink-muted")}>
                    {apps.length ? (
                      <span className="flex flex-wrap items-center gap-[0.5cqw]">
                        {apps.map((a) => (
                          <span key={a.id} className="inline-flex items-center gap-[0.4cqw]" title={a.name}>
                            <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className="h-[1.8cqw] w-[1.8cqw] rounded-[0.4cqw] text-[0.8cqw]" />
                            {apps.length === 1 && <span className="break-words">{a.name}</span>}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-ink-subtle">General</span>
                    )}
                  </td>
                )}
                <td className={cn(TD, "pr-[1.6cqw]")}>
                  <div className="flex flex-wrap items-center gap-x-[0.8cqw] gap-y-[0.35cqw]">
                    <span className={cn("break-words font-semibold", done ? "text-ink-muted" : "text-ink")}>{t.title}</span>
                    {plats.length > 0 && (
                      <span className="inline-flex items-center gap-[0.5cqw] text-[1.05cqw] text-ink-subtle">
                        {plats.map((pl) => (
                          <span key={pl} className="inline-flex items-center gap-[0.25cqw]">
                            <PlatformGlyph platform={pl} size={12} className="[&>svg]:h-[1.1cqw] [&>svg]:w-[1.1cqw]" />
                            {PLATFORM_META[pl].label}
                          </span>
                        ))}
                      </span>
                    )}
                    {typeof t.carry === "number" && t.carry > 0 && <CarryChip carry={t.carry} />}
                    {t.pinned && <span className="shrink-0 rounded-full bg-canvas px-[0.7cqw] py-[0.15cqw] text-[0.95cqw] font-semibold text-ink-muted ring-1 ring-inset ring-line">Pinned</span>}
                  </div>
                  <ClampedText text={desc} lines={2} className="mt-[0.4cqw] text-[1.15cqw] leading-snug text-ink-muted" buttonClassName="text-[1.05cqw]" moreLabel="Show more" lessLabel="Show less" />
                  {t.requested_status && <p className="mt-[0.4cqw] text-[1.1cqw] font-medium text-amber-700">Asked to move to {STATUS_META[t.requested_status].label} — awaiting approval</p>}
                  {taskNotes.length > 0 && (
                    <ul className="mt-[0.8cqw] flex flex-col gap-[0.5cqw] border-l-[0.25cqw] border-line pl-[1cqw]">
                      {taskNotes.slice(0, NOTES_SHOWN_PER_TASK).map((x) => (
                        <li key={x.id} className="flex items-start gap-[0.7cqw] text-[1.15cqw] leading-snug text-ink">
                          <NoteKind kind={x.kind} />
                          <span className="min-w-0 whitespace-pre-wrap break-words">{x.body}</span>
                        </li>
                      ))}
                      {taskNotes.length > NOTES_SHOWN_PER_TASK && <li className="text-[1.05cqw] text-ink-subtle">+ {taskNotes.length - NOTES_SHOWN_PER_TASK} more in the minutes</li>}
                    </ul>
                  )}
                </td>
                {matrix && (
                  <td className={TD}>
                    <ShipMatrix t={t} />
                  </td>
                )}
                <td className={cn(TD, "text-ink-muted")}>
                  <Owners users={t.assignees} labels={labels} />
                </td>
                <td className={cn(TD, "tabular-nums", due?.tone === "danger" ? "font-semibold text-red-600" : due?.tone === "warning" ? "font-semibold text-amber-700" : "text-ink-muted")}>{t.due_date ? ymdPretty(t.due_date) : <span className="text-ink-subtle">—</span>}</td>
                <td className={cn(TD, "text-right")}>
                  <span className={cn(BADGE, DECK_STATUS[t.status])}>{STATUS_META[t.status].label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Releases as version cards, nothing like the task table: a tinted header
 * says which version, on which platform, in which state and when; the body
 * lists what it ships (title AND description, in full) and the release notes.
 * Cards take the height they need and the column scrolls when there are several.
 */
function ReleaseCards({ releases }: { releases: Release[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[1.1cqw] overflow-y-auto overscroll-contain pr-[0.3cqw]" data-deck-scroll>
      {releases.map((r) => {
        const released = r.status === "released";
        const when = released && r.released_at ? `Released ${fmtDay(r.released_at)}` : r.planned_date ? `Release date ${ymdPretty(r.planned_date)}` : "No release date yet";
        const count = r.tasks?.length ?? 0;
        return (
          <article key={r.id} className="shrink-0 overflow-hidden rounded-[1cqw] border border-line bg-surface shadow-[0_1px_0_rgba(0,0,0,0.02)]">
            <header className="flex items-center gap-[1.2cqw] border-b border-line/70 px-[1.6cqw] py-[1.1cqw]" style={{ background: `linear-gradient(90deg, ${RELEASE_ACCENT[r.status]}1a, transparent 60%)`, boxShadow: `inset 0.45cqw 0 0 ${RELEASE_ACCENT[r.status]}` }}>
              <span className="flex h-[3.6cqw] w-[3.6cqw] shrink-0 items-center justify-center rounded-[0.8cqw] bg-surface ring-1 ring-inset ring-line">
                <PlatformGlyph platform={r.platform} size={20} className="[&>svg]:h-[2cqw] [&>svg]:w-[2cqw]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-[0.8cqw] text-[2.1cqw] font-bold leading-none tracking-[-0.02em] text-ink">
                  <span className="tabular-nums">v{r.version_name}</span>
                  {r.build_number && <span className="text-[1.1cqw] font-medium text-ink-subtle">build {r.build_number}</span>}
                  <span className="text-[1.2cqw] font-medium text-ink-muted">{PLATFORM_META[r.platform].label}</span>
                </p>
                <p className="mt-[0.5cqw] text-[1.1cqw] text-ink-muted">
                  {when}
                  {count ? ` · ${count} task${count === 1 ? "" : "s"} ${released ? "shipped" : "planned"} in this version` : " · no tasks linked"}
                </p>
              </div>
              <span className={cn(BADGE, "shrink-0", DECK_RELEASE[r.status])}>{RELEASE_STATUS_META[r.status].label}</span>
            </header>
            <div className="px-[1.6cqw] py-[1.2cqw]">
              {count > 0 && (
                <>
                  <p className="text-[0.9cqw] font-semibold uppercase tracking-[0.16em] text-ink-subtle">{released ? "What shipped in this version" : "What this version will cover"}</p>
                  <ol className="mt-[0.6cqw] flex flex-col divide-y divide-line/60">
                    {r.tasks!.map((t) => (
                      <li key={t.id} className="grid grid-cols-[4.2cqw_minmax(0,1fr)_auto] gap-x-[1cqw] py-[0.8cqw] first:pt-0 last:pb-0">
                        <span className="pt-[0.15cqw] text-[1.05cqw] tabular-nums text-ink-subtle">{taskRef(t.number)}</span>
                        <div className="min-w-0">
                          <p className="break-words text-[1.3cqw] font-semibold leading-snug text-ink">{t.title}</p>
                          {t.description?.trim() ? <p className="mt-[0.35cqw] whitespace-pre-wrap break-words text-[1.1cqw] leading-snug text-ink-muted">{t.description.trim()}</p> : <p className="mt-[0.3cqw] text-[1cqw] text-ink-subtle">No description.</p>}
                          {t.assignees.length > 0 && <p className="mt-[0.35cqw] text-[1cqw] text-ink-subtle">{t.assignees.map((u) => u.name.split(" ")[0]).join(", ")}</p>}
                        </div>
                        <span className={cn(BADGE_SM, "self-start", DECK_STATUS[t.status])}>{STATUS_META[t.status].label}</span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              {r.description?.trim() ? (
                <div className={cn(count > 0 && "mt-[1cqw] border-t border-line/60 pt-[0.9cqw]")}>
                  <p className="mb-[0.35cqw] text-[0.9cqw] font-semibold uppercase tracking-[0.16em] text-ink-subtle">Release notes</p>
                  <p className="whitespace-pre-wrap break-words text-[1.15cqw] leading-snug text-ink">{r.description.trim()}</p>
                </div>
              ) : count === 0 ? (
                <p className="text-[1.15cqw] text-ink-subtle">No tasks linked and no release notes.</p>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function MinutesTable({ notes, labels }: { notes: MeetingNote[]; labels: Map<string, string> }) {
  return (
    <div className={PANEL_SCROLL} data-deck-scroll>
      <table className="w-full border-collapse">
        <colgroup>
          <col style={{ width: "13%" }} />
          <col style={{ width: "30%" }} />
          <col />
          <col style={{ width: "12%" }} />
        </colgroup>
        <thead className="sticky top-0 z-[1] bg-surface shadow-[0_1px_0_rgba(0,0,0,0.06)]">
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
              <td className={cn(TD, "whitespace-pre-wrap break-words text-ink")}>{x.body}</td>
              <td className={cn(TD, "text-ink-muted")}>{x.author ? ownerText([x.author], labels) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CarryChip({ carry }: { carry: number }) {
  return (
    <span className={cn("shrink-0 whitespace-nowrap rounded-full px-[0.7cqw] py-[0.2cqw] text-[0.95cqw] font-bold ring-1 ring-inset", carry >= 3 ? "bg-red-600 text-white ring-red-600" : "bg-amber-100 text-amber-800 ring-amber-300")} title={`Pending for ${carry} earlier meeting${carry === 1 ? "" : "s"}`}>
      {carry}× carried
    </span>
  );
}

function NoteKind({ kind }: { kind: MeetingNote["kind"] }) {
  return (
    <span
      className={cn(
        "mt-[0.1cqw] inline-block shrink-0 whitespace-nowrap rounded-[0.4cqw] px-[0.7cqw] py-[0.25cqw] text-[0.9cqw] font-bold uppercase tracking-[0.08em] ring-1 ring-inset",
        kind === "blocker" ? "bg-red-600 text-white ring-red-600" : kind === "decision" ? "bg-ink text-white ring-ink" : kind === "action" ? "bg-blue-600 text-white ring-blue-600" : "bg-surface text-ink-muted ring-line"
      )}
    >
      {NOTE_KIND_META[kind].label}
    </span>
  );
}
