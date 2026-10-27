"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dropdown } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { Badge } from "@/components/ui/badge";
import { PageHeader, LoadError, EmptyState, Breadcrumb } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { DateRangeInput } from "@/components/ui/date-range";
import { ReleaseStatusBadge, PlatformBadge, AppTile, StatusBadge } from "@/components/ui/task-chips";
import { ReleaseViewSheet, prettyDate } from "@/components/release-ui";
import { useCachedFetch } from "@/lib/client-cache";
import { useNameLabels } from "@/lib/use-name-labels";
import { usePref } from "@/lib/use-pref";
import { istTime, fmtYmd } from "@/lib/time";
import { istDayKey } from "@/lib/ist";
import { releaseDay } from "@/lib/release-day";
import { cn } from "@/lib/cn";
import { PLATFORM_META, RELEASE_STATUSES, RELEASE_STATUS_META, taskRef, type ReleaseStatus } from "@/lib/domain";
import { IconRocket, IconCalendar, IconCheck, IconChevronDown, IconEdit, IconUserCheck, IconX, IconSearch } from "@/components/ui/icons";
import type { AppOverview, Release } from "@/lib/types";
import type { ReleaseEvent } from "@/app/api/releases/history/route";

type Group = "app" | "month" | "date";

const monthLabel = (ym: string) => fmtYmd(ym, { month: "long", year: true });
const fmtWhen = (iso: string) => istTime(iso).replace(/:\d\d (am|pm)/, " $1");
/** Separator glued to the word before it, so a wrapped line never opens with "·". */
const SEP = "\u00a0· ";

export default function ReleaseHistoryPage() {
  return (
    <Suspense fallback={<ListSkeleton rows={6} />}>
      <HistoryScreen />
    </Suspense>
  );
}

