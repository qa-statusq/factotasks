/**
 * Browser-compatibility layer. The panel gets used from old office machines
 * (Windows 7/8-era Chrome caps at 109, old Safari, locked-down enterprise
 * profiles) — every helper here feature-detects a modern API and degrades to
 * an equivalent behavior instead of crashing or silently doing nothing.
 * Client-side code must go through these; server code (Node 18+) may use the
 * native APIs directly.
 */

/**
 * `AbortSignal.timeout(ms)` needs Chrome 103 / Safari 16 / Firefox 100.
 * Before that, the direct call is a TypeError thrown BEFORE fetch even
 * starts — which took down every data load in the panel on old browsers.
 * Fallback builds the same one-shot signal from AbortController (Chrome 66+);
 * on anything older still, an untimed fetch beats a crash.
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  if (typeof AbortController !== "undefined") {
    const c = new AbortController();
    // Held for the duration exactly like the native implementation holds its
    // internal timer; aborting an already-settled fetch is a no-op.
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }
  return undefined;
}

/** ScrollToOptions/ScrollIntoViewOptions support tracks `scrollBehavior` in
 * style — the one reliable detect for the whole options-object family. */
const supportsScrollOptions = () =>
  typeof document !== "undefined" && "scrollBehavior" in document.documentElement.style;

/**
 * Smooth-scroll the window to the top. Old Safari (< 15.4) treats
 * `scrollTo({top, behavior})` as a SILENT NO-OP — the scroll-to-top button
 * did nothing there. Degrade to an instant jump, which always works.
 */
export function smoothScrollToTop(): void {
  if (supportsScrollOptions()) window.scrollTo({ top: 0, behavior: "smooth" });
  else window.scrollTo(0, 0);
}

/**
 * `el.scrollIntoView({block:"nearest"})` on engines without options support
 * coerces the object to `alignToTop = truthy` and YANKS the page so the
 * element tops the viewport — jarring for a keyboard-nav dropdown or a tab
 * strip. Fallback reproduces "nearest" by hand: nudge each scrollable
 * ancestor only as far as needed to bring the element into its box.
 */
export function scrollIntoViewNearest(el: HTMLElement): void {
  if (supportsScrollOptions()) {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    return;
  }
  // Inner scrollers only — never the window: both call sites (dropdown menu,
  // tab strip) scroll a contained box, and nudging documentElement/body would
  // fire the page-level scroll listeners some overlays close on.
  let parent = el.parentElement;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    const canY = parent.scrollHeight > parent.clientHeight;
    const canX = parent.scrollWidth > parent.clientWidth;
    if (canY || canX) {
      const pr = parent.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (canY) {
        if (er.top < pr.top) parent.scrollTop -= pr.top - er.top;
        else if (er.bottom > pr.bottom) parent.scrollTop += er.bottom - pr.bottom;
      }
      if (canX) {
        if (er.left < pr.left) parent.scrollLeft -= pr.left - er.left;
        else if (er.right > pr.right) parent.scrollLeft += er.right - pr.right;
      }
    }
    parent = parent.parentElement;
  }
}

/**
 * Copy text to the clipboard, resolving `true` only on confirmed success so
 * callers can toast honestly. Tries the async Clipboard API (secure context +
 * Chrome 66/Safari 13.1), then the legacy hidden-textarea + execCommand path
 * that works everywhere back to ancient Chrome — including http:// intranet
 * hosts where `navigator.clipboard` doesn't exist at all.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* permission denied / flaky driver — fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    const prevFocus = document.activeElement as HTMLElement | null;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    prevFocus?.focus?.({ preventScroll: true });
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------- per-tab key/value memory ------------------------ */

/**
 * MEMORY-FIRST per-tab storage with a sessionStorage mirror. Chrome's "block
 * cookies and site data" setting (and some enterprise policies) makes every
 * sessionStorage ACCESS throw — on such machines the scroll/dialog position
 * memory silently died and Back always landed at the top of the page. All SPA
 * navigation is same-document, so a module-scoped Map survives every route
 * change no matter what the storage policy says; sessionStorage is only the
 * mirror that lets positions additionally survive a full reload.
 */
const mem = new Map<string, string>();

export function tabMemGet(key: string): string | null {
  const v = mem.get(key);
  if (v !== undefined) return v;
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function tabMemSet(key: string, value: string): void {
  mem.set(key, value);
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* mirror only — the Map above is the source of truth this session */
  }
}

export function tabMemRemove(key: string): void {
  mem.delete(key);
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Keys under this prefix survive tabMemClear(). Reserved for tab-scoped
 * bookkeeping that must outlive a sign-out — currently only the session-death
 * loop guard, which exists precisely to survive the teardown navigation it
 * triggers. Never put user data here. */
export const TAB_MEM_KEEP_PREFIX = "facto:keep:";

/**
 * Wipe per-tab memory — sign-out hygiene, so the next user of the machine
 * inherits nothing (scroll offsets, dialog state, the cached-response
 * snapshot). This is the client half of what a `Clear-Site-Data: "storage"`
 * response header used to do; doing it here is instant and synchronous,
 * whereas the header makes Chrome BLOCK the response until it has purged the
 * whole origin — which is what made sign-out take seconds (and time out) on
 * some machines. Safe because the panel uses no localStorage or IndexedDB, and
 * the only service worker (public/sw.js) caches exactly one static file —
 * /offline.html, zero user data: sessionStorage is the entire per-user client
 * footprint.
 */
export function tabMemClear(): void {
  for (const k of Array.from(mem.keys())) if (!k.startsWith(TAB_MEM_KEEP_PREFIX)) mem.delete(k);
  try {
    // Collect first, then remove: removing during the walk reindexes the store
    // and would silently skip every other key.
    const doomed: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && !k.startsWith(TAB_MEM_KEEP_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) sessionStorage.removeItem(k);
  } catch {
    /* storage blocked by policy — the Map above was the source of truth anyway */
  }
}
