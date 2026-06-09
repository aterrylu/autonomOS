import { expect, test } from "@playwright/test";
import { MOCK_AGENTS, mockApi } from "./mocks";

/**
 * L4 UI e2e — the real dashboard (vite) driven by a browser, with every backend
 * call mocked. No autonomos server, no `claude`, no PTY, no agents are spawned.
 */

test.describe("dashboard load + sidebar", () => {
  test("renders the sidebar with the mocked agents", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");

    // App boots past the auth probe (GET /api/agents → 200) into the main UI.
    await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();

    // Sidebar lists each mocked agent by name. Names render as plain text in
    // SessionRow, so assert on visible text within the sidebar <aside>.
    const sidebar = page.locator("aside");
    for (const agent of MOCK_AGENTS) {
      await expect(sidebar.getByText(agent.name, { exact: true })).toBeVisible();
    }

    // The singleton nav buttons are present (Org Chart / Templates / Schedules).
    await expect(sidebar.getByText("Org Chart", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Schedules", { exact: true })).toBeVisible();
  });

  test("empty agent list shows the empty-state and auto-opens Create Agent", async ({
    page,
  }) => {
    // First-run UX: zero agents → App.tsx auto-opens the Create Agent panel.
    await mockApi(page, { agents: [] });
    await page.goto("/");

    await expect(page.getByText("No active agents")).toBeVisible();

    // Auto-opened Create Agent panel (sessionStorage-gated first-run flow).
    await expect(
      page.getByRole("heading", { name: "Create New Agent" }),
    ).toBeVisible();
  });
});

test.describe("settings panel", () => {
  test("opens and an Auto-Trust toggle persists via PUT /api/settings", async ({
    page,
  }) => {
    const state = await mockApi(page);
    await page.goto("/");

    // The settings entry point is the gear + hostname badge in the status bar.
    // Host comes from GET /api/host → "e2e-mock".
    const settingsBadge = page.getByRole("button", { name: /e2e-mock/ });
    await expect(settingsBadge).toBeVisible();
    await settingsBadge.click();

    // Panel renders (loads GET /api/settings).
    await expect(page.getByText("Settings", { exact: true })).toBeVisible();
    await expect(page.getByText("Auto-Trust")).toBeVisible();

    // Auto-Trust starts ON (mock settings.autoTrust = true). Its ToggleSwitch is
    // the first pill-shaped (.rounded-full) control following the label — click
    // it to fire PUT /api/settings with { autoTrust: false }.
    await page
      .getByText("Auto-Trust")
      .locator("xpath=following::div[contains(@class,'rounded-full')][1]")
      .click();

    await expect
      .poll(() => state.settingsUpdates.length, { timeout: 5_000 })
      .toBeGreaterThan(0);
    expect(state.settingsUpdates[0]).toMatchObject({ autoTrust: false });
  });
});
