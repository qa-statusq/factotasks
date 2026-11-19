"use client";

import { useEffect, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * A picture you can zoom and move like in a photos app.
 *
 *   - Pinch with two fingers (phone / tablet) — zooms around the fingers and
 *     follows them as they move.
 *   - Mouse wheel / trackpad scroll or trackpad pinch (computer) — zooms
 *     around the pointer.
 *   - Double-tap / double-click — zooms in to that spot, or back out to fit.
 *   - Drag (one finger or the mouse) — moves the picture while zoomed.
 *   - Swipe left / right while NOT zoomed — the previous / next file.
 *   - The parent's +, −, Fit buttons and keys call the handle.
 *
 * The model: the <img> keeps the picture's real pixel size and is placed by
 * ONE transform, translate(tx, ty) scale(s) with origin 0 0, so a point p
 * of the picture shows at t + s·p. Zooming around a screen point a keeps the
 * picture point under a fixed: t' = a − (a − t)·(s'/s). After every change
 * the picture is kept on screen: smaller than the stage → centred on that
 * axis; bigger → its edges can't come inside the stage. s runs from "fit"
 * (whole picture visible, never enlarged past its real size) to 4 (400% of
 * the real pixels). Gestures write the transform directly (no re-render per
 * frame); `will-change` is only on while a gesture runs, so the browser
 * redraws the picture sharp at the final zoom.
 */
export interface ZoomHandle {
  /** Multiply the zoom around the stage's centre. */
  zoomBy: (k: number) => void;
  /** Back to the whole picture. */
  fit: () => void;
  /** Actual pixels (100%), or back to fit when already there. */
  toggleActual: () => void;
}

const MAX = 4;
const TAP_MS = 260;
const DOUBLE_MS = 320;

