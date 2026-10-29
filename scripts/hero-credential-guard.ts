import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Guard for the README hero capture (packages/dashboard/scripts/capture-hero.ts,
 * #551): its throwaway HOME must never hold a real credential.
 *
 * The capture used to copy the operator's ~/.codex/auth.json, Claude OAuth
 * token and ~/.gemini into that HOME so real agents could run. If a CLI then
 * refreshed its token inside the copy, the provider rotated the refresh token
 * and signed the operator's REAL login out. The capture now runs on a mock
 * backend and scripted panes, and this guard fails it if any credential lands
 * there anyway, by name or by contents.
 */

/** File names the CLIs store credentials in. */
export const CREDENTIAL_FILE_NAMES = new Set([
  "auth.json", // Codex
  ".credentials.json", // Claude Code
  "oauth_creds.json", // Gemini CLI (Google OAuth)
  "google_accounts.json", // Gemini CLI
  "mcp-oauth-tokens.json", // Gemini CLI MCP OAuth
]);

/** Contents that only a stored credential has. */
const CREDENTIAL_CONTENT = [
  /"refresh_token"\s*:/,
  /"refreshToken"\s*:/,
  /"access_token"\s*:\s*"[^"]{20,}"/,
  /"accessToken"\s*:\s*"[^"]{20,}"/,
  /"claudeAiOauth"\s*:/,
  /\bsk-ant-(?:oat|ort|api)\d*-[A-Za-z0-9_-]{20,}/,
];

/** Skip contents past this size (logs, transcripts); names still count. */
const MAX_SCANNED_BYTES = 1024 * 1024;

export interface CredentialFinding {
  path: string;
  why: string;
}

/** Every credential-looking file under `root` (symlinks are not followed). */
export function findCredentials(root: string): CredentialFinding[] {
  const found: CredentialFinding[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!st.isFile()) continue;
      if (CREDENTIAL_FILE_NAMES.has(name) || /\.keychain(-db)?$/.test(name)) {
        found.push({ path: p, why: `credential file name "${name}"` });
        continue;
      }
      if (st.size > MAX_SCANNED_BYTES) continue;
      let text: string;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      const hit = CREDENTIAL_CONTENT.find((re) => re.test(text));
      if (hit) found.push({ path: p, why: `credential-like contents (${hit})` });
    }
  };
  walk(root);
  return found;
}

/** Throw, naming every finding, if `root` holds a credential. */
export function assertNoCredentials(root: string, label: string): void {
  const found = findCredentials(root);
  if (found.length === 0) return;
  const list = found
    .map((f) => `  - ${relative(root, f.path) || f.path}: ${f.why}`)
    .join("\n");
  throw new Error(
    `${label} holds ${found.length} credential(s); the hero capture must run on NO real login (#551):\n${list}`,
  );
}
