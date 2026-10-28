"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Dropdown } from "@/components/ui/dropdown";
import { Sheet } from "@/components/ui/sheet";
import { DateInput, usePopover } from "@/components/ui/date-input";
import { Spinner, EmptyState, LoadError } from "@/components/ui/misc";
import { Avatar } from "@/components/ui/avatar";
import { RichText } from "@/components/ui/rich-text";
import { ReleaseStatusBadge, PlatformBadge, AppTile, PriorityBadge, PlatformGlyph, StatusBadge } from "@/components/ui/task-chips";
import { TaskList } from "@/components/task-list";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { useTaskComposer } from "@/components/task-composer";
import { useNeedsApproval } from "@/lib/use-policy";
import { useSubmitShortcut } from "@/lib/use-submit-shortcut";
import { useDiscardGuard, same } from "@/lib/use-discard-guard";
import { useCachedFetch, mutate, mutatePrefix, mutateWhere, revalidatePrefix, dropEverywhere, settleDelete } from "@/lib/client-cache";
import { postJson, deleteJson } from "@/lib/http";
import { fmtYmd } from "@/lib/time";
import { When } from "@/components/ui/live-time";
import { cn } from "@/lib/cn";
import { LIMITS, RELEASE_STATUSES, RELEASE_STATUS_META, PLATFORM_META, taskRef, type ReleaseStatus } from "@/lib/domain";
import { IconRocket, IconEdit, IconTrash, IconPlus, IconCheck, IconUserCheck, IconChevronDown } from "@/components/ui/icons";
import type { AppOverview, Release, TaskCard, TaskTarget } from "@/lib/types";

const STATUS_OPTIONS = RELEASE_STATUSES.map((s) => ({ value: s, label: RELEASE_STATUS_META[s].label }));

export const prettyDate = (ymd: string | null | undefined) => (ymd ? fmtYmd(ymd, { year: true }) : "");


/** Paint a fresh release into every cached list/detail immediately (optimistic),
 * then let the lists revalidate in the background. */
function applyRelease(rel: Release) {
  mutateWhere("/api/releases", (data) => {
    const d = data as { releases?: Release[]; release?: Release } | null;
    if (!d) return undefined;
    if (Array.isArray(d.releases)) return { ...d, releases: d.releases.map((x) => (x.id === rel.id ? rel : x)) };
    if (d.release?.id === rel.id) return { ...d, release: rel };
    return undefined;
  });
  revalidatePrefix("/api/releases");
  mutate("/api/apps");
  mutate("/api/dashboard");
  if (rel.app_id) mutate(`/api/apps/${rel.app_id}`);
  mutatePrefix("/api/tasks");
  mutate("/api/notifications?limit=1");
}

/** Invalidate everything a release change can be painted on. */
function invalidateReleases(appId?: string) {
  mutatePrefix("/api/releases");
  mutatePrefix("/api/tasks");
  mutate("/api/apps");
  mutate("/api/dashboard");
  mutate("/api/notifications?limit=1");
  if (appId) mutate(`/api/apps/${appId}`);
}

/** What a save that ships the version did, as one toast. */
function reportSave(toast: ReturnType<typeof useToast>["toast"], res: { mode?: string; closed?: number } | null, version: string, fallback: string) {
  if (res?.mode === "requested") toast(`v${version} sent for approval`, "info", "An admin will confirm the release; its open tasks are closed at that moment.");
  else if (res?.mode === "applied") toast(`v${version} released`, "success", res.closed ? `${res.closed} task${res.closed === 1 ? "" : "s"} marked done.` : undefined);
  else toast(fallback);
}

/* ------------------------------ Task picker ------------------------------- */

