import { claudeUsagePlugin } from "./claude-usage";
import { codexUsagePlugin } from "./codex-usage";
import { connectionStatusPlugin } from "./connection-status";
import { notificationsPlugin } from "./notifications";
import { settingsPlugin } from "./settings";
import type { DashboardPlugin } from "./types";

export const plugins: DashboardPlugin[] = [
  claudeUsagePlugin,
  codexUsagePlugin,
  connectionStatusPlugin,
  notificationsPlugin,
  settingsPlugin,
];
