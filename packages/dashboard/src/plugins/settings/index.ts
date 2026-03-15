import type { DashboardPlugin } from "../types";
import { SettingsStatusBarItem } from "./SettingsStatusBarItem";

export const settingsPlugin: DashboardPlugin = {
  id: "settings",
  name: "Settings",
  statusBarItems: [
    {
      id: "settings-gear",
      align: "right",
      priority: 100, // far right, like VSCode
      component: SettingsStatusBarItem,
    },
  ],
};
