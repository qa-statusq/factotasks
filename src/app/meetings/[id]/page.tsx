"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, buttonClass } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { Breadcrumb, LoadError, Spinner, EmptyState } from "@/components/ui/misc";
import { PanelSkeleton } from "@/components/ui/skeleton";
import { Avatar } from "@/components/ui/avatar";
import { ReleaseStatusBadge, PlatformBadge, PriorityBadge, AppTile, TargetChips, ReleaseProgress, StatusBadge } from "@/components/ui/task-chips";
import { StatusMenu } from "@/components/status-menu";
import { DueChip, PILL_WIDTH } from "@/components/task-list";
import { NoteComposer, NoteList } from "@/components/meeting-notes";
import { MeetingRecordingsCard } from "@/components/recordings";
import { RecordButton, canRecordMeeting } from "@/components/recording-controls";
import { AddTaskSheet } from "@/components/add-task-sheet";
import { SeriesBadge, ScopeLabel, MeetingStatusBadge } from "@/components/meeting-series";
import { useToast } from "@/components/ui/toast";
import { ClampedText } from "@/components/ui/clamped-text";
import { prettyDate } from "@/components/release-ui";
import { tabMemSet } from "@/lib/compat";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { useCachedFetch, mutate } from "@/lib/client-cache";
import { useDocumentTitle } from "@/lib/use-document-title";
import { buildAgenda, notesByTask, nameLabels, packPeople, ownerText, type AgendaGroup } from "@/lib/meeting-agenda";
import { postJson, deleteJson } from "@/lib/http";
import { istTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import { LIMITS, taskRef } from "@/lib/domain";
import { useOnChange } from "@/lib/use-on-change";
import { IconMaximize, IconPrint, IconCheck, IconTrash, IconEdit, IconPresentation, IconChevronDown, IconPlus, IconX } from "@/components/ui/icons";
import type { AppOverview, Meeting, MeetingNote, MeetingPack, MeetingSeries, TaskCard } from "@/lib/types";

type Pack = MeetingPack & { workspace_name: string };
const fmt = (iso: string) => istTime(iso).replace(/:\d\d (am|pm)/, " $1");

export default function MeetingPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const key = `/api/meetings/${id}`;
  const { toast } = useToast();
  const { data, loading, error, refresh } = useCachedFetch<Pack>(key, {
    onError: (e) => {
      if ((e as { status?: number }).status === 404) {
        toast("That meeting no longer exists", "error");
        router.replace("/meetings");
      }
    },
  });
  useDocumentTitle(data ? `${data.meeting.title} · FactoTasks` : "Meeting · FactoTasks");
  if (loading) return <PanelSkeleton />;
  if (error && !data) return <LoadError title="Couldn't load this meeting" onRetry={refresh} />;
  if (!data) return null;
  return <MeetingScreen pack={data} cacheKey={key} />;
}

