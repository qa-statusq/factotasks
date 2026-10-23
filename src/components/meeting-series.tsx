"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { closeForNavigation } from "@/components/ui/use-modal-chrome";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { Dropdown } from "@/components/ui/dropdown";
import { DateInput, istNowLocal, istLocalToIso } from "@/components/ui/date-input";
import { Spinner } from "@/components/ui/misc";
import { AppTile } from "@/components/ui/task-chips";
import { useToast } from "@/components/ui/toast";
import { useDialog } from "@/components/ui/dialog";
import { useCachedFetch, mutate } from "@/lib/client-cache";
import { postJson, deleteJson } from "@/lib/http";
import { useOnChange } from "@/lib/use-on-change";
import { useSubmitShortcut } from "@/lib/use-submit-shortcut";
import { cn } from "@/lib/cn";
import { IconCheck, IconTrash, IconChevronUp, IconChevronDown } from "@/components/ui/icons";
import type { AppOverview, Meeting, MeetingSeries } from "@/lib/types";

const NEW = "__new__";

/** Small pill naming the series, with its (automatic) colour. */
export function SeriesBadge({ series, className }: { series: { name: string; color: string } | null | undefined; className?: string }) {
  if (!series) return null;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-surface px-1.5 py-[1px] text-[11px] font-semibold text-ink ring-1 ring-inset ring-line", className)}>
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: series.color }} />
      {series.name}
    </span>
  );
}

export interface Scope {
  app_ids: string[];
  include_general: boolean;
}

/** What a meeting covers: "Everything", or the chosen apps (+ general tasks). */
export function ScopeLabel({ scope, apps, className, size = "sm" }: { scope: Partial<Scope> | undefined; apps: AppOverview[] | undefined; className?: string; size?: "sm" | "md" }) {
  const ids = scope?.app_ids ?? [];
  if (!ids.length) return <span className={cn("text-ink-subtle", className)}>All apps</span>;
  const chosen = ids.map((id) => apps?.find((a) => a.id === id)).filter((a): a is AppOverview => !!a);
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      {chosen.map((a) => (
        <span key={a.id} className="inline-flex items-center gap-1 text-ink-muted" title={a.name}>
          <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className={size === "sm" ? "h-4 w-4 rounded-[4px] text-[8px]" : "h-5 w-5 rounded-[5px] text-[9px]"} />
          {chosen.length <= 4 && a.name}
        </span>
      ))}
      {chosen.length < ids.length && <span className="text-ink-subtle">+{ids.length - chosen.length}</span>}
    </span>
  );
}

/** Toggle chips: every app, or a subset. General tasks join a meeting only
 * when attached to the series (task form → Meeting) or added by hand. */
export function AppScopePicker({ apps, value, onChange }: { apps: AppOverview[]; value: Scope; onChange: (s: Scope) => void }) {
  const all = value.app_ids.length === 0;
  const chip = "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium ring-1 ring-inset transition-colors";
  const on = "bg-ink text-white ring-ink";
  const off = "bg-surface text-ink-muted ring-line hover:text-ink";
  const toggleApp = (id: string) => {
    const app_ids = value.app_ids.includes(id) ? value.app_ids.filter((x) => x !== id) : [...value.app_ids, id];
    // Back to "Everything" means everything — general tasks included.
    onChange({ app_ids, include_general: app_ids.length === 0 ? true : value.include_general });
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" onClick={() => onChange({ app_ids: [], include_general: true })} className={cn(chip, all ? on : off)} aria-pressed={all}>
        {all && <IconCheck size={13} />} Everything
      </button>
      {apps
        .filter((a) => a.status !== "archived" || value.app_ids.includes(a.id))
        .map((a) => {
          const sel = value.app_ids.includes(a.id);
          return (
            <button key={a.id} type="button" onClick={() => toggleApp(a.id)} className={cn(chip, sel ? on : off)} aria-pressed={sel}>
              <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className="h-4.5 w-4.5 rounded-[4px] text-[8px]" />
              {a.name}
            </button>
          );
        })}
    </div>
  );
}

/* ----------------------------- New meeting -------------------------------- */