export function ZoomableImage({ src, alt, handle, onZoom, onSwipe, className }: {
  src: string;
  alt: string;
  handle?: React.Ref<ZoomHandle>;
  /** Current zoom (1 = actual pixels) and whether it is at "fit". */
  onZoom?: (scale: number, atFit: boolean) => void;
  /** -1 previous, 1 next — only when the picture isn't zoomed. */
  onSwipe?: (dir: -1 | 1) => void;
  className?: string;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // Everything a frame needs, kept out of React state.
  const v = useRef({ nw: 0, nh: 0, W: 0, H: 0, fit: 1, s: 1, tx: 0, ty: 0, ready: false });
  const raf = useRef(0);
  const anim = useRef(0);
  /** Where a running eased zoom is heading (so quick + + + presses add up instead of restarting). */
  const target = useRef<{ s: number; ax: number; ay: number } | null>(null);
  // Pointers: one drags (or swipes / taps), two pinch.
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const g = useRef({ mode: "none" as "none" | "pan" | "pinch", sx: 0, sy: 0, stx: 0, sty: 0, t0: 0, moved: false, d0: 1, s0: 1, mx: 0, my: 0, ptx: 0, pty: 0, pinched: false });
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const onZoomRef = useRef(onZoom);
  const onSwipeRef = useRef(onSwipe);
  useEffect(() => {
    onZoomRef.current = onZoom;
    onSwipeRef.current = onSwipe;
  });

  const paint = () => {
    raf.current = 0;
    const img = imgRef.current;
    const st = v.current;
    if (!img || !st.ready) return;
    img.style.transform = `translate3d(${st.tx}px, ${st.ty}px, 0) scale(${st.s})`;
    const atFit = st.s <= st.fit * 1.001;
    if (stageRef.current) stageRef.current.style.cursor = g.current.mode === "pan" && !atFit ? "grabbing" : atFit ? (st.fit < 1 ? "zoom-in" : "default") : "grab";
    onZoomRef.current?.(st.s, atFit);
  };
  const schedule = () => {
    if (!raf.current) raf.current = requestAnimationFrame(paint);
  };
  /** Keep the picture on screen (centred on an axis where it is smaller than the stage). */
  const clamp = () => {
    const st = v.current;
    const sw = st.nw * st.s;
    const sh = st.nh * st.s;
    st.tx = sw <= st.W ? (st.W - sw) / 2 : Math.min(0, Math.max(st.W - sw, st.tx));
    st.ty = sh <= st.H ? (st.H - sh) / 2 : Math.min(0, Math.max(st.H - sh, st.ty));
  };
  const limit = (s: number) => Math.min(Math.max(MAX, v.current.fit), Math.max(v.current.fit, s));
  /** Zoom to s keeping the picture point under (ax, ay) — stage coordinates — where it is. */
  const zoomAt = (s: number, ax: number, ay: number) => {
    const st = v.current;
    const next = limit(s);
    const k = next / st.s;
    st.tx = ax - (ax - st.tx) * k;
    st.ty = ay - (ay - st.ty) * k;
    st.s = next;
    clamp();
    schedule();
  };
  /** The same as zoomAt, eased over ~200 ms (double-tap, buttons, keys). */
  const animateTo = (s: number, ax: number, ay: number) => {
    const st = v.current;
    cancelAnimationFrame(anim.current);
    const from = { s: st.s, tx: st.tx, ty: st.ty };
    zoomAt(s, ax, ay); // compute the end state…
    const to = { s: st.s, tx: st.tx, ty: st.ty };
    Object.assign(st, from); // …then travel there
    target.current = { s: to.s, ax, ay };
    const t0 = performance.now();
    const img = imgRef.current;
    if (img) img.style.willChange = "transform";
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / 200);
      const e = 1 - Math.pow(1 - p, 3);
      st.s = from.s + (to.s - from.s) * e;
      st.tx = from.tx + (to.tx - from.tx) * e;
      st.ty = from.ty + (to.ty - from.ty) * e;
      paint();
      if (p < 1) anim.current = requestAnimationFrame(step);
      else {
        target.current = null;
        if (img) img.style.willChange = "";
      }
    };
    anim.current = requestAnimationFrame(step);
  };
  const toFit = () => {
    const st = v.current;
    animateTo(st.fit, st.W / 2, st.H / 2);
  };

  useImperativeHandle(handle, () => ({
    zoomBy: (k) => animateTo((target.current?.s ?? v.current.s) * k, v.current.W / 2, v.current.H / 2),
    fit: toFit,
    toggleActual: () => {
      const st = v.current;
      if (Math.abs(st.s - 1) < 0.01 || st.fit >= 1) toFit();
      else animateTo(1, st.W / 2, st.H / 2);
    },
  }));

  // Measure the picture and the stage; lay out at "fit"; follow stage resizes (rotation, full screen).
  useEffect(() => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!stage || !img) return;
    const st = v.current;
    const measure = () => {
      const r = stage.getBoundingClientRect();
      if (!r.width || !r.height || !st.nw) return;
      const wasFit = !st.ready || st.s <= st.fit * 1.001;
      // The picture point at the stage's centre stays at the centre.
      const cx = st.ready ? (st.W / 2 - st.tx) / st.s : st.nw / 2;
      const cy = st.ready ? (st.H / 2 - st.ty) / st.s : st.nh / 2;
      st.W = r.width;
      st.H = r.height;
      st.fit = Math.min(1, st.W / st.nw, st.H / st.nh);
      st.s = wasFit ? st.fit : limit(st.s);
      st.tx = st.W / 2 - cx * st.s;
      st.ty = st.H / 2 - cy * st.s;
      st.ready = true;
      clamp();
      paint();
    };
    const onLoad = () => {
      st.nw = img.naturalWidth;
      st.nh = img.naturalHeight;
      st.ready = false;
      measure();
      img.style.opacity = "1";
    };
    if (img.complete && img.naturalWidth) onLoad();
    img.addEventListener("load", onLoad);
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => {
      img.removeEventListener("load", onLoad);
      ro.disconnect();
      cancelAnimationFrame(raf.current);
      cancelAnimationFrame(anim.current);
    };
  }, [src]);

  // Wheel / trackpad: must be a non-passive listener to stop the page from scrolling or zooming.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!v.current.ready) return;
      cancelAnimationFrame(anim.current);
      target.current = null;
      const r = stage.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * r.height : e.deltaY;
      // A trackpad pinch arrives as ctrl+wheel with small steps: make it as direct as the fingers.
      const k = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002));
      zoomAt(v.current.s * k, e.clientX - r.left, e.clientY - r.top);
    };
    // Safari's own pinch gesture events would zoom the whole page.
    const stop = (e: Event) => e.preventDefault();
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("gesturestart", stop);
    stage.addEventListener("gesturechange", stop);
    return () => {
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("gesturestart", stop);
      stage.removeEventListener("gesturechange", stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoomAt only reads refs
  }, []);


  const local = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startPan = (p: { x: number; y: number }) => {
    const st = v.current;
    Object.assign(g.current, { mode: "pan", sx: p.x, sy: p.y, stx: st.tx, sty: st.ty });
  };
  const startPinch = () => {
    const [a, b] = [...pts.current.values()];
    const st = v.current;
    Object.assign(g.current, { mode: "pinch", d0: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), s0: st.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ptx: st.tx, pty: st.ty, pinched: true, moved: true });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!v.current.ready || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.stopPropagation();
    stageRef.current?.setPointerCapture(e.pointerId);
    cancelAnimationFrame(anim.current);
    target.current = null;
    const p = local(e);
    pts.current.set(e.pointerId, p);
    if (imgRef.current) imgRef.current.style.willChange = "transform";
    if (pts.current.size === 1) {
      Object.assign(g.current, { t0: performance.now(), moved: false, pinched: false });
      startPan(p);
    } else if (pts.current.size === 2) startPinch();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return;
    const p = local(e);
    pts.current.set(e.pointerId, p);
    const st = v.current;
    const gs = g.current;
    if (gs.mode === "pinch" && pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()];
      const s = limit(gs.s0 * (Math.hypot(b.x - a.x, b.y - a.y) / gs.d0));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      // The picture point that was under the fingers' midpoint stays under it, wherever the midpoint goes.
      st.tx = mx - (gs.mx - gs.ptx) * (s / gs.s0);
      st.ty = my - (gs.my - gs.pty) * (s / gs.s0);
      st.s = s;
      clamp();
      schedule();
      return;
    }
    if (gs.mode === "pan") {
      const dx = p.x - gs.sx;
      const dy = p.y - gs.sy;
      if (Math.abs(dx) + Math.abs(dy) > 6) g.current.moved = true;
      if (st.s > st.fit * 1.001) {
        st.tx = gs.stx + dx;
        st.ty = gs.sty + dy;
        clamp();
        schedule();
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return;
    const p = local(e);
    pts.current.delete(e.pointerId);
    const gs = g.current;
    const st = v.current;
    if (pts.current.size === 1) {
      // Lifting one finger of a pinch: carry on as a drag from where the other finger is — no jump.
      startPan([...pts.current.values()][0]);
      return;
    }
    if (pts.current.size > 1) {
      startPinch();
      return;
    }
    g.current.mode = "none";
    if (imgRef.current) imgRef.current.style.willChange = "";
    if (e.type === "pointercancel") return;
    const dx = p.x - gs.sx;
    const dy = p.y - gs.sy;
    const quick = performance.now() - gs.t0 < TAP_MS;
    if (!gs.moved && !gs.pinched && quick) {
      // A tap: two in a row near each other zoom in there, or back out.
      const lt = lastTap.current;
      if (performance.now() - lt.t < DOUBLE_MS && Math.hypot(p.x - lt.x, p.y - lt.y) < 30) {
        lastTap.current = { t: 0, x: 0, y: 0 };
        if (st.s > st.fit * 1.05) toFit();
        else animateTo(Math.max(st.fit * 2.5, Math.min(1, MAX)), p.x, p.y);
      } else lastTap.current = { t: performance.now(), x: p.x, y: p.y };
      return;
    }
    // A swipe while the whole picture shows: previous / next.
    if (!gs.pinched && st.s <= st.fit * 1.001 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipeRef.current?.(dx < 0 ? 1 : -1);
  };

  return (
    <div
      ref={stageRef}
      className={cn("relative h-full w-full touch-none select-none overflow-hidden", className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // Touch events would reach a presentation behind and turn its slides.
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        className="pointer-events-none absolute left-0 top-0 max-w-none origin-top-left opacity-0 transition-opacity duration-150"
      />
    </div>
  );
}