function MeetingScreen({ pack, cacheKey }: { pack: Pack; cacheKey: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const { confirm } = useDialog();
  const { isAdmin } = useSession();
  const m = pack.meeting;
  const { data: sd } = useCachedFetch<{ series: MeetingSeries[] }>("/api/meeting-series");
  // The pack carries the agenda; the meeting row (list endpoint) carries the closing rule.
  const { data: ml } = useCachedFetch<{ meetings: Meeting[] }>("/api/meetings");
  const row = ml?.meetings.find((x) => x.id === m.id);
  const seriesClose = sd?.series.find((x) => x.id === m.series_id)?.auto_close ?? true;
  const closesItself = row?.auto_close ?? seriesClose;
  const finalized = m.status === "finalized";
  // Closed = locked for everyone (an admin reopens to change anything), so the copy stays true.
  // Members of the series read the minutes, present, print, record and add tasks; everything else is the admins'.
  const readOnly = finalized || !isAdmin;
  const canAdd = !finalized;
  const [noteTask, setNoteTask] = useState<TaskCard | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { data: ad } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const agenda = useMemo(() => buildAgenda(pack), [pack]);
  const labels = useMemo(() => nameLabels(packPeople(pack)), [pack]);
  const notes = useMemo(() => notesByTask(pack.notes), [pack.notes]);
  const general = pack.notes.filter((n) => !n.task_id);

  async function patch(body: Record<string, unknown>, okMsg: string, k: string) {
    if (busy) return false;
    setBusy(k);
    const { ok, data } = await postJson(cacheKey, body, "PATCH");
    setBusy(null);
    if (ok) {
      toast(okMsg);
      mutate(cacheKey);
      mutate("/api/meetings");
      return true;
    }
    toast(data?.error || "Couldn't update", "error");
    return false;
  }
  async function finalize() {
    if (!(await confirm({ title: "Close this meeting?", message: "Closing locks the minutes as they stand right now. Open tasks are not affected — they simply carry into the next meeting.", confirmLabel: "Close meeting" }))) return;
    await patch({ status: "finalized" }, "Meeting closed", "fin");
  }
  const [editing, setEditing] = useState(false);
  async function remove() {
    if (!(await confirm({ title: "Delete this meeting?", message: "Its minutes are deleted too. Tasks are untouched.", confirmLabel: "Delete", tone: "danger" }))) return;
    const { ok, data } = await deleteJson(cacheKey);
    if (ok) {
      toast("Meeting deleted");
      mutate("/api/meetings");
      router.replace("/meetings");
    } else toast(data?.error || "Couldn't delete", "error");
  }

  const totalPending = pack.pending.length;
  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <Breadcrumb items={[{ label: "Meetings", href: "/meetings" }, { label: m.title }]} />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="break-words text-[20px] font-bold leading-tight tracking-[-0.02em] text-ink sm:text-[24px]">{m.title}</h1>
          <MeetingStatusBadge status={m.status} />
          <SeriesBadge series={pack.series} />
          {isAdmin && (
            <button type="button" onClick={() => setEditing(true)} className="rounded p-1 text-ink-subtle hover:text-ink" aria-label="Edit meeting" title="Edit meeting">
              <IconEdit size={14} />
            </button>
          )}
        </div>
        <p className="text-[13px] text-ink-muted">
          {fmt(m.held_at)} · covering {pack.previous_meeting ? `since the previous ${pack.series ? pack.series.name : "meeting"} (${fmt(pack.previous_meeting)})` : "the previous 7 days"}
          {!finalized && (closesItself ? " · live until the end of its day" : " · live until closed by hand")}
          {" · "}
          <ScopeLabel scope={m} apps={ad?.apps} className="align-middle" />
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/meetings/${m.id}/present`} onClick={() => tabMemSet("ft_deck_from", m.id)} className={buttonClass("primary", "sm")}>
            <IconMaximize size={14} /> Present
          </Link>
          <Link href={`/meetings/${m.id}/print`} target="_blank" rel="noopener" className={buttonClass("secondary", "sm")} title="Minutes as an A4 document — print or save as PDF">
            <IconPrint size={14} /> Print
          </Link>
          {canRecordMeeting(m) && <RecordButton meetingId={m.id} title={m.title} />}
          {canAdd && (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)} title="Pin any task to this meeting">
              <IconPlus size={14} /> Add task
            </Button>
          )}
          {isAdmin && !finalized && (
            <Button variant="secondary" size="sm" onClick={finalize} disabled={!!busy}>
              {busy === "fin" ? <Spinner /> : <IconCheck size={14} />} Close meeting
            </Button>
          )}
          {isAdmin && finalized && (
            <Button variant="secondary" size="sm" onClick={() => patch({ status: "open" }, "Reopened", "open")} disabled={!!busy}>
              Reopen
            </Button>
          )}
          {isAdmin && (
            <Button variant="danger" size="sm" onClick={remove} aria-label="Delete meeting" title="Delete meeting" className="ml-auto">
              <IconTrash size={14} />
            </Button>
          )}
        </div>
      </div>

      {/* Numbers strip */}
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line/70 sm:grid-cols-6 [&>*]:bg-surface">
        <Stat label="Done" value={pack.done.length} tone="success" />
        <Stat label="Pending" value={totalPending} />
        <Stat label="Carried" value={pack.carried.length} tone={pack.carried.length ? "warning" : undefined} />
        <Stat label="New" value={pack.new.length} />
        <Stat label="Overdue" value={pack.overdue.length} tone={pack.overdue.length ? "danger" : undefined} />
        <Stat label="Approvals" value={pack.approvals.length} tone={pack.approvals.length ? "warning" : undefined} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          {agenda.length === 0 ? (
            <EmptyState icon={<IconPresentation size={20} />} title="Nothing to discuss yet" description="Tasks created or completed and releases since the last meeting show up here, app by app." />
          ) : (
            agenda.map((g) => <AppSection key={g.key} group={g} notes={notes} labels={labels} cacheKey={cacheKey} readOnly={readOnly} onNote={setNoteTask} meetingId={m.id} />)
          )}

        </div>

        <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-6 xl:self-start">
          <section className="rounded-xl border border-line bg-surface p-4">
            <h2 className="mb-2 text-[13px] font-semibold text-ink">Minutes</h2>
            {!readOnly && <NoteComposer meetingId={m.id} cacheKey={cacheKey} task={noteTask} onClear={() => setNoteTask(null)} autoFocus={!!noteTask} />}
            {general.length ? (
              <div className={cn(!readOnly && "mt-3 border-t border-line/70 pt-3")}>
                <NoteList notes={[...general].reverse()} cacheKey={cacheKey} readOnly={readOnly} />
              </div>
            ) : !readOnly ? (
              <p className="mt-2 text-[12px] text-ink-subtle">Decisions, action items and blockers. Use <b>Note</b> on a task to pin one to it.</p>
            ) : (
              <p className="text-[12px] text-ink-subtle">{finalized ? "No minutes were written." : "No minutes yet — admins write them as the meeting goes."}</p>
            )}
          </section>

          <GeneralMinutes pack={pack} cacheKey={cacheKey} canEdit={isAdmin} />

          <MeetingRecordingsCard meetingId={m.id} />

          {pack.people.length > 0 && (
            <section className="overflow-hidden rounded-xl border border-line bg-surface">
              <header className="border-b border-line/80 px-4 py-2 text-[13px] font-semibold text-ink">People</header>
              <table className="w-full text-[13px]">
                <thead className="text-[10.5px] uppercase tracking-wide text-ink-subtle">
                  <tr>
                    <th className="px-4 py-1.5 text-left font-medium"></th>
                    <th className="px-2 py-1.5 text-right font-medium">Done</th>
                    <th className="px-2 py-1.5 text-right font-medium">Open</th>
                    <th className="px-4 py-1.5 text-right font-medium">Late</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/60">
                  {pack.people.map((p) => (
                    <tr key={p.id}>
                      <td className="px-4 py-1.5">
                        <Link href={`/tasks?assignee=${p.id}`} className="inline-flex items-center gap-2 hover:text-brand-700">
                          <Avatar user={p} size="xs" /> <span className="truncate">{p.name}</span>
                        </Link>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-emerald-700">{p.done}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.pending}</td>
                      <td className={cn("px-4 py-1.5 text-right tabular-nums", p.overdue > 0 && "text-red-600")}>{p.overdue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </aside>
      </div>
      {editing && (
        <EditMeetingSheet
          title={m.title}
          autoClose={row?.auto_close ?? null}
          seriesName={pack.series?.name ?? null}
          seriesAutoClose={seriesClose}
          busy={busy === "edit"}
          onClose={() => setEditing(false)}
          onSave={async (body) => {
            if (await patch(body, "Meeting updated", "edit")) setEditing(false);
          }}
        />
      )}
      {adding && <AddTaskSheet meetingId={m.id} cacheKey={cacheKey} pinned={pack.pinned ?? []} onClose={() => setAdding(false)} />}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" | "danger" }) {
  return (
    <div className="px-3 py-2.5 sm:px-4">
      <div className={cn("text-[20px] font-semibold leading-none tabular-nums", tone === "success" ? "text-emerald-700" : tone === "warning" ? "text-amber-700" : tone === "danger" ? "text-red-600" : "text-ink")}>{value}</div>
      <div className="mt-1 text-[10.5px] font-medium uppercase tracking-wide text-ink-subtle">{label}</div>
    </div>
  );
}

function AppSection({ group: g, notes, labels, cacheKey, readOnly, onNote, meetingId }: { group: AgendaGroup; notes: Map<string, MeetingNote[]>; labels: Map<string, string>; cacheKey: string; readOnly: boolean; onNote: (t: TaskCard) => void; meetingId: string }) {
  const [showDone, setShowDone] = useState(g.done.length <= 5);
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/80 bg-canvas/60 px-3 py-2 sm:px-4">
        <AppTile name={g.name} color={g.color} iconUrl={g.iconUrl} className="h-7 w-7 text-xs" />
        <span className="text-[14px] font-semibold text-ink">{g.name}</span>
        <span className="text-[12px] text-ink-subtle">
          {g.pending.length} pending{g.carried ? ` · ${g.carried} carried` : ""}
          {g.overdue ? <span className="text-red-600"> · {g.overdue} late</span> : null} · <span className="text-emerald-700">{g.done.length} done</span>
          {g.releases.length ? ` · ${g.releases.length} release${g.releases.length === 1 ? "" : "s"}` : ""}
        </span>
      </header>
      {g.releases.length > 0 && (
        <ul className="divide-y divide-line/60 border-b border-line/70 bg-canvas/40">
          {g.releases.map((r) => (
            <ReleaseRow key={r.id} release={r} />
          ))}
        </ul>
      )}
      {g.pending.length > 0 && (
        <ul className="divide-y divide-line/70">
          {g.pending.map((t) => (
            <AgendaRow key={t.id} task={t} notes={notes.get(t.id) || []} labels={labels} cacheKey={cacheKey} readOnly={readOnly} onNote={onNote} meetingId={meetingId} />
          ))}
        </ul>
      )}
      {g.done.length > 0 && (
        <>
          <button type="button" onClick={() => setShowDone((v) => !v)} className="flex w-full items-center gap-1.5 border-t border-line/70 bg-emerald-50/40 px-4 py-1.5 text-[12px] font-medium text-emerald-800 hover:bg-emerald-50">
            <IconChevronDown size={13} className={cn("transition-transform", !showDone && "-rotate-90")} /> Done since last meeting · {g.done.length}
          </button>
          {showDone && (
            <ul className="divide-y divide-line/70 border-t border-line/70">
              {g.done.map((t) => (
                <AgendaRow key={t.id} task={t} notes={notes.get(t.id) || []} labels={labels} cacheKey={cacheKey} readOnly={readOnly} onNote={onNote} meetingId={meetingId} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function ReleaseRow({ release: r }: { release: MeetingPack["releases"][number] }) {
  const desc = r.description?.trim();
  const when = r.status === "released" && r.released_at ? `Released ${fmt(r.released_at)}` : r.planned_date ? `Release date ${prettyDate(r.planned_date)}` : "No date yet";
  return (
    <li className="px-3 py-2.5 sm:px-4">
      <div className="flex items-start gap-3">
        <PlatformBadge platform={r.platform} label={false} className="mt-0.5 h-7 w-7 shrink-0 justify-center rounded-lg px-0 py-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={`/apps/${r.app.id}?tab=releases`} className="text-[14px] font-semibold tabular-nums text-ink hover:text-brand-700">
              v{r.version_name}
              {r.build_number ? <span className="ml-1 text-[12px] font-normal text-ink-subtle">({r.build_number})</span> : null}
            </Link>
            <ReleaseStatusBadge status={r.status} />
            <span className="text-[11.5px] text-ink-subtle">{when}</span>
          </div>
          {r.tasks && r.tasks.length > 0 && (
            <ul className="mt-1.5 divide-y divide-line/60 rounded-lg bg-surface ring-1 ring-inset ring-line/70">
              {r.tasks.map((t) => (
                <li key={t.id} className="px-2.5 py-1.5">
                  <div className="flex items-baseline gap-1.5 text-[12.5px]">
                    <span className="shrink-0 tabular-nums whitespace-nowrap text-ink-subtle">{taskRef(t.number)}</span>
                    <Link href={`/tasks/${t.id}`} className="min-w-0 break-words font-medium text-ink hover:text-brand-700">
                      {t.title}
                    </Link>
                    <StatusBadge status={t.status} className="ml-auto shrink-0" />
                  </div>
                  <ClampedText text={t.description} rich lines={2} className="mt-0.5 text-[12px] text-ink-muted" />
                </li>
              ))}
            </ul>
          )}
          {desc ? <ClampedText text={desc} lines={3} className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted" /> : !r.tasks?.length && <p className="mt-0.5 text-[12px] text-ink-subtle">No release notes.</p>}
        </div>
      </div>
    </li>
  );
}

/** Title and closing rule of one meeting. The closing rule follows the series unless set here. */
function EditMeetingSheet({ title, autoClose, seriesName, seriesAutoClose, busy, onClose, onSave }: { title: string; autoClose: boolean | null; seriesName: string | null; seriesAutoClose: boolean; busy: boolean; onClose: () => void; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [name, setName] = useState(title);
  const [rule, setRule] = useState<"series" | "auto" | "manual">(autoClose == null ? "series" : autoClose ? "auto" : "manual");
  const next = rule === "series" ? null : rule === "auto";
  const dirty = name.trim() !== title || next !== autoClose;
  const options: { id: "series" | "auto" | "manual"; label: string; hint: string }[] = [
    { id: "series", label: `Follow the series`, hint: `${seriesName ? `${seriesName} closes its meetings ` : "The series closes meetings "}${seriesAutoClose ? "by themselves at the end of their day" : "only when an admin closes them"}.` },
    { id: "auto", label: "Close by itself at the end of its day", hint: "The night after the meeting day it closes on its own, so the next meeting starts clean." },
    { id: "manual", label: "Stay open until closed by hand", hint: "It stays live, whatever the day, until an admin presses Close meeting." },
  ];
  return (
    <Sheet
      title="Edit meeting"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void onSave({ ...(name.trim() !== title ? { title: name.trim() } : {}), ...(next !== autoClose ? { auto_close: next } : {}) })} disabled={busy || !dirty || !name.trim()}>
            {busy ? <Spinner /> : <IconCheck size={14} />} Save
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">Title</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium text-ink">Closing</legend>
          <p className="mb-1 text-xs text-ink-subtle">How this meeting ends. Closing locks the minutes; open tasks carry into the next meeting either way.</p>
          {options.map((o) => (
            <label key={o.id} className={cn("flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors", rule === o.id ? "border-ink/30 bg-canvas" : "border-line hover:bg-canvas/60")}>
              <input type="radio" name="closing" value={o.id} checked={rule === o.id} onChange={() => setRule(o.id)} className="mt-1 accent-ink" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-ink">{o.label}</span>
                <span className="text-xs text-ink-subtle">{o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </div>
    </Sheet>
  );
}

function AgendaRow({ task: t, notes, labels, cacheKey, readOnly, onNote, meetingId }: { task: TaskCard; notes: MeetingNote[]; labels: Map<string, string>; cacheKey: string; readOnly: boolean; onNote: (t: TaskCard) => void; meetingId: string }) {
  const { me, isAdmin } = useSession();
  const { toast } = useToast();
  const [gone, setGone] = useState(false);
  async function unpin() {
    setGone(true); // leaves the agenda at once; comes back only if the server refuses
    const r = await postJson(`/api/meetings/${meetingId}/tasks`, { task_id: t.id }, "DELETE");
    if (r.ok) {
      mutate(cacheKey);
      mutate(`/api/tasks/${t.id}`);
      toast(`${taskRef(t.number)} removed from the meeting`);
    } else {
      setGone(false);
      toast(r.data?.error || "Couldn't remove", "error");
    }
  }
  const desc = t.description?.trim();
  if (gone) return null;
  return (
    <li className="px-3 py-2.5 sm:px-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <PriorityBadge priority={t.priority} compact className="shrink-0" />
            <Link href={`/tasks/${t.id}`} className="break-words text-[14px] font-medium text-ink hover:text-brand-700">
              <span className="mr-1.5 text-[12px] whitespace-nowrap text-ink-subtle">{taskRef(t.number)}</span>
              {t.title}
            </Link>
            {typeof t.carry === "number" && t.carry > 0 && (
              <Badge tone={t.carry >= 3 ? "danger" : "warning"} title={`Pending for ${t.carry} earlier meeting${t.carry === 1 ? "" : "s"} of this series`}>
                {t.carry}× carried
              </Badge>
            )}
            {t.pinned && (
              <Badge tone="neutral" title="Added to this meeting by hand" className="gap-1">
                Pinned
                {!readOnly && (
                  <button type="button" onClick={unpin} className="-mr-0.5 rounded p-px hover:text-red-600" aria-label="Remove from meeting">
                    <IconX size={11} />
                  </button>
                )}
              </Badge>
            )}
          </div>
          <ClampedText text={desc} lines={2} className="mt-1 text-[12.5px] leading-relaxed text-ink-muted" />
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-ink-subtle">
            <span>{ownerText(t.assignees, labels) || "unassigned"}</span>
            {(t.targets?.length ?? 0) > 1 ? <TargetChips targets={t.targets} compact /> : <PlatformBadge platform={t.platform} label={false} />}
            <ReleaseProgress progress={t.release_progress} />
            <DueChip task={t} />
            {t.requested_status && <span className="text-amber-700">awaiting approval</span>}
          </div>
          {notes.length > 0 && (
            <div className="mt-2 rounded-lg bg-canvas/70 px-3 py-2">
              <NoteList notes={notes} cacheKey={cacheKey} readOnly={readOnly} compact />
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <StatusMenu task={t} canChange={isAdmin || t.assignees.some((a) => a.id === me?.id)} className={PILL_WIDTH} />
          {!readOnly && (
            <button type="button" onClick={() => onNote(t)} className="text-[11.5px] font-medium text-brand-700 hover:text-brand-800">
              + Note
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function GeneralMinutes({ pack, cacheKey, canEdit }: { pack: MeetingPack; cacheKey: string; canEdit: boolean }) {
  const { toast } = useToast();
  const [text, setText] = useState(pack.meeting.notes ?? "");
  const [saving, setSaving] = useState(false);
  useOnChange(pack.meeting.notes ?? "", () => setText(pack.meeting.notes ?? ""));
  async function save() {
    if ((pack.meeting.notes ?? "") === text) return;
    setSaving(true);
    const { ok, data } = await postJson(cacheKey, { notes: text }, "PATCH");
    setSaving(false);
    if (ok) mutate(cacheKey);
    else toast(data?.error || "Couldn't save", "error");
  }
  if (!canEdit && !pack.meeting.notes) return null;
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h2 className="mb-2 flex items-center justify-between text-[13px] font-semibold text-ink">
        Agenda & remarks {saving && <Spinner className="h-3 w-3 text-ink-subtle" />}
      </h2>
      {canEdit ? (
        <Textarea value={text} onChange={(e) => setText(e.target.value)} onBlur={save} rows={4} maxLength={LIMITS.meetingNotes} placeholder="Announcements, anything not tied to a task. Saves when you click away." className="text-[13px]" />
      ) : (
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">{pack.meeting.notes}</p>
      )}
    </section>
  );
}