/** Series + when. The title is the series name and the date; the scope is the series' scope. */
export function NewMeetingSheet({ onClose, defaultSeriesId }: { onClose: () => void; defaultSeriesId?: string | null }) {
  const router = useRouter();
  const { confirm } = useDialog();
  const { toast } = useToast();
  const { data: sd } = useCachedFetch<{ series: MeetingSeries[] }>("/api/meeting-series");
  const { data: ad } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const series = sd?.series ?? [];
  const [seriesId, setSeriesId] = useState<string>(defaultSeriesId || "");
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<Scope>({ app_ids: [], include_general: true });
  const [when, setWhen] = useState(istNowLocal());
  const [busy, setBusy] = useState(false);
  // Validation and save problems surface as error toasts, not inline text.
  const setError = (m: string) => {
    if (m) toast(m, "error");
  };

  useOnChange(series.length ? series[0].id : "", () => {
    if (!seriesId && series.length) setSeriesId(series[0].id);
  });
  const current = series.find((x) => x.id === seriesId);
  const options = [...series.map((s) => ({ value: s.id, label: s.name })), { value: NEW, label: "＋ New series…" }];

  async function create(force = false) {
    if (busy) return;
    if (!when) return setError("Pick the meeting date and time.");
    let sid = seriesId;
    setBusy(true);
    setError("");
    if (sid === NEW) {
      const name = newName.trim();
      if (!name) {
        setBusy(false);
        return setError("Name the new series.");
      }
      const r = await postJson<{ series?: MeetingSeries; error?: string }>("/api/meeting-series", { name, app_ids: newScope.app_ids, include_general: newScope.include_general });
      if (!r.ok || !r.data?.series) {
        setBusy(false);
        return setError(r.data?.error || "Couldn't create the series.");
      }
      sid = r.data.series.id;
      setSeriesId(sid); // a failed meeting POST below must not create the series twice on retry
      mutate("/api/meeting-series");
    }
    const { ok, status, data } = await postJson<{ meeting?: Meeting; error?: string; open_id?: string }>("/api/meetings", { series_id: sid, held_at: istLocalToIso(when), force });
    setBusy(false);
    if (ok && data?.meeting) {
      mutate("/api/meetings");
      mutate("/api/meeting-series");
      closeForNavigation();
      onClose();
      router.push(`/meetings/${data.meeting.id}`);
      return;
    }
    if (status === 409 && data?.open_id) {
      if (await confirm({ title: "The previous meeting in this series is still open", message: "Create this one anyway? The open meeting stays as it is.", confirmLabel: "Create anyway" })) void create(true);
      return;
    }
    setError(data?.error || "Couldn't create the meeting.");
  }
  useSubmitShortcut(() => void create());

  return (
    <Sheet
      title="New meeting"
      description="Pick the series and when you meet. The agenda covers the series' scope since its previous meeting."
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto hidden text-[11px] text-ink-subtle sm:inline">
            <kbd className="rounded border border-line bg-canvas px-1 py-0.5 font-sans">Ctrl</kbd>+<kbd className="rounded border border-line bg-canvas px-1 py-0.5 font-sans">Enter</kbd> to create
          </span>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => create()} disabled={busy}>
            {busy ? <Spinner /> : "Create meeting"}
          </Button>
        </div>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        className="flex flex-col gap-4"
      >
        <Field label="Series" hint={current ? <ScopeLabel scope={current} apps={ad?.apps} /> : "Meetings of one kind; carry-forward is counted within the series."}>
          <Dropdown value={seriesId} onChange={setSeriesId} options={options} placeholder={sd ? "Pick a series" : "Loading…"} />
        </Field>
        {seriesId === NEW && (
          <>
            <Field label="Series name" hint="Becomes the meeting title, with the date.">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. FactoTime release review" maxLength={60} autoFocus />
            </Field>
            <Field label="Covers">{ad ? <AppScopePicker apps={ad.apps} value={newScope} onChange={setNewScope} /> : <span className="text-sm text-ink-subtle">Loading apps…</span>}</Field>
          </>
        )}
        <Field label="Date & time" hint="When the team actually meets (IST).">
          <DateInput value={when} onChange={setWhen} withTime clearable={false} />
        </Field>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Sheet>
  );
}

/* ---------------------------- Manage series ------------------------------- */

export function ManageSeriesSheet({ onClose }: { onClose: () => void }) {
  const { data: sd, refresh } = useCachedFetch<{ series: MeetingSeries[] }>("/api/meeting-series");
  const { data: ad } = useCachedFetch<{ apps: AppOverview[] }>("/api/apps");
  const [adding, setAdding] = useState(false);
  const list = sd?.series ?? [];
  return (
    <Sheet title="Meeting series" description="One series per kind of meeting. Each keeps its own carry-forward and scope; colours are assigned automatically." onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        {list.map((s) => (
          <SeriesEditor key={s.id} series={s} apps={ad?.apps ?? []} onChanged={refresh} canDelete={list.length > 1} />
        ))}
        {adding ? (
          <SeriesEditor
            apps={ad?.apps ?? []}
            onChanged={() => {
              setAdding(false);
              refresh();
            }}
            onCancel={() => setAdding(false)}
            canDelete={false}
          />
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)} className="self-start">
            + New series
          </Button>
        )}
      </div>
    </Sheet>
  );
}

