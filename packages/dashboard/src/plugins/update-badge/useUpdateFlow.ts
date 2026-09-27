/**
 * The in-app update state machine (ADR-105), owned by the status-bar pill.
 *
 * Two independent axes:
 *  - `view`     — which modal screen is showing (or "closed"). Purely UI;
 *                 closing it never affects a run (the job runs on the server).
 *                 `confirm` is the one decision screen (notes, the live agent
 *                 check and the buttons together); `waiting` is an armed
 *                 wait-for-idle, reopened from the amber pill.
 *  - `tracking` — what we are following on the server:
 *      none         nothing scheduled or running
 *      armed        waiting-for-idle; poll GET /api/system/upgrade (~2s)
 *      running      job launched; same poll, drives the step list
 *      reconnecting daemon down / restarting; poll /api/system/version (1s)
 *
 * "Our run" = a status record whose startedAt differs from the one present
 * when we armed/launched (`baseline`). Identity, not timestamps, so client /
 * server clock skew can't misattribute a previous run's leftover record.
 *
 * Auth-continuity invariant: a 401 after the restart is surfaced as an
 * explicit error — never a silent bounce to the login page.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/core";
import {
  type SystemSnapshots,
  systemApi,
  type UpgradeState,
  type UpgradeStatusRecord,
} from "../../api/system";
import { useUpdateBus } from "./updateBus";
import { isLiveRun, stageDetail, writeUpdatedFlag } from "./updateFlow";

/** Mutable so tests can shrink the waits; production never touches it. */
export const updateTiming = {
  /** Poll cadence while armed / running / on the check screen. */
  pollMs: 2_000,
  /** Probe cadence during the restart gap. */
  reconnectMs: 1_000,
  /** After this long with no answer, tell the operator to look at the host. */
  giveUpMs: 3 * 60_000,
};

export type FlowView =
  | "closed"
  | "confirm"
  | "waiting"
  | "notSupervised"
  | "updating"
  | "failed"
  | "authRejected"
  | "restoreConfirm";

export type RestoreInfo =
  | { kind: "loading" }
  | { kind: "ok"; data: SystemSnapshots }
  | { kind: "error"; message: string };

export type Tracking = "none" | "armed" | "running" | "reconnecting";

function isUnreachable(err: unknown): boolean {
  // 0 = never reached; 5xx = a proxy (or a half-started daemon) answering
  // for a server that isn't there yet.
  return err instanceof ApiError && (err.status === 0 || err.status >= 500);
}

