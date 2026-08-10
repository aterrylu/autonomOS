/**
 * Channel status API — reports the known channels for the settings
 * panel. All remaining channels are `server:*` (autonomOS-owned MCP
 * subprocesses), which are always available — no plugin detection
 * subprocess is needed anymore.
 */

import type { ChannelStatusEntry } from "@autonomos/core";
import { Hono } from "hono";
import { KNOWN_CHANNELS } from "../channels.js";

// Wire shape lives in @autonomos/core (types/api.ts) — one declaration
// shared with the dashboard client.
export type { ChannelStatusEntry } from "@autonomos/core";

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
