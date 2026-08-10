/** Config families — templates, env presets, settings, channels. */

import type {
  AgentTemplate,
  ChannelStatusEntry,
  EnvPreset,
  MaskedSettings,
} from "@autonomos/core";
import { request } from "./core";

export const templatesApi = {
  /** Keyed by template name — the server serves its store map verbatim. */
  list: (opts?: { signal?: AbortSignal; fresh?: boolean }) =>
    request<Record<string, AgentTemplate>>("/api/templates", opts),
  save: (name: string, template: AgentTemplate) =>
    request<{ ok: boolean; message: string; warnings?: string[] }>(
      "/api/templates",
      { method: "POST", body: { name, ...template } },
    ),
  remove: (name: string) =>
    request<{ ok: boolean }>(`/api/templates/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
};

export const presetsApi = {
  /** Keyed by preset name — the server serves its store map verbatim. */
  list: (opts?: { signal?: AbortSignal; fresh?: boolean }) =>
    request<Record<string, EnvPreset>>("/api/env-presets", opts),
  create: (preset: unknown) =>
    request<EnvPreset>("/api/env-presets", { method: "POST", body: preset }),
  update: (name: string, patch: unknown) =>
    request<EnvPreset>(`/api/env-presets/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: patch,
    }),
  remove: (name: string) =>
    request<{ ok: boolean }>(`/api/env-presets/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
};

export const settingsApi = {
  get: (opts?: { signal?: AbortSignal; fresh?: boolean }) =>
    request<MaskedSettings>("/api/settings", opts),
  /** Partial update; the server whitelists keys. All six former PUT sites
   * funnel here so panels can share one invalidation path. */
  update: (partial: Record<string, unknown>) =>
    request<MaskedSettings>("/api/settings", { method: "PUT", body: partial }),
};

export const channelsApi = {
  status: (opts?: { signal?: AbortSignal; fresh?: boolean }) =>
    request<{ channels: ChannelStatusEntry[] }>("/api/channels/status", opts),
};
