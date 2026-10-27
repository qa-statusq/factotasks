/**
 * The panel's shared vocabulary — statuses, priorities, platforms, departments
 * — with their labels and tones. Pure (no environment access) so it is safe
 * to import from both server routes (validation) and client screens (rendering).
 * Every allowed value here MUST match the CHECK constraints in
 * supabase/schema.sql; the database is the final gate, this is the first.
 */
import { WORK_DAY_SECONDS } from "./work-time";

export type Tone = "neutral" | "brand" | "success" | "warning" | "info" | "danger";

/* ----------------------------- task status ----------------------------- */

export const TASK_STATUSES = ["todo", "in_progress", "in_review", "on_hold", "partial", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_META: Record<TaskStatus, { label: string; tone: Tone; dot: string; hint: string }> = {
  todo: { label: "To do", tone: "neutral", dot: "bg-slate-400", hint: "Not started yet" },
  in_progress: { label: "In progress", tone: "info", dot: "bg-blue-500", hint: "Being worked on right now" },
  in_review: { label: "In review", tone: "info", dot: "bg-violet-500", hint: "Waiting for code review / QA" },
  on_hold: { label: "On hold", tone: "warning", dot: "bg-amber-500", hint: "Blocked or paused" },
  partial: { label: "Partly released", tone: "info", dot: "bg-teal-500", hint: "Shipped on some apps/platforms, pending on others" },
  done: { label: "Done", tone: "success", dot: "bg-emerald-500", hint: "Completed" },
  cancelled: { label: "Cancelled", tone: "danger", dot: "bg-red-400", hint: "Will not be done" },
};

/** Statuses that count as "open" / pending work. */
export const OPEN_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "in_review", "on_hold", "partial"];
export const isTaskStatus = (s: unknown): s is TaskStatus => typeof s === "string" && (TASK_STATUSES as readonly string[]).includes(s);

/* ------------------------------ priority ------------------------------- */

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_META: Record<Priority, { label: string; tone: Tone; rank: number }> = {
  urgent: { label: "Urgent", tone: "danger", rank: 0 },
  high: { label: "High", tone: "warning", rank: 1 },
  medium: { label: "Medium", tone: "info", rank: 2 },
  low: { label: "Low", tone: "neutral", rank: 3 },
};

/* -------------------------------- type --------------------------------- */

