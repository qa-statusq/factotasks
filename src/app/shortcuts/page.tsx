import type { Metadata } from "next";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";

export const metadata: Metadata = { title: "Keyboard shortcuts" };

const GROUPS: { title: string; keys: [string | string[], string][] }[] = [
  {
    title: "Anywhere",
    keys: [
      ["c", "New task"],
      ["?", "This screen"],
      ["Esc", "Close a sheet or dialog"],
    ],
  },
  {
    title: "Go to… (press g, then the letter)",
    keys: [
      ["g d", "Dashboard"],
      ["g t", "Tasks"],
      ["g a", "Apps"],
      ["g r", "Releases"],
      ["g m", "Meetings (admins and series members)"],
      ["g n", "Inbox"],
      ["g o", "Analytics"],
      ["g e", "People"],
      ["g p", "Approvals (admins)"],
      ["g v", "Activity (admins)"],
      ["g s", "Settings (admins)"],
      ["g h", "Help & guide"],
    ],
  },
  {
    title: "Forms & comments",
    keys: [
      [["Ctrl", "Enter"], "Save / post"],
      [["Enter"], "Add a label (in the labels box) — a comma works too"],
    ],
  },
  {
    title: "Presentation",
    keys: [
      [["→", "Space"], "Next slide"],
      [["←"], "Previous slide"],
      [["↓", "↑"], "Scroll a long section, then turn the slide"],
      [["Home", "End"], "First / last slide"],
      [["a"], "Jump to a section"],
      [["1", "…", "9"], "Jump to the nth section"],
      [["f"], "Toggle full screen"],
      [["Esc"], "Exit"],
    ],
  },
];

export default function ShortcutsPage() {
  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <PageHeader title="Keyboard shortcuts" description="Shortcuts never fire while you're typing in a field." />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {GROUPS.map((g) => (
          <Card key={g.title}>
            <CardHeader>
              <CardTitle>{g.title}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col divide-y divide-line/70 py-1">
              {g.keys.map(([k, what]) => (
                <div key={Array.isArray(k) ? k.join(" ") : k} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <span className="text-ink-muted">{what}</span>
                  <span className="flex gap-1">
                    {(Array.isArray(k) ? k : k.split(" ")).map((part, i) => (
                      <kbd key={i} className="rounded border border-line bg-canvas px-1.5 py-0.5 font-sans text-xs font-medium text-ink">
                        {part}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
