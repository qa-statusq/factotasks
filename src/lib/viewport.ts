/**
 * Anchored popovers are position:fixed and written in CSS pixels, but
 * getBoundingClientRect() and innerWidth/innerHeight report real viewport
 * pixels. On 2K/4K screens the panel scales <html> with `zoom`, so the two
 * differ by that factor and a menu placed from raw rect values lands beside
 * its trigger. Everything that positions a floating element reads through
 * here, in CSS pixels.
 */
export function zoomFactor(): number {
  if (typeof document === "undefined") return 1;
  const z = Number((getComputedStyle(document.documentElement) as CSSStyleDeclaration & { zoom?: string }).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  /** The viewport, in the same CSS pixels. */
  vw: number;
  vh: number;
  zoom: number;
}

/** An element's rectangle and the viewport size, both in CSS pixels. */
export function anchorRect(el: Element): AnchorRect {
  const z = zoomFactor();
  const b = el.getBoundingClientRect();
  return { left: b.left / z, top: b.top / z, right: b.right / z, bottom: b.bottom / z, width: b.width / z, height: b.height / z, vw: window.innerWidth / z, vh: window.innerHeight / z, zoom: z };
}
