/** Weekly repeating meetings (036): date maths shared by the scheduler and the series screen. All in India time. */
const IST_MS = 330 * 60_000;
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** YYYY-MM-DD + days. */
export const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar date. */
const isoWeekday = (ymd: string) => ((new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
/** The instant a meeting on `ymd` at `hhmm` India time starts. */
export const istInstant = (ymd: string, hhmm: string) => new Date(Date.parse(`${ymd}T${hhmm}:00Z`) - IST_MS);

/**
 * The next meeting day of a weekly schedule from `now`: today when it is that
 * weekday and the time hasn't passed yet, else the coming one.
 */
export function nextOccurrence(weekday: number, hhmm: string, now = new Date()): string {
  const today = new Date(now.getTime() + IST_MS).toISOString().slice(0, 10);
  let d = today;
  for (let i = 0; i < 8; i++, d = addDays(today, i)) {
    if (isoWeekday(d) !== weekday) continue;
    if (d === today && istInstant(d, hhmm).getTime() <= now.getTime()) continue;
    return d;
  }
  return addDays(today, 7);
}

