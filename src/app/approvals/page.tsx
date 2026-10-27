"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader, LoadError, Spinner, EmptyState } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { TaskList, RequestSummary } from "@/components/task-list";
import { AppTile, PlatformBadge, StatusBadge } from "@/components/ui/task-chips";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { useCachedFetch, mutate, mutatePrefix } from "@/lib/client-cache";
import { postJson } from "@/lib/http";
import { When } from "@/components/ui/live-time";
import { taskRef } from "@/lib/domain";
import { cn } from "@/lib/cn";
import { prettyDate } from "@/components/release-ui";
import { IconUserCheck, IconRocket, IconCheck } from "@/components/ui/icons";
import type { Release, TaskCard } from "@/lib/types";

export default function ApprovalsPage() {
  const router = useRouter();
  const { me, isAdmin, loading: sessionLoading, error: sessionError, refresh: sessionRefresh } = useSession();
  const { data, loading, error, refresh } = useCachedFetch<{ tasks: TaskCard[] }>(isAdmin ? "/api/tasks?scope=approvals&sort=updated" : null);
  const { data: rd, loading: rLoading, error: rError, refresh: rRefresh } = useCachedFetch<{ releases: Release[] }>(isAdmin ? "/api/releases?scope=requests" : null);
  const { toast } = useToast();
  const { prompt, confirm } = useDialog();
  const [busy, setBusy] = useState<string | null>(null);

  // Members are sent home from an effect, never from render (React warns about
  // updating the Router while this component renders).
  useEffect(() => {
    if (!sessionLoading && me && !isAdmin) router.replace("/");
  }, [sessionLoading, me, isAdmin, router]);
  if (sessionError) return <LoadError title="Couldn't check who you are" onRetry={sessionRefresh} />;
  if (!sessionLoading && !isAdmin) return null;

  function done() {
    mutatePrefix("/api/tasks");
    mutatePrefix("/api/releases");
    mutate("/api/dashboard");
    mutate("/api/notifications?limit=1");
  }

  async function decide(t: TaskCard, action: "approve" | "reject") {
    if (busy) return;
    let note: string | null = null;
    if (action === "reject") {
      note = await prompt({ title: `Send ${taskRef(t.number)} back`, message: "Tell them what to fix (optional).", placeholder: "e.g. Also test on Android 10", confirmLabel: "Send back" });
      if (note === null) return;
    }
    setBusy(t.id);
    const { ok, data: res } = await postJson(`/api/tasks/${t.id}/review`, { action, note });
    setBusy(null);
    if (ok) {
      toast(action === "approve" ? `${taskRef(t.number)} approved` : `${taskRef(t.number)} sent back`);
      done();
    } else toast(res?.error || "Couldn't update the task", "error");
  }

  async function decideRelease(r: Release, action: "approve" | "reject") {
    if (busy) return;
    const open = (r.tasks ?? []).filter((t) => !t.released_at);
    let note: string | null = null;
    if (action === "reject") {
      note = await prompt({ title: `Send v${r.version_name} back`, message: "Tell them what to fix (optional).", placeholder: "e.g. Wait for the store review", confirmLabel: "Send back" });
      if (note === null) return;
    } else if (!(await confirm({ title: `Approve ${r.app?.name ?? ""} v${r.version_name} as released?`, message: open.length ? `${open.length} task${open.length === 1 ? "" : "s"} will be marked shipped here (open ones become done): ${open.map((t) => taskRef(t.number)).join(", ")}.` : "No tasks are linked to this version; only its status changes.", confirmLabel: "Approve & release" }))) return;
    setBusy(r.id);
    const { ok, data: res } = await postJson<{ error?: string; closed?: number }>(`/api/releases/${r.id}/review`, { action, note });
    setBusy(null);
    if (ok) {
      if (action === "approve") toast(`v${r.version_name} released`, "success", res?.closed ? `${res.closed} task${res.closed === 1 ? "" : "s"} marked done.` : undefined);
      else toast("Release request sent back");
      done();
    } else toast(res?.error || "Couldn't update the release", "error");
  }

  const tasks = data?.tasks ?? [];
  const releases = rd?.releases ?? [];
  const nothing = tasks.length === 0 && releases.length === 0;
  const total = tasks.length + releases.length;

  /** Every request at once, in order: tasks, then releases (each release also ships its linked tasks). */
  async function approveAll() {
    if (busy || total < 2) return;
    const shipping = releases.reduce((n, r) => n + (r.tasks ?? []).filter((t) => !t.released_at).length, 0);
    const parts = [
      tasks.length ? `${tasks.length} task status change${tasks.length === 1 ? "" : "s"} will be applied.` : "",
      releases.length ? `${releases.length} release${releases.length === 1 ? "" : "s"} will be marked released${shipping ? `, shipping ${shipping} linked task${shipping === 1 ? "" : "s"}` : ""}.` : "",
    ].filter(Boolean);
    if (!(await confirm({ title: `Approve all ${total} requests?`, message: parts.join(" "), confirmLabel: "Approve all" }))) return;
    setBusy("all");
    let ok = 0;
    const failed: string[] = [];
    for (const t of tasks) {
      const r = await postJson(`/api/tasks/${t.id}/review`, { action: "approve", note: null });
      if (r.ok) ok++;
      else failed.push(taskRef(t.number));
    }
    for (const r of releases) {
      const res = await postJson(`/api/releases/${r.id}/review`, { action: "approve", note: null });
      if (res.ok) ok++;
      else failed.push(`${r.app?.name ?? "App"} v${r.version_name}`);
    }
    setBusy(null);
    done();
    if (failed.length) toast(`${ok} approved · couldn't approve ${failed.join(", ")}`, "error");
    else toast(`${ok} request${ok === 1 ? "" : "s"} approved`, "success");
  }

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <PageHeader
        title="Approvals"
        description="Status changes and releases your teammates have requested. Approving applies them; sending back clears the request with your note."
        actions={
          total > 1 ? (
            <Button onClick={approveAll} disabled={!!busy}>
              {busy === "all" ? <Spinner /> : <IconCheck size={15} />} Approve all · {total}
            </Button>
          ) : undefined
        }
      />
      {loading || rLoading || sessionLoading ? (
        <ListSkeleton rows={5} />
      ) : (error && !data) || (rError && !rd) ? (
        <LoadError title="Couldn't load the queue" onRetry={() => { refresh(); rRefresh(); }} />
      ) : nothing ? (
        <EmptyState icon={<IconUserCheck size={20} />} title="Nothing waiting for you" description="When a teammate marks a task done or a version released, it shows up here for a quick review." />
      ) : (
        <>
          {releases.length > 0 && (
            <Card className="overflow-hidden">
              <header className="flex items-center gap-2 border-b border-line/80 px-4 py-2 text-[13px] font-semibold text-ink">
                <IconRocket size={15} className="text-ink-subtle" /> Releases <span className="font-normal text-ink-subtle">{releases.length}</span>
              </header>
              <ul className="divide-y divide-line/70">
                {releases.map((r) => {
                  const open = (r.tasks ?? []).filter((t) => !t.released_at);
                  return (
                    <li key={r.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-start gap-3">
                        {r.app && <AppTile name={r.app.name} color={r.app.color} iconUrl={r.app.icon_url} className="h-9 w-9 text-sm" />}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-sm font-semibold text-ink">
                              {r.app?.name} v{r.version_name}
                            </span>
                            <PlatformBadge platform={r.platform} />
                            <span className="text-[12px] text-ink-subtle">→ Released{r.planned_date ? ` · ${prettyDate(r.planned_date)}` : ""}</span>
                          </div>
                          <p className="mt-0.5 text-[12px] text-ink-muted">
                            Requested by {r.requested_by?.name ?? "a teammate"}
                            {r.requested_at && (
                              <>
                                {"\u00a0· "}
                                <When iso={r.requested_at} />
                              </>
                            )}
                            {r.request_note ? `\u00a0· “${r.request_note}”` : ""}
                          </p>
                          {open.length ? (
                            <div className="mt-2 rounded-lg bg-canvas/70 px-3 py-2">
                              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">On approval, marked shipped · {open.length}</p>
                              <ul className="flex flex-col gap-0.5">
                                {open.map((t) => (
                                  <li key={t.id} className="flex items-baseline gap-1.5 text-[12.5px]">
                                    <span className="shrink-0 tabular-nums whitespace-nowrap text-ink-subtle">{taskRef(t.number)}</span>
                                    <span className="min-w-0 flex-1">
                                      <span className="break-words text-ink">{t.title}</span>
                                      {t.description?.trim() && <span className="mt-0.5 line-clamp-2 block whitespace-pre-wrap text-[11.5px] leading-snug text-ink-muted">{t.description.trim()}</span>}
                                      {/* Phones: the status sits under the title, which keeps the full width. */}
                                      <span className="mt-1 block sm:hidden">
                                        <StatusBadge status={t.status} />
                                      </span>
                                    </span>
                                    <span className="ml-auto hidden shrink-0 sm:block">
                                      <StatusBadge status={t.status} />
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            <p className="mt-1 text-[12px] text-ink-subtle">No tasks are linked to this version; only its status changes.</p>
                          )}
                        </div>
                        {/* Phones: the buttons drop under the text instead of squeezing it to a sliver. */}
                        <div className={cn("flex shrink-0 basis-full items-center gap-2 sm:basis-auto sm:pl-0", r.app && "pl-12")}>
                          <Button size="sm" variant="secondary" onClick={() => decideRelease(r, "reject")} disabled={busy === r.id}>
                            Send back
                          </Button>
                          <Button size="sm" onClick={() => decideRelease(r, "approve")} disabled={busy === r.id}>
                            {busy === r.id ? <Spinner /> : "Approve & release"}
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
          {tasks.length > 0 && (
            <Card className="overflow-hidden">
              {releases.length > 0 && (
                <header className="flex items-center gap-2 border-b border-line/80 px-4 py-2 text-[13px] font-semibold text-ink">
                  <IconUserCheck size={15} className="text-ink-subtle" /> Tasks <span className="font-normal text-ink-subtle">{tasks.length}</span>
                </header>
              )}
              <TaskList
                tasks={tasks}
                renderBelow={(t) => (
                  <div className="mt-1.5 flex flex-col gap-2 pl-[22px]">
                    <RequestSummary task={t} />
                    <div className="flex items-center gap-2 sm:hidden">
                      <Button size="sm" variant="secondary" onClick={() => decide(t, "reject")} disabled={busy === t.id}>
                        Send back
                      </Button>
                      <Button size="sm" onClick={() => decide(t, "approve")} disabled={busy === t.id}>
                        {busy === t.id ? <Spinner /> : "Approve"}
                      </Button>
                    </div>
                  </div>
                )}
                renderTrailing={(t) => (
                  <span className="hidden items-center gap-2 sm:flex">
                    <Button size="sm" variant="secondary" onClick={() => decide(t, "reject")} disabled={busy === t.id}>
                      Send back
                    </Button>
                    <Button size="sm" onClick={() => decide(t, "approve")} disabled={busy === t.id}>
                      {busy === t.id ? <Spinner /> : "Approve"}
                    </Button>
                  </span>
                )}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
