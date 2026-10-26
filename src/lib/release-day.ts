import { istDayKey } from "./ist";

/** The calendar day (IST) a release belongs to: when it shipped, else its plan, else its creation. */
export function releaseDay(r: { released_at: string | null; planned_date: string | null; created_at: string }): string {
  return r.released_at ? istDayKey(r.released_at) : (r.planned_date ?? istDayKey(r.created_at));
}
