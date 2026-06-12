/**
 * Channel status API — reports the known channels for the settings
 * panel. All remaining channels are `server:*` (autonomOS-owned MCP
 * subprocesses), which are always available — no plugin detection
 * subprocess is needed anymore.
 */

import { Hono } from "hono";
import { type ChannelStatus, KNOWN_CHANNELS } from "../channels.js";

export interface ChannelStatusEntry {
  id: string;
  label: string;
  icon: string;
  status: ChannelStatus;
  /** Actionable command the user can run to reach "ok". */
  fix: string | null;
}

export function getChannelStatuses(): ChannelStatusEntry[] {
  return KNOWN_CHANNELS.map((ch) => ({
    id: ch.id,
    label: ch.label,
    icon: ch.icon,
    status: "ok" as const,
    fix: null,
  }));
}

export const channelsRouter = new Hono();

channelsRouter.get("/status", (c) => {
  return c.json({ channels: getChannelStatuses() });
});
