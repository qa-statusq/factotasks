"use client";

import Link from "next/link";
import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { istToday } from "@/lib/ist";
import { taskRef } from "@/lib/domain";
import { AvatarStack } from "@/components/ui/avatar";
import { PlatformBadge, PriorityBadge, TargetChips, ReleaseProgress, SeriesChip, AppTile, StatusBadge, GeneralTile } from "@/components/ui/task-chips";
import { StatusMenu } from "@/components/status-menu";
import { EmptyState } from "@/components/ui/misc";
import { useNeedsApproval } from "@/lib/use-policy";
import { useSession } from "@/components/providers/session-provider";
import { IconMessage, IconPaperclip, IconTasks, IconArrowRight } from "@/components/ui/icons";
import { Avatar } from "@/components/ui/avatar";
import { RelTime } from "@/components/ui/live-time";
import type { TaskCard } from "@/lib/types";

/** "Due today" / "3d late" / "Fri 24 Oct" with a tone that escalates. */
export function dueInfo(due: string | null | undefined, status: string): { label: string; tone: "danger" | "warning" | "neutral" | "subtle" } | null {
  if (!due) return null;
  const closed = status === "done" || status === "cancelled";
  const diff = Math.round((Date.parse(due) - Date.parse(istToday())) / 86_400_000);
  const pretty = new Date(due + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  if (closed) return { label: pretty, tone: "subtle" };
  if (diff < 0) return { label: `${-diff}d late`, tone: "danger" };
  if (diff === 0) return { label: "Due today", tone: "warning" };
  if (diff === 1) return { label: "Due tomorrow", tone: "warning" };
  if (diff <= 7) return { label: `Due in ${diff}d`, tone: "neutral" };
  return { label: `Due ${pretty}`, tone: "subtle" };
}

export function DueChip({ task, className }: { task: TaskCard; className?: string }) {
  const info = dueInfo(task.due_date, task.status);
  if (!info) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap text-[11.5px] font-medium",
        info.tone === "danger" && "text-red-600",
        info.tone === "warning" && "text-amber-600",
        info.tone === "neutral" && "text-ink-muted",
        info.tone === "subtle" && "text-ink-subtle",
        className
      )}
      title={`Due ${task.due_date}`}
    >
      {info.label}
    </span>
  );
}

/** Status pills share one width so a column of rows lines up; the rare "requested" pill may grow. */
export const PILL_WIDTH = "sm:min-w-[8.5rem]";

/**
 * One task = one row: title (wraps, never truncates), one line of quiet
 * context, then two fixed columns — people, and the status pill that changes
 * status in place — so every row's controls sit on the same vertical line.
 */
export function TaskRow({ task, showApp = true, showDescription = false, trailing, below, needsApproval, canChange = true }: { task: TaskCard; showApp?: boolean; showDescription?: boolean; trailing?: React.ReactNode; below?: React.ReactNode; needsApproval: boolean; canChange?: boolean }) {
  return (
    <li className="cv-card group px-3 py-2.5 transition-colors hover:bg-canvas/60 sm:px-4">
      <div className="flex items-start gap-3">
        <Link href={`/tasks/${task.id}`} className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <PriorityBadge priority={task.priority} compact className="mt-[3px] shrink-0" />
            <span className={cn("min-w-0 break-words text-[14px] font-medium leading-snug text-ink", task.status === "done" && "text-ink-muted", task.status === "cancelled" && "text-ink-subtle line-through")}>
              {task.title}
            </span>
          </div>
          {showDescription && task.description?.trim() && <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words pl-[22px] text-[12px] leading-snug text-ink-muted">{task.description.trim()}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[22px] text-[11.5px] text-ink-subtle">
            <span className="tabular-nums">{taskRef(task.number)}</span>
            {showApp || (task.targets?.length ?? 0) > 1 ? (
              <TargetChips targets={task.targets} app={task.app} platform={task.platform} max={showApp ? 3 : 4} compact />
            ) : (
              <PlatformBadge platform={task.platform} label={false} className="px-1 py-0 ring-0 bg-transparent" />
            )}
            <ReleaseProgress progress={task.release_progress} />
            <SeriesChip series={task.series} />
            <DueChip task={task} />
            {task.labels.slice(0, 2).map((l) => (
              <span key={l}>#{l}</span>
            ))}
            {task.comment_count > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <IconMessage size={11} /> {task.comment_count}
              </span>
            )}
            {task.attachment_count > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <IconPaperclip size={11} /> {task.attachment_count}
              </span>
            )}
          </div>
        </Link>
        <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="flex justify-end sm:w-[5rem]">
            <AvatarStack users={task.assignees} size="sm" />
          </span>
          <StatusMenu task={task} needsApproval={needsApproval} canChange={canChange} className={PILL_WIDTH} />
          {trailing}
        </div>
      </div>
      {below}
    </li>
  );
}

