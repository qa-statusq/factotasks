"use client";

import { Button, buttonClass } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Avatar } from "@/components/ui/avatar";
import { RichText } from "@/components/ui/rich-text";
import { When } from "@/components/ui/live-time";
import { IconExternal, IconMessage } from "@/components/ui/icons";
import { taskRef } from "@/lib/domain";
import type { TaskComment } from "@/lib/types";

/**
 * A task's comments, read-only, in a sheet — opened from the meeting presentation
 * so the discussion behind a task can be shown without leaving the deck. Oldest
 * first, the way the conversation happened. Esc, the ✕ or Close dismisses it.
 */
export function CommentsViewer({ task, comments, onClose }: { task: { id: string; number: number; title: string }; comments: TaskComment[]; onClose: () => void }) {
  const n = comments.length;
  return (
    <Sheet
      title={`${taskRef(task.number)} · ${task.title}`}
      description={`${n} comment${n === 1 ? "" : "s"}`}
      onClose={onClose}
      wide
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <a href={`/tasks/${task.id}`} target="_blank" rel="noopener" className={buttonClass("secondary", "sm")} title="Open the task in a new tab — the presentation stays where it is">
            <IconExternal size={14} /> Open task
          </a>
          <Button size="sm" onClick={onClose}>Close</Button>
        </div>
      }
    >
      <div data-comments-viewer>
      {n === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-[13px] text-ink-subtle">
          <IconMessage size={22} />
          No comments on this task.
        </div>
      ) : (
        <ol className="flex flex-col divide-y divide-line/70 overflow-hidden rounded-xl border border-line bg-surface">
          {comments.map((c) => (
            <li key={c.id} className="flex gap-3 px-4 py-3">
              <Avatar user={c.author} size="sm" className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px] text-ink-subtle">
                  <span className="text-[13px] font-medium text-ink">{c.author?.name ?? "Former teammate"}</span>
                  <When iso={c.created_at} />
                  {c.edited_at && <span>(edited)</span>}
                </div>
                <RichText text={c.body} className="mt-1" />
              </div>
            </li>
          ))}
        </ol>
      )}
      </div>
    </Sheet>
  );
}
