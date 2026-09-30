/**
 * Per-runtime permissions in each CLI's OWN values (ADR-115) — the pieces the
 * Settings → Runtimes defaults, Create Agent, Templates and the Org Chart
 * inspector share. Every label is the CLI's canonical value and every
 * description comes from core's RUNTIME_PERMISSIONS table, so the UI can't
 * drift from what the spawn passes.
 */

import {
  type AgentTemplate,
  completePermission,
  formatPermission,
  type MaskedSettings,
  neverAsks,
  PERMISSION_RUNTIMES,
  type Provider,
  type ProviderInfo,
  parseRuntimePermission,
  permissionFromLegacyMode,
  RUNTIME_PERMISSIONS,
  type RuntimePermission,
} from "@autonomos/core";
import { useEffect, useState } from "react";
import { settingsApi } from "../api/config";
import type { THEMES } from "../store";
import { isLightBg } from "./recency";
import { STATUS_COLORS_DARK, STATUS_COLORS_LIGHT } from "./statusLabelStyle";

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

export const RUNTIME_NAMES: Record<Provider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

export { PERMISSION_RUNTIMES };

/** The axes chosen at launch (Codex's collaboration mode is per turn). */
export function launchAxes(runtime: Provider) {
  return (RUNTIME_PERMISSIONS[runtime]?.axes ?? []).filter((a) => !a.perTurn);
}

/** The "never asks" amber — the same color as the Needs-input label. */
export function neverAsksTone(page: PageTheme) {
  const amber = (isLightBg(page.bg) ? STATUS_COLORS_LIGHT : STATUS_COLORS_DARK)
    .needsInput;
  return { fg: amber, bg: `${amber}26`, line: `${amber}99` };
}

export function NeverAsksPill({ page }: { page: PageTheme }) {
  const tone = neverAsksTone(page);
  return (
    <span
      data-never-asks
      className="text-[10px] px-1.5 py-px rounded whitespace-nowrap"
      style={{ color: tone.fg, background: tone.bg }}
    >
      never asks
    </span>
  );
}

/** The canonical value as text, amber-outlined when it never asks. */
export function PermissionChip({
  permission,
  page,
}: {
  permission: RuntimePermission;
  page: PageTheme;
}) {
  const never = neverAsks(permission);
  const tone = neverAsksTone(page);
  return (
    <span
      data-permission-chip
      className="font-mono text-[11px] px-1.5 py-px rounded break-all"
      style={{
        color: never ? tone.fg : page.fg,
        background: never ? tone.bg : "transparent",
        border: `1px solid ${never ? tone.line : page.border}`,
      }}
    >
      {formatPermission(permission)}
    </span>
  );
}

/**
 * One control per launch axis. `select` is compact (Settings, template pins);
 * `cards` shows each value with its description (Create Agent). `defaults`
 * marks the operator's default value on each axis.
 */
