import { getSupabase } from "./supabase";
import { convertToPdf, ensureFolder, fileSize } from "./google-drive";

/**
 * Word, Excel and PowerPoint files can't be shown by a browser. The first time
 * one is opened the panel has Google convert it to a PDF (lib/google-drive
 * convertToPdf), keeps that PDF in the "Previews" folder and remembers it on
 * the attachment (preview_file_id, 036); every later view is that PDF, shown
 * like any PDF. The preview is deleted with its file.
 */
export const PREVIEWS_FOLDER = "Previews";

const GOOGLE_TYPE: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "application/vnd.google-apps.document",
  "application/msword": "application/vnd.google-apps.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "application/vnd.google-apps.spreadsheet",
  "application/vnd.ms-excel": "application/vnd.google-apps.spreadsheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "application/vnd.google-apps.presentation",
  "application/vnd.ms-powerpoint": "application/vnd.google-apps.presentation",
};
export const isOfficeDoc = (mime: string) => mime in GOOGLE_TYPE;

/** Preview sizes, so serving a range doesn't ask Drive every time. */
const sizes = new Map<string, number>();
/** One conversion per file at a time on this instance (two viewers opening it share it). */
const running = new Map<string, Promise<{ id: string; size: number }>>();

/**
 * The PDF preview of an office attachment: the one made before, or made now.
 * `table` is task_attachments or meeting_attachments.
 */
export async function officePreview(table: "task_attachments" | "meeting_attachments", att: { id: string; mime: string; file_name: string; drive_file_id: string; preview_file_id?: string | null }): Promise<{ id: string; size: number }> {
  if (att.preview_file_id) {
    const known = sizes.get(att.preview_file_id);
    if (known !== undefined) return { id: att.preview_file_id, size: known };
    try {
      const size = await fileSize(att.preview_file_id);
      sizes.set(att.preview_file_id, size);
      return { id: att.preview_file_id, size };
    } catch {
      // The kept preview is gone (removed by hand in Drive): make it again below.
    }
  }
  let job = running.get(att.id);
  if (!job) {
    job = (async () => {
      const folder = await ensureFolder(PREVIEWS_FOLDER);
      const made = await convertToPdf(att.drive_file_id, GOOGLE_TYPE[att.mime], att.file_name.replace(/\.[^.]+$/, ""), folder);
      await getSupabase().from(table).update({ preview_file_id: made.id }).eq("id", att.id);
      sizes.set(made.id, made.size);
      return made;
    })().finally(() => running.delete(att.id));
    running.set(att.id, job);
  }
  return job;
}
