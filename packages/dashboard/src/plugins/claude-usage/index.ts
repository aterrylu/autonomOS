import type { DashboardPlugin } from "../types";
import { UsageStatusBarItem } from "./UsageStatusBarItem";

export const claudeUsagePlugin: DashboardPlugin = {
  id: "claude-usage",
  name: "Claude Usage",
  statusBarItems: [
    {
      id: "claude-usage-summary",
      align: "right",
      priority: 10,
      component: UsageStatusBarItem,
    },
  ],
};
