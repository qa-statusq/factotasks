import type { AppRole, Department, NoteKind, Platform, Priority, ReleaseStatus, TaskStatus, TaskType } from "./domain";

/** Shape returned by the SQL `user_brief()` helper — one consistent person
 * object everywhere (assignees, authors, approvers, directory rows). */
export interface UserBrief {
  id: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  color: string;
  department: Department;
  is_active: boolean;
}

export interface AppLite {
  id: string;
  name: string;
  color: string;
  /** Main tile (Android first, else iOS). */
  icon_url?: string | null;
  /** The Play icon and the App Store artwork, shown where that platform is meant. */
  icon_android_url?: string | null;
  icon_ios_url?: string | null;
  has_android?: boolean;
  has_ios?: boolean;
}

export interface ReleaseLite {
  id: string;
  version_name: string;
  platform: "android" | "ios";
  status: ReleaseStatus;
  planned_date?: string | null;
}

/** One place a task ships: an app on a platform, through its own release. */
export interface TaskTarget {
  app: AppLite;
  platform: "android" | "ios";
  release: ReleaseLite | null;
  released_at: string | null;
}

/** Shape returned by the SQL `task_card()` helper (lists, dashboard, MOM). */
export interface TaskCard {
  id: string;
  number: number;
  title: string;
  /** First 600 chars (lists, meeting deck). The detail page has the full text. */
  description?: string | null;
  status: TaskStatus;
  priority: Priority;
  type: TaskType;
  platform: Platform | null;
  due_date: string | null;
  labels: string[];
  created_at: string;
  updated_at: string;
  status_since: string;
  started_at: string | null;
  completed_at: string | null;
  approved_at: string | null;
  active_seconds: number;
  estimate_hours: number | null;
  requested_status: TaskStatus | null;
  requested_at: string | null;
  request_note: string | null;
  requested_by: UserBrief | null;
  app: AppLite | null;
  /** Attached to a meeting series: shows on that series' meetings until done. */
  series: { id: string; name: string; color: string } | null;
  /** Every app × platform the task must land on; empty = general task. */
  targets: TaskTarget[];
  release_progress: { released: number; total: number };
  assignees: UserBrief[];
  created_by: UserBrief | null;
  comment_count: number;
  attachment_count: number;
  /** MOM only: how many earlier meetings this pending task has been through. */
  carry?: number;
  /** Pinned to the meeting by hand (meeting packs only). */
  pinned?: boolean;
}

export interface StatusLogEntry {
  id: string;
  kind: "change" | "request" | "approve" | "reject" | "withdraw";
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  note: string | null;
  created_at: string;
  actor: UserBrief | null;
}

export interface TaskComment {
  id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
  author: UserBrief | null;
}

export interface TaskAttachment {
  id: string;
  file_name: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  created_at: string;
  uploaded_by: UserBrief | null;
}

export interface TaskMeetingLink {
  id: string;
  title: string;
  held_at: string;
  status: "open" | "finalized";
  series: { name: string; color: string } | null;
}

export interface TaskMeetingNote {
  id: string;
  kind: NoteKind;
  body: string;
  link_url: string | null;
  link_label: string | null;
  created_at: string;
  author: UserBrief | null;
  meeting: { id: string; title: string; held_at: string };
}

/** Full task for the detail screen: the card plus everything hanging off it. */
export interface TaskDetail extends TaskCard {
  description: string | null;
  approved_by: UserBrief | null;
  log: StatusLogEntry[];
  comments: TaskComment[];
  attachments: TaskAttachment[];
  meeting_notes: TaskMeetingNote[];
  /** Meetings this task is pinned to, newest first. */
  meetings: TaskMeetingLink[];
  /** What THIS caller may do (computed server-side from the real rules). */
  can: { edit: boolean; delete: boolean; status: boolean; approve: boolean };
}

export interface AppOverview {
  id: string;
  name: string;
  description: string | null;
  kind: "b2c" | "b2b";
  status: "active" | "maintenance" | "archived";
  has_android: boolean;
  has_ios: boolean;
  android_package: string | null;
  ios_bundle_id: string | null;
  appstore_url: string | null;
  color: string;
  icon_url: string | null;
  icon_android_url?: string | null;
  icon_ios_url?: string | null;
  /** Hand-arranged position (Apps → Arrange); lists arrive sorted by it. */
  sort_order?: number;
  created_at: string;
  updated_at: string;
  open_tasks: number;
  in_progress: number;
  overdue: number;
  done_week: number;
  members: { user: UserBrief; app_role: AppRole }[];
  latest_android: { id: string; version_name: string; released_at: string | null } | null;
  latest_ios: { id: string; version_name: string; released_at: string | null } | null;
  next_release: { id: string; version_name: string; platform: "android" | "ios"; status: ReleaseStatus; planned_date: string | null } | null;
}

export interface Release {
  id: string;
  app_id: string;
  platform: "android" | "ios";
  version_name: string;
  build_number: string | null;
  status: ReleaseStatus;
  planned_date: string | null;
  released_at: string | null;
  description: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: UserBrief | null;
  app?: AppLite;
  task_count?: number;
  done_count?: number;
  /** Tasks linked to this version (lite), newest number last. */
  tasks?: ReleaseTaskLite[];
  /** A member asked for "released" and an admin hasn't decided yet. */
  requested_status: "released" | null;
  requested_by: UserBrief | null;
  requested_at: string | null;
  request_note: string | null;
}

