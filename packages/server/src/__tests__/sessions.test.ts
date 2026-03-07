import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getSession,
  getAllSessions,
  killSession,
  killAllSessions,
  expandPath,
  _resetForTesting,
} from "../sessions.js";

describe("expandPath", () => {
  it("expands ~ to HOME", () => {
    const result = expandPath("~/projects");
    assert.equal(result, `${process.env.HOME}/projects`);
  });

  it("leaves absolute paths unchanged", () => {
    assert.equal(expandPath("/tmp/foo"), "/tmp/foo");
  });

  it("only expands leading ~", () => {
    assert.equal(expandPath("/home/~user"), "/home/~user");
  });

  it("expands bare ~ to HOME", () => {
    assert.equal(expandPath("~"), process.env.HOME);
  });

  it("throws when HOME is unset and path starts with ~", () => {
    const origHome = process.env.HOME;
    try {
      delete process.env.HOME;
      assert.throws(() => expandPath("~/projects"), {
        message: "HOME environment variable is not set",
      });
    } finally {
      process.env.HOME = origHome;
    }
  });
});

describe("session map operations", () => {
  afterEach(() => {
    killAllSessions();
    _resetForTesting();
  });

  it("getSession returns undefined for unknown id", () => {
    assert.equal(getSession("nonexistent"), undefined);
  });

  it("killSession returns false for unknown id", () => {
    assert.equal(killSession("nonexistent"), false);
  });

  it("getAllSessions returns empty array initially", () => {
    assert.deepEqual(getAllSessions(), []);
  });
});
