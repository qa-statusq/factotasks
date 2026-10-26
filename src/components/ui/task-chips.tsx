"use client";

import { createContext, useContext, useState } from "react";
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
import { IconAndroid, IconApple, IconFlag, IconCheck, IconPresentation } from "@/components/ui/icons";
import type { AppLite, TaskTarget } from "@/lib/types";

/** Status pill with its colour dot — the same treatment on every screen. */
export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const m = STATUS_META[status] ?? STATUS_META.todo;
  return (
    <Badge tone={m.tone} className={cn("gap-1.5 rounded-full", status === "in_review" && "bg-violet-50 text-violet-700 ring-violet-200", className)} title={m.hint}>
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

/**
 * The Android robot (green) or the Apple mark (black) — always in their own
 * colour so they read at 11px, with a tick when that target has shipped.
 */
export function PlatformGlyph({ platform, size = 12, className, released }: { platform: "android" | "ios"; size?: number; className?: string; released?: boolean }) {
  const label = `${PLATFORM_META[platform].label}${released ? " · released" : ""}`;
  const badge = Math.max(8, Math.round(size * 0.7));
  return (
    <span className={cn("relative inline-flex shrink-0 items-center", released && "mr-0.5", className)} title={label} aria-label={label}>
      {platform === "android" ? <IconAndroid size={size} className="text-[#2f9e5f]" /> : <IconApple size={size} className="text-ink" />}
      {released && (
        // A green check badge on the corner of the mark — "this one shipped" — instead of a loose tick beside it.
        <span className="absolute -bottom-0.5 -right-1 flex items-center justify-center rounded-full bg-emerald-500 ring-[1.5px] ring-surface" style={{ width: badge, height: badge }}>
          <IconCheck size={Math.max(6, badge - 3)} className="text-white" strokeWidth={3} />
        </span>
      )}
    </span>
  );
}

/** Android / iOS glyphs with a label; "both" shows the pair. */
export function PlatformBadge({ platform, className, label = true }: { platform: Platform | null | undefined; className?: string; label?: boolean }) {
  if (!platform) return null;
  const m = PLATFORM_META[platform];
  const icons =
    platform === "both" ? (
      <>
        <PlatformGlyph platform="android" size={13} />
        <PlatformGlyph platform="ios" size={13} />
      </>
    ) : (
      <PlatformGlyph platform={platform} size={13} />
    );
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[11.5px] font-medium text-ink-muted", className)} title={m.label}>
      {icons}
      {label && (platform === "both" ? "Android · iOS" : m.label)}
    </span>
  );
}

/** The one tile for "General" (work on no app) — the same grey G everywhere. */
export function GeneralTile({ className }: { className?: string }) {
  return <AppTile name="General" color="#94a3b8" className={className} />;
}

/** App identity: tile + name. "General" when the task has no app. */
export function AppChip({ app, className, size = "sm" }: { app: AppLite | null | undefined; className?: string; size?: "xs" | "sm" }) {
  const tile = size === "xs" ? "h-4 w-4 rounded-[4px] text-[7px]" : "h-5 w-5 rounded-[5px] text-[8px]";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-ink-muted", className)} title={app ? app.name : "General task (no app)"}>
      {app ? <AppTile name={app.name} color={app.color} iconUrl={app.icon_url} className={tile} /> : <GeneralTile className={tile} />}
      <span className="truncate">{app ? app.name : "General"}</span>
    </span>
  );
}

/**
 * Square app tile: the store icon when the app has one, otherwise its first
 * letter on its colour. An icon that fails to load falls back to the letter
 * instead of leaving an empty box.
 */
/** Store artwork goes through the panel's own relay (/api/icon), which the hosting CDN caches. */
export function iconSrc(url: string): string {
  try {
    const h = new URL(url).hostname;
    if (h === "play-lh.googleusercontent.com" || h.endsWith("mzstatic.com")) return `/api/icon?u=${encodeURIComponent(url)}`;
  } catch {
    /* not a URL: use as-is */
  }
  return url;
}

/** Set to true around the meeting deck: every slide is mounted at once, so icons must not wait to be scrolled into view. */
export const EagerIconsContext = createContext(false);

