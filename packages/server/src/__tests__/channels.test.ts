import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHANNEL_ID_RE, isValidChannelId } from "../channels.js";

describe("channels — isValidChannelId (tag-syntax)", () => {
  const validIds = ["server:autonomos", "server:custom_name"];
  const invalidIds = [
    "",
    // plugin:* channels were removed — stale entries from old
    // settings.json files must no longer validate.
    "plugin:telegram@claude-plugins-official",
    "plugin:discord@claude-plugins-official",
    "plugin:my-plugin@my-org",
    "telegram", // no tag
    "server:",
    "server::double",
    "server: spaced", // whitespace
    "http://foo.bar",
    "server:foo:bar", // extra colon
  ];

  for (const id of validIds) {
    it(`accepts ${JSON.stringify(id)}`, () => {
      assert.equal(isValidChannelId(id), true);
      assert.equal(CHANNEL_ID_RE.test(id), true);
    });
  }

  for (const id of invalidIds) {
    it(`rejects ${JSON.stringify(id)}`, () => {
      assert.equal(isValidChannelId(id), false);
    });
  }
});
