"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dropdown } from "@/components/ui/dropdown";
import { Segmented } from "@/components/ui/segmented";
import { Breadcrumb, LoadError, EmptyState, Spinner, StatCard } from "@/components/ui/misc";
import { ListSkeleton, PanelSkeleton } from "@/components/ui/skeleton";
import { Avatar } from "@/components/ui/avatar";
import { AppTile, PlatformBadge } from "@/components/ui/task-chips";
import { PeoplePicker } from "@/components/ui/people-picker";
import { TaskList } from "@/components/task-list";
import { AppFormSheet } from "@/components/app-form";
import { ReleaseFormSheet, ReleaseRow, ReleaseViewSheet } from "@/components/release-ui";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { useTaskComposer } from "@/components/task-composer";
import { useCachedFetch, mutate, mutatePrefix } from "@/lib/client-cache";
import { useDocumentTitle } from "@/lib/use-document-title";
import { postJson, deleteJson } from "@/lib/http";
import { cn } from "@/lib/cn";
import { APP_ROLES, APP_ROLE_META, DEPARTMENT_META, type AppRole } from "@/lib/domain";
import { IconPlus, IconEdit, IconTasks, IconRocket, IconUsers, IconSettings, IconExternal, IconAndroid, IconApple, IconTrash, IconArchive, IconX } from "@/components/ui/icons";
import type { AppOverview, Release, TaskCard, UserBrief } from "@/lib/types";

type Tab = "tasks" | "releases" | "members" | "settings";

export default function AppPage() {
  return (
    <Suspense fallback={<PanelSkeleton />}>
      <AppScreen />
    </Suspense>
  );
}

function AppScreen() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAdmin } = useSession();
  const composer = useTaskComposer();
  const { toast } = useToast();
  const { data, loading, error, refresh } = useCachedFetch<{ app: AppOverview }>(`/api/apps/${id}`, {
    onError: (e) => {
      if ((e as { status?: number }).status === 404) {
        toast("That app doesn't exist, or you aren't on it", "error");
        router.replace("/apps");
      }
    },
  });
  const { data: appsData } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const app = data?.app ?? null;
  const tabParam = searchParams.get("tab") as Tab | null;
  const tab: Tab = tabParam && ["tasks", "releases", "members", "settings"].includes(tabParam) && (tabParam !== "settings" || isAdmin) ? tabParam : "tasks";
  const setTab = (t: Tab) => router.replace(`/apps/${id}${t === "tasks" ? "" : `?tab=${t}`}`, { scroll: false });
  const [editing, setEditing] = useState(false);
  useDocumentTitle(app ? `${app.name} · FactoTasks` : "App · FactoTasks");

  if (loading) return <PanelSkeleton />;
  if (error && !app) return <LoadError title="Couldn't load this app" onRetry={refresh} />;
  if (!app) return null;

  const TABS: { id: Tab; label: string; icon: React.ReactNode; admin?: boolean }[] = [
    { id: "tasks", label: "Tasks", icon: <IconTasks size={15} /> },
    { id: "releases", label: "Releases", icon: <IconRocket size={15} /> },
    { id: "members", label: "Members", icon: <IconUsers size={15} /> },
    { id: "settings", label: "Settings", icon: <IconSettings size={15} />, admin: true },
  ];
  const playUrl = app.android_package ? `https://play.google.com/store/apps/details?id=${encodeURIComponent(app.android_package)}` : null;

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <Breadcrumb items={[{ label: "Apps", href: "/apps" }, { label: app.name }]} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <AppTile name={app.name} color={app.color} iconUrl={app.icon_url} className="h-14 w-14 text-xl" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[20px] font-bold leading-tight tracking-[-0.02em] text-ink sm:text-[24px]">{app.name}</h1>
              {app.status === "archived" && <Badge tone="neutral">Archived</Badge>}
            </div>
            {app.description && <p className="mt-1 max-w-2xl text-sm text-ink-muted">{app.description}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
              {app.has_android && (
                <span className="inline-flex items-center gap-1">
                  <IconAndroid size={13} /> {app.latest_android ? `v${app.latest_android.version_name}` : "no release yet"}
                  {playUrl && (
                    <a href={playUrl} target="_blank" rel="noopener noreferrer" className="ml-0.5 text-brand-700 hover:text-brand-800" title="Open on Google Play">
                      <IconExternal size={12} />
                    </a>
                  )}
                </span>
              )}
              {app.has_ios && (
                <span className="inline-flex items-center gap-1">
                  <IconApple size={13} /> {app.latest_ios ? `v${app.latest_ios.version_name}` : "no release yet"}
                  {app.appstore_url && (
                    <a href={app.appstore_url} target="_blank" rel="noopener noreferrer" className="ml-0.5 text-brand-700 hover:text-brand-800" title="Open on the App Store">
                      <IconExternal size={12} />
                    </a>
                  )}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isAdmin && (
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              <IconEdit size={15} /> Edit
            </Button>
          )}
          <Button size="sm" onClick={() => composer.open({ app_id: app.id })}>
            <IconPlus size={15} /> New task
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Open" value={app.open_tasks} />
        <StatCard label="In progress" value={app.in_progress} />
        <StatCard label="Overdue" value={app.overdue} />
        <StatCard label="Done this week" value={app.done_week} />
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-line no-scrollbar">
        {TABS.filter((t) => !t.admin || isAdmin).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
              tab === t.id ? "border-brand-600 text-brand-700" : "border-transparent text-ink-muted hover:text-ink"
            )}
            aria-current={tab === t.id ? "page" : undefined}
          >
            {t.icon} {t.label}
            {t.id === "members" && <span className="text-xs text-ink-subtle">{app.members.length}</span>}
          </button>
        ))}
      </div>

      {tab === "tasks" && <TasksTab app={app} />}
      {tab === "releases" && <ReleasesTab app={app} apps={appsData?.apps ?? [app]} />}
      {tab === "members" && <MembersTab app={app} />}
      {tab === "settings" && isAdmin && <SettingsTab app={app} onEdit={() => setEditing(true)} />}

      {editing && <AppFormSheet app={app} onClose={() => setEditing(false)} />}
    </div>
  );
}