interface Group {
  key: string;
  name: string;
  color: string;
  iconUrl: string | null;
  tasks: TaskCard[];
}

/** Group tasks by app in the Apps screen's order (`appOrder`), General last; keeps the incoming order inside each group. */
export function groupByApp(tasks: TaskCard[], appOrder: string[] = []): Group[] {
  const map = new Map<string, Group>();
  for (const t of tasks) {
    const key = t.app?.id ?? "general";
    let g = map.get(key);
    if (!g) {
      g = { key, name: t.app?.name ?? "General", color: t.app?.color ?? "#94a3b8", iconUrl: t.app?.icon_url ?? null, tasks: [] };
      map.set(key, g);
    }
    g.tasks.push(t);
  }
  const groups = [...map.values()];
  const pos = (g: Group) => {
    const i = appOrder.indexOf(g.key);
    return i === -1 ? appOrder.length : i;
  };
  groups.sort((a, b) => (a.key === "general" ? 1 : b.key === "general" ? -1 : pos(a) - pos(b) || a.name.localeCompare(b.name)));
  return groups;
}

export function TaskList({
  tasks,
  empty,
  emptyDescription,
  showApp = true,
  showDescription = false,
  groupBy,
  appOrder,
  renderTrailing,
  renderBelow,
  className,
}: {
  tasks: TaskCard[];
  empty?: string;
  emptyDescription?: string;
  showApp?: boolean;
  /** Show each task's description under its title (release views). */
  showDescription?: boolean;
  groupBy?: "app";
  /** App ids in the Apps screen's order; groups follow it. */
  appOrder?: string[];
  renderTrailing?: (t: TaskCard) => React.ReactNode;
  renderBelow?: (t: TaskCard) => React.ReactNode;
  className?: string;
}) {
  const needsApproval = useNeedsApproval();
  const { me, isAdmin } = useSession();
  // The API lets an admin, the creator or an assignee change a status; the pill says so up front.
  const mayChange = (t: TaskCard) => isAdmin || t.created_by?.id === me?.id || t.assignees.some((a) => a.id === me?.id);
  const groups = useMemo(() => (groupBy === "app" ? groupByApp(tasks, appOrder) : null), [tasks, groupBy, appOrder]);
  if (!tasks.length) {
    return <EmptyState icon={<IconTasks size={20} />} title={empty || "No tasks here"} description={emptyDescription} />;
  }
  if (groups) {
    return (
      <div className={cn("flex flex-col gap-4", className)}>
        {groups.map((g) => (
          <section key={g.key} className="overflow-hidden rounded-xl border border-line bg-surface">
            <header className="flex items-center gap-2 border-b border-line/80 bg-canvas/60 px-3 py-2 sm:px-4">
              {g.key === "general" ? <GeneralTile className="h-6 w-6 rounded-md text-[10px]" /> : <AppTile name={g.name} color={g.color} iconUrl={g.iconUrl} className="h-6 w-6 rounded-md text-[10px]" />}
              <span className="text-[13px] font-semibold text-ink">{g.name}</span>
              <span className="text-xs text-ink-subtle">{g.tasks.length}</span>
            </header>
            <ul className="divide-y divide-line/70">
              {g.tasks.map((t) => (
                <TaskRow key={t.id} task={t} showApp={false} showDescription={showDescription} needsApproval={needsApproval} canChange={mayChange(t)} trailing={renderTrailing?.(t)} below={renderBelow?.(t)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }
  return (
    <ul className={cn("divide-y divide-line/70", className)}>
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} showApp={showApp} showDescription={showDescription} needsApproval={needsApproval} canChange={mayChange(t)} trailing={renderTrailing?.(t)} below={renderBelow?.(t)} />
      ))}
    </ul>
  );
}

/**
 * What a pending approval is about, for admins: who asked, when, from which
 * status to which, and their note. Sits under the task title on the
 * Approvals page and the dashboard card.
 */
export function RequestSummary({ task, className }: { task: TaskCard; className?: string }) {
  if (!task.requested_status) return null;
  const chip = (s: TaskCard["status"]) => <StatusBadge status={s} />;
  return (
    <div className={cn("flex flex-col gap-1 text-[12px] text-ink-muted", className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {task.requested_by && (
          <span className="inline-flex items-center gap-1.5 font-medium text-ink">
            <Avatar user={task.requested_by} size="xs" /> {task.requested_by.name}
          </span>
        )}
        <span>asked to move</span>
        {chip(task.status)}
        <IconArrowRight size={12} className="text-ink-subtle" />
        {chip(task.requested_status)}
        {task.requested_at && (
          <span className="text-ink-subtle">
            · <RelTime iso={task.requested_at} />
          </span>
        )}
      </div>
      {task.request_note && <p className="break-words rounded-md bg-canvas px-2 py-1 text-[12px] text-ink">“{task.request_note}”</p>}
    </div>
  );
}
