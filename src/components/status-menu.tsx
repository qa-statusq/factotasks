"use client";

import { usePolicyMode, willRequestStatus } from "@/lib/use-policy";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/components/providers/session-provider";
import { changeTaskStatus, statusToast } from "@/lib/task-actions";
import { STATUS_META, TASK_STATUSES, type TaskStatus } from "@/lib/domain";
import { IconChevronDown } from "@/components/ui/icons";
import type { TaskCard } from "@/lib/types";

/**
 * The one control that moves a task: a status pill that opens a menu. One
 * click, instant repaint (optimistic), toast on the result. Members get the
 * same control — a move that needs approval shows as "→ Done (pending)".
 * Portaled so it never gets clipped inside a scrolling list.
 */
export function StatusMenu({ task, size = "sm", className, canChange = true }: { task: TaskCard; size?: "sm" | "md"; className?: string; canChange?: boolean }) {
  const mode = usePolicyMode();
  const { toast } = useToast();
  const { isAdmin } = useSession();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const m = STATUS_META[task.status];
  const pending = task.requested_status;

  useEffect(() => {
    if (!open) return;
    const b = btnRef.current?.getBoundingClientRect();
    if (b) {
      const up = window.innerHeight - b.bottom < 280 && b.top > 280;
      setPos({ left: Math.min(b.left, window.innerWidth - 200), top: up ? b.top - 6 : b.bottom + 6, up });
    }
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  async function pick(to: TaskStatus) {
    setOpen(false);
    if (to === task.status && !pending) return;
    setBusy(true);
    const willRequest = !isAdmin && willRequestStatus(mode, to);
    const res = await changeTaskStatus(task, to, { optimisticRequest: willRequest });
    setBusy(false);
    toast(statusToast(res, to), res.ok ? "success" : "error");
  }

  const pill = (
    <button
      ref={btnRef}
      type="button"
      disabled={!canChange || busy}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOpen((o) => !o);
      }}
      aria-haspopup="listbox"
      aria-expanded={open}
      title={pending ? `Waiting for approval → ${STATUS_META[pending].label}` : canChange ? "Change status" : m.hint}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium ring-1 ring-inset transition-[background-color,box-shadow,transform] duration-150",
        size === "sm" ? "h-6 px-2 text-[11.5px]" : "h-8 px-3 text-sm",
        toneClass(task.status),
        canChange && "hover:brightness-95 active:scale-[0.97]",
        busy && "opacity-60",
        className
      )}
    >
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", m.dot)} />
        <span className="truncate">{m.label}</span>
        {pending && (
          <span className="ml-0.5 rounded-full bg-amber-100/80 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-amber-800" title={`${STATUS_META[pending].label} requested — waiting for an admin`}>
            {STATUS_META[pending].label} requested
          </span>
        )}
      </span>
      {canChange && <IconChevronDown size={11} className="ml-auto shrink-0 opacity-60" />}
    </button>
  );

  return (
    <>
      {pill}
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            style={{ position: "fixed", left: pos.left, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
            className="z-[200] w-48 animate-scale-in rounded-xl border border-line/80 bg-surface p-1 shadow-pop ring-1 ring-ink/5"
            onClick={(e) => e.stopPropagation()}
          >
            {TASK_STATUSES.filter((s) => s !== "partial" || s === task.status).map((s) => (
              <button
                key={s}
                type="button"
                role="option"
                aria-selected={s === task.status}
                onClick={() => pick(s)}
                className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-canvas", s === task.status && "font-semibold text-ink")}
              >
                <span className={cn("h-2 w-2 rounded-full", STATUS_META[s].dot)} />
                {STATUS_META[s].label}
                {!isAdmin && willRequestStatus(mode, s) && <span className="ml-auto text-[10px] text-ink-subtle">needs approval</span>}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}

export function toneClass(status: TaskStatus): string {
  switch (status) {
    case "in_progress":
      return "bg-blue-50 text-blue-700 ring-blue-200";
    case "in_review":
      return "bg-violet-50 text-violet-700 ring-violet-200";
    case "on_hold":
      return "bg-amber-50 text-amber-700 ring-amber-200";
    case "partial":
      return "bg-teal-50 text-teal-700 ring-teal-200";
    case "done":
      return "bg-emerald-50 text-emerald-700 ring-emerald-200";
    case "cancelled":
      return "bg-red-50 text-red-600 ring-red-200";
    default:
      return "bg-slate-100 text-slate-700 ring-slate-200";
  }
}
