"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { usePref } from "@/lib/use-pref";
import { LoadError, EmptyState, PageHeader } from "@/components/ui/misc";
import { Dropdown } from "@/components/ui/dropdown";
import { DateRangeInput, type DateRange } from "@/components/ui/date-range";
import { PanelSkeleton } from "@/components/ui/skeleton";
import { Avatar } from "@/components/ui/avatar";
import { AppTile, GeneralTile, StatusBadge, PriorityBadge } from "@/components/ui/task-chips";
import { useSession } from "@/components/providers/session-provider";
import { HBars } from "@/components/ui/charts";
import { addDays, istTodayYmd, prettyYmd } from "@/components/ui/date-input";
import { useCachedFetch } from "@/lib/client-cache";
import { cn } from "@/lib/cn";
import { STATUS_META, TYPE_META, PRIORITY_META, RELEASE_STATUS_META, formatDuration, taskRef, type TaskStatus, type TaskType, type Priority, type ReleaseStatus } from "@/lib/domain";
import { IconAnalytics, IconRocket, IconPresentation, IconClock } from "@/components/ui/icons";
import type { AppLite, UserBrief } from "@/lib/types";

/* ------------------------------- data shape ------------------------------- */

interface Period {
  key: string;
  start: string;
  done: number;
  created: number;
  released: number;
  avg_lead_hours: number | null;
  avg_active_hours: number | null;
}
interface Row {
  done: number;
  created: number;
  open: number;
  in_progress: number;
  overdue: number;
  avg_lead_hours: number | null;
  with_due: number;
  on_time: number;
  releases: number;
  periods: Record<string, number>;
}
interface AppRow extends Row {
  id: string;
  name: string;
  color: string;
  icon_url: string | null;
}
type PersonRow = UserBrief & Omit<Row, "releases">;
interface Bucket {
  key: string;
  n: number;
}
interface OldTask {
  id: string;
  number: number;
  title: string;
  status: TaskStatus;
  priority: Priority;
  age_days: number;
  due_date: string | null;
  app: AppLite | null;
  assignees: UserBrief[];
}
interface Pack {
  range: { from: string; to: string; bucket: "week" | "month" };
  periods: Period[];
  by_app: AppRow[];
  general: Row;
  by_person?: PersonRow[];
  status_now: Record<string, number>;
  type_mix: Record<string, { done: number; open: number }>;
  priority_mix: Record<string, { done: number; open: number }>;
  cycle_buckets: Bucket[];
  aging: Bucket[];
  oldest_open: OldTask[];
  releases: { released: number; android: number; ios: number; with_plan: number; on_time: number; avg_slip_days: number | null; apps: number; pipeline: Record<string, number>; periods: Record<string, number> };
  meetings: { held: number; notes: number; decisions: number; actions: number; blockers: number };
  totals: { done: number; created: number; cancelled: number; open_now: number; wip_now: number; blocked_now: number; overdue_now: number; with_due: number; on_time: number; median_lead_hours: number | null; p90_lead_hours: number | null; avg_active_hours: number | null; avg_open_age_days: number | null };
}

/* -------------------------------- helpers --------------------------------- */

const hours = (h: number | null | undefined) => (h == null ? "—" : formatDuration(h * 3600));
const pct = (num: number, den: number) => (den > 0 ? `${Math.round((num / den) * 100)}%` : "—");
const STATUS_COLORS: Record<TaskStatus, string> = { todo: "#94a3b8", in_progress: "#3b82f6", in_review: "#8b5cf6", on_hold: "#f59e0b", partial: "#14b8a6", done: "#10b981", cancelled: "#f87171" };
const monthStart = (t: string) => `${t.slice(0, 7)}-01`;

/** Quick ranges; "custom" opens the calendar. */
const PRESETS: { id: string; label: string; build: (today: string) => DateRange }[] = [
  { id: "30d", label: "Last 30 days", build: (t) => ({ from: addDays(t, -29), to: t }) },
  { id: "90d", label: "Last 90 days", build: (t) => ({ from: addDays(t, -89), to: t }) },
  { id: "month", label: "This month", build: (t) => ({ from: monthStart(t), to: t }) },
  { id: "lastMonth", label: "Last month", build: (t) => { const end = addDays(monthStart(t), -1); return { from: monthStart(end), to: end }; } },
  { id: "quarter", label: "This quarter", build: (t) => { const m = Number(t.slice(5, 7)); const qm = m - ((m - 1) % 3); return { from: `${t.slice(0, 4)}-${String(qm).padStart(2, "0")}-01`, to: t }; } },
  { id: "6m", label: "Last 6 months", build: (t) => ({ from: addDays(t, -182), to: t }) },
  { id: "12m", label: "Last 12 months", build: (t) => ({ from: addDays(t, -364), to: t }) },
  { id: "year", label: "This year", build: (t) => ({ from: `${t.slice(0, 4)}-01-01`, to: t }) },
];