export function RuntimeAxisFields({
  permission,
  onChange,
  page,
  variant = "select",
  defaults,
  idPrefix,
}: {
  permission: RuntimePermission;
  onChange: (next: RuntimePermission) => void;
  page: PageTheme;
  variant?: "select" | "cards";
  defaults?: RuntimePermission;
  idPrefix?: string;
}) {
  const { runtime, values } = permission;
  const tone = neverAsksTone(page);
  const set = (key: string, value: string) =>
    onChange(completePermission(runtime, { ...values, [key]: value }));

  return (
    <div className="flex flex-col gap-2">
      {launchAxes(runtime).map((axis) => {
        const id = `${idPrefix ?? runtime}-${axis.key}`;
        if (variant === "select") {
          return (
            <div key={axis.key} className="flex items-center gap-2">
              <label
                htmlFor={id}
                className="font-mono text-[10px] w-[118px] shrink-0"
                style={{ color: page.statusFg }}
              >
                {axis.key}
              </label>
              <select
                id={id}
                value={values[axis.key]}
                onChange={(e) => set(axis.key, e.target.value)}
                className="rounded px-2 py-1 text-xs font-mono cursor-pointer min-w-0 flex-1"
                style={{
                  background: page.border,
                  color: page.fg,
                  border: "none",
                }}
              >
                {axis.values.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.value}
                    {defaults?.values[axis.key] === v.value ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </div>
          );
        }
        return (
          <fieldset key={axis.key} className="min-w-0">
            <legend
              className="font-mono text-[11px] mb-1.5"
              style={{ color: page.statusFg }}
            >
              {axis.key}
            </legend>
            <div className="flex flex-wrap gap-2">
              {axis.values.map((v) => {
                const on = values[axis.key] === v.value;
                const never = neverAsks(
                  completePermission(runtime, {
                    ...values,
                    [axis.key]: v.value,
                  }),
                );
                return (
                  <button
                    key={v.value}
                    type="button"
                    aria-pressed={on}
                    data-value={v.value}
                    onClick={() => set(axis.key, v.value)}
                    className="w-[172px] p-2 rounded-lg text-left cursor-pointer flex flex-col gap-1"
                    style={{
                      background: on
                        ? "rgba(35,134,54,0.15)"
                        : "rgba(127,127,127,0.06)",
                      border: `1.5px solid ${on ? "#238636" : page.border}`,
                      color: page.fg,
                    }}
                  >
                    <span className="flex items-center gap-1.5 font-mono text-[12px]">
                      {v.value}
                      {defaults?.values[axis.key] === v.value && (
                        <span
                          className="font-sans text-[9px] uppercase tracking-wide px-1 rounded"
                          style={{
                            color: page.statusFg,
                            border: `1px solid ${page.border}`,
                          }}
                        >
                          default
                        </span>
                      )}
                    </span>
                    <span
                      className="text-[10px] leading-snug"
                      style={{ color: never && on ? tone.fg : page.statusFg }}
                    >
                      {v.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

/**
 * What to know about a chosen permission: "never asks" (amber), each chosen
 * value's caveat, Codex's experimental reviewers, and where Codex's Plan mode
 * lives (it's a per-turn toggle, not a launch option).
 */
export function PermissionNotes({
  permission,
  page,
}: {
  permission: RuntimePermission;
  page: PageTheme;
}) {
  const tone = neverAsksTone(page);
  const notes: string[] = [];
  for (const axis of launchAxes(permission.runtime)) {
    const v = axis.values.find((x) => x.value === permission.values[axis.key]);
    if (v?.caveat) notes.push(`${v.value}: ${v.caveat}`);
  }
  const reviewer = permission.values.approvals_reviewer;
  if (reviewer && reviewer !== "user")
    notes.push(`${reviewer} is experimental in Codex.`);
  return (
    <div className="flex flex-col gap-1 text-[10px] leading-relaxed">
      {neverAsks(permission) && (
        <div
          data-never-asks-note
          className="rounded px-2 py-1"
          style={{ color: tone.fg, background: tone.bg }}
        >
          Never asks before acting.
        </div>
      )}
      {notes.map((n) => (
        <div key={n} style={{ color: page.statusFg }}>
          {n}
        </div>
      ))}
      {permission.runtime === "codex" && (
        <div style={{ color: page.statusFg }}>
          <span className="font-mono">plan</span> collaboration mode: toggle it
          inside Codex with <kbd className="font-mono">Shift+Tab</kbd>. Codex
          picks it per turn, so it isn't set when the agent starts.
        </div>
      )}
    </div>
  );
}

/** "2.1.282 · options verified", or what the drift probe found wrong. */
export function RuntimeCheckLine({
  info,
  page,
}: {
  info: ProviderInfo | undefined;
  page: PageTheme;
}) {
  const check = info?.permissionCheck;
  if (!check) return null;
  const tone = neverAsksTone(page);
  const drift = check.axes.some(
    (a) => a.rejected.length > 0 || a.unlisted.length > 0,
  );
  const version = check.version ?? "version unknown";
  if (check.error)
    return (
      <span className="text-[10px]" style={{ color: tone.fg }}>
        {version} · couldn't check options
      </span>
    );
  return (
    <span className="text-[10px]" style={{ color: page.statusFg }}>
      {version} ·{" "}
      <span style={{ color: drift ? tone.fg : undefined }}>
        {drift ? "options changed in this version" : "✓ options verified"}
      </span>
    </span>
  );
}

// ── Template pins (mirrors the server's templatePermissionFor) ────────────

/**
 * What a template pins for `runtime`: its canonical `permissions` entry, else
 * its legacy shared-vocabulary mode mapped to what that mode ACTUALLY ran,
 * else nothing (the operator's default applies). An entry that no longer
 * parses pins nothing — the server ignores it the same way.
 */
export function templatePin(
  tmpl: AgentTemplate | null | undefined,
  runtime: Provider,
): RuntimePermission | undefined {
  if (!tmpl) return undefined;
  const values = tmpl.permissions?.[runtime];
  if (values) {
    const parsed = parseRuntimePermission(runtime, values);
    return parsed.ok ? parsed.permission : undefined;
  }
  return tmpl.permissionMode
    ? permissionFromLegacyMode(runtime, tmpl.permissionMode)
    : undefined;
}

/** Every runtime's pin, as the explicit per-runtime map a save writes. A legacy
 *  mode becomes explicit pins, so a save never changes what the template ran. */
export function templatePins(
  tmpl: AgentTemplate | null | undefined,
): Partial<Record<Provider, RuntimePermission>> {
  const out: Partial<Record<Provider, RuntimePermission>> = {};
  for (const r of PERMISSION_RUNTIMES) {
    const pin = templatePin(tmpl, r);
    if (pin) out[r] = pin;
  }
  return out;
}

/** The `permissions` field for a save, from per-runtime pins. */
export function pinsToTemplatePermissions(
  pins: Partial<Record<Provider, RuntimePermission>>,
): AgentTemplate["permissions"] {
  const out: NonNullable<AgentTemplate["permissions"]> = {};
  for (const [r, p] of Object.entries(pins) as [Provider, RuntimePermission][])
    out[r] = { ...p.values };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The operator's default for `runtime` from Settings, else the built-in. */
export function operatorDefault(
  defaults: Partial<Record<Provider, RuntimePermission>> | undefined,
  runtime: Provider,
): RuntimePermission {
  return defaults?.[runtime] ?? completePermission(runtime);
}

/** The operator's per-runtime defaults, read once from the server. Undefined
 *  until loaded (or if the read fails) — callers then show the built-in. */
export function useRuntimeDefaults():
  | MaskedSettings["runtimeDefaults"]
  | undefined {
  const [defaults, setDefaults] = useState<MaskedSettings["runtimeDefaults"]>();
  useEffect(() => {
    let live = true;
    settingsApi
      .get()
      .then((s) => live && setDefaults(s.runtimeDefaults))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return defaults;
}
