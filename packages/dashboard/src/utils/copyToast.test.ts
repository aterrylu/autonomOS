import { describe, expect, it } from "vitest";
import { COPY_TOAST_SUPPRESS_MS, shouldSuppressCopyToast } from "./copyToast";

describe("shouldSuppressCopyToast", () => {
  it("suppresses identical successful content within the window (streaming re-sync)", () => {
    expect(
      shouldSuppressCopyToast(
        { text: "abc", at: 1000 },
        { text: "abc", ok: true, at: 1500 },
      ),
    ).toBe(true);
  });

  it("does not suppress when the selection changed", () => {
    expect(
      shouldSuppressCopyToast(
        { text: "abc", at: 1000 },
        { text: "xyz", ok: true, at: 1100 },
      ),
    ).toBe(false);
  });

  it("does not suppress once the window has elapsed", () => {
    expect(
      shouldSuppressCopyToast(
        { text: "abc", at: 1000 },
        { text: "abc", ok: true, at: 1000 + COPY_TOAST_SUPPRESS_MS + 1 },
      ),
    ).toBe(false);
  });

  it("never suppresses a failed copy", () => {
    expect(
      shouldSuppressCopyToast(
        { text: "abc", at: 1000 },
        { text: "abc", ok: false, at: 1100 },
      ),
    ).toBe(false);
  });

  it("does not suppress the first copy (no prior content)", () => {
    expect(
      shouldSuppressCopyToast(
        { text: null, at: 0 },
        { text: "abc", ok: true, at: 100 },
      ),
    ).toBe(false);
  });
});
