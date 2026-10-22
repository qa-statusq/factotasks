import { cn } from "@/lib/cn";
import { nameInitials } from "@/lib/name";

interface Person {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  name?: string | null;
  color?: string | null;
  is_active?: boolean;
}

const SIZES = {
  xs: "h-5 w-5 text-[9px]",
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
  xl: "h-14 w-14 text-lg",
} as const;

/**
 * A person's avatar: initials on their own colour (set at invite time from a
 * fixed palette, so teammates are distinguishable at a glance everywhere —
 * assignee stacks, comments, the MOM deck). Deactivated people render muted.
 */
export function Avatar({
  user,
  size = "md",
  className,
  title,
}: {
  user: Person | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
  title?: string;
}) {
  const initials = user ? nameInitials(user.first_name, user.last_name, user.email || user.name) : "?";
  const inactive = user?.is_active === false;
  return (
    <span
      title={title ?? user?.name ?? undefined}
      aria-hidden={title ? undefined : true}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold uppercase text-white ring-2 ring-surface",
        SIZES[size],
        inactive && "opacity-45 grayscale",
        className
      )}
      style={{ backgroundColor: user?.color || "#64748b" }}
    >
      {initials}
    </span>
  );
}

/** Overlapping stack of up to `max` avatars, "+N" for the rest. */
export function AvatarStack({
  users,
  max = 3,
  size = "sm",
  className,
}: {
  users: Person[];
  max?: number;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  if (!users.length) return null;
  const shown = users.slice(0, max);
  const rest = users.length - shown.length;
  return (
    <span className={cn("inline-flex items-center -space-x-1.5", className)} title={users.map((u) => u.name || u.email || "").join(", ")}>
      {shown.map((u, i) => (
        <Avatar key={(u.email || u.name || "") + i} user={u} size={size} />
      ))}
      {rest > 0 && (
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-700 ring-2 ring-surface",
            SIZES[size]
          )}
        >
          +{rest}
        </span>
      )}
    </span>
  );
}
