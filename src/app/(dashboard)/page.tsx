"use client";

import { UnreleasedWorkBanner } from "@/components/release-ui";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { LoadError, EmptyState, Spinner, StatCard } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { TaskList, RequestSummary } from "@/components/task-list";
import { PlatformBadge, ReleaseStatusBadge, AppTile } from "@/components/ui/task-chips";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { useTaskComposer } from "@/components/task-composer";
import { useCachedFetch } from "@/lib/client-cache";
import { usePref } from "@/lib/use-pref";
import { reviewTask } from "@/lib/task-actions";
import { displayName } from "@/lib/name";
import { taskRef } from "@/lib/domain";
import { IconPlus, IconCheckCircle, IconArrowRight, IconTasks, IconPlay, IconCalendar, IconAlert, IconUserCheck } from "@/components/ui/icons";
import type { DashboardPack, TaskCard } from "@/lib/types";

// Hand-formatted (no Intl): server and browser ICU builds punctuate dates
// differently, which showed up as a hydration mismatch on this one line.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function todayLabel(): string {
  const d = new Date(Date.now() + 5.5 * 3600_000); // IST wall clock as UTC fields
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function greeting(): string {
  const h = Number(new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(11, 13));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default function DashboardPage() {
  const { me, isAdmin } = useSession();
  const composer = useTaskComposer();
  const { data, loading, error, refresh } = useCachedFetch<DashboardPack>("/api/dashboard");
  const name = displayName(me?.first_name, me?.last_name)?.split(" ")[0];
  const [tab, setTab] = usePref<"mine" | "team">("dashboard.tab", "mine");

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-bold leading-tight tracking-[-0.02em] text-ink sm:text-[24px]">{name ? `${greeting()}, ${name}` : "Dashboard"}</h1>
          <p className="mt-1 text-[13px] text-ink-muted">{todayLabel()}</p>
        </div>
        <Button onClick={() => composer.open(me ? { assignee_ids: [me.id] } : undefined)}>
          <IconPlus size={16} /> New task
        </Button>
      </div>

      {loading ? (
        <ListSkeleton rows={6} />
      ) : error && !data ? (
        <LoadError title="Couldn't load your dashboard" onRetry={refresh} />
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="My open" value={data.counts.my_open} icon={<IconTasks size={15} />} hint={`${data.counts.my_done_week} done by you this week`} />
            <StatCard label="In progress" value={data.counts.team_in_progress} icon={<IconPlay size={15} />} hint={`team · ${data.counts.team_open} open in total`} />
            <StatCard label="Due this week" value={data.counts.my_due_week} icon={<IconCalendar size={15} />} hint={data.counts.my_overdue ? `${data.counts.my_overdue} of yours overdue` : "nothing overdue for you"} />
            {isAdmin ? (
              <StatCard label="Needs approval" value={data.counts.approvals} icon={<IconUserCheck size={15} />} hint={`team overdue · ${data.counts.team_overdue}`} />
            ) : (
              <StatCard label="Overdue" value={data.counts.my_overdue} icon={<IconAlert size={15} />} hint={data.counts.my_awaiting ? `${data.counts.my_awaiting} awaiting approval` : "nothing awaiting approval"} />
            )}
          </div>

          {isAdmin && data.approvals.length > 0 && <Approvals tasks={data.approvals} total={data.counts.approvals} />}

          <section className="overflow-hidden rounded-xl border border-line bg-surface">
            <header className="flex items-center gap-2 border-b border-line/80 px-3 py-2">
              <Segmented
                size="sm"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "mine", label: `My tasks · ${data.counts.my_open}` },
                  { value: "team", label: `Team due this week · ${data.due_soon.length}` },
                ]}
                aria-label="Dashboard list"
              />
              <Link href={tab === "mine" ? "/tasks?scope=mine" : "/tasks?due=week"} className="ml-auto inline-flex items-center gap-1 px-1 text-xs font-medium text-ink-muted hover:text-ink">
                All <IconArrowRight size={12} />
              </Link>
            </header>
            {tab === "mine" ? (
              data.my_tasks.length ? (
                <TaskList tasks={data.my_tasks} />
              ) : (
                <EmptyState icon={<IconCheckCircle size={20} />} title="Nothing assigned to you" description="Create a task or pick one from the team's open list." />
              )
            ) : (
              <TaskList tasks={data.due_soon} empty="Nothing on the team is due this week" />
            )}
          </section>

          <UnreleasedWorkBanner compact />
          {data.releases.length > 0 && (
            <section>
              <h2 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-subtle">Releases</h2>
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {data.releases.map((r) => (
                  <li key={r.id} className="min-w-0">
                    <Link href={`/apps/${r.app.id}?tab=releases`} className="flex h-full items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2 transition-colors hover:bg-canvas">
                      <AppTile name={r.app.name} color={r.app.color} iconUrl={r.app.icon_url} androidIconUrl={r.app.icon_android_url} iosIconUrl={r.app.icon_ios_url} platform={r.platform} className="h-8 w-8 text-xs" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-ink">{r.app.name}</span>
                        <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                          <span className="tabular-nums">v{r.version_name}</span>
                          <PlatformBadge platform={r.platform} label={false} />
                        </span>
                      </span>
                      <ReleaseStatusBadge status={r.status} className="shrink-0" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.recent_done.length > 0 && (
            <section className="overflow-hidden rounded-xl border border-line bg-surface">
              <header className="flex items-center justify-between border-b border-line/80 px-4 py-2">
                <span className="text-[13px] font-semibold text-ink">
                  Done this week <span className="font-normal text-ink-subtle">{data.counts.team_done_week}</span>
                </span>
                <Link href="/tasks?scope=done" className="text-xs font-medium text-brand-700 hover:text-brand-800">
                  All done
                </Link>
              </header>
              <TaskList tasks={data.recent_done.slice(0, 6)} />
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}

function Approvals({ tasks, total }: { tasks: TaskCard[]; total: number }) {
  const { toast } = useToast();
  const { prompt } = useDialog();
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(t: TaskCard, action: "approve" | "reject") {
    if (busy) return;
    let note: string | null = null;
    if (action === "reject") {
      note = await prompt({ title: `Send ${taskRef(t.number)} back`, message: "Tell them what to fix (optional).", placeholder: "e.g. Also test on Android 10", confirmLabel: "Send back" });
      if (note === null) return;
    }
    setBusy(t.id);
    const res = await reviewTask(t, action, note);
    setBusy(null);
    toast(res.ok ? (action === "approve" ? `${taskRef(t.number)} approved` : `${taskRef(t.number)} sent back`) : res.error || "Failed", res.ok ? "success" : "error");
  }

  return (
    <section className="overflow-hidden rounded-xl border border-amber-200 bg-surface">
      <header className="flex items-center justify-between border-b border-amber-100 bg-amber-50/60 px-4 py-2">
        <span className="text-[13px] font-semibold text-amber-900">
          Needs your approval <span className="font-normal text-amber-700">{total}</span>
        </span>
        <Link href="/approvals" className="text-xs font-medium text-brand-700 hover:text-brand-800">
          All
        </Link>
      </header>
      <ul className="divide-y divide-line/70">
        {tasks.slice(0, 5).map((t) => (
          <li key={t.id} className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3">
            <Link href={`/tasks/${t.id}`} className="min-w-0 flex-1">
              <div className="break-words text-sm font-medium text-ink">
                <span className="mr-1.5 text-xs whitespace-nowrap text-ink-subtle">{taskRef(t.number)}</span>
                {t.title}
              </div>
              <RequestSummary task={t} className="mt-1" />
            </Link>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="secondary" onClick={() => decide(t, "reject")} disabled={busy === t.id}>
                Send back
              </Button>
              <Button size="sm" onClick={() => decide(t, "approve")} disabled={busy === t.id}>
                {busy === t.id ? <Spinner /> : "Approve"}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