export interface ReleaseTaskLite {
  id: string;
  number: number;
  title: string;
  status: TaskStatus;
  description?: string | null;
  /** When this version shipped the task's target (null until released). */
  released_at?: string | null;
}

export interface TeamMember extends UserBrief {
  role: "admin" | "member";
  title: string | null;
  created_at: string;
  /** Admin-only facts; absent for members. */
  last_login_at?: string | null;
  must_change_password?: boolean;
  open?: number;
  in_progress?: number;
  overdue?: number;
  done_week?: number;
  apps: { id: string; name: string; color: string; icon_url?: string | null; app_role: AppRole }[];
}

export interface DashboardPack {
  counts: {
    my_open: number;
    my_in_progress: number;
    my_due_week: number;
    my_overdue: number;
    my_awaiting: number;
    my_done_week: number;
    team_open: number;
    team_in_progress: number;
    team_on_hold: number;
    team_overdue: number;
    team_done_week: number;
    approvals: number;
  };
  my_tasks: TaskCard[];
  approvals: TaskCard[];
  due_soon: TaskCard[];
  recent_done: TaskCard[];
  releases: {
    id: string;
    app: AppLite;
    platform: "android" | "ios";
    version_name: string;
    status: ReleaseStatus;
    planned_date: string | null;
    released_at: string | null;
  }[];
}

export interface MeetingSeries {
  id: string;
  name: string;
  color: string;
  /** Default scope for new meetings of this series; empty = every app. */
  app_ids: string[];
  /** Presentation order of apps (ids); unlisted apps follow alphabetically. */
  app_order?: string[];
  /** (021) Meetings of the series close by themselves after their day. */
  auto_close?: boolean;
  /** (021) Team members who take part (admins only see this). */
  member_ids?: string[];
  created_at?: string;
  /** Rollups from the list endpoint. */
  meeting_count?: number;
  last_held_at?: string | null;
  open_meeting_id?: string | null;
}

export interface Meeting {
  id: string;
  title: string;
  held_at: string;
  notes: string | null;
  status: "open" | "finalized";
  finalized_at: string | null;
  created_at: string;
  created_by?: UserBrief | null;
  note_count?: number;
  series_id?: string | null;
  series?: { id: string; name: string; color: string } | null;
  /** (021) null = follow the series' auto_close. */
  auto_close?: boolean | null;
  /** Scope: empty = every app. */
  app_ids?: string[];
}

export interface MeetingNote {
  id: string;
  task_id: string | null;
  kind: NoteKind;
  body: string;
  /** A finding, document or ticket behind the note; opens in a new tab. */
  link_url: string | null;
  /** Button text for the link; "Click here" when empty. */
  link_label: string | null;
  created_at: string;
  author: UserBrief | null;
  about: UserBrief | null;
  task: { id: string; number: number; title: string; status: TaskStatus } | null;
}

/** A screen + mic recording of a presented meeting, stored on the team's Google Shared Drive. */
export interface Recording {
  id: string;
  meeting_id: string;
  name: string;
  mime: string;
  size_bytes: number;
  duration_sec: number | null;
  status: "uploading" | "ready" | "failed";
  drive_file_id: string | null;
  created_at: string;
  updated_at: string;
  recorder: UserBrief | null;
  meeting: { id: string; title: string; held_at: string; status: "open" | "finalized"; series: { id: string; name: string; color: string } | null } | null;
  /** E-mail addresses given access (only sent to people who may manage it). */
  shares: RecordingShare[];
}

export interface RecordingShare {
  id: string;
  email: string;
  message: string | null;
  created_at: string;
  sharer: UserBrief | null;
}

export interface MeetingPack {
  meeting: Meeting;
  series: { id: string; name: string; color: string; app_order?: string[] } | null;
  /** Ids of tasks pinned to this meeting. */
  pinned: string[];
  window: { from: string; to: string };
  previous_meeting: string | null;
  done: TaskCard[];
  pending: TaskCard[];
  /** Ids of pending tasks carried from an earlier meeting / created this window / past due. */
  carried: string[];
  new: string[];
  overdue: string[];
  approvals: TaskCard[];
  releases: (DashboardPack["releases"][number] & { build_number: string | null; description: string | null; tasks?: TaskCard[] })[];
  people: (UserBrief & { done: number; pending: number; in_progress: number; carried: number; overdue: number })[];
  apps: { id: string; name: string; color: string; icon_url?: string | null; has_android: boolean; has_ios: boolean; done: number; pending: number; carried: number }[];
  notes: MeetingNote[];
}

export interface Notification {
  id: string;
  kind: string;
  task_id: string | null;
  message: string;
  read_at: string | null;
  created_at: string;
  actor: UserBrief | null;
  task: { id: string; number: number; title: string } | null;
}

export interface Me {
  id: string;
  email: string;
  role: "admin" | "member";
  first_name: string | null;
  last_name: string | null;
  department: Department;
  title: string | null;
  color: string;
  /** Small UI preferences, per person (see lib/use-pref). */
  prefs?: Record<string, string | number | boolean>;
  /** (021) Meeting series this person takes part in (members); admins see every series anyway. */
  series_ids?: string[];
}
