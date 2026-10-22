"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, buttonClass } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/field";
import { DateRangeInput, type DateRange } from "@/components/ui/date-range";
import { EmptyState, LoadError } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { useSession } from "@/components/providers/session-provider";
import { useCachedFetch } from "@/lib/client-cache";
import { istTime } from "@/lib/time";
import { RelTime } from "@/components/ui/live-time";
import { cn } from "@/lib/cn";
import { NewMeetingSheet, ManageSeriesSheet, SeriesBadge, ScopeLabel } from "@/components/meeting-series";
import { IconPresentation, IconPlus, IconMaximize, IconSettings, IconSearch, IconX } from "@/components/ui/icons";
import type { AppOverview, Meeting, MeetingSeries } from "@/lib/types";

const fmt = (iso: string) => istTime(iso).replace(/:\d\d (am|pm)/, " $1");

export default function MeetingsPage() {
  const { isAdmin } = useSession();
  const { data, loading, error, refresh } = useCachedFetch<{ meetings: Meeting[] }>("/api/meetings");
  const { data: sd } = useCachedFetch<{ series: MeetingSeries[] }>("/api/meeting-series");
  const { data: ad } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const [range, setRange] = useState<DateRange | null>(null);
  const from = range?.from ?? "";
  const to = range?.to ?? "";
  const meetings = useMemo(() => data?.meetings ?? [], [data]);
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
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[20px] font-bold tracking-[-0.02em] text-ink sm:text-[24px]">Meetings</h1>
        {isAdmin && (
          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setManaging(true)} title="Manage series">
              <IconSettings size={14} /> Series
            </Button>
            <Button onClick={() => setCreating(true)}>
              <IconPlus size={16} /> New meeting
            </Button>
          </div>
        )}
      </div>
      <p className="-mt-2 text-[13px] text-ink-muted">
        {active ? (
          <>
            {active.name}
            {active.last_held_at ? ` · last held ${fmt(active.last_held_at)}` : " · no meetings yet"}. Each meeting covers its scope since the previous one in this series; pending work carries on to the next.
          </>
        ) : (
          "Every meeting gathers what was done and what's still pending since the previous one of its series — grouped by app, ready to present."
        )}
      </p>

      {series.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Series">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            All <span className="text-ink-subtle">{meetings.length}</span>
          </FilterChip>
          {series.map((s) => (
            <FilterChip key={s.id} active={filter === s.id} onClick={() => setFilter(s.id)}>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
              {s.name} <span className="text-ink-subtle">{s.meeting_count ?? 0}</span>
            </FilterChip>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
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
        <EmptyState icon={<IconPresentation size={20} />} title={active ? `No ${active.name} meetings yet` : "No meetings yet"} description="Create a meeting: pick its series and scope, the date and time you're meeting, and the agenda is built for you." action={isAdmin ? <Button onClick={() => setCreating(true)}>New meeting</Button> : undefined} />
      ) : (
        <ul className="divide-y divide-line/70 overflow-hidden rounded-xl border border-line bg-surface">
          {shown.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-3 py-3 sm:px-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-canvas text-ink-muted ring-1 ring-inset ring-line">
                <IconPresentation size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/meetings/${m.id}`} className="break-words text-[14px] font-semibold text-ink hover:underline">
                    {m.title}
                  </Link>
                  <Badge tone={m.status === "open" ? "success" : "neutral"}>{m.status === "open" ? "Open" : "Closed"}</Badge>
                  {filter === "all" && <SeriesBadge series={m.series} />}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-ink-subtle">
                  <span>
                    {fmt(m.held_at)} · <RelTime iso={m.held_at} />
                  </span>
                  <span>·</span>
                  <ScopeLabel scope={m} apps={ad?.apps} />
                  {typeof m.note_count === "number" && m.note_count > 0 && <span>· {m.note_count} note{m.note_count === 1 ? "" : "s"}</span>}
                </div>
              </div>
              <Link href={`/meetings/${m.id}/present`} className={buttonClass("secondary", "sm")} title="Present full-screen">
                <IconMaximize size={14} /> <span className="hidden sm:inline">Present</span>
              </Link>
              <Link href={`/meetings/${m.id}`} className={buttonClass("primary", "sm")}>
                Open
              </Link>
            </li>
          ))}
        </ul>
      )}
      {(filter !== "all" || narrowed) && shown.length > 0 && <p className="text-[12px] text-ink-subtle">Showing {shown.length} of {meetings.length} meetings, newest first.</p>}
      {creating && <NewMeetingSheet onClose={() => setCreating(false)} defaultSeriesId={filter === "all" ? null : filter} />}
      {managing && <ManageSeriesSheet onClose={() => setManaging(false)} />}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium ring-1 ring-inset transition-colors", active ? "bg-ink text-white ring-ink [&_span]:text-white/60" : "bg-surface text-ink-muted ring-line hover:text-ink")}>
      {children}
    </button>
  );
}
