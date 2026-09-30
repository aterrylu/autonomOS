// @vitest-environment jsdom
import type { AgentTemplate } from "@autonomos/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { useStore } from "../store";
import { CreateAgentPanel } from "./CreateAgentPanel";

/**
 * CreateAgentPanel — the first-run "Create New Agent" UX. High value: it's the
 * entry point a user hits before any agent exists. We seed the store with
 * templates/projects and stub the two fetches it fires on mount
 * (`/api/providers`, plus fetchProjects/fetchTemplates), then assert the
 * user-facing behavior: layout, name-required validation, the Dispatcher
 * auto-default + "Recommended" badge, and that Create calls the store's
 * `createSession` with the resolved args.
 */

const dispatcherTemplate: AgentTemplate = {
  role: "Dispatcher",
  description: "Routes work to the right agents",
  systemPrompt: "You are the dispatcher.",
  permissionMode: "bypass",
};

const workerTemplate: AgentTemplate = {
  role: "Worker",
  description: "Does focused implementation work",
  systemPrompt: "You are a worker.",
};

let createSession: ReturnType<typeof vi.fn>;
/** What GET /api/settings serves — the operator's per-runtime defaults. */
let runtimeDefaults: Record<string, unknown>;

const caps = {
  messaging: { inbound: true, outbound: true },
  hooks: { eventCount: 13, requiresSetup: false },
  liveStatus: { supported: true, method: "hooks" },
  systemPrompt: { supported: true },
};

beforeEach(() => {
  createSession = vi.fn(() => Promise.resolve());
  runtimeDefaults = {};

  useStore.setState({
    projects: [],
    status: "ready",
    createSession,
    // Stub the fetch-on-mount store action so no network is hit.
    fetchProjects: () => Promise.resolve(),
  });

  // Templates/presets now come from the shared polls, which fetch through the
  // real api client — serve REAL Response JSON (the client reads res.text()).
  const providers = [
    {
      name: "claude-code",
      displayName: "Claude Code",
      installed: true,
      version: "1.0.0",
      recommended: true,
      capabilities: caps,
    },
    {
      name: "codex",
      displayName: "Codex",
      installed: true,
      version: "0.154.0",
      recommended: false,
      capabilities: caps,
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const body = (data: unknown) =>
        Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
      if (typeof url === "string" && url.includes("/api/providers")) {
        return body(providers);
      }
      if (typeof url === "string" && url.includes("/api/templates")) {
        return body({ dispatcher: dispatcherTemplate, worker: workerTemplate });
      }
      if (typeof url === "string" && url.includes("/api/settings")) {
        return body({ runtimeDefaults });
      }
      if (typeof url === "string" && url.includes("/api/env-presets")) {
        return body({});
      }
      return body([]);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CreateAgentPanel", () => {
  it("renders the panel header and the Create button", () => {
    render(<CreateAgentPanel />);
    expect(
      screen.getByRole("heading", { name: /create new agent/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create agent/i }),
    ).toBeInTheDocument();
  });

  it("auto-defaults to the Dispatcher template and shows the Recommended badge", async () => {
    render(<CreateAgentPanel />);
    // The "Recommended" badge only renders for the dispatcher card.
    expect(await screen.findByText("Recommended")).toBeInTheDocument();
    // Auto-default also seeds the name input from the dispatcher role.
    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText(
        /Dispatcher, Researcher/i,
      ) as HTMLInputElement;
      expect(nameInput.value).toBe("Dispatcher");
    });
  });

  it("shows a validation error when the name is blank", async () => {
    const user = userEvent.setup();
    render(<CreateAgentPanel />);

    // Wait for auto-default, then clear the name.
    const nameInput = (await screen.findByPlaceholderText(
      /Dispatcher, Researcher/i,
    )) as HTMLInputElement;
    await user.clear(nameInput);

    await user.click(screen.getByRole("button", { name: /create agent/i }));

    expect(screen.getByText(/agent name is required/i)).toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("calls createSession with the chosen name, dir, provider and template", async () => {
    const user = userEvent.setup();
    render(<CreateAgentPanel />);

    const nameInput = (await screen.findByPlaceholderText(
      /Dispatcher, Researcher/i,
    )) as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "Scout");

    await user.click(screen.getByRole("button", { name: /create agent/i }));

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    const [dir, opts] = createSession.mock.calls[0];
    expect(dir).toBe("~"); // Home is the default working directory
    expect(opts).toMatchObject({
      name: "Scout",
      provider: "claude-code",
      template: "dispatcher",
      appendSystemPrompt: dispatcherTemplate.systemPrompt,
    });
    // Nothing was picked here, so nothing is sent: the server resolves the
    // template's pin, then the operator's default (ADR-115) — "the caller said
    // nothing" must survive to the server (ADR-061).
    expect(opts.permission).toBeUndefined();
    expect(opts).not.toHaveProperty("permissionMode");
  });

  it("shows what the agent will run as, and where it comes from — amber when it never asks", async () => {
    render(<CreateAgentPanel />);
    // The dispatcher here pins the legacy `bypass`, which is what it ran.
    const picker = await screen.findByTestId("permission-picker");
    await waitFor(() =>
      expect(
        within(picker).getByText("pinned by the dispatcher template"),
      ).toBeInTheDocument(),
    );
    const chip = picker.querySelector("[data-permission-chip]");
    expect(chip?.textContent).toBe("bypassPermissions");
    expect(
      within(picker).getByText("Never asks before acting."),
    ).toBeInTheDocument();
  });

  it("with no template, shows YOUR default from Settings → Runtimes", async () => {
    runtimeDefaults = {
      "claude-code": {
        runtime: "claude-code",
        values: { "permission-mode": "acceptEdits" },
      },
    };
    const user = userEvent.setup();
    render(<CreateAgentPanel />);
    await user.click(await screen.findByText("None"));
    const picker = screen.getByTestId("permission-picker");
    await waitFor(() =>
      expect(picker.querySelector("[data-permission-chip]")?.textContent).toBe(
        "acceptEdits",
      ),
    );
    expect(
      within(picker).getByText("your Claude Code default"),
    ).toBeInTheDocument();
    expect(
      within(picker).queryByText("Never asks before acting."),
    ).not.toBeInTheDocument();
  });

  it("a value picked here is sent in the runtime's own values", async () => {
    const user = userEvent.setup();
    render(<CreateAgentPanel />);
    const picker = await screen.findByTestId("permission-picker");
    await user.click(within(picker).getByRole("button", { name: /^plan/ }));
    expect(within(picker).getByText("chosen here")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][1].permission).toEqual({
      "permission-mode": "plan",
    });
  });

  it("Codex: its launch axes only — Plan is a Shift+Tab hint, not an option", async () => {
    const user = userEvent.setup();
    render(<CreateAgentPanel />);
    await user.click(await screen.findByText("Codex"));
    const picker = screen.getByTestId("permission-picker");
    for (const axis of [
      "approval_policy",
      "sandbox_mode",
      "approvals_reviewer",
    ])
      expect(within(picker).getByText(axis)).toBeInTheDocument();
    expect(
      within(picker).queryByText("collaboration_mode"),
    ).not.toBeInTheDocument();
    expect(within(picker).getByText("Shift+Tab")).toBeInTheDocument();
  });

  it("renders a card for each available template", async () => {
    render(<CreateAgentPanel />);
    // Roles from both seeded templates plus the built-in "None" card.
    expect(await screen.findByText("None")).toBeInTheDocument();
    expect(screen.getByText("Dispatcher")).toBeInTheDocument();
    expect(screen.getByText("Worker")).toBeInTheDocument();
  });
});
