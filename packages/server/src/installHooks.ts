/**
 * Auto-install the autonomOS hook relay into Claude Code's settings.
 *
 * On server startup, ensures:
 * 1. ~/.claude/hooks/autonomos-relay.sh exists (copies from repo)
 * 2. Claude Code's settings.json has the relay registered on all events
 *
 * This is idempotent — safe to run on every startup. If the hook is
 * already installed and registered, it's a no-op.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const HOME = process.env.HOME || "/root";
const CLAUDE_DIR = join(HOME, ".claude");
const HOOKS_DIR = join(CLAUDE_DIR, "hooks");
const SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");
const HOOK_FILENAME = "autonomos-relay.sh";

/** Source hook script bundled with the server */
const BUNDLED_HOOK = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../hooks",
  HOOK_FILENAME,
);

/** All Claude Code hook events we want to relay */
const RELAY_EVENTS = [
  "Notification",
  "Stop",
  "PermissionRequest",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "PreCompact",
];

const RELAY_HOOK_ENTRY = {
  matcher: "",
  hooks: [
    {
      type: "command",
      command: `~/.claude/hooks/${HOOK_FILENAME}`,
      timeout: 3,
      async: true,
    },
  ],
};

export function installHookRelay(): void {
  try {
    installScript();
    registerInSettings();
  } catch (err) {
    // Non-fatal — the server can still run without hooks
    console.warn(
      `[hooks] Failed to auto-install relay: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Copy the hook script to ~/.claude/hooks/ if missing or outdated */
function installScript(): void {
  if (!existsSync(BUNDLED_HOOK)) {
    console.warn(`[hooks] Bundled hook not found at ${BUNDLED_HOOK}`);
    return;
  }

  const targetPath = join(HOOKS_DIR, HOOK_FILENAME);

  // Compare contents to avoid unnecessary writes
  if (existsSync(targetPath)) {
    const existing = readFileSync(targetPath, "utf-8");
    const bundled = readFileSync(BUNDLED_HOOK, "utf-8");
    if (existing === bundled) return; // already up to date
    console.log("[hooks] Updating autonomos-relay.sh (new version)");
  } else {
    console.log("[hooks] Installing autonomos-relay.sh");
  }

  mkdirSync(HOOKS_DIR, { recursive: true });
  copyFileSync(BUNDLED_HOOK, targetPath);
  chmodSync(targetPath, 0o755);
}

/** Register the relay hook in Claude Code's settings.json for all events */
function registerInSettings(): void {
  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true });
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(SETTINGS_FILE)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    } catch {
      console.warn(
        "[hooks] Could not parse settings.json, skipping registration",
      );
      return;
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  let changed = false;

  for (const event of RELAY_EVENTS) {
    const entries = (hooks[event] ?? []) as Array<{
      hooks?: Array<{ command?: string }>;
    }>;

    const alreadyRegistered = entries.some((entry) =>
      entry.hooks?.some((h) => h.command?.includes(HOOK_FILENAME)),
    );

    if (!alreadyRegistered) {
      entries.push(RELAY_HOOK_ENTRY);
      hooks[event] = entries;
      changed = true;
    }
  }

  if (changed) {
    settings.hooks = hooks;
    writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
    console.log(
      `[hooks] Registered relay on ${RELAY_EVENTS.length} Claude Code events`,
    );
  }
}
