import type { DashboardPlugin } from "../types";
import { NewDeviceLockStatusBarItem } from "./NewDeviceLockStatusBarItem";

export const newDeviceLockPlugin: DashboardPlugin = {
  id: "new-device-lock",
  name: "New-Device Lock",
  statusBarItems: [
    {
      id: "new-device-lock-indicator",
      align: "left",
      // Beside connection status (20) and the update badge (25): another
      // "state of the server itself" item; zero width unless locked.
      priority: 24,
      component: NewDeviceLockStatusBarItem,
    },
  ],
};
