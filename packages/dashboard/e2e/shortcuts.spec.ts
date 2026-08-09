import { expect, type Page, test } from "@playwright/test";
import { mockApi } from "./mocks";

/**
 * Keyboard shortcut e2e (ADR-063) — the tests that jsdom cannot express:
 *
 *  1. Chrome actually delivers mod+digit to the page (the design's premise:
 *     select-tab-by-index is NOT on Chromium's reserved-key list), and the
 *     REAL wire-up chain works: DockviewLayout.onReady → registerDockviewApi →
 *     orderedPaneIds(real api.toJSON()) → setActive → store writeback. The
 *     unit suite fakes the api registration, so deleting the onReady
 *     registration line breaks only THIS spec.
 *  2. The key-capture boundary with a REAL focused xterm terminal: reserved
 *     chords (mod+B) win over the terminal; unreserved keys still reach the
 *     PTY socket; reserved digit chords never do.
 *  3. The help overlay takes focus (backing its aria-modal claim) and returns
 *     it to the terminal on Escape.
 */

const DISPATCHER = "agent-dispatcher-0001";
const RESEARCHER = "agent-researcher-0002";

/** Platform primary modifier of the browser under test — computed from the
 *  SAME source the app's `isMac` uses (userAgentData first). Under Playwright's
 *  "Desktop Chrome" device the emulated userAgentData says Linux even on a mac
 *  host while navigator.platform still says MacIntel; reading only the latter
 *  makes the spec press Meta while the app expects Control. */
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

/** Seed the persisted zustand blob before the app boots (see stuck-states). */
async function seedPersisted(page: Page, state: Record<string, unknown>) {
  await page.addInitScript(
    (s) =>
      localStorage.setItem("autonomos", JSON.stringify({ state: s, version: 0 })),
    state,
  );
}

/** A hand-authored two-group dockview layout: [Dispatcher | Researcher].
 *  Shape mirrors api.toJSON() (SerializedDockview) for dockview-core 7. */
function twoPaneWorkspace() {
  const panel = (id: string) => ({
    id,
    contentComponent: "pane",
    tabComponent: "status",
    params: { pane: { type: "session", id } },
    title: id,
  });
  return {
    activePane: { type: "session", id: DISPATCHER },
    dvWorkspaces: {
      ws1: {
        paneIds: [DISPATCHER, RESEARCHER],
        serialized: {
          grid: {
            root: {
              type: "branch",
              data: [
                {
                  type: "leaf",
                  data: { views: [DISPATCHER], activeView: DISPATCHER, id: "1" },
                  size: 400,
                },
                {
                  type: "leaf",
                  data: { views: [RESEARCHER], activeView: RESEARCHER, id: "2" },
                  size: 400,
                },
              ],
              size: 600,
            },
            width: 800,
            height: 600,
            orientation: "HORIZONTAL",
          },
          panels: {
            [DISPATCHER]: panel(DISPATCHER),
            [RESEARCHER]: panel(RESEARCHER),
          },
          activeGroup: "1",
        },
      },
    },
    dvPaneWorkspace: { [DISPATCHER]: "ws1", [RESEARCHER]: "ws1" },
  };
}

function activePaneId(page: Page) {
  return page.evaluate(() => {
    const store = (
      window as unknown as {
        __autonomosStore?: {
          getState: () => { activePane: { id: string } | null };
        };
      }
    ).__autonomosStore;
    return store?.getState().activePane?.id ?? null;
  });
}

/** Focus the first terminal and wait until xterm's textarea owns focus. */
async function focusTerminal(page: Page) {
  await page.locator(".xterm-helper-textarea").first().focus();
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.activeElement?.classList.contains("xterm-helper-textarea"),
      ),
    )
    .toBe(true);
}

test("mod+digit switches to the Nth SIDEBAR agent through the real published order", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();

  // Both mocked agents are listed in the sidebar (Dispatcher above Researcher).
  const rows = page.locator("aside");
  await expect(rows.getByText("Dispatcher")).toBeVisible();
  await expect(rows.getByText("Researcher")).toBeVisible();
  const mod = await modKey(page);

  // mod+2 switches to the SECOND sidebar row — even though no pane for it was
  // open (this is agent navigation, not open-pane cycling). Crosses the real
  // chain: Sidebar publishes sidebarRowOrder → registry action → switchPane.
  await page.keyboard.press(`${mod}+2`);
  await expect.poll(() => activePaneId(page)).toBe(RESEARCHER);

  await page.keyboard.press(`${mod}+1`);
  await expect.poll(() => activePaneId(page)).toBe(DISPATCHER);
});

