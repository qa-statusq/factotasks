import type { MeetingNote, MeetingPack, TaskCard, UserBrief } from "./types";
import type { TaskStatus } from "./domain";

export interface AgendaGroup {
  key: string;
  name: string;
  color: string;
  iconUrl: string | null;
  pending: TaskCard[];
  done: TaskCard[];
  releases: MeetingPack["releases"];
  carried: number;
  overdue: number;
}

/** Deck order inside an app: finished work first, then what is moving, then what waits. */
export const DECK_STATUS_ORDER: TaskStatus[] = ["done", "partial", "in_progress", "in_review", "todo", "on_hold", "cancelled"];

type AppLike = { id: string; name: string; color: string; icon_url?: string | null };

/** Key of the deck's group for tasks that span several apps. */
export const SHARED_KEY = "shared";
/** The id that stands for the "Across apps" section inside a series' app_order (a uuid-shaped sentinel, never a real app). */
export const SHARED_ORDER_ID = "00000000-0000-4000-8000-000000000001";

/**
 * Groups a meeting pack's tasks and releases per app, General first, then
 * the series' presentation order, then the Apps screen's order (the pack's
 * apps arrive sorted by it).
 *
 * `dedupe`: a task on several apps appears ONCE — in its own "Across apps"
 * group (`SHARED_KEY`, placed last), where every app and platform it ships
 * on is shown side by side; without it the task is listed under every app
 * it targets (the editing view).
 */
export function buildAgenda(pack: MeetingPack, opts: { dedupe?: boolean } = {}): AgendaGroup[] {
  const map = new Map<string, AgendaGroup>();
  const groupFor = (app: AppLike | null, key = app?.id ?? "general") => {
    let g = map.get(key);
    if (!g) {
      const name = key === SHARED_KEY ? "Across apps" : app?.name ?? "General";
      g = { key, name, color: app?.color ?? (key === SHARED_KEY ? "#0f766e" : "#94a3b8"), iconUrl: app?.icon_url ?? null, pending: [], done: [], releases: [], carried: 0, overdue: 0 };
      map.set(key, g);
    }
    return g;
  };
  const appsOf = (t: TaskCard): AppLike[] => {
    const apps = new Map<string, AppLike>();
    for (const x of t.targets ?? []) apps.set(x.app.id, x.app);
    if (!apps.size && t.app) apps.set(t.app.id, t.app);
    return [...apps.values()];
  };
  // Every app in scope gets a group even before any task lands on it, so the
  // order below is complete.
  for (const a of pack.apps) groupFor(a);
  const order = pack.series?.app_order ?? [];
  const screenOrder = pack.apps.map((a) => a.id);
  // General first; then the series' own order (which may place "Across apps");
  // then the Apps screen's order; "Across apps" last unless the series placed it.
  const rank = (key: string): number => {
    if (key === "general") return -1;
    const id = key === SHARED_KEY ? SHARED_ORDER_ID : key;
    const i = order.indexOf(id);
    if (i !== -1) return i;
    if (key === SHARED_KEY) return Number.MAX_SAFE_INTEGER;
    const j = screenOrder.indexOf(key);
    return order.length + (j === -1 ? screenOrder.length : j);
  };
  const groupsOf = (t: TaskCard): AgendaGroup[] => {
    const apps = appsOf(t);
    if (!apps.length) return [groupFor(null)];
    if (!opts.dedupe) return apps.map((a) => groupFor(a));
    return apps.length > 1 ? [groupFor(null, SHARED_KEY)] : [groupFor(apps[0])];
  };
  const overdueIds = new Set(pack.overdue.map((t) => t.id));
  const seen = new Set<string>();
  for (const t of pack.pending) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    for (const g of groupsOf(t)) {
      g.pending.push(t);
      if ((t.carry ?? 0) > 0) g.carried++;
      if (overdueIds.has(t.id)) g.overdue++;
    }
  }
  for (const t of pack.done) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    for (const g of groupsOf(t)) g.done.push(t);
  }
  for (const r of pack.releases) groupFor(r.app).releases.push(r);
  const urgency = (t: TaskCard) => (overdueIds.has(t.id) ? 0 : 1);
  for (const g of map.values()) {
    g.pending.sort((a, b) => (b.carry ?? 0) - (a.carry ?? 0) || urgency(a) - urgency(b) || a.number - b.number);
    g.done.sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""));
    g.releases.sort((a, b) => (b.released_at || b.planned_date || "").localeCompare(a.released_at || a.planned_date || ""));
  }
  const groups = [...map.values()].filter((g) => g.pending.length || g.done.length || g.releases.length);
  return groups.sort((a, b) => rank(a.key) - rank(b.key) || a.name.localeCompare(b.name));
}

