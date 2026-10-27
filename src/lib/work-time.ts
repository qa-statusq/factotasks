import { IST_MS } from "./ist";

/**
 * Office working time — the one clock every duration in the panel is measured on:
 * lead time, active time, how long an approval took, the age of open work.
 *
 * Monday to Friday, 09:00–13:00 and 13:45–18:45 India time (the lunch break is
 * left out): 9 working hours a day. A task created at 6:30 pm and finished at
 * 10:00 am the next morning took 1h 15m, not 15½ hours.
 *
 * The database measures with work_seconds() (migrations 025/026) on the same
 * schedule — change both together.
 */
const WORK_SESSIONS: ReadonlyArray<readonly [number, number]> = [
  [9 * 60, 13 * 60],
  [13 * 60 + 45, 18 * 60 + 45],
]; // minutes after midnight, IST
export const WORK_DAY_SECONDS = 9 * 3600;
export const WORK_SCHEDULE_TEXT = "Mon–Fri, 9:00 am–6:45 pm, lunch excluded";

const DAY_MS = 86_400_000;

/** Working seconds between two instants (0 when either is missing or they are out of order). */
export function workSeconds(from: string | number | null | undefined, to: string | number | null | undefined): number {
  if (from == null || to == null) return 0;
  const a = typeof from === "number" ? from : Date.parse(from);
  const b = typeof to === "number" ? to : Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  let total = 0;
  // Walk the IST calendar days the span touches; each weekday adds its overlap with the two sessions.
  for (let day = Math.floor((a + IST_MS) / DAY_MS) * DAY_MS - IST_MS; day < b; day += DAY_MS) {
    const dow = new Date(day + IST_MS).getUTCDay(); // 0 Sunday … 6 Saturday
    if (dow === 0 || dow === 6) continue;
    for (const [start, end] of WORK_SESSIONS) {
      const lo = Math.max(a, day + start * 60_000);
      const hi = Math.min(b, day + end * 60_000);
      if (hi > lo) total += hi - lo;
    }
  }
  // Whole seconds, rounded like the database's bigint cast, so both clocks agree exactly.
  return Math.round(total / 1000);
}
