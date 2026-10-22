"use client";

import { useCallback } from "react";
import { useDialog } from "@/components/ui/dialog";
import { isHandlingPopstate } from "@/components/ui/use-modal-chrome";

/** Deep-enough equality for form values: scalars, arrays (order-free for ids), plain objects. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a == null || a === "") && (b == null || b === "")) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const key = (x: unknown) => (typeof x === "object" && x ? JSON.stringify(x, Object.keys(x as object).sort()) : String(x));
    const as = a.map(key).sort();
    const bs = b.map(key).sort();
    return as.every((x, i) => x === bs[i]);
  }
  if (a && b && typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** Wraps a sheet's onClose: when the form has unsaved edits, a confirm stands
 * between an accidental Escape / scrim click and losing the text. */
export function useDiscardGuard(dirty: boolean, onClose: () => void): () => void {
  const { confirm } = useDialog();
  return useCallback(() => {
    // Browser Back already popped the sheet's entry: leaving is the intent.
    if (!dirty || isHandlingPopstate()) return onClose();
    void confirm({ title: "Discard your changes?", message: "What you typed here hasn't been saved.", confirmLabel: "Discard", tone: "danger" }).then((ok) => {
      if (ok) onClose();
    });
  }, [dirty, onClose, confirm]);
}
