import type { Metadata } from "next";
import { Brand } from "@/components/shell/topbar";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { SetupDocs } from "./setup-docs";

export const metadata: Metadata = {
  title: "Docs — Emuly",
  description: "Set up Claude Code, Codex, or OpenCode on Windows or Linux, then paste the Emuly prompt.",
};

export default function DocsPage() {
  return <SetupDocs nav={<><Brand /><ThemeToggle /></>} />;
}