/** Tick the tasks that ship in this version: the app's open tasks plus whatever is already linked. */
function ReleaseTaskPicker({ appId, platform, releaseId, value, onChange }: { appId: string; platform: "android" | "ios"; releaseId?: string; value: string[]; onChange: (ids: string[]) => void }) {
  // Only tasks with a target on THIS app + platform that hasn't shipped yet
  // (and isn't already in another version) — an Android fix never shows up
  // in the iOS release, and a task released on one app stays available for
  // the other apps it targets.
  const { data: openData, error: openErr, refresh: openRetry } = useCachedFetch<{ tasks: TaskCard[] }>(appId ? `/api/tasks?app=${appId}&platform=${platform}&scope=all&limit=100&sort=number` : null);
  const { data: linkedData, error: linkedErr, refresh: linkedRetry } = useCachedFetch<{ tasks: TaskCard[] }>(releaseId ? `/api/tasks?release=${releaseId}&scope=all&limit=100&sort=number` : null);
  const [q, setQ] = useState("");
  const tasks = useMemo(() => {
    const map = new Map<string, TaskCard>();
    for (const t of linkedData?.tasks ?? []) map.set(t.id, t);
    for (const t of openData?.tasks ?? []) if (!map.has(t.id)) map.set(t.id, t);
    const eligible = [...map.values()].filter((t) => {
      const target = (t.targets ?? []).find((x) => x.app.id === appId && x.platform === platform);
      if (!target) return false;
      // Already in THIS version (shipped or not): always listed, so an edit
      // shows the full contents. Otherwise only unreleased, unassigned targets.
      if (target.release?.id === releaseId) return true;
      return !target.released_at && !target.release;
    });
    const list = eligible.sort((a, b) => a.number - b.number);
    const needle = q.trim().toLowerCase();
    return needle ? list.filter((t) => t.title.toLowerCase().includes(needle) || taskRef(t.number).toLowerCase().includes(needle)) : list;
  }, [openData, linkedData, q, appId, platform, releaseId]);
  const loading = (!openData && !openErr) || (releaseId && !linkedData && !linkedErr);
  const failed = (!openData && !!openErr) || (releaseId && !linkedData && !!linkedErr);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter tasks…" className="h-9 text-[13px]" />
        <span className="shrink-0 text-[12px] text-ink-subtle">
          {value.length} selected
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto rounded-xl border border-line bg-surface">
        {failed ? (
          <LoadError title="Couldn't load tasks" onRetry={() => { openRetry(); linkedRetry(); }} />
        ) : loading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : tasks.length === 0 ? (
          <p className="px-3 py-5 text-center text-[13px] text-ink-subtle">{q ? "No tasks match." : `No unreleased ${PLATFORM_META[platform].label} tasks for this app.`}</p>
        ) : (
          <ul className="divide-y divide-line/70">
            {tasks.map((t) => {
              const on = value.includes(t.id);
              return (
                <li key={t.id}>
                  <button type="button" onClick={() => toggle(t.id)} className={cn("flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-canvas/70", on && "bg-emerald-50/50")} aria-pressed={on}>
                    <span className={cn("mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] ring-1 ring-inset", on ? "bg-emerald-600 text-white ring-emerald-600" : "bg-surface ring-line")}>{on && <IconCheck size={12} />}</span>
                    <PriorityBadge priority={t.priority} compact className="mt-0.5 shrink-0" />
                    <span className="shrink-0 text-[12px] tabular-nums whitespace-nowrap text-ink-subtle">{taskRef(t.number)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-[13px] font-medium text-ink">{t.title}</span>
                      {t.description && <span className="mt-0.5 line-clamp-2 block whitespace-pre-wrap text-[12px] leading-snug text-ink-muted">{t.description}</span>}
                    </span>
                    {(t.targets?.length ?? 0) > 1 && <span className="shrink-0 text-[10.5px] text-ink-subtle" title="This task also ships elsewhere">+{(t.targets?.length ?? 1) - 1} more target{(t.targets?.length ?? 1) - 1 === 1 ? "" : "s"}</span>}
                    {(t.targets ?? []).some((x) => x.app.id === appId && x.platform === platform && x.released_at) && <span className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-semibold text-emerald-700"><IconCheck size={11} /> shipped</span>}
                    <StatusBadge status={t.status} className="shrink-0" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- Form ----------------------------------- */

/** Create / edit a release. `apps` lets the global page pick the app; an app
 * page passes a fixed `appId`. */
export function ReleaseFormSheet({ release, apps, appId, initial, onClose }: { release?: Release | null; apps: AppOverview[]; appId?: string; initial?: { platform?: "android" | "ios"; task_ids?: string[] }; onClose: () => void }) {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const { isAdmin } = useSession();
  const needsApproval = useNeedsApproval();
  const [app, setApp] = useState(release?.app_id ?? appId ?? apps[0]?.id ?? "");
  const current = apps.find((a) => a.id === app) || null;
  const [platform, setPlatform] = useState<"android" | "ios">(release?.platform ?? initial?.platform ?? (current?.has_android === false ? "ios" : "android"));
  const [version, setVersion] = useState(release?.version_name ?? "");
  const [build, setBuild] = useState(release?.build_number ?? "");
  const [status, setStatus] = useState<ReleaseStatus>(release?.status ?? "planned");
  const [planned, setPlanned] = useState(release?.planned_date ?? "");
  const [description, setDescription] = useState(release?.description ?? "");
  const [notes, setNotes] = useState(release?.notes ?? "");
  const [taskIds, setTaskIds] = useState<string[]>(release ? (release.tasks ?? []).map((t) => t.id) : (initial?.task_ids ?? []));
  const [busy, setBusy] = useState(false);
  // What the sheet opened with — the diff base for saves and the dirty check.
  const [snapshot] = useState(() => ({ app_id: release?.app_id ?? appId ?? apps[0]?.id ?? "", platform: release?.platform ?? initial?.platform ?? "android", version_name: release?.version_name ?? "", build_number: release?.build_number ?? "", status: release?.status ?? "planned", planned_date: release?.planned_date ?? null, description: release?.description ?? "", notes: release?.notes ?? "", task_ids: release ? (release.tasks ?? []).map((t) => t.id) : (initial?.task_ids ?? []) }));
  const dirty = !same(version.trim(), snapshot.version_name) || !same(build, snapshot.build_number) || status !== snapshot.status || !same(planned || null, snapshot.planned_date) || !same(description, snapshot.description) || !same(notes, snapshot.notes) || !same(taskIds, snapshot.task_ids) || (release ? platform !== snapshot.platform : false);
  const close = useDiscardGuard(dirty && !busy, onClose);
  // Validation and save problems surface as error toasts, not inline text.
  const setError = (m: string) => {
    if (m) toast(m, "error");
  };

  const platformOptions = [
    ...(current?.has_android !== false ? [{ value: "android", label: PLATFORM_META.android.label }] : []),
    ...(current?.has_ios ? [{ value: "ios", label: PLATFORM_META.ios.label }] : []),
  ];
  const shipping = status === "released" && release?.status !== "released";
  const willAsk = shipping && !isAdmin && needsApproval;

  async function save() {
    if (busy) return;
    if (!app) return setError("Pick an app.");
    if (!version.trim()) return setError("Enter the version name.");
    if (shipping && !willAsk) {
      const n = taskIds.length;
      if (!(await confirm({ title: `Mark v${version.trim()} as released?`, message: n ? `${n} linked task${n === 1 ? "" : "s"} will be marked shipped here, open ones done on the release date.` : "No tasks are linked to this version; only its status changes.", confirmLabel: "Release" }))) return;
    }
    const full = { app_id: app, platform, version_name: version.trim(), build_number: build, status, planned_date: planned || null, description, notes, task_ids: taskIds };
    // Editing sends ONLY the fields that changed since the sheet opened, so a
    // teammate's change meanwhile (say, marking it released) is never undone
    // by a stale copy of the whole form.
    const body: Record<string, unknown> = release ? Object.fromEntries(Object.entries(full).filter(([k, v]) => k !== "app_id" && !same(v, snapshot[k as keyof typeof full]))) : full;
    if (release && Object.keys(body).length === 0) {
      toast("Nothing changed");
      onClose();
      return;
    }
    setBusy(true);
    setError("");
    const { ok, data } = release ? await postJson<{ error?: string; mode?: string; closed?: number }>(`/api/releases/${release.id}`, body, "PATCH") : await postJson<{ error?: string; mode?: string; closed?: number }>("/api/releases", body);
    if (!ok) {
      setBusy(false);
      setError(data?.error || "Couldn't save the release.");
      return;
    }
    reportSave(toast, data, version.trim(), release ? "Release updated" : "Release added");
    invalidateReleases(app);
    onClose();
  }
  useSubmitShortcut(() => void save());

  return (
    <Sheet
      title={release ? `Edit v${release.version_name}` : `New release${appId ? ` · ${apps.find((a) => a.id === appId)?.name ?? ""}` : ""}`}
      description="One entry per version per platform. Tick the tasks that ship in it; marking it released closes them."
      onClose={close}
      wide
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto hidden text-[11px] text-ink-subtle sm:inline">
            <kbd className="rounded border border-line bg-canvas px-1 py-0.5 font-sans">Ctrl</kbd>+<kbd className="rounded border border-line bg-canvas px-1 py-0.5 font-sans">Enter</kbd> to save
          </span>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? <Spinner /> : shipping ? (willAsk ? "Request release" : "Save & release") : release ? "Save changes" : "Add release"}
          </Button>
        </div>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-4"
      >
        {!release && !appId && (
          <Field label="App">
            <Dropdown value={app} onChange={(v) => { setApp(v); setTaskIds([]); }} options={apps.map((a) => ({ value: a.id, label: a.name }))} placeholder="Pick an app" />
          </Field>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Platform">
            <Dropdown value={platform} onChange={(v) => { setPlatform(v as "android" | "ios"); if (!release) setTaskIds([]); }} options={platformOptions.length ? platformOptions : [{ value: platform, label: PLATFORM_META[platform].label }]} />
          </Field>
          <Field label="Status">
            <Dropdown value={status} onChange={(v) => setStatus(v as ReleaseStatus)} options={STATUS_OPTIONS} />
          </Field>
          <Field label="Version name">
            <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="2.4.0" maxLength={LIMITS.versionName} autoFocus />
          </Field>
          <Field label={platform === "android" ? "Version code" : "Build number"}>
            <Input value={build} onChange={(e) => setBuild(e.target.value)} placeholder="240" maxLength={LIMITS.buildNumber} />
          </Field>
          <Field label="Release date" hint="The day it goes live. Used as the completion date of the tasks it closes.">
            <DateInput value={planned} onChange={setPlanned} />
          </Field>
        </div>
        {app ? (
          <Field label={`Tasks in this ${PLATFORM_META[platform].label} version`} hint="Only tasks that target this app on this platform and haven't shipped here yet. They appear under the version in meetings and minutes.">
            <ReleaseTaskPicker appId={app} platform={platform} releaseId={release?.id} value={taskIds} onChange={setTaskIds} />
          </Field>
        ) : null}
        {shipping && (
          <p className={cn("rounded-lg px-3 py-2 text-[13px] ring-1 ring-inset", willAsk ? "bg-amber-50 text-amber-800 ring-amber-100" : "bg-emerald-50 text-emerald-800 ring-emerald-100")}>
            {willAsk
              ? `Marking it released needs an admin's approval. They'll see the ${taskIds.length} linked task${taskIds.length === 1 ? "" : "s"} that will be marked done when they approve.`
              : `Saving will mark the release as released and close the ${taskIds.length} linked task${taskIds.length === 1 ? "" : "s"} that ${taskIds.length === 1 ? "is" : "are"} still open.`}
          </p>
        )}
        <Field label="Release notes" hint="Anything beyond the task list — highlights, known issues, migration steps. Shown in meetings and minutes.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={LIMITS.releaseText} placeholder="- Faster sync on slow networks&#10;- Known issue: dark-mode icons on Android 10" />
        </Field>
        <Field label="Internal notes" hint="Rollout %, store review remarks, hotfix plans…">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={LIMITS.releaseText} />
        </Field>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Sheet>
  );
}

/* ---------------------------------- Row ----------------------------------- */

/** One release as a row. */
export function ReleaseRow({ r, showApp = true, onOpen }: { r: Release; showApp?: boolean; onOpen: (r: Release) => void }) {
  // The status pill is its own control, so it sits BESIDE the row button,
  // never inside it (nested buttons are invalid and misroute clicks).
  return (
    // Phones: the status pill sits under the row, so the version and dates keep the full width.
    <li className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-canvas/70 sm:flex-row sm:items-center sm:gap-3 sm:px-5">
      <button type="button" onClick={() => onOpen(r)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        {showApp && r.app ? <AppTile name={r.app.name} color={r.app.color} iconUrl={r.app.icon_url} androidIconUrl={r.app.icon_android_url} iosIconUrl={r.app.icon_ios_url} platform={r.platform} className="h-9 w-9 text-sm" /> : <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-canvas ring-1 ring-inset ring-line"><PlatformGlyph platform={r.platform} size={18} /></span>}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {showApp && r.app && <span className="text-sm font-medium text-ink">{r.app.name}</span>}
            {/* Version and build travel together when the name wraps. */}
            <span className="whitespace-nowrap">
              <span className="text-sm font-semibold tabular-nums text-ink">v{r.version_name}</span>
              {r.build_number && <span className="ml-1.5 text-xs text-ink-subtle">({r.build_number})</span>}
            </span>
            {showApp && <PlatformBadge platform={r.platform} />}
            {r.requested_status && <Badge tone="warning">Awaiting approval</Badge>}
          </div>
          {/* Flows as one sentence; the "·" stays at the end of a line, never opening the next. */}
          <div className="mt-0.5 text-[11px] text-ink-subtle">
            {r.status === "released" && r.released_at ? (
              <span>
                Released <When iso={r.released_at} />
              </span>
            ) : r.planned_date ? (
              <span>Release date {prettyDate(r.planned_date)}</span>
            ) : (
              <span>No date yet</span>
            )}
            {typeof r.task_count === "number" && r.task_count > 0 && (
              <span>
                {"\u00a0· "}
                <span className="whitespace-nowrap">
                  {r.done_count}/{r.task_count} tasks done
                </span>
              </span>
            )}
          </div>
        </div>
      </button>
      <div className="pl-12 sm:pl-0">
        <ReleaseStatusMenu release={r} />
      </div>
    </li>
  );
}

/* -------------------------------- Detail ---------------------------------- */

/** Release detail sheet: what's in it, linked tasks with quick status, release action, request review. */
export function ReleaseViewSheet({ release, apps, onClose }: { release: Release; apps: AppOverview[]; onClose: () => void }) {
  const { toast } = useToast();
  const { confirm, prompt } = useDialog();
  const { me, isAdmin } = useSession();
  const needsApproval = useNeedsApproval();
  const composer = useTaskComposer();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const key = `/api/releases/${release.id}`;
  const { data: live } = useCachedFetch<{ release: Release }>(key);
  const r = live?.release ?? release;
  const { data: tasksData, error: tasksErr, refresh: tasksRetry } = useCachedFetch<{ tasks: TaskCard[] }>(`/api/tasks?release=${r.id}&scope=all&sort=number&limit=100`);
  const app = apps.find((a) => a.id === r.app_id);
  const canManage = isAdmin || !!app?.members.some((m) => m.user.id === me?.id);
  const openTasks = (r.tasks ?? []).filter((t) => !t.released_at);
  const pending = !!r.requested_status;

  async function remove() {
    if (!(await confirm({ title: `Delete v${r.version_name}?`, message: "Linked tasks keep existing; only the release entry is removed.", confirmLabel: "Delete", tone: "danger" }))) return;
    // Goes at once from every list; comes back only if the server refuses.
    dropEverywhere(r.id, ["/api/releases", `/api/apps/${r.app_id}`]);
    toast("Release deleted");
    onClose();
    const { ok, data } = await deleteJson(key);
    settleDelete(r.id);
    invalidateReleases(r.app_id);
    if (!ok) toast(data?.error ? `Couldn't delete v${r.version_name}: ${data.error}` : `Couldn't delete v${r.version_name} — it is back`, "error");
  }

  async function markReleased() {
    if (busy) return;
    const n = openTasks.length;
    const ask = !isAdmin && needsApproval;
    const okGo = await confirm({
      title: ask ? `Request release of v${r.version_name}?` : `Mark v${r.version_name} as released?`,
      message: ask
        ? `An admin will confirm it. ${n ? `${n} linked task${n === 1 ? "" : "s"} will be marked shipped here (open ones become done): ${openTasks.map((t) => taskRef(t.number)).join(", ")}.` : "No tasks are linked to this version."}`
        : n
          ? `${n} linked task${n === 1 ? "" : "s"} will be marked shipped here, open ones done on the release date: ${openTasks.map((t) => taskRef(t.number)).join(", ")}.`
          : "No tasks are linked to this version; only its status changes.",
      confirmLabel: ask ? "Send request" : "Release",
    });
    if (!okGo) return;
    setBusy("release");
    const { ok, data } = await postJson<{ error?: string; mode?: string; closed?: number; release?: Release }>(key, { status: "released" }, "PATCH");
    setBusy(null);
    if (ok) {
      reportSave(toast, data, r.version_name, "Release updated");
      if (data?.release) applyRelease(data.release);
      else invalidateReleases(r.app_id);
    } else toast(data?.error || "Couldn't update the release", "error");
  }

  async function review(action: "approve" | "reject" | "withdraw") {
    if (busy) return;
    let note: string | null = null;
    if (action === "reject") {
      note = await prompt({ title: "Send the release request back", message: "Tell them what to fix (optional).", placeholder: "e.g. Wait for the store review to clear", confirmLabel: "Send back" });
      if (note === null) return;
    }
    if (action === "approve") {
      const n = openTasks.length;
      if (!(await confirm({ title: `Approve v${r.version_name} as released?`, message: n ? `${n} linked task${n === 1 ? "" : "s"} will be marked shipped here: ${openTasks.map((t) => taskRef(t.number)).join(", ")}.` : "No tasks are linked to this version.", confirmLabel: "Approve & release" }))) return;
    }
    setBusy(action);
    const { ok, data } = await postJson<{ error?: string; closed?: number; release?: Release | null }>(`${key}/review`, { action, note });
    setBusy(null);
    if (ok) {
      if (action === "approve") toast(`v${r.version_name} released`, "success", data?.closed ? `${data.closed} task${data.closed === 1 ? "" : "s"} marked done.` : undefined);
      else toast(action === "reject" ? "Request sent back" : "Request withdrawn");
      if (data?.release) applyRelease(data.release);
      else invalidateReleases(r.app_id);
    } else toast(data?.error || "Couldn't update", "error");
  }

  return (
    <>
      <Sheet
        title={`${r.app?.name ?? app?.name ?? ""} v${r.version_name}`}
        description={`${PLATFORM_META[r.platform].label}${r.build_number ? ` · build ${r.build_number}` : ""}`}
        onClose={onClose}
        wide
        footer={
          canManage ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {isAdmin && (
                <Button variant="danger" size="sm" onClick={remove}>
                  <IconTrash size={14} /> Delete
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => composer.open({ app_id: r.app_id, platform: r.platform, release_id: r.id, type: "release" })}>
                <IconPlus size={14} /> Task for this release
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                <IconEdit size={14} /> Edit
              </Button>
              {r.status !== "released" && !pending && (
                <Button size="sm" onClick={markReleased} disabled={!!busy}>
                  {busy === "release" ? <Spinner /> : <IconRocket size={14} />} {!isAdmin && needsApproval ? "Request release" : "Mark as released"}
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            {canManage ? <ReleaseStatusMenu release={r} size="md" /> : <ReleaseStatusBadge status={r.status} />}
            <span className="text-xs text-ink-subtle">
              {r.status === "released" && r.released_at ? (
                <>
                  Released <When iso={r.released_at} />
                </>
              ) : r.planned_date ? (
                `Release date ${prettyDate(r.planned_date)}`
              ) : (
                "No date yet"
              )}
            </span>
            {r.created_by && (
              <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-ink-subtle">
                <Avatar user={r.created_by} size="xs" /> {r.created_by.name}
              </span>
            )}
          </div>

          {pending && (
            <div className="rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-inset ring-amber-100">
              <div className="flex items-start gap-2.5">
                <IconUserCheck size={16} className="mt-0.5 shrink-0 text-amber-700" />
                <div className="min-w-0 flex-1 text-[13px] text-amber-900">
                  <p className="font-semibold">
                    {r.requested_by?.name ?? "A teammate"} asked to mark this released
                    {r.requested_at && (
                      <span className="font-normal">
                        {"\u00a0· "}
                        <When iso={r.requested_at} />
                      </span>
                    )}
                  </p>
                  {r.request_note && <p className="mt-0.5 text-amber-800">“{r.request_note}”</p>}
                  <p className="mt-1 text-amber-800">
                    {openTasks.length ? (
                      <>
                        On approval these tasks are marked shipped here (open ones become done): <b>{openTasks.map((t) => taskRef(t.number)).join(", ")}</b>.
                      </>
                    ) : (
                      "No tasks are linked to this version; only its status changes."
                    )}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {isAdmin && (
                      <>
                        <Button size="sm" onClick={() => review("approve")} disabled={!!busy}>
                          {busy === "approve" ? <Spinner /> : "Approve & release"}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => review("reject")} disabled={!!busy}>
                          Send back
                        </Button>
                      </>
                    )}
                    {(r.requested_by?.id === me?.id || isAdmin) && (
                      <Button size="sm" variant="secondary" onClick={() => review("withdraw")} disabled={!!busy}>
                        Withdraw
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
              In this version {tasksData && <span className="font-normal normal-case">· {tasksData.tasks.length} task{tasksData.tasks.length === 1 ? "" : "s"}</span>}
            </h3>
            {tasksData ? (
              tasksData.tasks.length ? (
                <div className="overflow-hidden rounded-xl border border-line">
                  <TaskList tasks={tasksData.tasks} showApp={false} showDescription />
                </div>
              ) : (
                <EmptyState icon={<IconRocket size={18} />} title="No tasks linked yet" description="Edit the release to tick the tasks it ships, or create one for it." />
              )
            ) : tasksErr ? (
              <LoadError title="Couldn't load the linked tasks" onRetry={tasksRetry} />
            ) : (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            )}
            {canManage && tasksData && tasksData.tasks.length > 0 && <p className="mt-1.5 text-[11.5px] text-ink-subtle">Change any task&rsquo;s status right here from its pill.</p>}
          </section>

          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Release notes</h3>
            {r.description ? <RichText text={r.description} /> : <p className="text-sm text-ink-subtle">Nothing beyond the task list.</p>}
          </section>
          {r.notes && (
            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Internal notes</h3>
              <RichText text={r.notes} />
            </section>
          )}
          {app && (
            <p className="text-xs text-ink-subtle">
              Manage all versions on the{" "}
              <Link href={`/apps/${app.id}?tab=releases`} className="font-medium text-brand-700 hover:text-brand-800" onClick={onClose}>
                {app.name} page
              </Link>
              .
            </p>
          )}
        </div>
      </Sheet>
      {editing && <ReleaseFormSheet release={r} apps={apps} onClose={() => setEditing(false)} />}
    </>
  );
}

/* ----------------------------- Quick status ------------------------------- */

/**
 * The release's status as a pill that changes it in place — the same gesture
 * as a task's status pill. Choosing Released runs the normal release flow:
 * confirmation naming the tasks it closes, or an approval request for a
 * member under the policy.
 */
function ReleaseStatusMenu({ release: r, size = "sm", className }: { release: Release; size?: "sm" | "md"; className?: string }) {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const { me, isAdmin } = useSession();
  const needsApproval = useNeedsApproval();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useMemo(() => () => setOpen(false), []);
  const pos = usePopover(open, close, btnRef, menuRef, 300, 208);
  // Who may change it is enforced by the API (admin or a member of the app);
  // the pill stays interactive and reports a clear error otherwise. Moving a
  // shipped version back is an admin call, so members see a plain badge there.
  const canChange = !!me && (isAdmin || r.status !== "released");
  const meta = RELEASE_STATUS_META[r.status];
  const openTasks = (r.tasks ?? []).filter((t) => !t.released_at);

  async function pick(next: ReleaseStatus) {
    setOpen(false);
    if (next === r.status || busy) return;
    if (next === "released") {
      const ask = !isAdmin && needsApproval;
      const n = openTasks.length;
      const ok = await confirm({
        title: ask ? `Request release of v${r.version_name}?` : `Mark v${r.version_name} as released?`,
        message: ask
          ? `An admin will confirm it. ${n ? `${n} linked task${n === 1 ? "" : "s"} will be marked shipped here (open ones become done): ${openTasks.map((t) => taskRef(t.number)).join(", ")}.` : "No tasks are linked to this version."}`
          : n
            ? `${n} linked task${n === 1 ? "" : "s"} will be marked shipped here, open ones done on the release date: ${openTasks.map((t) => taskRef(t.number)).join(", ")}.`
            : "No tasks are linked to this version; only its status changes.",
        confirmLabel: ask ? "Send request" : "Release",
      });
      if (!ok) return;
    }
    setBusy(true);
    const { ok, data } = await postJson<{ error?: string; mode?: string; closed?: number; release?: Release }>(`/api/releases/${r.id}`, { status: next }, "PATCH");
    setBusy(false);
    if (ok) {
      if (next === "released") reportSave(toast, data, r.version_name, "Release updated");
      else toast(`v${r.version_name} → ${RELEASE_STATUS_META[next].label}`);
      if (data?.release) applyRelease(data.release);
      else invalidateReleases(r.app_id);
    } else toast(data?.error || "Couldn't update the release", "error");
  }

  const toneCls = { neutral: "bg-canvas text-ink-muted ring-line", brand: "bg-brand-100 text-ink ring-brand-200", info: "bg-sky-50 text-sky-700 ring-sky-200", warning: "bg-amber-50 text-amber-700 ring-amber-200", success: "bg-emerald-50 text-emerald-700 ring-emerald-200", danger: "bg-red-50 text-red-600 ring-red-200" }[meta.tone] ?? "bg-canvas text-ink-muted ring-line";
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={!canChange || busy || !!r.requested_status}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full font-semibold ring-1 ring-inset transition-colors", size === "md" ? "px-2.5 py-1 text-[12.5px]" : "px-2 py-0.5 text-[11.5px]", toneCls, canChange && !r.requested_status && "hover:brightness-95", className)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={r.requested_status ? "Awaiting approval" : "Change status"}
      >
        {busy ? <Spinner /> : null}
        {meta.label}
        {canChange && !r.requested_status && <IconChevronDown size={12} className={cn("opacity-60 transition-transform", open && "rotate-180")} />}
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={menuRef} role="listbox" className="fixed z-[200] w-52 rounded-xl border border-line/80 bg-surface p-1 shadow-pop animate-fade-in" style={{ left: pos.left, top: pos.top, transform: pos.up ? "translateY(-100%)" : undefined }} onClick={(e) => e.stopPropagation()}>
            {RELEASE_STATUSES.map((st) => (
              <button key={st} type="button" role="option" aria-selected={st === r.status} onClick={() => pick(st)} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-canvas", st === r.status && "font-semibold text-ink")}>
                <span className={cn("h-2 w-2 rounded-full", { neutral: "bg-slate-400", brand: "bg-ink", info: "bg-sky-500", warning: "bg-amber-500", success: "bg-emerald-500", danger: "bg-red-400" }[RELEASE_STATUS_META[st].tone] ?? "bg-slate-400")} />
                {RELEASE_STATUS_META[st].label}
                {st === r.status && <IconCheck size={13} className="ml-auto text-ink-subtle" />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}

/* --------------------------- Pending release ------------------------------ */

/**
 * On a task page: which of its targets still have no release. One click
 * opens a pre-filled New release for the chosen app + platform with the task
 * already ticked; only the version and dates are left to type.
 */
/**
 * Work in progress that no version is carrying yet, grouped by app × platform.
 * One click opens New release pre-filled with the app, platform and tasks;
 * the person adds the version and the rest. Members see only their apps.
 */
export function UnreleasedWorkBanner({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { me, isAdmin } = useSession();
  const { data: unreleased } = useCachedFetch<{ groups: { app_id: string; platform: "android" | "ios"; tasks: { id: string; number: number }[] }[] }>("/api/releases/unreleased");
  const { data: appsData } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const [form, setForm] = useState<{ app: AppOverview; platform: "android" | "ios"; task_ids: string[] } | null>(null);
  const apps = appsData?.apps ?? [];
  const groups = useMemo(() => (unreleased?.groups ?? []).map((g) => ({ appId: g.app_id, platform: g.platform, tasks: g.tasks })), [unreleased]);
  const canManage = (app: AppOverview) => isAdmin || app.members.some((mm) => mm.user.id === me?.id);
  const visible = groups.map((g) => ({ ...g, app: apps.find((a) => a.id === g.appId) })).filter((g): g is typeof g & { app: AppOverview } => !!g.app && g.app.status !== "archived" && canManage(g.app));
  if (!visible.length) return null;
  const total = new Set(visible.flatMap((g) => g.tasks.map((t) => t.id))).size;
  return (
    <>
      <div className={cn("flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-inset ring-amber-100", className)}>
        <IconRocket size={16} className="shrink-0 text-amber-700" />
        {/* Phones: the button drops under the sentence instead of squeezing it. */}
        <div className="min-w-0 flex-1 basis-[14rem] text-[13px] text-amber-900">
          <p className="font-semibold">
            {total} task{total === 1 ? "" : "s"} in progress {total === 1 ? "isn't" : "aren't"} in any release yet.
            {compact ? " " : " Create the version now and they ride along:"}
            {compact && (
              <Link href="/releases" className="font-semibold underline-offset-2 hover:underline">
                Create release
              </Link>
            )}
          </p>
          {!compact && (
            <p className="mt-1 flex flex-wrap items-center gap-1.5">
              {visible.map((g) => (
                <button key={`${g.appId}:${g.platform}`} type="button" onClick={() => setForm({ app: g.app, platform: g.platform, task_ids: g.tasks.map((t) => t.id) })} className="inline-flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-[12px] font-medium text-ink ring-1 ring-inset ring-amber-200 hover:ring-ink" title={`New ${PLATFORM_META[g.platform].label} release for ${g.app.name} with ${g.tasks.map((t) => taskRef(t.number)).join(", ")}`}>
                  <AppTile name={g.app.name} color={g.app.color} iconUrl={g.app.icon_url} androidIconUrl={g.app.icon_android_url} iosIconUrl={g.app.icon_ios_url} platform={g.platform} className="h-4 w-4 rounded-[4px] text-[7px]" />
                  {g.app.name}
                  <PlatformGlyph platform={g.platform} size={12} />
                  <span className="text-ink-subtle">· {g.tasks.length}</span>
                </button>
              ))}
            </p>
          )}
        </div>
        {!compact && visible.length === 1 && (
          <Button size="sm" onClick={() => setForm({ app: visible[0].app, platform: visible[0].platform, task_ids: visible[0].tasks.map((t) => t.id) })} className="ml-7 shrink-0 sm:ml-0">
            <IconRocket size={14} /> Create release
          </Button>
        )}
      </div>
      {form && <ReleaseFormSheet apps={apps} appId={form.app.id} initial={{ platform: form.platform, task_ids: form.task_ids }} onClose={() => setForm(null)} />}
    </>
  );
}

export function PendingReleaseBanner({ task, className }: { task: TaskCard; className?: string }) {
  const { data: appsData } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const [choosing, setChoosing] = useState(false);
  const [form, setForm] = useState<TaskTarget | null>(null);
  const targets = task.targets ?? [];
  const pending = targets.filter((t) => !t.release && !t.released_at);
  const released = targets.filter((t) => t.released_at).length;
  const planned = targets.filter((t) => t.release && !t.released_at).length;
  // A task marked done by hand can still be waiting on a release, so only a
  // cancelled task hides this.
  if (!pending.length || task.status === "cancelled") return null;
  const apps = appsData?.apps ?? [];
  const start = (t: TaskTarget) => {
    setChoosing(false);
    setForm(t);
  };
  return (
    <>
      <div className={cn("flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-inset ring-amber-100", className)}>
        <IconRocket size={16} className="shrink-0 text-amber-700" />
        <div className="min-w-0 flex-1 basis-[14rem] text-[13px] text-amber-900">
          <p className="font-semibold">
            {released ? `Released on ${released} of ${targets.length} targets.` : planned ? `Planned on ${planned} of ${targets.length} targets.` : "No release planned yet."} {pending.length} still {pending.length === 1 ? "has" : "have"} no release:
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5">
            {pending.map((t) => (
              <button key={`${t.app.id}:${t.platform}`} type="button" onClick={() => start(t)} className="inline-flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-[12px] font-medium text-ink ring-1 ring-inset ring-amber-200 hover:ring-ink" title={`Create a ${PLATFORM_META[t.platform].label} release for ${t.app.name}`}>
                <AppTile name={t.app.name} color={t.app.color} iconUrl={t.app.icon_url} androidIconUrl={t.app.icon_android_url} iosIconUrl={t.app.icon_ios_url} platform={t.platform} className="h-4 w-4 rounded-[4px] text-[7px]" />
                {t.app.name}
                <PlatformGlyph platform={t.platform} size={12} />
              </button>
            ))}
          </p>
        </div>
        <Button size="sm" onClick={() => (pending.length === 1 ? start(pending[0]) : setChoosing(true))} className="ml-7 shrink-0 sm:ml-0">
          <IconRocket size={14} /> Create release
        </Button>
      </div>
      {choosing && (
        <Sheet title="Create a release for…" description="Pick the app and platform. The task is added to the new version automatically." onClose={() => setChoosing(false)}>
          <ul className="divide-y divide-line/70 overflow-hidden rounded-xl border border-line bg-surface">
            {pending.map((t) => (
              <li key={`${t.app.id}:${t.platform}`}>
                <button type="button" onClick={() => start(t)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-canvas/70">
                  <AppTile name={t.app.name} color={t.app.color} iconUrl={t.app.icon_url} className="h-8 w-8 text-xs" />
                  <span className="min-w-0 flex-1 text-[13.5px] font-medium text-ink">{t.app.name}</span>
                  <PlatformBadge platform={t.platform} />
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
      {form && apps.length > 0 && <ReleaseFormSheet apps={apps} appId={form.app.id} initial={{ platform: form.platform, task_ids: [task.id] }} onClose={() => setForm(null)} />}
    </>
  );
}
