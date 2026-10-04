/**
 * Permission… — change one agent's permission and restart it in the SAME
 * conversation (context menu + Org Chart inspector). Values are the runtime's
 * own (ADR-115). The server has the last word on two refusals, answered here:
 *  - a widening to a value that never asks needs an explicit confirm;
 *  - a resumed Codex conversation keeps the policy it started with (ADR-104),
 *    so a change there needs a FRESH conversation, offered explicitly.
 */

import {
  completePermission,
  formatPermission,
  neverAsks,
  type Provider,
  type RuntimePermission,
  samePermission,
  widerAxes,
} from "@autonomos/core";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../api/core";
import { pushEscapeCloser } from "../shortcuts/escapeStack";
import { THEMES, useStore } from "../store";
import {
  knownDefault,
  neverAsksTone,
  PERMISSION_RUNTIMES,
  PermissionChip,
  PermissionNotes,
  RUNTIME_NAMES,
  RuntimeAxisFields,
  useRuntimeDefaults,
} from "./RuntimePermission";

type Step = "pick" | "confirm-never" | "needs-fresh";

export function PermissionDialog() {
  const agentId = useStore((s) => s.permissionDialogFor);
  const close = useStore((s) => s.openPermissionDialog);
  const session = useStore((s) =>
    agentId
      ? [...s.sessions, ...s.exitedSessions].find((x) => x.id === agentId)
      : undefined,
  );
  if (!agentId || !session) return null;
  const runtime = session.provider as Provider;
  if (!PERMISSION_RUNTIMES.includes(runtime)) return null;
  return (
    <Dialog
      key={agentId}
      agentId={agentId}
      name={session.name}
      runtime={runtime}
      current={session.permission ?? completePermission(runtime)}
      onClose={() => close(null)}
    />
  );
}

function Dialog({
  agentId,
  name,
  runtime,
  current,
  onClose,
}: {
  agentId: string;
  name: string;
  runtime: Provider;
  current: RuntimePermission;
  onClose: () => void;
}) {
  const page = THEMES[useStore((s) => s.theme)].page;
  const restartWithPermission = useStore((s) => s.restartWithPermission);
  const defaults = useRuntimeDefaults();
  const [picked, setPicked] = useState<RuntimePermission>(current);
  const [step, setStep] = useState<Step>("pick");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const tone = neverAsksTone(page);

  useEffect(() => pushEscapeCloser(onClose), [onClose]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("select, button")?.focus();
  }, []);

  const unchanged = samePermission(picked, current);
  const widensToNever =
    neverAsks(picked) && widerAxes(current, picked).length > 0;

  async function send(opts: { confirm: boolean; fresh: boolean }) {
    setBusy(true);
    setError("");
    try {
      await restartWithPermission(agentId, {
        permission: picked.values,
        ...(opts.confirm ? { confirmNeverAsks: true } : {}),
        ...(opts.fresh ? { freshConversation: true } : {}),
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRM_NEVER_ASKS") {
        setStep("confirm-never");
      } else if (
        err instanceof ApiError &&
        err.code === "PERMISSION_NEEDS_FRESH_CONVERSATION"
      ) {
        setStep("needs-fresh");
      } else {
        setError(err instanceof Error ? err.message : "Restart failed");
      }
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (widensToNever && !confirmed) {
      setStep("confirm-never");
      return;
    }
    void send({ confirm: confirmed, fresh: false });
  }

  const button = (primary: boolean) =>
    ({
      className:
        "rounded px-3 py-1.5 text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
      style: primary
        ? { background: "#238636", color: "#fff" }
        : { background: page.border, color: page.fg },
    }) as const;

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop closes on click; Esc is the keyboard path
    <div
      className="fixed inset-0 z-[65] flex items-start justify-center overflow-y-auto p-3 pt-[10vh]"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="perm-dialog-title"
        data-testid="permission-dialog"
        className="flex w-[560px] max-w-full flex-col gap-3 rounded-md p-4 text-xs shadow-lg"
        style={{
          background: page.bg,
          color: page.fg,
          border: `1px solid ${page.border}`,
        }}
      >
        <div className="flex flex-col gap-1">
          <h2 id="perm-dialog-title" className="text-sm font-semibold">
            Permission for {name}
          </h2>
          <div style={{ color: page.statusFg }}>
            {RUNTIME_NAMES[runtime]}'s own values. Applying restarts the agent
            in the same conversation.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span style={{ color: page.statusFg }}>Now</span>
            <PermissionChip permission={current} page={page} />
          </div>
        </div>

        <RuntimeAxisFields
          permission={picked}
          onChange={(p) => {
            setPicked(p);
            setStep("pick");
            setConfirmed(false);
          }}
          page={page}
          defaults={knownDefault(defaults, runtime)}
          idPrefix={`perm-${agentId}`}
        />

        <div className="flex flex-wrap items-center gap-2">
          <span style={{ color: page.statusFg }}>Will run as</span>
          <PermissionChip permission={picked} page={page} />
        </div>
        <PermissionNotes permission={picked} page={page} />

        {step === "confirm-never" && (
          <div
            data-testid="permission-confirm-never"
            className="rounded px-2 py-1.5 leading-relaxed"
            style={{ color: tone.fg, background: tone.bg }}
          >
            <span className="font-mono">{formatPermission(picked)}</span> never
            asks before acting: {name} will run every action without asking you.
            Restart it with this anyway?
          </div>
        )}

        {step === "needs-fresh" && (
          <div
            data-testid="permission-needs-fresh"
            className="rounded px-2 py-1.5 leading-relaxed"
            style={{ color: page.fg, background: "rgba(83,189,250,0.10)" }}
          >
            A resumed {RUNTIME_NAMES[runtime]} conversation keeps the
            permissions it started with, so this can't apply to {name}'s current
            conversation. Restart it with a FRESH conversation to use it: the
            agent starts over, and its current conversation stays on disk.
          </div>
        )}

        {error && <div style={{ color: "#ea6c73" }}>{error}</div>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} {...button(false)}>
            Cancel
          </button>
          {step === "needs-fresh" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void send({ confirm: confirmed, fresh: true })}
              {...button(true)}
            >
              {busy ? "Restarting…" : "Restart with a fresh conversation"}
            </button>
          ) : step === "confirm-never" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmed(true);
                void send({ confirm: true, fresh: false });
              }}
              className="rounded px-3 py-1.5 text-xs cursor-pointer font-medium disabled:opacity-50"
              style={{ background: tone.fg, color: page.bg }}
            >
              {busy ? "Restarting…" : "Restart with it anyway"}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || unchanged}
              onClick={apply}
              {...button(true)}
            >
              {busy
                ? "Restarting…"
                : unchanged
                  ? "No change"
                  : "Restart with this"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