test("reserved chords beat a focused terminal; passthrough keys still reach the PTY socket", async ({
  page,
}) => {
  await mockApi(page);
  // Recording WebSocket stub that pretends the terminal socket is OPEN, so
  // xterm→PTY bytes are observable. Added AFTER mockApi so this class (not
  // its closed no-op stub) is the one the app constructs.
  await page.addInitScript(() => {
    (window as unknown as { __wsSent: string[] }).__wsSent = [];
    class RecordingWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly OPEN = 1;
      url: string;
      readyState = 1; // OPEN
      binaryType: BinaryType = "blob";
      onopen: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
        setTimeout(() => {
          this.onopen?.(new Event("open"));
          this.dispatchEvent(new Event("open"));
        }, 0);
      }
      send(data: unknown) {
        if (typeof data === "string" && this.url.includes("/ws/terminal/")) {
          (window as unknown as { __wsSent: string[] }).__wsSent.push(data);
        }
      }
      close() {}
    }
    // @ts-expect-error overriding the global for the test environment
    window.WebSocket = RecordingWebSocket;
  });
  await seedPersisted(page, twoPaneWorkspace());
  await page.goto("/");
  await expect(page.locator(".dv-tab")).toHaveCount(2);
  const mod = await modKey(page);

  await focusTerminal(page);

  // Reserved chord: mod+B closes the sidebar even though xterm has focus.
  await expect(page.locator("aside")).toBeVisible();
  await page.keyboard.press(`${mod}+b`);
  await expect(page.locator("aside")).toHaveCount(0);
  await page.keyboard.press(`${mod}+b`); // restore

  // Passthrough: a plain key typed into the terminal reaches the socket.
  await focusTerminal(page);
  await page.keyboard.type("x");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __wsSent: string[] }).__wsSent.join(""),
      ),
    )
    .toContain("x");

  // ADR-065: ctrl+d is FREED — EOF must reach the PTY (the legacy swallow ate
  // it). In this non-mac-emulated browser ctrl IS mod, and mod+d is
  // deliberately unregistered.
  const eofBefore = await page.evaluate(
    () => (window as unknown as { __wsSent: string[] }).__wsSent.length,
  );
  await page.keyboard.press("Control+d");
  await expect
    .poll(() =>
      page.evaluate(
        (n) =>
          (window as unknown as { __wsSent: string[] }).__wsSent
            .slice(n)
            .join(""),
        eofBefore,
      ),
    )
    .toContain("\x04");

  // Reserved digit chord: switches panes, and no digit byte reaches the PTY.
  const sentBefore = await page.evaluate(
    () => (window as unknown as { __wsSent: string[] }).__wsSent.length,
  );
  await page.keyboard.press(`${mod}+2`);
  await expect.poll(() => activePaneId(page)).toBe(RESEARCHER);
  const sentAfter = await page.evaluate(() =>
    (window as unknown as { __wsSent: string[] }).__wsSent.slice(),
  );
  expect(sentAfter.slice(sentBefore).join("")).not.toContain("2");
});

test("mod+/ overlay takes focus and Escape returns it to the terminal", async ({
  page,
}) => {
  await mockApi(page);
  await seedPersisted(page, twoPaneWorkspace());
  await page.goto("/");
  await expect(page.locator(".dv-tab")).toHaveCount(2);
  const mod = await modKey(page);

  await focusTerminal(page);
  await page.keyboard.press(`${mod}+Slash`);
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  // The dialog itself owns focus — typed keys must not leak to the terminal.
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.getAttribute("role") === "dialog",
      ),
    )
    .toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Focus returned to the terminal that had it before mod+/.
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.activeElement?.classList.contains("xterm-helper-textarea"),
      ),
    )
    .toBe(true);
});

test("Escape closes an open panel even with a terminal focused — and only then reaches the shell", async ({
  page,
}) => {
  await mockApi(page);
  await page.addInitScript(() => {
    (window as unknown as { __wsSent: string[] }).__wsSent = [];
    class RecordingWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly OPEN = 1;
      url: string;
      readyState = 1;
      binaryType: BinaryType = "blob";
      onopen: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
        setTimeout(() => {
          this.onopen?.(new Event("open"));
          this.dispatchEvent(new Event("open"));
        }, 0);
      }
      send(data: unknown) {
        if (typeof data === "string" && this.url.includes("/ws/terminal/")) {
          (window as unknown as { __wsSent: string[] }).__wsSent.push(data);
        }
      }
      close() {}
    }
    // @ts-expect-error overriding the global for the test environment
    window.WebSocket = RecordingWebSocket;
  });
  await seedPersisted(page, twoPaneWorkspace());
  await page.goto("/");
  await expect(page.locator(".dv-tab")).toHaveCount(2);

  // Open the notification panel from the status bar…
  await page.getByTitle("Notifications").click();
  const panelHeader = page.getByText("Notifications", { exact: true });
  await expect(panelHeader).toBeVisible();

  // …then move focus back into a terminal (the case the old bubble-phase
  // listener silently failed on: xterm stopPropagation()s Escape).
  await focusTerminal(page);

  const before = await page.evaluate(
    () => (window as unknown as { __wsSent: string[] }).__wsSent.length,
  );
  await page.keyboard.press("Escape");
  await expect(panelHeader).toHaveCount(0); // panel closed
  const afterClose = await page.evaluate(
    (n) =>
      (window as unknown as { __wsSent: string[] }).__wsSent.slice(n).join(""),
    before,
  );
  expect(afterClose).not.toContain("\x1b"); // ESC consumed by the app, not the shell

  // With nothing open, Escape belongs to the terminal again.
  await focusTerminal(page);
  const before2 = await page.evaluate(
    () => (window as unknown as { __wsSent: string[] }).__wsSent.length,
  );
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      page.evaluate(
        (n) =>
          (window as unknown as { __wsSent: string[] }).__wsSent
            .slice(n)
            .join(""),
        before2,
      ),
    )
    .toContain("\x1b");
});

