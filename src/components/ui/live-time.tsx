"use client";

import { ago, fmtDateTime, istTime } from "@/lib/time";
import { useClock } from "@/components/providers/clock-provider";

/**
 * A moment, written the one way the panel writes moments:
 * "27 Oct 2026, 11:05 am · 1d ago" — the exact date and time, then how long ago
 * (dropped after 30 days). Hover shows it to the second. The two halves never
 * split inside; on a narrow line the "how long ago" moves to the next line and
 * the "·" stays at the end of the first, so nothing overflows on any screen.
 */
export function When({ iso, className, relative = true }: { iso: string | null | undefined; className?: string; relative?: boolean }) {
  useClock();
  if (!iso) return null;
  const rel = relative ? ago(iso) : "";
  return (
    <time dateTime={iso} title={istTime(iso)} className={className}>
      <span className="whitespace-nowrap">
        {fmtDateTime(iso)}
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
