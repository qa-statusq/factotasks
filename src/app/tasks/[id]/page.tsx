"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/field";
import { Breadcrumb, LoadError, Spinner } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar } from "@/components/ui/avatar";
import { RichText } from "@/components/ui/rich-text";
import { NoteLink } from "@/components/ui/note-link";
import { SeriesBadge, MeetingStatusBadge } from "@/components/meeting-series";
import { PriorityBadge, TypeBadge, PlatformBadge, LabelChip, TargetChips, ReleaseProgress, AppTile, SeriesChip } from "@/components/ui/task-chips";
import { DueChip } from "@/components/task-list";
import { StatusMenu } from "@/components/status-menu";
import { TaskFormSheet, type TaskFormValues } from "@/components/task-form";
import { TaskAttachments } from "@/components/task-attachments";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { useClock } from "@/components/providers/clock-provider";
import { useNameLabels } from "@/lib/use-name-labels";
import { useCachedFetch, mutate, mutatePrefix } from "@/lib/client-cache";
import { useDocumentTitle } from "@/lib/use-document-title";
import { reviewTask, applyTaskCard, refreshTaskViews } from "@/lib/task-actions";
import { postJson, deleteJson } from "@/lib/http";
import { closeSystemNotifications } from "@/lib/push-client";
import { istTime } from "@/lib/time";
import { AddToMeetingSheet } from "@/components/add-task-sheet";
import { PendingReleaseBanner } from "@/components/release-ui";
import { same } from "@/lib/use-discard-guard";
import { RelTime } from "@/components/ui/live-time";
import { cn } from "@/lib/cn";
import { STATUS_META, RELEASE_STATUS_META, formatDuration, secondsBetween, taskRef, LIMITS, NOTE_KIND_META } from "@/lib/domain";
import { IconEdit, IconTrash, IconCheck, IconX, IconPresentation, IconSend } from "@/components/ui/icons";
import type { TaskDetail, TaskComment } from "@/lib/types";

export default function TaskPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const key = `/api/tasks/${id}`;
  const { toast } = useToast();
  const gone = useRef(false);
  const { data, loading, error, refresh } = useCachedFetch<{ task: TaskDetail }>(key, {
    onError: (e) => {
      if ((e as { status?: number }).status === 404 && !gone.current) {
        gone.current = true;
        toast("That task was deleted, or it isn't on an app you belong to", "error");
        router.replace("/tasks");
      }
    },
  });
  const task = data?.task ?? null;
  useDocumentTitle(task ? `${taskRef(task.number)} · ${task.title} · FactoTasks` : "Task · FactoTasks");

  if (loading)
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  if (error && !task) return <LoadError title="Couldn't load this task" onRetry={refresh} />;
  if (!task) return null;
  return <TaskScreen task={task} cacheKey={key} />;
}

/** The edit form's values for a task, as they stand right now. */
function initialFrom(task: TaskDetail): TaskFormValues {
  return {
    title: task.title,
    description: task.description ?? "",
    targets: (task.targets ?? []).map((t) => ({ app_id: t.app.id, platform: t.platform })),
    type: task.type,
    priority: task.priority,
    assignee_ids: task.assignees.map((a) => a.id),
    due_date: task.due_date,
    labels: task.labels,
    estimate_hours: task.estimate_hours,
    series_id: task.series?.id ?? null,
    series_name: task.series?.name ?? null,
  };
}

