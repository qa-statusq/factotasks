"use client";

import { useEffect, useState } from "react";
import { Sheet } from "@/components/ui/sheet";
import { Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Spinner, LoadError } from "@/components/ui/misc";
import { AppTile, PriorityBadge } from "@/components/ui/task-chips";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { mutate, useCachedFetch } from "@/lib/client-cache";
import { postJson } from "@/lib/http";
import { STATUS_META, taskRef } from "@/lib/domain";
import { toneClass } from "@/components/status-menu";
import { cn } from "@/lib/cn";
import { IconSearch, IconCheck } from "@/components/ui/icons";
import { istTime } from "@/lib/time";
import type { Meeting, TaskCard } from "@/lib/types";

/**
 * Pin any task to a meeting. Search by title or number across every task
 * (open first), click to add; already-pinned ones show a tick.
 */
export function AddTaskSheet({ meetingId, cacheKey, pinned, onClose }: { meetingId: string; cacheKey: string; pinned: string[]; onClose: () => void }) {
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"open" | "all">("open");
  const [results, setResults] = useState<TaskCard[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [local, setLocal] = useState<string[]>(pinned);

  useEffect(() => {
    const ctrl = new AbortController();
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/tasks?scope=${scope}&limit=25&sort=updated&q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal, credentials: "same-origin" });
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { tasks: TaskCard[] };
        setResults(data.tasks);
      } catch {
        if (!ctrl.signal.aborted) setResults([]);
      }
    }, q ? 180 : 0);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [q, scope]);

  async function pin(t: TaskCard) {
    if (busy) return;
    const on = local.includes(t.id);
    setBusy(t.id);
    const r = await postJson(`/api/meetings/${meetingId}/tasks`, { task_id: t.id }, on ? "DELETE" : "POST");
    setBusy(null);
    if (r.ok) {
      setLocal((l) => (on ? l.filter((x) => x !== t.id) : [...l, t.id]));
      mutate(cacheKey);
      mutate(`/api/tasks/${t.id}`);
      toast(on ? `${taskRef(t.number)} removed` : `${taskRef(t.number)} added to the meeting`);
    } else toast(r.data?.error || "Couldn't update", "error");
  }

  return (
    <Sheet title="Add tasks to this meeting" description="Pinned tasks stay on the agenda whatever their app or date." onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="relative">
          <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title or T-number…" className="pl-9" autoFocus />
        </div>
        <div className="flex items-center gap-1 text-[12px]">
          {(["open", "all"] as const).map((s) => (
            <button key={s} type="button" onClick={() => setScope(s)} className={cn("rounded-md px-2 py-1 font-medium", scope === s ? "bg-ink text-white" : "text-ink-muted hover:bg-canvas hover:text-ink")}>
              {s === "open" ? "Open tasks" : "All tasks"}
            </button>
          ))}
        </div>
        {results === null ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : results.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-subtle">No tasks match.</p>
        ) : (
          <ul className="divide-y divide-line/70 overflow-hidden rounded-xl border border-line bg-surface">
            {results.map((t) => {
              const on = local.includes(t.id);
              return (
                <li key={t.id}>
                  <button type="button" onClick={() => pin(t)} disabled={busy === t.id} className={cn("flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-canvas/70", on && "bg-emerald-50/50")}>
                    <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-md ring-1 ring-inset", on ? "bg-emerald-600 text-white ring-emerald-600" : "bg-surface ring-line")}>{busy === t.id ? <Spinner /> : on ? <IconCheck size={12} /> : null}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <PriorityBadge priority={t.priority} compact className="shrink-0" />
                        <span className="text-[12px] tabular-nums text-ink-subtle">{taskRef(t.number)}</span>
                        <span className="break-words text-[13.5px] font-medium text-ink">{t.title}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-subtle">
                        {t.app ? (
                          <>
                            <AppTile name={t.app.name} color={t.app.color} iconUrl={t.app.icon_url} className="h-3.5 w-3.5 rounded-[3px] text-[7px]" /> {t.app.name}
                          </>
                        ) : (
                          "General"
                        )}
                        {t.assignees.length > 0 && <span>· {t.assignees.map((a) => a.name.split(" ")[0]).join(", ")}</span>}
                      </div>
                    </div>
                    <Badge className={cn("shrink-0", toneClass(t.status))}>{STATUS_META[t.status].label}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/** From a task: pick an open meeting to pin it to. */
export function AddToMeetingSheet({ taskId, taskNumber, already, onClose }: { taskId: string; taskNumber: number; already: string[]; onClose: () => void }) {
  const { toast } = useToast();
  const { data, error: mErr, refresh: mRetry } = useCachedFetch<{ meetings: Meeting[] }>("/api/meetings");
  const [busy, setBusy] = useState<string | null>(null);
  const [local, setLocal] = useState<string[]>(already);
  const open = (data?.meetings ?? []).filter((m) => m.status === "open");

  async function toggle(m: Meeting) {
    if (busy) return;
    const on = local.includes(m.id);
    setBusy(m.id);
    const r = await postJson(`/api/meetings/${m.id}/tasks`, { task_id: taskId }, on ? "DELETE" : "POST");
    setBusy(null);
    if (r.ok) {
      setLocal((l) => (on ? l.filter((x) => x !== m.id) : [...l, m.id]));
      mutate(`/api/tasks/${taskId}`);
      mutate(`/api/tasks/${taskNumber}`); // the page may be cached under its T-number
      mutate(`/api/meetings/${m.id}`);
      toast(on ? `Removed from “${m.title}”` : `${taskRef(taskNumber)} added to “${m.title}”`);
    } else toast(r.data?.error || "Couldn't update", "error");
  }

  return (
    <Sheet title="Add to a meeting" description="Open meetings only. The task joins that meeting's agenda whatever its app or date." onClose={onClose}>
      {!data && mErr ? (
        <LoadError title="Couldn't load meetings" onRetry={mRetry} />
      ) : !data ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : open.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-subtle">No open meetings. Create one under Meetings first.</p>
      ) : (
        <ul className="divide-y divide-line/70 overflow-hidden rounded-xl border border-line bg-surface">
          {open.map((m) => {
            const on = local.includes(m.id);
            return (
              <li key={m.id}>
                <button type="button" onClick={() => toggle(m)} disabled={busy === m.id} className={cn("flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-canvas/70", on && "bg-emerald-50/50")}>
                  <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-md ring-1 ring-inset", on ? "bg-emerald-600 text-white ring-emerald-600" : "bg-surface ring-line")}>{busy === m.id ? <Spinner /> : on ? <IconCheck size={12} /> : null}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium text-ink">
                      {m.title}
                      {m.series && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-muted">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.series.color }} /> {m.series.name}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-ink-subtle">{istTime(m.held_at).replace(/:\d\d (am|pm)/, " $1")}</div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Sheet>
  );
}
