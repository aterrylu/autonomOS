import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { mockApi } from "./mocks";

/**
 * Split-pane + tab interaction.
 *
 * Layout/active-pane state is verified through the dev-only store bridge
 * (`window.__autonomosStore`, see src/main.tsx) — a reliable read of the real
 * zustand layout tree, far less brittle than reverse-engineering pane DOM. Ctrl+D
 * spawns a new session into a new leaf via the MOCKED POST /api/agents — no real
 * agent is ever spawned. Live terminal streaming over WS is out of scope here.
 */

/** Number of leaves in the layout tree (split regions). */
function leafCount(page: Page) {
  return page.evaluate(() => {
    const store = (
      window as unknown as {
        __autonomosStore?: { getState: () => { layout: unknown } };
      }
    ).__autonomosStore;
    if (!store) return -1;
    type Node = { kind?: string; first?: Node; second?: Node };
    const countLeaves = (node?: Node): number => {
      if (!node) return 0;
      if (node.kind === "leaf") return 1;
      return countLeaves(node.first) + countLeaves(node.second);
    };
    return countLeaves(store.getState().layout as never);
  });
}

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

test("split-pane: Ctrl+D splits the focused leaf into a second pane", async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();

  // Confirm the store bridge is live.
  await expect.poll(() => leafCount(page)).toBeGreaterThanOrEqual(1);

  // Focus a session pane so Ctrl+D has a leaf to split from.
  await page.locator("aside").getByText("Dispatcher", { exact: true }).click();
  await expect.poll(() => activePaneType(page)).toBe("session");

  const before = await leafCount(page);

  // Ctrl+D — split vertically, spawning a new session into the new leaf.
  await page.keyboard.press("Control+d");

  // The split requests a new agent via the mocked POST /api/agents.
  await expect
    .poll(() => state.createdAgents.length, { timeout: 5_000 })
    .toBeGreaterThan(0);

  // The layout tree gained a leaf.
  await expect
    .poll(() => leafCount(page), { timeout: 5_000 })
    .toBeGreaterThan(before);
});

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