function TaskScreen({ task, cacheKey }: { task: TaskDetail; cacheKey: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const { confirm } = useDialog();
  const { me, isAdmin } = useSession();
  // Meetings: admins, and the members who take part in a series.
  const canMeet = isAdmin || (me?.series_ids?.length ?? 0) > 0;
  // Opening a task reads what was about it: its inbox rows turn read and its system
  // notifications leave this device's tray (GitHub / Linear behaviour).
  const { data: badge } = useCachedFetch<{ unread?: number }>("/api/notifications?limit=1");
  // Keyed on the count: news about this task that arrives while it is open is read at once too.
  const unreadCount = badge?.unread ?? 0;
  const readFor = useRef<{ task: string; count: number } | null>(null);
  useEffect(() => {
    void closeSystemNotifications(`task-${task.id}`);
    if (unreadCount === 0) return;
    // The same count for the same task was already handled: no repeat request after our own refresh.
    if (readFor.current?.task === task.id && readFor.current.count === unreadCount) return;
    readFor.current = { task: task.id, count: unreadCount };
    void postJson("/api/notifications/read", { task_id: task.id }).then((r) => {
      if (!r.ok) return;
      mutate("/api/notifications?limit=1");
      mutatePrefix("/api/notifications?limit=30");
    });
  }, [task.id, unreadCount]);
  // The edit sheet's starting point, captured when it opens: the diff base for
  // the save and the form's initial values (a background refresh must not
  // move it under an open form).
  const [editInitial, setEditInitial] = useState<TaskFormValues | null>(null);
  const editing = editInitial !== null;
  const setEditing = (on: boolean) => setEditInitial(on ? initialFrom(task) : null);
  const [addingToMeeting, setAddingToMeeting] = useState(false);

  async function save(values: TaskFormValues): Promise<string | null> {
    // Only the keys that differ from the snapshot leave: a change a teammate
    // made while the sheet was open survives.
    const initial = editInitial ?? initialFrom(task);
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => !same(v, initial[k as keyof TaskFormValues])));
    if (Object.keys(changed).length === 0) {
      toast("Nothing changed");
      setEditing(false);
      return null;
    }
    const { ok, data } = await postJson<{ task?: TaskDetail; error?: string }>(cacheKey, changed, "PATCH");
    if (!ok) return data?.error || "Couldn't save the task.";
    toast("Saved");
    setEditing(false);
    if (data?.task) {
      mutate(cacheKey, { task: { ...task, ...data.task } });
      applyTaskCard(data.task);
    }
    refreshTaskViews(); // revalidates this key too

    return null;
  }

  async function remove() {
    if (!(await confirm({ title: `Delete ${taskRef(task.number)}?`, message: "Removes the task, its comments and attachments.", confirmLabel: "Delete", tone: "danger" }))) return;
    const { ok, data } = await deleteJson(cacheKey);
    if (ok) {
      toast(`${taskRef(task.number)} deleted`);
      mutatePrefix("/api/tasks");
      mutate("/api/dashboard");
      router.replace("/tasks");
    } else toast(data?.error || "Couldn't delete the task", "error");
  }

  const pending = task.requested_status;
  const iRequested = task.requested_by?.id === me?.id;

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <Breadcrumb items={[{ label: "Tasks", href: "/tasks" }, ...(task.app ? [{ label: task.app.name, href: `/apps/${task.app.id}` }] : []), { label: taskRef(task.number) }]} />

      {/* Header: title + the status pill that does the work */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold tabular-nums whitespace-nowrap text-ink-subtle">{taskRef(task.number)}</span>
          <StatusMenu task={task} size="md" canChange={task.can.status} />
          <div className="ml-auto flex items-center gap-2">
            {task.can.edit && (
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                <IconEdit size={14} /> Edit
              </Button>
            )}
            {task.can.delete && (
              <Button variant="danger" size="sm" onClick={remove} aria-label="Delete task" title="Delete task">
                <IconTrash size={14} />
              </Button>
            )}
          </div>
        </div>
        <h1 className={cn("break-words text-[20px] font-bold leading-tight tracking-[-0.02em] text-ink sm:text-[24px]", task.status === "cancelled" && "text-ink-muted line-through")}>{task.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-ink-muted">
          <TargetChips targets={task.targets} />
          <SeriesChip series={task.series} />
          <ReleaseProgress progress={task.release_progress} />
          <TypeBadge type={task.type} />
          <PriorityBadge priority={task.priority} />
          <DueChip task={task} />
          {task.labels.map((l) => (
            <Link key={l} href={`/tasks?label=${encodeURIComponent(l)}&scope=all`}>
              <LabelChip label={l} />
            </Link>
          ))}
        </div>
      </div>

      {pending && <RequestBanner task={task} isAdmin={isAdmin} iRequested={iRequested} cacheKey={cacheKey} />}
      <PendingReleaseBanner task={task} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
            {task.description ? <RichText text={task.description} /> : <p className="text-sm text-ink-subtle">No description.{task.can.edit ? " Click Edit to add one." : ""}</p>}
          </section>

          <TaskAttachments task={task} cacheKey={cacheKey} />

          {canMeet && (task.meetings.length > 0 || task.meeting_notes.length > 0 || task.status !== "cancelled") && (
            <section className="overflow-hidden rounded-xl border border-line bg-surface">
              <header className="flex items-center gap-2 border-b border-line/80 px-4 py-2 text-[13px] font-semibold text-ink">
                <IconPresentation size={15} className="text-ink-subtle" /> Meetings
                <button type="button" onClick={() => setAddingToMeeting(true)} className="ml-auto text-[12px] font-medium text-brand-700 hover:text-brand-800">
                  + Add to meeting
                </button>
              </header>
              {task.meetings.length > 0 ? (
                <ul className="divide-y divide-line/70 border-b border-line/70">
                  {task.meetings.map((mm) => (
                    <li key={mm.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-[13px]">
                      <Link href={`/meetings/${mm.id}`} className="font-medium text-ink hover:underline">
                        {mm.title}
                      </Link>
                      {mm.series && <SeriesBadge series={mm.series} />}
                      <MeetingStatusBadge status={mm.status} />
                      <span className="ml-auto text-[11.5px] text-ink-subtle">{istTime(mm.held_at).replace(/:\d\d (am|pm)/, " $1")}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                task.meeting_notes.length === 0 && <p className="px-4 py-3 text-[12.5px] text-ink-subtle">{task.series ? <>Attached to the <b className="font-semibold text-ink">{task.series.name}</b> series (Edit → Meeting): it joins that series&rsquo; meetings until it&rsquo;s done.</> : task.targets?.length ? "Not added to any meeting by hand. App tasks join the meetings whose scope covers their app automatically." : "Not on any meeting. Attach it to a meeting series from Edit → Meeting, or add it to one meeting by hand here."}</p>
              )}
              <ul className="divide-y divide-line/70">
                {task.meeting_notes.map((n) => (
                  <li key={n.id} className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-subtle">
                      <Badge tone={NOTE_KIND_META[n.kind].tone}>{NOTE_KIND_META[n.kind].label}</Badge>
                      <Link href={`/meetings/${n.meeting.id}`} className="font-medium text-ink-muted hover:text-ink">
                        {n.meeting.title}
                      </Link>
                      {n.author && <span>· {n.author.name}</span>}
                    </div>
                    <RichText text={n.body} className="mt-1" />
                    <NoteLink url={n.link_url} label={n.link_label} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <Comments task={task} cacheKey={cacheKey} />
          {addingToMeeting && <AddToMeetingSheet taskId={task.id} taskNumber={task.number} already={task.meetings.map((mm) => mm.id)} onClose={() => setAddingToMeeting(false)} />}
          <Timeline task={task} />
        </div>

        <Details task={task} />
      </div>

      {editing && (
        <TaskFormSheet mode="edit" initial={editInitial ?? undefined} onClose={() => setEditing(false)} onSubmit={save} />
      )}
    </div>
  );
}

function RequestBanner({ task, isAdmin, iRequested, cacheKey }: { task: TaskDetail; isAdmin: boolean; iRequested: boolean; cacheKey: string }) {
  const { toast } = useToast();
  const { prompt, confirm } = useDialog();
  const [busy, setBusy] = useState<string | null>(null);
  const to = task.requested_status!;

  async function act(action: "approve" | "reject" | "withdraw") {
    if (busy) return;
    let note: string | null = null;
    if (action === "reject") {
      note = await prompt({ title: `Send ${taskRef(task.number)} back`, message: "Tell them what to fix (optional).", placeholder: "e.g. Please also test on Android 10", confirmLabel: "Send back" });
      if (note === null) return;
    }
    if (action === "withdraw" && !(await confirm({ title: "Withdraw your request?", message: "The task stays as it is." }))) return;
    setBusy(action);
    const res = await reviewTask(task, action, note);
    setBusy(null);
    if (res.ok) {
      toast(action === "approve" ? "Approved" : action === "reject" ? "Sent back" : "Request withdrawn");
      mutate(cacheKey);
    } else toast(res.error || "Failed", "error");
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <Avatar user={task.requested_by} size="md" />
        <div className="min-w-0 text-sm text-ink">
          <b>{task.requested_by?.name ?? "Someone"}</b> wants this marked <b>{STATUS_META[to].label}</b>
          {task.requested_at && (
            <span className="text-ink-subtle">
              {" "}
              · <RelTime iso={task.requested_at} />
            </span>
          )}
          {task.request_note && <div className="mt-0.5 break-words text-ink-muted">“{task.request_note}”</div>}
          {!isAdmin && <div className="mt-0.5 text-xs text-ink-subtle">An admin reviews it; the status updates once approved.</div>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isAdmin ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => act("reject")} disabled={!!busy}>
              {busy === "reject" ? <Spinner /> : <IconX size={14} />} Send back
            </Button>
            <Button size="sm" onClick={() => act("approve")} disabled={!!busy}>
              {busy === "approve" ? <Spinner /> : <IconCheck size={14} />} Approve
            </Button>
          </>
        ) : iRequested ? (
          <Button variant="secondary" size="sm" onClick={() => act("withdraw")} disabled={!!busy}>
            {busy === "withdraw" ? <Spinner /> : "Withdraw"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-[13px]">
      <span className="shrink-0 text-ink-subtle">{label}</span>
      <span className="min-w-0 break-words text-right text-ink">{children}</span>
    </div>
  );
}

/** Facts + live durations in a compact sidebar. */
function Details({ task }: { task: TaskDetail }) {
  const label = useNameLabels();
  useClock();
  const now = new Date().toISOString();
  const active = Number(task.active_seconds) + (task.status === "in_progress" ? secondsBetween(task.status_since, now) : 0);
  const lead = task.completed_at ? secondsBetween(task.created_at, task.completed_at) : secondsBetween(task.created_at, now);
  const waited = task.requested_at && !task.completed_at ? secondsBetween(task.requested_at, now) : task.approved_at && task.completed_at ? secondsBetween(task.completed_at, task.approved_at) : null;

  return (
    <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
      {(task.targets?.length ?? 0) > 0 && (
        <section className="rounded-xl border border-line bg-surface px-4 py-3">
          <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-subtle">
            Where it ships
            {task.release_progress && task.release_progress.released > 0 && <span className="normal-case tracking-normal text-emerald-700">· {task.release_progress.released}/{task.release_progress.total} released</span>}
          </div>
          <ul className="divide-y divide-line/60">
            {task.targets.map((t) => (
              <li key={`${t.app.id}:${t.platform}`} className="flex items-center gap-2 py-1.5 text-[12.5px]">
                <AppTile name={t.app.name} color={t.app.color} iconUrl={t.app.icon_url} className="h-5 w-5 rounded-[5px] text-[8px]" />
                <Link href={`/apps/${t.app.id}`} className="min-w-0 flex-1 break-words font-medium leading-tight text-ink hover:underline">
                  {t.app.name}
                </Link>
                <PlatformBadge platform={t.platform} />
                {t.released_at ? (
                  <span className="shrink-0 font-medium text-emerald-700" title={istTime(t.released_at)}>
                    {t.release ? `Released · v${t.release.version_name}` : "Released"}
                  </span>
                ) : t.release ? (
                  <Link href={`/apps/${t.app.id}?tab=releases`} className="shrink-0 text-ink-muted hover:text-ink" title={RELEASE_STATUS_META[t.release.status].label}>
                    v{t.release.version_name} · {RELEASE_STATUS_META[t.release.status].label}
                  </Link>
                ) : (
                  <span className="shrink-0 text-ink-subtle">No release yet</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="rounded-xl border border-line bg-surface px-4 py-3">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-subtle">Assignees</div>
        {task.assignees.length ? (
          <ul className="flex flex-col gap-1.5">
            {task.assignees.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-[13px]">
                <Avatar user={a} size="sm" />
                <span className={cn("truncate", !a.is_active && "text-ink-subtle line-through")}>{a.name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-subtle">Unassigned</p>
        )}
      </section>
      <section className="rounded-xl border border-line bg-surface px-4 py-2 divide-y divide-line/70">
        <Row label="Created">
          <span title={istTime(task.created_at)}>
            <RelTime iso={task.created_at} />
            {task.created_by && <span className="text-ink-subtle"> by {label(task.created_by)}</span>}
          </span>
        </Row>
        {task.started_at && (
          <Row label="Started">
            <span title={istTime(task.started_at)}>
              <RelTime iso={task.started_at} />
            </span>
          </Row>
        )}
        {task.completed_at && (
          <Row label="Completed">
            <span title={istTime(task.completed_at)}>
              <RelTime iso={task.completed_at} />
            </span>
          </Row>
        )}
        {task.approved_by && (
          <Row label="Approved by">
            <span className="inline-flex items-center gap-1.5">
              <Avatar user={task.approved_by} size="xs" /> {task.approved_by.name}
            </span>
          </Row>
        )}
        <Row label={task.completed_at ? "Lead time" : "Age"}>
          <span className="tabular-nums">{formatDuration(lead)}</span>
        </Row>
        <Row label="Active time">
          <span className="tabular-nums" title="Time spent in “In progress”">
            {formatDuration(active)}
            {task.status === "in_progress" && <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500 align-middle" />}
          </span>
        </Row>
        {waited !== null && (
          <Row label={task.approved_at ? "Approval took" : "Waiting"}>
            <span className="tabular-nums">{formatDuration(waited)}</span>
          </Row>
        )}
        {task.estimate_hours != null && (
          <Row label="Estimate">
            <span className="tabular-nums">{task.estimate_hours} h</span>
          </Row>
        )}
      </section>
    </aside>
  );
}

function Comments({ task, cacheKey }: { task: TaskDetail; cacheKey: string }) {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const { me, isAdmin } = useSession();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);

  async function send() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    const { ok, data } = await postJson<{ comment?: TaskComment; error?: string }>(`/api/tasks/${task.id}/comments`, { body: text });
    setBusy(false);
    if (ok && data?.comment) {
      setBody("");
      mutate(cacheKey, { task: { ...task, comments: [...task.comments, data.comment], comment_count: task.comment_count + 1 } });
      mutate(cacheKey);
    } else toast(data?.error || "Couldn't post the comment", "error");
  }
  async function saveEdit() {
    if (!editing) return;
    const text = editing.body.trim();
    if (!text) return;
    const { ok, data } = await postJson(`/api/comments/${editing.id}`, { body: text }, "PATCH");
    if (ok) {
      setEditing(null);
      mutate(cacheKey);
    } else toast(data?.error || "Couldn't save", "error");
  }
  async function remove(c: TaskComment) {
    if (!(await confirm({ title: "Delete this comment?", confirmLabel: "Delete", tone: "danger" }))) return;
    const { ok, data } = await deleteJson(`/api/comments/${c.id}`);
    if (ok) mutate(cacheKey, { task: { ...task, comments: task.comments.filter((x) => x.id !== c.id), comment_count: Math.max(0, task.comment_count - 1) } });
    else toast(data?.error || "Couldn't delete", "error");
  }

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <header className="border-b border-line/80 px-4 py-2 text-[13px] font-semibold text-ink">
        Comments {task.comments.length > 0 && <span className="font-normal text-ink-subtle">{task.comments.length}</span>}
      </header>
      {task.comments.length > 0 && (
        <ul className="divide-y divide-line/70">
          {task.comments.map((c) => {
            const mine = c.author?.id === me?.id;
            return (
              <li key={c.id} className="flex gap-3 px-4 py-3">
                <Avatar user={c.author} size="sm" className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-[11.5px] text-ink-subtle">
                    <span className="text-[13px] font-medium text-ink">{c.author?.name ?? "Former teammate"}</span>
                    <span title={istTime(c.created_at)}>
                      <RelTime iso={c.created_at} />
                    </span>
                    {c.edited_at && <span>(edited)</span>}
                    {(mine || isAdmin) && !editing && (
                      <span className="ml-auto flex gap-2">
                        <button type="button" onClick={() => setEditing({ id: c.id, body: c.body })} className="font-medium hover:text-ink">
                          Edit
                        </button>
                        <button type="button" onClick={() => remove(c)} className="font-medium hover:text-red-600">
                          Delete
                        </button>
                      </span>
                    )}
                  </div>
                  {editing?.id === c.id ? (
                    <div className="mt-2 flex flex-col gap-2">
                      <Textarea value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} rows={3} maxLength={LIMITS.comment} autoFocus />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={saveEdit}>
                          Save
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <RichText text={c.body} className="mt-0.5" />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex gap-3 border-t border-line/80 px-4 py-3">
        <Avatar user={me} size="sm" className="mt-1 hidden sm:inline-flex" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder="Write a comment… (Ctrl+Enter)"
            maxLength={LIMITS.comment}
            className="py-2"
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={send} disabled={busy || !body.trim()}>
              {busy ? <Spinner /> : <IconSend size={14} />} Post
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

const KIND_LABEL: Record<TaskDetail["log"][number]["kind"], string> = {
  change: "changed status to",
  request: "requested",
  approve: "approved",
  reject: "sent back",
  withdraw: "withdrew",
};

function Timeline({ task }: { task: TaskDetail }) {
  const [open, setOpen] = useState(false);
  if (!task.log.length) return null;
  const shown = open ? task.log : task.log.slice(0, 3);
  return (
    <section className="rounded-xl border border-line bg-surface px-4 py-2">
      <ol>
        {shown.map((e) => (
          <li key={e.id} className="flex items-start gap-2.5 py-1.5 text-[13px]">
            <Avatar user={e.actor} size="xs" className="mt-0.5" />
            <div className="min-w-0 flex-1 break-words text-ink-muted">
              <span className="font-medium text-ink">{e.actor?.name ?? "Someone"}</span> {KIND_LABEL[e.kind]}{" "}
              {e.to_status && <span className="font-medium text-ink">{STATUS_META[e.to_status].label}</span>}
              {e.note && <span> — “{e.note}”</span>}
              <span className="text-ink-subtle" title={istTime(e.created_at)}>
                {" "}
                · <RelTime iso={e.created_at} />
              </span>
            </div>
          </li>
        ))}
      </ol>
      {task.log.length > 3 && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="py-1 text-xs font-medium text-brand-700 hover:text-brand-800">
          {open ? "Show less" : `Show all ${task.log.length} events`}
        </button>
      )}
    </section>
  );
}
