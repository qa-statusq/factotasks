import type { Metadata } from "next";
import { AdminGate } from "@/components/admin-gate";

export const metadata: Metadata = { title: "Meetings" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return <AdminGate>{children}</AdminGate>;
}
