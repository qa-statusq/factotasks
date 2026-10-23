"use client";

import { usePref } from "@/lib/use-pref";

import { useMemo } from "react";
import { LoadError, EmptyState } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { PanelSkeleton } from "@/components/ui/skeleton";
import { Avatar } from "@/components/ui/avatar";
import { useCachedFetch } from "@/lib/client-cache";
import { cn } from "@/lib/cn";
import { STATUS_META, TYPE_META, formatDuration, type TaskStatus, type TaskType } from "@/lib/domain";
import { IconAnalytics } from "@/components/ui/icons";
import type { UserBrief } from "@/lib/types";

interface MonthRow {
  month: string;
  done: number;
  created: number;
  avg_lead_hours: number | null;
  avg_active_hours: number | null;
  releases: number;
}
interface Pack {
  months: MonthRow[];
  by_app: { id: string; name: string; color: string; done: number; open: number; overdue: number; months: Record<string, number> }[];
  general: { done: number; open: number; months: Record<string, number> };
  by_person?: (UserBrief & { done: number; open: number; in_progress: number; overdue: number; avg_lead_hours: number | null; months: Record<string, number> })[];
  status_now: Record<string, number>;
  type_done: Record<string, number>;
  totals: { done: number; created: number; open_now: number; overdue_now: number; median_lead_hours: number | null; avg_active_hours: number | null };
}

const monthLabel = (m: string) => new Date(m + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });
const hours = (h: number | null | undefined) => (h == null ? "—" : formatDuration(h * 3600));
const STATUS_COLORS: Record<TaskStatus, string> = { todo: "#94a3b8", in_progress: "#3b82f6", in_review: "#0ea5e9", on_hold: "#f59e0b", partial: "#14b8a6", done: "#10b981", cancelled: "#f87171" };

