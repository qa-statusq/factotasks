"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePref } from "@/lib/use-pref";
import { LoadError, EmptyState, PageHeader } from "@/components/ui/misc";
import { Dropdown } from "@/components/ui/dropdown";
import { DateRangeInput, type DateRange } from "@/components/ui/date-range";
import { PanelSkeleton } from "@/components/ui/skeleton";
import { Avatar } from "@/components/ui/avatar";
import { AppTile, GeneralTile, StatusBadge, PriorityBadge } from "@/components/ui/task-chips";
import { addDays, istTodayYmd, prettyYmd } from "@/components/ui/date-input";
import { useCachedFetch } from "@/lib/client-cache";
import { useNameList } from "@/lib/use-name-labels";
import { cn } from "@/lib/cn";
import { fmtYmd } from "@/lib/time";
import { STATUS_META, TYPE_META, PRIORITY_META, RELEASE_STATUS_META, formatDuration, taskRef, type TaskStatus, type TaskType, type Priority, type ReleaseStatus } from "@/lib/domain";
import { IconAnalytics, IconRocket, IconPresentation, IconClock, IconCheckCircle, IconPlus, IconTasks, IconAlert, IconCalendar, IconPlay } from "@/components/ui/icons";
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
  if (bucket === "month") return fmtYmd(key, { year: "2-digit" });
  return fmtYmd(key);
}
/** Column heads: the month alone (year on January), or the week's first day. */
function periodShort(key: string, bucket: "week" | "month"): string {
  if (bucket === "month") return fmtYmd(key) + (key.endsWith("-01") ? ` ${key.slice(2, 4)}` : "");
  return periodLabel(key, bucket);
}

/* --------------------------------- page ----------------------------------- */

