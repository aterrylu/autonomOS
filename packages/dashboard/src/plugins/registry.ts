import type { DashboardPlugin } from "./types";
import { claudeUsagePlugin } from "./claude-usage";

export const plugins: DashboardPlugin[] = [claudeUsagePlugin];