export default function AnalyticsPage() {
  const [months, setMonths] = usePref<number>("analytics.months", 6);
  const { data, loading, error, refresh } = useCachedFetch<Pack>(`/api/analytics?months=${months}`);
  const needsSchema = (error as { status?: number } | null)?.status === 424;

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-[20px] font-bold tracking-[-0.02em] text-ink sm:text-[24px]">Analytics</h1>
        <Segmented value={String(months)} onChange={(v) => setMonths(Number(v))} options={[3, 6, 12].map((n) => ({ value: String(n), label: `${n} months` }))} aria-label="Range" />
      </div>

      {loading ? (
        <PanelSkeleton />
      ) : error && !data ? (
        needsSchema ? (
          <EmptyState icon={<IconAnalytics size={20} />} title="One database update needed" description="Run supabase/schema.sql once in the Supabase SQL editor (it's safe to re-run), then reload this page." />
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
  const months = data.months;
  const maxMonth = Math.max(1, ...months.map((m) => Math.max(m.done, m.created)));
  const statusRows = useMemo(() => (Object.keys(STATUS_META) as TaskStatus[]).map((s) => ({ s, n: data.status_now[s] ?? 0 })).filter((r) => r.n > 0), [data]);
  const statusTotal = statusRows.reduce((a, r) => a + r.n, 0) || 1;
  const appsWithGeneral = useMemo(
    () => [...data.by_app, ...(data.general.done || data.general.open ? [{ id: "general", name: "General", color: "#94a3b8", done: data.general.done, open: data.general.open, overdue: 0, months: data.general.months }] : [])],
    [data]
  );
  const maxAppMonth = Math.max(1, ...appsWithGeneral.flatMap((a) => Object.values(a.months)));
  const byPerson = data.by_person ?? [];
  const maxPersonMonth = Math.max(1, ...byPerson.flatMap((p) => Object.values(p.months)));
  const people = [...byPerson].sort((a, b) => b.done - a.done || b.open - a.open);
  const types = Object.entries(data.type_done).sort((a, b) => b[1] - a[1]);

  return (
    <>
      {/* Headline numbers — one strip, not four cards */}
      <div className="grid grid-cols-2 divide-y divide-line/70 rounded-xl border border-line bg-surface sm:grid-cols-3 sm:divide-y-0 sm:divide-x lg:grid-cols-6">
        <Stat label="Done" value={data.totals.done} hint={`in ${months.length} months`} />
        <Stat label="Created" value={data.totals.created} />
        <Stat label="Open now" value={data.totals.open_now} />
        <Stat label="Overdue" value={data.totals.overdue_now} tone={data.totals.overdue_now ? "danger" : undefined} />
        <Stat label="Median lead" value={hours(data.totals.median_lead_hours)} hint="created → done" />
        <Stat label="Avg active" value={hours(data.totals.avg_active_hours)} hint="in progress" />
      </div>

      {/* Month-wise progress */}
      <Section title="Month-wise progress" hint="Done vs created per month">
        {data.totals.done || data.totals.created ? (
          <div className="flex items-end gap-2 sm:gap-4">
            {months.map((m) => (
              <div key={m.month} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                <div className="flex h-36 w-full items-end justify-center gap-1">
                  <Bar value={m.done} max={maxMonth} color="#10b981" title={`${monthLabel(m.month)}: ${m.done} done`} />
                  <Bar value={m.created} max={maxMonth} color="#c7d2fe" title={`${monthLabel(m.month)}: ${m.created} created`} />
                </div>
                <div className="text-[11px] font-medium text-ink-muted">{monthLabel(m.month)}</div>
                <div className="text-[10.5px] tabular-nums text-ink-subtle">
                  <span className="text-emerald-700">{m.done}</span> / {m.created}
                  {m.releases > 0 && <span title={`${m.releases} release(s)`}> · {m.releases} rel.</span>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-ink-subtle">No tasks in this window yet.</p>
        )}
        <Legend items={[["#10b981", "Done"], ["#c7d2fe", "Created"]]} />
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* App-wise, month-wise */}
        <Section title="App-wise" hint="Done per month, per app">
          {appsWithGeneral.length ? (
            <Heatmap rows={appsWithGeneral.map((a) => ({ key: a.id, label: a.name, color: a.color, months: a.months, total: a.done, extra: `${a.open} open${a.overdue ? ` · ${a.overdue} late` : ""}` }))} months={months.map((m) => m.month)} max={maxAppMonth} />
          ) : (
            <p className="py-6 text-center text-sm text-ink-subtle">No apps yet.</p>
          )}
        </Section>

        {/* Person-wise, month-wise (admins) */}
        {data.by_person && <Section title="Person-wise" hint="Done per month, per teammate">
          {people.length ? (
            <Heatmap rows={people.map((p) => ({ key: p.id, label: p.name, avatar: p, months: p.months, total: p.done, extra: `${p.open} open${p.overdue ? ` · ${p.overdue} late` : ""}` }))} months={months.map((m) => m.month)} max={maxPersonMonth} />
          ) : (
            <p className="py-6 text-center text-sm text-ink-subtle">No teammates yet.</p>
          )}
        </Section>}

        {/* Status mix now */}
        <Section title="Where work is right now" hint="Every task by status">
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
            <p className="py-6 text-center text-sm text-ink-subtle">No tasks yet.</p>
          )}
        </Section>

        {/* Cycle time per month + type mix */}
        <Section title="Cycle time by month" hint="Average lead time (created → done) and active time">
          {months.some((m) => m.avg_lead_hours != null) ? (
            <table className="w-full text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-ink-subtle">
                <tr>
                  <th className="pb-1.5 text-left font-medium">Month</th>
                  <th className="pb-1.5 text-right font-medium">Done</th>
                  <th className="pb-1.5 text-right font-medium">Lead</th>
                  <th className="pb-1.5 text-right font-medium">Active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {months.map((m) => (
                  <tr key={m.month}>
                    <td className="py-1.5 text-ink">{monthLabel(m.month)}</td>
                    <td className="py-1.5 text-right tabular-nums text-emerald-700">{m.done}</td>
                    <td className="py-1.5 text-right tabular-nums">{hours(m.avg_lead_hours)}</td>
                    <td className="py-1.5 text-right tabular-nums">{hours(m.avg_active_hours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-6 text-center text-sm text-ink-subtle">Nothing completed yet.</p>
          )}
          {types.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5 border-t border-line/70 pt-3">
              {types.map(([t, n]) => (
                <span key={t} className="rounded-md bg-canvas px-2 py-0.5 text-[11.5px] text-ink-muted ring-1 ring-inset ring-line">
                  {TYPE_META[t as TaskType]?.label ?? t} <b className="text-ink">{n}</b>
                </span>
              ))}
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: number | string; hint?: string; tone?: "danger" }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">{label}</div>
      <div className={cn("mt-0.5 text-[22px] font-semibold leading-none tabular-nums tracking-[-0.02em]", tone === "danger" ? "text-red-600" : "text-ink")}>{value}</div>
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

/** Rows × months grid of counts, shaded by intensity — reads at a glance on a phone too. */
function Heatmap({ rows, months, max }: { rows: { key: string; label: string; color?: string; avatar?: UserBrief; months: Record<string, number>; total: number; extra?: string }[]; months: string[]; max: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-[13px]">
        <thead className="text-[11px] uppercase tracking-wide text-ink-subtle">
          <tr>
            <th className="pb-1.5 text-left font-medium"></th>
            {months.map((m) => (
              <th key={m} className="pb-1.5 text-center font-medium">
                {monthLabel(m)}
              </th>
            ))}
            <th className="pb-1.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="py-1.5 pr-2">
                <div className="flex items-center gap-2">
                  {r.avatar ? <Avatar user={r.avatar} size="xs" /> : <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: r.color }} />}
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">{r.label}</span>
                    {r.extra && <span className="block text-[11px] text-ink-subtle">{r.extra}</span>}
                  </span>
                </div>
              </td>
              {months.map((m) => {
                const v = r.months[m] ?? 0;
                const a = v ? 0.15 + 0.85 * (v / max) : 0;
                return (
                  <td key={m} className="px-0.5 py-1.5 text-center">
                    <span className={cn("inline-flex h-7 w-10 items-center justify-center rounded-md text-[12px] font-semibold tabular-nums", v ? (a >= 0.5 ? "text-white" : "text-ink") : "text-ink-subtle/60")} style={{ backgroundColor: v ? `rgba(28,28,26,${a.toFixed(2)})` : "rgba(15,23,42,0.04)" }}>
                      {v || "·"}
                    </span>
                  </td>
                );
              })}
              <td className="py-1.5 text-right font-semibold tabular-nums text-ink">{r.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
