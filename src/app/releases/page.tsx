"use client";

import { istDayKey } from "@/lib/ist";

import { useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { Button, buttonClass } from "@/components/ui/button";
import { Dropdown } from "@/components/ui/dropdown";
import { PageHeader, LoadError, EmptyState } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { ReleaseFormSheet, ReleaseRow, ReleaseViewSheet, prettyDate, UnreleasedWorkBanner } from "@/components/release-ui";
import { useSession } from "@/components/providers/session-provider";
import { useCachedFetch } from "@/lib/client-cache";
import { PLATFORM_META } from "@/lib/domain";
import { IconPlus, IconRocket, IconClock } from "@/components/ui/icons";
import type { AppOverview, Release } from "@/lib/types";

export default function ReleasesPage() {
  const { me, isAdmin } = useSession();
  const [app, setApp] = useState("");
  const [platform, setPlatform] = useState("");
  const url = `/api/releases?${new URLSearchParams({ ...(app ? { app } : {}), ...(platform ? { platform } : {}) }).toString()}`.replace(/\?$/, "");
  const { data, loading, error, refresh } = useCachedFetch<{ releases: Release[] }>(url);
  const { data: appsData } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const apps = useMemo(() => (appsData?.apps ?? []).filter((a) => a.status !== "archived"), [appsData]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Release | null>(null);
  const canAdd = isAdmin || apps.some((a) => a.members.some((m) => m.user.id === me?.id));

  const releases = data?.releases ?? [];
  const upcoming = releases
    .filter((r) => !["released", "cancelled", "rolled_back"].includes(r.status))
    .sort((a, b) => (a.planned_date || "9999").localeCompare(b.planned_date || "9999"));
  const shipped = releases.filter((r) => r.status === "released").sort((a, b) => (b.released_at || b.updated_at).localeCompare(a.released_at || a.updated_at));
  // Cancelled / rolled back versions are history, not shipped work: their own list.
  const dropped = releases.filter((r) => r.status === "cancelled" || r.status === "rolled_back").sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  // Group shipped releases by month for a readable timeline.
  const months = useMemo(() => {
    const m = new Map<string, Release[]>();
    for (const r of shipped) {
      const key = istDayKey(r.released_at || r.updated_at).slice(0, 7);
      m.set(key, [...(m.get(key) || []), r]);
    }
    return [...m.entries()];
  }, [shipped]);

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <PageHeader
        title="Releases"
        description="What's shipping and what shipped — every version, Android and iOS."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/releases/history" className={buttonClass("secondary", "sm")} title="Every version with its date changes, status changes and what shipped">
              <IconClock size={14} /> History
            </Link>
            {canAdd && (
              <Button onClick={() => setAdding(true)}>
                <IconPlus size={16} /> New release
              </Button>
            )}
          </div>
        }
      />
      <UnreleasedWorkBanner />
      <div className="flex flex-wrap gap-2">
        <div className="w-52">
          <Dropdown value={app} onChange={setApp} options={[{ value: "", label: "All apps" }, ...apps.map((a) => ({ value: a.id, label: a.name }))]} className="[&>button]:h-9" />
        </div>
        <div className="w-44">
          <Dropdown
            value={platform}
            onChange={setPlatform}
            options={[
              { value: "", label: "Both platforms" },
              { value: "android", label: PLATFORM_META.android.label },
              { value: "ios", label: PLATFORM_META.ios.label },
            ]}
            className="[&>button]:h-9"
          />
        </div>
      </div>

      {loading ? (
        <ListSkeleton rows={5} />
      ) : error && !data ? (
        <LoadError title="Couldn't load releases" onRetry={refresh} />
      ) : releases.length === 0 ? (
        <EmptyState icon={<IconRocket size={20} />} title="No releases yet" description={isAdmin ? "Log the versions you're working on from an app's Releases tab, or right here." : "Releases of the apps you belong to show up here."} action={canAdd ? <Button size="sm" onClick={() => setAdding(true)}>New release</Button> : undefined} />
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card className="overflow-hidden self-start">
            <CardHeader>
              <CardTitle>
                In the pipeline <span className="ml-1 text-sm font-normal text-ink-subtle">{upcoming.length}</span>
              </CardTitle>
            </CardHeader>
            {upcoming.length ? (
              <ul className="divide-y divide-line/80">
                {upcoming.map((r) => (
                  <ReleaseRow key={r.id} r={r} onOpen={setOpen} />
                ))}
              </ul>
            ) : (
              <CardBody>
                <p className="text-sm text-ink-subtle">Nothing planned right now.</p>
              </CardBody>
            )}
          </Card>
          <div className="flex flex-col gap-5">
            {months.length === 0 && (
              <Card>
                <CardBody>
                  <p className="text-sm text-ink-subtle">Nothing released yet.</p>
                </CardBody>
              </Card>
            )}
            {months.map(([key, list]) => (
              <Card key={key} className="overflow-hidden">
                <CardHeader>
                  <CardTitle>
                    Released · {prettyDate(`${key}-01`).replace(/^1 /, "")} <span className="ml-1 text-sm font-normal text-ink-subtle">{list.length}</span>
                  </CardTitle>
                </CardHeader>
                <ul className="divide-y divide-line/80">
                  {list.map((r) => (
                    <ReleaseRow key={r.id} r={r} onOpen={setOpen} />
                  ))}
                </ul>
              </Card>
            ))}
            {dropped.length > 0 && (
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>
                    Cancelled &amp; rolled back <span className="ml-1 text-sm font-normal text-ink-subtle">{dropped.length}</span>
                  </CardTitle>
                </CardHeader>
                <ul className="divide-y divide-line/80">
                  {dropped.map((r) => (
                    <ReleaseRow key={r.id} r={r} onOpen={setOpen} />
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </div>
      )}
      {adding && <ReleaseFormSheet apps={apps} onClose={() => setAdding(false)} />}
      {open && <ReleaseViewSheet release={open} apps={apps} onClose={() => setOpen(null)} />}
    </div>
  );
}
