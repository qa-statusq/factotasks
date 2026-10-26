"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { zoomFactor } from "@/lib/viewport";
import { IconChevronUp, IconChevronDown, IconGrip } from "@/components/ui/icons";

/**
 * A list the user can arrange by hand: drag a row by its grip (mouse, pen or
 * finger — pointer events, no library) or nudge it with the arrows, which
 * also makes the order reachable from the keyboard. The parent owns the
 * array; every move calls `onChange` with the new order.
 *
 * Feel: the dragged row rides under the pointer; the others slide into their
 * new slot (FLIP — measured before paint, animated with a transform) instead
 * of jumping. The slot is the row whose middle is nearest the pointer, so a
 * row never flickers back and forth on a boundary.
 */
export function SortableList<T>({
  items,
  keyOf,
  onChange,
  children,
  className,
  itemClassName,
  disabled,
  numbered = true,
}: {
  items: T[];
  keyOf: (item: T) => string;
  onChange: (next: T[]) => void;
  children: (item: T, index: number) => React.ReactNode;
  className?: string;
  itemClassName?: string;
  disabled?: boolean;
  numbered?: boolean;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  // Grab geometry: where the pointer and the row were when the drag began.
  const grab = useRef<{ pointerY: number; rowTop: number; lastY: number } | null>(null);
  // Each row's layout top from the previous paint, for the slide animation.
  const tops = useRef<Map<string, number>>(new Map());

  const rows = () => [...(listRef.current?.querySelectorAll<HTMLElement>("[data-sort-key]") ?? [])];

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onChange(next);
  };

  // Put the dragged row under the pointer, whatever slot it now occupies.
  const placeDragged = () => {
    const g = grab.current;
    if (!g || !dragKey) return;
    const el = rows().find((r) => r.dataset.sortKey === dragKey);
    if (!el) return;
    el.style.transition = "none";
    el.style.transform = `translateY(${(g.lastY - g.pointerY) / zoomFactor() - (el.offsetTop - g.rowTop)}px)`;
  };

  useLayoutEffect(() => {
    const next = new Map<string, number>();
    for (const r of rows()) {
      const key = r.dataset.sortKey!;
      next.set(key, r.offsetTop);
      const prev = tops.current.get(key);
      if (key !== dragKey && prev !== undefined && prev !== r.offsetTop) {
        // FLIP: start from where it was, then let it slide to where it is.
        r.style.transition = "none";
        r.style.transform = `translateY(${prev - r.offsetTop}px)`;
        requestAnimationFrame(() => {
          r.style.transition = "transform 170ms ease";
          r.style.transform = "";
        });
      }
    }
    tops.current = next;
    placeDragged();
    // Rows move only when the list or the drag changes — not on every parent keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, dragKey]);

  const onPointerMove = (e: React.PointerEvent) => {
    const g = grab.current;
    if (!dragKey || !g) return;
    g.lastY = e.clientY;
    const list = rows();
    const from = list.findIndex((r) => r.dataset.sortKey === dragKey);
    if (from === -1) return;
    // Slot = the row whose middle is nearest the pointer (layout positions, transforms ignored).
    const z = zoomFactor(); // pointer and rects are real pixels; offsetTop is CSS pixels
    const base = listRef.current!.getBoundingClientRect().top / z;
    let over = from;
    let best = Infinity;
    list.forEach((r, i) => {
      const mid = base + r.offsetTop + r.offsetHeight / 2;
      const d = Math.abs(e.clientY / z - mid);
      if (d < best) {
        best = d;
        over = i;
      }
    });
    if (over !== from) move(from, over);
    else placeDragged();
  };

  const endDrag = () => {
    const el = dragKey ? rows().find((r) => r.dataset.sortKey === dragKey) : null;
    if (el) {
      el.style.transition = "transform 150ms ease";
      el.style.transform = "";
    }
    grab.current = null;
    setDragKey(null);
  };

  return (
    <ol ref={listRef} className={cn("relative divide-y divide-line/70 overflow-hidden rounded-lg border border-line bg-surface", dragKey && "select-none", className)} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {items.map((item, i) => {
        const key = keyOf(item);
        const dragging = dragKey === key;
        return (
          <li key={key} data-sort-key={key} className={cn("flex items-center gap-2 bg-surface px-2.5 py-1.5 text-[13px] will-change-transform", dragging && "relative z-[1] rounded-lg bg-brand-50 shadow-[0_6px_18px_rgba(0,0,0,0.14)] ring-1 ring-brand-200", itemClassName)}>
            {!disabled && (
              <button
                type="button"
                onPointerDown={(e) => {
                  if (e.button !== 0 && e.pointerType === "mouse") return;
                  e.preventDefault();
                  const row = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-sort-key]");
                  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                  grab.current = { pointerY: e.clientY, rowTop: row?.offsetTop ?? 0, lastY: e.clientY };
                  setDragKey(key);
                }}
                onPointerUp={(e) => {
                  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                  endDrag();
                }}
                className={cn("tap shrink-0 touch-none rounded-md p-1 text-ink-subtle hover:bg-canvas hover:text-ink", dragging ? "cursor-grabbing" : "cursor-grab")}
                aria-label="Drag to reorder"
                title="Drag to reorder"
              >
                <IconGrip size={14} />
              </button>
            )}
            {numbered && <span className="w-5 shrink-0 text-right tabular-nums text-ink-subtle">{i + 1}</span>}
            <div className="flex min-w-0 flex-1 items-center gap-2">{children(item, i)}</div>
            {!disabled && (
              <span className="flex shrink-0 items-center">
                <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} className="tap rounded-md p-1 text-ink-subtle hover:bg-canvas hover:text-ink disabled:opacity-30" aria-label="Move up">
                  <IconChevronUp size={14} />
                </button>
                <button type="button" onClick={() => move(i, i + 1)} disabled={i === items.length - 1} className="tap rounded-md p-1 text-ink-subtle hover:bg-canvas hover:text-ink disabled:opacity-30" aria-label="Move down">
                  <IconChevronDown size={14} />
                </button>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
