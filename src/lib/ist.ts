/**
 * India Standard Time helpers — THE single source of truth. IST is UTC+5:30
 * with no DST, so fixed-offset arithmetic is exact. Previously each route/
 * screen re-declared these; one definition means one behaviour everywhere.
 */

export const IST_MS = 5.5 * 60 * 60 * 1000;

/** Strict YYYY-MM-DD validator for date query params. */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Shape AND calendar validity — "2026-99-99" matches the regex but parses to
 * NaN (istDayStartUtc then threw an unhandled RangeError: a 500 from crafted
 * input instead of a 400), and V8 leniently ROLLS "2026-02-31" over to Mar 3,
 * so the parse must also round-trip back to the same calendar day. Route
 * validation must use this, not YMD alone. */
export const isYmd = (s: string): boolean => {
  if (!YMD.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};

/** Today's IST calendar day as YYYY-MM-DD. */
export const istToday = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);

/** The IST calendar day (YYYY-MM-DD) an ISO timestamp falls on. */
export const istDayKey = (iso: string) => new Date(new Date(iso).getTime() + IST_MS).toISOString().slice(0, 10);

/** UTC instant of IST midnight STARTING the given day (inclusive start). */
export const istDayStartUtc = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) - IST_MS).toISOString();

/** UTC instant of IST midnight AFTER the given day (exclusive end). */
export const istDayEndUtc = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) - IST_MS + 86_400_000).toISOString();
