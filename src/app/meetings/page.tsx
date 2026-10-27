"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, buttonClass } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Dropdown } from "@/components/ui/dropdown";
import { DateRangeInput, type DateRange } from "@/components/ui/date-range";
import { EmptyState, LoadError, PageHeader } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { useSession } from "@/components/providers/session-provider";
import { useCachedFetch } from "@/lib/client-cache";
import { usePref } from "@/lib/use-pref";
import { fmtDateTime } from "@/lib/time";
import { When } from "@/components/ui/live-time";
import { cn } from "@/lib/cn";
import { NewMeetingSheet, ScopeLabel, SeriesBadge, MeetingStatusBadge } from "@/components/meeting-series";
import { RecordingBadge } from "@/components/recording-controls";
import { useRecorder } from "@/lib/use-recorder";
import { IconPresentation, IconPlus, IconMaximize, IconSettings, IconSearch, IconX, IconCalendar, IconMessage } from "@/components/ui/icons";
import type { AppOverview, Meeting, MeetingSeries } from "@/lib/types";

const fmt = fmtDateTime;

export default function MeetingsPage() {
  const { isAdmin } = useSession();
  const { data, loading, error, refresh } = useCachedFetch<{ meetings: Meeting[] }>("/api/meetings");
  const { data: sd } = useCachedFetch<{ series: MeetingSeries[] }>("/api/meeting-series");
  const { data: ad } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const [creating, setCreating] = useState(false);

  const [filterPref, setFilter] = usePref<string>("meetings.filter", "all");
  const [q, setQ] = useState("");
  const [range, setRange] = useState<DateRange | null>(null);
  const from = range?.from ?? "";
  const to = range?.to ?? "";
  const meetings = useMemo(() => data?.meetings ?? [], [data]);
  // A remembered series that no longer exists falls back to "all".
  const filter = filterPref === "all" || (sd?.series ?? []).some((s) => s.id === filterPref) ? filterPref : "all";
  const series = sd?.series ?? [];
  // Newest first; narrowed by series, title search and the held-on date range (IST days).
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return meetings
      .filter((m) => filter === "all" || m.series_id === filter)
      .filter((m) => !needle || m.title.toLowerCase().includes(needle) || (m.series?.name ?? "").toLowerCase().includes(needle))
      .filter((m) => {
        const day = new Date(Date.parse(m.held_at) + 5.5 * 3600_000).toISOString().slice(0, 10);
        return (!from || day >= from) && (!to || day <= to);
      })
      .sort((a, b) => b.held_at.localeCompare(a.held_at));
  }, [meetings, filter, q, from, to]);
  const narrowed = !!(q.trim() || from || to);
  const active = series.find((s) => s.id === filter);

  return (
    <div className="flex flex-col gap-4 animate-fade-in">
      <PageHeader
        title="Meetings"
        description={active ? `${active.name}${active.last_held_at ? ` · last held ${fmt(active.last_held_at)}` : " · no meetings yet"}. Each meeting covers its scope since the previous one in this series; pending work carries on to the next.` : "Every meeting gathers what was done and what's still pending since the previous one of its series — grouped by app, ready to present."}
        actions={
          isAdmin ? (
            <div className="flex items-center gap-2">
              <Link href="/meetings/series" className={buttonClass("secondary")} title="Series: scope, order, people, closing">
                <IconSettings size={15} /> Series
              </Link>
              <Button onClick={() => setCreating(true)}>
                <IconPlus size={16} /> New meeting
              </Button>
            </div>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {series.length > 0 && (
          <Dropdown
            fit
            value={filter}
            onChange={setFilter}
            options={[{ value: "all", label: `All series · ${meetings.length}` }, ...series.map((s) => ({ value: s.id, label: `${s.name} · ${s.meeting_count ?? 0}` }))]}
            className="[&>button]:h-9"
          />
        )}
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <IconSearch size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search meetings…" className="h-9 pl-8 pr-8" aria-label="Search meetings" />
          {q && (
            <button type="button" onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-subtle hover:text-ink" aria-label="Clear search">
              <IconX size={14} />
            </button>
          )}
        </div>
        <DateRangeInput value={range} onChange={setRange} placeholder="Held on any date" className="[&>button]:h-9" />
        {narrowed && (
          <button type="button" onClick={() => { setQ(""); setRange(null); }} className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted hover:text-ink">
            <IconX size={13} /> Clear
          </button>
        )}
      </div>

      {loading ? (
        <ListSkeleton rows={5} />
      ) : error && !data ? (
        <LoadError title="Couldn't load meetings" onRetry={refresh} />
      ) : shown.length === 0 && narrowed ? (
        <EmptyState icon={<IconSearch size={20} />} title="No meetings match" description="Try another word or widen the dates." />
      ) : shown.length === 0 ? (
        <EmptyState icon={<IconPresentation size={20} />} title={active ? `No ${active.name} meetings yet` : "No meetings yet"} description={isAdmin ? "Create a meeting: pick its series and the date and time you're meeting — the agenda is built from the series' scope for you." : "Meetings of the series you take part in appear here once an admin creates them."} action={isAdmin ? <Button onClick={() => setCreating(true)}>New meeting</Button> : undefined} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {shown.map((m) => (
            <li key={m.id} className="min-w-0">
              <MeetingCard m={m} apps={ad?.apps} />
            </li>
          ))}
        </ul>
      )}
      {(filter !== "all" || narrowed) && shown.length > 0 && <p className="text-[12px] text-ink-subtle">Showing {shown.length} of {meetings.length} meetings, newest first.</p>}
      {creating && <NewMeetingSheet onClose={() => setCreating(false)} defaultSeriesId={filter === "all" ? null : filter} />}

    </div>
  );
}

/** One meeting as a card: series colour on top, title and state, when it was held, what it covers, and the two ways in. */
function MeetingCard({ m, apps }: { m: Meeting; apps?: AppOverview[] }) {
  const recorder = useRecorder();
  const color = m.series?.color || "#64748b";
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface transition-shadow hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
      <div className="h-1 w-full" style={{ backgroundColor: color }} aria-hidden />
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ring-black/5" style={{ backgroundColor: `${color}1f`, color }} title={m.series?.name}>
          <IconPresentation size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <Link href={`/meetings/${m.id}`} className="block break-words text-[14.5px] font-semibold leading-snug text-ink hover:text-brand-700">
            {m.title}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-muted">
            <span className="inline-flex items-center gap-1">
              <IconCalendar size={12} className="shrink-0 text-ink-subtle" />
              <When iso={m.held_at} />
            </span>
          </div>
        </div>
        <MeetingStatusBadge status={m.status} className="shrink-0" />
        {recorder.state.phase === "recording" && recorder.state.meetingId === m.id && <RecordingBadge seconds={recorder.state.seconds} className="shrink-0" />}
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 px-4 pb-3.5 pt-3 text-[12px]">
        {m.series && (
          <>
            <dt className="text-ink-subtle">Series</dt>
            <dd className="min-w-0">
              <SeriesBadge series={m.series} />
            </dd>
          </>
        )}
        <dt className="text-ink-subtle">Covers</dt>
        <dd className="min-w-0 text-ink-muted">
          <ScopeLabel scope={m} apps={apps} />
        </dd>
        {typeof m.note_count === "number" && m.note_count > 0 && (
          <>
            <dt className="text-ink-subtle">Minutes</dt>
            <dd className="inline-flex items-center gap-1 text-ink-muted">
              <IconMessage size={12} className="text-ink-subtle" /> {m.note_count} note{m.note_count === 1 ? "" : "s"}
            </dd>
          </>
        )}
      </dl>
      <footer className="mt-auto flex items-center gap-2 border-t border-line/70 bg-canvas/40 px-4 py-2.5">
        <Link href={`/meetings/${m.id}/present`} className={buttonClass("secondary", "sm")} title="Present full-screen">
          <IconMaximize size={14} /> Present
        </Link>
        <Link href={`/meetings/${m.id}`} className={cn(buttonClass("primary", "sm"), "ml-auto")}>
          Open
        </Link>
      </footer>
    </article>
  );
}
