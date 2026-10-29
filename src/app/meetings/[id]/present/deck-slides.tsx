"use client";

import { buildAgenda, notesByTask, deckRows, nameLabels, packPeople, ownerText, targetMatrix, SHARED_KEY, type AgendaGroup, meetingWindowText } from "@/lib/meeting-agenda";
import { istDate, fmtYmd, fmtDateTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import { STATUS_META, NOTE_KIND_META, PLATFORM_META, RELEASE_STATUS_META, taskRef, type TaskStatus, type ReleaseStatus } from "@/lib/domain";
import { dueInfo } from "@/components/task-list";
import { AppTile, PlatformGlyph } from "@/components/ui/task-chips";
import { nameInitials } from "@/lib/name";
import { ClampedText } from "@/components/ui/clamped-text";
import { NoteLink } from "@/components/ui/note-link";
import { IconAndroid, IconApple, IconCheck, IconPaperclip } from "@/components/ui/icons";
import { createContext, useContext } from "react";
import type { DeckPack, MeetingNote, MeetingPack, TaskCard, UserBrief } from "@/lib/types";

/**
 * The slides of a meeting deck: what each section shows and the parts it is built from
 * (tables, release cards, owners, platform marks). Every measurement is in cqw — 1cqw = 1% of
 * the 16:9 stage width — so proportions never change with the screen. The deck frame (keys,
 * strip, chrome, recording) lives in page.tsx.
 */
type Release = MeetingPack["releases"][number];

/** Cover title as lines: the name, then the date on its own line (no separator dot). */
function titleParts(title: string, heldAt: string): string[] {
  const i = title.lastIndexOf(" · ");
  if (i > 0) return [title.slice(0, i).trim(), title.slice(i + 3).trim()];
  const day = istDate(heldAt);
  return title.includes(day) ? [title] : [title, day];
}
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

export interface Slide {
  key: string;
  render: (n: number, total: number) => React.ReactNode;
  /** Listed in the "jump to" panel and the app strip. */
  jump?: { label: string; icon?: { name: string; color: string; iconUrl: string | null }; sub?: string; short?: string; kind?: "cover" | "general" | "shared" | "approvals" | "minutes" | "next" };
}

export function buildSlides(p: DeckPack): Slide[] {
  const slides: Slide[] = [];
  const m = p.meeting;
  const agenda = buildAgenda(p, { dedupe: true });
  const notes = notesByTask(p.notes);
  const labels = nameLabels(packPeople(p));
  const appMeta = new Map(p.apps.map((a) => [a.id, a]));
  const windowText = meetingWindowText(p);
  const frame = (n: number, total: number) => ({ meeting: m, workspace: p.workspace_name, n, total });

  /* Cover: minimal — the title block, four plain figures, and the agenda as
     a quiet list. No panels, nothing scrolls. */
  const dense = agenda.length > 8;
  const agendaCols = agenda.length <= 4 ? 1 : dense ? 3 : 2;
  const agendaRows = Math.ceil(agenda.length / agendaCols);
  slides.push({
    key: "cover",
    jump: { label: "Cover", sub: m.title, short: "Cover", kind: "cover" },
    render: (n, total) => (
      <Frame {...frame(n, total)} bare>
        <div className="flex min-h-0 flex-1 flex-col pt-[1.2cqw]">
          <p className="text-[1.05cqw] font-semibold uppercase tracking-[0.24em] text-ink-subtle">Minutes of meeting{p.series ? ` · ${p.series.name}` : ""}</p>
          <h1 className="mt-[1cqw] max-w-[78cqw] break-words text-[4cqw] font-bold leading-[1.06] tracking-[-0.03em] text-ink">
            {titleParts(m.title, m.held_at).map((part, i) => (
              <span key={i} className={cn("block", i > 0 && "mt-[1.1cqw] text-[2.4cqw] font-semibold leading-none text-ink-muted")}>{part}</span>
            ))}
          </h1>
          <p className="mt-[1cqw] text-[1.3cqw] text-ink-muted">
            Held {fmtDateTime(m.held_at)} IST · covering {windowText} · {(m.scoped ?? !!m.app_ids?.length) ? `${p.apps.length} app${p.apps.length === 1 ? "" : "s"}` : "every app"}{p.people.length > 0 && ` · ${p.people.length} ${p.people.length === 1 ? "person" : "people"}`}
          </p>
          <dl className="mt-[2.2cqw] flex gap-[4cqw] border-y border-line py-[1.4cqw]">
            {[
              ["Done", p.done.length, "text-emerald-700"],
              ["Open", p.pending.length, "text-ink"],
              ["Carried", p.carried.length, p.carried.length ? "text-amber-700" : "text-ink"],
              ["Overdue", p.overdue.length, p.overdue.length ? "text-red-600" : "text-ink"],
              ["Releases", p.releases.length, "text-ink"],
            ].map(([label, n, tone]) => (
              <div key={label as string}>
                <dt className="text-[0.95cqw] font-semibold uppercase tracking-[0.16em] text-ink-subtle">{label}</dt>
                <dd className={cn("mt-[0.3cqw] text-[3cqw] font-bold leading-none tabular-nums tracking-[-0.02em]", tone as string)}>{n as number}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-[1.8cqw] text-[0.95cqw] font-semibold uppercase tracking-[0.16em] text-ink-subtle">Agenda</p>
          {agenda.length === 0 ? (
            <p className="mt-[0.8cqw] text-[1.25cqw] text-ink-muted">Nothing changed since the last meeting.</p>
          ) : (
            <ol className="mt-[0.6cqw] grid min-h-0 gap-x-[4cqw]" style={{ gridTemplateColumns: `repeat(${agendaCols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${agendaRows}, auto)`, gridAutoFlow: "column" }}>
              {agenda.map((g, i) => (
                <li key={g.key} className={cn("flex items-center gap-[0.8cqw] border-b border-line/60 text-ink", dense ? "py-[0.5cqw] text-[1.1cqw]" : "py-[0.7cqw] text-[1.25cqw]")}>
                  <span className="w-[1.4cqw] shrink-0 text-right text-[0.95cqw] tabular-nums text-ink-subtle">{i + 1}</span>
                  <GroupTile g={g} className={dense ? "h-[1.9cqw] w-[1.9cqw] rounded-[0.45cqw] text-[0.8cqw]" : "h-[2.2cqw] w-[2.2cqw] rounded-[0.5cqw] text-[0.9cqw]"} />
                  <span className="min-w-0 flex-1 break-words font-semibold leading-tight">{g.name}</span>
                  <span className="shrink-0 whitespace-nowrap text-[0.95em] tabular-nums text-ink-muted">
                    {[g.done.length ? `${g.done.length} done` : "", g.pending.length ? `${g.pending.length} open` : "", g.releases.length ? `${g.releases.length} release${g.releases.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "—"}
                  </span>
                </li>
              ))}
            </ol>
          )}
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
            <ReleaseCards releases={g.releases} labels={labels} />
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
        <Frame {...frame(n, total)} app={app} section={shared ? undefined : "Tasks"} title={shared ? "Across apps" : undefined} subtitle={shared ? "Tasks that ship on more than one app — a green tick marks a platform already released" : undefined} part={`${rows.length} task${rows.length === 1 ? "" : "s"}`}>
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
  const carried = deckRows({ key: "next", name: "Next steps", color: "", iconUrl: null, pending: p.pending, done: [], releases: [], carried: 0, overdue: 0 });
  slides.push({
    key: "end",
    jump: { label: "Next steps", short: "Next steps", kind: "next", sub: `${p.pending.length} open` },
    render: (n, total) => (
      <Frame
        {...frame(n, total)}
        title="Next steps"
        subtitle={carried.length ? `${carried.length} open task${carried.length === 1 ? "" : "s"} carr${carried.length === 1 ? "ies" : "y"} into the next meeting${p.overdue.length ? ` · ${p.overdue.length} overdue` : ""}${p.carried.length ? ` · ${p.carried.length} carried before` : ""}` : "Nothing carries forward — everything is closed."}
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

export function Mark({ className }: { className?: string }) {
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
  meeting: DeckPack["meeting"];
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
      <div className="invisible flex h-[5.4cqw] shrink-0 items-center justify-between bg-[#1c1c1a] px-[4cqw] text-[1.05cqw] text-white/60 print:visible">
        <span className="inline-flex min-w-0 max-w-[24cqw] items-center gap-[0.8cqw]">
          <Mark className="h-[1.9cqw] w-[1.9cqw] text-white" />
          <span className="truncate font-semibold text-white/90">{meeting.title}</span>
          {!meeting.title.includes(istDate(meeting.held_at)) && <span className="shrink-0">· {istDate(meeting.held_at)}</span>}
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
                  <Tile n={g.pending.length} label="Open" />
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
                    <Tile n={g.pending.length} label="Open" />
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

/**
 * Where a task ships, compactly: one line per app — tile, name, then a glyph
 * per platform with a green tick once that target is released ("NEW PF ·
 * Android ✓ · iOS v1.1.4"). On an app's own slide only the platforms show.
 */
/** A platform on a task: filled green with a check once released there, quiet grey while it waits. */
function PlatformMark({ x }: { x: TaskCard["targets"][number] }) {
  const released = !!x.released_at;
  const label = `${PLATFORM_META[x.platform].label}: ${released ? `released in v${x.release?.version_name ?? ""}` : x.release ? `in v${x.release.version_name} (${RELEASE_STATUS_META[x.release.status].label})` : "no release yet"}`;
  return (
    <span className={cn("relative inline-flex h-[2.4cqw] w-[2.4cqw] shrink-0 items-center justify-center rounded-[0.55cqw]", released ? "bg-emerald-600 [&_svg]:text-white" : "bg-ink/[0.06] [&_svg]:text-ink-subtle")} title={label} aria-label={label}>
      {x.platform === "android" ? <IconAndroid className="h-[1.35cqw] w-[1.35cqw]" /> : <IconApple className="h-[1.35cqw] w-[1.35cqw]" />}
      {released && (
        <span className="absolute -bottom-[0.3cqw] -right-[0.3cqw] flex h-[1.05cqw] w-[1.05cqw] items-center justify-center rounded-full bg-white shadow-[0_0_0_0.15cqw_#059669]">
          <IconCheck className="h-[0.7cqw] w-[0.7cqw] !text-emerald-700" strokeWidth={3.5} />
        </span>
      )}
    </span>
  );
}

/** An icon that names itself on hover — large enough to read from the back of the room. */
function AppHint({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <span className="group relative inline-flex" title={name}>
      {children}
      <span className="pointer-events-none absolute left-full top-1/2 z-10 ml-[0.6cqw] -translate-y-1/2 whitespace-nowrap rounded-[0.5cqw] bg-ink px-[0.9cqw] py-[0.45cqw] text-[1.15cqw] font-semibold text-white opacity-0 shadow-[0_0.4cqw_1.2cqw_rgba(0,0,0,0.25)] transition-opacity duration-150 group-hover:opacity-100">
        {name}
      </span>
    </span>
  );
}

function DeckTargets({ t, currentApp }: { t: TaskCard; currentApp?: string }) {
  const rows = targetMatrix(t).filter((x) => !currentApp || x.app.id === currentApp);
  if (!rows.length) return null;
  const marks = (items: TaskCard["targets"]) => (
    <span className="inline-flex items-center gap-[0.35cqw]">
      {items.map((x) => (
        <PlatformMark key={x.platform} x={x} />
      ))}
    </span>
  );
  if (currentApp) return marks(rows[0].items);
  return (
    <span className="mt-[0.5cqw] flex flex-wrap items-center gap-x-[1.2cqw] gap-y-[0.5cqw]">
      {rows.map(({ app, items }) => (
        <span key={app.id} className="inline-flex items-center gap-[0.5cqw]" title={`${app.name}: ${items.map((x) => `${PLATFORM_META[x.platform].label} ${x.released_at ? "released" : x.release ? `in v${x.release.version_name}` : "pending"}`).join(", ")}`}>
          <AppTile name={app.name} color={app.color} iconUrl={app.icon_url} className="h-[2.1cqw] w-[2.1cqw] rounded-[0.5cqw] text-[0.85cqw]" />
          <span className="text-[1.05cqw] font-medium text-ink-muted">{app.name}</span>
          {marks(items)}
        </span>
      ))}
    </span>
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
          {showApp && <col style={{ width: "14%" }} />}
          <col />
          <col style={{ width: "19%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "12%" }} />
        </colgroup>
        <thead className="sticky top-0 z-[1] bg-surface shadow-[0_1px_0_rgba(0,0,0,0.06)]">
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
          {rows.map(({ t, done }) => {
            const taskNotes = notes.get(t.id) || [];
            const desc = t.description?.trim();
            const due = dueInfo(t.due_date, t.status);
            const appRows = showApp ? targetMatrix(t) : [];
            return (
              <tr key={t.id} className="border-b border-line/70 last:border-b-0">
                <td className={cn(TD, "whitespace-nowrap tabular-nums text-ink-subtle")}>{taskRef(t.number)}</td>
                {showApp && (
                  <td className={cn(TD, "text-ink-muted")}>
                    <span className="flex flex-col gap-[0.5cqw]">
                      {appRows.length ? (
                        appRows.map(({ app: a, items }) => (
                          <span key={a.id} className="inline-flex items-center gap-[0.4cqw]">
                            <AppHint name={a.name}>
                              <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className="h-[2.4cqw] w-[2.4cqw] rounded-[0.55cqw] text-[1cqw]" />
                            </AppHint>
                            {items.map((x) => (
                              <PlatformMark key={x.platform} x={x} />
                            ))}
                          </span>
                        ))
                      ) : (
                        <span className="text-[1.15cqw] text-ink-subtle">General</span>
                      )}
                    </span>
                  </td>
                )}
                <td className={cn(TD, "pr-[1.6cqw]")}>
                  <div className="flex flex-wrap items-center gap-x-[0.8cqw] gap-y-[0.35cqw]">
                    <span className={cn("break-words font-semibold", done ? "text-ink-muted" : "text-ink")}>{t.title}</span>
                    {currentApp && <DeckTargets t={t} currentApp={currentApp} />}
                    {typeof t.carry === "number" && t.carry > 0 && <CarryChip carry={t.carry} />}
                    {t.pinned && <span className="shrink-0 rounded-full bg-canvas px-[0.7cqw] py-[0.15cqw] text-[0.95cqw] font-semibold text-ink-muted ring-1 ring-inset ring-line">Pinned</span>}
                    <AttachmentChip t={t} />
                  </div>
                  <ClampedText text={desc} lines={2} className="mt-[0.4cqw] text-[1.15cqw] leading-snug text-ink-muted" buttonClassName="mt-[0.2cqw] text-[1.05cqw]" moreLabel="Show more" lessLabel="Show less" />
                  {matrix && <DeckTargets t={t} />}
                  {t.requested_status && <p className="mt-[0.4cqw] text-[1.1cqw] font-medium text-amber-700">Asked to move to {STATUS_META[t.requested_status].label} — awaiting approval</p>}
                  {taskNotes.length > 0 && <TaskNotes notes={taskNotes} />}
                </td>
                <td className={cn(TD, "text-ink-muted")}>
                  <Owners users={t.assignees} labels={labels} />
                </td>
                <td className={cn(TD, "tabular-nums", due?.tone === "danger" ? "font-semibold text-red-600" : due?.tone === "warning" ? "font-semibold text-amber-700" : "text-ink-muted")}>{t.due_date ? fmtYmd(t.due_date) : <span className="text-ink-subtle">—</span>}</td>
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
function ReleaseCards({ releases, labels }: { releases: Release[]; labels: Map<string, string> }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[1.1cqw] overflow-y-auto overscroll-contain pr-[0.3cqw]" data-deck-scroll>
      {releases.map((r) => {
        const released = r.status === "released";
        const when = released && r.released_at ? `Released ${istDate(r.released_at)}` : r.planned_date ? `Release date ${fmtYmd(r.planned_date)}` : "No release date yet";
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
                        <span className="pt-[0.15cqw] text-[1.05cqw] tabular-nums whitespace-nowrap text-ink-subtle">{taskRef(t.number)}</span>
                        <div className="min-w-0">
                          <p className="break-words text-[1.3cqw] font-semibold leading-snug text-ink">{t.title}</p>
                          {t.description?.trim() ? <p className="mt-[0.35cqw] whitespace-pre-wrap break-words text-[1.1cqw] leading-snug text-ink-muted">{t.description.trim()}</p> : <p className="mt-[0.3cqw] text-[1cqw] text-ink-subtle">No description.</p>}
                          {t.assignees.length > 0 && <p className="mt-[0.35cqw] text-[1cqw] text-ink-subtle">{ownerText(t.assignees, labels)}</p>}
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
                    <span className="mr-[0.5cqw] tabular-nums whitespace-nowrap text-ink-subtle">{taskRef(x.task.number)}</span>
                    <span className="break-words font-medium text-ink">{x.task.title}</span>
                  </>
                ) : x.about ? (
                  <span className="font-medium text-ink">{x.about.name}</span>
                ) : (
                  <span className="text-ink-subtle">General</span>
                )}
              </td>
              <td className={cn(TD, "whitespace-pre-wrap break-words text-ink")}>
                {x.body}
                {x.link_url && <NoteLink url={x.link_url} label={x.link_label} size="deck" className={x.body ? "ml-[0.7cqw]" : undefined} />}
              </td>
              <td className={cn(TD, "text-ink-muted")}>{x.author ? ownerText([x.author], labels) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The minute lines pinned to a task, under its description: a text note keeps
 * its link at the end of the sentence; notes that are only a link share one
 * "Links" row, so four findings read as four buttons, not four paragraphs.
 */
function TaskNotes({ notes }: { notes: MeetingNote[] }) {
  const text = notes.filter((x) => x.body.trim());
  const linkOnly = notes.filter((x) => !x.body.trim() && x.link_url);
  const shown = text.slice(0, NOTES_SHOWN_PER_TASK);
  const hidden = text.length - shown.length;
  return (
    <ul className="mt-[0.8cqw] flex flex-col gap-[0.55cqw] border-l-[0.25cqw] border-line pl-[1cqw]">
      {shown.map((x) => (
        <li key={x.id} className="flex items-start gap-[0.7cqw] text-[1.15cqw] leading-snug text-ink">
          <NoteKind kind={x.kind} />
          <span className="min-w-0 whitespace-pre-wrap break-words">
            {x.body}
            {x.link_url && <NoteLink url={x.link_url} label={x.link_label} size="deck" className="ml-[0.7cqw]" />}
          </span>
        </li>
      ))}
      {linkOnly.length > 0 && (
        <li className="flex items-start gap-[0.7cqw] text-[1.15cqw] leading-snug">
          <NoteKind kind={linkOnly[0].kind} label={linkOnly.length === 1 ? undefined : "Links"} />
          <span className="flex min-w-0 flex-wrap items-center gap-[0.5cqw]">
            {linkOnly.map((x) => (
              <NoteLink key={x.id} url={x.link_url} label={x.link_label} size="deck" />
            ))}
          </span>
        </li>
      )}
      {hidden > 0 && <li className="text-[1.05cqw] text-ink-subtle">+ {hidden} more in the minutes</li>}
    </ul>
  );
}

function CarryChip({ carry }: { carry: number }) {
  return (
    <span className={cn("shrink-0 whitespace-nowrap rounded-full px-[0.7cqw] py-[0.2cqw] text-[0.95cqw] font-bold ring-1 ring-inset", carry >= 3 ? "bg-red-600 text-white ring-red-600" : "bg-amber-100 text-amber-800 ring-amber-300")} title={`Still open after ${carry} earlier meeting${carry === 1 ? "" : "s"}`}>
      {carry}× carried
    </span>
  );
}

function NoteKind({ kind, label }: { kind: MeetingNote["kind"]; label?: string }) {
  return (
    <span
      className={cn(
        "mt-[0.1cqw] inline-block shrink-0 whitespace-nowrap rounded-[0.4cqw] px-[0.7cqw] py-[0.25cqw] text-[0.9cqw] font-bold uppercase tracking-[0.08em] ring-1 ring-inset",
        kind === "blocker" ? "bg-red-600 text-white ring-red-600" : kind === "decision" ? "bg-ink text-white ring-ink" : kind === "action" ? "bg-blue-600 text-white ring-blue-600" : "bg-surface text-ink-muted ring-line"
      )}
    >
      {label ?? NOTE_KIND_META[kind].label}
    </span>
  );
}

/** Opens a task's attachments from a slide; the deck page supplies the viewer. */
export const DeckAttachmentsContext = createContext<((t: TaskCard) => void) | null>(null);

/** "📎 3" on a task with attachments — opens them in the viewer, previous/next between them. */
function AttachmentChip({ t }: { t: TaskCard }) {
  const open = useContext(DeckAttachmentsContext);
  if (!open || !t.attachment_count) return null;
  const n = t.attachment_count;
  return (
    <button
      type="button"
      onClick={() => open(t)}
      className="deck-chrome inline-flex shrink-0 items-center gap-[0.3cqw] rounded-full bg-canvas px-[0.7cqw] py-[0.15cqw] text-[0.95cqw] font-semibold text-ink-muted ring-1 ring-inset ring-line hover:text-ink hover:ring-ink/40"
      title={`${n} attachment${n === 1 ? "" : "s"} — open`}
      aria-label={`Open ${n} attachment${n === 1 ? "" : "s"}`}
    >
      <IconPaperclip className="h-[1.05cqw] w-[1.05cqw]" />
      {n}
    </button>
  );
}
