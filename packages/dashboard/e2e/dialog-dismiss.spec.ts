import { expect, type Locator, type Page, test } from "@playwright/test";
import { mockApi } from "./mocks";

/**
 * A text selection that ends over the backdrop must NOT close a dialog.
 *
 * Terry's bug: drag-selecting release notes and letting go outside the panel
 * closed it. The browser dispatches that `click` to the nearest common
 * ancestor of the mousedown and mouseup targets — the backdrop — so the old
 * `e.target === e.currentTarget` check closed the dialog. This drives the
 * REAL gesture (press inside, move out, release on the backdrop) in Chromium,
 * where that dispatch rule actually applies; jsdom can't reproduce it.
 */

async function modKey(page: Page): Promise<"Meta" | "Control"> {
  const mac = await page.evaluate(() =>
    /mac/i.test(
      (navigator as Navigator & { userAgentData?: { platform: string } })
        .userAgentData?.platform ??
        navigator.platform ??
        "",
    ),
  );
  return mac ? "Meta" : "Control";
}

/** Press inside `dialog`, drag to the viewport corner (backdrop), release. */
async function dragSelectOut(page: Page, dialog: Locator): Promise<void> {
  const box = await dialog.boundingBox();
  if (!box) throw new Error("dialog has no box");
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 60, { steps: 4 });
  await page.mouse.move(5, 5, { steps: 6 }); // off the dialog, onto the backdrop
  await page.mouse.up();
}

/** Press `chord` until `dialog` opens — on a cold dev server the first press
 *  can land before the shortcut dispatcher has mounted. */
async function openWith(page: Page, chord: string, dialog: Locator) {
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.keyboard.press(chord);
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

async function checkDialog(page: Page, dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  await dragSelectOut(page, dialog);
  await expect(dialog).toBeVisible(); // the regression
  // A real backdrop click (press AND release outside) still dismisses.
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
}

test("keyboard-shortcuts overlay survives a selection that ends on the backdrop", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  const mod = await modKey(page);
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await openWith(page, `${mod}+Slash`, dialog);
  await checkDialog(page, dialog);
});

test("quick switcher survives a selection that ends on the backdrop", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  const mod = await modKey(page);
  const dialog = page.getByRole("dialog").first();
  await openWith(page, `${mod}+k`, dialog);
  await checkDialog(page, dialog);
});

test("update dialog survives a selection that ends on the backdrop (Terry's report)", async ({
  page,
}) => {
  await mockApi(page);
  // Registered after mockApi → these take precedence.
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route("**/api/system/version", (r) =>
    r.fulfill(
      json({
        version: "0.7.0",
        latest: "0.7.99",
        updateAvailable: true,
        installMode: "bundle",
        platform: "linux",
        arch: "x64",
        releaseUrl: null,
        checkedAt: "2026-09-26T00:00:00Z",
      }),
    ),
  );
  await page.route("**/api/system/releases", (r) =>
    r.fulfill(
      json({
        current: "0.7.0",
        latest: "0.7.99",
        updateAvailable: true,
        releaseUrl: null,
        releases: [
          {
            version: "0.7.99",
            name: "v0.7.99",
            body: "Some release notes worth copying out of the dialog.\n\n- one\n- two",
            url: null,
            publishedAt: "2026-09-26T00:00:00Z",
            storageFormatChange: false,
          },
        ],
      }),
    ),
  );
  await page.route("**/api/system/upgrade", (r) =>
    r.fulfill(
      json({
        current: "0.7.0",
        supervised: true,
        installMode: "bundle",
        status: null,
        armed: null,
        idleWindowMs: 30_000,
        busy: [],
        background: [],
        inFlight: false,
      }),
    ),
  );
  await page.goto("/");
  await page.getByTestId("update-badge").click();
  await checkDialog(page, page.getByRole("dialog").first());
});
