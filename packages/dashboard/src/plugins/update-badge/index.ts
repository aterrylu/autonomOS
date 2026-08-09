import type { DashboardPlugin } from "../types";
import { UpdateBadgeStatusBarItem } from "./UpdateBadgeStatusBarItem";

export const updateBadgePlugin: DashboardPlugin = {
  id: "update-badge",
  name: "Update Badge",
  statusBarItems: [
    {
      id: "update-badge-indicator",
      align: "left",
      // Next to connection status (20) — both are "state of the server
      // itself" items; renders null (zero width) unless an update is known.
      priority: 25,
      component: UpdateBadgeStatusBarItem,
    },
  ],
};
