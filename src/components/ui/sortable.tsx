"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { zoomFactor } from "@/lib/viewport";
import { useLatest } from "@/lib/use-latest";
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
 *
 * Touch: once a drag starts, the finger is followed at window level for the
 * whole gesture (re-inserting a row cannot drop it), the page does not scroll
 * under the finger, and the list scrolls itself when the finger nears the top
 * or bottom edge — so a long list can be arranged on a phone.
 */
const EDGE = 64; // px from the top/bottom of the scroll area where auto-scroll starts
const MAX_SPEED = 14; // px per frame at the very edge

/** The element that scrolls this list (a sheet's body, or the page itself). */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null; // the window
}

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
  // Live values for the window-level handlers of a drag in progress.
  const live = useLatest({ items, onChange });
  // The row being dragged, readable from window-level handlers at any moment of the gesture.
  const dragging = useRef<string | null>(null);
  // Grab geometry: where the pointer, the row and the scroll were when the drag began.
  const grab = useRef<{ pointerY: number; rowTop: number; lastY: number; scroll0: number; scroller: HTMLElement | null } | null>(null);
  // Each row's layout top from the previous paint, for the slide animation.
  const tops = useRef<Map<string, number>>(new Map());
  const stopDrag = useRef<(() => void) | null>(null);

  const rows = () => [...(listRef.current?.querySelectorAll<HTMLElement>("[data-sort-key]") ?? [])];
  const scrollTopOf = (s: HTMLElement | null) => (s ? s.scrollTop : window.scrollY);

  const move = (from: number, to: number) => {
    const { items: list, onChange: change } = live.current;
    if (from === to || to < 0 || to >= list.length) return;
    const next = [...list];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    change(next);
  };

  // Put the dragged row under the pointer, whatever slot it now occupies and however far the list scrolled.
  const placeDragged = () => {
    const g = grab.current;
    const key = dragging.current;
    if (!g || !key) return;
    const el = rows().find((r) => r.dataset.sortKey === key);
    if (!el) return;
    const z = zoomFactor();
    el.style.transition = "none";
    el.style.transform = `translateY(${(g.lastY - g.pointerY) / z + (scrollTopOf(g.scroller) - g.scroll0) / z - (el.offsetTop - g.rowTop)}px)`;
  };

  /** The pointer is at clientY: move the dragged row to the nearest slot. */
  const track = (clientY: number) => {
    const g = grab.current;
    const key = dragging.current;
    if (!g || !key) return;
    g.lastY = clientY;
    const list = rows();
    const from = list.findIndex((r) => r.dataset.sortKey === key);
    if (from === -1) return;
    // Slot = the row whose middle is nearest the pointer (layout positions, transforms ignored).
    const z = zoomFactor(); // pointer and rects are real pixels; offsetTop is CSS pixels
    const base = listRef.current!.getBoundingClientRect().top / z;
    let over = from;
    let best = Infinity;
    list.forEach((r, i) => {
      const mid = base + r.offsetTop + r.offsetHeight / 2;
      const d = Math.abs(clientY / z - mid);
      if (d < best) {
        best = d;
        over = i;
      }
    });
    if (over !== from) move(from, over);
    else placeDragged();
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

  // A drag in progress when the list goes away (sheet closed) ends cleanly.
  useEffect(() => () => stopDrag.current?.(), []);

  const startDrag = (e: React.PointerEvent<HTMLButtonElement>, key: string) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    stopDrag.current?.();
    const row = e.currentTarget.closest<HTMLElement>("[data-sort-key]");
    const scroller = scrollParent(listRef.current);
    grab.current = { pointerY: e.clientY, rowTop: row?.offsetTop ?? 0, lastY: e.clientY, scroll0: scrollTopOf(scroller), scroller };
    dragging.current = key;
    setDragKey(key);
    const id = e.pointerId;
    let raf = 0;

    // Near an edge of the scroll area, scroll towards it (faster the closer), re-tracking each frame.
    const autoScroll = () => {
      const g = grab.current;
      if (!g) return;
      const area = g.scroller ? g.scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const y = g.lastY;
      const dy = y < area.top + EDGE ? -Math.ceil(((area.top + EDGE - y) / EDGE) * MAX_SPEED) : y > area.bottom - EDGE ? Math.ceil(((y - (area.bottom - EDGE)) / EDGE) * MAX_SPEED) : 0;
      if (dy) {
        if (g.scroller) g.scroller.scrollTop += dy;
        else window.scrollBy(0, dy);
        track(y);
      }
      raf = requestAnimationFrame(autoScroll);
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (ev.cancelable) ev.preventDefault();
      track(ev.clientY);
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      finish();
    };
    // The page must not scroll under the finger while a row is held (older Safari ignores touch-action alone).
    const holdPage = (ev: TouchEvent) => {
      if (ev.cancelable) ev.preventDefault();
    };
    const finish = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("touchmove", holdPage);
      stopDrag.current = null;
      const k = dragging.current;
      const el = k ? rows().find((r) => r.dataset.sortKey === k) : null;
      if (el) {
        el.style.transition = "transform 150ms ease";
        el.style.transform = "";
      }
      grab.current = null;
      dragging.current = null;
      setDragKey(null);
    };
    stopDrag.current = finish;
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("touchmove", holdPage, { passive: false });
    raf = requestAnimationFrame(autoScroll);
  };

  return (
    <ol ref={listRef} className={cn("relative divide-y divide-line/70 overflow-hidden rounded-lg border border-line bg-surface", dragKey && "select-none", className)}>
      {items.map((item, i) => {
        const key = keyOf(item);
        const held = dragKey === key;
        return (
          <li key={key} data-sort-key={key} className={cn("flex items-center gap-2 bg-surface px-2.5 py-1.5 text-[13px] will-change-transform", held && "relative z-[1] rounded-lg bg-brand-50 shadow-[0_6px_18px_rgba(0,0,0,0.14)] ring-1 ring-brand-200", itemClassName)}>
            {!disabled && (
              <button
                type="button"
                onPointerDown={(e) => startDrag(e, key)}
                className={cn("tap shrink-0 touch-none rounded-md p-1 text-ink-subtle hover:bg-canvas hover:text-ink", held ? "cursor-grabbing" : "cursor-grab")}
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