function SeriesEditor({ series, apps, onChanged, onCancel, canDelete }: { series?: MeetingSeries; apps: AppOverview[]; onChanged: () => void; onCancel?: () => void; canDelete: boolean }) {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const [name, setName] = useState(series?.name ?? "");
  const [scope, setScope] = useState<Scope>({ app_ids: series?.app_ids ?? [], include_general: series?.include_general ?? true });
  const [order, setOrder] = useState<string[]>(series?.app_order ?? []);
  const [busy, setBusy] = useState(false);
  // The apps this series presents, in their current order: listed ones first, then the rest by name.
  const inScope = apps.filter((a) => a.status !== "archived" && (scope.app_ids.length === 0 || scope.app_ids.includes(a.id)));
  const ordered = [...inScope].sort((a, b) => {
    const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.name.localeCompare(b.name);
  });
  const move = (id: string, dir: -1 | 1) => {
    const ids = ordered.map((a) => a.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setOrder(ids);
  };
  const dirty = !series || name.trim() !== series.name || scope.app_ids.join() !== series.app_ids.join() || scope.include_general !== (series.include_general ?? true) || order.join() !== (series.app_order ?? []).join();

  async function save() {
    if (busy || !name.trim()) return;
    setBusy(true);
    const body = { name: name.trim(), app_ids: scope.app_ids, include_general: scope.include_general, app_order: order };
    const r = series ? await postJson(`/api/meeting-series/${series.id}`, body, "PATCH") : await postJson("/api/meeting-series", body);
    setBusy(false);
    if (r.ok) {
      toast(series ? "Series updated" : "Series created");
      mutate("/api/meeting-series");
      mutate("/api/meetings");
      onChanged();
    } else toast(r.data?.error || "Couldn't save", "error");
  }
  async function remove() {
    if (!series) return;
    if (!(await confirm({ title: `Delete “${series.name}”?`, message: "Its meetings are kept; they just lose the series. Carry-forward for them restarts.", confirmLabel: "Delete", tone: "danger" }))) return;
    const r = await deleteJson(`/api/meeting-series/${series.id}`);
    if (r.ok) {
      toast("Series deleted");
      mutate("/api/meeting-series");
      mutate("/api/meetings");
      onChanged();
    } else toast(r.data?.error || "Couldn't delete", "error");
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center gap-3">
        {series && <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: series.color }} aria-hidden />}
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Series name" maxLength={60} className="min-w-0 flex-1" autoFocus={!series} />
      </div>
      <div className="mt-3">
        <p className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-ink-subtle">Covers</p>
        <AppScopePicker apps={apps} value={scope} onChange={setScope} />
      </div>
      {ordered.length > 1 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-ink-subtle">Presentation order <span className="font-normal normal-case tracking-normal">· General tasks always come first</span></p>
          <ol className="divide-y divide-line/70 overflow-hidden rounded-lg border border-line">
            {ordered.map((a, i) => (
              <li key={a.id} className="flex items-center gap-2 bg-surface px-2.5 py-1.5 text-[13px]">
                <span className="w-5 shrink-0 text-right tabular-nums text-ink-subtle">{i + 1}</span>
                <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} className="h-5 w-5 rounded-[5px] text-[8px]" />
                <span className="min-w-0 flex-1 truncate text-ink">{a.name}</span>
                <button type="button" onClick={() => move(a.id, -1)} disabled={i === 0} className="tap rounded-md p-1 text-ink-subtle hover:bg-canvas hover:text-ink disabled:opacity-30" aria-label={`Move ${a.name} up`}>
                  <IconChevronUp size={14} />
                </button>
                <button type="button" onClick={() => move(a.id, 1)} disabled={i === ordered.length - 1} className="tap rounded-md p-1 text-ink-subtle hover:bg-canvas hover:text-ink disabled:opacity-30" aria-label={`Move ${a.name} down`}>
                  <IconChevronDown size={14} />
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-subtle">
        {series && (
          <span>
            {series.meeting_count ?? 0} meeting{(series.meeting_count ?? 0) === 1 ? "" : "s"}
          </span>
        )}
        <span className="ml-auto" />
        {series && canDelete && (
          <Button variant="secondary" size="sm" onClick={remove} aria-label="Delete series" title="Delete series">
            <IconTrash size={14} />
          </Button>
        )}
        {onCancel && (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" onClick={save} disabled={busy || !dirty || !name.trim()}>
          {busy ? <Spinner /> : series ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  );
}
