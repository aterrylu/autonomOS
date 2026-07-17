import type { DashboardPlugin } from "../types";
import { CodexUsageStatusBarItem } from "./CodexUsageStatusBarItem";

export const codexUsagePlugin: DashboardPlugin = {
  id: "codex-usage",
  name: "Codex Usage",
  statusBarItems: [
    {
      id: "codex-usage-summary",
      align: "right",
      // Just right of the Claude usage item (priority 10) so the two providers
      // sit side by side in the status bar.
      priority: 11,
      component: CodexUsageStatusBarItem,
    },
  ],
};
