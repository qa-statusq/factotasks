import { cn } from "@/lib/cn";
import { IconExternal } from "@/components/ui/icons";

export const NOTE_LINK_DEFAULT_LABEL = "Click here";

/**
 * "Link: Click here" — the link behind a minute line. Opens in a new tab.
 * `size` picks the unit system: px in the panel, cqw inside the deck stage,
 * pt in the printed minutes (where the anchor stays clickable in the PDF).
 */
export function NoteLink({ url, label, size = "sm", className }: { url: string | null | undefined; label?: string | null; size?: "sm" | "deck" | "print"; className?: string }) {
  if (!url) return null;
  const text = label?.trim() || NOTE_LINK_DEFAULT_LABEL;
  const sized =
    size === "deck"
      ? "gap-[0.5cqw] rounded-[0.5cqw] px-[0.8cqw] py-[0.25cqw] text-[1.05cqw] leading-none [&_svg]:h-[1cqw] [&_svg]:w-[1cqw]"
      : size === "print"
        ? "gap-1 rounded px-1.5 py-[1px] text-[8.5pt] leading-tight [&_svg]:h-[8pt] [&_svg]:w-[8pt]"
        : "gap-1 rounded-md px-2 py-0.5 text-[11.5px] [&_svg]:h-3 [&_svg]:w-3";
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={(e) => e.stopPropagation()}
      title={url}
      className={cn("inline-flex max-w-full items-center whitespace-nowrap align-middle bg-brand-50 font-semibold text-brand-700 ring-1 ring-inset ring-brand-200 hover:bg-brand-100 hover:text-brand-800", sized, className)}
    >
      <span className="font-medium text-brand-600/80">Link:</span>
      <span className="truncate">{text}</span>
      <IconExternal size={12} className="shrink-0 opacity-70" />
    </a>
  );
}
