import { expect, type Page, test } from "@playwright/test";
import { mockApi } from "./mocks";

/**
 * L4 UI e2e — sidebar drag-reorder (native HTML5 DnD, whole-row draggable).
 *
 * Asserts the COMMITTED order after a real native drag, covering:
 *  - FM-1 accuracy: indicated == committed. The drop EDGE (which half of the
 *    hovered row the cursor is in) decides the landing slot, so a downward drag
 *    lands BELOW the row the line was under — not one slot short (the old bug).
 *  - Re-parent is out: a cross-parent hierarchy drop is a no-op.
 *  - Index-space (nox Thread-1): a sibling reorder commits by NAME into the
 *    persisted order, so it survives a stopped sibling holding a slot.
 *
 * WHY dispatched DragEvents, not `page.mouse`: native HTML5 drag is gated behind
 * real OS-level drag events that CDP's synthetic mouse does not raise — a
 * `mouse.down/move/up` sequence never fires `dragstart`, so it cannot exercise
 * the `draggable` + onDragStart/Over/Drop path at all. Dispatching the drag
 * events with a SHARED `DataTransfer` is the faithful, reliable way to drive
 * native DnD in Playwright: it runs the REAL React handlers, the midpoint
 * hit-test (`dropEdgeAt` reads `e.clientY` + the row's live rect), and the store
 * commit. The `clientY` we pass is an absolute viewport coord matched to the
 * target row's bounding box, so the above/below decision is exercised for real.
 *
 * RED-first proof (performed while authoring; re-runnable): breaking the commit
 * math — e.g. `flatDropIndex` ignoring `edge`, or the hierarchy commit splicing
 * live indices straight into the full persisted order — turns the downward-drag
 * and stopped-sibling assertions RED. The green below is therefore load-bearing.
 *
 * A self-contained fleet + tree is routed for determinism: two parents each with
 * two reorderable children.
 */
const NOW = 1_700_000_000_000;
const agent = (id: string, name: string, managerId: string | null) => ({
  id,
  name,
  status: "running",
  workingDirectory: "/x",
  provider: "claude-code",
  providerSessionId: id,
  managerId,
  createdAt: NOW,
  updatedAt: NOW,
});
const treeNode = (
  id: string,
  name: string,
  children: Record<string, unknown>[] = [],
): Record<string, unknown> => ({
  id,
  claudeSessionId: id,
  name,
  status: "running",
  provider: "claude-code",
  permissionMode: "ask",
  children,
});

const FLEET = [
  agent("p1", "Parent1", null),
  agent("c1", "Child1", "p1"),
  agent("c2", "Child2", "p1"),
  agent("p2", "Parent2", null),
  agent("c3", "Child3", "p2"),
  agent("c4", "Child4", "p2"),
];
const TREE = [
  treeNode("p1", "Parent1", [treeNode("c1", "Child1"), treeNode("c2", "Child2")]),
  treeNode("p2", "Parent2", [treeNode("c3", "Child3"), treeNode("c4", "Child4")]),
];

// Store bridge (DEV-only, main.tsx). Typed loosely — a test-only escape hatch.
declare global {
  interface Window {
    // biome-ignore lint/suspicious/noExplicitAny: dev-only store bridge for e2e
    __autonomosStore: any;
  }
}

async function stage(page: Page, view: "flat" | "hierarchy") {
  await mockApi(page);
  await page.route("**/api/agents", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: FLEET });
  });
  await page.route("**/api/agents/tree", (route) =>
    route.fulfill({ json: TREE }),
  );
  await page.goto("/");
  await page.waitForFunction(() => "__autonomosStore" in window);
  await page.evaluate((v) => {
    window.__autonomosStore.setState({
      sidebarViewMode: v,
      sidebarViewModeExplicit: true,
      // Deterministic flat order so the reorder assertion is exact.
      pinnedOrder: [],
      unpinnedOrder: ["p1", "c1", "c2", "p2", "c3", "c4"],
    });
  }, view);
  await expect(page.locator('[data-session-id="c1"]')).toBeVisible();
}

/**
 * Drive a NATIVE HTML5 drag from `srcId`'s row to `dstId`'s row. `dstFrac` picks
 * the vertical fraction of the target row the cursor lands on — < 0.5 is the top
 * half (insert ABOVE), > 0.5 the bottom half (insert BELOW) — so the midpoint
 * hit-test is exercised, not bypassed. A single `DataTransfer` is shared across
 * the whole gesture, exactly as the browser does.
 */
async function nativeDrag(
  page: Page,
  srcId: string,
  dstId: string,
  dstFrac = 0.5,
) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const src = page.locator(`[data-session-id="${srcId}"]`);
  const dst = page.locator(`[data-session-id="${dstId}"]`);
  const box = await dst.boundingBox();
  if (!box) throw new Error("missing target bounding box");
  const clientX = box.x + box.width / 2;
  const clientY = box.y + box.height * dstFrac;

  await src.dispatchEvent("dragstart", { dataTransfer });
  await dst.dispatchEvent("dragover", { dataTransfer, clientX, clientY });
  // Let React flush the drop-target state before `drop` reads it.
  await page.waitForTimeout(40);
  await dst.dispatchEvent("drop", { dataTransfer, clientX, clientY });
  await src.dispatchEvent("dragend", { dataTransfer });
  await page.waitForTimeout(60);
}

test.describe("sidebar drag-reorder (native HTML5 DnD)", () => {
  test("flat: downward drag lands BELOW the hovered row (indicated == committed)", async ({
    page,
  }) => {
    await stage(page, "flat");
    // Drag Child1 (idx 1) onto Child3's LOWER half → line below c3 → c1 after c3.
    await nativeDrag(page, "c1", "c3", 0.7);
    const after = await page.evaluate(
      () => window.__autonomosStore.getState().unpinnedOrder,
    );
    // Clean single-item move: c1 lands after c3; the others keep their order.
    expect(after).toEqual(["p1", "c2", "p2", "c3", "c1", "c4"]);
  });

  test("flat: upward drag lands ABOVE the hovered row", async ({ page }) => {
    await stage(page, "flat");
    // Drag Child4 (idx 5) onto Child1's UPPER half → line above c1 → c4 before c1.
    await nativeDrag(page, "c4", "c1", 0.3);
    const after = await page.evaluate(
      () => window.__autonomosStore.getState().unpinnedOrder,
    );
    expect(after).toEqual(["p1", "c4", "c1", "c2", "p2", "c3"]);
  });

  test("hierarchy: sibling reorder stays under the same parent, committed by name", async ({
    page,
  }) => {
    await stage(page, "hierarchy");
    // Drag Child2 above Child1 (both under Parent1).
    await nativeDrag(page, "c2", "c1", 0.3);
    const hierOrder = await page.evaluate(
      () => window.__autonomosStore.getState().hierarchyOrder,
    );
    // Parent1's children reordered to [child2, child1] by name; not re-parented.
    expect(hierOrder.parent1).toEqual(["child2", "child1"]);
  });

  test("hierarchy: cross-parent drop is a no-op (no re-parent)", async ({
    page,
  }) => {
    await stage(page, "hierarchy");
    const before = await page.evaluate(() =>
      JSON.stringify(window.__autonomosStore.getState().hierarchyOrder),
    );
    // Drag Child1 (under Parent1) onto Child3 (under Parent2) — different parent.
    await nativeDrag(page, "c1", "c3", 0.5);
    const after = await page.evaluate(() =>
      JSON.stringify(window.__autonomosStore.getState().hierarchyOrder),
    );
    expect(after).toBe(before); // unchanged → nothing re-parented or reordered
  });
});