function is401(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/** `enabled` = the server answered /api/system/version (so the routes exist):
 *  recover armed / in-flight state once. */
export function useUpdateFlow(enabled: boolean) {
  const [view, setView] = useState<FlowView>("closed");
  const [tracking, setTracking] = useState<Tracking>("none");
  const [upgrade, setUpgrade] = useState<UpgradeState | null>(null);
  const [record, setRecord] = useState<UpgradeStatusRecord | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** A one-line outcome for screen readers when no dialog is left to say it
   *  (a cancel from the pill closes everything). */
  const [notice, setNotice] = useState<string | null>(null);
  const [reconnectStart, setReconnectStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [restore, setRestore] = useState<RestoreInfo>({ kind: "loading" });
  /** Which command the not-supervised screen should hand over. */
  const [terminalFor, setTerminalFor] = useState<"upgrade" | "rollback">(
    "upgrade",
  );

  const baseline = useRef<string | null>(null);
  const interrupted = useRef<string[]>([]);
  const finished = useRef(false);
  /** Set when THIS tab started a Restore: whether a snapshot pairs with it. */
  const restoreWithSnapshot = useRef<boolean | undefined>(undefined);

  const isOurs = useCallback(
    (rec: UpgradeStatusRecord | null): rec is UpgradeStatusRecord =>
      rec !== null && rec.startedAt !== baseline.current,
    [],
  );

  const enterReconnect = useCallback(() => {
    setTracking("reconnecting");
    setReconnectStart((s) => s ?? Date.now());
  }, []);

  /** React to our run's record. `servingVersion` is who answered. */
  const handleRecord = useCallback(
    (rec: UpgradeStatusRecord, servingVersion: string, inFlight?: boolean) => {
      setRecord(rec);
      switch (rec.phase) {
        case "restarting":
          enterReconnect();
          return;
        case "done":
          if (rec.to && servingVersion === rec.to) {
            if (finished.current) return;
            finished.current = true;
            writeUpdatedFlag(
              rec.kind === "rollback"
                ? {
                    kind: "rollback",
                    updatedTo: rec.to,
                    interruptedNames: interrupted.current,
                    withSnapshot: restoreWithSnapshot.current,
                    message: rec.message,
                  }
                : {
                    kind: "upgrade",
                    updatedTo: rec.to,
                    interruptedNames: interrupted.current,
                  },
            );
            // New asset hashes: only a real reload picks up the new bundle.
            window.location.reload();
          } else {
            // The record says done but the old build answered — keep waiting
            // for the new one (the give-up timer still bounds this).
            enterReconnect();
          }
          return;
        case "rolled_back":
        case "failed":
          setTracking("none");
          setReconnectStart(null);
          setView("failed");
          return;
        case "up_to_date":
          setTracking("none");
          setReconnectStart(null);
          setView("closed");
          return;
        default:
          // Non-terminal but no longer live: the job died without a final
          // write (or never started). Say so instead of following it forever.
          // Liveness is the server's call when it made one — a browser clock
          // minutes off would otherwise misjudge it either way.
          if (!(inFlight ?? isLiveRun(rec))) {
            setRecord({
              ...rec,
              phase: "failed",
              message: `The ${rec.kind === "rollback" ? "restore" : "update"} stopped responding (last step: ${stageDetail(rec.phase, rec.to ?? "", { rollback: rec.kind === "rollback" }).replace(/…$/, "")}). Run autonomos status on the machine running autonomOS.`,
            });
            setTracking("none");
            setReconnectStart(null);
            setView("failed");
            return;
          }
          // Post-restart, the new daemon is up but not yet proven: still part
          // of "Restarting", so the overlay stays up until the reload instead
          // of flashing away and leaving a spinner behind it.
          if (rec.phase === "health_check") {
            enterReconnect();
            return;
          }
          // A live pre-restart phase answered: we're connected. A blip that
          // put us in "reconnecting" must not keep its give-up clock running
          // through a minutes-long build.
          setReconnectStart(null);
          setTracking("running");
          return;
      }
    },
    [enterReconnect],
  );

  // ── recover state after a page load (armed, or a run already going) ──
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    systemApi
      .upgradeState({ signal: ctrl.signal })
      .then((s) => {
        setUpgrade(s);
        if (s.armed) {
          baseline.current = s.status?.startedAt ?? null;
          interrupted.current = [];
          setTracking("armed");
        } else if (s.inFlight ?? isLiveRun(s.status)) {
          baseline.current = null;
          setRecord(s.status);
          setTracking("running");
        }
      })
      .catch(() => {
        // Older server without the route, or offline: the pill still works;
        // the flow re-fetches when the operator opens it.
      });
    return () => ctrl.abort();
  }, [enabled]);

  // ── armed / running: poll the upgrade state ──
  useEffect(() => {
    if (tracking !== "armed" && tracking !== "running") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await systemApi.upgradeState({
          signal: AbortSignal.timeout(5_000),
        });
        if (!alive) return;
        setUpgrade(s);
        const rec = s.status;
        if (tracking === "armed") {
          if (!isOurs(rec)) {
            // No armed record and no run of ours: cancelled elsewhere.
            if (!s.armed) {
              setTracking("none");
              return;
            }
            // Still waiting for idle — keep polling (below) so the pill
            // follows the agents and the launch is picked up when it fires.
            interrupted.current = s.busy.map((b) => b.name);
          } else {
            setTracking("running");
            setView("updating");
          }
        }
        if (isOurs(rec)) handleRecord(rec, s.current, s.inFlight);
      } catch (err) {
        if (!alive) return;
        // Signed out (token rotated) while armed or running: stop polling a
        // session that will never answer, and say why.
        if (is401(err)) {
          setTracking("none");
          setView("authRejected");
          return;
        }
        if (isUnreachable(err)) {
          enterReconnect();
          return;
        }
      }
      if (alive) timer = setTimeout(tick, updateTiming.pollMs);
    };
    timer = setTimeout(tick, tracking === "running" ? 0 : updateTiming.pollMs);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [tracking, isOurs, handleRecord, enterReconnect]);

  // ── reconnecting: probe the cheap version route, then re-read status ──
  useEffect(() => {
    if (tracking !== "reconnecting") return;
    let alive = true;
    let busy = false;
    const probe = async () => {
      setNow(Date.now());
      if (busy || finished.current) return;
      busy = true;
      try {
        const v = await systemApi.version({
          signal: AbortSignal.timeout(Math.max(500, updateTiming.reconnectMs)),
        });
        const s = await systemApi.upgradeState({
          signal: AbortSignal.timeout(5_000),
        });
        if (!alive) return;
        setUpgrade(s);
        if (isOurs(s.status)) handleRecord(s.status, v.version, s.inFlight);
      } catch (err) {
        if (!alive) return;
        if (is401(err)) {
          setTracking("none");
          setReconnectStart(null);
          setView("authRejected");
        }
        // Anything else: still down — keep probing.
      } finally {
        busy = false;
      }
    };
    const id = setInterval(probe, updateTiming.reconnectMs);
    void probe();
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [tracking, isOurs, handleRecord]);

  // ── the confirm screen's live agent check ──
  const loadCheck = useCallback(async (quiet = false) => {
    if (!quiet) {
      setUpgrade(null);
      setCheckError(null);
    }
    try {
      const s = await systemApi.upgradeState({
        signal: AbortSignal.timeout(5_000),
      });
      setUpgrade(s);
      setCheckError(null);
      if (!s.supervised) {
        setTerminalFor("upgrade");
        setView("notSupervised");
      }
    } catch (err) {
      if (!quiet) setCheckError(errText(err));
    }
  }, []);

  // Keep the busy list live while the operator is deciding.
  useEffect(() => {
    if (view !== "confirm") return;
    const id = setInterval(() => void loadCheck(true), updateTiming.pollMs);
    return () => clearInterval(id);
  }, [view, loadCheck]);

  /** Open (or return to) the decision screen with a fresh agent check. */
  const review = useCallback(() => {
    setActionError(null);
    setView("confirm");
    void loadCheck();
  }, [loadCheck]);

  const start = useCallback(
    async (when: "idle" | "now", expectedVersion?: string) => {
      setPending(true);
      setActionError(null);
      baseline.current = upgrade?.status?.startedAt ?? null;
      interrupted.current =
        when === "now" ? (upgrade?.busy ?? []).map((b) => b.name) : [];
      try {
        const r = await systemApi.startUpgrade(when, expectedVersion);
        if ("armed" in r) {
          setUpgrade((u) => (u ? { ...u, armed: r.armed } : u));
          setTracking("armed");
          setView("waiting");
        } else {
          setRecord(null);
          setTracking("running");
          setView("updating");
        }
      } catch (err) {
        const code = err instanceof ApiError ? err.code : undefined;
        if (code === "NOT_SUPERVISED") {
          setTerminalFor("upgrade");
          setView("notSupervised");
        } else if (code === "IN_FLIGHT") {
          // Someone (another tab, the CLI) already started one — follow it.
          baseline.current = null;
          setTracking("running");
          setView("updating");
        } else if (code === "NO_UPDATE") {
          setActionError("You're already on the latest version.");
          setView((v) => (v === "closed" ? "confirm" : v));
        } else if (code === "VERSION_CHANGED") {
          // A newer release appeared since the notes were shown: show ITS
          // notes (the notes screen refetches on mount) before any install.
          setActionError(errText(err));
          useUpdateBus.getState().refreshVersion();
          setView("confirm");
        } else {
          setActionError(errText(err));
          setView((v) => (v === "closed" ? "confirm" : v));
        }
      } finally {
        setPending(false);
      }
    },
    [upgrade],
  );

  const cancelArmed = useCallback(async () => {
    setActionError(null);
    const target = upgrade?.armed?.target;
    try {
      await systemApi.cancelUpgrade();
      setUpgrade((u) => (u ? { ...u, armed: null } : u));
      setTracking("none");
      setView("closed");
      setNotice(
        `Scheduled update cancelled.${target ? ` Update to v${target} is still available.` : ""}`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === "LAUNCHED") {
        // The idle window closed first: the update is already running —
        // follow it rather than pretend it was cancelled.
        baseline.current = null;
        setUpgrade((u) => (u ? { ...u, armed: null } : u));
        setTracking("running");
        setView("updating");
        return;
      }
      setActionError(`Couldn't cancel the scheduled update: ${errText(err)}`);
    }
  }, [upgrade]);

  // ── Restore (the in-app `autonomos rollback`) ──
  const openRestore = useCallback(() => {
    setActionError(null);
    setRestore({ kind: "loading" });
    setView("restoreConfirm");
    systemApi
      .snapshots({ signal: AbortSignal.timeout(5_000) })
      .then((data) => setRestore({ kind: "ok", data }))
      .catch((err) => setRestore({ kind: "error", message: errText(err) }));
  }, []);

  const confirmRestore = useCallback(async () => {
    if (restore.kind !== "ok" || !restore.data.rollback) return;
    setPending(true);
    setActionError(null);
    try {
      // Baseline = the record present BEFORE we launch, read fresh (the
      // restore can start from Settings, where no state has been loaded).
      const before = await systemApi
        .upgradeState({ signal: AbortSignal.timeout(5_000) })
        .catch(() => null);
      if (before) setUpgrade(before);
      baseline.current = before?.status?.startedAt ?? null;
      interrupted.current = [];
      const r = await systemApi.startRollback();
      restoreWithSnapshot.current =
        (r.target ?? restore.data.rollback).snapshotId !== null;
      setRecord(null);
      setTracking("running");
      setView("updating");
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === "NOT_SUPERVISED") {
        setTerminalFor("rollback");
        setView("notSupervised");
      } else if (code === "IN_FLIGHT") {
        baseline.current = null;
        setTracking("running");
        setView("updating");
      } else if (code === "NO_ROLLBACK") {
        setActionError("There's no previous version to restore.");
      } else {
        setActionError(errText(err));
      }
    } finally {
      setPending(false);
    }
  }, [restore]);

  const open = useCallback(() => {
    setNotice(null);
    if (tracking === "running" || tracking === "reconnecting") {
      setActionError(null);
      setView("updating");
    } else if (tracking === "armed") {
      setView("waiting");
    } else {
      review();
    }
  }, [tracking, review]);

  const close = useCallback(() => setView("closed"), []);

  const elapsedMs = reconnectStart === null ? 0 : now - reconnectStart;

  return {
    view,
    tracking,
    upgrade,
    record,
    checkError,
    actionError,
    pending,
    notice,
    elapsedMs,
    gaveUp: tracking === "reconnecting" && elapsedMs >= updateTiming.giveUpMs,
    open,
    close,
    review,
    restore,
    terminalFor,
    openRestore,
    confirmRestore,
    retryCheck: () => void loadCheck(),
    start,
    cancelArmed,
  };
}

export type UpdateFlow = ReturnType<typeof useUpdateFlow>;
