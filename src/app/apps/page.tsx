"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadError, EmptyState, Spinner, PageHeader } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { AvatarStack } from "@/components/ui/avatar";
import { AppTile, ReleaseStatusBadge, PlatformGlyph } from "@/components/ui/task-chips";
import { SortableList } from "@/components/ui/sortable";
import { AppFormSheet } from "@/components/app-form";
import { useSession } from "@/components/providers/session-provider";
import { useToast } from "@/components/ui/toast";
import { useCachedFetch, prefetch, mutate, mutatePrefix } from "@/lib/client-cache";
import { postJson } from "@/lib/http";
import { cn } from "@/lib/cn";
import { IconApps, IconPlus, IconChevronRight, IconGrip, IconCheck } from "@/components/ui/icons";
import type { AppOverview } from "@/lib/types";

export default function AppsPage() {
  const { isAdmin } = useSession();
  const { toast } = useToast();
  const { data, loading, error, refresh } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // Arrange mode: a draft order of the live apps, saved in one go.
  const [draft, setDraft] = useState<AppOverview[] | null>(null);
  const [saving, setSaving] = useState(false);
  const apps = useMemo(() => (data?.apps ?? []).filter((a) => showArchived || a.status !== "archived"), [data, showArchived]);
  const archivedCount = (data?.apps ?? []).filter((a) => a.status === "archived").length;

  async function saveOrder() {
    if (!draft || saving) return;
    setSaving(true);
    const { ok, data: res } = await postJson(`/api/apps/reorder`, { ids: draft.map((a) => a.id) }, "PATCH");
    setSaving(false);
    if (!ok) return toast(res?.error || "Couldn't save the order", "error");
    toast("Apps arranged");
    setDraft(null);
    mutate("/api/apps");
    mutate("/api/team");
    mutatePrefix("/api/tasks");
    mutatePrefix("/api/meetings");
    mutate("/api/meeting-series");
  }

  return (
    <div className="flex flex-col gap-4 animate-fade-in">
      <PageHeader
        title="Apps"
        description={draft ? "Drag by the grip (or use the arrows). This order is used on every screen that lists apps, including meeting decks unless a series sets its own." : "Every app the team ships, with what is open and what shipped last."}
        actions={
          <>
        {isAdmin && !draft && (
          <div className="flex items-center gap-2">
            {apps.length > 1 && (
              <Button variant="secondary" onClick={() => setDraft((data?.apps ?? []).filter((a) => a.status !== "archived"))} title="Drag the apps into the order every list and the meeting deck should use">
                <IconGrip size={15} /> Arrange
              </Button>
            )}
            <Button onClick={() => setAdding(true)}>
              <IconPlus size={16} /> Add app
            </Button>
          </div>
        )}
        {draft && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={saveOrder} disabled={saving}>
              {saving ? <Spinner /> : <IconCheck size={15} />} Save order
            </Button>
          </div>
        )}
          </>
        }
      />
      {draft ? (
        <>
          <SortableList items={draft} keyOf={(a) => a.id} onChange={setDraft} itemClassName="py-2">
            {(a) => (
              <>
                <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className="h-8 w-8 text-xs" />
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{a.name}</span>
                <span className="hidden items-center gap-1.5 text-[11.5px] text-ink-subtle sm:inline-flex">
                  {a.has_android && <PlatformGlyph platform="android" size={12} />}
                  {a.has_ios && <PlatformGlyph platform="ios" size={12} />}
                </span>
              </>
            )}
          </SortableList>
        </>
      ) : loading ? (
        <ListSkeleton rows={4} />
      ) : error && !data ? (
        <LoadError title="Couldn't load apps" onRetry={refresh} />
      ) : apps.length === 0 ? (
        <EmptyState icon={<IconApps size={20} />} title={isAdmin ? "No apps yet" : "You're not on an app yet"} description={isAdmin ? "Add your first app — Android, iOS or both — then assign the people working on it." : "You see the apps you belong to. An admin adds you to an app from its Members tab."} action={isAdmin ? <Button onClick={() => setAdding(true)}>Add app</Button> : undefined} />
      ) : (
        <ul className="divide-y divide-line/70 overflow-hidden rounded-xl border border-line bg-surface">
          {apps.map((a) => (
            <li key={a.id}>
              <Link href={`/apps/${a.id}`} onPointerEnter={() => prefetch(`/api/tasks?app=${a.id}&scope=open&limit=100`)} className={cn("group flex items-center gap-3 px-3 py-3 transition-colors hover:bg-canvas/60 sm:px-4", a.status === "archived" && "opacity-60")}>
                <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className="h-10 w-10 text-base" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="break-words text-[14px] font-semibold text-ink group-hover:text-brand-700">{a.name}</span>
                    {a.status === "archived" && <Badge tone="neutral">Archived</Badge>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-ink-muted">
                    {a.has_android && (
                      <span className="inline-flex items-center gap-1" title="Android">
                        <PlatformGlyph platform="android" size={13} /> {a.latest_android ? `v${a.latest_android.version_name}` : "no release"}
                      </span>
                    )}
                    {a.has_ios && (
                      <span className="inline-flex items-center gap-1" title="iOS">
                        <PlatformGlyph platform="ios" size={13} /> {a.latest_ios ? `v${a.latest_ios.version_name}` : "no release"}
                      </span>
                    )}
                    {a.next_release && (
                      <span className="inline-flex items-center gap-1">
                        next v{a.next_release.version_name} <ReleaseStatusBadge status={a.next_release.status} />
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11.5px] tabular-nums text-ink-subtle sm:hidden">
                    {a.open_tasks} open · {a.in_progress} in progress{a.overdue ? <span className="text-red-600"> · {a.overdue} overdue</span> : ""} · {a.members.length} member{a.members.length === 1 ? "" : "s"}
                  </p>
                </div>
                {/* Four fixed columns, so the figures line up row after row. */}
                <div className="hidden shrink-0 grid-cols-4 gap-x-1 sm:grid sm:w-[300px]">
                  <Count n={a.open_tasks} label="open" />
                  <Count n={a.in_progress} label="in progress" />
                  <Count n={a.overdue} label="overdue" tone={a.overdue ? "danger" : undefined} />
                  <Count n={a.done_week} label="done / wk" tone="success" />
                </div>
                <div className="hidden w-[108px] shrink-0 justify-end sm:flex">{a.members.length ? <AvatarStack users={a.members.map((m) => m.user)} max={4} size="sm" /> : <span className="text-[11px] text-ink-subtle">no members</span>}</div>
                <IconChevronRight size={16} className="shrink-0 text-ink-subtle transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {!draft && archivedCount > 0 && (
        <button type="button" onClick={() => setShowArchived((v) => !v)} className="self-start text-xs font-medium text-ink-subtle hover:text-ink">
          {showArchived ? "Hide" : "Show"} {archivedCount} archived app{archivedCount === 1 ? "" : "s"}
        </button>
      )}
      {adding && <AppFormSheet onClose={() => setAdding(false)} />}
    </div>
  );
}

function Count({ n, label, tone }: { n: number; label: string; tone?: "danger" | "success" }) {
  return (
    <span className="text-center">
      <span className={cn("block text-[15px] font-semibold leading-none tabular-nums", tone === "danger" && n ? "text-red-600" : tone === "success" && n ? "text-emerald-700" : n ? "text-ink" : "text-ink-subtle")}>{n}</span>
      <span className="mt-0.5 block whitespace-nowrap text-[10.5px] text-ink-subtle">{label}</span>
    </span>
  );
}