export function AppTile({ name, color, iconUrl, androidIconUrl, iosIconUrl, platform, className }: { name: string; color: string; iconUrl?: string | null; androidIconUrl?: string | null; iosIconUrl?: string | null; /** Show that platform's own store icon when the app has one. */ platform?: "android" | "ios" | null; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const eager = useContext(EagerIconsContext);
  // Where the tile stands for ONE platform, that store's icon wins over the main tile.
  const src = platform === "android" ? androidIconUrl ?? iconUrl : platform === "ios" ? iosIconUrl ?? iconUrl : iconUrl;
  // The caller's own radius wins; rounded-xl is only the default.
  const radius = /(^|\s)rounded(-|\s|$)/.test(className ?? "") ? "" : "rounded-xl";
  if (src && broken !== src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={iconSrc(src)} alt="" loading={eager ? "eager" : "lazy"} decoding="async" onError={() => setBroken(src)} className={cn("shrink-0 bg-canvas object-cover ring-1 ring-inset ring-black/10", radius, className)} />
    );
  }
  return (
    <span
      className={cn("flex shrink-0 select-none items-center justify-center font-bold uppercase text-white ring-1 ring-inset ring-black/10", radius, className)}
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
    <Badge tone={m.tone} className={cn("rounded-full", className)}>
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
 * Where a task ships: ONE chip per app — its tile, name and a glyph per
 * platform (ticked once that target is released) — "+N" past `max` apps.
 * `compact` drops the names when the task spans more than two apps (the
 * tooltip still carries them). A task without targets is a general task.
 */
export function TargetChips({ targets, max = Infinity, compact, className }: { targets?: TaskTarget[]; max?: number; compact?: boolean; className?: string }) {
  if (!targets?.length) return <AppChip app={null} size="xs" className={className} />;
  const byApp = new Map<string, { app: AppLite; items: TaskTarget[] }>();
  for (const t of targets) {
    const g = byApp.get(t.app.id) ?? { app: t.app, items: [] };
    g.items.push(t);
    byApp.set(t.app.id, g);
  }
  const list = [...byApp.values()];
  for (const g of list) g.items.sort((a, b) => (a.platform === b.platform ? 0 : a.platform === "android" ? -1 : 1));
  const shown = list.slice(0, max);
  const more = list.length - shown.length;
  // One pill per app: icon, name, then its platforms — every app shows, nothing hides behind a "+1".
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {shown.map(({ app: a, items }) => (
        <span
          key={a.id}
          className={cn("inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-md bg-canvas py-[1px] pl-[3px] pr-1.5 text-[11.5px] font-medium text-ink-muted ring-1 ring-inset ring-line/80", compact && "text-[11px]")}
          title={`${a.name} · ${items.map((t) => `${PLATFORM_META[t.platform].label}${t.released_at ? " (released)" : t.release ? ` (v${t.release.version_name})` : ""}`).join(", ")}`}
        >
          <AppTile name={a.name} color={a.color} iconUrl={a.icon_url} androidIconUrl={a.icon_android_url} iosIconUrl={a.icon_ios_url} platform={items.length === 1 ? items[0].platform : null} className="h-4 w-4 rounded-[4px] text-[7px]" />
          <span className="max-w-[9rem] truncate">{a.name}</span>
          <span className="ml-0.5 inline-flex items-center gap-0.5 border-l border-line/80 pl-1">
            {items.map((t) => (
              <PlatformGlyph key={t.platform} platform={t.platform} size={11} released={!!t.released_at} />
            ))}
          </span>
        </span>
      ))}
      {more > 0 && <span className="text-[11px] text-ink-subtle">+{more}</span>}
    </span>
  );
}

/** "Attached to Weekly sync": the series a task reports into. */
export function SeriesChip({ series, className }: { series?: { id: string; name: string; color: string } | null; className?: string }) {
  if (!series) return null;
  // The presentation glyph in the series' colour says "meeting" at a glance;
  // the word is spelled out unless the series name already carries it.
  const saysMeeting = /meet/i.test(series.name);
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[11.5px] font-medium text-ink-muted", className)} title={`Reports into the "${series.name}" meetings until done`}>
      <IconPresentation size={12} className="shrink-0" style={{ color: series.color }} />
      {!saysMeeting && <span className="text-ink-subtle">Meeting ·</span>}
      {series.name}
    </span>
  );
}

/** "Released 2/6" once anything has shipped; green when everything has. */
export function ReleaseProgress({ progress, className }: { progress?: { released: number; total: number }; className?: string }) {
  if (!progress || progress.total < 1 || progress.released === 0) return null;
  const all = progress.released >= progress.total;
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded-full px-1.5 py-px text-[10.5px] font-semibold ring-1 ring-inset", all ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-teal-50 text-teal-700 ring-teal-200", className)} title={`Released on ${progress.released} of ${progress.total} targets`}>
      Released {progress.released}/{progress.total}
    </span>
  );
}
