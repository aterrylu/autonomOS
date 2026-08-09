import { defineConfig, devices } from "@playwright/test";

/**
 * L2 PERF config — drives the REAL dashboard against a REAL perf server
 * (synthetic session + burst trigger), measuring in-browser render cost.
 *
 * Unlike `playwright.config.ts` (mocked-backend UI flows), this hits a live
 * server. It does NOT manage the servers itself — start them with
 * `perf/run-l2.sh` (or manually) and point PERF_BASE at the vite origin. This
 * keeps the env-heavy tsx server command out of Playwright's webServer and
 * keeps the config CI-inert (LOCAL ONLY — not part of `make check`).
 *
 * Headed by default so the WebGL renderer path is real (headless Chromium uses
 * SwiftShader software-GL, which understates GPU gains). Set PERF_HEADLESS=1 to
 * override.
 */
const BASE_URL = process.env.PERF_BASE ?? "http://127.0.0.1:5179";

export default defineConfig({
  testDir: "./e2e-perf",
  testMatch: /.*\.perf\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    headless: process.env.PERF_HEADLESS === "1",
    trace: "off",
  },
  projects: [
    {
      name: "chromium-perf",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
