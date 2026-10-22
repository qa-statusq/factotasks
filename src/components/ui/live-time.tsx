"use client";

import { relativeTime, relativeTimeLong } from "@/lib/time";
import { useClock } from "@/components/providers/clock-provider";

/**
 * Leaf components that render a live, self-updating relative timestamp. They
 * subscribe to the shared clock so ONLY this tiny node re-renders every 30s —
 * the surrounding card/list/page does not. Use these instead of calling
 * relativeTime()/relativeTimeLong() inline together with a page-level useClock().
 */
export function RelTime({ iso }: { iso: string | null | undefined }) {
  useClock();
  return <>{relativeTime(iso)}</>;
}

export function RelTimeLong({ iso }: { iso: string | null | undefined }) {
  useClock();
  return <>{relativeTimeLong(iso)}</>;
}
