import { claudeUsagePlugin } from "./claude-usage";
import { settingsPlugin } from "./settings";
import type { DashboardPlugin } from "./types";

export const plugins: DashboardPlugin[] = [claudeUsagePlugin, settingsPlugin];
