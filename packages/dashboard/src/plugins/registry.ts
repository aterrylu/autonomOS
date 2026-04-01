import { claudeUsagePlugin } from "./claude-usage";
import { connectionStatusPlugin } from "./connection-status";
import { notificationsPlugin } from "./notifications";
import { settingsPlugin } from "./settings";
import type { DashboardPlugin } from "./types";

export const plugins: DashboardPlugin[] = [
  claudeUsagePlugin,
  connectionStatusPlugin,
  notificationsPlugin,
  settingsPlugin,
];
