// @vitest-environment jsdom
import type { AgentTemplate } from "@autonomos/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { templatesApi } from "../api/config";
import { useStore } from "../store";
import { TemplatesPanel } from "./TemplatesPanel";

// The panel reads the shared templatesPoll and mutates via templatesApi —
// mock both at the module seam (the store slices it used to read are gone).
vi.mock("../api/config", () => ({
  templatesApi: {
    save: vi.fn(async () => ({ ok: true, message: "" })),
    remove: vi.fn(async () => ({ ok: true })),
  },
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
 * resurrect a capabilities control, and the editor must round-trip
 * permissionMode rather than quietly demoting a template to the safe default.
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

const saveTemplate = vi.mocked(templatesApi.save);

beforeEach(() => {
  saveTemplate.mockClear();
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

  it("shows each template's permission mode on its card", () => {
    // This slot used to read "N capabilities" — a count of a field that
    // controlled nothing. permissionMode is what actually governs the agent.
    render(<TemplatesPanel />);
    expect(screen.getByText("bypass")).toBeInTheDocument();
    expect(screen.getByText("plan")).toBeInTheDocument();
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

  it("round-trips permissionMode when saving an edited template", async () => {
    // A template migrated to "bypass" must not be silently demoted to the
    // default just because the operator edited its description.
    const user = userEvent.setup();
    render(<TemplatesPanel />);

    await user.click(screen.getByText("Feature Worker"));
    const save = await screen.findByRole("button", { name: /save|update/i });
    await user.click(save);

    await waitFor(() => expect(saveTemplate).toHaveBeenCalled());
    const [, payload] = saveTemplate.mock.calls[0];
    expect(payload.permissionMode).toBe("bypass");
    expect(payload).not.toHaveProperty("capabilities");
  });
});
