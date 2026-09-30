// @vitest-environment jsdom
import type { AgentTemplate } from "@autonomos/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { templatesApi } from "../api/config";
import { useStore } from "../store";
import { TemplatesPanel } from "./TemplatesPanel";

// The panel reads the shared templatesPoll and mutates via templatesApi —
// mock both at the module seam (the store slices it used to read are gone).
// The operator's per-runtime defaults (GET /api/settings), per test.
let runtimeDefaults: Record<string, unknown> = {};
vi.mock("../api/config", () => ({
  templatesApi: {
    save: vi.fn(async () => ({ ok: true, message: "" })),
    remove: vi.fn(async () => ({ ok: true })),
  },
  settingsApi: { get: vi.fn(async () => ({ runtimeDefaults })) },
}));
// getSnapshot must return a REFERENCE-STABLE object or useSyncExternalStore
// re-renders forever ("maximum update depth exceeded").
let pollSnapshot: { data: Record<string, unknown>; error: null } = {
  data: {},
  error: null,
};
function seedPoll(data: Record<string, unknown>): void {
  pollSnapshot = { data, error: null };
}
vi.mock("../api/polls", () => ({
  templatesPoll: {
    subscribe: () => () => {},
    getSnapshot: () => pollSnapshot,
    refresh: vi.fn(async () => {}),
  },
}));

/**
 * TemplatesPanel had NO test coverage, which is part of why ADR-058 happened:
 * the capability checkboxes it rendered drifted to a different set than the
 * server's (the UI could not grant `self_exit` at all) and nothing caught it.
 * These tests pin the properties that replaced them — the panel must not
 * resurrect a capabilities control, and the editor must round-trip a
 * template's permissions rather than quietly demoting it to the safe default.
 */

const bypassTemplate: AgentTemplate = {
  role: "Feature Worker",
  description: "Implements features end to end",
  systemPrompt: "You are a Feature Worker.",
  permissionMode: "bypass",
};

const planTemplate: AgentTemplate = {
  role: "Reviewer",
  description: "Reads and reports",
  systemPrompt: "You are a Reviewer.",
  permissionMode: "plan",
};

/** Pins in the runtimes' own values (ADR-115), plus a field the editor
 *  doesn't show — both must survive a save. */
const pinnedTemplate: AgentTemplate = {
  role: "Scout",
  description: "Looks around",
  systemPrompt: "You are a Scout.",
  permissions: {
    "claude-code": { "permission-mode": "manual" },
    codex: { approval_policy: "never", sandbox_mode: "workspace-write" },
  },
  model: "opus",
};

const saveTemplate = vi.mocked(templatesApi.save);

const card = (role: string) =>
  screen.getByText(role).closest("[role=button]") as HTMLElement;
const pinRow = (scope: HTMLElement, runtime: string) =>
  scope.querySelector(`[data-runtime="${runtime}"]`) as HTMLElement;

