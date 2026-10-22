"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/field";
import { Dropdown } from "@/components/ui/dropdown";
import { Spinner } from "@/components/ui/misc";
import { Avatar } from "@/components/ui/avatar";
import { RichText } from "@/components/ui/rich-text";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { mutate } from "@/lib/client-cache";
import { postJson, deleteJson } from "@/lib/http";
import { istTime } from "@/lib/time";
import { RelTime } from "@/components/ui/live-time";
import { cn } from "@/lib/cn";
import { LIMITS, NOTE_KINDS, NOTE_KIND_META, taskRef, type NoteKind } from "@/lib/domain";
import { IconSend, IconX, IconEdit, IconTrash } from "@/components/ui/icons";
import type { MeetingNote, TaskCard } from "@/lib/types";

const KIND_OPTIONS = NOTE_KINDS.map((k) => ({ value: k, label: NOTE_KIND_META[k].label }));

/** Composer for one minute line — general, or pinned to a task. */
export function NoteComposer({
  meetingId,
  cacheKey,
  task,
  onClear,
  autoFocus,
  defaultKind = "note",
}: {
  meetingId: string;
  cacheKey: string;
  task?: TaskCard | null;
  onClear?: () => void;
  autoFocus?: boolean;
  defaultKind?: NoteKind;
}) {
  const { toast } = useToast();
  const [kind, setKind] = useState<NoteKind>(defaultKind);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    const { ok, data } = await postJson(`/api/meetings/${meetingId}/notes`, { body: text, kind, task_id: task?.id ?? null });
    setBusy(false);
    if (ok) {
      setBody("");
      mutate(cacheKey);
      if (task) mutate(`/api/tasks/${task.id}`);
      toast("Noted");
      onClear?.();
    } else toast(data?.error || "Couldn't save the note", "error");
  }

  return (
    <div className="flex flex-col gap-2">
      {task && (
        <div className="flex items-center gap-2 rounded-lg bg-brand-50 px-2.5 py-1.5 text-xs text-brand-800 ring-1 ring-inset ring-brand-100">
          <span className="font-semibold">{taskRef(task.number)}</span>
          <span className="truncate">{task.title}</span>
          {onClear && (
            <button type="button" onClick={onClear} className="ml-auto rounded p-0.5 hover:text-brand-900" aria-label="Clear task">
              <IconX size={13} />
            </button>
          )}
        </div>
      )}
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
        autoFocus={autoFocus}
        placeholder={task ? `What was said about ${taskRef(task.number)}? (Ctrl+Enter)` : "Decision, action item, blocker or a general note… (Ctrl+Enter)"}
        maxLength={LIMITS.note}
        className="text-[13px]"
      />
      <div className="flex items-center gap-2">
        <div className="w-36">
          <Dropdown value={kind} onChange={(v) => setKind(v as NoteKind)} options={KIND_OPTIONS} className="[&>button]:h-9 [&>button]:text-[13px]" />
        </div>
        <Button size="sm" onClick={send} disabled={busy || !body.trim()} className="ml-auto">
          {busy ? <Spinner /> : <IconSend size={14} />} Add
        </Button>
      </div>
    </div>
  );
}

/** A list of minute lines. The author (or an admin) can edit or delete each one, inline. */
export function NoteList({ notes, cacheKey, readOnly, compact }: { notes: MeetingNote[]; cacheKey: string; readOnly?: boolean; compact?: boolean }) {
  const { me, isAdmin } = useSession();
  if (!notes.length) return null;
  return (
    <ul className={cn("flex flex-col", compact ? "gap-1.5" : "divide-y divide-line/70")}>
      {notes.map((n) => (
        <NoteRow key={n.id} note={n} cacheKey={cacheKey} compact={compact} canEdit={!readOnly && (n.author?.id === me?.id || isAdmin)} />
      ))}
    </ul>
  );
}

function NoteRow({ note: n, cacheKey, compact, canEdit }: { note: MeetingNote; cacheKey: string; compact?: boolean; canEdit: boolean }) {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<NoteKind>(n.kind);
  const [body, setBody] = useState(n.body);
  const [busy, setBusy] = useState(false);

  function refresh() {
    mutate(cacheKey);
    if (n.task_id) mutate(`/api/tasks/${n.task_id}`);
  }
  function startEdit() {
    setKind(n.kind);
    setBody(n.body);
    setEditing(true);
  }
  async function save() {
    const text = body.trim();
    if (!text || busy) return;
    if (text === n.body && kind === n.kind) return setEditing(false);
    setBusy(true);
    const { ok, data } = await postJson(`/api/meeting-notes/${n.id}`, { body: text, kind }, "PATCH");
    setBusy(false);
    if (ok) {
      setEditing(false);
      refresh();
      toast("Note updated");
    } else toast(data?.error || "Couldn't update the note", "error");
  }
  async function remove() {
    if (!(await confirm({ title: "Delete this note?", message: "It disappears from the minutes and from the task.", confirmLabel: "Delete", tone: "danger" }))) return;
    const { ok, data } = await deleteJson(`/api/meeting-notes/${n.id}`);
    if (ok) refresh();
    else toast(data?.error || "Couldn't delete", "error");
  }

  if (editing) {
    return (
      <li className={cn("flex flex-col gap-2", compact ? "text-sm" : "py-2.5")}>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") setEditing(false);
          }}
          rows={2}
          autoFocus
          maxLength={LIMITS.note}
          className="text-[13px]"
        />
        <div className="flex items-center gap-2">
          <div className="w-36">
            <Dropdown value={kind} onChange={(v) => setKind(v as NoteKind)} options={KIND_OPTIONS} className="[&>button]:h-8 [&>button]:text-[12.5px]" />
          </div>
          <Button size="sm" variant="secondary" onClick={() => setEditing(false)} disabled={busy} className="ml-auto">
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={busy || !body.trim()}>
            {busy ? <Spinner /> : "Save"}
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className={cn("group flex items-start gap-2.5", compact ? "text-sm" : "py-2.5")}>
      <Badge tone={NOTE_KIND_META[n.kind].tone} className="mt-[2px] shrink-0">
        {NOTE_KIND_META[n.kind].label}
      </Badge>
      <div className="min-w-0 flex-1">
        {n.task && !compact && (
          <Link href={`/tasks/${n.task.id}`} className="text-xs font-semibold text-brand-700 hover:text-brand-800">
            {taskRef(n.task.number)} · {n.task.title}
          </Link>
        )}
        <RichText text={n.body} className={compact ? "text-[13px]" : undefined} />
        {!compact && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-subtle">
            {n.author && (
              <>
                <Avatar user={n.author} size="xs" /> {n.author.name} ·
              </>
            )}
            <span title={istTime(n.created_at)}>
              <RelTime iso={n.created_at} />
            </span>
            {n.about && <span>· about {n.about.name}</span>}
          </div>
        )}
      </div>
      {canEdit && (
        <span className="-mr-1 -mt-0.5 flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <button type="button" onClick={startEdit} className="rounded-md p-1 text-ink-subtle hover:bg-canvas hover:text-ink" aria-label="Edit note" title="Edit">
            <IconEdit size={14} />
          </button>
          <button type="button" onClick={remove} className="rounded-md p-1 text-ink-subtle hover:bg-red-50 hover:text-red-600" aria-label="Delete note" title="Delete">
            <IconTrash size={14} />
          </button>
        </span>
      )}
    </li>
  );
}
