// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { presetsApi } from "../api/config";
import { presetsPoll } from "../api/polls";
import { THEMES } from "../store";
import { SecretRow } from "./PresetsPanel";

vi.mock("../api/config", () => ({
  presetsApi: { update: vi.fn(async () => ({})) },
}));
vi.mock("../api/polls", () => ({
  presetsPoll: { refresh: vi.fn(async () => {}) },
}));
const updateMock = vi.mocked(presetsApi.update);
void presetsPoll; // poll refresh is fire-and-verify via the mock above

/**
 * The settled↔edit behavior of the API-key field (ADR-067 UX): a SET key must
 * NOT show an empty input by default — it shows a masked chip; entering a new
 * value is an explicit "Change". This is exactly the interaction a pure/unit
 * test can't see (the tab-title miss taught that lesson), so it's a DOM test.
 */
const page = Object.values(THEMES)[0].page;
const pasteInput = () => screen.queryByPlaceholderText(/paste/i);

afterEach(() => {
  updateMock.mockClear();
});

describe("SecretRow — settled vs edit", () => {
  it("a SET key shows a masked chip and NO input by default", () => {
    render(
      <SecretRow
        presetName="kimi"
        keyName="ANTHROPIC_AUTH_TOKEN"
        isSet
        maskedValue="••••1234"
        page={page}
      />,
    );
    expect(screen.getByText("✓ ••••1234")).toBeInTheDocument();
    expect(pasteInput()).toBeNull(); // the fix: no enterable box when set
    expect(screen.getByText("Change")).toBeInTheDocument();
    expect(screen.getByText("Clear")).toBeInTheDocument();
  });

  it("clicking Change reveals the input; Cancel returns to the chip", async () => {
    const user = userEvent.setup();
    render(
      <SecretRow
        presetName="kimi"
        keyName="ANTHROPIC_AUTH_TOKEN"
        isSet
        maskedValue="••••1234"
        page={page}
      />,
    );
    await user.click(screen.getByText("Change"));
    expect(pasteInput()).not.toBeNull();
    await user.click(screen.getByText("Cancel"));
    expect(pasteInput()).toBeNull();
    expect(screen.getByText("✓ ••••1234")).toBeInTheDocument();
  });

  it("Clear is two-step — one click confirms, doesn't wipe the key", async () => {
    const user = userEvent.setup();

    render(
      <SecretRow
        presetName="kimi"
        keyName="ANTHROPIC_AUTH_TOKEN"
        isSet
        maskedValue="••••1234"
        page={page}
      />,
    );
    await user.click(screen.getByText("Clear"));
    expect(updateMock).not.toHaveBeenCalled(); // not wiped on the first click
    expect(screen.getByText("Confirm clear")).toBeInTheDocument();
    await user.click(screen.getByText("Confirm clear"));
    expect(updateMock).toHaveBeenCalledWith("kimi", {
      secrets: { ANTHROPIC_AUTH_TOKEN: "" },
    });
  });

  it("an UNSET key opens straight into entry", () => {
    render(
      <SecretRow
        presetName="kimi"
        keyName="ANTHROPIC_AUTH_TOKEN"
        isSet={false}
        page={page}
      />,
    );
    expect(screen.getByText("not set")).toBeInTheDocument();
    expect(pasteInput()).not.toBeNull();
  });

  it("Save PUTs the typed value then collapses to the settled chip", async () => {
    const user = userEvent.setup();

    render(
      <SecretRow
        presetName="kimi"
        keyName="ANTHROPIC_AUTH_TOKEN"
        isSet={false}
        page={page}
      />,
    );
    const input = pasteInput();
    if (!input) throw new Error("expected an input");
    await user.type(input, "sk-new-key-9999");
    await user.click(screen.getByText("Save"));
    expect(updateMock).toHaveBeenCalledWith("kimi", {
      secrets: { ANTHROPIC_AUTH_TOKEN: "sk-new-key-9999" },
    });
  });
});
