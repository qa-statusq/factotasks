import type { SessionUser } from "./auth";

/** The minimal task facts the permission rules need. */
export interface TaskOwnership {
  created_by: string | null;
  status: string;
  assignee_ids: string[];
}

/**
 * The ONE place that decides what a caller may do with a task. Every route and
 * the detail payload's `can` block go through these, so the UI can never show
 * a control the server would refuse (and vice versa).
 */
export const isAdmin = (u: SessionUser) => u.role === "admin";

const isInvolved = (u: SessionUser, t: TaskOwnership) => t.created_by === u.uid || t.assignee_ids.includes(u.uid);

/** Edit title/description/priority/assignees/due/labels/app/release. */
export const canEditTask = (u: SessionUser, t: TaskOwnership) => isAdmin(u) || isInvolved(u, t);

/** Move the status (directly or via an approval request). */
export const canChangeStatus = (u: SessionUser, t: TaskOwnership) => isAdmin(u) || isInvolved(u, t);

/** Approve / reject a pending request. */
export const canApprove = (u: SessionUser) => isAdmin(u);

/** Delete: admins only — a member's task stays on record even if they made it by mistake (they can cancel it). */
export const canDeleteTask = (u: SessionUser, _t: TaskOwnership) => isAdmin(u);
