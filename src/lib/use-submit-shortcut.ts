"use client";

import { useEffect } from "react";
import { useLatest } from "./use-latest";

/**
 * Ctrl/Cmd+Enter submits a sheet from ANYWHERE inside it — a dropdown button,
 * the people picker, the panel itself right after it opened — not only from
 * a text field inside the <form>. Listens on the document while mounted, so
 * it works regardless of where keyboard focus sits.
 */
export function useSubmitShortcut(submit: () => void, enabled = true) {
  const ref = useLatest(submit);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.repeat) {
        e.preventDefault();
        ref.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, ref]);
}
