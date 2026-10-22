import { cn } from "@/lib/cn";
import { forwardRef } from "react";

type Variant = "primary" | "secondary" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

// Quiet, professional buttons: solid fills, hairline borders, color-only
// transitions. No gradients, glows, or scale effects. 2.0: a silkier 200ms
// curve and a secondary hover that firms the hairline as well as the fill.
const base =
  "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-semibold tracking-[-0.005em] transition-[background-color,border-color,color,transform] duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-2 focus-visible:ring-offset-surface active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-white hover:bg-[#2a2a27]",
  secondary: "border border-line bg-surface text-ink hover:border-ink/25 hover:bg-canvas",
  danger: "border border-line bg-surface text-red-600 hover:border-red-200 hover:bg-red-50",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-3.5 text-[13.5px]",
  lg: "h-11 px-5 text-[15px]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", ...props }, ref) => (
    <button ref={ref} className={cn(base, variants[variant], sizes[size], className)} {...props} />
  )
);
Button.displayName = "Button";

/** Button LOOK for non-button elements (e.g. a <Link> that must not wrap a
 * <button> — <a><button> is invalid HTML and double-announced by screen
 * readers). Usage: <Link className={buttonClass()}>…</Link> */
export function buttonClass(variant: Variant = "primary", size: Size = "md", className?: string): string {
  return cn(base, variants[variant], sizes[size], className);
}
