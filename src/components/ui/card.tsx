import { cn } from "@/lib/cn";

export function Card({
  className,
  hoverable,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { hoverable?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-line bg-surface",
        hoverable && "transition-colors duration-150 hover:border-ink/20",
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-b border-line/80 px-4 py-3.5 sm:px-5 sm:py-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-[13px] font-semibold tracking-[-0.01em] text-ink", className)} {...props} />;
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 sm:p-5", className)} {...props} />;
}

/** Titled section header with a tinted icon tile — used inside form/section cards. */
export function SectionHeader({
  icon,
  title,
  description,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-3 border-b border-line/80 px-4 py-3.5 sm:px-5 sm:py-4", className)}>
      {icon && (
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100">
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <h3 className="text-sm font-semibold tracking-[-0.01em] text-ink">{title}</h3>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-ink-subtle">{description}</p>}
      </div>
    </div>
  );
}
