"use client";

import { useMemo, useState } from "react";
import { PageHeader, LoadError, EmptyState } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { Dropdown } from "@/components/ui/dropdown";
import { DateRangeInput, type DateRange } from "@/components/ui/date-range";
import { Avatar } from "@/components/ui/avatar";
import { RecordingList, isAudioRecording } from "@/components/recordings";
import { useSession } from "@/components/providers/session-provider";
import { useCachedFetch } from "@/lib/client-cache";
import { useDocumentTitle } from "@/lib/use-document-title";
import { usePref } from "@/lib/use-pref";
import { istDayKey } from "@/lib/ist";
import { istDate } from "@/lib/time";
import { fmtDuration, recordingLabel } from "@/lib/recordings";
import { fmtBytes } from "@/lib/format";
import { IconPlay, IconSearch, IconPresentation } from "@/components/ui/icons";
import type { Recording } from "@/lib/types";


/** Every recorded meeting, newest first, grouped by meeting — searchable and filterable by series, person and date. */
export default function RecordingsPage() {
  const { isAdmin } = useSession();
  useDocumentTitle("Recordings · FactoTasks");
  const { data, loading, error, refresh } = useCachedFetch<{ recordings: Recording[]; enabled: boolean }>("/api/recordings");
  const [q, setQ] = useState("");
  const [seriesPref, setSeries] = usePref<string>("recordings.series", "");
  const [person, setPerson] = useState("");
  const [kind, setKind] = usePref<string>("recordings.kind", "");
  const [range, setRange] = useState<DateRange | null>(null);

  const all = useMemo(() => data?.recordings ?? [], [data]);
  const seriesOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of all) if (r.meeting?.series) m.set(r.meeting.series.id, r.meeting.series.name);
    return [...m.entries()].map(([value, label]) => ({ value, label }));
  }, [all]);
  const people = useMemo(() => {
    const m = new Map<string, NonNullable<Recording["recorder"]>>();
    for (const r of all) if (r.recorder) m.set(r.recorder.id, r.recorder);
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [all]);
  const series = seriesOptions.some((s) => s.value === seriesPref) ? seriesPref : "";

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => {
      if (series && r.meeting?.series?.id !== series) return false;
      if (person && r.recorder?.id !== person) return false;
      if (kind === "audio" && !isAudioRecording(r)) return false;
      if (kind === "video" && isAudioRecording(r)) return false;
      if (range && r.meeting) {
        const day = istDayKey(r.meeting.held_at);
        if (range.from && day < range.from) return false;
        if (range.to && day > range.to) return false;
      }
      if (needle) {
        const hay = `${r.meeting?.title ?? ""} ${recordingLabel(r)} ${r.recorder?.name ?? ""} ${r.meeting?.series?.name ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [all, q, series, person, range, kind]);

  const groups = useMemo(() => {
    const m = new Map<string, { meeting: NonNullable<Recording["meeting"]> | null; items: Recording[] }>();
    for (const r of filtered) {
      const key = r.meeting?.id ?? r.meeting_id;
      const g = m.get(key) ?? { meeting: r.meeting ?? null, items: [] };
      g.items.push(r);
      m.set(key, g);
    }
    return [...m.values()];
  }, [filtered]);

  const totalBytes = filtered.reduce((n, r) => n + r.size_bytes, 0);
  const totalSec = filtered.reduce((n, r) => n + (r.duration_sec ?? 0), 0);
  const filtering = !!(q.trim() || series || person || range || kind);

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <PageHeader title="Recordings" description={isAdmin ? "Screen and voice recordings of meetings. Watch or download them here, or share one with any e-mail address." : "Screen and voice recordings of the meetings you take part in. Watch them here."} />

      {loading && !data ? (
        <ListSkeleton rows={4} />
      ) : error && !data ? (
        <LoadError onRetry={refresh} />
      ) : !all.length ? (
        <EmptyState icon={<IconPlay size={22} />} title="No recordings yet" description={data?.enabled ? "Press “Record meeting” on a meeting, or the record button while presenting." : "Recording isn't set up on this server yet."} />
      ) : (
        <>
          {/* Phones: search on its own line, then the filters two to a row. */}
          <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
            <div className="relative col-span-2 sm:min-w-[220px] sm:max-w-sm sm:flex-1">
              <IconSearch size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search meeting, recording or person…" className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-[13px] text-ink placeholder:text-ink-subtle focus:border-brand-400 focus:outline-none" aria-label="Search recordings" />
            </div>
            <Dropdown fit value={kind} onChange={setKind} options={[{ value: "", label: "Screen and audio" }, { value: "video", label: "Screen recordings" }, { value: "audio", label: "Audio only" }]} className="min-w-0 [&>button]:h-9 max-sm:[&>button]:w-full" />
            {seriesOptions.length > 1 && <Dropdown fit value={series} onChange={setSeries} options={[{ value: "", label: "All series" }, ...seriesOptions]} className="min-w-0 [&>button]:h-9 max-sm:[&>button]:w-full" />}
            {people.length > 1 && <Dropdown fit value={person} onChange={setPerson} options={[{ value: "", label: "Recorded by anyone" }, ...people.map((p) => ({ value: p.id, label: p.name }))]} className="min-w-0 [&>button]:h-9 max-sm:[&>button]:w-full" />}
            <DateRangeInput value={range} onChange={setRange} placeholder="Meeting held on any date" className="col-span-2 [&>button]:h-9 max-sm:[&>button]:w-full" />
            <span className="col-span-2 text-[12px] sm:ml-auto tabular-nums text-ink-subtle">
              {filtered.length} recording{filtered.length === 1 ? "" : "s"} · {fmtDuration(totalSec)} · {fmtBytes(totalBytes)}
            </span>
          </div>

          {!groups.length ? (
            <EmptyState icon={<IconSearch size={22} />} title="Nothing matches" description={filtering ? "Try a different search, series, person or date range." : ""} />
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map((g) => (
                <section key={g.meeting?.id ?? g.items[0].meeting_id} className="overflow-hidden rounded-xl border border-line bg-surface">
                  <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/80 bg-canvas/50 px-4 py-2.5">
                    <IconPresentation size={15} className="shrink-0" style={g.meeting?.series ? { color: g.meeting.series.color } : undefined} />
                    <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{g.meeting?.title ?? "Meeting"}</h2>
                    <span className="text-[12px] text-ink-subtle">
                      {g.meeting && !g.meeting.title.includes(istDate(g.meeting.held_at)) ? `${istDate(g.meeting.held_at)} · ` : ""}
                      {g.items.length} recording{g.items.length === 1 ? "" : "s"}
                    </span>
                    {g.items[0].recorder && (
                      <span className="inline-flex items-center gap-1 text-[12px] text-ink-subtle">
                        <Avatar user={g.items[0].recorder} size="xs" /> {g.items[0].recorder.name}
                      </span>
                    )}
                  </header>
                  <div className="px-4">
                    <RecordingList recordings={g.items} cacheKey="/api/recordings" />
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
