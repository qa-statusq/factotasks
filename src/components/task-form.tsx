"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useSubmitShortcut } from "@/lib/use-submit-shortcut";
import { useDiscardGuard, same } from "@/lib/use-discard-guard";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea, controlClass } from "@/components/ui/field";
import { Dropdown } from "@/components/ui/dropdown";
import { Sheet } from "@/components/ui/sheet";
import { PeoplePicker } from "@/components/ui/people-picker";
import { DateInput } from "@/components/ui/date-input";
import { LabelChip, AppTile } from "@/components/ui/task-chips";
import { Spinner } from "@/components/ui/misc";
import { useSession } from "@/components/providers/session-provider";
import { useToast } from "@/components/ui/toast";
import { useCachedFetch } from "@/lib/client-cache";
import { cn } from "@/lib/cn";
import { LIMITS, PRIORITIES, PRIORITY_META, TASK_TYPES, TYPE_META, type Priority, type TaskType } from "@/lib/domain";
import { IconAndroid, IconApple, IconCheck, IconX, IconSearch } from "@/components/ui/icons";
import { Segmented } from "@/components/ui/segmented";
import type { AppOverview, UserBrief } from "@/lib/types";

/** One place a task must ship: an app on a platform. */
export interface TargetRef {
  app_id: string;
  platform: "android" | "ios";
}

export interface TaskFormValues {
  title: string;
  description: string;
  /** Empty = general task (no app). */
  targets: TargetRef[];
  type: TaskType;
  priority: Priority;
  assignee_ids: string[];
  due_date: string | null;
  labels: string[];
  estimate_hours: number | null;
  /** Meeting series the task is attached to; null = none. */
  series_id: string | null;
}

const TYPE_OPTIONS = TASK_TYPES.map((t) => ({ value: t, label: TYPE_META[t].label }));
const PRIORITY_OPTIONS = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label }));

/**
 * Where a task ships. First an explicit choice — General task (no app) or App
 * task — so nobody has to guess how to make a general one. App tasks then get
 * a compact picker that stays tidy with a dozen apps: selected targets as
 * removable chips, a search box, "all Android / all iOS" shortcuts, and a
 * scrolling list with an Android and an iOS toggle per app.
 */
