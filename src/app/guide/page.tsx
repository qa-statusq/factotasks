import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";

export const metadata: Metadata = { title: "Help & guide" };

const SECTIONS: { title: string; items: { q: string; a: React.ReactNode }[] }[] = [
  {
    title: "Tasks",
    items: [
      { q: "Creating a task", a: <>Press <kbd>c</kbd> anywhere, or use <b>New task</b>. Pick the app (or leave it General), the platform, who&rsquo;s on it and a due date. Labels are free-form tags (<i>crash</i>, <i>onboarding</i>).</> },
      { q: "Changing status", a: <>Open the task and use the <b>Status</b> box. Admins apply directly. For members, moving to <b>Done</b> (or Cancelled) is sent to an admin for review under the default policy — the task shows an &ldquo;awaiting approval&rdquo; badge until then. Everything else applies immediately.</> },
      { q: "Approvals", a: <>Admins see pending requests on the Dashboard and under <Link href="/approvals" className="text-brand-700">Approvals</Link>. <b>Approve</b> applies the status and records completion at the time the member asked. <b>Send back</b> clears the request with a note; the member is notified.</> },
      { q: "Time tracking", a: <>Every task records when it was created, first started, completed and approved. <b>Active time</b> only counts time spent in <i>In progress</i> — pauses on hold don&rsquo;t count. <b>Lead time</b> is creation to completion.</> },
      { q: "Attachments", a: <>Drop screenshots, recordings, logs or builds onto a task. Images are downscaled in your browser before upload (a 4 MB screenshot becomes ~250 KB). Files are private; links expire after 10 minutes.</> },
    ],
  },
  {
    title: "Apps & releases",
    items: [
      { q: "Apps", a: <>An app ships on Android, iOS or both. Admins add apps and assign the people working on each (developer, designer, QA, lead…). Tasks on an app can target one platform or both.</> },
      { q: "Releases", a: <>Log every version per platform on the app&rsquo;s <b>Releases</b> tab: planned date, status (planned → in progress → testing → submitted → released), what&rsquo;s in it, and internal notes. Link tasks to a release from the task editor; the release sheet shows how many are done.</> },
    ],
  },
  {
    title: "Weekly meeting (MOM)",
    items: [
      { q: "How it works", a: <>Under <Link href="/meetings" className="text-brand-700">Meetings</Link>, create a meeting: pick its <b>series</b> (weekly sync, a release review, a management review…), optionally limit it to some apps, and set the date and time you actually meet. It gathers everything in scope since the previous meeting <i>of that series</i>, app by app: what got done, what&rsquo;s still pending (with how many meetings it has been carried through), and releases. While the meeting is open it keeps updating to the minute.</> },
      { q: "Meetings & general tasks", a: <>An app task reaches every meeting whose scope covers its app. A general task reaches a meeting only when it is attached to a meeting series (New/Edit task → <b>Meeting</b>) or added to one meeting by hand. Attached tasks carry forward on that series like app tasks until they are done.</> },
      { q: "What members see", a: <>A member&rsquo;s panel covers the apps they belong to: those apps, their releases and tasks, plus the general tasks they are assigned to or created. A general task is private to the people on it. Meetings, approvals, activity and per-person analytics are for admins. Add people to an app from its page to widen what they see.</> },
      { q: "Series & scope", a: <>Different kinds of meetings don&rsquo;t interfere: a FactoTime review on Tuesday never shortens Thursday&rsquo;s weekly sync, and carry-forward is counted within each series. Any task can be <b>added to a meeting</b> by hand — from the meeting page (Add task) or from the task page — and the same task can sit in several meetings, each with its own notes.</> },
      { q: "Releases & tasks", a: <>When you add or edit a release, tick the tasks that ship in it. Marking the version <b>Released</b> marks those tasks done on the release date — directly for admins, or after an admin approves when the policy asks for it; the approval shows exactly which tasks will close. The version, its tasks and their descriptions appear in meetings and minutes. Any task&rsquo;s status can still be changed by hand from its pill.</> },
      { q: "Present & print", a: <><b>Present</b> opens the deck full-screen (arrow keys, F for full screen, Esc to leave). <b>Print</b> opens the minutes as an A4 document in a new tab and brings up the print dialog, so you can print or save a PDF.</> },
      { q: "Minutes & closing", a: <>Add notes against any task (note, decision, action item, blocker) or general minutes; notes also appear on the task page. <b>Close meeting</b> locks the minutes as they stood — open tasks aren&rsquo;t affected and simply carry into the next meeting.</> },
      { q: "Presenting", a: <>Open <b>Present</b> for a full-screen deck. Arrow keys / swipe move between sections; <kbd>Esc</kbd> exits. Print to PDF from the browser for a shareable copy.</> },
    ],
  },
  {
    title: "Team & account",
    items: [
      { q: "Adding people", a: <>Admins add teammates under <Link href="/team" className="text-brand-700">Team</Link> with a temporary password. On first sign-in they set their own. Deactivate someone to keep their history but stop sign-ins.</> },
      { q: "Roles", a: <><b>Admin</b> manages apps, people, settings, and approves status changes. <b>Member</b> creates and works on tasks, comments, attaches files, and logs releases for their apps.</> },
      { q: "Notifications", a: <>Assignments, approval requests and decisions, comments on your tasks, meeting notes about you, and releases of your apps land in <Link href="/notifications" className="text-brand-700">Inbox</Link>. Turn on <b>browser notifications</b> under Profile to get them as push alerts on this device, even with the tab closed.</> },
    ],
  },
];

export default function GuidePage() {
  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <PageHeader title="Help & guide" description="How FactoTasks works, in a page." />
      {SECTIONS.map((s) => (
        <Card key={s.title}>
          <CardHeader>
            <CardTitle>{s.title}</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col divide-y divide-line/70">
            {s.items.map((it) => (
              <div key={it.q} className="py-3 first:pt-0 last:pb-0">
                <h3 className="text-sm font-semibold text-ink">{it.q}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted [&_kbd]:rounded [&_kbd]:border [&_kbd]:border-line [&_kbd]:bg-canvas [&_kbd]:px-1 [&_kbd]:py-0.5 [&_kbd]:font-sans [&_kbd]:text-xs">{it.a}</p>
              </div>
            ))}
          </CardBody>
        </Card>
      ))}
      <p className="text-xs text-ink-subtle">
        Keyboard shortcuts are listed under{" "}
        <Link href="/shortcuts" className="font-medium text-brand-700">
          Keyboard shortcuts
        </Link>
        .
      </p>
    </div>
  );
}
