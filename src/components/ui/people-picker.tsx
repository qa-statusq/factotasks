"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { controlClass } from "@/components/ui/field";
import { Avatar } from "@/components/ui/avatar";
import { IconCheck, IconChevronDown, IconSearch, IconX } from "@/components/ui/icons";
import { DEPARTMENT_META } from "@/lib/domain";
import { useOnChange } from "@/lib/use-on-change";
import type { UserBrief } from "@/lib/types";

interface MenuPos {
  left: number;
  top: number;
  width: number;
  up: boolean;
}

/**
 * Multi-select of teammates with search, keyboard navigation and avatar chips.
 * The menu is portaled and viewport-positioned (like Dropdown) so it is never
 * clipped by a scrolling sheet. Deactivated people are hidden unless already
 * selected (so an old task can still show them).
 */
export function PeoplePicker({
  users,
  value,
  onChange,
  placeholder = "Assign teammates…",
  max = 10,
  className,
  single,
}: {
  users: UserBrief[];
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  max?: number;
  className?: string;
  /** Pick exactly one person (closes on select). */
  single?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const selected = value.map((id) => byId.get(id)).filter(Boolean) as UserBrief[];
  const query = q.trim().toLowerCase();
  const options = useMemo(() => {
    const pool = users.filter((u) => u.is_active || value.includes(u.id));
    const list = query
      ? pool.filter((u) => `${u.name} ${u.email || ""} ${DEPARTMENT_META[u.department]?.label ?? ""}`.toLowerCase().includes(query))
      : pool;
    // Selected first, then by department, then name.
    return [...list].sort((a, b) => {
      const sa = value.includes(a.id) ? 0 : 1;
      const sb = value.includes(b.id) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      if (a.department !== b.department) return a.department.localeCompare(b.department);
      return a.name.localeCompare(b.name);
    });
  }, [users, value, query]);

  const toggle = (id: string) => {
    if (single) {
      onChange(value.includes(id) ? [] : [id]);
      setOpen(false);
      btnRef.current?.focus();
      return;
    }
    if (value.includes(id)) onChange(value.filter((v) => v !== id));
    else if (value.length < max) onChange([...value, id]);
  };

  // Opening starts with an empty search and the first option highlighted —
  // reset during render so that is what paints (no effect round-trip).
  useOnChange(open, () => {
    if (open) {
      setQ("");
      setActive(0);
    }
  });

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      const menuH = 320;
      const spaceBelow = window.innerHeight - b.bottom;
      const up = spaceBelow < menuH + 12 && b.top > spaceBelow;
      setPos({ left: b.left, width: Math.max(b.width, 280), top: up ? b.top - 6 : b.bottom + 6, up });
    };
    place();
    // Focus the search box once the portal has painted.
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    // Escape closes the list only — captured before the sheet's own handler.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = options[active];
      if (o) toggle(o.id);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={cn("relative", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(controlClass, "flex min-h-10 items-center justify-between gap-2 py-1.5 text-left")}
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {selected.length === 0 ? (
            <span className="text-ink-subtle">{placeholder}</span>
          ) : (
            selected.map((u) => (
              <span key={u.id} className="inline-flex items-center gap-1.5 rounded-full bg-canvas py-0.5 pl-0.5 pr-2 text-xs font-medium text-ink ring-1 ring-inset ring-line">
                <Avatar user={u} size="xs" />
                <span className="max-w-[140px] truncate">{u.name}</span>
                {!single && (
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(u.id);
                    }}
                    className="-mr-1 rounded-full p-0.5 text-ink-subtle hover:text-ink"
                    aria-label={`Remove ${u.name}`}
                  >
                    <IconX size={12} />
                  </span>
                )}
              </span>
            ))
          )}
        </span>
        <IconChevronDown size={16} className={cn("shrink-0 text-ink-subtle transition-transform", open && "rotate-180")} />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            style={{ position: "fixed", left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
            role="listbox"
            aria-multiselectable={!single}
            onKeyDown={onKey}
            className="z-[200] flex max-h-80 animate-scale-in flex-col overflow-hidden rounded-xl border border-line/80 bg-surface shadow-pop ring-1 ring-ink/5"
          >
            <div className="relative border-b border-line p-2">
              <IconSearch size={14} className="pointer-events-none absolute left-4.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                placeholder="Search by name or team…"
                className={cn(controlClass, "h-9 pl-8 text-[13px]")}
                aria-label="Search teammates"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
              {options.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-ink-subtle">No one matches.</p>
              ) : (
                options.map((u, i) => {
                  const on = value.includes(u.id);
                  const full = !on && !single && value.length >= max;
                  return (
                    <button
                      key={u.id}
                      type="button"
                      role="option"
                      aria-selected={on}
                      disabled={full}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => toggle(u.id)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors disabled:opacity-40",
                        i === active ? "bg-canvas" : "hover:bg-canvas",
                        on && "font-medium text-ink"
                      )}
                    >
                      <Avatar user={u} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{u.name}</span>
                        <span className="block truncate text-[11px] text-ink-subtle">
                          {DEPARTMENT_META[u.department]?.label ?? u.department}
                          {!u.is_active && " · deactivated"}
                        </span>
                      </span>
                      {on && <IconCheck size={15} className="shrink-0 text-brand-600" />}
                    </button>
                  );
                })
              )}
            </div>
            {!single && (
              <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[11px] text-ink-subtle">
                <span>
                  {value.length} of {max} selected
                </span>
                <button type="button" onClick={() => setOpen(false)} className="font-medium text-brand-700 hover:text-brand-800">
                  Done
                </button>
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
