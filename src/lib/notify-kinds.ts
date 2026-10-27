/**
 * The kinds of notification the panel sends, grouped the way people choose what
 * reaches their devices (Profile → Browser notifications). The in-app Inbox
 * always keeps everything; these choices only decide which ones also push.
 * Shared by the server (filtering pushes) and the Profile screen (the switches).
 */
export const NOTIFY_CATEGORIES = [
  { key: "assigned", label: "Assigned to me", hint: "A task is given to you", kinds: ["task.assigned"], urgent: true },
  { key: "approvals", label: "Approvals", hint: "Requests waiting for you, and decisions on yours", kinds: ["task.requested", "release.requested", "task.approved", "task.rejected", "release.rejected"], urgent: true },
  { key: "comments", label: "Comments and meeting notes", hint: "Someone comments, attaches a file or notes something on your task", kinds: ["task.comment", "task.attachment", "task.mom", "meeting.note"], urgent: true },
  { key: "reminders", label: "Due-date reminders", hint: "Your open task is due tomorrow or overdue", kinds: ["task.due"], urgent: true },
  { key: "status", label: "Status changes on my tasks", hint: "Someone else moves or removes a task you are on", kinds: ["task.status", "task.deleted"], urgent: false },
  { key: "releases", label: "Releases of my apps", hint: "A version of an app you work on ships", kinds: ["release.released"], urgent: false },
] as const;

export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number]["key"];

const BY_KIND = new Map<string, (typeof NOTIFY_CATEGORIES)[number]>();
for (const c of NOTIFY_CATEGORIES) for (const k of c.kinds) BY_KIND.set(k, c);

/** The category a notification kind belongs to (unknown kinds count as urgent, on by default). */
export function categoryOf(kind: string): { key: string; urgent: boolean } {
  const c = BY_KIND.get(kind);
  return c ? { key: c.key, urgent: c.urgent } : { key: "other", urgent: true };
}

/** The users.prefs key that turns a category's pushes off when set to false. */
export const notifyPrefKey = (category: string) => `notify.${category}`;
