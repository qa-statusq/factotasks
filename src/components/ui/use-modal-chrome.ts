"use client";

import { useCallback, useEffect, useId, useRef, useSyncExternalStore } from "react";
import { tabMemGet, tabMemSet, tabMemRemove } from "@/lib/compat";
import { useLatest } from "@/lib/use-latest";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab / Shift+Tab cycling inside the dialog panel. aria-modal tells screen
 * readers the page behind is inert, but the browser's own tab order doesn't
 * honour it — without this, tabbing walks out of the dialog into the page.
 */
export function trapTabKey(panel: HTMLElement, e: KeyboardEvent) {
  if (e.key !== "Tab") return;
  const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // offsetParent is null for display:none subtrees (collapsed accordions etc.)
    (el) => el.offsetParent !== null
  );
  if (items.length === 0) {
    e.preventDefault();
    panel.focus({ preventScroll: true });
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

/* ---------------------------------------------------------------------------
 * The modal stack. Sheets and confirm()/prompt() dialogs can stack (a confirm
 * raised from inside a sheet, an Edit sheet over a view sheet). One document
 * listener serves the TOP entry only, so Escape closes one layer at a time,
 * Tab cycles inside the top panel, and the page scroll lock is a count —
 * never a "restore what I saw" that the wrong layer puts back.
 * ------------------------------------------------------------------------- */
interface ModalEntry {
  id: string;
  panel: () => HTMLElement | null;
  onEscape: () => void;
}
const modalStack: ModalEntry[] = [];
let scrollLockDepth = 0;
let savedOverflow = "";
let listening = false;
function onStackKey(e: KeyboardEvent) {
  const top = modalStack[modalStack.length - 1];
  if (!top) return;
  if (e.key === "Escape") top.onEscape();
  else if (e.key === "Tab") {
    const panel = top.panel();
    if (panel) trapTabKey(panel, e);
  }
}
/** Register a modal layer; returns the unregister function. */
export function pushModal(entry: ModalEntry): () => void {
  modalStack.push(entry);
  if (scrollLockDepth++ === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  if (!listening) {
    // Bubble phase on purpose: popovers (status menu, dropdown, date picker,
    // people picker) handle Escape in the CAPTURE phase and stop it, so an
    // open popover closes itself first and the sheet under it stays.
    document.addEventListener("keydown", onStackKey);
    listening = true;
  }
  return () => {
    const i = modalStack.findIndex((m) => m.id === entry.id);
    if (i >= 0) modalStack.splice(i, 1);
    if (--scrollLockDepth <= 0) {
      scrollLockDepth = 0;
      document.body.style.overflow = savedOverflow;
    }
  };
}
export function isTopModal(id: string): boolean {
  return modalStack[modalStack.length - 1]?.id === id;
}

/** Set right before a `router.push` that CLOSES a sheet ("Create & open",
 * "New meeting"): the sheet's history entry is then stripped in place instead
 * of popped, so the pop can't race the navigation and cancel it. */
let navigatingAway = false;
export function closeForNavigation() {
  navigatingAway = true;
  window.setTimeout(() => {
    navigatingAway = false;
  }, 1000);
}

/** True while a popstate (browser Back / back gesture) is being dispatched.
 * A dirty-form guard reads it: Back means "leave", so no "discard?" prompt. */
let inPopstate = false;
if (typeof window !== "undefined") {
  window.addEventListener(
    "popstate",
    () => {
      inPopstate = true;
      window.setTimeout(() => {
        inPopstate = false;
      }, 0);
    },
    true
  );
}
export const isHandlingPopstate = () => inPopstate;

/**
 * Shared modal-chrome behavior for full dialogs/sheets: close on Escape, lock
 * the page scroll behind the dialog, and — when given the panel's ref — manage
 * keyboard focus properly: move focus into the dialog on open, keep Tab cycling
 * inside it, and hand focus back to whatever opened it on close.
 * Was copy-pasted in three modals before; one hook keeps them identical.
 */
export function useModalChrome(onClose: () => void, panelRef?: React.RefObject<HTMLElement | null>) {
  // Every consumer passes a render-scoped closure as onClose. Keying the effect
  // on it made the WHOLE chrome tear down and re-run on every parent re-render
  // while the modal was open (a background revalidation was enough): cleanup
  // focused the opener BEHIND the modal, setup snapped focus back to the panel
  // root — discarding wherever the keyboard user had tabbed to. The closure
  // lives in a ref instead; the effect runs once per modal lifetime.
  const onCloseRef = useLatest(onClose);
  // One history entry per dialog lifetime (survives Strict Mode's double effect).
  const modalId = useId();
  const hist = useRef<{ id: string; pushed: boolean; closing: number | null }>({ id: `m${modalId}`, pushed: false, closing: null });
  useEffect(() => {
    // Remember what opened the dialog so Escape/close returns the keyboard user
    // exactly where they were (the card/button they activated).
    const opener = document.activeElement as HTMLElement | null;
    panelRef?.current?.focus({ preventScroll: true });
    const unregister = pushModal({ id: hist.current.id, panel: () => panelRef?.current ?? null, onEscape: () => onCloseRef.current() });

    // Back-stack: every open dialog is one history entry, so the browser's
    // Back (or the phone's back gesture) closes the TOP dialog only — never
    // the page behind it, never a dialog underneath. Closing through the UI
    // pops our entry so Back isn't left pointing at a ghost.
    // Dev Strict Mode runs this effect twice (mount → cleanup → mount): the
    // entry is kept across that bounce via `hist` so it is pushed once and
    // popped once.
    const h = hist.current;
    if (h.closing !== null) {
      // Re-mount right after a cleanup (Strict Mode): keep the entry.
      window.clearTimeout(h.closing);
      h.closing = null;
    } else if (!h.pushed) {
      const prevState = window.history.state;
      window.history.pushState({ ...(prevState && typeof prevState === "object" ? prevState : {}), __modal: h.id }, "");
      h.pushed = true;
    }
    function onPop() {
      // Still on our own entry (a dialog ABOVE us was popped): ignore.
      if ((window.history.state as { __modal?: string } | null)?.__modal === h.id) return;
      h.pushed = false;
      onCloseRef.current();
    }
    window.addEventListener("popstate", onPop);

    return () => {
      unregister();
      window.removeEventListener("popstate", onPop);
      opener?.focus?.({ preventScroll: true });
      // Closing because we are about to navigate: leave history alone except
      // for the marker, so the pop can't land after the push and undo it.
      if (navigatingAway && h.pushed && (window.history.state as { __modal?: string } | null)?.__modal === h.id) {
        navigatingAway = false; // consumed by this one close
        const { __modal: _m, ...rest } = window.history.state as Record<string, unknown>;
        window.history.replaceState(rest, "");
        h.pushed = false;
        return;
      }
      // Closed from the UI while our entry is on top → step back over it,
      // but only if this really is an unmount and not a Strict Mode bounce.
      // If a navigation already replaced the entry (e.g. "Create & open"),
      // the marker is gone and history is left alone.
      if (h.pushed && (window.history.state as { __modal?: string } | null)?.__modal === h.id) {
        h.closing = window.setTimeout(() => {
          h.closing = null;
          if (h.pushed && (window.history.state as { __modal?: string } | null)?.__modal === h.id) {
            h.pushed = false;
            window.history.back();
          }
        }, 0);
      }
    };
    // Both are stable ref objects (panelRef from the caller, onCloseRef from
    // useLatest), so listing them keeps this effect running exactly once per
    // modal lifetime — which is the whole reason onClose lives in a ref.
  }, [panelRef, onCloseRef]);
}

/** Fired after this module mutates the URL via pushState/replaceState, so every
 * useDialogParam subscriber re-reads the location in the same tab. popstate
 * covers browser Back/Forward; this covers our own programmatic changes. */
const URL_CHANGE_EVT = "facto:urlchange";

/**
 * HOW the current dialog param entered the URL: a fresh forward open() in this
 * tab, vs a history traversal (Back/Forward popstate) or an initial page load.
 * Dialog position memory (dialogUiMemory) must be consumed ONLY on traversals —
 * the standard restoration contract: Back/Forward/reload return the user where
 * they were; a NEW open always starts clean. Clearing on the CLOSE side cannot
 * enforce this: the browser Back button closes dialogs without running any
 * close handler, and a navigate-away that never comes Back leaves the memory
 * behind to resurrect much later (both shipped as bugs).
 */
let freshDialogOpen = false;
if (typeof window !== "undefined") {
  // Any traversal invalidates "fresh open" — including the back() that our own
  // close() issues.
  window.addEventListener("popstate", () => {
    freshDialogOpen = false;
  });
}
/** True when the dialog mounting right now was opened by open() in this tab —
 * i.e. NOT resurrected by Back/Forward/reload. Call at dialog mount to decide
 * whether saved section/scroll memory may be restored (no) or must be
 * discarded (yes). CONSUMES the flag: a fresh-open answer is valid for exactly
 * one mount, so a hypothetical later remount-while-open can't wrongly discard
 * the memory again (StrictMode's double run is safe — the second call takes
 * the restore branch against just-cleared memory, same clean outcome). */
export function isFreshDialogOpen(): boolean {
  const fresh = freshDialogOpen;
  freshDialogOpen = false;
  return fresh;
}

/** Subscribe to every URL change this app can make: browser Back/Forward
 * (popstate) and our own pushState/replaceState (URL_CHANGE_EVT). Exported so a
 * component can read window.location through useSyncExternalStore instead of
 * poking at it inside an effect. */
export function subscribeUrl(cb: () => void) {
  window.addEventListener("popstate", cb);
  window.addEventListener(URL_CHANGE_EVT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(URL_CHANGE_EVT, cb);
  };
}

/**
 * Sync a dialog's open state with a URL query param so the browser's Back
 * button behaves the way users expect:
 *   - opening the dialog pushes `?<param>=<value>` as a history entry, so
 *     pressing Back with the dialog open simply closes it;
 *   - navigating away from inside the dialog (e.g. clicking a review) and
 *     pressing Back returns to the URL WITH the param — the dialog reopens
 *     exactly where it was (pair with per-dialog scroll restore);
 *   - closing via ✕/backdrop/Escape pops the entry the open pushed; a fresh
 *     tab landing directly on the param URL strips it in place instead, so
 *     Back can never throw the user off the site.
 *
 * The param is read STRAIGHT from window.location through a
 * useSyncExternalStore subscription (popstate + our own change event) — never
 * through Next's useSearchParams. Next does not reliably re-render on native
 * history.pushState in production, which left the URL changed but the dialog
 * closed (and un-closable after a refresh). The server snapshot is null, so
 * SSR/hydration match and a ?param URL opens the dialog right after mount.
 * Returns [value, open, close]; `value` is null while the dialog is closed.
 */
export function useDialogParam(param: string) {
  // Did THIS page visit push the history entry? Refreshing keeps history.state
  // (browsers persist it), so the `dlg` marker also survives reloads — between
  // the two, close() knows when Back is safe vs. when to strip in place.
  const pushedRef = useRef(false);
  // history.back() is ASYNC — until the traversal lands, the URL still holds
  // the param, so a second close() (Escape key auto-repeat, a fast ✕
  // double-click) passed every guard and queued a SECOND back(), popping the
  // page entry underneath and throwing the user off the screen. This latch
  // makes close() a no-op while a pop is in flight; it re-arms when the URL
  // actually changes.
  const closingRef = useRef(false);
  const value = useSyncExternalStore(
    subscribeUrl,
    () => new URLSearchParams(window.location.search).get(param),
    () => null
  );
  useEffect(() => {
    closingRef.current = false; // URL settled (param changed/cleared) — re-arm
  }, [value]);
  const open = useCallback(
    (v: string = "1") => {
      const url = new URL(window.location.href);
      if (url.searchParams.get(param) === v) return;
      url.searchParams.set(param, v);
      window.history.pushState({ ...window.history.state, dlg: param }, "", url);
      pushedRef.current = true;
      freshDialogOpen = true; // a NEW open — saved dialog memory must not restore
      window.dispatchEvent(new Event(URL_CHANGE_EVT));
    },
    [param]
  );
  const close = useCallback(() => {
    if (closingRef.current) return; // a back() is already in flight
    const url = new URL(window.location.href);
    if (!url.searchParams.get(param)) return;
    if (pushedRef.current || window.history.state?.dlg === param) {
      // We're on the entry the open pushed — pop it (popstate re-renders).
      pushedRef.current = false;
      closingRef.current = true;
      window.history.back();
    } else {
      // Shared link / fresh tab: no known previous entry — strip in place.
      url.searchParams.delete(param);
      window.history.replaceState(window.history.state, "", url);
      window.dispatchEvent(new Event(URL_CHANGE_EVT));
    }
  }, [param]);
  return [value, open, close] as const;
}

/**
 * Remember a dialog's internal position (open accordion section + scrollTop)
 * across a navigate-away-and-Back round trip, in tab memory (module Map with
 * a sessionStorage mirror — see lib/compat.ts: raw sessionStorage throws on
 * machines whose Chrome blocks site data, which silently killed dialog
 * position memory there). `save` is cheap enough to call from onScroll.
 * Consumption is gated by isFreshDialogOpen(): only a history traversal
 * (Back/Forward/reload) may restore; a fresh open() clears instead — never
 * clear in close handlers (the browser Back button closes dialogs without
 * running them).
 */
export function dialogUiMemory(key: string) {
  return {
    read(): { openKey?: string | null; top?: number } | null {
      try {
        return JSON.parse(tabMemGet(key) || "null");
      } catch {
        return null; // corrupt mirror — treat as no memory
      }
    },
    save(openKey: string | null, top: number) {
      tabMemSet(key, JSON.stringify({ openKey, top }));
    },
    clear() {
      tabMemRemove(key);
    },
  };
}

/**
 * Backdrop-close handlers that never eat a text selection. A plain
 * onClick={onClose} backdrop closes the dialog when a drag-select that STARTED
 * inside the panel ends over the backdrop — the click event fires on the common
 * ancestor (the backdrop), so copying a review's text slammed the dialog shut.
 * Close only when the press both started AND ended on the backdrop itself.
 * Spread the returned props onto the backdrop element.
 */
export function useBackdropClose(onClose: () => void) {
  const armed = useRef(false);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      armed.current = e.target === e.currentTarget;
    },
    onClick: (e: React.MouseEvent) => {
      if (armed.current && e.target === e.currentTarget) onClose();
      armed.current = false;
    },
  };
}
