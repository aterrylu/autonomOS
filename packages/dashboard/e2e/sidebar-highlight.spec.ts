import { expect, type Locator, type Page, test } from "@playwright/test";
import { mockApi } from "./mocks";

/**
 * L4 UI e2e — active-agent sidebar highlight (gold/amber inset-ring + glow).
 *
 * Asserts on computed `box-shadow` rather than pixel snapshots: the active row's
 * shadow must contain the current theme's accent RGB, a non-active row's must be
 * `none`. This pins the behavior (active → themed ring) without coupling to blur
 * radii or cross-machine anti-aliasing.
 */

// THEMES[theme].terminal.yellow per store.ts, as the browser renders rgb():
const ACCENT_RGB: Record<string, string> = {
  Midnight: "230, 180, 80", // #e6b450
  Daylight: "176, 136, 0", // #b08800
  Void: "245, 215, 110", // #f5d76e
};
const PARENT_BLUE = "59, 130, 246"; // rgba(59,130,246,.6) hierarchy parent borderLeft

function row(page: Page, name: string): Locator {
  return page
    .locator('aside [role="button"]')
    .filter({ hasText: name })
    .first();
}
const boxShadow = (loc: Locator) =>
  loc.evaluate((el) => getComputedStyle(el).boxShadow);
const borderLeft = (loc: Locator) =>
  loc.evaluate((el) => getComputedStyle(el).borderLeftColor);

/** Open the settings panel, cycle the theme button to `target`, close it. */
async function setTheme(page: Page, target: keyof typeof ACCENT_RGB) {
  await page.getByRole("button", { name: /e2e-mock/ }).click();
  const btn = page.getByRole("button", { name: /^(Midnight|Daylight|Void)$/ });
  await expect(btn).toBeVisible();
  for (let i = 0; i < 3; i++) {
    if (((await btn.textContent()) ?? "").trim() === target) break;
    await btn.click();
  }
  await expect(btn).toHaveText(target);
  await page.keyboard.press("Escape");
  await expect(btn).toBeHidden();
}

async function activate(page: Page, name: string) {
  await page.locator("aside").getByText(name, { exact: true }).first().click();
}

/**
 * Ensure the sidebar shows `target`. The view toggle's title reflects the
 * destination ("Switch to flat view" when currently in hierarchy, and vice
 * versa), so the button for `target` is present only when we're in the other
 * view — click it iff present. Robust to the default-view setting (hierarchy
 * since #249).
 */
async function setView(page: Page, target: "flat" | "hierarchy") {
  const toggle = page.getByTitle(
    target === "flat" ? "Switch to flat view" : "Switch to hierarchy view",
  );
  if (await toggle.count()) await toggle.click();
}

test.describe("active-agent sidebar highlight", () => {
  test("active row gets a themed ring; non-active rows get none (flat)", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();
    await setView(page, "flat");

    // Default theme is Void (store initial state).
    await activate(page, "Researcher");

    const active = await boxShadow(row(page, "Researcher"));
    expect(active).not.toBe("none");
    expect(active).toContain(ACCENT_RGB.Void); // ring is the theme accent
    expect(active).toContain("inset"); // inset ring (no reflow), not a border

    // A different, non-active agent has no ring.
    expect(await boxShadow(row(page, "Dispatcher"))).toBe("none");
  });

  test("ring color is theme-sourced (Midnight gold → Daylight amber)", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();
    await setView(page, "flat");
    await activate(page, "Researcher");

    await setTheme(page, "Midnight");
    expect(await boxShadow(row(page, "Researcher"))).toContain(
      ACCENT_RGB.Midnight,
    );

    await setTheme(page, "Daylight");
    expect(await boxShadow(row(page, "Researcher"))).toContain(
      ACCENT_RGB.Daylight,
    );
  });

  test("highlight works in hierarchy view; active parent keeps its blue left border", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();

    await setView(page, "hierarchy");
    // Dispatcher is the root manager (has child Researcher) → it carries the
    // 3px blue parent borderLeft. Make it the active agent.
    await activate(page, "Dispatcher");

    const parentRow = row(page, "Dispatcher");
    // Ring present (highlight applied through SessionRow in hierarchy too)...
    expect(await boxShadow(parentRow)).toContain(ACCENT_RGB.Void);
    // ...AND the blue parent border survives — both signals coexist.
    expect(await borderLeft(parentRow)).toContain(PARENT_BLUE);
  });

  test("active ring coexists with another agent's unread badge (Option A)", async ({
    page,
  }) => {
    await mockApi(page);
    // A sibling agent carries an unread count; the active agent shows its ring.
    // The two signals use independent code paths and must render side-by-side.
    await page.route("**/api/hooks", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ "agent-dispatcher-0001": { unread: 5 } }),
      }),
    );
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();
    await setView(page, "flat");
    await activate(page, "Researcher");

    // Active agent (Researcher) has the themed ring...
    expect(await boxShadow(row(page, "Researcher"))).toContain(ACCENT_RGB.Void);
    // ...while a different agent (Dispatcher) still shows its red unread badge.
    await expect(row(page, "Dispatcher")).toContainText("unread");
  });
});