function HistoryScreen() {
  const sp = useSearchParams();
  const app = sp.get("app") || "";
  const platform = sp.get("platform") || "";
  const status = sp.get("status") || "";
  const [groupPref, setGroupPref] = usePref<string>("history.group", "month");
  const group = ((sp.get("group") as Group) || (groupPref as Group)) ?? "month";
  const from = sp.get("from") || "";
  const to = sp.get("to") || "";
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    window.history.replaceState(null, "", `/releases/history${next.toString() ? `?${next}` : ""}`);
  };
  const qs = new URLSearchParams({ ...(app ? { app } : {}), ...(platform ? { platform } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const { data, loading, error, refresh } = useCachedFetch<{ releases: Release[]; events: ReleaseEvent[] }>(`/api/releases/history${qs ? `?${qs}` : ""}`);
  const { data: appsData } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const apps = useMemo(() => appsData?.apps ?? [], [appsData]);
  const [open, setOpen] = useState<Release | null>(null);

  const eventsByRelease = useMemo(() => {
    const m = new Map<string, ReleaseEvent[]>();
    for (const e of data?.events ?? []) m.set(e.release_id, [...(m.get(e.release_id) || []), e]);
    return m;
  }, [data]);

  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const matches = useCallback(
    (r: Release) => {
      if (status && r.status !== status) return false;
      if (!needle) return true;
      const hay = [`v${r.version_name}`, r.version_name, r.build_number ?? "", r.app?.name ?? "", r.description ?? "", r.notes ?? "", RELEASE_STATUS_META[r.status].label, PLATFORM_META[r.platform].label, ...(r.tasks ?? []).flatMap((t) => [taskRef(t.number), t.title, t.description ?? ""]), ...(eventsByRelease.get(r.id) || []).map((e) => `${e.summary ?? ""} ${e.by}`)]
        .join("\n")
        .toLowerCase();
      return hay.includes(needle);
    },
    [needle, status, eventsByRelease]
  );
  const groups = useMemo(() => {
    const releases = [...(data?.releases ?? [])].filter(matches).sort((a, b) => releaseDay(b).localeCompare(releaseDay(a)) || b.created_at.localeCompare(a.created_at));
    const m = new Map<string, { label: string; sub?: string; items: Release[]; app?: Release["app"] }>();
    for (const r of releases) {
      const key = group === "app" ? r.app_id : group === "month" ? releaseDay(r).slice(0, 7) : releaseDay(r);
      const g = m.get(key) ?? { label: group === "app" ? (r.app?.name ?? "App") : group === "month" ? monthLabel(releaseDay(r).slice(0, 7)) : prettyDate(releaseDay(r)), items: [], app: r.app };
      g.items.push(r);
      m.set(key, g);
    }
    const list = [...m.entries()];
    if (group === "app") list.sort((a, b) => a[1].label.localeCompare(b[1].label));
    return list;
  }, [data, group, matches]);

  const total = (data?.releases ?? []).filter(matches).length;
  const shipped = (data?.releases ?? []).filter((r) => r.status === "released" && matches(r)).length;

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <Breadcrumb items={[{ label: "Releases", href: "/releases" }, { label: "History" }]} />
      <PageHeader title="Release history" description="Every version, with how its date and status moved and what shipped in it." className="-mt-2" />

      {/* Phones: two filters a row; search and grouping take the full width. */}
      <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
        <Cell label="App">
          <Dropdown fit value={app} onChange={(v) => set({ app: v || undefined })} options={[{ value: "", label: "All apps" }, ...apps.map((a) => ({ value: a.id, label: a.name }))]} className="min-w-0 sm:min-w-[11rem] [&>button]:h-9 [&>button]:w-full" />
        </Cell>
        <Cell label="Platform">
          <Dropdown value={platform} onChange={(v) => set({ platform: v || undefined })} options={[{ value: "", label: "Both platforms" }, { value: "android", label: PLATFORM_META.android.label }, { value: "ios", label: PLATFORM_META.ios.label }]} className="w-full sm:w-44 [&>button]:h-9" />
        </Cell>
        <Cell label="Status">
          <Dropdown value={status} onChange={(v) => set({ status: v || undefined })} options={[{ value: "", label: "Any status" }, ...RELEASE_STATUSES.map((s) => ({ value: s, label: RELEASE_STATUS_META[s].label }))]} className="w-full sm:w-40 [&>button]:h-9" />
        </Cell>
        <Cell label="Dates">
          <DateRangeInput value={from && to ? { from, to } : null} onChange={(v) => set({ from: v?.from, to: v?.to })} placeholder="Any dates" className="[&>button]:h-9 max-sm:[&>button]:w-full" />
        </Cell>
        <Cell label="Search" className="col-span-2">
          <div className="relative">
            <IconSearch size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Version, task, note, app…" className="h-9 w-full pl-8 text-[13px] sm:w-64" aria-label="Search releases" />
          </div>
        </Cell>
        <Cell label="Group by" className="col-span-2">
          <Segmented
            value={group}
            onChange={(v) => {
              setGroupPref(v);
              set({ group: undefined });
            }}
            options={[{ value: "app", label: "App" }, { value: "month", label: "Month" }, { value: "date", label: "Date" }]}
            aria-label="Group by"
          />
        </Cell>
      </div>

      {loading ? (
        <ListSkeleton rows={6} />
      ) : error && !data ? (
        <LoadError title="Couldn't load the history" onRetry={refresh} />
      ) : total === 0 ? (
        <EmptyState icon={<IconRocket size={20} />} title={needle ? `Nothing matches “${q.trim()}”` : status ? `No ${RELEASE_STATUS_META[status as ReleaseStatus]?.label.toLowerCase() ?? status} releases` : "No releases here"} description={needle ? "Try a version number, a task number or a word from the notes." : "Widen the dates, pick another app or clear the status filter."} />
      ) : (
        <>
          <p className="-mt-2 text-[12.5px] text-ink-subtle">
            {total} release{total === 1 ? "" : "s"} · {shipped} shipped
          </p>
          {groups.map(([key, g]) => (
            <section key={key} className="flex flex-col gap-3">
              <h2 className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                {group === "app" && g.app ? <AppTile name={g.app.name} color={g.app.color} iconUrl={g.app.icon_url} className="h-5 w-5 rounded-[5px] text-[8px]" /> : <IconCalendar size={14} className="text-ink-subtle" />}
                {g.label}
                <span className="font-normal text-ink-subtle">· {g.items.length}</span>
              </h2>
              <div className="flex flex-col gap-3">
                {g.items.map((r) => (
                  <ReleaseCard key={r.id} r={r} events={eventsByRelease.get(r.id) || []} showApp={group !== "app"} onOpen={() => setOpen(r)} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
      {open && <ReleaseViewSheet release={open} apps={apps} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Cell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">{label}</span>
      {children}
    </div>
  );
}

/* ------------------------------- one release ------------------------------ */

function ReleaseCard({ r, events, showApp, onOpen }: { r: Release; events: ReleaseEvent[]; showApp: boolean; onOpen: () => void }) {
  const label = useNameLabels();
  const plannedMoves = events.filter((e) => e.changes?.planned_date);
  const firstPlanned = plannedMoves.length ? (plannedMoves[0].changes!.planned_date.from as string | null) : null;
  const releasedDay = r.released_at ? istDayKey(r.released_at) : null;
  const slipped = firstPlanned && r.planned_date && firstPlanned !== r.planned_date;
  const tasks = r.tasks ?? [];
  const shippedTasks = tasks.filter((t) => t.released_at).length;
  const [showTimeline, setShowTimeline] = useState(false);
  const lastEvent = events.length ? events[events.length - 1] : null;
  // Flows as one sentence; each "·" stays on the line before, never opening a new one.
  const meta = (
    <div className="text-[12px] text-ink-muted">
      {releasedDay ? (
        <span>
          Released <b className="font-semibold text-ink">{prettyDate(releasedDay)}</b>
          {r.planned_date && r.planned_date !== releasedDay && <span className="text-ink-subtle">{SEP}planned {prettyDate(r.planned_date)}</span>}
        </span>
      ) : r.planned_date ? (
        <span>
          Release date <b className="font-semibold text-ink">{prettyDate(r.planned_date)}</b>
        </span>
      ) : (
        <span>No date yet</span>
      )}
      {slipped && (
        <span className="text-amber-700" title={`Originally ${prettyDate(firstPlanned)}`}>
          {SEP}moved {plannedMoves.length}× (first {prettyDate(firstPlanned)})
        </span>
      )}
      {tasks.length > 0 && (
        <span>
          {SEP}{shippedTasks}/{tasks.length} task{tasks.length === 1 ? "" : "s"} shipped
        </span>
      )}
      {r.created_by && <span>{SEP}added by {label(r.created_by)}</span>}
    </div>
  );

  return (
    <article className="overflow-hidden rounded-xl border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
        {showApp && r.app && <AppTile name={r.app.name} color={r.app.color} iconUrl={r.app.icon_url} androidIconUrl={r.app.icon_android_url} iosIconUrl={r.app.icon_ios_url} platform={r.platform} className="h-9 w-9 text-sm" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {showApp && r.app && <span className="text-[14px] font-semibold text-ink">{r.app.name}</span>}
            <span className="whitespace-nowrap">
              <span className="text-[14px] font-semibold tabular-nums text-ink">v{r.version_name}</span>
              {r.build_number && <span className="ml-1.5 text-xs text-ink-subtle">({r.build_number})</span>}
            </span>
            <PlatformBadge platform={r.platform} />
            <ReleaseStatusBadge status={r.status} />
            {r.requested_status && <Badge tone="warning">Awaiting approval</Badge>}
          </div>
          {/* Phones: the date line takes the card's full width under the title row. */}
          <div className="mt-0.5 hidden sm:block">{meta}</div>
        </div>
        <Button size="sm" variant="secondary" onClick={onOpen}>
          Open
        </Button>
        <div className="basis-full sm:hidden">{meta}</div>
      </header>

      <div className="grid gap-0 border-t border-line/70 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:divide-x md:divide-line/70">
        {/* What shipped */}
        <div className="px-4 py-3">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">In this version</p>
          {tasks.length ? (
            <ul className="flex flex-col gap-1">
              {tasks.map((t) => (
                <li key={t.id} className="flex items-start gap-1.5 text-[12.5px]">
                  <span className="shrink-0 tabular-nums whitespace-nowrap text-ink-subtle">{taskRef(t.number)}</span>
                  <div className="min-w-0 flex-1">
                    <Link href={`/tasks/${t.id}`} className="break-words text-ink hover:underline">
                      {t.title}
                    </Link>
                    {t.released_at ? <span className="ml-1.5 inline-flex items-center gap-0.5 align-[-1px] text-[11px] font-semibold text-emerald-700"><IconCheck size={11} /> shipped</span> : null}
                    {t.description?.trim() && <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[11.5px] leading-snug text-ink-muted">{t.description.trim()}</p>}
                    <div className="mt-1 sm:hidden">
                      <StatusBadge status={t.status} />
                    </div>
                  </div>
                  <span className="ml-auto hidden shrink-0 sm:block">
                    <StatusBadge status={t.status} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-ink-subtle">No tasks linked.</p>
          )}
          {r.description && (
            <div className="mt-2.5">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Release notes</p>
              <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink-muted">{r.description}</p>
            </div>
          )}
        </div>
        {/* Timeline — folded by default; the header line already says what matters. */}
        <div className="border-t border-line/70 px-4 py-3 md:border-t-0">
          <button type="button" onClick={() => setShowTimeline((v) => !v)} aria-expanded={showTimeline} className="flex w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-subtle hover:text-ink sm:flex-nowrap">
            <IconChevronDown size={13} className={cn("transition-transform", showTimeline ? "rotate-180" : "")} />
            Timeline
            <span className="whitespace-nowrap font-normal normal-case tracking-normal">· {events.length || 1} {events.length === 1 || events.length === 0 ? "entry" : "entries"}</span>
            {!showTimeline && lastEvent && <span className="w-full truncate pl-[19px] font-normal normal-case tracking-normal text-ink-subtle sm:ml-auto sm:w-auto sm:pl-0">last: {describe(lastEvent)} · {fmtWhen(lastEvent.created_at)}</span>}
          </button>
          {showTimeline && (
          <ol className="mt-2 flex flex-col gap-1.5">
            {events.length === 0 && (
              <li className="text-[12.5px] text-ink-subtle">Added {fmtWhen(r.created_at)}.</li>
            )}
            {events.map((e) => (
              <li key={e.id} className="flex items-start gap-2 text-[12.5px]">
                <span className={cn("mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-1 ring-inset", e.action.endsWith("approve") || e.changes?.status?.to === "released" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : e.action.endsWith("request") ? "bg-amber-50 text-amber-700 ring-amber-200" : e.action.endsWith("reject") ? "bg-red-50 text-red-600 ring-red-200" : "bg-canvas text-ink-subtle ring-line")}>
                  {e.action.endsWith("approve") || e.changes?.status?.to === "released" ? <IconCheck size={10} /> : e.action.endsWith("request") ? <IconUserCheck size={10} /> : e.action.endsWith("reject") ? <IconX size={10} /> : <IconEdit size={9} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-ink">{describe(e)}</div>
                  <div className="text-[11px] text-ink-subtle">
                    {fmtWhen(e.created_at)} · {e.by}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          )}
        </div>
      </div>
    </article>
  );
}

/** One readable line per logged change, from the field diff when there is one. */
function describe(e: ReleaseEvent): React.ReactNode {
  const c = e.changes;
  if (e.action === "release.create") return <>Added{c?.status?.to ? ` as ${RELEASE_STATUS_META[c.status.to as ReleaseStatus]?.label ?? String(c.status.to)}` : ""}{c?.planned_date?.to ? `, release date ${prettyDate(String(c.planned_date.to))}` : ""}{e.closed ? ` — ${e.closed} task${e.closed === 1 ? "" : "s"} marked done` : ""}</>;
  if (e.action === "release.approve") return <>Approved as released{e.closed ? ` — ${e.closed} task${e.closed === 1 ? "" : "s"} marked done` : ""}</>;
  if (e.action === "release.request") return <>Asked to mark it released</>;
  if (e.action === "release.reject") return <>Release request sent back</>;
  if (e.action === "release.withdraw") return <>Release request withdrawn</>;
  if (c && Object.keys(c).length) {
    const parts: React.ReactNode[] = [];
    if (c.planned_date) parts.push(<span key="d">Release date {c.planned_date.from ? <>{prettyDate(String(c.planned_date.from))} → </> : "set to "}<b className="font-semibold">{c.planned_date.to ? prettyDate(String(c.planned_date.to)) : "none"}</b></span>);
    if (c.status) parts.push(<span key="s">Status {RELEASE_STATUS_META[c.status.from as ReleaseStatus]?.label ?? "—"} → <b className="font-semibold">{RELEASE_STATUS_META[c.status.to as ReleaseStatus]?.label ?? String(c.status.to)}</b>{e.closed ? ` — ${e.closed} task${e.closed === 1 ? "" : "s"} marked done` : ""}</span>);
    if (c.version_name) parts.push(<span key="v">Version v{String(c.version_name.from)} → <b className="font-semibold">v{String(c.version_name.to)}</b></span>);
    if (c.build_number) parts.push(<span key="b">Build {String(c.build_number.from ?? "—")} → <b className="font-semibold">{String(c.build_number.to ?? "—")}</b></span>);
    if (c.platform) parts.push(<span key="p">Platform {String(c.platform.from)} → <b className="font-semibold">{String(c.platform.to)}</b></span>);
    if (c.tasks) parts.push(<span key="t">Task list updated ({String(c.tasks.to)} task{c.tasks.to === 1 ? "" : "s"})</span>);
    if (c.description) parts.push(<span key="n">Notes edited</span>);
    if (c.notes) parts.push(<span key="i">Internal notes edited</span>);
    if (parts.length) return parts.map((p, i) => <span key={i}>{i > 0 && " · "}{p}</span>);
  }
  return e.summary ?? e.action;
}
