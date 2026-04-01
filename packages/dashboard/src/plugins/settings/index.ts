import type { DashboardPlugin } from "../types";

export const settingsPlugin: DashboardPlugin = {
  id: "settings",
  name: "Settings",
  // No status bar items — settings is triggered from the hostname badge in StatusBar.tsx
};
