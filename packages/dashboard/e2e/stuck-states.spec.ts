import { expect, type Page, test } from "@playwright/test";
import { MOCK_AGENTS, mockApi } from "./mocks";

/**
 * Regression coverage for the dashboard stuck-state bug sweep — drives the REAL
 * app (real store/merge/DockviewLayout/ErrorBoundary) in a real Chromium against
 * mocked APIs, exercising the full rehydrate → mount → fetch → reconcile pipeline
 * that unit tests can't reach. Each test guards one "can't get out of it" state:
 *   A — a corrupt persisted layout must boot cleanly (merge sanitizes), not blank.
 *   C — a killed workspace member is reconciled out so clicks don't rebuild.
 *   D — killing the active member retargets to a live sibling, not the empty state.
 */

const DISPATCHER = "agent-dispatcher-0001";
const RESEARCHER = "agent-researcher-0002";

/** Seed the persisted zustand blob before the app boots. */
async function seedPersisted(page: Page, state: Record<string, unknown>) {
  await page.addInitScript(
    (s) => localStorage.setItem("autonomos", JSON.stringify({ state: s, version: 0 })),
    state,
  );
}

function storeSnapshot(page: Page) {
  return page.evaluate(() => {
    const s = (
      window as unknown as {
        __autonomosStore: {
          getState: () => {
            activePane: unknown;
            dvWorkspaces: Record<string, unknown>;
            dvPaneWorkspace: Record<string, string>;
            sessionsInitialFetchDone: boolean;
          };
        };
      }
    ).__autonomosStore.getState();
    return {
      activePane: s.activePane,
      dvWorkspaces: s.dvWorkspaces,
      dvPaneWorkspace: s.dvPaneWorkspace,
      fetched: s.sessionsInitialFetchDone,
    };
  });
}

// ── Cluster A: corrupt persisted layout must NOT blank the app ──────────
test("A: corrupt activePane + poison workspace boot cleanly (merge sanitizes)", async ({
  page,
}) => {
  await mockApi(page);
  await seedPersisted(page, {
    activePane: { type: "session" }, // no id → invalid
    dvWorkspaces: { poison: { paneIds: ["x"], serialized: 12345 } }, // non-object serialized
    dvPaneWorkspace: { x: "poison" },
  });
  await page.goto("/");

  // App boots to the real UI, NOT a blank tree or the ErrorBoundary fallback.
  await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();
  await expect(page.getByText("The dashboard hit an error")).toHaveCount(0);

  const snap = await storeSnapshot(page);
  expect(snap.activePane).toBeNull(); // invalid activePane rejected
  expect(snap.dvWorkspaces).toEqual({}); // poison workspace dropped by merge
});

// ── Cluster C: a dead workspace member is reconciled out ────────────────
test("C: dead member dropped from a bound workspace, live members kept", async ({
  page,
}) => {
  await mockApi(page); // MOCK_AGENTS = Dispatcher + Researcher (both live)
  // activePane is a singleton, so ws1 stays bound-but-unmounted: this isolates
  // the fetchSessions reconcile path (no fromJSON restore of the fake blob).
  await seedPersisted(page, {
    activePane: { type: "orgchart", id: "orgchart" },
    dvWorkspaces: {
      ws1: {
        paneIds: [DISPATCHER, RESEARCHER, "dead-agent-999"],
        serialized: { grid: {} },
      },
    },
    dvPaneWorkspace: {
      [DISPATCHER]: "ws1",
      [RESEARCHER]: "ws1",
      "dead-agent-999": "ws1",
    },
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();

  // After the first fetch, reconcileDeadWorkspaces drops the dead id but keeps
  // the 2 live members (group stays intact).
  await expect
    .poll(async () => (await storeSnapshot(page)).dvWorkspaces)
    .toEqual({ ws1: { paneIds: [DISPATCHER, RESEARCHER], serialized: { grid: {} } } });
  const snap = await storeSnapshot(page);
  expect(snap.dvPaneWorkspace).toEqual({ [DISPATCHER]: "ws1", [RESEARCHER]: "ws1" });
});

// ── Cluster D: active pane death falls back to a live sibling ───────────
test("D: killing the active member retargets to a live sibling, not blank", async ({
  page,
}) => {
  // Dispatcher "died": the agents endpoint returns only Researcher.
  await mockApi(page, { agents: MOCK_AGENTS.filter((a) => a.id === RESEARCHER) });
  await seedPersisted(page, {
    activePane: { type: "session", id: DISPATCHER },
    dvWorkspaces: {
      ws1: { paneIds: [DISPATCHER, RESEARCHER], serialized: { grid: {} } },
    },
    dvPaneWorkspace: { [DISPATCHER]: "ws1", [RESEARCHER]: "ws1" },
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "autonomOS" })).toBeVisible();

  // fetchSessions sees Dispatcher gone → pickActiveFallback lands on Researcher.
  await expect
    .poll(async () => (await storeSnapshot(page)).activePane)
    .toEqual({ type: "session", id: RESEARCHER });
});
