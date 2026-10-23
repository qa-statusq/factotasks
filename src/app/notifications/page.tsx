"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader, EmptyState, LoadError, Spinner } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { Avatar } from "@/components/ui/avatar";
import { useCachedFetch, mutate, mutateWhere } from "@/lib/client-cache";
import { postJson } from "@/lib/http";
import { timeoutSignal } from "@/lib/compat";
import { istTime } from "@/lib/time";
import { RelTime } from "@/components/ui/live-time";
import { cn } from "@/lib/cn";
import { IconBell, IconCheck, IconUser, IconUserCheck, IconCheckCircle, IconXCircle, IconMessage, IconRefresh, IconPaperclip, IconTrash, IconClock, IconPresentation, IconRocket } from "@/components/ui/icons";
import type { Notification } from "@/lib/types";

interface Page {
  unread: number;
  notifications: Notification[];
  hasMore: boolean;
}

/** One icon + tint per kind; nothing emoji. */
const KIND_META: Record<string, { icon: React.ReactNode; cls: string }> = {
  "task.assigned": { icon: <IconUser size={15} />, cls: "bg-sky-50 text-sky-700 ring-sky-200" },
  "task.requested": { icon: <IconUserCheck size={15} />, cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  "task.approved": { icon: <IconCheckCircle size={15} />, cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  "task.rejected": { icon: <IconXCircle size={15} />, cls: "bg-red-50 text-red-600 ring-red-200" },
  "task.comment": { icon: <IconMessage size={15} />, cls: "bg-canvas text-ink-muted ring-line" },
  "task.status": { icon: <IconRefresh size={15} />, cls: "bg-canvas text-ink-muted ring-line" },
  "task.attachment": { icon: <IconPaperclip size={15} />, cls: "bg-canvas text-ink-muted ring-line" },
  "task.deleted": { icon: <IconTrash size={15} />, cls: "bg-red-50 text-red-600 ring-red-200" },
  "task.due": { icon: <IconClock size={15} />, cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  "task.mom": { icon: <IconPresentation size={15} />, cls: "bg-canvas text-ink-muted ring-line" },
  "meeting.note": { icon: <IconPresentation size={15} />, cls: "bg-canvas text-ink-muted ring-line" },
  "release.released": { icon: <IconRocket size={15} />, cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  "release.requested": { icon: <IconRocket size={15} />, cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  "release.rejected": { icon: <IconXCircle size={15} />, cls: "bg-red-50 text-red-600 ring-red-200" },
};
const FALLBACK_META = { icon: <IconBell size={15} />, cls: "bg-canvas text-ink-muted ring-line" };

export default function InboxPage() {
  const url = "/api/notifications?limit=30";
  const { data, loading, error, refresh } = useCachedFetch<Page>(url);
  const [more, setMore] = useState<Notification[]>([]);
  const [hasMore, setHasMore] = useState<boolean | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const items = [...(data?.notifications ?? []), ...more.filter((m) => !(data?.notifications ?? []).some((n) => n.id === m.id))];
  const unread = data?.unread ?? 0;
  // What was unread when the inbox opened stays highlighted until you leave,
  // even though it is marked read in the background a moment later.
  const [openedUnread, setOpenedUnread] = useState<Set<string> | null>(null);
  if (data && openedUnread === null) setOpenedUnread(new Set(data.notifications.filter((n) => !n.read_at).map((n) => n.id)));
  const isUnread = (n: { id: string; read_at: string | null }) => !n.read_at || !!openedUnread?.has(n.id);

  // Opening the inbox reads it: mark everything read shortly after it paints,
  // so the badge clears without a click — the Gmail/Linear convention.
  useEffect(() => {
    if (!data || data.unread === 0) return;
    const t = window.setTimeout(async () => {
      await postJson("/api/notifications/read", { all: true });
      // Functional update: a poll may have delivered a newer page meanwhile.
      mutateWhere(url, (cur, key) => {
        if (key !== url || !cur) return undefined;
        const d = cur as { unread: number; notifications: { read_at: string | null }[] };
        return { ...d, unread: 0, notifications: d.notifications.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })) };
      });
      setMore((m) => m.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
      mutate("/api/notifications?limit=1");
    }, 1500);
    return () => window.clearTimeout(t);
  }, [data]);

  // Page 1 changed under us (new rows arrived): the older tail no longer
  // joins up with it, so it is dropped and "Load older" starts again.
  const firstId = data?.notifications?.[0]?.id ?? null;
  const [seenFirst, setSeenFirst] = useState<string | null>(null);
  if (firstId !== seenFirst) {
    setSeenFirst(firstId);
    if (seenFirst !== null && more.length) {
      setMore([]);
      setHasMore(data?.hasMore ?? false);
    }
  }

  async function loadMore() {
    const last = items[items.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(`${url}&before=${encodeURIComponent(last.created_at)}&before_id=${encodeURIComponent(last.id)}`, { signal: timeoutSignal(15_000) });
      if (!r.ok) throw new Error();
      const page = (await r.json()) as Page;
      setMore((cur) => [...cur, ...page.notifications]);
      setHasMore(page.hasMore);
    } catch {
      /* button stays */
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <PageHeader
        title="Inbox"
        description="Assignments, approvals, comments and releases that concern you."
        actions={
          <Button
            variant="secondary"
            size="sm"
            disabled={unread === 0}
            title={unread === 0 ? "Everything is read" : undefined}
            onClick={async () => {
              await postJson("/api/notifications/read", { all: true });
              mutate(url);
              mutate("/api/notifications?limit=1");
            }}
          >
            <IconCheck size={14} /> {unread === 0 ? "All read" : "Mark all read"}
          </Button>
        }
      />
      {loading ? (
        <ListSkeleton rows={6} />
      ) : error && !data ? (
        <LoadError title="Couldn't load your inbox" onRetry={refresh} />
      ) : items.length === 0 ? (
        <EmptyState icon={<IconBell size={20} />} title="You're all caught up" description="When someone assigns you a task, comments, or an approval lands, it shows up here." />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line/80">
            {items.map((n) => {
              const inner = (
                <>
                  <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset", (KIND_META[n.kind] ?? FALLBACK_META).cls)} aria-hidden>
                    {(KIND_META[n.kind] ?? FALLBACK_META).icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm", n.read_at ? "text-ink-muted" : "font-medium text-ink")}>{n.message}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-subtle">
                      {n.actor && (
                        <span className="inline-flex items-center gap-1">
                          <Avatar user={n.actor} size="xs" /> {n.actor.name}
                        </span>
                      )}
                      <span title={istTime(n.created_at)}>
                        <RelTime iso={n.created_at} />
                      </span>
                    </div>
                  </div>
                  {isUnread(n) && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-brand-600" aria-label="Unread" />}
                </>
              );
              return (
                <li key={n.id} className={cn("cv-card", isUnread(n) && "bg-brand-50/30")}>
                  {n.task_id ? (
                    <Link href={`/tasks/${n.task_id}`} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-canvas/70 sm:px-5">
                      {inner}
                    </Link>
                  ) : (
                    <div className="flex items-start gap-3 px-4 py-3 sm:px-5">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
          {(hasMore ?? data?.hasMore) && (
            <div className="flex justify-center border-t border-line/80 p-3">
              <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? <Spinner /> : "Load older"}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