beforeEach(() => {
  saveTemplate.mockClear();
  runtimeDefaults = {};
  seedPoll({ "feature-worker": bypassTemplate, reviewer: planTemplate });
  useStore.setState({ theme: "midnight", sessions: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TemplatesPanel", () => {
  it("lists templates by role", () => {
    render(<TemplatesPanel />);
    expect(screen.getByText("Feature Worker")).toBeInTheDocument();
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
  });

  it("shows each template's permission per runtime, in the runtime's own values", () => {
    // This slot used to read "N capabilities" — a count of a field that
    // controlled nothing. The permission is what actually governs the agent;
    // a legacy mode shows as what it ran on each runtime.
    render(<TemplatesPanel />);
    const chip = (role: string, runtime: string) =>
      pinRow(card(role), runtime).querySelector("[data-permission-chip]")
        ?.textContent;
    expect(chip("Feature Worker", "claude-code")).toBe("bypassPermissions");
    expect(chip("Feature Worker", "codex")).toBe(
      "approval_policy=never · sandbox_mode=danger-full-access",
    );
    expect(chip("Feature Worker", "gemini-cli")).toBe("yolo");
    expect(chip("Reviewer", "gemini-cli")).toBe("plan");
  });

  it("a runtime the template doesn't pin says it follows your default", async () => {
    seedPoll({ scout: pinnedTemplate });
    render(<TemplatesPanel />);
    const gemini = pinRow(card("Scout"), "gemini-cli");
    expect(
      within(gemini).getByText("follows your default"),
    ).toBeInTheDocument();
    expect(
      within(gemini).queryByRole("button", { name: "Use default" }),
    ).not.toBeInTheDocument();
  });

  it("offers no capabilities control once the editor is open", async () => {
    // The regression guard for ADR-058: re-adding a checkbox grid here would
    // recreate a UI that claims to restrict agents but cannot. Assert against
    // the OPEN editor — the list view never had the control, so checking only
    // the list would pass no matter what the form contains.
    const user = userEvent.setup();
    render(<TemplatesPanel />);
    await user.click(screen.getByText("Feature Worker"));
    await screen.findByRole("button", { name: /save|update/i });

    expect(screen.queryByText(/capabilit/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    // Sanity: the editor really is open, so the assertions above had a chance
    // to fail rather than passing on an unrendered form.
    expect(
      screen.getByDisplayValue("You are a Feature Worker."),
    ).toBeInTheDocument();
  });

  it("saving a legacy-mode template writes the explicit pins it always ran", async () => {
    // A "bypass" template must not be silently demoted to the default just
    // because the operator edited its description — its legacy mode becomes
    // the per-runtime values it actually ran.
    const user = userEvent.setup();
    render(<TemplatesPanel />);

    await user.click(screen.getByText("Feature Worker"));
    const save = await screen.findByRole("button", { name: /save|update/i });
    await user.click(save);

    await waitFor(() => expect(saveTemplate).toHaveBeenCalled());
    const [, payload] = saveTemplate.mock.calls[0];
    expect(payload).not.toHaveProperty("permissionMode");
    expect(payload.permissions?.["claude-code"]?.["permission-mode"]).toBe(
      "bypassPermissions",
    );
    expect(payload.permissions?.codex?.approval_policy).toBe("never");
    expect(payload.permissions?.["gemini-cli"]?.["approval-mode"]).toBe("yolo");
    expect(payload).not.toHaveProperty("capabilities");
  });

  it("saving keeps the template's pins and the fields the editor doesn't show", async () => {
    // The bug this replaces: the editor rebuilt the payload from its own
    // fields, so a save silently dropped every canonical `permissions` pin.
    seedPoll({ scout: pinnedTemplate });
    const user = userEvent.setup();
    render(<TemplatesPanel />);
    await user.click(screen.getByText("Scout"));
    await user.click(await screen.findByRole("button", { name: /save/i }));

    await waitFor(() => expect(saveTemplate).toHaveBeenCalled());
    const [name, payload] = saveTemplate.mock.calls[0];
    expect(name).toBe("scout");
    expect(payload.permissions?.codex).toMatchObject({
      approval_policy: "never",
      sandbox_mode: "workspace-write",
    });
    expect(payload.permissions?.["claude-code"]?.["permission-mode"]).toBe(
      "manual",
    );
    expect(payload.permissions).not.toHaveProperty("gemini-cli");
    expect(payload.model).toBe("opus");
  });

  it("'Use default' never widens silently: it names what widens and asks first", async () => {
    runtimeDefaults = {
      "claude-code": {
        runtime: "claude-code",
        values: { "permission-mode": "acceptEdits" },
      },
    };
    seedPoll({ scout: pinnedTemplate });
    const user = userEvent.setup();
    render(<TemplatesPanel />);
    const claude = pinRow(card("Scout"), "claude-code");
    await waitFor(() =>
      expect(within(claude).getByText("acceptEdits")).toBeInTheDocument(),
    );
    await user.click(
      within(claude).getByRole("button", { name: "Use default" }),
    );

    const confirm = within(claude).getByTestId("confirm-use-default");
    expect(confirm.textContent).toContain(
      "permission-mode manual → acceptEdits",
    );
    expect(saveTemplate).not.toHaveBeenCalled();
    // …and the click didn't fall through to the card (open the editor).
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();

    await user.click(
      within(confirm).getByRole("button", { name: "Use default anyway" }),
    );
    await waitFor(() => expect(saveTemplate).toHaveBeenCalledTimes(1));
    const [, payload] = saveTemplate.mock.calls[0];
    expect(payload.permissions).not.toHaveProperty("claude-code");
    expect(payload.permissions?.codex?.approval_policy).toBe("never");
  });

  it("'Keep pin' cancels, and a default that's NARROWER than the pin needs no confirm", async () => {
    // defaults: built-in (codex on-request)
    seedPoll({ scout: pinnedTemplate, "feature-worker": bypassTemplate });
    const user = userEvent.setup();
    render(<TemplatesPanel />);
    const codex = pinRow(card("Scout"), "codex");
    // codex default: approval_policy=on-request · sandbox_mode=danger-full-access.
    // The pin never asks (wider on approval) but sandboxes writes (narrower on
    // sandbox) — the default widens sandbox_mode, so this asks.
    await user.click(
      within(codex).getByRole("button", { name: "Use default" }),
    );
    const confirm = within(codex).getByTestId("confirm-use-default");
    expect(confirm.textContent).toContain(
      "sandbox_mode workspace-write → danger-full-access",
    );
    expect(confirm.textContent).not.toContain("approval_policy never →");
    await user.click(within(confirm).getByRole("button", { name: "Keep pin" }));
    expect(within(codex).queryByTestId("confirm-use-default")).toBeNull();
    expect(saveTemplate).not.toHaveBeenCalled();

    // Feature Worker pins bypassPermissions; the default `manual` is narrower.
    const worker = pinRow(card("Feature Worker"), "claude-code");
    await user.click(
      within(worker).getByRole("button", { name: "Use default" }),
    );
    await waitFor(() => expect(saveTemplate).toHaveBeenCalledTimes(1));
    expect(within(worker).queryByTestId("confirm-use-default")).toBeNull();
  });
});
