"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Button, buttonClass } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { PeoplePicker } from "@/components/ui/people-picker";
import { SortableList } from "@/components/ui/sortable";
import { AppTile } from "@/components/ui/task-chips";
import { Avatar } from "@/components/ui/avatar";
import { PageHeader, LoadError, Spinner, EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { AppScopePicker } from "@/components/meeting-series";
import { useCachedFetch, mutate } from "@/lib/client-cache";
import { postJson, deleteJson } from "@/lib/http";
import { useDocumentTitle } from "@/lib/use-document-title";
import { SHARED_ORDER_ID } from "@/lib/meeting-agenda";
import { cn } from "@/lib/cn";
import { IconPresentation, IconPlus, IconTrash, IconBack, IconUsers, IconApps, IconCheck } from "@/components/ui/icons";
import type { AppOverview, MeetingSeries, UserBrief } from "@/lib/types";

type Scope = { app_ids: string[]; include_general: boolean };

/**
 * Meeting series, one screen: pick a series on the left, set it up on the
 * right — what it covers, how its apps are presented, who takes part, and
 * whether its meetings close by themselves at the end of their day.
 */
export default function SeriesSettingsPage() {
  return (
    <Suspense fallback={null}>
      <SeriesSettings />
    </Suspense>
  );
}

function SeriesSettings() {
  useDocumentTitle("Meeting series · FactoTasks");
  const router = useRouter();
  const sp = useSearchParams();
  const { data: sd, error, refresh } = useCachedFetch<{ series: MeetingSeries[] }>("/api/meeting-series");
  const { data: ad } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const { data: ud } = useCachedFetch<{ users: UserBrief[] }>("/api/users");
  const list = useMemo(() => sd?.series ?? [], [sd]);
  const wanted = sp.get("id");
  const creating = wanted === "new";
  const selected = creating ? null : (list.find((s) => s.id === wanted) ?? list[0] ?? null);
  // The first series is the default pick; keep the address in step so a reload lands on the same one.
  useEffect(() => {
    if (!creating && selected && wanted !== selected.id) router.replace(`/meetings/series?id=${selected.id}`, { scroll: false });
  }, [creating, selected, wanted, router]);

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <PageHeader
        title="Meeting series"
        description="One series per kind of meeting. Each keeps its own carry-forward, scope, presentation order and people."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/meetings" className={buttonClass("secondary")}>
              <IconBack size={15} /> Meetings
            </Link>
            <Link href="/meetings/series?id=new" className={buttonClass("primary")}>
              <IconPlus size={16} /> New series
            </Link>
          </div>
        }
      />
      {!sd && error ? (
        <LoadError title="Couldn't load the series" onRetry={refresh} />
      ) : !sd ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav className="flex flex-col gap-1 lg:sticky lg:top-6 lg:self-start" aria-label="Series">
            {list.map((s) => {
              const active = !creating && selected?.id === s.id;
              return (
                <Link key={s.id} href={`/meetings/series?id=${s.id}`} className={cn("flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors", active ? "border-ink bg-surface shadow-xs" : "border-line bg-surface/60 hover:bg-surface")}>
                  <IconPresentation size={16} className="shrink-0" style={{ color: s.color }} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-ink">{s.name}</span>
                    <span className="block text-[11.5px] text-ink-subtle">
                      {s.meeting_count ?? 0} meeting{(s.meeting_count ?? 0) === 1 ? "" : "s"} · {s.member_ids?.length ?? 0} member{(s.member_ids?.length ?? 0) === 1 ? "" : "s"}
                    </span>
                  </span>
                </Link>
              );
            })}
            {creating && (
              <span className="flex items-center gap-3 rounded-xl border border-ink bg-surface px-3 py-2.5 shadow-xs">
                <IconPlus size={16} className="shrink-0 text-ink-subtle" />
                <span className="text-[13.5px] font-semibold text-ink">New series</span>
              </span>
            )}
          </nav>
          {creating || selected ? (
            <SeriesForm key={selected?.id ?? "new"} series={selected ?? undefined} apps={ad?.apps ?? []} users={ud?.users ?? []} canDelete={list.length > 1} onSaved={(id) => { refresh(); mutate("/api/meetings"); if (id) router.replace(`/meetings/series?id=${id}`, { scroll: false }); }} onDeleted={() => { refresh(); mutate("/api/meetings"); router.replace("/meetings/series", { scroll: false }); }} />
          ) : (
            <EmptyState icon={<IconPresentation size={20} />} title="No series yet" description="Create one to start holding meetings." action={<Link href="/meetings/series?id=new" className={buttonClass("primary")}>New series</Link>} />
          )}
        </div>
      )}
    </div>
  );
}