test("holding mod reveals digit badges on the sidebar agent rows", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();
  await expect(page.locator("aside").getByText("Researcher", { exact: true })).toBeVisible();
  const mod = await modKey(page);
  const badges = page.getByTestId("agent-digit-badge");

  await expect(badges).toHaveCount(0); // none at rest

  await page.keyboard.down(mod);
  await expect(badges).toHaveCount(2); // auto-waits past the hold delay
  await expect(badges.nth(0)).toHaveText("1");
  await expect(badges.nth(1)).toHaveText("2");

  // The badge IS the chord: press 2 while holding → that agent activates.
  await page.keyboard.press("2");
  await expect.poll(() => activePaneId(page)).toBe(RESEARCHER);
  await expect(badges).toHaveCount(2); // still holding — hints stay up

  await page.keyboard.up(mod);
  await expect(badges).toHaveCount(0);
});

test("mod+arrows walk the sidebar; hold shows \u2191/\u2193 on the active agent's neighbors", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator("aside").getByText("Researcher", { exact: true })).toBeVisible();
  const mod = await modKey(page);

  // Anchor on the FIRST agent, then walk down and clamp.
  await page.keyboard.press(`${mod}+1`);
  await expect.poll(() => activePaneId(page)).toBe(DISPATCHER);
  await page.keyboard.press(`${mod}+ArrowDown`);
  await expect.poll(() => activePaneId(page)).toBe(RESEARCHER);
  await page.keyboard.press(`${mod}+ArrowDown`); // last row → clamp
  await expect.poll(() => activePaneId(page)).toBe(RESEARCHER);
  await page.keyboard.press(`${mod}+ArrowUp`);
  await expect.poll(() => activePaneId(page)).toBe(DISPATCHER);

  // Hold: active is row 1, so its down-neighbor (row 2) shows the ↓ arrow.
  await page.keyboard.down(mod);
  const arrows = page.getByTestId("agent-arrow-badge");
  await expect(arrows).toHaveCount(1);
  await expect(arrows.first()).toHaveText("\u2193");
  await page.keyboard.up(mod);
  await expect(arrows).toHaveCount(0);
});

test("mod+K quick-switcher: fuzzy-find an agent and switch, even from a focused terminal", async ({
  page,
}) => {
  await mockApi(page);
  await seedPersisted(page, twoPaneWorkspace());
  await page.goto("/");
  await expect(page.locator(".dv-tab")).toHaveCount(2);
  const mod = await modKey(page);

  // From a FOCUSED TERMINAL: mod+K must open the switcher (it used to clear
  // the terminal — that moved to mod+Shift+K — see the quick-switcher ADR).
  await focusTerminal(page);
  await page.keyboard.press(`${mod}+k`);
  const dialog = page.getByRole("dialog", { name: "Switch to agent" });
  await expect(dialog).toBeVisible();
  const input = page.getByTestId("quick-switcher-input");
  await expect(input).toBeFocused();

  // Type-ahead: filter to Researcher, Enter switches and closes.
  await input.fill("resear");
  await expect(page.getByTestId("quick-switcher-item")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => activePaneId(page)).toBe(RESEARCHER);

  // Escape closes a reopened switcher without switching.
  await page.keyboard.press(`${mod}+k`);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => activePaneId(page)).toBe(RESEARCHER);
});

test("quick-switcher reaches a NEVER-mounted pane and focus lands in its terminal", async ({
  page,
}) => {
  await mockApi(page);
  // No seeded workspace: panes mount solo, on demand. Open ONLY Dispatcher…
  await page.goto("/");
  await expect(page.locator("aside").getByText("Dispatcher")).toBeVisible();
  await page.locator("aside").getByText("Dispatcher").click();
  await expect.poll(() => activePaneId(page)).toBe(DISPATCHER);
  const mod = await modKey(page);

  // …then ⌘K to an agent whose pane has NEVER mounted. focusTerminal must
  // wait out registration (independent budget) and land focus in the new
  // pane's xterm textarea — not on document.body.
  await page.keyboard.press(`${mod}+k`);
  await page.getByTestId("quick-switcher-input").fill("resear");
  await page.keyboard.press("Enter");
  await expect.poll(() => activePaneId(page)).toBe(RESEARCHER);
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.activeElement?.classList.contains("xterm-helper-textarea"),
      ),
    )
    .toBe(true);
});
