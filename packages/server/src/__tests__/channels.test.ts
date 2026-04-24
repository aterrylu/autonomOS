import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHANNEL_ID_RE,
  channelStatus,
  type InstalledPlugin,
  isValidChannelId,
} from "../channels.js";

describe("channels — isValidChannelId (tag-syntax)", () => {
  const validIds = [
    "plugin:telegram@claude-plugins-official",
    "plugin:discord@claude-plugins-official",
    "plugin:my-plugin@my-org",
    "server:autonomos",
    "server:custom_name",
  ];
  const invalidIds = [
    "",
    "plugin:telegram", // no marketplace
    "plugin:@claude-plugins-official", // no name
    "plugin:name@", // no marketplace
    "plugin: telegram@foo", // whitespace
    "telegram", // no tag
    "server:",
    "server::double",
    "http://foo.bar",
    "plugin:telegram:extra@marketplace", // extra colon
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

describe("channels — channelStatus", () => {
  const installed: InstalledPlugin[] = [
    { id: "telegram@claude-plugins-official", enabled: true },
    { id: "discord@claude-plugins-official", enabled: false },
  ];

  it("server: channels always return ok even when detection fails", () => {
    assert.equal(channelStatus("server:autonomos", installed), "ok");
    assert.equal(channelStatus("server:autonomos", []), "ok");
    // server:* short-circuits before the null check — a broken
    // `claude plugin list` must not make the gateway look broken.
    assert.equal(channelStatus("server:autonomos", null), "ok");
  });

  it("installed + enabled plugin → ok", () => {
    assert.equal(
      channelStatus("plugin:telegram@claude-plugins-official", installed),
      "ok",
    );
  });

  it("installed + disabled plugin → disabled", () => {
    assert.equal(
      channelStatus("plugin:discord@claude-plugins-official", installed),
      "disabled",
    );
  });

  it("not-in-list plugin → not-installed", () => {
    assert.equal(
      channelStatus("plugin:ghost@claude-plugins-official", installed),
      "not-installed",
    );
  });

  it("null installed (detection failed) → unknown for everything non-server", () => {
    assert.equal(
      channelStatus("plugin:telegram@claude-plugins-official", null),
      "unknown",
    );
  });
});
