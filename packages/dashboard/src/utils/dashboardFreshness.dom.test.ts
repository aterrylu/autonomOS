// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  getLoadedDashboardBuildId,
  isDashboardStale,
} from "./dashboardFreshness";

describe("isDashboardStale", () => {
  it("is true when both ids are known and differ", () => {
    expect(isDashboardStale("index-AAA.js", "index-BBB.js")).toBe(true);
  });

  it("is false when the ids match", () => {
    expect(isDashboardStale("index-AAA.js", "index-AAA.js")).toBe(false);
  });

  it("is false when the loaded id is unknown", () => {
    expect(isDashboardStale(null, "index-BBB.js")).toBe(false);
  });

  it("is false when the server id is unknown (dev server / older server)", () => {
    expect(isDashboardStale("index-AAA.js", null)).toBe(false);
    expect(isDashboardStale("index-AAA.js", undefined)).toBe(false);
  });
});

describe("getLoadedDashboardBuildId", () => {
  function setEntryScript(src: string): void {
    const s = document.createElement("script");
    s.type = "module";
    s.setAttribute("crossorigin", "");
    s.setAttribute("src", src);
    document.head.appendChild(s);
  }

  afterEach(() => {
    document.head.replaceChildren();
  });

  it("reads the hashed bundle id from the entry module script", () => {
    setEntryScript("/assets/index-DqFMNhch.js");
    expect(getLoadedDashboardBuildId(document)).toBe("index-DqFMNhch.js");
  });

  it("returns null when there is no built bundle script (e.g. Vite dev server)", () => {
    setEntryScript("/src/main.tsx");
    expect(getLoadedDashboardBuildId(document)).toBeNull();
  });
});
