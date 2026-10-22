import type { MeetingNote, MeetingPack, TaskCard } from "./types";

export interface AgendaGroup {
  key: string;
  name: string;
  color: string;
  iconUrl: string | null;
  /** Still open at the meeting (carried, new, on hold, overdue). */
  pending: TaskCard[];
  /** Completed inside the meeting window. */
  done: TaskCard[];
  /** Releases planned or shipped inside the window, newest first. */
  releases: MeetingPack["releases"];
  carried: number;
  overdue: number;
}

/**
 * The meeting, app by app: every task that matters (done since the last
 * meeting + everything still pending) and every release in the window,
 * grouped under its app, General last. Order inside a group: pending first (carried-forward longest at the
 * top, then overdue, then by number), then done.
 */
export function buildAgenda(pack: MeetingPack): AgendaGroup[] {
  const map = new Map<string, AgendaGroup>();
  const groupFor = (app: { id: string; name: string; color: string; icon_url?: string | null } | null) => {
    const key = app?.id ?? "general";
    let g = map.get(key);
    if (!g) {
      g = { key, name: app?.name ?? "General", color: app?.color ?? "#94a3b8", iconUrl: app?.icon_url ?? null, pending: [], done: [], releases: [], carried: 0, overdue: 0 };
      map.set(key, g);
    }
    return g;
  };
  // A task sits under EVERY app it targets (a six-app fix shows in six
  // sections); tasks with no targets fall back to their primary app or General.
  const groupsOf = (t: TaskCard): AgendaGroup[] => {
    const apps = new Map<string, NonNullable<TaskCard["app"]>>();
    for (const x of t.targets ?? []) apps.set(x.app.id, x.app);
    if (!apps.size && t.app) apps.set(t.app.id, t.app);
    return apps.size ? [...apps.values()].map(groupFor) : [groupFor(null)];
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
  for (const r of pack.releases) {
    groupFor(r.app).releases.push(r);
  }
  const rank = (t: TaskCard) => (overdueIds.has(t.id) ? 0 : 1);
  for (const g of map.values()) {
    g.pending.sort((a, b) => (b.carry ?? 0) - (a.carry ?? 0) || rank(a) - rank(b) || a.number - b.number);
    g.done.sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""));
    g.releases.sort((a, b) => (b.released_at || b.planned_date || "").localeCompare(a.released_at || a.planned_date || ""));
  }
  return [...map.values()].sort((a, b) => (a.key === "general" ? 1 : b.key === "general" ? -1 : a.name.localeCompare(b.name)));
}

/** Notes pinned to tasks, keyed by task id. */
export function notesByTask(notes: MeetingNote[]): Map<string, MeetingNote[]> {
  const m = new Map<string, MeetingNote[]>();
  for (const n of notes) if (n.task_id) m.set(n.task_id, [...(m.get(n.task_id) || []), n]);
  return m;
}