export const TASK_TYPES = ["feature", "bug", "improvement", "design", "qa", "release", "research", "marketing", "other"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TYPE_META: Record<TaskType, { label: string }> = {
  feature: { label: "Feature" },
  bug: { label: "Bug" },
  improvement: { label: "Improvement" },
  design: { label: "Design" },
  qa: { label: "QA / Testing" },
  release: { label: "Release" },
  research: { label: "Research" },
  marketing: { label: "Marketing" },
  other: { label: "Other" },
};

/* ------------------------------ platforms ------------------------------ */

export const PLATFORMS = ["android", "ios", "both"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_META: Record<Platform, { label: string; short: string }> = {
  android: { label: "Android", short: "Android" },
  ios: { label: "iOS", short: "iOS" },
  both: { label: "Android + iOS", short: "Both" },
};

/* ----------------------------- departments ----------------------------- */

export const DEPARTMENTS = ["android", "ios", "flutter", "design", "qa", "backend", "web", "marketing", "management", "other"] as const;
export type Department = (typeof DEPARTMENTS)[number];
export const DEPARTMENT_META: Record<Department, { label: string }> = {
  android: { label: "Android" },
  ios: { label: "iOS" },
  flutter: { label: "Flutter / cross-platform" },
  design: { label: "Design" },
  qa: { label: "QA" },
  backend: { label: "Backend" },
  web: { label: "Web" },
  marketing: { label: "Marketing" },
  management: { label: "Management" },
  other: { label: "Other" },
};

/* ------------------------------ app roles ------------------------------ */

export const APP_ROLES = ["lead", "developer", "designer", "qa", "backend", "marketing", "other"] as const;
export type AppRole = (typeof APP_ROLES)[number];
export const APP_ROLE_META: Record<AppRole, { label: string }> = {
  lead: { label: "Lead" },
  developer: { label: "Developer" },
  designer: { label: "Designer" },
  qa: { label: "QA" },
  backend: { label: "Backend" },
  marketing: { label: "Marketing" },
  other: { label: "Other" },
};

/** The part someone plays on an app follows their department, so adding them asks nothing more. */
export function appRoleForDepartment(d: string | null | undefined): AppRole {
  switch (d) {
    case "android":
    case "ios":
    case "flutter":
    case "web":
      return "developer";
    case "design":
      return "designer";
    case "qa":
      return "qa";
    case "backend":
      return "backend";
    case "marketing":
      return "marketing";
    case "management":
      return "lead";
    default:
      return "other";
  }
}

/* ------------------------------- releases ------------------------------ */

export const RELEASE_STATUSES = ["planned", "in_progress", "testing", "submitted", "released", "rolled_back", "cancelled"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
export const RELEASE_STATUS_META: Record<ReleaseStatus, { label: string; tone: Tone }> = {
  planned: { label: "Planned", tone: "neutral" },
  in_progress: { label: "In progress", tone: "brand" },
  testing: { label: "Testing", tone: "info" },
  submitted: { label: "Submitted to store", tone: "warning" },
  released: { label: "Released", tone: "success" },
  rolled_back: { label: "Rolled back", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/* ------------------------------- MOM notes ----------------------------- */

export const NOTE_KINDS = ["note", "decision", "action", "blocker"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_KIND_META: Record<NoteKind, { label: string; tone: Tone }> = {
  note: { label: "Note", tone: "neutral" },
  decision: { label: "Decision", tone: "brand" },
  action: { label: "Action item", tone: "info" },
  blocker: { label: "Blocker", tone: "danger" },
};

/* ------------------------------ people colors -------------------------- */

/** Avatar palette: 12 hues that stay distinguishable side by side and keep
 * white initials readable. Assigned round-robin at invite time. */
export const USER_COLORS = [
  "#4f46e5", "#0ea5e9", "#059669", "#d97706", "#dc2626", "#7c3aed",
  "#db2777", "#0d9488", "#65a30d", "#ea580c", "#2563eb", "#9333ea",
] as const;

/** App tile palette (a touch deeper than the people palette). */
export const APP_COLORS = [
  "#4f46e5", "#0891b2", "#16a34a", "#ca8a04", "#e11d48", "#7c3aed", "#0f766e", "#c2410c", "#1d4ed8", "#be185d",
] as const;

/* ------------------------------ limits ---------------------------------- */

export const LIMITS = {
  title: 160,
  description: 8000,
  comment: 4000,
  note: 2000,
  noteLink: 2000,
  noteLinkLabel: 60,
  label: 24,
  labelsPerTask: 10,
  assigneesPerTask: 10,
  appName: 60,
  appDescription: 2000,
  versionName: 40,
  buildNumber: 40,
  releaseText: 6000,
  meetingTitle: 120,
  meetingNotes: 20000,
  userTitle: 80,
  attachmentBytes: 15 * 1024 * 1024,
  attachmentsPerTask: 25,
} as const;

/* ------------------------------ helpers -------------------------------- */

/** Human task reference: T-123. */
export const taskRef = (n: number | string) => `T-${n}`;

/**
 * A WORKING duration (see lib/work-time): "3d 4h", "2h 15m", "45m", "<1m",
 * where 1d is one 9-hour working day — the way Jira writes logged work.
 */
export function formatDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return s === 0 ? "0m" : "<1m";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const dayH = WORK_DAY_SECONDS / 3600;
  if (h < dayH) return mm ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / dayH);
  const hh = h % dayH;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}
