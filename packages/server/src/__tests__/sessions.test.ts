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
