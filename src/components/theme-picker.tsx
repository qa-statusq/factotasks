"use client";

import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/cn";
import { IconCheck, IconMonitor, IconMoon, IconSun } from "@/components/ui/icons";

const OPTIONS: { value: Theme; label: string; hint: string; icon: typeof IconSun }[] = [
  { value: "light", label: "Light", hint: "Bright and clear", icon: IconSun },
  { value: "dark", label: "Dark", hint: "Easy on the eyes", icon: IconMoon },
  { value: "system", label: "System", hint: "Follows this device", icon: IconMonitor },
];

/** A miniature of the panel in one palette — fixed colours, so each tile shows its theme whatever is active. */
function Preview({ dark }: { dark: boolean }) {
  const c = dark
    ? { canvas: "#121211", surface: "#1d1d1c", line: "#31312e", ink: "#ecebe7", muted: "#4f4f4b", chip: "color-mix(in oklab, #10b981 22%, #1d1d1c)", chipInk: "#6ee7b7" }
    : { canvas: "#f7f7f5", surface: "#ffffff", line: "#e7e6e2", ink: "#1c1c1a", muted: "#d3d3cc", chip: "#ecfdf5", chipInk: "#047857" };
  return (
    <div className="flex h-full w-full gap-1.5 p-2" style={{ background: c.canvas }}>
      <div className="flex w-[22%] flex-col gap-1 rounded-[5px] p-1" style={{ background: c.surface, boxShadow: `inset 0 0 0 1px ${c.line}` }}>
        <span className="h-1.5 w-3/4 rounded-full" style={{ background: c.ink }} />
        <span className="h-1 w-full rounded-full" style={{ background: c.muted }} />
        <span className="h-1 w-5/6 rounded-full" style={{ background: c.muted }} />
        <span className="h-1 w-2/3 rounded-full" style={{ background: c.muted }} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5">
        <div className="flex flex-col gap-1 rounded-[5px] p-1.5" style={{ background: c.surface, boxShadow: `inset 0 0 0 1px ${c.line}` }}>
          <span className="h-1.5 w-1/2 rounded-full" style={{ background: c.ink }} />
          <span className="h-1 w-5/6 rounded-full" style={{ background: c.muted }} />
          <span className="mt-0.5 h-2 w-8 rounded-full" style={{ background: c.chip, boxShadow: `inset 0 0 0 1px ${c.chipInk}33` }} />
        </div>
        <div className="flex items-center gap-1 rounded-[5px] p-1.5" style={{ background: c.surface, boxShadow: `inset 0 0 0 1px ${c.line}` }}>
          <span className="h-1 flex-1 rounded-full" style={{ background: c.muted }} />
          <span className="h-2.5 w-6 rounded-[3px]" style={{ background: c.ink }} />
        </div>
      </div>
    </div>
  );
}

/** Profile → Appearance: three preview tiles, the chosen one ringed. Saves to the account instantly. */
export function ThemeTiles() {
  const [theme, setTheme] = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-3">
      {OPTIONS.map((o) => {
        const on = theme === o.value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setTheme(o.value)}
            className={cn(
              "group flex flex-col overflow-hidden rounded-xl bg-surface text-left ring-inset transition-shadow",
              on ? "ring-2 ring-ink" : "ring-1 ring-line hover:ring-brand-300"
            )}
          >
            <div className="relative aspect-[16/9] w-full overflow-hidden border-b border-line">
              {o.value === "system" ? (
                <>
                  <div className="absolute inset-0"><Preview dark={false} /></div>
                  <div className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]"><Preview dark /></div>
                </>
              ) : (
                <Preview dark={o.value === "dark"} />
              )}
              {on && (
                <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-on-ink shadow-xs">
                  <IconCheck size={12} strokeWidth={3} />
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 px-3 py-2.5">
              <Icon size={16} className={on ? "text-ink" : "text-ink-subtle"} />
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold text-ink">{o.label}</div>
                <div className="text-[12px] text-ink-subtle">{o.hint}</div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** Account menu: the same choice as three icon buttons, one tap. */
export function ThemeQuick() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
      <span className="text-sm font-medium text-ink-muted">Theme</span>
      <div role="radiogroup" aria-label="Theme" className="inline-flex items-center rounded-lg bg-brand-100/80 p-[3px]">
        {OPTIONS.map((o) => {
          const on = theme === o.value;
          const Icon = o.icon;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={o.label}
              title={o.label}
              onClick={() => setTheme(o.value)}
              className={cn("flex h-7 w-8 items-center justify-center rounded-[6px] transition-colors", on ? "bg-surface text-ink shadow-xs ring-1 ring-line" : "text-ink-subtle hover:text-ink")}
            >
              <Icon size={15} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
