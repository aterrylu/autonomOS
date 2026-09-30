/**
 * Settings → Runtimes: the operator's default permission per installed CLI, in
 * the CLI's own values (ADR-115). These defaults are SERVER-side and apply to
 * every new agent that names none — including agents started by other agents —
 * so a default that never asks is flagged amber and needs an explicit confirm
 * (the server refuses it without `confirmNeverAsks`, ADR-122), and every change
 * is listed below, including edits made to settings.json directly.
 */

import {
  formatPermission,
  type MaskedSettings,
  neverAsks,
  type Provider,
  type ProviderInfo,
  type RuntimePermission,
} from "@autonomos/core";
import { useEffect, useState } from "react";
import { settingsApi } from "../../api/config";
import { ApiError } from "../../api/core";
import { providersApi } from "../../api/misc";
import {
  neverAsksTone,
  operatorDefault,
  PERMISSION_RUNTIMES,
  PermissionNotes,
  RUNTIME_NAMES,
  RuntimeAxisFields,
  RuntimeCheckLine,
} from "../../components/RuntimePermission";
import type { THEMES } from "../../store";

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

const LOG_SHOWN = 5;

export function RuntimeDefaultsSection({
  settings,
  onSaved,
  page,
}: {
  settings: MaskedSettings | null;
  onSaved: (s: MaskedSettings) => void;
  page: PageTheme;
}) {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [confirm, setConfirm] = useState<RuntimePermission | null>(null);
  const [error, setError] = useState("");
  const tone = neverAsksTone(page);
  const labelStyle = { color: page.statusFg };

  useEffect(() => {
    providersApi
      .list()
      .then(setProviders)
      .catch(() => setProviders([]));
  }, []);

  const current = (r: Provider) =>
    operatorDefault(settings?.runtimeDefaults, r);

  async function save(next: RuntimePermission, confirmed: boolean) {
    setError("");
    try {
      onSaved(
        await settingsApi.update({
          runtimeDefaults: { [next.runtime]: next.values },
          ...(confirmed ? { confirmNeverAsks: true } : {}),
        }),
      );
      setConfirm(null);
    } catch (err) {
      // The server has the last word on what widens (e.g. this panel was
      // opened before someone else changed the default): ask here, then retry.
      if (err instanceof ApiError && err.code === "CONFIRM_NEVER_ASKS") {
        setConfirm(next);
        return;
      }
      setError(
        err instanceof ApiError && !err.unreachable
          ? err.message
          : "Could not reach server",
      );
    }
  }

  function change(next: RuntimePermission) {
    if (neverAsks(next) && !neverAsks(current(next.runtime))) {
      setConfirm(next);
      return;
    }
    void save(next, false);
  }

  const installed = (providers ?? []).filter(
    (p) => p.installed && PERMISSION_RUNTIMES.includes(p.name as Provider),
  );
  const log = [...(settings?.runtimeDefaultsLog ?? [])]
    .reverse()
    .slice(0, LOG_SHOWN);

  return (
    <div className="space-y-2.5" data-testid="runtime-defaults">
      <div>
        <div
          className="text-[10px] font-medium uppercase tracking-wide"
          style={labelStyle}
        >
          Runtimes
        </div>
        <div className="text-[10px] mt-1" style={labelStyle}>
          Each installed CLI, in its own values. The default applies to new
          agents started here, from templates that don't pin one, and by other
          agents.
        </div>
      </div>

      {providers === null && <div style={labelStyle}>Loading…</div>}

      {installed.map((p) => {
        const r = p.name as Provider;
        const value = current(r);
        const pending = confirm?.runtime === r ? confirm : null;
        return (
          <div
            key={r}
            data-runtime={r}
            className="rounded p-2 space-y-1.5"
            style={{ border: `1px solid ${page.border}` }}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium">{RUNTIME_NAMES[r]}</span>
              <RuntimeCheckLine info={p} page={page} />
            </div>
            <RuntimeAxisFields
              permission={pending ?? value}
              onChange={change}
              page={page}
              idPrefix={`default-${r}`}
            />
            {pending ? (
              <div
                data-testid="confirm-never-asks"
                className="rounded px-2 py-1.5 space-y-1.5 text-[10px] leading-relaxed"
                style={{ color: tone.fg, background: tone.bg }}
              >
                <div>
                  Make{" "}
                  <span className="font-mono">{formatPermission(pending)}</span>{" "}
                  the default? New {RUNTIME_NAMES[r]} agents that don't name a
                  permission, including ones other agents start, will never ask
                  before acting.
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void save(pending, true)}
                    className="rounded px-2 py-0.5 cursor-pointer font-medium"
                    style={{ background: tone.fg, color: page.bg }}
                  >
                    Make default
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirm(null)}
                    className="rounded px-2 py-0.5 cursor-pointer"
                    style={{ background: page.border, color: page.fg }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <PermissionNotes permission={value} page={page} />
            )}
          </div>
        );
      })}

      {error && (
        <div className="text-[10px]" style={{ color: "#ea6c73" }}>
          {error}
        </div>
      )}

      <div className="text-[10px]" style={labelStyle}>
        Only installed CLIs are listed. An agent started by another agent may
        name its runtime's own value; if it names none, these defaults apply.
      </div>

      {log.length > 0 && (
        <div className="space-y-1" data-testid="runtime-defaults-log">
          <div className="text-[10px]" style={labelStyle}>
            Recent changes
          </div>
          {log.map((e) => (
            <div
              key={`${e.at}-${e.runtime}`}
              className="text-[10px] leading-snug"
              style={{ color: e.neverAsks ? tone.fg : page.statusFg }}
            >
              {new Date(e.at).toLocaleString()} ·{" "}
              {RUNTIME_NAMES[e.runtime as Provider] ?? e.runtime}:{" "}
              <span className="font-mono">{e.from}</span> →{" "}
              <span className="font-mono">{e.to}</span>
              {e.source === "out-of-band" && " (settings.json edited directly)"}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
