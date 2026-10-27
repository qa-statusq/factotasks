"use client";

import { ago, dateTimeParts, istTime } from "@/lib/time";
import { useClock } from "@/components/providers/clock-provider";

/**
 * A moment, written the one way the panel writes moments:
 * "27 Oct 2026, 11:05 am · 1d ago" — the exact date and time, then how long ago
 * (dropped after 30 days). Hover shows it to the second. Three pieces that never
 * split inside — "27 Oct 2026," | "11:05 am ·" | "1d ago" — so a narrow column
 * breaks between them (the "·" stays at the end of its line) and nothing
 * overflows on any screen.
 */
export function When({ iso, className, relative = true }: { iso: string | null | undefined; className?: string; relative?: boolean }) {
  useClock();
  const p = dateTimeParts(iso);
  if (!iso || !p) return null;
  const rel = relative ? ago(iso) : "";
  return (
    <time dateTime={iso} title={istTime(iso)} className={className}>
      <span className="whitespace-nowrap">{p.date},</span>{" "}
      <span className="whitespace-nowrap">
        {p.time}
        {rel && "\u00a0·"}
      </span>
      {rel && (
        <>
          {" "}
          <span className="whitespace-nowrap">{rel}</span>
        </>
      )}
    </time>
  );
}
