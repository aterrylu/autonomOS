// @vitest-environment jsdom
import { completePermission } from "@autonomos/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { ApiError } from "../api/core";
import { type SessionInfo, useStore } from "../store";
import { PermissionDialog } from "./PermissionDialog";

/**
 * Permission… — restart one agent with a chosen permission. The dialog sends
 * the runtime's own values, never widens to a never-asks value without an
 * explicit confirm, and offers a FRESH conversation explicitly when the server
 * says a resumed Codex thread can't take the change.
 */

let restartWithPermission: ReturnType<typeof vi.fn>;

function session(over: Partial<SessionInfo>): SessionInfo {
  return {
    id: "a1",
    name: "worker",
    status: "running",
    workingDirectory: "/w",
    provider: "claude-code",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as SessionInfo;
}

beforeEach(() => {
  restartWithPermission = vi.fn(async () => {});
  // The dialog reads the operator defaults (GET /api/settings) to mark them.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ runtimeDefaults: {} }))),
  );
  useStore.setState({
    theme: "midnight",
    sessions: [
      session({
        permission: completePermission("claude-code", {
          "permission-mode": "auto",
        }),
      }),
      session({
        id: "cx1",
        name: "coder",
        provider: "codex",
        permission: completePermission("codex", {}),
      }),
    ],
    exitedSessions: [],
    restartWithPermission,
    permissionDialogFor: null,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useStore.setState({ permissionDialogFor: null });
});

const open = (id: string) => useStore.setState({ permissionDialogFor: id });

describe("PermissionDialog", () => {
  it("shows the agent's current value and sends the picked one in the runtime's own values", async () => {
    const user = userEvent.setup();
    open("a1");
    render(<PermissionDialog />);
    const dialog = await screen.findByTestId("permission-dialog");
    expect(dialog.querySelector("[data-permission-chip]")?.textContent).toBe(
      "auto",
    );
    await user.selectOptions(
      within(dialog).getByLabelText("permission-mode"),
      "acceptEdits",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Restart with this" }),
    );
    await waitFor(() => expect(restartWithPermission).toHaveBeenCalledTimes(1));
    expect(restartWithPermission).toHaveBeenCalledWith("a1", {
      permission: { "permission-mode": "acceptEdits" },
    });
    expect(useStore.getState().permissionDialogFor).toBe(null);
  });

  it("an unchanged value can't be applied", async () => {
    open("a1");
    render(<PermissionDialog />);
    expect(
      await screen.findByRole("button", { name: "No change" }),
    ).toBeDisabled();
  });

  it("a widening to a value that NEVER asks asks first, then sends the confirm", async () => {
    const user = userEvent.setup();
    open("a1");
    render(<PermissionDialog />);
    const dialog = await screen.findByTestId("permission-dialog");
    await user.selectOptions(
      within(dialog).getByLabelText("permission-mode"),
      "bypassPermissions",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Restart with this" }),
    );
    expect(
      within(dialog).getByTestId("permission-confirm-never"),
    ).toBeInTheDocument();
    expect(restartWithPermission).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Restart with it anyway" }),
    );
    await waitFor(() =>
      expect(restartWithPermission).toHaveBeenCalledWith("a1", {
        permission: { "permission-mode": "bypassPermissions" },
        confirmNeverAsks: true,
      }),
    );
  });

  it("Codex: when the server says the thread can't take it, offer a FRESH conversation explicitly", async () => {
    const user = userEvent.setup();
    restartWithPermission.mockRejectedValueOnce(
      new ApiError("keeps its permissions", 409, {
        code: "PERMISSION_NEEDS_FRESH_CONVERSATION",
      }),
    );
    open("cx1");
    render(<PermissionDialog />);
    const dialog = await screen.findByTestId("permission-dialog");
    await user.selectOptions(
      within(dialog).getByLabelText("sandbox_mode"),
      "read-only",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Restart with this" }),
    );
    expect(
      await within(dialog).findByTestId("permission-needs-fresh"),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", {
        name: "Restart with a fresh conversation",
      }),
    );
    await waitFor(() => expect(restartWithPermission).toHaveBeenCalledTimes(2));
    expect(restartWithPermission.mock.calls[1][1]).toMatchObject({
      permission: { sandbox_mode: "read-only" },
      freshConversation: true,
    });
  });
});
