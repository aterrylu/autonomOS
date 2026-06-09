import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e config — Testing layer L4 (Integration — UI).
 *
 * SAFETY: this drives the dashboard FRONTEND ONLY. The `webServer` below boots
 * the `vite` dev server (`packages/dashboard`) — it does NOT start the autonomos
 * backend (`packages/server`), and it never spawns `claude`, an agent, or any
 * PTY. Every `/api/*` HTTP call and every `/ws/*` WebSocket the dashboard makes
 * is intercepted with canned responses inside the specs (see `e2e/mocks.ts`),
 * so the whole suite runs with zero backend and zero real processes. The vite
 * proxy targets in `vite.config.ts` (→ localhost:3101) are therefore never hit.
 *
 * `make dev` / `make prod` / the `autonomos` CLI are intentionally NOT used here.
 */

const PORT = Number(process.env.E2E_PORT ?? 5180);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Spec files live under e2e/ — kept OUT of src/ so the vitest unit run
  // (include: src/**/*.test.{ts,tsx}) and `tsc --build` (include: ["src"])
  // never pick them up. Only files ending in .spec.ts are treated as tests.
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 30_000,
  expect: { timeout: 7_500 },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    // Headless chromium only — fast, deterministic, and all we need for the
    // mocked-API UI flows. No live terminal streaming here (deferred).
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Boot the REAL dashboard via vite — the same dev server `make dev` runs,
    // but standalone (no backend behind the proxy; the specs mock every route).
    // Use the local binary directly: webServer runs under /bin/sh, which does
    // not have node_modules/.bin on PATH.
    command: `node_modules/.bin/vite --port ${PORT} --strictPort`,
    url: BASE_URL,
    // In CI always start a fresh server; locally reuse a running one if present.
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
