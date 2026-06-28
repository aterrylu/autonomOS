import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { mockApi } from "./mocks";

/**
 * Tab / active-pane interaction.
 *
 * Active-pane state is verified through the dev-only store bridge
 * (`window.__autonomosStore`, see src/main.tsx) — a reliable read of the real
 * zustand `activePane`, far less brittle than reverse-engineering pane DOM.
 *
 * Note: the legacy binary-tree split test (Ctrl+D → new leaf) was removed with
 * the legacy layout engine (dockview is now the only engine). dockview-native
 * split keybinds are a planned follow-up and will get their own e2e coverage.
 */

/** The active pane's type ("session" | "orgchart" | "templates" | ...). */
function activePaneType(page: Page) {
  return page.evaluate(() => {
    const store = (
      window as unknown as {
        __autonomosStore?: {
          getState: () => { activePane: { type: string } | null };
        };
      }
    ).__autonomosStore;
    return store?.getState().activePane?.type ?? null;
  });
}

test("tab switching: Org Chart → Templates → Org Chart updates the active pane", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();

  await page.locator("aside").getByText("Org Chart", { exact: true }).click();
  await expect.poll(() => activePaneType(page)).toBe("orgchart");

  await page.locator("aside").getByText("Templates", { exact: true }).click();
  await expect.poll(() => activePaneType(page)).toBe("templates");

  // Switch back — the singleton Org Chart tab reactivates (not recreated).
  await page.locator("aside").getByText("Org Chart", { exact: true }).click();
  await expect.poll(() => activePaneType(page)).toBe("orgchart");
});
