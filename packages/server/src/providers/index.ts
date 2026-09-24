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

/** Test hook: swap a provider (null restores the real one). Lets a test drive a
 *  real spawnAgent reattach against a fake runtime. */
const realProviders = new Map(providers);
export function _setProviderForTesting(
  name: string,
  provider: AgentProvider | null,
): void {
  const real = realProviders.get(name);
  if (provider) providers.set(name, provider);
  else if (real) providers.set(name, real);
  else providers.delete(name);
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
