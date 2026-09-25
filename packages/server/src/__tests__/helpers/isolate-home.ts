/**
 * Run an in-process unit test under a throwaway HOME + CLAUDE_CONFIG_DIR — the
 * in-process twin of the #388 integration harness's per-boot fake HOME.
 *
 * WHY: any test that drives the real `spawnAgent` with a provider inheriting
 * claude-code's `prepareSpawn` pre-trusts its cwd in `.claude.json`, resolved
 * from the child env (which is a copy of process.env). Under the operator's
 * HOME that wrote a `projects[<tmp cwd>]` entry into the REAL ~/.claude.json
 * on every run — silently, because pre-trust no-ops when the file is missing,
 * which it is on CI runners and in a bare sandbox.
 *
 * Call at MODULE TOP, before importing any server module: shared.ts captures
 * HOME at import, and every spawn copies process.env.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedHome {
  /** The throwaway HOME (also holds CLAUDE_CONFIG_DIR). */
  home: string;
  /** The `.claude.json` spawns now resolve to (seeded, so pre-trust writes it). */
  claudeJson: string;
  /** Trust keys the REAL (pre-isolation) `.claude.json` holds right now. */
  realTrustKeys: () => Set<string>;
  /** Trust keys in the throwaway `.claude.json`. */
  fakeTrustKeys: () => Set<string>;
  /** Restore HOME/CLAUDE_CONFIG_DIR and delete the throwaway dir. */
  restore: () => void;
}

function trustKeys(path: string): Set<string> {
  try {
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as {
      projects?: Record<string, unknown>;
    };
    return new Set(Object.keys(cfg.projects ?? {}));
  } catch {
    return new Set();
  }
}

export function isolateHome(prefix: string): IsolatedHome {
  const prevHome = process.env.HOME;
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  // Resolve the operator's real file the way CC does, BEFORE overriding.
  const realCfg = prevCfg?.trim();
  const realClaudeJson = realCfg
    ? join(realCfg, ".claude.json")
    : join(homedir(), ".claude.json");

  const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
  const claudeDir = join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const claudeJson = join(claudeDir, ".claude.json");
  // Seeded like a real install, so the pre-trust write actually happens here
  // (and a test can assert it landed HERE rather than assume it).
  writeFileSync(claudeJson, `${JSON.stringify({ projects: {} }, null, 2)}\n`);

  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;

  return {
    home,
    claudeJson,
    realTrustKeys: () => trustKeys(realClaudeJson),
    fakeTrustKeys: () => trustKeys(claudeJson),
    restore: () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevCfg;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
