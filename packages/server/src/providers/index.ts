/**
 * Provider registry — resolves provider names to AgentProvider implementations.
 *
 * New providers are registered here. The rest of the system uses
 * getProvider(name) and never imports provider modules directly.
 */

import type { AgentProvider } from "@autonomos/core";
import { claudeCodeProvider } from "./claude-code.js";
import { codexProvider } from "./codex.js";
import { geminiCliProvider } from "./gemini-cli.js";

const providers = new Map<string, AgentProvider>([
  ["claude-code", claudeCodeProvider],
  ["codex", codexProvider],
  ["gemini-cli", geminiCliProvider],
]);

/** Get a provider by name. Throws if unknown. */
export function getProvider(name: string): AgentProvider {
  const provider = providers.get(name);
  if (!provider) {
    const known = Array.from(providers.keys()).join(", ");
    throw new Error(`Unknown provider "${name}". Available: ${known}`);
  }
  return provider;
}

/** Get all registered providers (for the /api/providers endpoint). */
export function getAllProviders(): AgentProvider[] {
  return Array.from(providers.values());
}

/** Check if a provider is installed (binary exists). */
export function isProviderInstalled(name: string): boolean {
  try {
    getProvider(name).resolveBinary();
    return true;
  } catch {
    return false;
  }
}
