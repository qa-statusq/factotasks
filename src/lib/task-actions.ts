"use client";

import { mutate, mutateWhere, revalidatePrefix } from "@/lib/client-cache";
import { postJson } from "@/lib/http";
import { STATUS_META, type TaskStatus } from "@/lib/domain";
import type { TaskCard } from "@/lib/types";

/** Walk any cached payload and swap a task card wherever it appears
 * (lists, dashboard sections, meeting packs, the detail page). */
function replaceCard(data: unknown, card: TaskCard): unknown {
  if (Array.isArray(data)) {
    let changed = false;
    const out = data.map((x) => {
      const n = replaceCard(x, card);
      if (n !== x) changed = true;
      return n;
    });
    return changed ? out : data;
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (o.id === card.id && "number" in o && "status" in o) return { ...o, ...card };
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      const n = replaceCard(v, card);
      if (n !== v) changed = true;
      out[k] = n;
    }
    return changed ? out : data;
  }
  return data;
}

/** Paint a card everywhere it is cached. Used after every task write. */
export function applyTaskCard(card: TaskCard) {
  for (const p of ["/api/tasks", "/api/dashboard", "/api/meetings"]) mutateWhere(p, (d) => replaceCard(d, card));
}

/** Everything a task write can be painted on, refreshed in the background. */
export function refreshTaskViews() {
  revalidatePrefix("/api/tasks");
  revalidatePrefix("/api/dashboard");
  revalidatePrefix("/api/meetings/");
  revalidatePrefix("/api/releases");
  mutate("/api/notifications?limit=1");
}

interface StatusResult {
  ok: boolean;
  /** "applied" | "requested" */
  mode?: string;
  error?: string;
  task?: TaskCard;
}

/**
 * Change a task's status with an OPTIMISTIC repaint: the row flips before the
 * request returns; the server's card replaces it on success; on failure the
 * previous card is restored. `isAdmin`/`needsApproval` decide whether the
 * optimistic state is the new status or a pending request.
 */
export async function changeTaskStatus(task: TaskCard, to: TaskStatus, opts: { note?: string | null; optimisticRequest?: boolean }): Promise<StatusResult> {
  const now = new Date().toISOString();
  const optimistic: TaskCard = opts.optimisticRequest
    ? { ...task, requested_status: to, requested_at: now }
    : { ...task, status: to, status_since: now, requested_status: null, requested_at: null, request_note: null, requested_by: null, completed_at: to === "done" ? now : task.completed_at };
  applyTaskCard(optimistic);
  const { ok, data } = await postJson<{ task?: TaskCard; mode?: string; error?: string }>(`/api/tasks/${task.id}/status`, { status: to, note: opts.note ?? null });
  if (ok && data?.task) {
    applyTaskCard(data.task);
    refreshTaskViews();
    return { ok: true, mode: data.mode, task: data.task };
  }
  applyTaskCard(task); // roll back to what we had…
  refreshTaskViews(); // …and let the server say what is true now
  return { ok: false, error: data?.error || "Couldn't change the status" };
}

export function statusToast(res: StatusResult, to: TaskStatus): string {
  if (!res.ok) return res.error || "Couldn't change the status";
  return res.mode === "requested" ? `Sent for approval → ${STATUS_META[to].label}` : `Marked ${STATUS_META[to].label}`;
}

/** Approve / reject / withdraw with the same optimistic treatment. */
export async function reviewTask(task: TaskCard, action: "approve" | "reject" | "withdraw", note?: string | null): Promise<StatusResult> {
  const to = task.requested_status;
  const optimistic: TaskCard =
    action === "approve" && to
      ? { ...task, status: to, requested_status: null, requested_at: null, request_note: null, requested_by: null, completed_at: to === "done" ? task.requested_at : task.completed_at }
      : { ...task, requested_status: null, requested_at: null, request_note: null, requested_by: null };
  applyTaskCard(optimistic);
  const { ok, data } = await postJson<{ task?: TaskCard; mode?: string; error?: string }>(`/api/tasks/${task.id}/review`, { action, note: note ?? null });
  if (ok && data?.task) {
    applyTaskCard(data.task);
    refreshTaskViews();
    return { ok: true, mode: data.mode, task: data.task };
  }
  applyTaskCard(task);
  return { ok: false, error: data?.error || "Couldn't update the request" };
}
