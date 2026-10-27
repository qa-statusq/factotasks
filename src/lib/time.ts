/** IST date-only formatter (e.g. "15 Jun 2026") —
 * lazily built and cached, and PINNED to Asia/Kolkata so an absolute date is
 * the IST calendar date for every viewer, not the browser's local one (which
 * could show the wrong day near midnight). */
let istDateFmt: Intl.DateTimeFormat | null = null;
export function istDate(input: string): string {
  istDateFmt ??= new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
  return istDateFmt.format(new Date(input));
}

/**
 * Exact date-time in India Standard Time, to the second — e.g.
 * "15 Jun 2026, 02:30:45 pm IST". Always IST regardless of where the
 * viewer's browser/server is, so timestamps are unambiguous.
 *
 * ONE module-level formatter, not toLocaleString(opts): with an options bag
 * V8 constructs a fresh Intl.DateTimeFormat on every call (~0.1–1ms), and this
 * runs once or twice per list row — a long list render was spending tens of ms on
 * formatter construction alone. Built lazily so importing this module on the
 * server can't throw where the ICU data/timezone differs.
 */
let istFmt: Intl.DateTimeFormat | null = null;
export function istTime(input: string | null | undefined): string {
  if (!input) return "";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  istFmt ??= new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
  return `${istFmt.format(d)} IST`;
}

/**
 * THE way the panel writes a moment: "27 Oct 2026, 11:05 am" (India time, to the
 * minute). Built from parts so it reads the same in every browser; the seconds
 * and the "IST" stay in the hover title (istTime).
 */
let dtParts: Intl.DateTimeFormat | null = null;
export function fmtDateTime(input: string | null | undefined): string {
  if (!input) return "";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  dtParts ??= new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
  const p: Record<string, string> = {};
  for (const x of dtParts.formatToParts(d)) p[x.type] = x.value;
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${(p.dayPeriod ?? "").toLowerCase()}`;
}

/**
 * The short distance beside a moment — "just now", "5m ago", "3h ago", "2d ago",
 * or "in 2d" for a time still ahead (a scheduled meeting). Empty beyond 30 days,
 * when the date says it all.
 */
export function ago(input: string | null | undefined): string {
  if (!input) return "";
  const t = new Date(input).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  if (abs >= 30 * 86_400_000) return "";
  if (abs < 45_000) return "just now";
  const min = Math.round(abs / 60_000);
  const span = min < 60 ? `${min}m` : Math.round(min / 60) < 24 ? `${Math.round(min / 60)}h` : `${Math.round(min / 1440)}d`;
  return diff < 0 ? `in ${span}` : `${span} ago`;
}

/**
 * A calendar day (YYYY-MM-DD, or YYYY-MM for a month) as "24 Oct", "24 Oct 2026",
 * "Fri 24 Oct 2026", "October 2026" — ONE Intl.DateTimeFormat per shape, cached,
 * because list rows call this per paint and a formatter per call costs ~0.1–1 ms.
 */
const ymdFmts = new Map<string, Intl.DateTimeFormat>();
export function fmtYmd(ymd: string, opts: { year?: boolean | "2-digit"; weekday?: boolean; month?: "short" | "long" } = {}): string {
  if (!ymd) return "";
  const day = ymd.length > 7;
  const key = `${day ? "d" : ""}|${opts.year === "2-digit" ? "yy" : opts.year ? "y" : ""}|${opts.weekday ? "w" : ""}|${opts.month ?? "short"}`;
  let f = ymdFmts.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-IN", {
      ...(opts.weekday ? { weekday: "short" } : {}),
      ...(day ? { day: "numeric" } : {}),
      month: opts.month ?? "short",
      ...(opts.year === "2-digit" ? { year: "2-digit" } : opts.year ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
    ymdFmts.set(key, f);
  }
  const t = Date.parse((day ? ymd : `${ymd}-01`) + "T00:00:00Z");
  return Number.isNaN(t) ? "" : f.format(new Date(t));
}