function Section({ icon, title, hint, children }: { icon: React.ReactNode; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-canvas text-ink-muted ring-1 ring-inset ring-line">{icon}</span>
        <div>
          <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
          {hint && <p className="text-[12.5px] text-ink-muted">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function SeriesForm({ series, apps, users, canDelete, onSaved, onDeleted }: { series?: MeetingSeries; apps: AppOverview[]; users: UserBrief[]; canDelete: boolean; onSaved: (id: string | null) => void; onDeleted: () => void }) {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const [name, setName] = useState(series?.name ?? "");
  const [scope, setScope] = useState<Scope>({ app_ids: series?.app_ids ?? [], include_general: series?.include_general ?? true });
  const [order, setOrder] = useState<string[]>(series?.app_order ?? []);
  const [members, setMembers] = useState<string[]>(series?.member_ids ?? []);
  const [autoClose, setAutoClose] = useState<boolean>(series?.auto_close ?? true);
  const [busy, setBusy] = useState(false);

  const inScope = apps.filter((a) => a.status !== "archived" && (scope.app_ids.length === 0 || scope.app_ids.includes(a.id)));
  type Entry = { id: string; name: string; color: string; icon_url: string | null; shared?: boolean };
  const entries: Entry[] = [...inScope.map((a) => ({ id: a.id, name: a.name, color: a.color, icon_url: a.icon_url })), { id: SHARED_ORDER_ID, name: "Across apps", color: "#0f766e", icon_url: null, shared: true }];
  const ordered = [...entries].sort((a, b) => {
    const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
    const fa = ia === -1 ? (a.shared ? order.length + entries.length : order.length) : ia;
    const fb = ib === -1 ? (b.shared ? order.length + entries.length : order.length) : ib;
    return fa - fb || entries.indexOf(a) - entries.indexOf(b);
  });
  // Admins run every meeting already, so only members are offered here.
  const people = users.filter((u) => u.is_active !== false && (u as UserBrief & { role?: string }).role !== "admin");
  const admins = users.filter((u) => u.is_active !== false && (u as UserBrief & { role?: string }).role === "admin");
  const picked = members.map((id) => people.find((u) => u.id === id)).filter((u): u is UserBrief => !!u);
  const dirty =
    !series ||
    name.trim() !== series.name ||
    scope.app_ids.join() !== series.app_ids.join() ||
    scope.include_general !== (series.include_general ?? true) ||
    order.join() !== (series.app_order ?? []).join() ||
    [...members].sort().join() !== [...(series.member_ids ?? [])].sort().join() ||
    autoClose !== (series.auto_close ?? true);

  async function save() {
    if (busy || !name.trim()) return;
    setBusy(true);
    const body = { name: name.trim(), app_ids: scope.app_ids, include_general: scope.include_general, app_order: order, member_ids: picked.map((u) => u.id), auto_close: autoClose };
    const r = series ? await postJson<{ series?: { id: string }; error?: string }>(`/api/meeting-series/${series.id}`, body, "PATCH") : await postJson<{ series?: { id: string }; error?: string }>("/api/meeting-series", body);
    setBusy(false);
    if (r.ok) {
      toast(series ? "Series saved" : "Series created");
      mutate("/api/meeting-series");
      onSaved(series ? null : (r.data?.series?.id ?? null));
    } else toast(r.data?.error || "Couldn't save", "error");
  }
  async function remove() {
    if (!series) return;
    if (!(await confirm({ title: `Delete “${series.name}”?`, message: "Its meetings are kept; they just lose the series. Carry-forward for them restarts, and its people lose access to them.", confirmLabel: "Delete", tone: "danger" }))) return;
    const r = await deleteJson(`/api/meeting-series/${series.id}`);
    if (r.ok) {
      toast("Series deleted");
      mutate("/api/meeting-series");
      onDeleted();
    } else toast(r.data?.error || "Couldn't delete", "error");
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Section icon={<IconPresentation size={15} />} title={series ? "Name" : "New series"} hint="Shown on every meeting of the series and on the agenda. The colour is picked for you.">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mobile Apps Weekly Meeting" maxLength={60} autoFocus={!series} className="max-w-md" />
      </Section>

      <Section icon={<IconApps size={15} />} title="Covers" hint="The apps whose tasks and releases make up the agenda. An app outside this list reaches the meeting only through tasks attached to the series.">
        <AppScopePicker apps={apps} value={scope} onChange={setScope} />
      </Section>

      {ordered.length > 1 && (
        <Section icon={<IconApps size={15} />} title="Presentation order" hint="Drag to arrange the slides. General tasks always come first.">
          <SortableList items={ordered} keyOf={(a) => a.id} onChange={(next) => setOrder(next.map((a) => a.id))}>
            {(a) => (
              <>
                {a.shared ? <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-teal-700 text-[10px] font-bold text-white" aria-hidden>⇄</span> : <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className="h-5 w-5 rounded-[5px] text-[8px]" />}
                <span className="min-w-0 flex-1 truncate text-ink">{a.name}</span>
                {a.shared && <span className="text-[11px] text-ink-subtle">tasks on several apps</span>}
              </>
            )}
          </SortableList>
        </Section>
      )}

      <Section icon={<IconUsers size={15} />} title="People" hint="Team members who take part. They see this series' meetings and recordings, can present, print, record and add tasks, and move their own tasks. Closing, deleting, minutes and sharing stay with admins.">
        <PeoplePicker users={people} value={members} onChange={setMembers} placeholder="Add team members…" max={50} />
        {admins.length > 0 && (
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-ink-subtle">
            <span>Always in:</span>
            {admins.map((u) => (
              <span key={u.id} className="inline-flex items-center gap-1 text-ink-muted">
                <Avatar user={u} size="xs" /> {u.name}
              </span>
            ))}
            <span>(admin{admins.length === 1 ? "" : "s"})</span>
          </p>
        )}
        {picked.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {picked.map((u) => (
              <li key={u.id} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas py-0.5 pl-0.5 pr-2 text-[12.5px] text-ink">
                <Avatar user={u} size="xs" /> {u.name}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={<IconCheck size={15} />} title="Closing" hint="A meeting closes when you press Close meeting — or by itself, the night after it was held, so the next meeting of the series starts clean.">
        <Switch checked={autoClose} onChange={setAutoClose} label="Close meetings automatically at the end of their day" description="Applies to every meeting of this series unless a meeting is set otherwise on its own page." />
      </Section>

      <div className="flex flex-wrap items-center gap-2">
        {series && canDelete && (
          <Button variant="secondary" onClick={remove} className="text-red-700 hover:bg-red-50">
            <IconTrash size={14} /> Delete series
          </Button>
        )}
        <span className="ml-auto" />
        {series && dirty && <span className="text-[12px] text-ink-subtle">Unsaved changes</span>}
        <Button onClick={save} disabled={busy || !dirty || !name.trim()}>
          {busy ? <Spinner /> : series ? "Save changes" : "Create series"}
        </Button>
      </div>
    </div>
  );
}