function periodLabel(key: string, bucket: "week" | "month"): string {
  if (bucket === "month") return new Date(key + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });
  return new Date(key + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

/* --------------------------------- page ----------------------------------- */

export default function AnalyticsPage() {
  const [preset, setPreset] = usePref<string>("analytics.range", "6m");
  const [custom, setCustom] = useState<DateRange | null>(null);
  const today = istTodayYmd();
  const range = useMemo<DateRange>(() => {
    if (preset === "custom" && custom) return custom;
    return (PRESETS.find((p) => p.id === preset) ?? PRESETS[5]).build(today);
  }, [preset, custom, today]);
  const { data, loading, error, refresh } = useCachedFetch<Pack>(`/api/analytics?from=${range.from}&to=${range.to}`);
  const needsSchema = (error as { status?: number } | null)?.status === 424;
  const { isAdmin } = useSession();
  const options = [...PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: "custom", label: "Custom dates…" }];

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <PageHeader
        title="Analytics"
        description={`${prettyYmd(range.from, { weekday: false })} → ${prettyYmd(range.to, { weekday: false })}${data ? ` · by ${data.range.bucket}` : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Dropdown fit value={preset} onChange={(v) => { setPreset(v); if (v === "custom" && !custom) setCustom(range); }} options={options} className="[&>button]:h-9" />
            {preset === "custom" && <DateRangeInput value={custom} onChange={(v) => v && setCustom(v)} allowClear={false} max={today} className="[&>button]:h-9" />}
          </div>
        }
      />

      {loading ? (
        <PanelSkeleton />
      ) : error && !data ? (
        needsSchema ? (
          <EmptyState icon={<IconAnalytics size={20} />} title="One database update needed" description={isAdmin ? "Run supabase/migrations/014_app_order_analytics_range.sql once in the Supabase SQL editor, then reload this page." : "Ask an admin to apply the latest database update; analytics returns right after."} />
        ) : (
          <LoadError title="Couldn't load analytics" onRetry={refresh} />
        )
      ) : data ? (
        <AnalyticsView data={data} />
      ) : null}
    </div>
  );
}

function AnalyticsView({ data }: { data: Pack }) {
  const t = data.totals;
  const periods = data.periods;
  const bucket = data.range.bucket;
  const maxPeriod = Math.max(1, ...periods.map((p) => Math.max(p.done, p.created)));
  const statusRows = useMemo(() => (Object.keys(STATUS_META) as TaskStatus[]).map((s) => ({ s, n: data.status_now[s] ?? 0 })).filter((r) => r.n > 0), [data]);
  const statusTotal = statusRows.reduce((a, r) => a + r.n, 0) || 1;
  const apps = useMemo<AppRow[]>(() => [...data.by_app, ...(data.general.done || data.general.open || data.general.created ? [{ id: "general", name: "General", color: "#94a3b8", icon_url: null, ...data.general }] : [])], [data]);
  const maxAppPeriod = Math.max(1, ...apps.flatMap((a) => Object.values(a.periods)));
  const people = useMemo(() => [...(data.by_person ?? [])].sort((a, b) => b.done - a.done || b.open - a.open), [data]);
  const maxPersonPeriod = Math.max(1, ...people.flatMap((p) => Object.values(p.periods)));
  const types = Object.entries(data.type_mix).sort((a, b) => b[1].done + b[1].open - (a[1].done + a[1].open));
  const priorities = (Object.keys(PRIORITY_META) as Priority[]).filter((p) => data.priority_mix[p]).map((p) => [p, data.priority_mix[p]] as const);
  const rel = data.releases;
  const pipeline = (Object.keys(RELEASE_STATUS_META) as ReleaseStatus[]).filter((s) => rel.pipeline[s]).map((s) => ({ s, n: rel.pipeline[s] }));
  const nothing = !t.done && !t.created && !t.open_now;

  return (
    <>
      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line/70 sm:grid-cols-4 lg:grid-cols-8 [&>*]:bg-surface">
        <Stat label="Done" value={t.done} hint="in this range" tone="success" />
        <Stat label="Created" value={t.created} hint={t.cancelled ? `${t.cancelled} cancelled` : "new tasks"} />
        <Stat label="Open now" value={t.open_now} hint={`${t.wip_now} in progress or review`} />
        <Stat label="Overdue" value={t.overdue_now} tone={t.overdue_now ? "danger" : undefined} hint={t.blocked_now ? `${t.blocked_now} on hold` : "past due today"} />
        <Stat label="On time" value={pct(t.on_time, t.with_due)} hint={t.with_due ? `${t.on_time} of ${t.with_due} with a due date` : "no dated tasks done"} tone={t.with_due && t.on_time / t.with_due < 0.7 ? "danger" : undefined} />
        <Stat label="Median lead" value={hours(t.median_lead_hours)} hint={`p90 ${hours(t.p90_lead_hours)} · created → done`} />
        <Stat label="Active time" value={hours(t.avg_active_hours)} hint="avg in progress per task" />
        <Stat label="Released" value={rel.released} hint={rel.released ? `${rel.android} Android · ${rel.ios} iOS` : "versions shipped"} />
      </div>

      {nothing && <EmptyState icon={<IconAnalytics size={20} />} title="Nothing in this range yet" description="Pick a wider range, or come back once tasks have been created and completed." />}

      {/* Throughput */}
      <Section title="Throughput" hint={`Done vs created per ${bucket}; releases marked underneath`}>
        {periods.length ? (
          <div className="overflow-x-auto">
            <div className="flex min-w-[420px] items-end gap-1.5 sm:gap-3">
              {periods.map((p) => (
                <div key={p.key} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                  <div className="flex h-36 w-full items-end justify-center gap-1">
                    <Bar value={p.done} max={maxPeriod} color="#10b981" title={`${periodLabel(p.key, bucket)}: ${p.done} done`} />
                    <Bar value={p.created} max={maxPeriod} color="#c7d2fe" title={`${periodLabel(p.key, bucket)}: ${p.created} created`} />
                  </div>
                  <div className="text-[11px] font-medium text-ink-muted">{periodLabel(p.key, bucket)}</div>
                  <div className="text-[10.5px] tabular-nums text-ink-subtle">
                    {p.done || p.created ? (
                      <>
                        <span className="text-emerald-700">{p.done}</span> / {p.created}
                      </>
                    ) : (
                      <span className="text-ink-subtle/50">—</span>
                    )}
                  </div>
                  <div className="h-4 text-[10.5px] text-ink-subtle">{p.released > 0 && <span className="inline-flex items-center gap-0.5" title={`${p.released} release(s)`}><IconRocket size={10} /> {p.released}</span>}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-ink-subtle">No periods in this range.</p>
        )}
        <Legend items={[["#10b981", "Done"], ["#c7d2fe", "Created"]]} />
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Cycle time distribution */}
        <Section title="Cycle time" hint="How long done tasks took, created → done">
          {t.done ? <HBars data={data.cycle_buckets.map((b) => ({ key: b.key, label: b.key, value: b.n, title: `${b.n} task${b.n === 1 ? "" : "s"} took ${b.key}` }))} color="#10b981" labelClassName="w-12" /> : <p className="py-6 text-center text-sm text-ink-subtle">Nothing completed in this range.</p>}
          <p className="mt-3 text-[11.5px] text-ink-subtle">Median {hours(t.median_lead_hours)} · 90% of tasks within {hours(t.p90_lead_hours)}.</p>
        </Section>

        {/* Open work aging */}
        <Section title="Open work by age" hint="Everything still open, by how long it has been waiting">
          {t.open_now ? <HBars data={data.aging.map((b) => ({ key: b.key, label: b.key, value: b.n, title: `${b.n} open task${b.n === 1 ? "" : "s"} aged ${b.key}` }))} color="#f59e0b" labelClassName="w-14" /> : <p className="py-6 text-center text-sm text-ink-subtle">Nothing open right now.</p>}
          <p className="mt-3 text-[11.5px] text-ink-subtle">Average age of open work: {t.avg_open_age_days == null ? "—" : `${t.avg_open_age_days} days`}.</p>
        </Section>
      </div>

      {/* App-wise */}
      <Section title="App-wise" hint="Delivery per app in this range">
        {apps.length ? (
          <Grid
            rows={apps.map((a) => ({ key: a.id, label: a.name, tile: a.id === "general" ? <GeneralTile className="h-6 w-6 rounded-md text-[10px]" /> : <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className="h-6 w-6 rounded-md text-[10px]" />, row: a }))}
            periods={periods}
            bucket={bucket}
            max={maxAppPeriod}
            showReleases
          />
        ) : (
          <p className="py-6 text-center text-sm text-ink-subtle">No apps yet.</p>
        )}
      </Section>

      {/* Person-wise (admins) */}
      {data.by_person && (
        <Section title="Person-wise" hint="Delivery per teammate in this range">
          {people.length ? <Grid rows={people.map((p) => ({ key: p.id, label: p.name, tile: <Avatar user={p} size="sm" />, row: { ...p, releases: 0 } }))} periods={periods} bucket={bucket} max={maxPersonPeriod} /> : <p className="py-6 text-center text-sm text-ink-subtle">No teammates yet.</p>}
        </Section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Releases */}
        <Section title="Releases" hint="Cadence and punctuality of versions shipped in this range">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Mini label="Released" value={rel.released} hint={`${rel.apps} app${rel.apps === 1 ? "" : "s"}`} />
            <Mini label="Android · iOS" value={`${rel.android} · ${rel.ios}`} />
            <Mini label="On planned date" value={pct(rel.on_time, rel.with_plan)} hint={rel.with_plan ? `${rel.on_time} of ${rel.with_plan} dated` : "none dated"} />
            <Mini label="Avg slip" value={rel.avg_slip_days == null ? "—" : `${rel.avg_slip_days > 0 ? "+" : ""}${rel.avg_slip_days}d`} hint="released − planned" />
          </div>
          {periods.length > 0 && rel.released > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Per {bucket}</p>
              <div className="flex items-end gap-1.5">
                {periods.map((p) => {
                  const n = rel.periods[p.key] ?? 0;
                  const max = Math.max(1, ...Object.values(rel.periods));
                  return (
                    <div key={p.key} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${periodLabel(p.key, bucket)}: ${n} release${n === 1 ? "" : "s"}`}>
                      <div className="flex h-12 w-full items-end justify-center">
                        <div className="w-full max-w-[18px] rounded-t-md bg-ink/70" style={{ height: `${(n / max) * 100}%`, minHeight: n ? 3 : 0 }} />
                      </div>
                      <span className="text-[10px] tabular-nums text-ink-subtle">{n || ""}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="mt-4 border-t border-line/70 pt-3">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">In the pipeline now</p>
            {pipeline.length ? (
              <div className="flex flex-wrap gap-1.5">
                {pipeline.map(({ s, n }) => (
                  <Link key={s} href="/releases" className="inline-flex items-center gap-1.5 rounded-md bg-canvas px-2 py-1 text-[12px] text-ink-muted ring-1 ring-inset ring-line hover:text-ink">
                    {RELEASE_STATUS_META[s].label} <b className="text-ink">{n}</b>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-ink-subtle">No versions in progress.</p>
            )}
          </div>
        </Section>

        {/* Mix */}
        <Section title="Where work is right now" hint="Every open and done task by status, type and priority">
          {statusRows.length ? (
            <>
              <div className="flex h-3 w-full overflow-hidden rounded-full bg-canvas">
                {statusRows.map((r) => (
                  <div key={r.s} style={{ width: `${(r.n / statusTotal) * 100}%`, backgroundColor: STATUS_COLORS[r.s] }} title={`${STATUS_META[r.s].label}: ${r.n}`} />
                ))}
              </div>
              <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
                {statusRows.map((r) => (
                  <li key={r.s} className="flex items-center gap-2 text-[13px]">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: STATUS_COLORS[r.s] }} />
                    <span className="text-ink-muted">{STATUS_META[r.s].label}</span>
                    <span className="ml-auto font-semibold tabular-nums text-ink">{r.n}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="py-4 text-center text-sm text-ink-subtle">No tasks yet.</p>
          )}
          {(types.length > 0 || priorities.length > 0) && (
            <div className="mt-4 grid gap-4 border-t border-line/70 pt-3 sm:grid-cols-2">
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">By type · done / open</p>
                <ul className="flex flex-col gap-1">
                  {types.map(([k, v]) => (
                    <li key={k} className="flex items-center gap-2 text-[12.5px]">
                      <span className="min-w-0 flex-1 truncate text-ink-muted">{TYPE_META[k as TaskType]?.label ?? k}</span>
                      <span className="tabular-nums"><b className="text-emerald-700">{v.done}</b><span className="text-ink-subtle"> / {v.open}</span></span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">By priority · done / open</p>
                <ul className="flex flex-col gap-1">
                  {priorities.map(([k, v]) => (
                    <li key={k} className="flex items-center gap-2 text-[12.5px]">
                      <PriorityBadge priority={k} compact />
                      <span className="min-w-0 flex-1 truncate text-ink-muted">{PRIORITY_META[k].label}</span>
                      <span className="tabular-nums"><b className="text-emerald-700">{v.done}</b><span className="text-ink-subtle"> / {v.open}</span></span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
        {/* Meetings */}
        <Section title="Meetings" hint="Held in this range, and what they produced">
          <div className="grid grid-cols-2 gap-3">
            <Mini label="Held" value={data.meetings.held} icon={<IconPresentation size={14} />} />
            <Mini label="Notes" value={data.meetings.notes} />
            <Mini label="Decisions" value={data.meetings.decisions} />
            <Mini label="Actions" value={data.meetings.actions} hint={data.meetings.blockers ? `${data.meetings.blockers} blocker${data.meetings.blockers === 1 ? "" : "s"} raised` : undefined} />
          </div>
          <p className="mt-3 text-[11.5px] text-ink-subtle">Minutes are recorded on each meeting; decisions and action items count here.</p>
        </Section>

        {/* Oldest open */}
        <Section title="Longest waiting" hint="Open tasks that have been around the longest">
          {data.oldest_open.length ? (
            <ul className="divide-y divide-line/60">
              {data.oldest_open.map((x) => (
                <li key={x.id} className="flex items-center gap-3 py-2">
                  {x.app ? <AppTile name={x.app.name} color={x.app.color} iconUrl={x.app.icon_url} className="h-6 w-6 rounded-md text-[10px]" /> : <GeneralTile className="h-6 w-6 rounded-md text-[10px]" />}
                  <div className="min-w-0 flex-1">
                    <Link href={`/tasks/${x.id}`} className="block break-words text-[13px] font-medium leading-snug text-ink hover:text-brand-700">
                      <span className="mr-1.5 text-[11.5px] text-ink-subtle">{taskRef(x.number)}</span>
                      {x.title}
                    </Link>
                    <p className="text-[11.5px] text-ink-subtle">
                      {x.assignees.length ? x.assignees.map((u) => u.name.split(" ")[0]).join(", ") : "Unassigned"}
                      {x.due_date && <span className={cn(x.due_date < istTodayYmd() && "text-red-600")}> · due {prettyYmd(x.due_date, { weekday: false, year: false })}</span>}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1 whitespace-nowrap text-[12px] tabular-nums text-ink-muted" title="Age since created">
                    <IconClock size={12} className="text-ink-subtle" /> {x.age_days}d
                  </span>
                  <StatusBadge status={x.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-ink-subtle">Nothing open right now.</p>
          )}
        </Section>
      </div>
    </>
  );
}

/* ------------------------------ components -------------------------------- */

function Stat({ label, value, hint, tone }: { label: string; value: number | string; hint?: string; tone?: "danger" | "success" }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">{label}</div>
      <div className={cn("mt-0.5 text-[22px] font-semibold leading-none tabular-nums tracking-[-0.02em]", tone === "danger" ? "text-red-600" : tone === "success" ? "text-emerald-700" : "text-ink")}>{value}</div>
      {hint && <div className="mt-1 truncate text-[11px] text-ink-subtle" title={hint}>{hint}</div>}
    </div>
  );
}

function Mini({ label, value, hint, icon }: { label: string; value: number | string; hint?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-canvas/70 px-3 py-2.5">
      <div className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-subtle">{icon}{label}</div>
      <div className="mt-0.5 text-[18px] font-semibold leading-none tabular-nums text-ink">{value}</div>
      {hint && <div className="mt-1 truncate text-[11px] text-ink-subtle">{hint}</div>}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        {hint && <span className="text-[11.5px] text-ink-subtle">{hint}</span>}
      </header>
      {children}
    </section>
  );
}

function Bar({ value, max, color, title }: { value: number; max: number; color: string; title: string }) {
  return (
    <div className="flex h-full w-1/2 max-w-[22px] flex-col justify-end" title={title}>
      <div className="rounded-t-md transition-[height] duration-300" style={{ height: `${(value / max) * 100}%`, minHeight: value ? 3 : 0, backgroundColor: color }} />
    </div>
  );
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="mt-3 flex gap-4 text-[11.5px] text-ink-subtle">
      {items.map(([c, l]) => (
        <span key={l} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: c }} /> {l}
        </span>
      ))}
    </div>
  );
}

/** Rows × figures, then a shaded cell per period — scrolls sideways on a phone. */
function Grid({ rows, periods, bucket, max, showReleases }: { rows: { key: string; label: string; tile: React.ReactNode; row: Row }[]; periods: Period[]; bucket: "week" | "month"; max: number; showReleases?: boolean }) {
  const cols = periods.slice(-12);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-[12.5px]">
        <thead className="text-[10.5px] uppercase tracking-wide text-ink-subtle">
          <tr>
            <th className="pb-1.5 text-left font-medium"></th>
            <th className="whitespace-nowrap pb-1.5 pl-3 text-right font-medium">Done</th>
            <th className="whitespace-nowrap pb-1.5 pl-3 text-right font-medium">Open</th>
            <th className="whitespace-nowrap pb-1.5 pl-3 text-right font-medium">Late</th>
            <th className="whitespace-nowrap pb-1.5 pl-3 text-right font-medium" title="Average created → done">Lead</th>
            <th className="whitespace-nowrap pb-1.5 pl-3 text-right font-medium" title="Done on or before the due date">On time</th>
            {showReleases && <th className="whitespace-nowrap pb-1.5 pl-3 text-right font-medium">Rel.</th>}
            {cols.map((p) => (
              <th key={p.key} className="pb-1.5 pl-2 text-center font-medium" title={periodLabel(p.key, bucket)}>
                {bucket === "month" ? periodLabel(p.key, bucket).split(" ")[0] : periodLabel(p.key, bucket)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="w-full max-w-0 py-1.5 pr-2">
                <div className="flex items-center gap-2">
                  {r.tile}
                  <span className="block truncate font-medium text-ink">{r.label}</span>
                </div>
              </td>
              <td className="py-1.5 pl-3 text-right font-semibold tabular-nums text-emerald-700">{r.row.done || <span className="font-normal text-ink-subtle/60">·</span>}</td>
              <td className="py-1.5 pl-3 text-right tabular-nums text-ink">{r.row.open || <span className="text-ink-subtle/60">·</span>}</td>
              <td className={cn("py-1.5 pl-3 text-right tabular-nums", r.row.overdue ? "font-semibold text-red-600" : "text-ink-subtle/60")}>{r.row.overdue || "·"}</td>
              <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums text-ink-muted">{hours(r.row.avg_lead_hours)}</td>
              <td className="py-1.5 pl-3 text-right tabular-nums text-ink-muted">{pct(r.row.on_time, r.row.with_due)}</td>
              {showReleases && <td className="py-1.5 pl-3 text-right tabular-nums text-ink-muted">{r.row.releases || <span className="text-ink-subtle/60">·</span>}</td>}
              {cols.map((p) => {
                const v = r.row.periods[p.key] ?? 0;
                const a = v ? 0.15 + 0.85 * (v / max) : 0;
                return (
                  <td key={p.key} className="py-1.5 pl-2 text-center">
                    {v ? (
                      <span className={cn("inline-flex h-6 w-8 items-center justify-center rounded-md text-[11.5px] font-semibold tabular-nums", a >= 0.5 ? "text-white" : "text-ink")} style={{ backgroundColor: `rgba(28,28,26,${a.toFixed(2)})` }}>
                        {v}
                      </span>
                    ) : (
                      <span className="inline-flex h-6 w-8 items-center justify-center text-[11.5px] text-ink-subtle/40">·</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
