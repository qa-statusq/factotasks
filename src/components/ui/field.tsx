import { cn } from "@/lib/cn";
import { cloneElement, forwardRef, isValidElement, useId } from "react";

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  // The label names its control: a single child without an id gets one.
  const id = useId();
  const child = isValidElement(children) && !(children.props as { id?: string }).id ? cloneElement(children as React.ReactElement<{ id?: string }>, { id }) : children;
  const forId = isValidElement(children) ? ((children.props as { id?: string }).id ?? id) : undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && <label htmlFor={forId} className="block text-[12.5px] font-semibold text-ink-muted">{label}</label>}
      {child}
      {hint && <p className="text-xs leading-relaxed text-ink-subtle">{hint}</p>}
    </div>
  );
}

/**
 * The one canonical form-control style. Exported so search inputs and
 * popover triggers (dropdown, date-range picker) compose the SAME string
 * instead of hand-rolling copies that drift apart.
 */
export const controlClass =
  // 2.0: crisper focus (a tighter 3px brand halo instead of the wide 4px wash)
  // and a slightly silkier hover/focus transition. Same box, same density.
  "w-full rounded-lg border border-line bg-surface px-3 text-[13.5px] text-ink placeholder:text-ink-subtle/80 transition-[border-color,box-shadow] duration-150 hover:border-ink/25 focus:border-ink focus:outline-hidden focus:ring-[3px] focus:ring-ink/10";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(controlClass, "h-10", className)} {...props} />
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(controlClass, "py-2.5 leading-relaxed", className)} {...props} />
);
Textarea.displayName = "Textarea";
