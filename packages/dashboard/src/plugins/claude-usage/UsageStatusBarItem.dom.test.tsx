// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../test/setup-dom";
import type { RateLimitData, UsageDiagnosis } from "./types";
import { UsageStatusBarItem } from "./UsageStatusBarItem";

/**
 * The Claude usage bar must SAY WHY it has no numbers. Each state below used
 * to render a bare, cause-free label ("n/a", "setup needed", "delayed"); now
 * the label names the reason and the tooltip / panel carry summary + hint.
 * Also pins the adjacent-regression case: a normal Max-plan answer renders
 * exactly the 5h + 7d pair, and a named limits[] window only surfaces when it
 * is the hottest one.
 */

function stub(body: RateLimitData): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) =>
      Promise.resolve(
        new Response(
          String(url).includes("/api/plugins/claude-usage")
            ? JSON.stringify(body)
            : "{}",
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ),
  );
}

async function renderSettled() {
  let r!: ReturnType<typeof render>;
  await act(async () => {
    r = render(<UsageStatusBarItem />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return r;
}

const base: RateLimitData = {
  fiveHour: null,
  sevenDay: null,
  sevenDaySonnet: null,
  sevenDayOpus: null,
  extraUsage: null,
  account: {},
  fetchedAt: new Date().toISOString(),
};

const diag = (code: UsageDiagnosis["code"], summary = "S", hint = "H") => ({
  code,
  summary,
  hint,
});

describe("UsageStatusBarItem — says why there are no numbers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the former bare 'n/a' names its reason, tooltips summary+hint, and opens a panel", async () => {
    stub({
      ...base,
      credentialSource: "oauth",
      diagnosis: diag(
        "no_rolling_limits",
        "Your Claude login works, but the usage response had no 5-hour or weekly window we could read (Team plan).",
        "Check `/usage` inside Claude Code.",
      ),
    });
    const { container, getByRole, getByText } = await renderSettled();
    expect(container.textContent).toContain("no windows");
    expect(container.textContent).not.toContain("n/a");
    const button = getByRole("button");
    expect(button.getAttribute("title")).toContain("(Team plan)");
    expect(button.getAttribute("title")).toContain("/usage");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(getByText("No usage to show")).toBeTruthy();
    expect(getByText("Check again")).toBeTruthy();
  });

  it("with no diagnosis at all (an older server) it still says 'n/a'", async () => {
    stub({ ...base });
    const { container } = await renderSettled();
    expect(container.textContent).toContain("n/a");
  });

  it("an unknown future code falls back to the generic label instead of blanking", async () => {
    stub({
      ...base,
      diagnosis: {
        code: "brand_new_cause" as never,
        summary: "Something new",
        hint: "Do a thing",
      },
    });
    const { container, getByRole } = await renderSettled();
    expect(container.textContent).toContain("n/a");
    expect(getByRole("button").getAttribute("title")).toContain(
      "Something new",
    );
  });

  it("setup-needed states name the cause (keychain denied) and show it in the panel", async () => {
    stub({
      ...base,
      needsSetup: true,
      error: "macOS denied access to the Claude Code login in the keychain.",
      diagnosis: diag(
        "keychain_denied",
        "macOS denied access to the Claude Code login in the keychain.",
        "Open Keychain Access…",
      ),
    });
    const { container, getByRole, getByTestId } = await renderSettled();
    expect(container.textContent).toContain("keychain denied");
    await act(async () => {
      fireEvent.click(getByRole("button"));
    });
    expect(getByTestId("usage-diagnosis-summary").textContent).toContain(
      "denied access",
    );
    expect(getByTestId("usage-diagnosis-hint").textContent).toContain(
      "Keychain Access",
    );
  });

  it("plain no-login keeps the familiar 'setup needed' label", async () => {
    stub({
      ...base,
      needsSetup: true,
      diagnosis: diag("no_login", "No Claude Code login found."),
    });
    const { container } = await renderSettled();
    expect(container.textContent).toContain("setup needed");
  });

  it("a 403 reads 'blocked (403)', not 'delayed', and the panel carries the hint", async () => {
    stub({
      ...base,
      error: "Anthropic refused the usage request (HTTP 403).",
      errorKind: "unavailable",
      diagnosis: diag(
        "usage_forbidden",
        "Anthropic refused the usage request (HTTP 403).",
        "Either this account isn't allowed to read its usage, or a proxy is blocking api.anthropic.com.",
      ),
    });
    const { container, getByRole, getByTestId } = await renderSettled();
    expect(container.textContent).toContain("blocked (403)");
    expect(container.textContent).not.toContain("delayed");
    await act(async () => {
      fireEvent.click(getByRole("button"));
    });
    expect(getByTestId("usage-diagnosis-hint").textContent).toContain("proxy");
    // A 403 may be about this account: no "temporarily", no "not your key".
    expect(container.textContent).toContain("Usage unavailable");
    expect(container.textContent).not.toContain("temporarily");
    expect(container.textContent).not.toContain("no need to reconfigure");
  });

  it("a network drop keeps the transient reassurance", async () => {
    stub({
      ...base,
      error: "Anthropic's usage API is temporarily unavailable.",
      errorKind: "unavailable",
      diagnosis: {
        ...diag(
          "network_unreachable",
          "Couldn't reach it.",
          "Check the network.",
        ),
        transient: true,
      },
    });
    const { container, getByRole } = await renderSettled();
    expect(container.textContent).toContain("offline");
    await act(async () => {
      fireEvent.click(getByRole("button"));
    });
    expect(container.textContent).toContain("Usage temporarily unavailable");
    expect(container.textContent).toContain("no need to reconfigure");
  });
});

describe("UsageStatusBarItem — windows (adjacent regression)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const maxHome: RateLimitData = {
    ...base,
    fiveHour: { utilization: 13, resetsAt: "2026-09-24T10:49:59Z" },
    sevenDay: { utilization: 4, resetsAt: "2026-09-30T21:59:59Z" },
    extraWindows: [
      {
        id: "claude-weekly-scoped-fable",
        label: "Fable 7d",
        utilization: 0,
        resetsAt: "2026-09-30T22:00:00Z",
      },
    ],
    credentialSource: "oauth",
  };

  it("Terry's Max answer renders exactly '5h 13%' and '7d 4%' — the Fable window stays in the panel", async () => {
    stub(maxHome);
    const { container } = await renderSettled();
    const text = container.textContent ?? "";
    expect(text).toContain("5h");
    expect(text).toContain("13%");
    expect(text).toContain("7d");
    expect(text).toContain("4%");
    expect(text).not.toContain("Fable");
  });

  it("a named window surfaces on the bar only when it is the hottest", async () => {
    stub({
      ...maxHome,
      extraWindows: [
        {
          ...(maxHome.extraWindows?.[0] as NonNullable<
            RateLimitData["extraWindows"]
          >[number]),
          utilization: 88,
        },
      ],
    });
    const { container } = await renderSettled();
    expect(container.textContent).toContain("Fable 7d");
    expect(container.textContent).toContain("88%");
  });
});
