import type { Metadata } from "next";
import { MeetingsGate } from "@/components/admin-gate";

export const metadata: Metadata = { title: "Meetings" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return <MeetingsGate>{children}</MeetingsGate>;
}
