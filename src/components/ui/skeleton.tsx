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
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
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
