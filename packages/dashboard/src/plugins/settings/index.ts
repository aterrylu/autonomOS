import type { DashboardPlugin } from "../types";
import { SettingsStatusBarItem } from "./SettingsStatusBarItem";

export const settingsPlugin: DashboardPlugin = {
  id: "settings",
  name: "Settings",
  statusBarItems: [
    {
      id: "settings-gear",
      align: "left",
      priority: 100, // far left after hostname, like VSCode
      component: SettingsStatusBarItem,
    },
  ],
};
