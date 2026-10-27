import Link from "next/link";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { IconAlert } from "./icons";

/** Tinted rounded icon chip (used by StatCard). */
function IconTile({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-canvas text-ink-muted ring-1 ring-inset ring-line",
        className
      )}
    >
      {children}
    </span>
  );
}

export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="flex items-center gap-1.5 text-sm text-ink-subtle" aria-label="Breadcrumb">
      {items.map((it, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5">
            {it.href && !last ? (
              <Link href={it.href} className="transition-colors hover:text-ink">
                {it.label}
              </Link>
            ) : (
              <span className={last ? "font-medium text-ink-muted" : undefined}>{it.label}</span>
            )}
            {!last && <span className="text-line">/</span>}
          </span>
        );
      })}
    </nav>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    // Stack on mobile (actions always BELOW the title) so the header can't
    // reflow/jump when the action content changes width (e.g. the sync label
    // showing/hiding). Side-by-side from sm+. No eyebrow labels — the page
    // title stands on its own, Play Console-style.
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-4", className)}>
      <div className="min-w-0 sm:flex-1 sm:basis-[24rem]">
        {/* 2.0: a touch more presence on the page title — larger on desktop,
            tighter tracking — so each screen opens with a clear anchor. */}
        <h1 className="text-[20px] font-bold leading-tight tracking-[-0.02em] text-ink [text-wrap:balance] sm:text-[24px]">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-[13px] text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  icon,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  hint?: string;
}) {
  return (
    // Phones: the icon steps aside so the label keeps one line, and the hint may take two.
    <div className="min-w-0 rounded-xl border border-line bg-surface px-3.5 py-3 sm:px-4 sm:py-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-subtle sm:text-[11px] sm:tracking-[0.08em]">{label}</span>
        {icon && (
          <span className="hidden sm:block">
            <IconTile>{icon}</IconTile>
          </span>
        )}
      </div>
      <div className="mt-2 text-[24px] font-bold leading-none tracking-[-0.02em] text-ink tabular-nums sm:text-[26px]">{value}</div>
      {hint && <div className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-ink-subtle sm:truncate">{hint}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-canvas text-ink-muted ring-1 ring-inset ring-line">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm leading-relaxed text-ink-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A failed fetch, honestly: says something went wrong and offers a retry —
 * never masquerades as a genuine "nothing here yet" empty state. */
export function LoadError({ onRetry, title = "Couldn't load this" }: { onRetry: () => void; title?: string }) {
  return (
    <EmptyState
      icon={<IconAlert size={20} />}
      title={title}
      description="Something went wrong fetching data. Check your connection and try again."
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent",
        className
      )}
    />
  );
}

/** Premium dual-ring brand loader. Use inside PageLoader or standalone. */
function Loader({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <span className={cn("relative inline-flex", className)} style={{ width: size, height: size }} role="status" aria-label="Loading">
      <span className="absolute inset-0 rounded-full border-[3px] border-brand-100" />
      <span className="absolute inset-0 animate-spin rounded-full border-[3px] border-transparent border-t-brand-600 border-r-brand-500" />
      <span className="absolute inset-[30%] animate-pulse rounded-full bg-brand-500/15" />
    </span>
  );
}

/** Centered, full-area loading state — shown in the MIDDLE of the page. */
export function PageLoader({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex min-h-[55vh] w-full flex-col items-center justify-center gap-4", className)}>
      <Loader />
      {label && <span className="text-sm font-medium text-ink-subtle">{label}</span>}
    </div>
  );
}
