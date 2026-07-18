/**
 * argv parsing for autonomos-server, focused on --host.
 *
 * --host decides whether the server is reachable from the network, so a
 * mis-parse is a security bug rather than a UX one. The cases that matter are
 * the ones where a bad value could silently widen the bind instead of failing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCliArgs } from "../cli-args.js";

describe("parseCliArgs — --host", () => {
  it("is undefined when not passed (server then binds all interfaces)", () => {
    assert.equal(parseCliArgs([]).host, undefined);
  });

  it("parses both --host=H and --host H", () => {
    assert.equal(parseCliArgs(["--host=0.0.0.0"]).host, "0.0.0.0");
    assert.equal(parseCliArgs(["--host", "0.0.0.0"]).host, "0.0.0.0");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(parseCliArgs(["--host", " 127.0.0.1 "]).host, "127.0.0.1");
  });

  it("rejects an empty value instead of passing it to listen()", () => {
    // listen("") binds all interfaces — the opposite of the safe default.
    // Fail loudly rather than silently expose the port.
    assert.throws(() => parseCliArgs(["--host="]), /must not be empty/);
    assert.throws(() => parseCliArgs(["--host", "   "]), /must not be empty/);
  });

  it("rejects a missing value rather than swallowing the next flag", () => {
    assert.throws(() => parseCliArgs(["--host"]), /--host requires a value/);
  });

  it("still parses --port alongside --host", () => {
    const args = parseCliArgs(["--port=3100", "--host=0.0.0.0"]);
    assert.equal(args.port, 3100);
    assert.equal(args.host, "0.0.0.0");
  });
});
