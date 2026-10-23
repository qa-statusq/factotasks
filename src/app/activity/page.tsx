"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dropdown } from "@/components/ui/dropdown";
import { PageHeader, EmptyState, LoadError, Spinner } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { useSession } from "@/components/providers/session-provider";
import { useCachedFetch } from "@/lib/client-cache";
import { timeoutSignal } from "@/lib/compat";
import { istTime } from "@/lib/time";
import { RelTime } from "@/components/ui/live-time";
import { useOnChange } from "@/lib/use-on-change";
import { IconActivity } from "@/components/ui/icons";
import type { UserBrief } from "@/lib/types";

interface Entry {
  id: string;
  user_email: string | null;
  user_name?: string | null;
  user_color?: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
interface Page {
  activity: Entry[];
  hasMore: boolean;
  nextCursor: string | null;
}

const toneFor = (action: string): "brand" | "success" | "info" | "warning" | "danger" | "neutral" => {
  if (action === "task.approve" || action === "task.status") return "success";
  if (action === "task.reject" || action.endsWith(".delete") || action.endsWith(".remove")) return "danger";
  if (action === "task.request") return "warning";
  if (action.startsWith("task")) return "brand";
  if (action.startsWith("release") || action.startsWith("app")) return "info";
  if (action.startsWith("user") || action.startsWith("settings")) return "warning";
  return "neutral";
};

const AREAS = [
  { value: "", label: "Everything" },
  { value: "task.", label: "Tasks" },
  { value: "release.", label: "Releases" },
  { value: "app.", label: "Apps" },
  { value: "meeting.", label: "Meetings" },
  { value: "user.", label: "Team" },
  { value: "auth.", label: "Sign-ins" },
  { value: "settings.", label: "Settings" },
];

export default function ActivityPage() {
  const router = useRouter();
  const { me, isAdmin, loading: sessionLoading, error: sessionError, refresh: sessionRefresh } = useSession();
  const [area, setArea] = useState("");
  const [userId, setUserId] = useState("");
  const url = `/api/activity?${new URLSearchParams({ ...(area ? { action: area } : {}), ...(userId ? { userId } : {}) }).toString()}`.replace(/\?$/, "");
  const { data, loading, error, refresh } = useCachedFetch<Page>(isAdmin ? url : null);
  const { data: usersData } = useCachedFetch<{ users: UserBrief[] }>(isAdmin ? "/api/users" : null);
  const [more, setMore] = useState<{ url: string; rows: Entry[]; cursor: string | null; hasMore: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useOnChange(url, () => setMore(null));

  const rows = useMemo(() => {
    const first = data?.activity ?? [];
    if (!more || more.url !== url) return first;
    const seen = new Set(first.map((r) => r.id));
    return [...first, ...more.rows.filter((r) => !seen.has(r.id))];
  }, [data, more, url]);
  const hasMore = more?.url === url ? more.hasMore : !!data?.hasMore;

  // Members are sent home from an effect, never from render (React warns about
  // updating the Router while this component renders).
  useEffect(() => {
    if (!sessionLoading && me && !isAdmin) router.replace("/");
  }, [sessionLoading, me, isAdmin, router]);
  if (sessionError) return <LoadError title="Couldn't check who you are" onRetry={sessionRefresh} />;
  if (!sessionLoading && !isAdmin) return null;


  async function loadMore() {
    if (loadingMore || !data) return;
    const cursor = more?.url === url ? more.cursor : data.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await fetch(`${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`, { signal: timeoutSignal(15_000) });
      if (!r.ok) throw new Error();
      const page = (await r.json()) as Page;
      setMore((cur) => ({ url, rows: [...(cur?.url === url ? cur.rows : []), ...page.activity], cursor: page.nextCursor, hasMore: page.hasMore }));
    } catch {
      /* retry via the button */
    } finally {
      setLoadingMore(false);
    }
  }

  const users = usersData?.users ?? [];
  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <PageHeader title="Activity" description="Every action by every teammate — the audit trail. Kept for 14 days." />
      <div className="flex flex-wrap gap-2">
        <div className="w-44">
          <Dropdown value={area} onChange={setArea} options={AREAS} className="[&>button]:h-9" />
        </div>
        <div className="w-52">
          <Dropdown value={userId} onChange={setUserId} options={[{ value: "", label: "Everyone" }, ...users.map((u) => ({ value: u.id, label: u.name }))]} className="[&>button]:h-9" />
        </div>
      </div>
      {loading || sessionLoading ? (
        <ListSkeleton rows={8} />
      ) : error && !data ? (
        <LoadError title="Couldn't load activity" onRetry={refresh} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<IconActivity size={20} />} title="No activity yet" />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line/80">
            {rows.map((e) => (
              <li key={e.id} className="cv-card flex items-start gap-3 px-4 py-3 sm:px-5">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold uppercase text-white" style={{ backgroundColor: e.user_color || "#64748b" }}>
                  {Array.from(e.user_name || e.user_email || "?")[0]}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    {e.entity_type === "task" && e.entity_id ? (
                      <Link href={`/tasks/${e.entity_id}`} className="hover:text-brand-700">
                        {e.summary || e.action}
                      </Link>
                    ) : e.entity_type === "app" && e.entity_id ? (
                      <Link href={`/apps/${e.entity_id}`} className="hover:text-brand-700">
                        {e.summary || e.action}
                      </Link>
                    ) : e.entity_type === "meeting" && e.entity_id ? (
                      <Link href={`/meetings/${e.entity_id}`} className="hover:text-brand-700">
                        {e.summary || e.action}
                      </Link>
                    ) : (
                      e.summary || e.action
                    )}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-subtle">
                    <span className="font-medium text-ink-muted">{e.user_name || e.user_email || "system"}</span>
                    <span>·</span>
                    <span title={istTime(e.created_at)}>
                      <RelTime iso={e.created_at} />
                    </span>
                  </div>
                </div>
                <Badge tone={toneFor(e.action)} className="shrink-0 font-mono text-[10.5px]">
                  {e.action}
                </Badge>
              </li>
            ))}
          </ul>
          {hasMore && (
            <div className="flex justify-center border-t border-line/80 p-3">
              <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? <Spinner /> : "Load more"}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
