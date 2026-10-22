import { redirect } from "next/navigation";

/** The old Reports URL — now Analytics. */
export default function ReportsRedirect() {
  redirect("/analytics");
}
