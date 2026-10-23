"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { IconChevronUp, IconChevronDown, IconGrip } from "@/components/ui/icons";

/**
 * A list the user can arrange by hand: drag a row by its grip (mouse, pen or
 * finger — pointer events, no library) or nudge it with the arrows, which
 * also makes the order reachable from the keyboard. The parent owns the
 * array; every move calls `onChange` with the new order.
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

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onChange(next);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragKey || !listRef.current) return;
    const rows = [...listRef.current.querySelectorAll<HTMLElement>("[data-sort-key]")];
    const from = rows.findIndex((r) => r.dataset.sortKey === dragKey);
    if (from === -1) return;
    // The row under the pointer becomes the dragged row's new slot. Rows
    // re-render in the new order, so the next move compares against that.
    let over = from;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom) {
        over = i;
        break;
      }
      if (i === 0 && e.clientY < r.top) over = 0;
      if (i === rows.length - 1 && e.clientY > r.bottom) over = i;
    }
    if (over !== from) move(from, over);
  };

  return (
    <ol ref={listRef} className={cn("divide-y divide-line/70 overflow-hidden rounded-lg border border-line bg-surface", className)} onPointerMove={onPointerMove} onPointerUp={() => setDragKey(null)} onPointerCancel={() => setDragKey(null)}>
      {items.map((item, i) => {
        const key = keyOf(item);
        const dragging = dragKey === key;
        return (
          <li key={key} data-sort-key={key} className={cn("flex items-center gap-2 px-2.5 py-1.5 text-[13px] transition-colors", dragging && "relative z-[1] bg-brand-50/60 shadow-[0_2px_8px_rgba(0,0,0,0.08)]", itemClassName)}>
            {!disabled && (
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                  setDragKey(key);
                }}
                onPointerUp={(e) => {
                  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                  setDragKey(null);
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
