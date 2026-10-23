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

/**
 * Groups a meeting pack's tasks and releases per app, General first, then
 * the series' presentation order, then the rest by name.
 *
 * `dedupe`: a task on several apps appears ONCE, under the first of its apps
 * in that order (the deck); without it the task is listed under every app
 * it targets (the editing view).
 */
export function buildAgenda(pack: MeetingPack, opts: { dedupe?: boolean } = {}): AgendaGroup[] {
  const map = new Map<string, AgendaGroup>();
  const groupFor = (app: AppLike | null) => {
    const key = app?.id ?? "general";
    let g = map.get(key);
    if (!g) {
      g = { key, name: app?.name ?? "General", color: app?.color ?? "#94a3b8", iconUrl: app?.icon_url ?? null, pending: [], done: [], releases: [], carried: 0, overdue: 0 };
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
  const rank = (key: string, name: string) => (key === "general" ? [-1, ""] : [order.indexOf(key) === -1 ? order.length : order.indexOf(key), name.toLowerCase()]) as [number, string];
  const groupsOf = (t: TaskCard): AgendaGroup[] => {
    const apps = appsOf(t);
    if (!apps.length) return [groupFor(null)];
    const gs = apps.map(groupFor);
    if (!opts.dedupe) return gs;
    gs.sort((a, b) => {
      const [ra, na] = rank(a.key, a.name);
      const [rb, nb] = rank(b.key, b.name);
      return ra - rb || na.localeCompare(nb);
    });
    return [gs[0]];
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
  return groups.sort((a, b) => {
    const [ra, na] = rank(a.key, a.name);
    const [rb, nb] = rank(b.key, b.name);
    return ra - rb || na.localeCompare(nb);
  });
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