function TasksTab({ app }: { app: AppOverview }) {
  const [scope, setScope] = useState<"open" | "done" | "all">("open");
  const { data, loading, error, refresh } = useCachedFetch<{ tasks: TaskCard[] }>(`/api/tasks?app=${app.id}&scope=${scope}&limit=100`);
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex items-center justify-between gap-3">
        <CardTitle>Tasks</CardTitle>
        <Segmented size="sm" value={scope} onChange={setScope} options={[{ value: "open", label: "Open" }, { value: "done", label: "Done" }, { value: "all", label: "All" }]} aria-label="Task scope" />
      </CardHeader>
      {loading ? <ListSkeleton rows={5} /> : error && !data ? <LoadError onRetry={refresh} /> : <TaskList tasks={data?.tasks ?? []} showApp={false} empty={scope === "open" ? "No open tasks for this app" : "No tasks here"} />}
      {data && data.tasks.length >= 100 && (
        <div className="border-t border-line/80 p-3 text-center text-xs text-ink-subtle">
          Showing the first 100 —{" "}
          <Link href={`/tasks?app=${app.id}&scope=${scope}`} className="font-medium text-brand-700">
            open the full list
          </Link>
          .
        </div>
      )}
    </Card>
  );
}

function ReleasesTab({ app, apps }: { app: AppOverview; apps: AppOverview[] }) {
  const { me, isAdmin } = useSession();
  const { data, loading, error, refresh } = useCachedFetch<{ releases: Release[] }>(`/api/releases?app=${app.id}`);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Release | null>(null);
  const canManage = isAdmin || app.members.some((m) => m.user.id === me?.id);
  const releases = data?.releases ?? [];
  const upcoming = releases.filter((r) => !["released", "cancelled", "rolled_back"].includes(r.status));
  const shipped = releases.filter((r) => ["released", "cancelled", "rolled_back"].includes(r.status));
  return (
    <>
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-ink-muted">Version-wise log per platform. Link tasks to a version from the task editor.</p>
          {canManage && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <IconPlus size={15} /> New release
            </Button>
          )}
        </div>
        {loading ? (
          <ListSkeleton rows={4} />
        ) : error && !data ? (
          <LoadError onRetry={refresh} />
        ) : releases.length === 0 ? (
          <EmptyState icon={<IconRocket size={20} />} title="No releases logged yet" description="Add the version you're working on now — planned date, what's in it, and the team sees it on the dashboard and in the weekly MOM." action={canManage ? <Button size="sm" onClick={() => setAdding(true)}>New release</Button> : undefined} />
        ) : (
          <>
            <Card className="overflow-hidden">
              <CardHeader>
                <CardTitle>Upcoming &amp; in progress</CardTitle>
              </CardHeader>
              {upcoming.length ? (
                <ul className="divide-y divide-line/80">
                  {upcoming.map((r) => (
                    <ReleaseRow key={r.id} r={r} showApp={false} onOpen={setOpen} />
                  ))}
                </ul>
              ) : (
                <CardBody>
                  <p className="text-sm text-ink-subtle">Nothing in the pipeline.</p>
                </CardBody>
              )}
            </Card>
            {shipped.length > 0 && (
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Released</CardTitle>
                </CardHeader>
                <ul className="divide-y divide-line/80">
                  {shipped.map((r) => (
                    <ReleaseRow key={r.id} r={r} showApp={false} onOpen={setOpen} />
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>
      {adding && <ReleaseFormSheet apps={apps} appId={app.id} onClose={() => setAdding(false)} />}
      {open && <ReleaseViewSheet release={open} apps={apps} onClose={() => setOpen(null)} />}
    </>
  );
}

const ROLE_OPTIONS = APP_ROLES.map((r) => ({ value: r, label: APP_ROLE_META[r].label }));

function MembersTab({ app }: { app: AppOverview }) {
  const { isAdmin } = useSession();
  const { toast } = useToast();
  const { confirm } = useDialog();
  const { data: usersData } = useCachedFetch<{ users: UserBrief[] }>("/api/users");
  const users = useMemo(() => usersData?.users ?? [], [usersData]);
  const [draft, setDraft] = useState<{ user_id: string; app_role: AppRole }[] | null>(null);
  const [adding, setAdding] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const rows = draft ?? app.members.map((m) => ({ user_id: m.user.id, app_role: m.app_role }));
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const dirty = draft !== null;

  async function save() {
    if (!draft || busy) return;
    const removed = app.members.filter((m) => !draft.some((d) => d.user_id === m.user.id)).map((m) => m.user.name);
    if (removed.length && !(await confirm({ title: `Remove ${removed.join(", ")} from ${app.name}?`, message: "They lose access to this app's tasks and releases, and are taken off any of its tasks they were assigned to.", confirmLabel: "Remove", tone: "danger" }))) return;
    setBusy(true);
    const { ok, data } = await postJson(`/api/apps/${app.id}/members`, { members: draft }, "PUT");
    setBusy(false);
    if (ok) {
      toast("Members updated");
      setDraft(null);
      mutate(`/api/apps/${app.id}`);
      mutate("/api/apps");
      mutate("/api/team");
      mutatePrefix("/api/tasks"); // assignee chips on their tasks
    } else toast(data?.error || "Couldn't save members", "error");
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>People on {app.name}</CardTitle>
        {isAdmin && (
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <div className="min-w-[220px] flex-1">
              <PeoplePicker
                users={users.filter((u) => !rows.some((r) => r.user_id === u.id))}
                value={adding}
                onChange={(ids) => {
                  setAdding([]);
                  if (ids.length) setDraft([...rows, ...ids.filter((id) => !rows.some((r) => r.user_id === id)).map((id) => ({ user_id: id, app_role: "developer" as AppRole }))]);
                }}
                placeholder="Add a teammate…"
                single
              />
            </div>
          </div>
        )}
      </CardHeader>
      {rows.length === 0 ? (
        <CardBody>
          <EmptyState icon={<IconUsers size={20} />} title="No one assigned yet" description={isAdmin ? "Add the developers, designer and QA working on this app." : "An admin assigns people to apps."} />
        </CardBody>
      ) : (
        <ul className="divide-y divide-line/80">
          {rows.map((r) => {
            const u = byId.get(r.user_id) ?? app.members.find((m) => m.user.id === r.user_id)?.user;
            if (!u) return null;
            return (
              <li key={r.user_id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                <Avatar user={u} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{u.name}</div>
                  <div className="truncate text-xs text-ink-subtle">{DEPARTMENT_META[u.department]?.label ?? u.department}</div>
                </div>
                {isAdmin ? (
                  <>
                    <div className="w-36">
                      <Dropdown value={r.app_role} onChange={(v) => setDraft(rows.map((x) => (x.user_id === r.user_id ? { ...x, app_role: v as AppRole } : x)))} options={ROLE_OPTIONS} className="[&>button]:h-9" />
                    </div>
                    <button type="button" onClick={() => setDraft(rows.filter((x) => x.user_id !== r.user_id))} className="tap rounded-md p-1.5 text-ink-subtle hover:bg-red-50 hover:text-red-600" aria-label={`Remove ${u.name}`}>
                      <IconX size={16} />
                    </button>
                  </>
                ) : (
                  <Badge tone="neutral">{APP_ROLE_META[r.app_role].label}</Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {isAdmin && dirty && (
        <div className="flex items-center justify-end gap-2 border-t border-line/80 px-4 py-3 sm:px-5">
          <Button variant="secondary" size="sm" onClick={() => setDraft(null)} disabled={busy}>
            Discard
          </Button>
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? <Spinner /> : "Save members"}
          </Button>
        </div>
      )}
    </Card>
  );
}

function SettingsTab({ app, onEdit }: { app: AppOverview; onEdit: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const { confirm } = useDialog();
  const [busy, setBusy] = useState(false);

  async function setStatus(status: AppOverview["status"]) {
    setBusy(true);
    const { ok, data } = await postJson(`/api/apps/${app.id}`, { status }, "PATCH");
    setBusy(false);
    if (ok) {
      toast(status === "archived" ? "App archived" : "App updated");
      mutate(`/api/apps/${app.id}`);
      mutate("/api/apps");
      mutatePrefix("/api/tasks");
    } else toast(data?.error || "Couldn't update", "error");
  }

  async function remove() {
    if (!(await confirm({ title: `Delete ${app.name}?`, message: "Only possible when the app has no tasks or releases. Otherwise archive it.", confirmLabel: "Delete", tone: "danger" }))) return;
    const { ok, data } = await deleteJson(`/api/apps/${app.id}`);
    if (ok) {
      toast("App deleted");
      mutate("/api/apps");
      router.replace("/apps");
    } else toast(data?.error || "Couldn't delete", "error");
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3 text-sm">
          <Row label="Platforms">
            <span className="inline-flex gap-1.5">
              {app.has_android && <PlatformBadge platform="android" />}
              {app.has_ios && <PlatformBadge platform="ios" />}
            </span>
          </Row>
          <Row label="Android package">{app.android_package || "—"}</Row>
          <Row label="iOS bundle id">{app.ios_bundle_id || "—"}</Row>
          <Row label="App Store link">{app.appstore_url ? <a href={app.appstore_url} className="text-brand-700 hover:underline" target="_blank" rel="noopener noreferrer">{app.appstore_url}</a> : "—"}</Row>
          <Button variant="secondary" size="sm" className="self-start" onClick={onEdit}>
            <IconEdit size={14} /> Edit details
          </Button>
        </CardBody>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Lifecycle</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="text-sm text-ink-muted">
            {app.status === "archived" ? "Archived apps are hidden from pickers; their history stays intact." : "Active — tasks and releases can be added."}
          </p>
          <div className="flex flex-wrap gap-2">
            {app.status !== "active" && (
              <Button variant="secondary" size="sm" onClick={() => setStatus("active")} disabled={busy}>
                Mark active
              </Button>
            )}
                        {app.status !== "archived" && (
              <Button variant="secondary" size="sm" onClick={() => setStatus("archived")} disabled={busy}>
                <IconArchive size={14} /> Archive
              </Button>
            )}
            <Button variant="danger" size="sm" onClick={remove} disabled={busy}>
              <IconTrash size={14} /> Delete
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-ink-subtle">{label}</span>
      <span className="min-w-0 break-words text-right text-ink">{children}</span>
    </div>
  );
}
