import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import {
  PLATFORM_META,
  PRIORITY_META,
  RELEASE_STATUS_META,
  STATUS_META,
  TYPE_META,
  type Platform,
  type Priority,
  type ReleaseStatus,
  type TaskStatus,
  type TaskType,
} from "@/lib/domain";
import { IconAndroid, IconApple, IconFlag, IconCheck } from "@/components/ui/icons";
import type { AppLite, TaskTarget } from "@/lib/types";

/** Status pill with its colour dot — the same treatment on every screen. */
export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const m = STATUS_META[status] ?? STATUS_META.todo;
  return (
    <Badge tone={m.tone} className={cn("gap-1.5", className)} title={m.hint}>
      <span className={cn("h-1.5 w-1.5 rounded-full", m.dot)} />
      {m.label}
    </Badge>
  );
}

export function PriorityBadge({ priority, className, compact }: { priority: Priority; className?: string; compact?: boolean }) {
  const m = PRIORITY_META[priority] ?? PRIORITY_META.medium;
  if (compact) {
    const color =
      priority === "urgent" ? "text-red-600" : priority === "high" ? "text-amber-600" : priority === "medium" ? "text-sky-600" : "text-slate-400";
    return (
      <span title={`${m.label} priority`} className={cn("inline-flex", className)}>
        <IconFlag size={14} className={color} aria-label={`${m.label} priority`} />
      </span>
    );
  }
  return (
    <Badge tone={m.tone} className={cn("gap-1", className)}>
      <IconFlag size={11} />
      {m.label}
    </Badge>
  );
}

export function TypeBadge({ type, className }: { type: TaskType; className?: string }) {
  return (
    <Badge tone="neutral" className={className}>
      {TYPE_META[type]?.label ?? type}
    </Badge>
  );
}

/** Android / iOS glyphs; "both" shows the pair. */
export function PlatformBadge({ platform, className, label = true }: { platform: Platform | null | undefined; className?: string; label?: boolean }) {
  if (!platform) return null;
  const m = PLATFORM_META[platform];
  const icons =
    platform === "both" ? (
      <>
        <IconAndroid size={13} />
        <IconApple size={13} />
      </>
    ) : platform === "android" ? (
      <IconAndroid size={13} />
    ) : (
      <IconApple size={13} />
    );
  return (
    <span
      className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[11.5px] font-medium text-ink-muted", className)}
      title={m.label}
    >
      {icons}
      {label && (platform === "both" ? "Android · iOS" : m.label)}
    </span>
  );
}

/** App identity: colour tile + name. "General" when the task has no app. */
export function AppChip({ app, className, size = "sm" }: { app: AppLite | null | undefined; className?: string; size?: "xs" | "sm" }) {
  const dot = size === "xs" ? "h-2 w-2 rounded-[3px]" : "h-2.5 w-2.5 rounded-[3px]";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-ink-muted", className)} title={app ? app.name : "General task (no app)"}>
      <span className={cn("shrink-0", dot)} style={{ backgroundColor: app?.color || "#94a3b8" }} />
      <span className="truncate">{app ? app.name : "General"}</span>
    </span>
  );
}

/** Square app tile with the first letter — used wherever an app is listed. */
export function AppTile({ name, color, iconUrl, className }: { name: string; color: string; iconUrl?: string | null; className?: string }) {
  if (iconUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={iconUrl} alt="" loading="lazy" decoding="async" className={cn("shrink-0 rounded-xl bg-canvas object-cover ring-1 ring-inset ring-black/10", className)} />
    );
  }
  return (
    <span
      className={cn("flex shrink-0 select-none items-center justify-center rounded-xl font-bold uppercase text-white ring-1 ring-inset ring-black/10", className)}
      style={{ backgroundColor: color }}
      aria-hidden
    >
      {Array.from(name.trim())[0] || "?"}
    </span>
  );
}

export function ReleaseStatusBadge({ status, className }: { status: ReleaseStatus; className?: string }) {
  const m = RELEASE_STATUS_META[status] ?? RELEASE_STATUS_META.planned;
  return (
    <Badge tone={m.tone} className={className}>
      {m.label}
    </Badge>
  );
}

/** Label tag (free-form, lower-cased). */
export function LabelChip({ label, className, onRemove }: { label: string; className?: string; onRemove?: () => void }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md bg-canvas px-1.5 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-inset ring-line", className)}>
      #{label}
      {onRemove && (
        <button type="button" onClick={onRemove} className="-mr-0.5 rounded px-0.5 text-ink-subtle hover:text-ink" aria-label={`Remove label ${label}`}>
          ×
        </button>
      )}
    </span>
  );
}

/**
 * Where a task ships, compactly: app tile + name + platform glyph per target,
 * a tick once that target is released, "+N" past `max`. Falls back to the
 * legacy single app/platform for cards without targets.
 */
export function TargetChips({ targets, app, platform, max = 3, className }: { targets?: TaskTarget[]; app?: AppLite | null; platform?: Platform | null; max?: number; className?: string }) {
  if (!targets?.length) {
    if (!app) return <span className={cn("text-[11.5px] text-ink-subtle", className)}>General</span>;
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)}>
        <AppChip app={app} size="xs" />
        <PlatformBadge platform={platform} label={false} className="px-0 ring-0 bg-transparent" />
      </span>
    );
  }
  const shown = targets.slice(0, max);
  const more = targets.length - shown.length;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-0.5", className)}>
      {shown.map((t) => (
        <span key={`${t.app.id}:${t.platform}`} className="inline-flex max-w-full items-center gap-1 whitespace-nowrap text-[11.5px] font-medium text-ink-muted" title={`${t.app.name} · ${PLATFORM_META[t.platform].label}${t.released_at ? " · released" : t.release ? ` · v${t.release.version_name}` : " · no release yet"}`}>
          <AppTile name={t.app.name} color={t.app.color} iconUrl={t.app.icon_url} className="h-3.5 w-3.5 rounded-[3px] text-[7px]" />
          <span className="max-w-[11rem] truncate">{t.app.name}</span>
          {t.platform === "android" ? <IconAndroid size={11} className="text-ink-subtle" /> : <IconApple size={11} className="text-ink-subtle" />}
          {t.released_at && <IconCheck size={10} className="text-emerald-600" />}
        </span>
      ))}
      {more > 0 && <span className="text-[11px] text-ink-subtle">+{more}</span>}
    </span>
  );
}

/** "Released 2/6" once anything has shipped; green when everything has. */
/** "Attached to Weekly sync": the series a task reports into. */
export function SeriesChip({ series, className }: { series?: { id: string; name: string; color: string } | null; className?: string }) {
  if (!series) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-muted", className)} title={`On the ${series.name} meetings`}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: series.color }} />
      {series.name}
    </span>
  );
}

export function ReleaseProgress({ progress, className }: { progress?: { released: number; total: number }; className?: string }) {
  if (!progress || progress.total < 1 || progress.released === 0) return null;
  const all = progress.released >= progress.total;
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded-full px-1.5 py-px text-[10.5px] font-semibold ring-1 ring-inset", all ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-teal-50 text-teal-700 ring-teal-200", className)} title={`Released on ${progress.released} of ${progress.total} targets`}>
      Released {progress.released}/{progress.total}
    </span>
  );
}
