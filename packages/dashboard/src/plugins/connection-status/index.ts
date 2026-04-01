import type { DashboardPlugin } from "../types";
import { ConnectionStatusBarItem } from "./ConnectionStatusBarItem";

export const connectionStatusPlugin: DashboardPlugin = {
  id: "connection-status",
  name: "Connection Status",
  statusBarItems: [
    {
      id: "connection-status-indicator",
      align: "left",
      priority: 20, // after settings (100 = far left), before usage (right side)
      component: ConnectionStatusBarItem,
    },
  ],
};
