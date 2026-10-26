"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { IconCheck, IconAlert, IconX, IconBell } from "@/components/ui/icons";

type ToastType = "success" | "error" | "info";
interface Toast {
  id: number;
  message: string;
  type: ToastType;
  detail?: string;
  /** How long it stays, in ms (drives the progress rail). */
  ttl: number;
  /** Exit phase: the card plays its leave animation, then unmounts. */
  leaving?: boolean;
}

const ToastCtx = createContext<{ toast: (m: string, t?: ToastType, detail?: string) => void }>({
  toast: () => {},
});

export function useToast() {
  return useContext(ToastCtx);
}

const EXIT_MS = 220;

/**
 * Feedback cards, bottom-right (full width on phones). Ink card on the light
 * UI so it never blends into the page; a coloured icon disc says what kind,
 * a thin rail drains for as long as it stays, and it can be dismissed early.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Map<number, number[]>());
  // "type|message" → id of that toast while it is on screen: the same message twice in a row
  // (a double-fired handler, two sources reporting one failure) is one message, not two.
  const shown = useRef(new Map<string, number>());

  const dismiss = useCallback((id: number) => {
    for (const t of timers.current.get(id) || []) window.clearTimeout(t);
    timers.current.delete(id);
    for (const [sig, v] of shown.current) if (v === id) shown.current.delete(sig);
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), EXIT_MS);
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = "success", detail?: string) => {
      const sig = `${type}|${message}`;
      if (shown.current.has(sig)) return;
      const id = ++counter.current;
      shown.current.set(sig, id);
      // Longer messages, and errors, deserve a longer look.
      const ttl = Math.min(8000, Math.max(type === "error" ? 4500 : 3000, (message.length + (detail?.length ?? 0)) * 45));
      // Keep at most 4 visible — a burst of errors must not stack unbounded.
      setToasts((t) => {
        for (const old of t.slice(0, -3)) for (const [s, v] of shown.current) if (v === old.id) shown.current.delete(s);
        return [...t.slice(-3), { id, message, type, detail, ttl }];
      });
      const leave = window.setTimeout(() => dismiss(id), ttl);
      timers.current.set(id, [leave]);
    },
    [dismiss]
  );

  // Stable context value so showing/auto-dismissing a toast doesn't re-render
  // the entire app tree under this top-level provider.
  const ctx = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastCtx.Provider value={ctx}>
      {children}
      {/* aria-live so screen readers announce feedback; errors are assertive. */}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[300] flex flex-col items-center gap-2 sm:inset-x-0 sm:bottom-5 sm:mx-auto sm:w-[380px]">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.type === "error" ? "alert" : "status"}
            className={cn("pointer-events-auto relative w-full overflow-hidden rounded-xl bg-[#1c1c1a] text-white shadow-[0_18px_40px_-12px_rgba(0,0,0,0.45),0_0_0_1px_rgba(255,255,255,0.06)]", t.leaving ? "animate-toast-out" : "animate-toast-in")}
          >
            <div className="flex items-start gap-3 py-3 pl-3.5 pr-2">
              <span className={cn("mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-full", t.type === "success" && "bg-emerald-400/20 text-emerald-300", t.type === "error" && "bg-red-400/20 text-red-300", t.type === "info" && "bg-white/10 text-white/80")}>
                {t.type === "error" ? <IconAlert size={15} /> : t.type === "info" ? <IconBell size={15} /> : <IconCheck size={15} />}
              </span>
              <div className="min-w-0 flex-1 pt-1">
                <div className="break-words text-[13.5px] font-semibold leading-snug">{t.message}</div>
                {t.detail && <div className="mt-0.5 break-words text-[12.5px] leading-relaxed text-white/65">{t.detail}</div>}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} className="shrink-0 rounded-md p-1.5 text-white/45 transition-colors hover:bg-white/10 hover:text-white" aria-label="Dismiss">
                <IconX size={14} />
              </button>
            </div>
            {/* Time-left rail */}
            <div className="h-[2px] w-full bg-white/10">
              <div className={cn("h-full origin-left animate-toast-rail", t.type === "success" && "bg-emerald-400", t.type === "error" && "bg-red-400", t.type === "info" && "bg-white/60")} style={{ animationDuration: `${t.ttl}ms` }} />
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
