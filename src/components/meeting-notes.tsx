"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea } from "@/components/ui/field";
import { NoteLink, NOTE_LINK_DEFAULT_LABEL } from "@/components/ui/note-link";
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
import { scrollIntoViewNearest } from "@/lib/compat";
import { RelTime } from "@/components/ui/live-time";
import { cn } from "@/lib/cn";
import { LIMITS, NOTE_KINDS, NOTE_KIND_META, taskRef, type NoteKind } from "@/lib/domain";
import { IconSend, IconX, IconEdit, IconTrash, IconLink } from "@/components/ui/icons";
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
  // "+ Note" on a task row re-targets this composer: bring it into view and focus it.
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!task) return;
    const el = areaRef.current;
    if (!el) return;
    scrollIntoViewNearest(el);
    el.focus({ preventScroll: true });
  }, [task]);
  const { toast } = useToast();
  const [kind, setKind] = useState<NoteKind>(defaultKind);
  const [body, setBody] = useState("");
  const [link, setLink] = useState<{ url: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    const text = body.trim();
    const url = link?.url.trim() || null;
    if ((!text && !url) || busy) return;
    setBusy(true);
    const { ok, data } = await postJson(`/api/meetings/${meetingId}/notes`, { body: text, kind, task_id: task?.id ?? null, link_url: url, link_label: link?.label.trim() || null });
    setBusy(false);
    if (ok) {
      setBody("");
      setLink(null);
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
        ref={areaRef}
        autoFocus={autoFocus}
        placeholder={link ? "What is this link? (optional)" : task ? `What was said about ${taskRef(task.number)}? (Ctrl+Enter)` : "Decision, action item, blocker or a general note… (Ctrl+Enter)"}
        maxLength={LIMITS.note}
        className="text-[13px]"
      />
      {link && <LinkFields link={link} onChange={setLink} onRemove={() => setLink(null)} />}
      <div className="flex items-center gap-2">
        <div className="w-36">
          <Dropdown value={kind} onChange={(v) => setKind(v as NoteKind)} options={KIND_OPTIONS} className="[&>button]:h-9 [&>button]:text-[13px]" />
        </div>
        {!link && (
          <button type="button" onClick={() => setLink({ url: "", label: "" })} className="inline-flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-[12.5px] font-medium text-ink-muted hover:bg-canvas hover:text-ink" title="Attach a link to this note — a finding, a document, a ticket">
            <IconLink size={13} /> Add link
          </button>
        )}
        <Button size="sm" onClick={send} disabled={busy || (!body.trim() && !link?.url.trim())} className="ml-auto">
          {busy ? <Spinner /> : <IconSend size={14} />} Add
        </Button>
      </div>
    </div>
  );
}

/** URL + optional button text for the link behind a note. */
function LinkFields({ link, onChange, onRemove }: { link: { url: string; label: string }; onChange: (l: { url: string; label: string }) => void; onRemove: () => void }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-canvas p-2 ring-1 ring-inset ring-line">
      <Input value={link.url} onChange={(e) => onChange({ ...link, url: e.target.value })} placeholder="https://… (finding, document, ticket)" inputMode="url" maxLength={LIMITS.noteLink} autoFocus className="h-8 w-full text-[12.5px]" aria-label="Link URL" />
      <div className="flex items-center gap-1.5">
        <Input value={link.label} onChange={(e) => onChange({ ...link, label: e.target.value })} placeholder={`Button text · ${NOTE_LINK_DEFAULT_LABEL}`} maxLength={LIMITS.noteLinkLabel} className="h-8 min-w-0 flex-1 text-[12.5px]" aria-label="Link button text" />
        <button type="button" onClick={onRemove} className="shrink-0 rounded-md p-1 text-ink-subtle hover:bg-surface hover:text-ink" aria-label="Remove link" title="Remove link">
          <IconX size={14} />
        </button>
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
  const [link, setLink] = useState<{ url: string; label: string } | null>(n.link_url ? { url: n.link_url, label: n.link_label ?? "" } : null);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);

  function refresh() {
    mutate(cacheKey);
    if (n.task_id) mutate(`/api/tasks/${n.task_id}`);
  }
  function startEdit() {
    setKind(n.kind);
    setBody(n.body);
    setLink(n.link_url ? { url: n.link_url, label: n.link_label ?? "" } : null);
    setEditing(true);
  }
  async function save() {
    const text = body.trim();
    const url = link?.url.trim() || null;
    if ((!text && !url) || busy) return;
    const label = (url && link?.label.trim()) || null;
    if (text === n.body && kind === n.kind && url === n.link_url && label === (n.link_label || null)) return setEditing(false);
    setBusy(true);
    const { ok, data } = await postJson(`/api/meeting-notes/${n.id}`, { body: text, kind, link_url: url, link_label: label }, "PATCH");
    setBusy(false);
    if (ok) {
      setEditing(false);
      refresh();
      toast("Note updated");
    } else toast(data?.error || "Couldn't update the note", "error");
  }
  async function remove() {
    if (!(await confirm({ title: "Delete this note?", message: "It disappears from the minutes and from the task.", confirmLabel: "Delete", tone: "danger" }))) return;
    setGone(true); // goes at once; comes back only if the server refuses
    const { ok, data } = await deleteJson(`/api/meeting-notes/${n.id}`);
    if (ok) refresh();
    else {
      setGone(false);
      toast(data?.error || "Couldn't delete", "error");
    }
  }

  if (gone) return null;
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
        {link && <LinkFields link={link} onChange={setLink} onRemove={() => setLink(null)} />}
        <div className="flex items-center gap-2">
          <div className="w-36">
            <Dropdown value={kind} onChange={(v) => setKind(v as NoteKind)} options={KIND_OPTIONS} className="[&>button]:h-8 [&>button]:text-[12.5px]" />
          </div>
          {!link && (
            <button type="button" onClick={() => setLink({ url: "", label: "" })} className="inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-[12px] font-medium text-ink-muted hover:bg-canvas hover:text-ink">
              <IconLink size={13} /> Add link
            </button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setEditing(false)} disabled={busy} className="ml-auto">
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={busy || (!body.trim() && !link?.url.trim())}>
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
        <NoteLink url={n.link_url} label={n.link_label} className={n.body.trim() ? "mt-1" : "mt-0.5"} />
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
