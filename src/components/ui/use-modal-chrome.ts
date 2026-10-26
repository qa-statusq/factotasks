"use client";

import { useEffect, useId, useRef } from "react";
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
/** Set right before a `router.push` that CLOSES a sheet ("Create & open",
 * "New meeting"): the sheet's history entry is then stripped in place instead
 * of popped, so the pop can't race the navigation and cancel it. */
let navigatingAway = false;
let navigatingTimer = 0;
export function closeForNavigation() {
  navigatingAway = true;
  // Long enough for a slow phone to commit the navigation; consumed by the
  // first dialog that closes, so it never lingers in practice.
  window.clearTimeout(navigatingTimer);
  navigatingTimer = window.setTimeout(() => {
    navigatingAway = false;
  }, 10_000);
}

// Any in-app link activated while a dialog (or the phone's navigation drawer)
// is open is a navigation out of that dialog: mark it BEFORE the click
// bubbles, so the dialog's closing never pops the history entry the router is
// about to push. Without this, on a phone, tapping "Tasks" in the drawer
// closed the drawer, the pop cancelled the push, and nothing opened.
if (typeof document !== "undefined") {
  document.addEventListener(
    "click",
    (e) => {
      if (!modalStack.length || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      let url: URL;
      try {
        url = new URL(a.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return; // same page: the close is a plain close
      closeForNavigation();
    },
    true
  );
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
