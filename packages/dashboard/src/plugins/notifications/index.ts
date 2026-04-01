import { NotificationBell } from "../../components/NotificationBell";
import type { DashboardPlugin } from "../types";

export const notificationsPlugin: DashboardPlugin = {
  id: "notifications",
  name: "Notifications",
  statusBarItems: [
    {
      id: "notification-bell",
      align: "right",
      priority: 200, // far right corner, after everything else
      component: NotificationBell,
    },
  ],
};
