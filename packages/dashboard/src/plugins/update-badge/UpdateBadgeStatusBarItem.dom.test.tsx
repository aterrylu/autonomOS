// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../test/setup-dom";
import { UpdateBadgeStatusBarItem } from "./UpdateBadgeStatusBarItem";

/**
 * UpdateBadgeStatusBarItem — the PASSIVE update indicator (ADR-077 §6). It
 * reads the server's cached update-check answer off /api/system/version and
 * renders a pill only when an update is known. Everything else — no update,
 * fields absent (older server), fetch failure — renders NOTHING: null is the
 * normal state, and there is deliberately no button.
 */

function stubVersionFetch(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const mock = vi.fn(() =>
    Promise.resolve({
      ok,
      json: () => Promise.resolve(body),
    } as Response),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UpdateBadgeStatusBarItem", () => {
  it("renders the pill when the server reports an update", async () => {
    const fetchMock = stubVersionFetch({
      version: "0.5.0",
      platform: "darwin",
      arch: "arm64",
      latest: "0.6.0",
      updateAvailable: true,
      checkedAt: "2026-08-09T00:00:00Z",
      installMode: "bundle",
    });
    await act(async () => {
      render(<UpdateBadgeStatusBarItem />);
    });
    const badge = await screen.findByTestId("update-badge");
    expect(badge.textContent).toContain("v0.6.0 available");
    // The tooltip carries the CLI instruction — the badge is passive.
    expect(badge.getAttribute("title")).toContain("autonomos upgrade");
    // THE invariant this feature leads with: the dashboard reads only the
    // server's cached answer — it never contacts GitHub (or anywhere else).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/system/version");
  });

  it("points a dev checkout at git pull + make prod, not at a command that refuses", async () => {
    stubVersionFetch({
      version: "0.5.0",
      platform: "darwin",
      arch: "arm64",
      latest: "0.6.0",
      updateAvailable: true,
      checkedAt: "2026-08-09T00:00:00Z",
      installMode: null,
    });
    await act(async () => {
      render(<UpdateBadgeStatusBarItem />);
    });
    const badge = await screen.findByTestId("update-badge");
    expect(badge.getAttribute("title")).toContain("git pull && make prod");
    expect(badge.getAttribute("title")).not.toContain("autonomos upgrade");
  });

  it("renders nothing when updateAvailable is true but latest is absent (no 'vnull')", async () => {
    stubVersionFetch({
      version: "0.5.0",
      platform: "darwin",
      arch: "arm64",
      latest: null,
      updateAvailable: true,
      checkedAt: "2026-08-09T00:00:00Z",
    });
    await act(async () => {
      render(<UpdateBadgeStatusBarItem />);
    });
    expect(screen.queryByTestId("update-badge")).toBeNull();
  });

  it("renders nothing when up to date", async () => {
    stubVersionFetch({
      version: "0.5.0",
      platform: "darwin",
      arch: "arm64",
      latest: "0.5.0",
      updateAvailable: false,
      checkedAt: "2026-08-09T00:00:00Z",
    });
    await act(async () => {
      render(<UpdateBadgeStatusBarItem />);
    });
    expect(screen.queryByTestId("update-badge")).toBeNull();
  });

  it("renders nothing against an older server without the additive fields", async () => {
    stubVersionFetch({ version: "0.5.0", platform: "darwin", arch: "arm64" });
    await act(async () => {
      render(<UpdateBadgeStatusBarItem />);
    });
    expect(screen.queryByTestId("update-badge")).toBeNull();
  });

  it("renders nothing when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    await act(async () => {
      render(<UpdateBadgeStatusBarItem />);
    });
    expect(screen.queryByTestId("update-badge")).toBeNull();
  });
});
