import { cn } from "@/lib/cn";

/** A single shimmering placeholder block. The sweeping highlight is disabled
 * automatically for users who prefer reduced motion (see globals.css). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-md bg-ink/[0.07]", className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/70 to-transparent" />
    </div>
  );
}

/** Row of 4 stat-card placeholders, matching the real StatCard grid. */
function StatSkeletonRow() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-8 w-8 rounded-xl" />
          </div>
          <Skeleton className="mt-4 h-7 w-12" />
        </div>
      ))}
    </div>
  );
}

/** Generic list/table card placeholder (rows of avatar + two lines). */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-line px-5 py-4 last:border-0">
          <Skeleton className="h-9 w-9 rounded-xl" />
          <div className="flex flex-col gap-2 flex-1">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Two-line review-card placeholders for the reviews tab. */
export function ReviewListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-card">
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="flex flex-col gap-2 flex-1">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}

/** Dashboard / analytics first-load skeleton: stat row + chart blocks. */
export function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <StatSkeletonRow />
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-4 h-40 w-full rounded-xl" />
        </div>
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-4 h-40 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}

/**
 * Placeholder for the Analytics "Time saved" card.
 *
 * It exists to RESERVE the card's slot: that section fetches separately from
 * the rest of the screen (different windowing column — see analytics-view), so
 * without a placeholder the charts below it painted first and were then shoved
 * down when it arrived. Mirrors the real card's structure — header with a
 * subtitle, big figure, caption, a divided bar block — so the swap is a fill,
 * not a jump.
 */
export function TimeSavedSkeleton() {
  return (
    <div className="rounded-2xl border border-line bg-surface shadow-card">
      <div className="border-b border-line/80 px-4 py-3.5 sm:px-5 sm:py-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24 rounded-full" />
        </div>
        <Skeleton className="mt-1.5 h-3 w-3/5 max-w-md" />
      </div>
      <div className="p-4 sm:p-5">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="mt-3 h-3 w-4/5 max-w-lg" />
        <div className="mt-4 border-t border-line/80 pt-4">
          <Skeleton className="h-3 w-16" />
          <div className="flex flex-col gap-3 mt-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-3 w-full" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The Analytics screen's own first-load skeleton — the SAME blocks in the SAME
 * order the real screen renders them (range picker, stat row, Time saved, the
 * paired donut cards).
 *
 * One skeleton for both waits: the route's dynamic import (`withPicker`, since
 * the real picker lives inside the lazily-loaded view) and the view's own data
 * fetch (the picker is already on screen by then). Previously those two stages
 * showed DIFFERENT placeholders — and the app detail page showed review-row
 * placeholders for an analytics tab — so opening Analytics flashed through two
 * unrelated shapes before the real thing.
 */
export function AnalyticsSkeleton({ withPicker = false }: { withPicker?: boolean }) {
  return (
    <div className="flex flex-col gap-5">
      {withPicker && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <Skeleton className="h-3.5 w-44" />
          <Skeleton className="h-10 w-full rounded-lg sm:w-64" />
        </div>
      )}
      <StatSkeletonRow />
      <TimeSavedSkeleton />
      <div className="grid gap-5 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-2xl border border-line bg-surface shadow-card">
            <div className="flex items-center justify-between gap-2 border-b border-line/80 px-4 py-3.5 sm:px-5 sm:py-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-20 rounded-full" />
            </div>
            <div className="flex flex-col items-center gap-4 p-4 sm:flex-row sm:gap-6 sm:p-5">
              <Skeleton className="h-32 w-32 shrink-0 rounded-full" />
              <div className="flex flex-col gap-2.5 w-full sm:min-w-0 sm:flex-1">
                {[0, 1, 2, 3].map((r) => (
                  <Skeleton key={r} className="h-3.5 w-full" />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
