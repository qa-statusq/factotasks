import { cn } from "@/lib/cn";

/**
 * FactoTasks mark: a heavy, rounded F on a green tile with a white tick riding
 * its lower arm — the initial and "done" in one shape. Inline SVG, crisp at
 * any size with zero network. The PNG variants in /brand are generated from
 * the same geometry (scripts/make-icons.mjs).
 */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={cn("shrink-0", className)}>
      <rect width="32" height="32" rx="8" fill="#059669" />
      <path d="M9 6.5h14a3 3 0 0 1 0 6h-8v2.5h6.5a2.75 2.75 0 0 1 0 5.5H15v3a3 3 0 0 1-6 0V6.5z" fill="#ffffff" />
      <path d="M18 24.4l2.6 2.6 5.6-6" fill="none" stroke="#ffffff" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Wordmark: one word, one heavy weight, tight tracking. */
export function BrandName({ className }: { className?: string }) {
  return <span className={cn("text-[17px] font-extrabold leading-none tracking-[-0.035em] text-ink", className)}>FactoTasks</span>;
}
