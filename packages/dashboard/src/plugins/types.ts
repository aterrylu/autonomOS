import type { ComponentType } from "react";

/** Where a status bar item appears */
export type StatusBarAlignment = "left" | "right";

/** A single item rendered in the status bar */
export interface StatusBarItem {
  id: string;
  align: StatusBarAlignment;
  /** Sort priority within alignment group (lower = further from center) */
  priority: number;
  /** Self-contained React component — manages its own data fetching */
  component: ComponentType;
}

/** Optional panel a plugin can surface (future extensibility) */
export interface PluginPanel {
  id: string;
  title: string;
  component: ComponentType;
}

/** A modular dashboard plugin */
export interface DashboardPlugin {
  id: string;
  name: string;
  statusBarItems?: StatusBarItem[];
  panels?: PluginPanel[];
}
