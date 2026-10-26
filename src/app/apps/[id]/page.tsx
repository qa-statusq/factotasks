"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { Breadcrumb, LoadError, EmptyState, Spinner, StatCard } from "@/components/ui/misc";
import { ListSkeleton, PanelSkeleton } from "@/components/ui/skeleton";
import { Avatar } from "@/components/ui/avatar";
import { AppTile, PlatformGlyph } from "@/components/ui/task-chips";
import { PeoplePicker } from "@/components/ui/people-picker";
import { TaskList } from "@/components/task-list";
import { AppFormSheet } from "@/components/app-form";
import { ReleaseFormSheet, ReleaseRow, ReleaseViewSheet, prettyDate } from "@/components/release-ui";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useSession } from "@/components/providers/session-provider";
import { useTaskComposer } from "@/components/task-composer";
import { useCachedFetch, mutate, mutatePrefix } from "@/lib/client-cache";
import { useDocumentTitle } from "@/lib/use-document-title";
import { postJson, deleteJson } from "@/lib/http";
import { cn } from "@/lib/cn";
import { APP_ROLE_META, DEPARTMENT_META, appRoleForDepartment, type AppRole } from "@/lib/domain";
import { IconPlus, IconEdit, IconTasks, IconRocket, IconUsers, IconSettings, IconExternal, IconTrash, IconArchive, IconX } from "@/components/ui/icons";
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
  // Client state in the address: replaceState switches the tab at once, with no server round trip.
  const setTab = (t: Tab) => window.history.replaceState(null, "", `/apps/${id}${t === "tasks" ? "" : `?tab=${t}`}`);
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
                  <PlatformGlyph platform="android" size={14} /> {app.latest_android ? `v${app.latest_android.version_name}` : "no release yet"}
                  {playUrl && (
                    <a href={playUrl} target="_blank" rel="noopener noreferrer" className="ml-0.5 text-brand-700 hover:text-brand-800" title="Open on Google Play">
                      <IconExternal size={12} />
                    </a>
                  )}
                </span>
              )}
              {app.has_ios && (
                <span className="inline-flex items-center gap-1">
                  <PlatformGlyph platform="ios" size={14} /> {app.latest_ios ? `v${app.latest_ios.version_name}` : "no release yet"}
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
  const shipped = releases.filter((r) => r.status === "released");
  const dropped = releases.filter((r) => r.status === "cancelled" || r.status === "rolled_back");
  return (
    <>
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-ink-muted">Version-wise log per platform. Tick the tasks that ship in a version when you add or edit it.</p>
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
            {dropped.length > 0 && (
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Cancelled &amp; rolled back</CardTitle>
                </CardHeader>
                <ul className="divide-y divide-line/80">
                  {dropped.map((r) => (
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
                  // Their app role follows their department (set under People) — no second question here.
                  if (ids.length) setDraft([...rows, ...ids.filter((id) => !rows.some((r) => r.user_id === id)).map((id) => ({ user_id: id, app_role: appRoleForDepartment(byId.get(id)?.department) }))]);
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
                <Badge tone="neutral" title="From their department under People">{APP_ROLE_META[r.app_role].label}</Badge>
                {isAdmin && (
                  <button type="button" onClick={() => setDraft(rows.filter((x) => x.user_id !== r.user_id))} className="tap rounded-md p-1.5 text-ink-subtle hover:bg-red-50 hover:text-red-600" aria-label={`Remove ${u.name}`}>
                    <IconX size={16} />
                  </button>
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
  const [busy, setBusy] = useState<string | null>(null);
  const playUrl = app.android_package ? `https://play.google.com/store/apps/details?id=${encodeURIComponent(app.android_package)}` : null;

  async function setStatus(status: AppOverview["status"]) {
    if (busy) return;
    if (status === "archived" && !(await confirm({ title: `Archive ${app.name}?`, message: "It disappears from pickers, meeting scopes and the Apps list (under “archived”). Tasks, releases and history stay exactly as they are, and you can bring it back any time.", confirmLabel: "Archive" }))) return;
    setBusy("status");
    const { ok, data } = await postJson(`/api/apps/${app.id}`, { status }, "PATCH");
    setBusy(null);
    if (ok) {
      toast(status === "archived" ? "App archived" : "App is active again");
      mutate(`/api/apps/${app.id}`);
      mutate("/api/apps");
      mutatePrefix("/api/tasks");
    } else toast(data?.error || "Couldn't update", "error");
  }

  async function refreshIcon() {
    if (busy) return;
    setBusy("icon");
    const { ok, data } = await postJson(`/api/apps/${app.id}`, { refresh_icon: true }, "PATCH");
    setBusy(null);
    if (ok) {
      toast("Store icon refreshed");
      mutate(`/api/apps/${app.id}`);
      mutate("/api/apps");
    } else toast(data?.error || "Couldn't fetch the icon", "error");
  }

  async function remove() {
    if (busy) return;
    if (!(await confirm({ title: `Delete ${app.name}?`, message: "Only possible while the app has no tasks or releases; otherwise archive it. This cannot be undone.", confirmLabel: "Delete", tone: "danger" }))) return;
    setBusy("delete");
    const { ok, data } = await deleteJson(`/api/apps/${app.id}`);
    setBusy(null);
    if (ok) {
      toast("App deleted");
      mutate("/api/apps");
      router.replace("/apps");
    } else toast(data?.error || "Couldn't delete", "error");
  }

  const archived = app.status === "archived";
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* Identity */}
      <Card>
        <CardHeader className="flex items-center justify-between gap-3">
          <CardTitle>Identity</CardTitle>
          <Button variant="secondary" size="sm" onClick={onEdit}>
            <IconEdit size={14} /> Edit details
          </Button>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <div className="flex items-start gap-4">
            <AppTile name={app.name} color={app.color} iconUrl={app.icon_url} className="h-16 w-16 text-2xl" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[16px] font-semibold text-ink">{app.name}</span>
                <Badge tone="neutral">{app.kind === "b2b" ? "Business app" : "Consumer app"}</Badge>
                <Badge tone={archived ? "neutral" : "success"}>{archived ? "Archived" : app.status === "maintenance" ? "Maintenance" : "Active"}</Badge>
              </div>
              <p className="mt-1 text-[13px] text-ink-muted">{app.description?.trim() || <span className="text-ink-subtle">No description yet — say what the app does in a line.</span>}</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-subtle">
                <span>Added {prettyDate(app.created_at.slice(0, 10))}</span>
                <span>· {app.members.length} member{app.members.length === 1 ? "" : "s"}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-canvas/70 px-3 py-2 text-[12.5px] text-ink-muted">
            <span className="min-w-0 flex-1">{app.icon_url ? `Icons come from the store listings — ${app.icon_android_url ? "Google Play" : ""}${app.icon_android_url && app.icon_ios_url ? " and " : ""}${app.icon_ios_url ? "the App Store" : ""}. The main tile uses the Android icon when there is one.` : "No store icon yet — add the package or bundle id and fetch it."}</span>
            <Button variant="secondary" size="sm" onClick={refreshIcon} disabled={!!busy || (!app.android_package && !app.ios_bundle_id)}>
              {busy === "icon" ? <Spinner /> : "Fetch icon"}
            </Button>
          </div>
        </CardBody>
      </Card>

      {/* Store presence */}
      <Card>
        <CardHeader>
          <CardTitle>Platforms & stores</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <StoreRow platform="android" on={app.has_android} id={app.android_package} idLabel="Package" link={playUrl} linkLabel="Google Play" latest={app.latest_android} icon={app.icon_android_url} app={app} />
          <StoreRow platform="ios" on={app.has_ios} id={app.ios_bundle_id} idLabel="Bundle id" link={app.appstore_url} linkLabel="App Store" latest={app.latest_ios} icon={app.icon_ios_url} app={app} />
          <p className="text-[12px] text-ink-subtle">Platforms decide which targets a task can have and which releases the app can hold. Change them under Edit details.</p>
        </CardBody>
      </Card>

      {/* Lifecycle */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Lifecycle</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-4 md:grid-cols-2">
          <div className="flex items-start justify-between gap-4 rounded-xl border border-line p-4">
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold text-ink">{archived ? "Bring back" : "Archive"}</p>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">{archived ? "Make the app active again: it returns to pickers, scopes and the Apps list." : "Hide the app from pickers and meeting scopes once it is retired. Nothing is deleted."}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setStatus(archived ? "active" : "archived")} disabled={!!busy} className="shrink-0">
              {busy === "status" ? <Spinner /> : archived ? "Mark active" : <><IconArchive size={14} /> Archive</>}
            </Button>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-xl border border-red-200 bg-red-50/40 p-4">
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold text-red-700">Delete app</p>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">Only while it has no tasks or releases. Otherwise archive it, so history stays intact.</p>
            </div>
            <Button variant="danger" size="sm" onClick={remove} disabled={!!busy} className="shrink-0">
              {busy === "delete" ? <Spinner /> : <><IconTrash size={14} /> Delete</>}
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function StoreRow({ platform, on, id, idLabel, link, linkLabel, latest, icon, app }: { platform: "android" | "ios"; on: boolean; id: string | null; idLabel: string; link: string | null; linkLabel: string; latest: AppOverview["latest_android"]; icon?: string | null; app: AppOverview }) {
  return (
    <div className={cn("flex items-start gap-3 rounded-xl border border-line p-3", !on && "opacity-60")}>
      <span className="relative shrink-0">
        {on && icon ? <AppTile name={app.name} color={app.color} iconUrl={icon} className="h-10 w-10 text-sm" /> : <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-canvas ring-1 ring-inset ring-line"><PlatformGlyph platform={platform} size={18} /></span>}
        {on && icon && <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-surface ring-1 ring-line"><PlatformGlyph platform={platform} size={10} /></span>}
      </span>
      <div className="min-w-0 flex-1 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">{platform === "android" ? "Android" : "iOS"}</span>
          {on ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Not shipped here</Badge>}
          {on && <span className="text-ink-muted">{latest ? `latest v${latest.version_name}` : "no release yet"}</span>}
        </div>
        {on && (
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12.5px]">
            <dt className="text-ink-subtle">{idLabel}</dt>
            <dd className="break-all font-mono text-[12px] text-ink">{id || <span className="font-sans text-ink-subtle">not set</span>}</dd>
            <dt className="text-ink-subtle">Listing</dt>
            <dd className="min-w-0">
              {link ? (
                <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:underline">
                  {linkLabel} <IconExternal size={12} />
                </a>
              ) : (
                <span className="text-ink-subtle">no link yet</span>
              )}
            </dd>
          </dl>
        )}
      </div>
    </div>
  );
}
