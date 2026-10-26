"use client";

import { Suspense, useEffect, useMemo, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCachedFetch } from "@/lib/client-cache";
import { useDocumentTitle } from "@/lib/use-document-title";
import { buildAgenda, notesByTask, nameLabels, packPeople, ownerText } from "@/lib/meeting-agenda";
import { istTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import { STATUS_META, NOTE_KIND_META, PLATFORM_META, RELEASE_STATUS_META, taskRef } from "@/lib/domain";
import { dueInfo } from "@/components/task-list";
import { Logo } from "@/components/ui/logo";
import { AppTile, EagerIconsContext } from "@/components/ui/task-chips";
import { NoteLink } from "@/components/ui/note-link";
import { IconPrint, IconBack } from "@/components/ui/icons";
import type { MeetingNote, MeetingPack, TaskCard } from "@/lib/types";

/**
 * Minutes of meeting as a document: A4, black on white, one running header,
 * app by app. Opened from the meeting page in its own tab; prints itself
 * once the data is in. Everything the deck shows, in reading order.
 */
type Pack = MeetingPack & { workspace_name: string };
const fmtWhen = (iso: string) => istTime(iso).replace(/:\d\d (am|pm) IST$/, " $1");
const fmtDay = (iso: string) => istTime(iso).replace(/, \d\d:\d\d(:\d\d)? (am|pm) IST$/, "");
const ymd = (s: string) => new Date(s + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default function PrintPage() {
  return (
    <Suspense fallback={null}>
      <PrintDoc />
    </Suspense>
  );
}

function PrintDoc() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const sp = useSearchParams();
  const auto = sp.get("auto") !== "0";
  const { data, loading, error, refresh } = useCachedFetch<Pack>(`/api/meetings/${id}`);
  useDocumentTitle(data ? `${data.meeting.title} · Minutes` : "Minutes");
  const agenda = useMemo(() => (data ? buildAgenda(data, { dedupe: true }) : []), [data]);
  const labels = useMemo(() => (data ? nameLabels(packPeople(data)) : new Map<string, string>()), [data]);
  const notes = useMemo(() => (data ? notesByTask(data.notes) : new Map<string, MeetingNote[]>()), [data]);

  const printed = useRef(false);
  useEffect(() => {
    if (!auto || !data || printed.current) return;
    // Print once fonts and every app icon are in, so the PDF never shows blank tiles.
    // Once only: a background refresh of the pack must not re-open the dialog.
    let cancelled = false;
    const t = window.setTimeout(async () => {
      await Promise.race([settleAssets(), new Promise((r) => setTimeout(r, 5000))]);
      if (cancelled || printed.current) return;
      printed.current = true;
      window.print();
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [auto, data]);

  if (loading) return <Shell>Preparing the minutes…</Shell>;
  if (error && !data)
    return (
      <Shell>
        <span className="flex flex-col items-center gap-3">
          Couldn&rsquo;t load this meeting.
          <button type="button" onClick={() => refresh()} className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-white">Try again</button>
        </span>
      </Shell>
    );
  if (!data) return null;
  const p = data;
  const m = p.meeting;
  const windowText = p.previous_meeting ? `${fmtDay(p.previous_meeting)} – ${fmtDay(m.held_at)}` : `7 days to ${fmtDay(m.held_at)}`;
  const minutes = [...p.notes].sort((a, b) => a.created_at.localeCompare(b.created_at));

  return (
    <div className="print-root min-h-svh bg-[#e9e8e4] py-8 print:bg-white print:py-0">
      <style>{`@media print { @page { size: A4 portrait; margin: 14mm 14mm 16mm; } }`}</style>
      {/* Screen-only toolbar */}
      <div className="print-chrome mx-auto mb-4 flex w-[210mm] max-w-[96vw] items-center gap-2">
        <button type="button" onClick={() => router.push(`/meetings/${m.id}`)} className="inline-flex items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-[13px] font-medium text-ink ring-1 ring-inset ring-line hover:bg-canvas">
          <IconBack size={14} /> Back to meeting
        </button>
        <span className="text-[12.5px] text-ink-muted">A4 · prints or saves as PDF from the browser dialog.</span>
        <button type="button" onClick={() => window.print()} className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-black">
          <IconPrint size={14} /> Print
        </button>
      </div>

      <EagerIconsContext.Provider value={true}>
      <article className="print-doc mx-auto w-[210mm] max-w-[96vw] bg-white px-[16mm] py-[14mm] text-[10.5pt] leading-[1.4] text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08),0_12px_40px_rgba(0,0,0,0.12)] print:max-w-none print:px-0 print:py-0 print:shadow-none">
        {/* Masthead */}
        <header className="border-b-2 border-ink pb-3">
          <div className="flex items-center justify-between gap-4 text-[8.5pt] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            <span className="inline-flex items-center gap-2"><Logo size={16} /> FactoTasks · {p.workspace_name}</span>
            <span className="shrink-0">Minutes of meeting</span>
          </div>
          <h1 className="mt-3 text-[21pt] font-bold leading-tight tracking-[-0.02em]">{m.title}</h1>
          {p.series && !m.title.startsWith(p.series.name) && <p className="mt-0.5 text-[9.5pt] text-ink-muted">{p.series.name}</p>}
          <dl className="mt-3 grid grid-cols-3 gap-x-6 text-[9.5pt]">
            <Fact label="Held">{fmtWhen(m.held_at)} IST</Fact>
            <Fact label="Covering">{windowText}</Fact>
            <Fact label="Status">{m.status === "finalized" ? "Closed" : "Open"}</Fact>
          </dl>
          {p.apps.length > 0 && (
            <p className="mt-2.5 text-[9pt]">
              <span className="mr-2 text-[7.5pt] font-semibold uppercase tracking-[0.14em] text-ink-subtle">Scope</span>
              <span className="font-medium">{m.app_ids?.length ? p.apps.map((a) => a.name).join(", ") : "All apps"}</span>
              {(!m.app_ids?.length || m.include_general !== false) && <span className="text-ink-muted"> + general tasks</span>}
            </p>
          )}
        </header>

        {/* Summary strip */}
        <section className="mt-4 grid grid-cols-4 divide-x divide-line border border-line">
          <Figure n={p.done.length} label="Done" tone="text-emerald-700" />
          <Figure n={p.pending.length} label="Pending" />
          <Figure n={p.carried.length} label="Carried forward" tone={p.carried.length ? "text-amber-700" : undefined} />
          <Figure n={p.overdue.length} label="Overdue" tone={p.overdue.length ? "text-red-600" : undefined} />
        </section>

        {m.notes && (
          <section className="mt-5">
            <H2>Agenda & remarks</H2>
            <p className="whitespace-pre-wrap break-words">{m.notes}</p>
          </section>
        )}

        {agenda.length === 0 && (
          <section className="mt-5">
            <p className="text-ink-muted">No tasks were created, completed or released since the previous meeting.</p>
          </section>
        )}

        {agenda.map((g) => (
          <section key={g.key} className="mt-6">
            <div className="flex items-center gap-2.5 border-b border-ink pb-1.5 break-after-avoid-page">
              <AppTile name={g.name} color={g.color} iconUrl={g.iconUrl} className="h-6 w-6 rounded-md text-[9px]" />
              <h2 className="text-[13pt] font-bold tracking-[-0.01em]">{g.name}</h2>
              <span className="ml-auto text-[8.5pt] text-ink-muted">
                {g.pending.length} pending{g.carried ? ` · ${g.carried} carried` : ""}
                {g.overdue ? ` · ${g.overdue} overdue` : ""} · {g.done.length} done{g.releases.length ? ` · ${g.releases.length} release${g.releases.length === 1 ? "" : "s"}` : ""}
              </span>
            </div>

            {g.releases.length > 0 && (
              <table className="mt-2 w-full border-collapse text-[9.5pt]">
                <colgroup>
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "13%" }} />
                  <col style={{ width: "17%" }} />
                  <col />
                </colgroup>
                <thead className="break-after-avoid-page">
                  <tr>
                    <Th>Version</Th>
                    <Th>Platform</Th>
                    <Th>Status</Th>
                    <Th>Date</Th>
                    <Th>Release notes</Th>
                  </tr>
                </thead>
                <tbody>
                  {g.releases.map((r) => (
                    <tr key={r.id} className="break-inside-avoid border-b border-line align-top">
                      <Td className="font-semibold tabular-nums">
                        v{r.version_name}
                        {r.build_number && <span className="font-normal text-ink-subtle"> ({r.build_number})</span>}
                      </Td>
                      <Td>{PLATFORM_META[r.platform].label}</Td>
                      <Td>{RELEASE_STATUS_META[r.status].label}</Td>
                      <Td className="tabular-nums">{r.status === "released" && r.released_at ? fmtDay(r.released_at) : r.planned_date ? `${ymd(r.planned_date)} (planned)` : "—"}</Td>
                      <Td className="text-ink-muted">
                        {r.tasks && r.tasks.length > 0 && (
                          <ul className="mb-1 flex flex-col gap-0.5">
                            {r.tasks.map((t) => (
                              <li key={t.id}>
                                <span className="mr-1 tabular-nums text-ink-subtle">{taskRef(t.number)}</span>
                                <span className="font-medium text-ink">{t.title}</span>
                                {t.description && <p className="whitespace-pre-wrap break-words text-[9pt]">{t.description}</p>}
                              </li>
                            ))}
                          </ul>
                        )}
                        {r.description ? <p className="whitespace-pre-wrap break-words">{r.description}</p> : !r.tasks?.length && "—"}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {(g.pending.length > 0 || g.done.length > 0) && (
              <table className="mt-2 w-full border-collapse text-[9.5pt]">
                <colgroup>
                  <col style={{ width: "8%" }} />
                  <col />
                  <col style={{ width: "17%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "13%" }} />
                </colgroup>
                <thead className="break-after-avoid-page">
                  <tr>
                    <Th>#</Th>
                    <Th>Task</Th>
                    <Th>Owner</Th>
                    <Th>Due</Th>
                    <Th className="text-right">Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {g.pending.length > 0 && <SectionRow label={`Pending · ${g.pending.length}`} />}
                  {g.pending.map((t) => (
                    <TaskRow key={t.id} t={t} notes={notes.get(t.id) || []} labels={labels} />
                  ))}
                  {g.done.length > 0 && <SectionRow label={`Completed since last meeting · ${g.done.length}`} tone="done" />}
                  {g.done.map((t) => (
                    <TaskRow key={t.id} t={t} notes={notes.get(t.id) || []} labels={labels} done />
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}

        {p.approvals.length > 0 && (
          <section className="mt-6">
            <H2>Awaiting approval</H2>
            <table className="w-full border-collapse text-[9.5pt]">
              <colgroup>
                <col style={{ width: "8%" }} />
                <col />
                <col style={{ width: "17%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "13%" }} />
              </colgroup>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Task</Th>
                  <Th>Owner</Th>
                  <Th>Due</Th>
                  <Th className="text-right">Status</Th>
                </tr>
              </thead>
              <tbody>
                {p.approvals.map((t) => (
                  <TaskRow key={t.id} t={t} notes={[]} labels={labels} showApp />
                ))}
              </tbody>
            </table>
          </section>
        )}

        {minutes.length > 0 && (
          <section className="mt-6">
            <H2>Minutes</H2>
            <table className="w-full border-collapse text-[9.5pt]">
              <colgroup>
                <col style={{ width: "13%" }} />
                <col style={{ width: "30%" }} />
                <col />
                <col style={{ width: "12%" }} />
              </colgroup>
              <thead>
                <tr>
                  <Th>Type</Th>
                  <Th>About</Th>
                  <Th>Minute</Th>
                  <Th>By</Th>
                </tr>
              </thead>
              <tbody>
                {minutes.map((x) => (
                  <tr key={x.id} className="break-inside-avoid border-b border-line align-top">
                    <Td className="font-semibold uppercase tracking-wide text-[8pt]">{NOTE_KIND_META[x.kind].label}</Td>
                    <Td>{x.task ? <><span className="tabular-nums text-ink-subtle">{taskRef(x.task.number)}</span> {x.task.title}</> : x.about ? x.about.name : <span className="text-ink-subtle">General</span>}</Td>
                    <Td className="whitespace-pre-wrap break-words">
                      {x.body}
                      {x.link_url && <NoteLink url={x.link_url} label={x.link_label} size="print" className={x.body ? "ml-1.5" : undefined} />}
                    </Td>
                    <Td className="text-ink-muted">{x.author ? ownerText([x.author], labels) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section className="mt-6 break-inside-avoid">
          <H2>Carried into the next meeting</H2>
          {p.pending.length === 0 ? (
            <p className="text-ink-muted">Nothing — every task in scope is closed.</p>
          ) : (
            <ul className="columns-2 gap-6 text-[9.5pt]">
              {[...p.pending]
                .sort((a, b) => (b.carry ?? 0) - (a.carry ?? 0) || a.number - b.number)
                .map((t) => (
                  <li key={t.id} className="flex items-baseline gap-2 break-inside-avoid py-0.5">
                    <span className="shrink-0 tabular-nums text-ink-subtle">{taskRef(t.number)}</span>
                    <span className="min-w-0 flex-1 break-words">{t.title}</span>
                    {typeof t.carry === "number" && t.carry > 0 && <span className="shrink-0 text-[8pt] font-semibold text-amber-700">{t.carry}× carried</span>}
                  </li>
                ))}
            </ul>
          )}
        </section>

        <footer className="mt-8 flex items-center justify-between border-t border-line pt-2 text-[8pt] text-ink-subtle">
          <span>{p.workspace_name} · Minutes of meeting</span>
          <span>Generated {fmtWhen(new Date().toISOString())} IST · FactoTasks</span>
        </footer>
      </article>
      </EagerIconsContext.Provider>
    </div>
  );
}

/** Resolves when fonts are ready and every image on the page has loaded (or failed) and decoded. */
async function settleAssets() {
  await document.fonts?.ready;
  await Promise.all(
    Array.from(document.images).map(async (img) => {
      if (!img.complete) await new Promise<void>((r) => { img.addEventListener("load", () => r(), { once: true }); img.addEventListener("error", () => r(), { once: true }); });
      if (img.naturalWidth) await img.decode().catch(() => undefined);
    }),
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-svh items-center justify-center bg-[#e9e8e4] text-sm text-ink-muted">{children}</div>;
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 border-b border-ink pb-1 text-[13pt] font-bold tracking-[-0.01em] break-after-avoid-page">{children}</h2>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[7.5pt] font-semibold uppercase tracking-[0.14em] text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 truncate font-medium">{children}</dd>
    </div>
  );
}

function Figure({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className="px-3 py-2">
      <div className={cn("text-[16pt] font-bold leading-none tabular-nums", tone ?? "text-ink")}>{n}</div>
      <div className="mt-1 text-[7.5pt] font-semibold uppercase tracking-[0.14em] text-ink-subtle">{label}</div>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={cn("border-b border-ink/60 pb-1 pr-2 text-left text-[7.5pt] font-semibold uppercase tracking-[0.14em] text-ink-muted", className)}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("py-1.5 pr-2", className)}>{children}</td>;
}
function SectionRow({ label, tone }: { label: string; tone?: "done" }) {
  return (
    <tr className="break-after-avoid-page">
      <td colSpan={5} className={cn("bg-canvas px-1.5 py-0.5 text-[7.5pt] font-semibold uppercase tracking-[0.14em]", tone === "done" ? "text-emerald-700" : "text-ink-muted")}>
        {label}
      </td>
    </tr>
  );
}

function TaskRow({ t, notes, labels, done, showApp }: { t: TaskCard; notes: MeetingNote[]; labels: Map<string, string>; done?: boolean; showApp?: boolean }) {
  const due = dueInfo(t.due_date, t.status);
  const desc = t.description?.trim();
  return (
    <tr className="break-inside-avoid border-b border-line align-top">
      <Td className="tabular-nums text-ink-subtle">{taskRef(t.number)}</Td>
      <Td>
        <div className={cn("font-semibold", done && "text-ink-muted")}>
          {t.title}
          {showApp && t.app && <span className="ml-1.5 font-normal text-ink-subtle">· {t.app.name}</span>}
          {t.platform && <span className="ml-1.5 text-[8pt] font-normal text-ink-subtle">{PLATFORM_META[t.platform].label}</span>}
          {typeof t.carry === "number" && t.carry > 0 && <span className="ml-1.5 text-[8pt] font-semibold text-amber-700">{t.carry}× carried</span>}
          {t.pinned && <span className="ml-1.5 text-[8pt] font-semibold text-ink-subtle">pinned</span>}
        </div>
        {desc && <p className="mt-0.5 whitespace-pre-wrap break-words text-[9pt] text-ink-muted">{desc}</p>}
        {t.requested_status && <p className="mt-0.5 text-[8.5pt] text-amber-700">Asked to move to {STATUS_META[t.requested_status].label} — awaiting approval</p>}
        {notes.length > 0 && (
          <ul className="mt-1 border-l-2 border-line pl-2">
            {notes.filter((x) => x.body.trim()).map((x) => (
              <li key={x.id} className="py-0.5 text-[9pt]">
                <span className="mr-1.5 text-[7.5pt] font-bold uppercase tracking-wide text-ink-muted">{NOTE_KIND_META[x.kind].label}</span>
                <span className="whitespace-pre-wrap break-words">{x.body}</span>
                {x.link_url && <NoteLink url={x.link_url} label={x.link_label} size="print" className="ml-1.5" />}
              </li>
            ))}
            {notes.some((x) => !x.body.trim() && x.link_url) && (
              <li className="flex flex-wrap items-center gap-1 py-0.5 text-[9pt]">
                <span className="mr-0.5 text-[7.5pt] font-bold uppercase tracking-wide text-ink-muted">Links</span>
                {notes.filter((x) => !x.body.trim() && x.link_url).map((x) => (
                  <NoteLink key={x.id} url={x.link_url} label={x.link_label} size="print" />
                ))}
              </li>
            )}
          </ul>
        )}
      </Td>
      <Td className="text-ink-muted">{t.assignees.length ? ownerText(t.assignees, labels) : "—"}</Td>
      <Td className={cn("tabular-nums", due?.tone === "danger" ? "font-semibold text-red-600" : due?.tone === "warning" ? "font-semibold text-amber-700" : "text-ink-muted")}>{t.due_date ? ymd(t.due_date) : "—"}</Td>
      <Td className="text-right font-semibold">{STATUS_META[t.status].label}</Td>
    </tr>
  );
}
