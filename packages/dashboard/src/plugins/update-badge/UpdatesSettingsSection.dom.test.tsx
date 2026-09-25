// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test/setup-dom";
import { UpdatesSettingsSection } from "./UpdatesSettingsSection";
import { useUpdateBus } from "./updateBus";

/**
 * Settings → Updates lists every kept snapshot but offers Restore ONLY on the
 * one pairing with the previous code kept on disk (fromVersion ===
 * rollback.version) — restoring any other would mismatch code and records.
 */

const snap = (
  id: string,
  fromVersion: string,
  toVersion: string,
  createdAt: string,
) => ({
  id,
  fromVersion,
  toVersion,
  createdAt,
  entries: [],
  bytes: 200_000,
  agentCount: 3,
});

let snapshots: unknown;

beforeEach(() => {
  snapshots = {
    snapshots: [
      snap("s3", "0.7.0", "0.7.1", "2026-09-24T07:12:00Z"),
      snap("s2", "0.6.1", "0.7.0", "2026-08-26T05:13:00Z"),
      snap("s2old", "0.6.1", "0.7.0", "2026-08-25T09:00:00Z"),
      snap("s1", "0.6.0", "0.6.1", "2026-08-25T08:15:00Z"),
    ],
    // The previous code kept on disk is 0.6.1 and a Restore puts back the
    // NEWEST snapshot from it — s2, not the older s2old from the same version.
    rollback: { version: "0.6.1", snapshotId: "s2" },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url === "/api/system/snapshots"
              ? snapshots
              : url === "/api/system/check-updates"
                ? {
                    current: "0.7.1",
                    latest: "0.7.2",
                    updateAvailable: true,
                    checkedAt: "2026-09-25T08:00:00Z",
                  }
                : { version: "0.7.1", platform: "darwin", arch: "arm64" },
          ),
        ),
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderSection(onRestore = vi.fn()) {
  await act(async () => {
    render(
      <UpdatesSettingsSection
        onRestore={onRestore}
        updateCheckToggle={<div data-testid="toggle-slot" />}
      />,
    );
  });
  return onRestore;
}

describe("UpdatesSettingsSection", () => {
  it("shows the version and keeps the update-check toggle inside the section", async () => {
    await renderSection();
    expect(screen.getByTestId("settings-version").textContent).toContain(
      "v0.7.1",
    );
    expect(screen.getByTestId("settings-version").textContent).toContain(
      "updated",
    );
    expect(screen.getByTestId("toggle-slot")).toBeInTheDocument();
    expect(screen.getByText(/autonomos snapshots list/)).toBeInTheDocument();
  });

  it("lists snapshots newest-first and offers Restore only on the pairing row", async () => {
    const onRestore = await renderSection();
    const rows = screen.getAllByTestId("settings-snapshot");
    expect(
      rows.map((r) => r.textContent?.match(/Saved on v[\d.]+/)?.[0]),
    ).toEqual([
      "Saved on v0.7.0",
      "Saved on v0.6.1",
      "Saved on v0.6.1",
      "Saved on v0.6.0",
    ]);
    // What each snapshot preceded — the label says which state it holds.
    expect(rows[0].textContent).toContain("Saved on v0.7.0 · before v0.7.1");
    expect(rows.map((r) => r.getAttribute("data-restorable"))).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
    expect(screen.getAllByTestId("settings-restore")).toHaveLength(1);
    expect(rows[1].contains(screen.getByTestId("settings-restore"))).toBe(true);

    const before = useUpdateBus.getState().restoreNonce;
    fireEvent.click(screen.getByTestId("settings-restore"));
    expect(useUpdateBus.getState().restoreNonce).toBe(before + 1);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it("offers no Restore at all when nothing can be restored", async () => {
    snapshots = { ...(snapshots as object), rollback: null };
    await renderSection();
    expect(screen.getAllByTestId("settings-snapshot")).toHaveLength(4);
    expect(screen.queryByTestId("settings-restore")).toBeNull();
  });
  it("Check now runs the check, says what it found, and nudges the status-bar pill", async () => {
    await renderSection();
    const before = useUpdateBus.getState().versionNonce;
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-check-now"));
    });
    expect(screen.getByTestId("settings-check-result").textContent).toBe(
      "v0.7.2 is available — Update is in the status bar",
    );
    expect(useUpdateBus.getState().versionNonce).toBe(before + 1);
  });
});
