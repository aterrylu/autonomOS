import { expect, type Page, test } from "@playwright/test";
import { mockApi } from "./mocks";

/**
 * The update dialog in a REAL browser — what jsdom can't vouch for:
 *  - focus: Tab cycles inside the dialog and never reaches the inert app
 *  - 400% zoom (320×256 CSS px): the actions stay on screen
 *  - Daylight contrast, measured from computed styles (the old fixed colors
 *    measured 1.74:1 amber and 2.28:1 blue there)
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mockUpdate(page: Page, busy: unknown[] = []) {
  await mockApi(page);
  await page.route("**/api/system/version", (r) =>
    r.fulfill(
      json({
        version: "0.7.0",
        latest: "0.7.99",
        updateAvailable: true,
        installMode: "bundle",
        platform: "linux",
        arch: "x64",
        releaseUrl: "https://example.com/releases/v0.7.99",
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
        releaseUrl: "https://example.com/releases/v0.7.99",
        releases: [
          {
            version: "0.7.99",
            name: "v0.7.99",
            body: [
              "- **[#360](https://example.com/360) — Old API routes removed.** Breaking change, announced in v0.6.0: the deprecated `/auth` aliases are gone.",
              ...Array.from(
                { length: 25 },
                (_, i) =>
                  `- [#${400 + i}](https://example.com/${400 + i}) change ${i}`,
              ),
            ].join("\n"),
            url: null,
            publishedAt: "2026-09-25T00:00:00Z",
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
        busy,
        background: [],
        inFlight: false,
      }),
    ),
  );
}

async function openDialog(page: Page) {
  await page.goto("/");
  await page.getByTestId("update-badge").click();
  const dialog = page.getByRole("dialog", {
    name: "Update autonomOS to v0.7.99",
  });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("update-start")).toBeEnabled();
  return dialog;
}

test("Tab and Shift+Tab stay inside the dialog; the app behind is inert", async ({
  page,
}) => {
  await mockUpdate(page);
  const dialog = await openDialog(page);
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  // Focus starts on the heading.
  await expect(
    page.getByRole("heading", { name: "Update autonomOS to v0.7.99" }),
  ).toBeFocused();
  // Enough presses to wrap the whole dialog (note links included) at least
  // once each way: focus must never leave it.
  const seen = new Set<string>();
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press(i % 7 === 6 ? "Shift+Tab" : "Tab");
    const where = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const dlg = document.querySelector('[role="dialog"]');
      return {
        inside: !!(el && dlg?.contains(el)),
        label: `${el?.tagName}:${el?.textContent?.slice(0, 24)}`,
      };
    });
    expect(where.inside, `focus escaped to ${where.label}`).toBe(true);
    seen.add(where.label);
  }
  expect([...seen].some((l) => l.includes("Update and restart"))).toBe(true);
  // Note links stay keyboard-reachable (WCAG 2.1.1)…
  expect([...seen].some((l) => l.startsWith("A:#"))).toBe(true);
  // …and the primary is still ONE Shift+Tab from the heading.
  await page
    .getByRole("heading", { name: "Update autonomOS to v0.7.99" })
    .focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("update-start")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect(page.getByTestId("update-badge")).toBeFocused();
});

test("at 400% zoom (320×256) the actions stay on screen", async ({ page }) => {
  await mockUpdate(page, [
    { id: "a", name: "busy-bee", status: "tool_running" },
  ]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByTestId("update-badge").click();
  await expect(page.getByTestId("update-now-interrupt")).toBeVisible();
  await page.setViewportSize({ width: 320, height: 256 });
  for (const id of ["update-start", "update-now-interrupt"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, id).not.toBeNull();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(256);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
  }
});

test("Daylight: every accent text in the dialog clears 4.5:1", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "autonomos",
      JSON.stringify({ state: { theme: "daylight" }, version: 0 }),
    ),
  );
  await mockUpdate(page, [
    { id: "a", name: "busy-bee", status: "tool_running" },
  ]);
  await page.goto("/");
  await expect(page.getByTestId("update-badge")).toBeVisible();
  const pill = await contrastOf(page, '[data-testid="update-badge"]');
  expect(pill, "pill").toBeGreaterThanOrEqual(4.5);
  await page.getByTestId("update-badge").click();
  await expect(page.getByTestId("breaking-callout")).toBeVisible();
  for (const sel of [
    '[data-testid="breaking-callout"] .font-semibold',
    '[data-testid="update-agents"] .font-semibold',
    '[data-testid="update-now-interrupt"]',
    '[data-testid="update-github-link"]',
  ]) {
    const ratio = await contrastOf(page, sel);
    expect(ratio, sel).toBeGreaterThanOrEqual(4.5);
  }
});