export function TargetPicker({ apps, value, onChange }: { apps: AppOverview[]; value: TargetRef[]; onChange: (v: TargetRef[]) => void }) {
  const [mode, setMode] = useState<"general" | "app">(value.length ? "app" : "general");
  const [q, setQ] = useState("");
  const has = (appId: string, platform: "android" | "ios") => value.some((t) => t.app_id === appId && t.platform === platform);
  const toggle = (appId: string, platform: "android" | "ios") => onChange(has(appId, platform) ? value.filter((t) => !(t.app_id === appId && t.platform === platform)) : [...value, { app_id: appId, platform }]);
  const platformsOf = (a: AppOverview) => (["android", "ios"] as const).filter((p) => (p === "android" ? a.has_android : a.has_ios));
  const toggleApp = (a: AppOverview) => {
    const plats = platformsOf(a);
    const all = plats.every((p) => has(a.id, p));
    onChange(all ? value.filter((t) => t.app_id !== a.id) : [...value.filter((t) => t.app_id !== a.id), ...plats.map((platform) => ({ app_id: a.id, platform }))]);
  };
  const live = apps.filter((a) => a.status !== "archived" || value.some((t) => t.app_id === a.id));
  const byId = new Map(live.map((a) => [a.id, a]));
  const needle = q.trim().toLowerCase();
  const list = needle ? live.filter((a) => a.name.toLowerCase().includes(needle)) : live;
  const appCount = new Set(value.map((t) => t.app_id)).size;
  const chip = (on: boolean, disabled?: boolean) => cn("inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-semibold ring-1 ring-inset transition-colors", on ? "bg-ink text-white ring-ink" : "bg-surface text-ink-muted ring-line hover:text-ink", disabled && "cursor-not-allowed opacity-40 hover:text-ink-muted");

  return (
    <div className="flex flex-col gap-2.5">
      <Segmented
        value={mode}
        onChange={(m) => {
          setMode(m);
          if (m === "general") onChange([]);
        }}
        options={[
          { value: "general", label: "General task" },
          { value: "app", label: "App task" },
        ]}
        aria-label="Task kind"
        className="self-start"
      />
      {mode === "general" ? (
        <p className="text-[12.5px] text-ink-subtle">Not tied to any app: process work, documentation, store accounts, anything team-wide. It reaches a meeting only when attached to a series below.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          {/* Selected targets */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line/70 bg-canvas/60 px-3 py-2">
            {value.length === 0 ? (
              <span className="text-[12px] text-ink-subtle">Nothing picked yet. Tick the apps and platforms below.</span>
            ) : (
              <>
                <span className="mr-1 text-[11.5px] font-medium text-ink-muted">
                  {value.length} target{value.length === 1 ? "" : "s"} · {appCount} app{appCount === 1 ? "" : "s"}
                </span>
                {value.map((t) => {
                  const a = byId.get(t.app_id);
                  return (
                    <span key={`${t.app_id}:${t.platform}`} className="inline-flex h-6 items-center gap-1 rounded-md bg-surface pl-1 pr-1 text-[11.5px] font-medium text-ink ring-1 ring-inset ring-line">
                      {a && <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className="h-4 w-4 rounded-[4px] text-[7px]" />}
                      {a?.name ?? "App"}
                      {t.platform === "android" ? <IconAndroid size={11} className="text-ink-subtle" /> : <IconApple size={11} className="text-ink-subtle" />}
                      <button type="button" onClick={() => toggle(t.app_id, t.platform)} className="rounded p-0.5 text-ink-subtle hover:text-red-600" aria-label={`Remove ${a?.name ?? "app"} ${t.platform}`}>
                        <IconX size={11} />
                      </button>
                    </span>
                  );
                })}
                <button type="button" onClick={() => onChange([])} className="ml-auto text-[11.5px] font-medium text-ink-subtle hover:text-ink">
                  Clear
                </button>
              </>
            )}
          </div>
          {/* Search + shortcuts */}
          <div className="px-3 py-2">
            <div className="relative">
              <IconSearch size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
              <input data-nested-input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps" className={cn(controlClass, "h-8 pl-7 text-[12.5px]")} aria-label="Search apps" />
            </div>
          </div>
          {/* App list */}
          {live.length === 0 ? (
            <p className="px-3 pb-3 text-[13px] text-ink-subtle">No apps yet. Add one under Apps, or make this a general task.</p>
          ) : list.length === 0 ? (
            <p className="px-3 pb-3 text-[13px] text-ink-subtle">No app matches.</p>
          ) : (
            <ul className="max-h-52 divide-y divide-line/60 overflow-y-auto border-t border-line/70">
              {list.map((a) => {
                const anyOn = value.some((t) => t.app_id === a.id);
                return (
                  <li key={a.id} className={cn("flex items-center gap-2.5 px-3 py-1.5", anyOn && "bg-emerald-50/40")}>
                    <button type="button" onClick={() => toggleApp(a)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" title="Toggle every platform of this app">
                      <span className={cn("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] ring-1 ring-inset", anyOn ? "bg-emerald-600 text-white ring-emerald-600" : "bg-surface ring-line")}>{anyOn && <IconCheck size={12} />}</span>
                      <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className="h-6 w-6 rounded-md text-[9px]" />
                      <span className="truncate text-[13px] font-medium text-ink">{a.name}</span>
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      <button type="button" onClick={() => a.has_android && toggle(a.id, "android")} disabled={!a.has_android} className={chip(has(a.id, "android"), !a.has_android)} aria-pressed={has(a.id, "android")} title={a.has_android ? "Android" : "Not on Android"}>
                        <IconAndroid size={12} /> Android
                      </button>
                      <button type="button" onClick={() => a.has_ios && toggle(a.id, "ios")} disabled={!a.has_ios} className={chip(has(a.id, "ios"), !a.has_ios)} aria-pressed={has(a.id, "ios")} title={a.has_ios ? "iOS" : "Not on iOS"}>
                        <IconApple size={12} /> iOS
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="border-t border-line/70 px-3 py-2 text-[11.5px] text-ink-subtle">Every app and platform this task must land on. Each one ships through its own version, on its own date.</p>
        </div>
      )}
    </div>
  );
}

/**
 * The one task form, used by the global composer (create) and the task page
 * (edit). `onSubmit` returns an error message to show, or null on success;
 * the caller owns navigation / cache invalidation / toasts.
 */
export function TaskFormSheet({
  mode,
  initial,
  onClose,
  onSubmit,
  secondaryLabel,
  onSecondary,
}: {
  mode: "create" | "edit";
  initial?: Partial<TaskFormValues>;
  onClose: () => void;
  onSubmit: (values: TaskFormValues) => Promise<string | null>;
  /** Optional second submit (e.g. "Create & open"). */
  secondaryLabel?: string;
  onSecondary?: (values: TaskFormValues) => Promise<string | null>;
}) {
  const { me } = useSession();
  const { toast } = useToast();
  const { data: usersData } = useCachedFetch<{ users: UserBrief[] }>("/api/users");
  const { data: appsData } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const allUsers = useMemo(() => usersData?.users ?? [], [usersData]);
  const apps = useMemo(() => appsData?.apps ?? [], [appsData]);

  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [targets, setTargets] = useState<TargetRef[]>(initial?.targets ?? []);
  const [type, setType] = useState<TaskType>(initial?.type ?? "feature");
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? "medium");
  const [assignees, setAssignees] = useState<string[]>(initial?.assignee_ids ?? []);
  // Only members of the target app(s) can be assigned; a general task is open
  // to everyone. Changing the targets prunes anyone who no longer qualifies.
  const eligibleFor = useCallback(
    (t: TargetRef[]) => {
      if (!t.length) return allUsers;
      const ok = new Set<string>();
      for (const a of apps) if (t.some((x) => x.app_id === a.id)) for (const m of a.members) ok.add(m.user.id);
      return allUsers.filter((u) => ok.has(u.id));
    },
    [allUsers, apps]
  );
  const users = useMemo(() => eligibleFor(targets), [eligibleFor, targets]);
  const targetAppNames = useMemo(() => apps.filter((a) => targets.some((t) => t.app_id === a.id)).map((a) => a.name), [apps, targets]);
  const changeTargets = (t: TargetRef[]) => {
    setTargets(t);
    if (!usersData || !appsData) return; // lists still loading: nothing to prune against yet
    const ok = new Set(eligibleFor(t).map((u) => u.id));
    setAssignees((a) => a.filter((id) => ok.has(id)));
  };
  const [due, setDue] = useState(initial?.due_date ?? "");
  const [labels, setLabels] = useState<string[]>(initial?.labels ?? []);
  const [labelDraft, setLabelDraft] = useState("");
  const [estimate, setEstimate] = useState(initial?.estimate_hours != null ? String(initial.estimate_hours) : "");
  const [seriesId, setSeriesId] = useState<string>(initial?.series_id ?? "");
  const { data: seriesData } = useCachedFetch<{ series: { id: string; name: string; color: string }[] }>("/api/meeting-series");
  const seriesOptions = useMemo(() => [{ value: "", label: "Not on a meeting" }, ...(seriesData?.series ?? []).map((s) => ({ value: s.id, label: s.name }))], [seriesData]);
  const [busy, setBusy] = useState<false | "primary" | "secondary">(false);
  // Validation and save problems surface as error toasts, not inline text.
  const setError = (m: string) => {
    if (m) toast(m, "error");
  };
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => titleRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, []);

  function addLabel(raw: string) {
    const l = raw.trim().replace(/^#/, "").toLowerCase().slice(0, LIMITS.label);
    if (!l) return;
    setLabels((cur) => (cur.includes(l) || cur.length >= LIMITS.labelsPerTask ? cur : [...cur, l]));
    setLabelDraft("");
  }

  function collect(): TaskFormValues | null {
    const t = title.trim();
    if (!t) {
      setError("Give the task a title.");
      titleRef.current?.focus();
      return null;
    }
    const pending = labelDraft.trim().replace(/^#/, "").toLowerCase();
    const allLabels = pending && !labels.includes(pending) ? [...labels, pending] : labels;
    return {
      title: t,
      description,
      targets,
      type,
      priority,
      assignee_ids: assignees,
      due_date: due || null,
      labels: allLabels,
      estimate_hours: estimate ? Number(estimate) : null,
      series_id: seriesId || null,
    };
  }

  const dirty =
    !same(title, initial?.title ?? "") ||
    !same(description, initial?.description ?? "") ||
    !same(targets.map((t) => `${t.app_id}:${t.platform}`), (initial?.targets ?? []).map((t) => `${t.app_id}:${t.platform}`)) ||
    type !== (initial?.type ?? "feature") ||
    priority !== (initial?.priority ?? "medium") ||
    !same(assignees, initial?.assignee_ids ?? []) ||
    !same(due, initial?.due_date ?? "") ||
    !same(labels, initial?.labels ?? []) ||
    !same(estimate, initial?.estimate_hours != null ? String(initial.estimate_hours) : "") ||
    !same(seriesId, initial?.series_id ?? "");
  const close = useDiscardGuard(dirty && !busy, onClose);
  useSubmitShortcut(() => void run("primary"));

  async function run(which: "primary" | "secondary") {
    if (busy) return;
    const values = collect();
    if (!values) return;
    setBusy(which);
    setError("");
    const err = await (which === "secondary" && onSecondary ? onSecondary(values) : onSubmit(values));
    if (err) {
      setBusy(false);
      setError(err);
    }
    // On success the caller closes the sheet; keep the spinner until unmount.
  }

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="mr-auto hidden text-[11px] text-ink-subtle sm:inline">
        <kbd className="rounded border border-line bg-canvas px-1 py-0.5 font-sans">Ctrl</kbd>+<kbd className="rounded border border-line bg-canvas px-1 py-0.5 font-sans">Enter</kbd> to save
      </span>
      {secondaryLabel && onSecondary && (
        <Button variant="secondary" onClick={() => void run("secondary")} disabled={!!busy}>
          {busy === "secondary" ? <Spinner /> : secondaryLabel}
        </Button>
      )}
      <Button onClick={() => void run("primary")} disabled={!!busy}>
        {busy === "primary" ? <Spinner /> : mode === "create" ? "Create task" : "Save changes"}
      </Button>
    </div>
  );

  return (
    <Sheet
      title={mode === "create" ? "New task" : "Edit task"}
      description={mode === "create" ? "Describe the work, pick where it ships and who's on it." : "Status is changed from the task page, not here."}
      onClose={close}
      footer={footer}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run("primary");
        }}
        className="flex flex-col gap-4"
      >
        <Field label="Title">
          <Input
            ref={titleRef}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
                    }}
            placeholder="e.g. Fix crash when opening the share sheet"
            maxLength={LIMITS.title}
            className="h-11 text-[15px]"
          />
        </Field>
        <Field label="Description" hint="Steps, links, acceptance criteria. Plain text — links and T-12 references become clickable.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} placeholder="What needs to happen?" maxLength={LIMITS.description} />
        </Field>

        <Field label="Where it ships">
          {appsData ? <TargetPicker apps={apps} value={targets} onChange={changeTargets} /> : <div className={cn(controlClass, "flex h-10 items-center text-ink-subtle")}>Loading apps…</div>}
        </Field>

        <Field label="Meeting" hint={targets.length ? "Optional: app tasks already reach the meetings that cover their app." : "A general task only reaches a meeting when attached here. It then shows on that series' meetings until it's done."}>
          <Dropdown value={seriesId} onChange={setSeriesId} options={seriesOptions} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            <Dropdown value={type} onChange={(v) => setType(v as TaskType)} options={TYPE_OPTIONS} />
          </Field>
          <Field label="Priority">
            <Dropdown value={priority} onChange={(v) => setPriority(v as Priority)} options={PRIORITY_OPTIONS} />
          </Field>
        </div>

        <Field label="Assignees">
          <PeoplePicker users={users} value={assignees} onChange={setAssignees} max={LIMITS.assigneesPerTask} placeholder={targets.length && !users.length ? "No one is on this app yet" : "Assign teammates…"} />
          {targets.length > 0 && <p className="text-[11.5px] text-ink-subtle">Members of {targetAppNames.join(" / ") || "the chosen app"} only. An admin adds people from the app&rsquo;s People tab.</p>}
          {me && !assignees.includes(me.id) && users.some((u) => u.id === me.id) && (
            <button type="button" onClick={() => setAssignees((a) => [...a, me.id])} className="self-start text-xs font-medium text-brand-700 hover:text-brand-800">
              + Assign to me
            </button>
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Due date">
            <DateInput value={due} onChange={setDue} />
          </Field>
          <Field label="Estimate (hours)">
            <Input type="number" inputMode="decimal" min={0} max={9999} step={0.5} value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder="optional" />
          </Field>
        </div>

        <Field label="Labels" hint="Press Enter or comma to add. Up to 10.">
          <div className={cn(controlClass, "flex min-h-10 flex-wrap items-center gap-1.5 py-1.5 focus-within:border-ink focus-within:ring-2 focus-within:ring-ink/15")}>
            {labels.map((l) => (
              <LabelChip key={l} label={l} onRemove={() => setLabels((cur) => cur.filter((x) => x !== l))} />
            ))}
            <input
              data-nested-input
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addLabel(labelDraft);
                } else if (e.key === "Backspace" && !labelDraft && labels.length) {
                  setLabels((cur) => cur.slice(0, -1));
                }
              }}
              onBlur={() => labelDraft && addLabel(labelDraft)}
              placeholder={labels.length ? "" : "e.g. crash, onboarding"}
              className="min-w-[120px] flex-1 bg-transparent text-sm placeholder:text-ink-subtle/80"
              maxLength={LIMITS.label}
            />
          </div>
        </Field>

        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Sheet>
  );
}
