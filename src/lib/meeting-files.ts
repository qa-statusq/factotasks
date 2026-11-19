import { getSupabase } from "./supabase";
import { loadMeeting } from "./meetings";
import { canAccessMeeting } from "./series-access";
import { USER_BRIEF_COLS, embeddedUser } from "./users";
import type { SessionUser } from "./auth";
import type { MeetingFile } from "./types";
import { cleanLine, isUuid } from "./validate";

/**
 * Files on a meeting (034): kept on the team's Shared Drive in the "Meeting
 * files" folder, shown on the meeting page and in its presentation. The
 * people who can open the meeting (admins and the people of its series) can
 * see them and add more; a file is removed by whoever added it, or an admin —
 * the same rule as task files.
 */
export const MEETING_FILES_FOLDER = "Meeting files";
export const MEETING_FILE_SELECT = `id, file_name, mime, size_bytes, width, height, created_at, note, group_id, uploader:users(${USER_BRIEF_COLS})`;

/** The note asked when files are added — the item's title in the meeting and its presentation. */
export const MEETING_NOTE_MAX = 200;
export const cleanMeetingNote = (v: unknown): string | null => cleanLine(v, MEETING_NOTE_MAX) || null;
/** The upload a file belongs to: the browser names it (one id per batch), or the file is its own item. */
export const meetingGroup = (v: unknown): string => (isUuid(v) ? (v as string) : crypto.randomUUID());

export function shapeMeetingFile(r: Record<string, unknown>): MeetingFile {
  return {
    id: r.id as string,
    file_name: r.file_name as string,
    mime: r.mime as string,
    size_bytes: Number(r.size_bytes),
    width: (r.width as number | null) ?? null,
    height: (r.height as number | null) ?? null,
    created_at: r.created_at as string,
    uploaded_by: embeddedUser(r.uploader),
    note: (r.note as string | null) ?? null,
    group_id: (r.group_id as string | null) ?? (r.id as string),
  };
}

/** The meeting, when this person may open it (else null — answered as "not found"). */
export async function meetingForUser(u: Pick<SessionUser, "uid" | "role">, id: string) {
  const m = await loadMeeting(id);
  if (!m || !(await canAccessMeeting(u, m))) return null;
  return m as { id: string; title: string; held_at: string; status: string; series_id: string | null };
}

export async function countMeetingFiles(meetingId: string): Promise<number> {
  const { count } = await getSupabase().from("meeting_attachments").select("id", { count: "exact", head: true }).eq("meeting_id", meetingId);
  return count ?? 0;
}