/** One flat list for a slide: by status (done → in progress → … → cancelled), newest first within a status. */
export function deckRows(g: AgendaGroup): TaskCard[] {
  const pos = (s: TaskStatus) => {
    const i = DECK_STATUS_ORDER.indexOf(s);
    return i === -1 ? DECK_STATUS_ORDER.length : i;
  };
  return [...g.pending, ...g.done].sort((a, b) => pos(a.status) - pos(b.status) || (b.created_at || "").localeCompare(a.created_at || ""));
}

/** The apps a task targets other than `exceptId` — shown as small tiles when a task spans apps. */
export function otherApps(t: TaskCard, exceptId: string): AppLike[] {
  const seen = new Map<string, AppLike>();
  for (const x of t.targets ?? []) if (x.app.id !== exceptId) seen.set(x.app.id, x.app);
  return [...seen.values()];
}

/** A task's targets grouped per app, Android before iOS — the release matrix of the deck. */
export function targetMatrix(t: TaskCard): { app: AppLike; items: TaskCard["targets"] }[] {
  const m = new Map<string, { app: AppLike; items: TaskCard["targets"] }>();
  for (const x of t.targets ?? []) {
    const g = m.get(x.app.id) ?? { app: x.app, items: [] };
    g.items.push(x);
    m.set(x.app.id, g);
  }
  for (const g of m.values()) g.items.sort((a, b) => (a.platform === b.platform ? 0 : a.platform === "android" ? -1 : 1));
  return [...m.values()];
}

/** The platforms a task ships on for ONE app (both when it targets both). */
export function platformsOn(t: TaskCard, appId: string): ("android" | "ios")[] {
  const out = new Set<"android" | "ios">();
  for (const x of t.targets ?? []) if (x.app.id === appId) out.add(x.platform);
  if (!out.size && t.platform) (t.platform === "both" ? ["android", "ios"] : [t.platform]).forEach((p) => out.add(p as "android" | "ios"));
  return [...out].sort((a, b) => (a === b ? 0 : a === "android" ? -1 : 1));
}

type Person = Pick<UserBrief, "id" | "name"> & { first_name?: string | null; last_name?: string | null };

/**
 * Short display names that stay unambiguous: first names, plus a last initial
 * wherever two people share a first name ("Neel P.", "Neel S.").
 */
export function nameLabels(people: Iterable<Person>): Map<string, string> {
  const list = [...new Map([...people].map((p) => [p.id, p])).values()];
  const first = (p: Person) => (p.first_name || p.name.split(" ")[0] || p.name).trim();
  const last = (p: Person) => (p.last_name || p.name.split(" ").slice(1).join(" ")).trim();
  const counts = new Map<string, number>();
  for (const p of list) counts.set(first(p).toLowerCase(), (counts.get(first(p).toLowerCase()) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const p of list) {
    const f = first(p);
    const l = last(p);
    out.set(p.id, (counts.get(f.toLowerCase()) ?? 0) > 1 && l ? `${f} ${l.charAt(0).toUpperCase()}.` : f);
  }
  return out;
}

/** Everyone a pack can mention: the people list, every assignee and note author. */
export function packPeople(pack: MeetingPack): Person[] {
  const all: Person[] = [...pack.people];
  for (const t of [...pack.pending, ...pack.done, ...pack.approvals]) all.push(...t.assignees);
  for (const n of pack.notes) if (n.author) all.push(n.author);
  return all;
}

export function ownerText(users: Pick<UserBrief, "id" | "name">[], labels: Map<string, string>): string {
  return users.map((u) => labels.get(u.id) ?? u.name.split(" ")[0]).join(", ");
}

export function notesByTask(notes: MeetingNote[]): Map<string, MeetingNote[]> {
  const m = new Map<string, MeetingNote[]>();
  for (const n of notes) if (n.task_id) m.set(n.task_id, [...(m.get(n.task_id) || []), n]);
  return m;
}
