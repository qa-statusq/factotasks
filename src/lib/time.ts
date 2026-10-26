/** IST date-only formatter (e.g. "15 Jun 2026") for the >30-day fallback —
 * lazily built and cached, and PINNED to Asia/Kolkata so an absolute date is
 * the IST calendar date for every viewer, not the browser's local one (which
 * could show the wrong day near midnight). */
let istDateFmt: Intl.DateTimeFormat | null = null;
function istDate(input: string): string {
  istDateFmt ??= new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
  return istDateFmt.format(new Date(input));
}

/** Human-friendly relative time, e.g. "2h ago", "3d ago". */
export function relativeTime(input: string | null | undefined): string {
  if (!input) return "";
  const then = new Date(input).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);

  if (sec < 45) return "just now";
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  if (day < 30) return `${day}d ago`;
  return istDate(input);
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

/** Long-form relative time, e.g. "just now", "23 minutes ago", "3 days ago". */
export function relativeTimeLong(input: string | null | undefined): string {
  if (!input) return "";
  const then = new Date(input).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const sec = Math.round(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon} month${mon === 1 ? "" : "s"} ago`;
  const yr = Math.round(mon / 12);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}
