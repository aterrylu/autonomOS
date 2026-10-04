import { describe, expect, it } from "vitest";
import { causesNeverAsks } from "./RuntimePermission";

/**
 * Amber marks the value that CAUSES "never asks", not every value that happens
 * to be selected while it's in force (the first live render painted Codex's
 * `user` reviewer and `danger-full-access` amber just because
 * approval_policy=never was also set).
 */
describe("causesNeverAsks", () => {
  const codexNever = {
    approval_policy: "never",
    sandbox_mode: "danger-full-access",
    approvals_reviewer: "user",
    collaboration_mode: "default",
  };

  it("marks the value that makes it never ask", () => {
    expect(
      causesNeverAsks("codex", codexNever, "approval_policy", "never"),
    ).toBe(true);
    expect(
      causesNeverAsks(
        "claude-code",
        { "permission-mode": "manual" },
        "permission-mode",
        "bypassPermissions",
      ),
    ).toBe(true);
    expect(
      causesNeverAsks(
        "gemini-cli",
        { "approval-mode": "default" },
        "approval-mode",
        "yolo",
      ),
    ).toBe(true);
  });

  it("doesn't mark the other axes' values while never-asks is in force", () => {
    expect(
      causesNeverAsks(
        "codex",
        codexNever,
        "sandbox_mode",
        "danger-full-access",
      ),
    ).toBe(false);
    expect(
      causesNeverAsks("codex", codexNever, "approvals_reviewer", "user"),
    ).toBe(false);
  });

  it("doesn't mark a value that asks", () => {
    expect(
      causesNeverAsks("codex", codexNever, "approval_policy", "on-request"),
    ).toBe(false);
    expect(
      causesNeverAsks(
        "claude-code",
        { "permission-mode": "manual" },
        "permission-mode",
        "acceptEdits",
      ),
    ).toBe(false);
  });
});
