"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { pushModal, useBackdropClose } from "@/components/ui/use-modal-chrome";
import { useLatest } from "@/lib/use-latest";

interface ConfirmOpts {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "brand";
}
interface PromptOpts {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  type?: "text" | "password";
  minLength?: number;
}

interface DialogState {
  kind: "confirm" | "prompt";
  opts: ConfirmOpts & PromptOpts;
  resolve: (v: boolean | string | null) => void;
}

const DialogCtx = createContext<{
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  prompt: (o: PromptOpts) => Promise<string | null>;
}>({
  confirm: async () => false,
  prompt: async () => null,
});

export function useDialog() {
  return useContext(DialogCtx);
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DialogState | null>(null);
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  // What had focus when the dialog opened — captured BEFORE the dialog's own
  // autoFocus steals it, so closing puts the keyboard user back where they were.
  const openerRef = useRef<HTMLElement | null>(null);

  // A dialog raised while one is open replaces it: settle the first promise
  // as "cancelled" so its caller never hangs.
  const confirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => {
        openerRef.current = document.activeElement as HTMLElement | null;
        setErr("");
        setValue("");
        setState((prev) => {
          prev?.resolve(prev.kind === "prompt" ? null : false);
          return { kind: "confirm", opts, resolve: resolve as (v: boolean | string | null) => void };
        });
      }),
    []
  );

  const prompt = useCallback(
    (opts: PromptOpts) =>
      new Promise<string | null>((resolve) => {
        openerRef.current = document.activeElement as HTMLElement | null;
        setErr("");
        setValue(opts.defaultValue || "");
        setState((prev) => {
          prev?.resolve(prev.kind === "prompt" ? null : false);
          return { kind: "prompt", opts, resolve: resolve as (v: boolean | string | null) => void };
        });
      }),
    []
  );

  const finish = useCallback(
    (result: boolean | string | null) => {
      state?.resolve(result);
      setState(null);
      setValue("");
      setErr("");
      openerRef.current?.focus?.({ preventScroll: true });
      openerRef.current = null;
    },
    [state]
  );

  const onCancel = useCallback(() => finish(state?.kind === "prompt" ? null : false), [finish, state]);
  // Selection-safe outside-click: only a press that starts AND ends on the
  // backdrop cancels — drag-selecting the message can't dismiss the dialog.
  const backdrop = useBackdropClose(onCancel);

  const onConfirm = useCallback(() => {
    if (state?.kind === "prompt") {
      const min = state.opts.minLength ?? 0;
      if (value.length < min) {
        setErr(`Must be at least ${min} characters.`);
        return;
      }
      finish(value);
    } else {
      finish(true);
    }
  }, [state, value, finish]);

  // Memoized context value: this provider wraps the WHOLE app and re-renders
  // on every keystroke in a prompt — a fresh `{confirm, prompt}` literal
  // pushed a new context identity to every useDialog consumer on screen
  // (e.g. each Team member row) per keystroke. confirm/prompt are stable.
  const ctx = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);

  // Handlers live in refs so the chrome effect binds ONCE per dialog
  // lifetime: onConfirm is recreated on every keystroke (it closes over
  // `value`), and keying the effect on it re-ran the whole teardown/setup —
  // document listener churn plus a double body-overflow write per typed
  // character. Same pattern as useModalChrome's onCloseRef.
  const onCancelRef = useLatest(onCancel);
  const onConfirmRef = useLatest(onConfirm);
  useEffect(() => {
    if (!state) return;
    // Escape and Tab come through the shared modal stack (top layer only).
    const unregister = pushModal({ id: "confirm-dialog", panel: () => panelRef.current, onEscape: () => onCancelRef.current() });
    function onKey(e: KeyboardEvent) {
      // Enter confirms ONLY from the prompt's input. A document-wide Enter
      // would confirm even when the user has tabbed to Cancel and presses
      // Enter there — the opposite of what they chose.
      if (e.key === "Enter" && state?.kind === "prompt" && (e.target as HTMLElement)?.tagName === "INPUT") onConfirmRef.current();
    }
    // Browser Back / phone back gesture while a confirm is up: the page is
    // about to change underneath it, so it cancels rather than lingering
    // over a different screen with a live destructive button.
    const onPop = () => onCancelRef.current();
    document.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
      unregister();
    };
  }, [state, onCancelRef, onConfirmRef]);

  return (
    <DialogCtx.Provider value={ctx}>
      {children}
      {state && (
        <div
          // Stacking order for the whole panel: page-level dialogs z-[100] <
          // AI-reasoning popover z-[105]/z-[110] < THIS z-[120] < toasts
          // z-[300]. confirm()/prompt() is the one surface that can be raised
          // FROM inside another dialog — a destructive action in the team sheet,
          // say — so it has to sit above every one of them. At its previous
          // z-50 it would have opened silently behind that sheet.
          className="fixed inset-0 z-[120] flex items-end justify-center overscroll-contain bg-ink/55 sm:items-center sm:p-4"
          {...backdrop}
        >
          <div
            ref={panelRef}
            // Bottom sheet on phones, centred card from sm up — the same
            // treatment every other modal in the panel uses.
            // sm:max-w-sm, not max-w-sm: as a BOTTOM SHEET the panel has to reach
            // both edges. Capped at 384px it sat 3px shy of a 390px phone, leaving
            // a sliver of scrim down each side under the rounded top corners. The
            // cap still applies from sm up, where it is a centred card.
            className="w-full animate-slide-up rounded-t-2xl border border-line/80 bg-surface p-6 shadow-pop ring-1 ring-ink/5 sm:max-w-sm sm:animate-scale-in sm:rounded-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={state.opts.title}
          >
            <h3 className="text-base font-semibold tracking-[-0.01em] text-ink">{state.opts.title}</h3>
            {state.opts.message && <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{state.opts.message}</p>}

            {state.kind === "prompt" && (
              <Input
                type={state.opts.type || "text"}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setErr("");
                }}
                placeholder={state.opts.placeholder}
                autoFocus
                className="mt-3.5"
              />
            )}
            {err && <p className="mt-2 text-xs text-red-600">{err}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={onCancel}>
                {state.opts.cancelLabel || "Cancel"}
              </Button>
              <Button
                variant={state.opts.tone === "danger" ? "danger" : "primary"}
                size="sm"
                onClick={onConfirm}
                autoFocus={state.kind === "confirm"}
              >
                {state.opts.confirmLabel || "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </DialogCtx.Provider>
  );
}
