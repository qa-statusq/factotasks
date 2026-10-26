"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { anchorRect } from "@/lib/viewport";
import { scrollIntoViewNearest } from "@/lib/compat";
import { controlClass } from "@/components/ui/field";
import { IconChevronDown, IconCheck } from "@/components/ui/icons";
import { useLatest } from "@/lib/use-latest";
import { useOnChange } from "@/lib/use-on-change";

interface Option {
  value: string;
  label: string;
}

interface MenuPos {
  left: number;
  top: number;
  width: number;
  up: boolean;
}

export function Dropdown({
  value,
  onChange,
  options,
  placeholder = "Select…",
  className,
  fit,
  id,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  className?: string;
  /** Size the trigger to its label instead of filling the row (toolbars). */
  fit?: boolean;
  /** Set by `Field`, so its label names this control. */
  id?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  // Keyboard-active option (starts at the selected one when the menu opens).
  const [active, setActive] = useState(value);
  const activeRef = useRef(value);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The open-menu effect deliberately keys on [open, options.length] so the
  // document listeners bind once per open — but the keydown handler must still
  // see the LATEST options/onChange (a parent re-render while the menu is open
  // can swap the closure; Enter would otherwise select through the stale one).
  const optionsRef = useLatest(options);
  const onChangeRef = useLatest(onChange);

  // Position the menu against the viewport and render it in a portal so it
  // escapes any overflow-clipping ancestor (e.g. a table's overflow-x-auto) —
  // it never gets cut off or forces the container to scroll, on any row.
  // Opening the menu starts highlighted on the CURRENT value. Done during
  // render so that is what paints, not a frame showing the previous highlight.
  useOnChange(open, () => {
    if (open) setActive(value);
  });

  useEffect(() => {
    if (!open) return;
    activeRef.current = value;
    function place() {
      const b = btnRef.current ? anchorRect(btnRef.current) : null;
      if (!b) return;
      const menuH = Math.min(264, options.length * 40 + 10);
      const spaceBelow = b.vh - b.bottom;
      const up = spaceBelow < menuH + 12 && b.top > spaceBelow;
      setPos({ left: b.left, width: b.width, top: up ? b.top - 6 : b.bottom + 6, up });
    }
    place();
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Capture phase + stop: the sheet underneath must not close too.
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
        return;
      }
      // Tab is the ONE way focus leaves the trigger without an outside
      // mousedown (which already closes the menu). The menu is portaled to
      // document.body and this listener is document-wide, so leaving it bound
      // meant a later Enter/Space ANYWHERE on the page was swallowed — it
      // preventDefault()ed the keystroke the focused control should have got
      // and re-committed the dropdown's option. No preventDefault here: focus
      // must still move on naturally.
      if (e.key === "Tab") {
        setOpen(false);
        return;
      }
      // Listbox keyboard navigation: arrows move the active option, Home/End
      // jump, Enter/Space select. Standard combobox behaviour. Reads options/
      // onChange through refs — the effect closure is from open-time.
      const opts = optionsRef.current;
      const idx = opts.findIndex((o) => o.value === activeRef.current);
      const move = (n: number) => {
        const next = opts[Math.max(0, Math.min(opts.length - 1, idx + n))];
        if (next) {
          activeRef.current = next.value;
          setActive(next.value);
          const el = document.getElementById(`dd-opt-${next.value}`);
          if (el) scrollIntoViewNearest(el); // compat: options-object scrollIntoView yanks old engines to top
        }
      };
      if (e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        move(-opts.length);
      } else if (e.key === "End") {
        e.preventDefault();
        move(opts.length);
      } else if (e.key === "Enter" || e.key === " ") {
        const cur = opts.find((o) => o.value === activeRef.current);
        if (cur) {
          e.preventDefault();
          onChangeRef.current(cur.value);
          setOpen(false);
          btnRef.current?.focus();
        }
      }
    }
    function onScroll(e: Event) {
      // Scrolling INSIDE the menu (long option lists) must NOT close it — only
      // an outside/page scroll does, since the fixed-positioned menu would then
      // detach from the button.
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setOpen(false);
    }
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    // Fixed-positioned menu would detach on outside scroll/resize — close it.
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
    // `value` is read to SEED the active option, but is deliberately not a
    // dependency. It is always fresh where it matters: this effect only does
    // anything when `open` flips false -> true, and that flip re-renders with
    // the current value. Adding it would re-run the whole effect whenever the
    // selection changes while the menu is open — resetting the highlight out
    // from under the user's arrow keys and rebinding every document listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options.length]);

  const selected = options.find((o) => o.value === value);

  return (
    <div className={cn("relative", fit && "inline-flex w-auto max-w-full", className)}>
      <button
        ref={btnRef}
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(controlClass, "flex h-10 items-center justify-between gap-2", fit && "w-auto max-w-full", disabled && "cursor-not-allowed opacity-60 hover:border-line")}
      >
        <span data-nowrap className={cn("truncate", fit && "whitespace-nowrap", selected ? "text-ink" : "text-ink-subtle")}>
          {selected ? selected.label : placeholder}
        </span>
        <IconChevronDown size={16} className={cn("shrink-0 text-ink-subtle transition-transform", open && "rotate-180")} />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              left: pos.left,
              // At least as wide as the trigger; wider when a label needs it,
              // so no option is ever cut to "Mobile Apps Weekl…".
              minWidth: pos.width,
              maxWidth: Math.max(pos.width, Math.min(440, window.innerWidth - pos.left - 8)),
              ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
            }}
            role="listbox"
            className="z-[200] max-h-64 animate-scale-in overflow-auto overscroll-contain rounded-xl border border-line/80 bg-surface p-1.5 shadow-pop ring-1 ring-ink/5"
          >
            {options.map((o) => (
              <button
                key={o.value}
                id={`dd-opt-${o.value}`}
                type="button"
                role="option"
                aria-selected={o.value === value}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-canvas",
                  o.value === value ? "bg-brand-50/60 font-semibold text-brand-700" : "text-ink",
                  o.value === active && o.value !== value && "bg-canvas"
                )}
              >
                <span className="min-w-0 break-words">{o.label}</span>
                {o.value === value && <IconCheck size={15} className="shrink-0 text-brand-600" />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
