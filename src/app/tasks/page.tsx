"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dropdown } from "@/components/ui/dropdown";
import { Segmented } from "@/components/ui/segmented";
import { controlClass } from "@/components/ui/field";
import { LoadError, Spinner, PageHeader } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { TaskList } from "@/components/task-list";
import { useTaskComposer } from "@/components/task-composer";
import { useSession } from "@/components/providers/session-provider";
import { useToast } from "@/components/ui/toast";
import { useCachedFetch } from "@/lib/client-cache";
import { timeoutSignal } from "@/lib/compat";
import { cn } from "@/lib/cn";
import { useLatest } from "@/lib/use-latest";
import { useOnChange } from "@/lib/use-on-change";
import { usePref } from "@/lib/use-pref";
import { PRIORITIES, PRIORITY_META, STATUS_META, TASK_STATUSES, TASK_TYPES, TYPE_META } from "@/lib/domain";
import { IconPlus, IconSearch, IconX, IconFilter, IconBoard, IconList } from "@/components/ui/icons";
import type { Meeting, AppOverview, TaskCard, UserBrief } from "@/lib/types";

interface Page {
  tasks: TaskCard[];
  hasMore: boolean;
  nextCursor: string | null;
  nextOffset: number | null;
}

const SCOPES: { value: "open" | "mine" | "done" | "all"; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "mine", label: "Mine" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

const SORTS = [
  { value: "updated", label: "Recently updated" },
  { value: "priority", label: "Priority" },
  { value: "due", label: "Due date" },
  { value: "created", label: "Newest" },
  { value: "number", label: "Task number" },
];

const KEYS = ["scope", "status", "app", "assignee", "priority", "type", "platform", "due", "meeting", "kind", "series", "label", "sort", "q", "group"] as const;
type Filters = Partial<Record<(typeof KEYS)[number], string>>;

function toQuery(f: Filters): string {
  const sp = new URLSearchParams();
  for (const k of KEYS) {
    const v = f[k];
    if (v && !(k === "scope" && v === "open") && !(k === "sort" && v === "updated")) sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
/** The API ignores `group`; strip it so the cache key is stable. */
function apiQuery(f: Filters): string {
  const { group: _g, ...rest } = f;
  return toQuery(rest);
}

export default function TasksPage() {
  return (
    <Suspense fallback={<ListSkeleton rows={8} />}>
      <TasksScreen />
    </Suspense>
  );
}

function TasksScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { me, isAdmin } = useSession();
  const { toast } = useToast();
  const composer = useTaskComposer();

  const filters = useMemo<Filters>(() => {
    const f: Filters = {};
    for (const k of KEYS) {
      const v = searchParams.get(k);
      if (v) f[k] = v;
    }
    return f;
  }, [searchParams]);
  // "approvals" is the admin queue; anyone else lands on the open list.
  const scope = ((filters.scope === "approvals" && !isAdmin ? "open" : filters.scope) || "open") as "open" | "mine" | "done" | "all";
  // Layout and default sort are personal, remembered on the account.
  const [layout, setLayout] = usePref<"app" | "flat">("tasks.layout", "app");
  const [sortPref, setSortPref] = usePref<string>("tasks.sort", "updated");
  const sort = filters.sort || sortPref;
  const grouped = layout === "app";
  const set = useCallback(
    (patch: Filters) => {
      const next: Filters = { ...filters, ...patch };
      for (const k of KEYS) if (!next[k]) delete next[k];
      router.replace(`${pathname}${toQuery(next)}`, { scroll: false });
    },
    [filters, pathname, router]
  );

  const [q, setQ] = useState(filters.q || "");
  useOnChange(filters.q || "", () => setQ(filters.q || ""));
  const setRef = useLatest(set);
  useEffect(() => {
    if ((filters.q || "") === q.trim()) return;
    const t = window.setTimeout(() => setRef.current({ q: q.trim() || undefined }), 300);
    return () => window.clearTimeout(t);
  }, [q, filters.q, setRef]);

  const url = `/api/tasks${apiQuery({ ...filters, sort: sort === "updated" ? undefined : sort }) || "?scope=open"}`;
  const { data, loading, error, refresh } = useCachedFetch<Page>(url);
  const { data: appsData } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const { data: usersData } = useCachedFetch<{ users: UserBrief[] }>("/api/users");

  const [more, setMore] = useState<{ url: string; tasks: TaskCard[]; cursor: string | null; offset: number | null; hasMore: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useOnChange(url, () => setMore(null));
  const tasks = useMemo(() => {
    const first = data?.tasks ?? [];
    if (!more || more.url !== url) return first;
    const seen = new Set(first.map((t) => t.id));
    return [...first, ...more.tasks.filter((t) => !seen.has(t.id))];
  }, [data, more, url]);
  const hasMore = more && more.url === url ? more.hasMore : !!data?.hasMore;

  async function loadMore() {
    if (loadingMore || !data) return;
    const cursor = more?.url === url ? more.cursor : data.nextCursor;
    const offset = more?.url === url ? more.offset : data.nextOffset;
    if (!cursor && offset == null) return;
    setLoadingMore(true);
    try {
      const sep = url.includes("?") ? "&" : "?";
      const r = await fetch(`${url}${sep}${cursor ? `cursor=${encodeURIComponent(cursor)}` : `offset=${offset}`}`, { signal: timeoutSignal(15_000) });
      if (!r.ok) throw new Error(String(r.status));
      const page = (await r.json()) as Page;
      setMore((cur) => ({ url, tasks: [...(cur?.url === url ? cur.tasks : []), ...page.tasks], cursor: page.nextCursor, offset: page.nextOffset, hasMore: page.hasMore }));
    } catch {
      toast("Couldn't load more tasks — try again", "error");
    } finally {
      setLoadingMore(false);
    }
  }

  const apps = useMemo(() => appsData?.apps ?? [], [appsData]);
  const appOrder = useMemo(() => apps.map((a) => a.id), [apps]);
  const users = useMemo(() => usersData?.users ?? [], [usersData]);
  const appOptions = useMemo(() => [{ value: "", label: "All apps" }, { value: "general", label: "General (no app)" }, ...apps.map((a) => ({ value: a.id, label: a.name }))], [apps]);
  const userOptions = useMemo(
    () => [{ value: "", label: "Anyone" }, ...(me ? [{ value: "me", label: "Me" }] : []), { value: "none", label: "Unassigned" }, ...users.filter((u) => u.is_active).map((u) => ({ value: u.id, label: u.name }))],
    [users, me]
  );
  const statusOptions = useMemo(() => [{ value: "", label: "Any status" }, ...TASK_STATUSES.map((s) => ({ value: s, label: STATUS_META[s].label }))], []);
  const priorityOptions = useMemo(() => [{ value: "", label: "Any priority" }, ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label }))], []);
  const typeOptions = useMemo(() => [{ value: "", label: "Any type" }, ...TASK_TYPES.map((t) => ({ value: t, label: TYPE_META[t].label }))], []);
  const platformOptions = [
    { value: "", label: "Any platform" },
    { value: "android", label: "Android" },
    { value: "ios", label: "iOS" },
  ];
  const dueOptions = [
    { value: "", label: "Any due date" },
    { value: "overdue", label: "Overdue" },
    { value: "today", label: "Due today" },
    { value: "week", label: "Due this week" },
    { value: "none", label: "No due date" },
  ];
  const { data: meetingsData } = useCachedFetch<{ meetings: Meeting[] }>(isAdmin ? "/api/meetings" : null);
  const meetingOptions = useMemo(
    () => [{ value: "", label: "Any meeting" }, ...(meetingsData?.meetings ?? []).slice(0, 40).map((m) => ({ value: m.id, label: `${m.title}${m.status === "open" ? " · open" : ""}` }))],
    [meetingsData]
  );
  const { data: seriesData } = useCachedFetch<{ series: { id: string; name: string }[] }>("/api/meeting-series");
  const seriesOptions = useMemo(() => [{ value: "", label: "Any" }, { value: "any", label: "Attached to a meeting" }, { value: "none", label: "Not on a meeting" }, ...(seriesData?.series ?? []).map((s) => ({ value: s.id, label: s.name }))], [seriesData]);
  const activeCount = (["status", "app", "assignee", "priority", "type", "platform", "due", "meeting", "kind", "series", "label"] as const).filter((k) => filters[k]).length;
  const [showFilters, setShowFilters] = useState(activeCount > 0);

  return (
    <div className="flex flex-col gap-4 animate-fade-in">
      <PageHeader
        title="Tasks"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={scope} onChange={(v) => set({ scope: v === "open" ? undefined : v, status: undefined })} options={SCOPES.map((o) => ({ value: o.value, label: o.label }))} aria-label="Scope" />
            <Button onClick={() => composer.open({ app_id: filters.app && filters.app !== "general" ? filters.app : null })}>
              <IconPlus size={16} /> New task
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
          <IconSearch size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search or T-12…" className={cn(controlClass, "h-9 pl-8 pr-8")} aria-label="Search tasks" />
          {q && (
            <button type="button" onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-subtle hover:text-ink" aria-label="Clear search">
              <IconX size={14} />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          className={cn("inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition-colors", showFilters || activeCount ? "border-brand-200 bg-brand-50 text-brand-700" : "border-line bg-surface text-ink-muted hover:text-ink")}
          aria-expanded={showFilters}
        >
          <IconFilter size={14} /> Filters{activeCount ? ` · ${activeCount}` : ""}
        </button>
        <Segmented
          value={grouped ? "app" : "flat"}
          onChange={(v) => setLayout(v === "app" ? "app" : "flat")}
          options={[
            { value: "app", label: <IconBoard size={14} />, title: "Group by app" },
            { value: "flat", label: <IconList size={14} />, title: "Flat list" },
          ]}
          aria-label="Layout"
        />
        <div className="w-44">
          <Dropdown
            value={sort}
            onChange={(v) => {
              setSortPref(v);
              set({ sort: v === sortPref || v === "updated" ? undefined : v });
            }}
            options={SORTS}
            className="[&>button]:h-9 [&>button]:text-[13px]"
          />
        </div>
      </div>

      {showFilters && (
        <div className="rounded-xl border border-line bg-surface p-3">
          <div className="grid gap-x-3 gap-y-2.5 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))] [&_button]:h-9 [&_button]:text-[13px]">
            <FilterCell label="Status"><Dropdown value={filters.status || ""} onChange={(v) => set({ status: v || undefined })} options={statusOptions} /></FilterCell>
            <FilterCell label="App"><Dropdown value={filters.app || ""} onChange={(v) => set({ app: v || undefined })} options={appOptions} /></FilterCell>
            <FilterCell label="Assignee"><Dropdown value={filters.assignee || ""} onChange={(v) => set({ assignee: v || undefined })} options={userOptions} /></FilterCell>
            <FilterCell label="Priority"><Dropdown value={filters.priority || ""} onChange={(v) => set({ priority: v || undefined })} options={priorityOptions} /></FilterCell>
            <FilterCell label="Type"><Dropdown value={filters.type || ""} onChange={(v) => set({ type: v || undefined })} options={typeOptions} /></FilterCell>
            <FilterCell label="Platform"><Dropdown value={filters.platform || ""} onChange={(v) => set({ platform: v || undefined })} options={platformOptions} /></FilterCell>
            <FilterCell label="Due"><Dropdown value={filters.due || ""} onChange={(v) => set({ due: v || undefined })} options={dueOptions} /></FilterCell>
            <FilterCell label="Kind"><Dropdown value={filters.kind || ""} onChange={(v) => set({ kind: v || undefined, ...(v === "app" ? { series: undefined } : {}) })} options={[{ value: "", label: "App & general" }, { value: "app", label: "App tasks" }, { value: "general", label: "General tasks" }]} /></FilterCell>
            <FilterCell label="Meeting series" hint={filters.kind === "general" ? "General tasks reach a meeting only when attached" : undefined}><Dropdown value={filters.series || ""} onChange={(v) => set({ series: v || undefined })} options={seriesOptions} /></FilterCell>
            {isAdmin && <FilterCell label="Meeting" hint="Everything on that meeting's agenda"><Dropdown value={filters.meeting || ""} onChange={(v) => set({ meeting: v || undefined, ...(v ? { scope: "all" } : {}) })} options={meetingOptions} /></FilterCell>}
          </div>
          {(activeCount > 0 || filters.label) && (
            <button
              type="button"
              onClick={() => set({ status: undefined, app: undefined, assignee: undefined, priority: undefined, type: undefined, platform: undefined, due: undefined, meeting: undefined, kind: undefined, series: undefined, label: undefined })}
              className="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-ink-muted hover:text-ink"
            >
              <IconX size={13} /> Clear filters{filters.label ? ` (#${filters.label})` : ""}
            </button>
          )}
        </div>
      )}

      {loading ? (
        <ListSkeleton rows={8} />
      ) : error && !data ? (
        <LoadError title="Couldn't load tasks" onRetry={refresh} />
      ) : grouped ? (
        <>
          <TaskList tasks={tasks} groupBy="app" appOrder={appOrder} empty={scope === "mine" ? "Nothing assigned to you" : q ? `No tasks match “${q}”` : "No tasks match these filters"} />
          {hasMore && <LoadMore onClick={loadMore} busy={loadingMore} />}
        </>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <TaskList tasks={tasks} empty={scope === "mine" ? "Nothing assigned to you" : q ? `No tasks match “${q}”` : "No tasks match these filters"} />
          {hasMore && <LoadMore onClick={loadMore} busy={loadingMore} bordered />}
        </div>
      )}
    </div>
  );
}

function LoadMore({ onClick, busy, bordered }: { onClick: () => void; busy: boolean; bordered?: boolean }) {
  return (
    <div className={cn("flex justify-center p-3", bordered && "border-t border-line/80")}>
      <Button variant="secondary" size="sm" onClick={onClick} disabled={busy}>
        {busy ? <Spinner /> : "Load more"}
      </Button>
    </div>
  );
}

function FilterCell({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle" title={hint}>
        {label}
      </span>
      {children}
    </label>
  );
}