/** WCAG contrast of `sel`'s text color against the first opaque background
 *  up its ancestor chain (alpha tints composited over it), with the text's
 *  own alpha and every ancestor's opacity applied. */
async function contrastOf(page: Page, sel: string): Promise<number> {
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el) throw new Error(`no ${s}`);
    const parse = (c: string) => {
      const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
      return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 };
    };
    const layers: { r: number; g: number; b: number; a: number }[] = [];
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg.a > 0) layers.push(bg);
      if (bg.a >= 1) break;
    }
    let base = { r: 255, g: 255, b: 255 };
    for (const l of layers.reverse()) {
      base = {
        r: l.r * l.a + base.r * (1 - l.a),
        g: l.g * l.a + base.g * (1 - l.a),
        b: l.b * l.a + base.b * (1 - l.a),
      };
    }
    // A computed color ignores ancestor `opacity` (how the stage hints were
    // washed out): fold the combined opacity into the text color.
    let op = 1;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      op *= Number(getComputedStyle(n).opacity);
    }
    const raw = parse(getComputedStyle(el).color);
    const k = raw.a * op;
    const fg = {
      r: raw.r * k + base.r * (1 - k),
      g: raw.g * k + base.g * (1 - k),
      b: raw.b * k + base.b * (1 - k),
    };
    const lum = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const [a, b] = [lum(fg), lum(base)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  }, sel);
}

test("the waiting view's actions fit on one row at desktop width", async ({
  page,
}) => {
  await mockUpdate(page, [
    { id: "a", name: "busy-bee", status: "tool_running" },
  ]);
  const armed = {
    target: "0.7.99",
    armedAt: "2026-09-26T00:00:00Z",
    idleSince: null,
  };
  await page.route("**/api/system/upgrade", (r) =>
    r.request().method() === "POST"
      ? r.fulfill(json({ ok: true, armed }))
      : r.fallback(),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByTestId("update-badge").click();
  await page.getByTestId("update-start").click();
  await expect(page.getByTestId("update-waiting")).toBeVisible();
  const ys = await Promise.all(
    ["update-cancel-armed", "update-waiting-now"].map(async (id) =>
      Math.round((await page.getByTestId(id).boundingBox())?.y ?? -1),
    ),
  );
  const close = await page
    .getByRole("button", { name: "Close", exact: true })
    .boundingBox();
  expect(new Set([...ys, Math.round(close?.y ?? -2)]).size).toBe(1);
});

test("at phone width, Tab never parks focus behind the sticky footer", async ({
  page,
}) => {
  await mockUpdate(page, [
    { id: "a", name: "busy-bee", status: "tool_running" },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByTestId("update-badge").click();
  await expect(page.getByTestId("update-start")).toBeEnabled();
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const footer = document.querySelector("[data-update-footer]");
      if (!footer || footer.contains(el)) return null;
      // Inside the notes box, it's the box's own scroll that matters.
      const box = el.closest('[aria-label="Release notes"]');
      if (box && box !== el) return null;
      const a = el.getBoundingClientRect();
      const f = footer.getBoundingClientRect();
      return { bottom: a.bottom, footerTop: f.top, label: el.textContent?.slice(0, 30) };
    });
    if (r) {
      expect(r.bottom, `"${r.label}" hidden behind the footer`).toBeLessThanOrEqual(
        r.footerTop + 1,
      );
    }
  }
});

test("Daylight: note links and not-started stage hints clear 4.5:1 too", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "autonomos",
      JSON.stringify({ state: { theme: "daylight" }, version: 0 }),
    ),
  );
  await mockUpdate(page);
  let launched = false;
  await page.route("**/api/system/upgrade", (r) => {
    if (r.request().method() === "POST") {
      launched = true;
      return r.fulfill(json({ ok: true, launched: true }));
    }
    return r.fulfill(
      json({
        current: "0.7.0",
        supervised: true,
        installMode: "bundle",
        status: launched
          ? {
              phase: "downloading",
              from: "0.7.0",
              to: "0.7.99",
              startedAt: "2026-09-26T00:00:00.000Z",
              updatedAt: new Date().toISOString(),
            }
          : null,
        armed: null,
        idleWindowMs: 30_000,
        busy: [],
        background: [],
        inFlight: launched,
      }),
    );
  });
  await openDialog(page);
  const link = await contrastOf(page, '[aria-label="Release notes"] a');
  expect(link, "note link").toBeGreaterThanOrEqual(4.5);
  await page.getByTestId("update-start").click();
  const todo = page.locator('[data-testid="update-stages"] [data-state="todo"]');
  await expect(todo.first()).toBeVisible();
  const hint = await contrastOf(
    page,
    '[data-testid="update-stages"] [data-state="todo"] > span:last-child',
  );
  expect(hint, "stage hint").toBeGreaterThanOrEqual(4.5);
});
