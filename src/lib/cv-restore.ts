/**
 * Scroll restores vs `content-visibility`: a saved scroll offset is measured
 * against REAL card heights (everything the user scrolled past had rendered),
 * but on a fresh mount `.cv-card`'s memoized sizes are gone — offscreen cards
 * are 260px estimates, so applying the saved pixel offset against the
 * estimated layout lands slightly past the card the user left (it appears
 * scrolled up). Holding a render lock while a restore measures/applies forces
 * every `.cv-card` to lay out at its real height (see globals.css), making the
 * pixel restore exact; releasing re-enables skipping with the just-memoized
 * sizes, so nothing shifts afterwards.
 *
 * Ref-counted because two restores can overlap (the window ScrollManager's
 * deep-restore loop and a dialog's internal restore) — the class must only
 * drop when the LAST holder releases. The returned release is idempotent.
 */
let holds = 0;

export function holdCvRender(): () => void {
  if (++holds === 1) document.documentElement.classList.add("cv-restoring");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds === 0) document.documentElement.classList.remove("cv-restoring");
  };
}
