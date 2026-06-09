import { expect, test } from "@playwright/test";
import { mockApi } from "./mocks";

/**
 * Org-chart / hierarchy panel renders the mocked tree (GET /api/agents/tree).
 * The tree has Dispatcher → Researcher; both agent cards must render.
 */
test("org chart renders the mocked hierarchy tree", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();

  // Open the Org Chart pane.
  await page.locator("aside").getByText("Org Chart", { exact: true }).click();

  // The hierarchy content area renders an agent card per tree node. Both the
  // root (Dispatcher) and its child (Researcher) appear. Scope to the main
  // content region (outside the sidebar) to avoid matching sidebar rows.
  const main = page.locator("aside ~ *");
  await expect(main.getByText("Dispatcher").first()).toBeVisible();
  await expect(main.getByText("Researcher").first()).toBeVisible();
});
