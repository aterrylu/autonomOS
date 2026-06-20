import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  extractDashboardBuildId,
  readDashboardBuild,
} from "../dashboardBuild.js";

describe("extractDashboardBuildId", () => {
  it("extracts the hashed main bundle id from a Vite index.html", () => {
    const html = `<!doctype html><html><head>
      <script type="module" crossorigin src="/assets/index-DqFMNhch.js"></script>
      <link rel="stylesheet" crossorigin href="/assets/index-abc123.css">
      </head><body></body></html>`;
    assert.equal(extractDashboardBuildId(html), "index-DqFMNhch.js");
  });

  it("returns null when no main bundle script is present", () => {
    assert.equal(
      extractDashboardBuildId("<html><body>no bundle</body></html>"),
      null,
    );
  });

  it("does not match non-index asset references", () => {
    assert.equal(
      extractDashboardBuildId(
        '<script src="/assets/vendor-XYZ123.js"></script>',
      ),
      null,
    );
  });
});

describe("readDashboardBuild", () => {
  it("returns nulls and logs (does not throw) when index.html is unreadable", () => {
    const warn = mock.method(console, "warn", () => {});
    const result = readDashboardBuild("/no/such/dashboard/dist");
    assert.deepEqual(result, { build: null, builtAt: null });
    assert.equal(warn.mock.callCount(), 1);
    warn.mock.restore();
  });
});
