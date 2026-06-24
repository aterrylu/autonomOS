import { mkdirSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { mockApi } from "./mocks";

/**
 * L4 UI e2e — active-agent sidebar highlight (gold/amber inset-ring + glow).
 *
 * Asserts on computed `box-shadow` rather than pixel snapshots: the active row's
 * shadow must contain the current theme's accent RGB, a non-active row's must be
 * `none`. This pins the behavior (active → themed ring) without coupling to blur
 * radii or cross-machine anti-aliasing. Screenshots are captured for human review.
 */

const SHOTS =
  "/private/tmp/claude-501/-Users-aterrylu-workspace-autonomOS/61bca8f4-e124-4baf-a46d-1908f6c25d50/scratchpad/qa-screens";
mkdirSync(SHOTS, { recursive: true });

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

test.describe("active-agent sidebar highlight", () => {
  test("active row gets a themed ring; non-active rows get none (flat)", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();

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

    await page.getByTitle("Switch to hierarchy view").click();
    // Dispatcher is the root manager (has child Researcher) → it carries the
    // 3px blue parent borderLeft. Make it the active agent.
    await activate(page, "Dispatcher");

    const parentRow = row(page, "Dispatcher");
    // Ring present (highlight applied through SessionRow in hierarchy too)...
    expect(await boxShadow(parentRow)).toContain(ACCENT_RGB.Void);
    // ...AND the blue parent border survives — both signals coexist.
    expect(await borderLeft(parentRow)).toContain(PARENT_BLUE);
  });

  test("capture: sidebar highlight across themes + views", async ({ page }) => {
    await mockApi(page);
    // Inject an unread count so the active row shows the red "N unread ·" text
    // (Option A coexist). Registered after mockApi → takes precedence; the 3s
    // poll re-adds it even after markNotificationsRead clears it on click.
    await page.route("**/api/hooks", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          "agent-researcher-0002": { unread: 2 },
          "agent-dispatcher-0001": { unread: 5 },
        }),
      }),
    );
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();
    await activate(page, "Researcher");

    const aside = page.locator("aside");

    for (const theme of ["Void", "Midnight", "Daylight"] as const) {
      await setTheme(page, theme);
      await aside.screenshot({ path: `${SHOTS}/flat-${theme}.png` });
    }

    // Hierarchy view (in Daylight, then Midnight) — show the active parent case.
    await page.getByTitle("Switch to hierarchy view").click();
    await activate(page, "Dispatcher");
    await aside.screenshot({ path: `${SHOTS}/hierarchy-Daylight.png` });
    await setTheme(page, "Midnight");
    await aside.screenshot({ path: `${SHOTS}/hierarchy-Midnight.png` });

    // Option A coexist: the active-agent ring and the red "N unread ·" badge use
    // independent code paths, so they render side-by-side in one list. Capture the
    // active (ringed) Researcher alongside a sibling (Dispatcher) carrying unread.
    // (Same-ROW active+unread is the new-activity-while-viewing case; shown in the
    // design mockup card 04 — it can't be forced deterministically here because a
    // click marks the active agent read.)
    await page.getByTitle("Switch to flat view").click();
    await activate(page, "Researcher");
    await expect(row(page, "Dispatcher")).toContainText("unread");
    await aside.screenshot({ path: `${SHOTS}/coexist-active-and-unread.png` });
  });
});
