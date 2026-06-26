/**
 * PermissionModeSelect — dropdown for the per-provider permission mode, with a
 * clickable "?" that reveals a current-selection-only explainer (what the
 * picked mode means for each provider). Shared by the Settings panel (sets the
 * global default) and the Create Agent panel (per-spawn override). The explainer
 * text is sourced from core's PERMISSION_MODE_INFO so the UI never drifts from
 * the actual provider mapping. See ADR-045.
 */

import {
  PERMISSION_MODE_INFO,
  PERMISSION_MODES,
  type PermissionMode,
  type Provider,
} from "@autonomos/core";
import { useState } from "react";

interface PermissionModePalette {
  /** Primary text color. */
  fg: string;
  /** Muted/secondary text color. */
  statusFg: string;
  /** Border / control-fill color. */
  border: string;
}

/** Provider rows shown in the explainer, in display order. */
const EXPLAINER_PROVIDERS = [
  { label: "Claude", key: "claude-code" },
  { label: "Gemini", key: "gemini-cli" },
  { label: "Codex", key: "codex" },
] as const;

export function PermissionModeSelect({
  value,
  onChange,
  page,
  id,
  provider,
}: {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  page: PermissionModePalette;
  id?: string;
  /** When set (Create Agent), modes the provider can't represent are disabled.
   *  Omitted in provider-agnostic contexts (global default, templates). */
  provider?: Provider;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const info = PERMISSION_MODE_INFO[value];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value as PermissionMode)}
          className="rounded px-2 py-1 text-xs cursor-pointer"
          style={{ background: page.border, color: page.fg, border: "none" }}
        >
          {PERMISSION_MODES.map((mode) => {
            const unsupported =
              provider !== undefined &&
              PERMISSION_MODE_INFO[mode].unsupportedBy?.includes(provider);
            return (
              <option key={mode} value={mode} disabled={unsupported}>
                {PERMISSION_MODE_INFO[mode].label}
                {unsupported ? " (n/a)" : ""}
              </option>
            );
          })}
        </select>
        <button
          type="button"
          aria-label="What does this permission mode do?"
          aria-expanded={showInfo}
          onClick={() => setShowInfo((s) => !s)}
          className="flex h-4 w-4 items-center justify-center rounded-full text-[10px] leading-none cursor-pointer"
          style={{ border: `1px solid ${page.statusFg}`, color: page.statusFg }}
        >
          ?
        </button>
      </div>

      {showInfo && (
        <div
          className="rounded px-2 py-1.5 text-[10px] leading-relaxed space-y-0.5"
          style={{ background: page.border, color: page.statusFg }}
        >
          <div style={{ color: page.fg }}>{info.summary}</div>
          {EXPLAINER_PROVIDERS.map(({ label, key }) => (
            <div key={key}>
              <span style={{ color: page.fg }}>{label}:</span>{" "}
              {info.perProvider[key]}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