export default function AnalyticsPage() {
  // The quick range is remembered per person; custom dates live for this visit only.
  const [savedPreset, setPreset] = usePref<string>("analytics.range", "6m");
  const preset = PRESETS.some((p) => p.id === savedPreset) ? savedPreset : "6m";
  const [custom, setCustom] = useState<DateRange | null>(null);
  const today = istTodayYmd();
  const range = useMemo<DateRange>(() => custom ?? (PRESETS.find((p) => p.id === preset) ?? PRESETS[5]).build(today), [preset, custom, today]);
  const { data, loading, error, refresh } = useCachedFetch<Pack>(`/api/analytics?from=${range.from}&to=${range.to}`);
  const options = [...PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: "custom", label: "Custom dates…" }];

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <PageHeader
        title="Analytics"
        description={`${prettyYmd(range.from, { weekday: false })} → ${prettyYmd(range.to, { weekday: false })}${data ? ` · figures per ${data.range.bucket}` : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Dropdown
              fit
              value={custom ? "custom" : preset}
              onChange={(v) => {
                if (v === "custom") setCustom(range);
                else {
                  setCustom(null);
                  setPreset(v);
                }
              }}
              options={options}
              className="[&>button]:h-9"
            />
            {custom && <DateRangeInput value={custom} onChange={(v) => v && setCustom(v)} allowClear={false} max={today} className="[&>button]:h-9" />}
          </div>
        }
      />

      {loading ? (
        <PanelSkeleton />
      ) : error && !data ? (
        <LoadError title="Couldn't load analytics" onRetry={refresh} />
      ) : data ? (
        <AnalyticsView data={data} />
      ) : null}
    </div>
  );
}

function AnalyticsView({ data }: { data: Pack }) {
  const names = useNameList();
  const t = data.totals;
  const periods = data.periods;
  const bucket = data.range.bucket;
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
  const onTimeRate = t.with_due ? t.on_time / t.with_due : null;

  return (
    <>
      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi icon={<IconCheckCircle size={15} />} label="Done" value={t.done} hint="completed in this range" tone="success" />
        <Kpi icon={<IconPlus size={15} />} label="Created" value={t.created} hint={t.cancelled ? `${t.cancelled} cancelled` : "new tasks"} />
        <Kpi icon={<IconTasks size={15} />} label="Open now" value={t.open_now} hint={`${t.wip_now} in progress or review${t.blocked_now ? ` · ${t.blocked_now} on hold` : ""}`} />
        <Kpi icon={<IconAlert size={15} />} label="Overdue" value={t.overdue_now} hint="past their due date today" tone={t.overdue_now ? "danger" : undefined} />
        <Kpi icon={<IconCalendar size={15} />} label="On time" value={pct(t.on_time, t.with_due)} hint={t.with_due ? `${t.on_time} of ${t.with_due} dated tasks met their date` : "no dated tasks completed yet"} tone={onTimeRate !== null && onTimeRate < 0.7 ? "danger" : onTimeRate !== null ? "success" : undefined} />
        <Kpi icon={<IconClock size={15} />} label="Lead time" value={hours(t.median_lead_hours)} hint={`median · 90% within ${hours(t.p90_lead_hours)}`} />
        <Kpi icon={<IconPlay size={15} />} label="Active time" value={hours(t.avg_active_hours)} hint="average spent in progress" />
        <Kpi icon={<IconRocket size={15} />} label="Released" value={rel.released} hint={rel.released ? `${rel.android} Android · ${rel.ios} iOS` : "versions shipped"} />
      </div>

      {nothing && <EmptyState icon={<IconAnalytics size={20} />} title="Nothing in this range yet" description="Pick a wider range, or come back once tasks have been created and completed." />}

      {/* Throughput */}
      <Section title="Throughput" hint={`Tasks done and created per ${bucket}; versions released marked beneath`}>
        {periods.length ? <PeriodChart periods={periods} bucket={bucket} /> : <p className="py-6 text-center text-sm text-ink-subtle">No periods in this range.</p>}
      </Section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Section title="Cycle time" hint="How long completed tasks took, created → done">
          {t.done ? <Buckets buckets={data.cycle_buckets} color="#10b981" /> : <p className="py-6 text-center text-sm text-ink-subtle">Nothing completed in this range.</p>}
        </Section>
        <Section title="Open work by age" hint="Everything still open, by how long it has been waiting">
          {t.open_now ? <Buckets buckets={data.aging} color="#f59e0b" /> : <p className="py-6 text-center text-sm text-ink-subtle">Nothing open right now.</p>}
          {t.open_now > 0 && <p className="mt-3 text-[12px] text-ink-subtle">Average age of open work: {t.avg_open_age_days == null ? "—" : `${t.avg_open_age_days} days`}.</p>}
        </Section>
      </div>

      {/* App-wise */}
      <Section title="App-wise" hint="Delivery per app in this range">
        {apps.length ? (
          <Grid
            rows={apps.map((a) => ({ key: a.id, label: a.name, tile: a.id === "general" ? <GeneralTile className="h-7 w-7 rounded-lg text-[11px]" /> : <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className="h-7 w-7 rounded-lg text-[11px]" />, row: a }))}
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
          {people.length ? <Grid rows={people.map((p) => ({ key: p.id, label: p.name, tile: <Avatar user={p} size="md" />, row: { ...p, releases: 0 } }))} periods={periods} bucket={bucket} max={maxPersonPeriod} /> : <p className="py-6 text-center text-sm text-ink-subtle">No teammates yet.</p>}
        </Section>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Releases */}
        <Section title="Releases" hint="Cadence and punctuality of versions shipped in this range">
          <div className="grid grid-cols-2 gap-3">
            <Mini label="Released" value={rel.released} hint={`across ${rel.apps} app${rel.apps === 1 ? "" : "s"}`} />
            <Mini label="Android · iOS" value={`${rel.android} · ${rel.ios}`} hint="by platform" />
            <Mini label="On planned date" value={pct(rel.on_time, rel.with_plan)} hint={rel.with_plan ? `${rel.on_time} of ${rel.with_plan} dated versions` : "no dated versions"} />
            <Mini label="Average slip" value={rel.avg_slip_days == null ? "—" : `${rel.avg_slip_days > 0 ? "+" : ""}${rel.avg_slip_days} d`} hint="released minus planned" />
          </div>
          {periods.length > 0 && rel.released > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Versions per {bucket}</p>
              <div className="flex items-end gap-1.5">
                {periods.map((p) => {
                  const n = rel.periods[p.key] ?? 0;
                  const max = Math.max(1, ...Object.values(rel.periods));
                  return (
                    <div key={p.key} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${periodLabel(p.key, bucket)}: ${n} release${n === 1 ? "" : "s"}`}>
                      <span className="text-[10.5px] font-semibold tabular-nums text-ink">{n || ""}</span>
                      <div className="flex h-14 w-full items-end justify-center rounded-md bg-canvas/70">
                        <div className="w-full max-w-[22px] rounded-t-md bg-ink/75" style={{ height: `${(n / max) * 100}%`, minHeight: n ? 4 : 0 }} />
                      </div>
                      <span className="truncate text-[10px] text-ink-subtle">{periodShort(p.key, bucket)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="mt-4 border-t border-line/70 pt-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">In the pipeline now</p>
            {pipeline.length ? (
              <div className="flex flex-wrap gap-1.5">
                {pipeline.map(({ s, n }) => (
                  <Link key={s} href="/releases" className="inline-flex items-center gap-1.5 rounded-lg bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink-muted ring-1 ring-inset ring-line hover:text-ink">
                    {RELEASE_STATUS_META[s].label} <b className="tabular-nums text-ink">{n}</b>
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
              <MixList title="By type" rows={types.map(([k, v]) => ({ key: k, label: TYPE_META[k as TaskType]?.label ?? k, done: v.done, open: v.open }))} />
              <MixList title="By priority" rows={priorities.map(([k, v]) => ({ key: k, label: PRIORITY_META[k].label, lead: <PriorityBadge priority={k} compact />, done: v.done, open: v.open }))} />
            </div>
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* Meetings */}
        <Section title="Meetings" hint="Held in this range, and what they produced">
          <div className="grid grid-cols-2 gap-3">
            <Mini label="Held" value={data.meetings.held} icon={<IconPresentation size={13} />} />
            <Mini label="Notes" value={data.meetings.notes} hint="recorded in minutes" />
            <Mini label="Decisions" value={data.meetings.decisions} />
            <Mini label="Action items" value={data.meetings.actions} hint={data.meetings.blockers ? `${data.meetings.blockers} blocker${data.meetings.blockers === 1 ? "" : "s"} raised` : undefined} />
          </div>
        </Section>

        {/* Oldest open */}
        <Section title="Longest waiting" hint="Open tasks that have been around the longest">
          {data.oldest_open.length ? (
            <ul className="divide-y divide-line/60">
              {data.oldest_open.map((x) => (
                <li key={x.id} className="flex items-start gap-3 py-2 sm:items-center">
                  {x.app ? <AppTile name={x.app.name} color={x.app.color} iconUrl={x.app.icon_url} className="h-7 w-7 rounded-lg text-[11px]" /> : <GeneralTile className="h-7 w-7 rounded-lg text-[11px]" />}
                  <div className="min-w-0 flex-1">
                    <Link href={`/tasks/${x.id}`} className="block break-words text-[13px] font-medium leading-snug text-ink hover:text-brand-700">
                      <span className="mr-1.5 text-[11.5px] whitespace-nowrap text-ink-subtle">{taskRef(x.number)}</span>
                      {x.title}
                    </Link>
                    <p className="text-[11.5px] text-ink-subtle">
                      {x.assignees.length ? names(x.assignees) : "Unassigned"}
                      {x.due_date && <span className={cn(x.due_date < istTodayYmd() && "text-red-600")}> · due {prettyYmd(x.due_date, { weekday: false, year: false })}</span>}
                    </p>
                    {/* Phones: age and status sit under the title, so the title keeps the row's width. */}
                    <div className="mt-1 flex items-center gap-2 sm:hidden">
                      <StatusBadge status={x.status} />
                      <span className="inline-flex items-center gap-1 text-[12px] tabular-nums text-ink-muted" title="Age since created">
                        <IconClock size={12} className="text-ink-subtle" /> {x.age_days}d
                      </span>
                    </div>
                  </div>
                  <span className="hidden w-12 shrink-0 items-center justify-end gap-1 whitespace-nowrap text-[12px] tabular-nums text-ink-muted sm:inline-flex" title="Age since created">
                    <IconClock size={12} className="text-ink-subtle" /> {x.age_days}d
                  </span>
                  <span className="hidden shrink-0 sm:block">
                    <StatusBadge status={x.status} className="w-[7.5rem] justify-center" />
                  </span>
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

function Kpi({ icon, label, value, hint, tone }: { icon: React.ReactNode; label: string; value: number | string; hint?: string; tone?: "danger" | "success" }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
        <span className="text-ink-subtle">{icon}</span>
        {label}
      </div>
      <div className={cn("mt-1.5 text-[26px] font-semibold leading-none tabular-nums tracking-[-0.02em]", tone === "danger" ? "text-red-600" : tone === "success" ? "text-emerald-700" : "text-ink")}>{value}</div>
      {hint && <div className="mt-1.5 text-[11.5px] leading-snug text-ink-subtle">{hint}</div>}
    </div>
  );
}

function Mini({ label, value, hint, icon }: { label: string; value: number | string; hint?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line/80 bg-canvas/50 px-3 py-2.5">
      <div className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-subtle">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-[20px] font-semibold leading-none tabular-nums text-ink">{value}</div>
      {hint && <div className="mt-1 text-[11px] leading-snug text-ink-subtle">{hint}</div>}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        {hint && <span className="text-[11.5px] text-ink-subtle">{hint}</span>}
      </header>
      {children}
    </section>
  );
}

/** The element's content width, kept current as it resizes (0 until first measured). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // The observer reports once on start, then on every resize.
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Grouped bars with gridlines and an integer axis — done beside created, per period.
 * Drawn at the card's own width (text stays its real size, nothing scrolls sideways);
 * when the columns get narrow, every k-th period is labelled and the counts move to the tooltip.
 */
function PeriodChart({ periods, bucket }: { periods: Period[]; bucket: "week" | "month" }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const n = periods.length;
  const W = Math.max(260, width || 640);
  const H = 240;
  const padL = W < 480 ? 30 : 40, padR = 8, padT = 16, padB = 54;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const rawMax = Math.max(1, ...periods.flatMap((p) => [p.done, p.created]));
  const step = rawMax <= 4 ? 1 : rawMax <= 8 ? 2 : rawMax <= 20 ? 5 : rawMax <= 40 ? 10 : Math.ceil(rawMax / 4 / 10) * 10;
  const top = Math.ceil(rawMax / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const col = innerW / n;
  const bw = Math.min(26, col * (col < 30 ? 0.38 : 0.28));
  const roomy = col >= 30; // room for the counts above the bars and the "rel." line
  const every = Math.ceil(36 / col); // label every k-th period so the labels never collide
  const y = (v: number) => padT + innerH - (v / top) * innerH;
  return (
    <div ref={box}>
      {width ? (
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full" role="img" aria-label="Tasks done and created per period">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#e7e5e4" strokeWidth={1} strokeDasharray={v === 0 ? undefined : "3 4"} />
            <text x={padL - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill="#8a8781">{v}</text>
          </g>
        ))}
        {periods.map((p, i) => {
          const cx = padL + col * i + col / 2;
          const label = periodShort(p.key, bucket);
          return (
            <g key={p.key}>
              <title>{`${periodLabel(p.key, bucket)}: ${p.done} done · ${p.created} created${p.released ? ` · ${p.released} release${p.released === 1 ? "" : "s"}` : ""}`}</title>
              <rect x={cx - bw - 2} y={y(p.done)} width={bw} height={Math.max(0, y(0) - y(p.done))} rx={4} fill="#10b981" />
              <rect x={cx + 2} y={y(p.created)} width={bw} height={Math.max(0, y(0) - y(p.created))} rx={4} fill="#a5b4fc" />
              {roomy && p.done > 0 && <text x={cx - bw / 2 - 2} y={y(p.done) - 5} textAnchor="middle" fontSize={11} fontWeight={600} fill="#047857">{p.done}</text>}
              {roomy && p.created > 0 && <text x={cx + bw / 2 + 2} y={y(p.created) - 5} textAnchor="middle" fontSize={11} fontWeight={600} fill="#4f46e5">{p.created}</text>}
              {(n - 1 - i) % every === 0 && <text x={cx} y={H - padB + 20} textAnchor="middle" fontSize={11.5} fontWeight={500} fill="#5f5c57">{label}</text>}
              {p.released > 0 &&
                (roomy ? (
                  <text x={cx} y={H - padB + 38} textAnchor="middle" fontSize={10.5} fill="#8a8781">
                    {p.released} rel.
                  </text>
                ) : (
                  <circle cx={cx} cy={H - padB + 34} r={2.5} fill="#8a8781" />
                ))}
            </g>
          );
        })}
      </svg>
      ) : (
        <div style={{ height: H }} />
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-subtle">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" /> Done
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-indigo-300" /> Created
        </span>
        <span className="inline-flex items-center gap-1.5">
          <IconRocket size={11} /> {roomy ? "rel. = versions released" : "dot = versions released"}
        </span>
      </div>
    </div>
  );
}

/** Horizontal bars with the share of the whole beside each count. */
function Buckets({ buckets, color }: { buckets: Bucket[]; color: string }) {
  const total = buckets.reduce((a, b) => a + b.n, 0) || 1;
  const max = Math.max(1, ...buckets.map((b) => b.n));
  return (
    <ul className="flex flex-col gap-2">
      {buckets.map((b) => (
        <li key={b.key} className="grid grid-cols-[3.5rem_1fr_5.5rem] items-center gap-3 text-[13px]">
          <span className="text-right tabular-nums text-ink-muted">{b.key}</span>
          <span className="h-3 overflow-hidden rounded-full bg-canvas">
            <span className="block h-full rounded-full transition-[width] duration-300" style={{ width: `${(b.n / max) * 100}%`, backgroundColor: color, minWidth: b.n ? 6 : 0 }} />
          </span>
          <span className="tabular-nums">
            <b className="text-ink">{b.n}</b> <span className="text-ink-subtle">· {Math.round((b.n / total) * 100)}%</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function MixList({ title, rows }: { title: string; rows: { key: string; label: string; lead?: React.ReactNode; done: number; open: number }[] }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
        {title} <span className="font-normal normal-case tracking-normal">· done / open</span>
      </p>
      <ul className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2 text-[12.5px]">
            {r.lead}
            <span className="min-w-0 flex-1 truncate text-ink-muted">{r.label}</span>
            <span className="tabular-nums">
              <b className="text-emerald-700">{r.done}</b>
              <span className="text-ink-subtle"> / {r.open}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Rows × figures, then a shaded cell per period. Phones get one card per row instead of a sideways-scrolling table. */
function Grid({ rows, periods, bucket, max, showReleases }: { rows: { key: string; label: string; tile: React.ReactNode; row: Row }[]; periods: Period[]; bucket: "week" | "month"; max: number; showReleases?: boolean }) {
  const cols = periods.slice(-12);
  const th = "whitespace-nowrap px-2.5 py-2 text-right text-[10.5px] font-semibold uppercase tracking-wide text-ink-subtle";
  const td = "px-2.5 py-2 text-right tabular-nums";
  const recent = cols.slice(-6);
  return (
    <>
    <ul className="-mx-4 divide-y divide-line/60 border-t border-line/60 sm:hidden">
      {rows.map((r) => (
        <li key={r.key} className="px-4 py-3">
          <div className="flex items-center gap-2.5">
            {r.tile}
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{r.label}</span>
          </div>
          <dl className="mt-2.5 grid grid-cols-3 gap-x-3 gap-y-2">
            <Fig label="Done" className="font-semibold text-emerald-700">{r.row.done || <Dash />}</Fig>
            <Fig label="Open" className="text-ink">{r.row.open || <Dash />}</Fig>
            <Fig label="Overdue" className={r.row.overdue ? "font-semibold text-red-600" : ""}>{r.row.overdue || <Dash />}</Fig>
            <Fig label="Lead time">{r.row.avg_lead_hours == null ? <Dash /> : hours(r.row.avg_lead_hours)}</Fig>
            <Fig label="On time">{r.row.with_due ? pct(r.row.on_time, r.row.with_due) : <Dash />}</Fig>
            {showReleases && <Fig label="Releases">{r.row.releases || <Dash />}</Fig>}
          </dl>
          {recent.length > 0 && (
            <div className="mt-2.5 flex gap-1" aria-label="Done per period">
              {recent.map((p) => {
                const v = r.row.periods[p.key] ?? 0;
                const a = v ? 0.18 + 0.82 * (v / max) : 0;
                return (
                  <div key={p.key} className="flex min-w-0 flex-1 flex-col items-center gap-0.5" title={`${periodLabel(p.key, bucket)}: ${v} done`}>
                    <span className={cn("flex h-6 w-full items-center justify-center rounded-md text-[11.5px] font-semibold tabular-nums ring-1 ring-inset", v ? (a >= 0.55 ? "text-white ring-transparent" : "text-ink ring-transparent") : "text-ink-subtle/30 ring-line/60")} style={v ? { backgroundColor: `rgba(5,150,105,${a.toFixed(2)})` } : undefined}>
                      {v || ""}
                    </span>
                    <span className="max-w-full truncate text-[10px] text-ink-subtle">{periodShort(p.key, bucket)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </li>
      ))}
    </ul>
    <div className="-mx-4 hidden overflow-x-auto sm:-mx-5 sm:block">
      <table className="w-full min-w-[760px] text-[13px]">
        <thead className="bg-canvas/70">
          <tr>
            <th className={cn(th, "pl-4 text-left sm:pl-5")}>Name</th>
            <th className={th}>Done</th>
            <th className={th}>Open</th>
            <th className={th}>Overdue</th>
            <th className={th} title="Average created → done">Lead time</th>
            <th className={th} title="Done on or before the due date">On time</th>
            {showReleases && <th className={th}>Releases</th>}
            {cols.map((p) => (
              <th key={p.key} className={cn(th, "px-1 text-center")} title={periodLabel(p.key, bucket)}>
                {periodShort(p.key, bucket)}
              </th>
            ))}
            <th className="w-4 sm:w-5" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {rows.map((r) => (
            <tr key={r.key} className="hover:bg-canvas/40">
              <td className="min-w-[200px] py-2 pl-4 pr-3 sm:pl-5">
                <div className="flex items-center gap-2.5">
                  {r.tile}
                  <span className="block max-w-[240px] truncate whitespace-nowrap font-medium text-ink">{r.label}</span>
                </div>
              </td>
              <td className={cn(td, "font-semibold text-emerald-700")}>{r.row.done || <Dash />}</td>
              <td className={cn(td, "text-ink")}>{r.row.open || <Dash />}</td>
              <td className={cn(td, r.row.overdue ? "font-semibold text-red-600" : "")}>{r.row.overdue || <Dash />}</td>
              <td className={cn(td, "whitespace-nowrap text-ink-muted")}>{r.row.avg_lead_hours == null ? <Dash /> : hours(r.row.avg_lead_hours)}</td>
              <td className={cn(td, "text-ink-muted")}>{r.row.with_due ? pct(r.row.on_time, r.row.with_due) : <Dash />}</td>
              {showReleases && <td className={cn(td, "text-ink-muted")}>{r.row.releases || <Dash />}</td>}
              {cols.map((p) => {
                const v = r.row.periods[p.key] ?? 0;
                const a = v ? 0.18 + 0.82 * (v / max) : 0;
                return (
                  <td key={p.key} className="px-1 py-2 text-center">
                    <span className={cn("inline-flex h-7 w-9 items-center justify-center rounded-md text-[12px] font-semibold tabular-nums ring-1 ring-inset", v ? (a >= 0.55 ? "text-white ring-transparent" : "text-ink ring-transparent") : "text-ink-subtle/30 ring-line/60")} style={v ? { backgroundColor: `rgba(5,150,105,${a.toFixed(2)})` } : undefined}>
                      {v || ""}
                    </span>
                  </td>
                );
              })}
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}

/** One labelled figure in a phone card. */
function Fig({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className={cn("mt-0.5 text-[13px] tabular-nums text-ink-muted", className)}>{children}</dd>
    </div>
  );
}

function Dash() {
  return <span className="text-ink-subtle/50">—</span>;
}
