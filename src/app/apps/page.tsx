"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadError, EmptyState } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { AvatarStack } from "@/components/ui/avatar";
import { AppTile, ReleaseStatusBadge } from "@/components/ui/task-chips";
import { AppFormSheet } from "@/components/app-form";
import { useSession } from "@/components/providers/session-provider";
import { useCachedFetch, prefetch } from "@/lib/client-cache";
import { cn } from "@/lib/cn";
import { IconApps, IconPlus, IconAndroid, IconApple, IconChevronRight } from "@/components/ui/icons";
import type { AppOverview } from "@/lib/types";

export default function AppsPage() {
  const { isAdmin } = useSession();
  const { data, loading, error, refresh } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const apps = useMemo(() => (data?.apps ?? []).filter((a) => showArchived || a.status !== "archived"), [data, showArchived]);
  const archivedCount = (data?.apps ?? []).filter((a) => a.status === "archived").length;

  return (
    <div className="flex flex-col gap-4 animate-fade-in">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[20px] font-bold tracking-[-0.02em] text-ink sm:text-[24px]">Apps</h1>
        {isAdmin && (
          <Button className="ml-auto" onClick={() => setAdding(true)}>
            <IconPlus size={16} /> Add app
          </Button>
        )}
      </div>
      {loading ? (
        <ListSkeleton rows={4} />
      ) : error && !data ? (
        <LoadError title="Couldn't load apps" onRetry={refresh} />
      ) : apps.length === 0 ? (
        <EmptyState icon={<IconApps size={20} />} title={isAdmin ? "No apps yet" : "You're not on an app yet"} description={isAdmin ? "Add your first app — Android, iOS or both — then assign the people working on it." : "You see the apps you belong to. An admin adds you to an app from its People tab."} action={isAdmin ? <Button onClick={() => setAdding(true)}>Add app</Button> : undefined} />
      ) : (
        <ul className="divide-y divide-line/70 overflow-hidden rounded-xl border border-line bg-surface">
          {apps.map((a) => (
            <li key={a.id}>
              <Link href={`/apps/${a.id}`} onPointerEnter={() => prefetch(`/api/tasks?app=${a.id}&scope=open&limit=100`)} className={cn("flex items-center gap-3 px-3 py-3 transition-colors hover:bg-canvas/60 sm:px-4", a.status === "archived" && "opacity-60")}>
                <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className="h-10 w-10 text-base" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="break-words text-[14px] font-semibold text-ink">{a.name}</span>
                    {a.status === "archived" && <Badge tone="neutral">Archived</Badge>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-ink-subtle">
                    {a.has_android && (
                      <span className="inline-flex items-center gap-1">
                        <IconAndroid size={12} /> {a.latest_android ? `v${a.latest_android.version_name}` : "no release"}
                      </span>
                    )}
                    {a.has_ios && (
                      <span className="inline-flex items-center gap-1">
                        <IconApple size={12} /> {a.latest_ios ? `v${a.latest_ios.version_name}` : "no release"}
                      </span>
                    )}
                    {a.next_release && (
                      <span className="inline-flex items-center gap-1">
                        next v{a.next_release.version_name} <ReleaseStatusBadge status={a.next_release.status} className="px-1.5 py-0 text-[10px]" />
                      </span>
                    )}
                  </div>
                </div>
                <div className="hidden shrink-0 items-center gap-5 text-right sm:flex">
                  <Count n={a.open_tasks} label="open" />
                  <Count n={a.in_progress} label="in progress" />
                  <Count n={a.overdue} label="overdue" tone={a.overdue ? "danger" : undefined} />
                  <Count n={a.done_week} label="done / wk" tone="success" />
                </div>
                <div className="shrink-0 sm:ml-2">{a.members.length ? <AvatarStack users={a.members.map((m) => m.user)} max={4} size="sm" /> : <span className="text-[11px] text-ink-subtle">no members</span>}</div>
                <IconChevronRight size={16} className="shrink-0 text-ink-subtle" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {archivedCount > 0 && (
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
    <span className="min-w-[52px]">
      <span className={cn("block text-[15px] font-semibold leading-none tabular-nums", tone === "danger" && n ? "text-red-600" : tone === "success" && n ? "text-emerald-700" : "text-ink")}>{n}</span>
      <span className="block text-[10.5px] text-ink-subtle">{label}</span>
    </span>
  );
}
