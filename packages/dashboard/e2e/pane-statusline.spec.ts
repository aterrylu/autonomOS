import { expect, type Page, test } from "@playwright/test";
import { type MockAgent, mockApi } from "./mocks";

/**
 * L4 UI e2e — the per-pane autonomOS statusline (PaneStatusline).
 *
 * Verifies, in the real dockview layout with a real terminal pane mounted, that:
 *   - a Codex pane renders the statusline (provider icon + identity + branch +
 *     live status) beneath its terminal, and
 *   - a Claude pane does NOT (its in-terminal statusline is on by default, so the
 *     chrome bar would be redundant — the Claude opt-in gate).
 *
 * Backend is fully mocked (see mocks.ts) — no server, no PTY, no real agent.
 */

const NOW = 1_700_000_000_000;

function codexAgent(): MockAgent & { branch?: string } {
  return {
    id: "agent-codex-qa",
    name: "CodexWorker",
    status: "running",
    workingDirectory: "/Users/dev/autonomOS",
    provider: "codex",
    providerSessionId: "agent-codex-qa",
    managerId: null,
    project: "autonomOS",
    branch: "terry/codex-statusline",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Override /api/hooks (mockApi returns {}) to give an agent a live status.
 *  Registered AFTER mockApi so Playwright's most-recent-wins routing picks it. */
async function mockStatus(
  page: Page,
  statuses: Record<string, string>,
): Promise<void> {
  await page.route("**/api/hooks", (route) => {
    const body: Record<string, { status: { status: string }; unread: number }> =
      {};
    for (const [id, status] of Object.entries(statuses)) {
      body[id] = { status: { status }, unread: 0 };
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

interface StoreBridge {
  getState: () => {
    activePane: { type: string; id?: string } | null;
    switchPane: (pane: { type: "session"; id: string }) => void;
  };
}

/** Open a session's pane deterministically via the dev store bridge (same
 *  bridge layout.spec.ts uses) rather than a sidebar click — the sidebar's
 *  grouped/flat view toggle makes name-clicking racy, and we only care that the
 *  pane mounts so PaneStatusline renders. */
async function openSessionPane(page: Page, id: string): Promise<void> {
  await page.evaluate((sessionId) => {
    (
      window as unknown as { __autonomosStore?: StoreBridge }
    ).__autonomosStore?.getState().switchPane({ type: "session", id: sessionId });
  }, id);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __autonomosStore?: StoreBridge })
            .__autonomosStore?.getState().activePane?.id ?? null,
      ),
    )
    .toBe(id);
}

test.describe("pane statusline", () => {
  test("Codex pane shows identity, branch, and live status", async ({
    page,
  }) => {
    await mockApi(page, { agents: [codexAgent()] });
    await mockStatus(page, { "agent-codex-qa": "working" });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "autonomOS" }),
    ).toBeVisible();

    await openSessionPane(page, "agent-codex-qa");

    const bar = page.getByTestId("pane-statusline");
    await expect(bar).toBeVisible();
    // Provider mark (Codex) rides in the icon; identity + branch + status text.
    await expect(bar.locator('svg[aria-label="Codex"]')).toBeVisible();
    await expect(bar.getByText("CodexWorker")).toBeVisible();
    await expect(bar.getByText("@autonomOS")).toBeVisible();
    await expect(bar.getByText(/terry\/codex-statusline/)).toBeVisible();
    await expect(bar.getByText("Working")).toBeVisible();
    // Standalone (no manager, no reports) since it's the only agent.
    await expect(bar.getByText("standalone")).toBeVisible();
  });

  test("Claude pane hides the bar when the in-terminal statusline is ON", async ({
    page,
  }) => {
    const claude: MockAgent = {
      id: "agent-claude-qa",
      name: "ClaudeWorker",
      status: "running",
      workingDirectory: "/Users/dev/autonomOS",
      provider: "claude-code",
      providerSessionId: "agent-claude-qa",
      managerId: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    // mockApi default settings have statusLine.enabled = true → Claude gated off.
    await mockApi(page, { agents: [claude] });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "autonomOS" }),
    ).toBeVisible();

    // openSessionPane already waits for the session pane to become active.
    await openSessionPane(page, "agent-claude-qa");

    // The pane is open, but the chrome statusline must NOT render for Claude
    // (its in-terminal statusline is on, so the chrome bar would be redundant).
    await expect(page.getByTestId("pane-statusline")).toHaveCount(0);
  });
});
