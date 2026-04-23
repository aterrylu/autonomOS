/**
 * Channel status API — reports which known channels are installed,
 * enabled, disabled, or missing. Cached in-memory so opening the
 * settings panel doesn't pay the ~300ms `claude plugin list` spawn
 * each time.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Hono } from "hono";
import {
  type ChannelStatus,
  channelStatus,
  type InstalledPlugin,
  KNOWN_CHANNELS,
} from "../channels.js";
import {
  commonBinaryCandidates,
  resolveBinaryFromCandidates,
} from "../providers/shared.js";

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 30_000;
const SUBPROCESS_TIMEOUT_MS = 5_000;

let cache: { data: InstalledPlugin[] | null; ts: number } | null = null;
let inflight: Promise<InstalledPlugin[] | null> | null = null;
const binaryCache = { path: null as string | null };

/** Exported for tests — drop the cache so the next call re-runs the subprocess. */
export function _invalidateChannelCache(): void {
  cache = null;
  inflight = null;
}

/**
 * Exported for tests — inject a fixed installed-plugins list so the
 * route (and the settings guard that calls it) can run without spawning
 * `claude plugin list`. Pass `null` to simulate a detection failure;
 * pass `undefined` to restore real subprocess behavior.
 */
export function _setInstalledPluginsForTesting(
  plugins: InstalledPlugin[] | null | undefined,
): void {
  inflight = null;
  if (plugins === undefined) {
    cache = null;
  } else {
    cache = { data: plugins, ts: Date.now() };
  }
}

type ExecFileErr = NodeJS.ErrnoException & {
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  killed?: boolean;
  signal?: string;
};

/**
 * Reads the installed-plugin list from `claude plugin list --json`.
 * Shared by the status route and the settings guard. Concurrent calls
 * share a single in-flight promise so a burst of requests doesn't
 * spawn parallel subprocesses.
 */
export async function readInstalledPlugins(): Promise<
  InstalledPlugin[] | null
> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const bin = resolveBinaryFromCandidates(
        "claude",
        commonBinaryCandidates("claude"),
        binaryCache,
      );
      const { stdout } = await execFileAsync(
        bin,
        ["plugin", "list", "--json"],
        {
          timeout: SUBPROCESS_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) throw new Error("Expected JSON array");
      const plugins: InstalledPlugin[] = [];
      for (const p of parsed) {
        if (typeof p !== "object" || p === null) continue;
        if (typeof p.id !== "string" || p.id.length === 0) continue;
        plugins.push({ id: p.id, enabled: p.enabled !== false });
      }
      cache = { data: plugins, ts: Date.now() };
      return plugins;
    } catch (err) {
      const e = err as ExecFileErr;
      console.warn("[channels] `claude plugin list --json` failed:", {
        message: e.message,
        code: e.code,
        killed: e.killed,
        signal: e.signal,
        stderr: e.stderr?.toString().slice(0, 500),
      });
      // Cache the failure briefly so a broken binary doesn't spawn
      // a subprocess on every keystroke in the settings panel.
      cache = { data: null, ts: Date.now() };
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export interface ChannelStatusEntry {
  id: string;
  label: string;
  icon: string;
  status: ChannelStatus;
  /** Actionable command the user can run to reach "ok". */
  fix: string | null;
}

function fixCommand(id: string, status: ChannelStatus): string | null {
  if (!id.startsWith("plugin:")) return null;
  const pluginId = id.replace(/^plugin:/, "");
  // `/plugin install` is the universal fix — works for both "not installed"
  // (installs fresh) and "disabled" (reinstall + enable in one step). Using
  // one command across both states avoids the `enable`/`install` confusion.
  if (status === "not-installed" || status === "disabled") {
    return `/plugin install ${pluginId}`;
  }
  return null;
}

export async function getChannelStatuses(): Promise<ChannelStatusEntry[]> {
  const installed = await readInstalledPlugins();
  return KNOWN_CHANNELS.map((ch) => {
    const status = channelStatus(ch.id, installed);
    return {
      id: ch.id,
      label: ch.label,
      icon: ch.icon,
      status,
      fix: fixCommand(ch.id, status),
    };
  });
}

export const channelsRouter = new Hono();

channelsRouter.get("/status", async (c) => {
  const channels = await getChannelStatuses();
  return c.json({ channels });
});
