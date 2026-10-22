import { cn } from "@/lib/cn";

type Tone = "neutral" | "brand" | "success" | "warning" | "info" | "danger";

const tones: Record<Tone, string> = {
  neutral: "bg-canvas text-ink-muted ring-line",
  brand: "bg-surface text-ink ring-ink/30",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warning: "bg-amber-50 text-amber-700 ring-amber-200",
  info: "bg-sky-50 text-sky-700 ring-sky-200",
  danger: "bg-red-50 text-red-700 ring-red-200",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-[1px] text-[11px] font-semibold ring-1 ring-inset",
        tones[tone],
        className
      )}
      {...props}
    />
  );
}
