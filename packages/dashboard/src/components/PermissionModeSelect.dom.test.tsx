// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { PermissionModeSelect } from "./PermissionModeSelect";

/**
 * PermissionModeSelect — the shared dropdown + "?" explainer used by Settings
 * (global default) and Create Agent (per-spawn override). Covers the
 * interactive behavior the unit tests can't: the explainer toggle and the
 * provider-aware disabling of modes a provider can't represent (Codex/plan).
 */

const page = { fg: "#fff", statusFg: "#999", border: "#333" };

describe("PermissionModeSelect", () => {
  it("renders all four modes", () => {
    render(
      <PermissionModeSelect value="bypass" onChange={() => {}} page={page} />,
    );
    for (const label of ["Ask", "Accept edits", "Plan", "Bypass"]) {
      expect(
        screen.getByRole("option", { name: new RegExp(label) }),
      ).toBeInTheDocument();
    }
  });

  it("toggles the current-selection explainer on '?' click", async () => {
    const user = userEvent.setup();
    render(
      <PermissionModeSelect value="plan" onChange={() => {}} page={page} />,
    );
    // Hidden until clicked.
    expect(screen.queryByText(/read-only investigation/i)).toBeNull();
    await user.click(
      screen.getByRole("button", {
        name: /what does this permission mode do/i,
      }),
    );
    // Summary + the three provider rows appear.
    expect(screen.getByText(/read-only investigation/i)).toBeInTheDocument();
    expect(screen.getByText("Claude:")).toBeInTheDocument();
    expect(screen.getByText("Gemini:")).toBeInTheDocument();
    expect(screen.getByText("Codex:")).toBeInTheDocument();
  });

  it("disables 'plan' when the provider is Codex (and only then)", () => {
    const { rerender } = render(
      <PermissionModeSelect
        value="default"
        onChange={() => {}}
        page={page}
        provider="codex"
      />,
    );
    const planOption = screen.getByRole("option", {
      name: /Plan/,
    }) as HTMLOptionElement;
    expect(planOption.disabled).toBe(true);
    expect(planOption.textContent).toMatch(/n\/a/);

    // No provider → every mode selectable.
    rerender(
      <PermissionModeSelect value="default" onChange={() => {}} page={page} />,
    );
    expect(
      (screen.getByRole("option", { name: /^Plan$/ }) as HTMLOptionElement)
        .disabled,
    ).toBe(false);
  });

  it("does NOT disable plan for Claude/Gemini providers", () => {
    render(
      <PermissionModeSelect
        value="default"
        onChange={() => {}}
        page={page}
        provider="claude-code"
      />,
    );
    expect(
      (screen.getByRole("option", { name: /Plan/ }) as HTMLOptionElement)
        .disabled,
    ).toBe(false);
  });

  it("fires onChange with the chosen mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PermissionModeSelect value="bypass" onChange={onChange} page={page} />,
    );
    await user.selectOptions(screen.getByRole("combobox"), "plan");
    expect(onChange).toHaveBeenCalledWith("plan");
  });
});
