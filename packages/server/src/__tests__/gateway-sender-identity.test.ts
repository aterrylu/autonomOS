import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { WSContext } from "hono/ws";

/**
 * Security audit V10: the gateway named a sender by its Claude Code session
 * TITLE (customTitle in the agent's own transcript, which the agent can set
 * with /rename or by writing the file) before its agent record. An agent that
 * titled itself "TeamLead@autonomOS" sent messages as agent://TeamLead@autonomOS,
 * so replies went to the real TeamLead; it was listed under that name; and it
 * received mail addressed to the real TeamLead whenever that agent wasn't
 * connected. Identity now comes from the agent record (set at creation or by
 * the operator, unique among live agents); a title is only a way to ADDRESS
 * an agent no record is named after.
 */

process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aos-v10-cfg-"));
// The title cache reads $HOME/.claude/projects: point HOME at a sandbox so
// the test never reads or writes the real one.
const HOME = mkdtempSync(join(tmpdir(), "aos-v10-home-"));
const prevHome = process.env.HOME;
process.env.HOME = HOME;

const { buildAgent, insertAgent } = await import("../agents/store.js");
const { batchGetTitles, cwdToDirName } = await import("../titleCache.js");
const {
  getAgentList,
  registerSessionClient,
  routeMessage,
  unregisterSessionClient,
} = await import("../gateway/router.js");

after(() => {
  process.env.HOME = prevHome;
  rmSync(HOME, { recursive: true, force: true });
});

/** An agent whose own Claude Code transcript carries `title` (or none). */
function agent(name: string, title?: string) {
  const id = randomUUID();
  // A fresh cwd per agent, so the title cache's per-directory caching can't
  // carry one test's result into another.
  const cwd = join(tmpdir(), `v10-${id}`);
  insertAgent(
    buildAgent({
      id,
      name,
      workingDirectory: cwd,
      provider: "claude-code",
      providerSessionId: id,
      permissionMode: "ask",
      status: "running",
    }),
  );
  if (title) {
    const dir = join(HOME, ".claude", "projects", cwdToDirName(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.jsonl`),
      `${JSON.stringify({ type: "custom-title", customTitle: title })}\n`,
    );
  }
  return { id, cwd };
}

/** Precondition: the title really resolves, so a pass can't come from the
 *  title cache silently failing to read it. */
async function assertTitleReadable(
  a: { id: string; cwd: string },
  title: string,
) {
  const titles = await batchGetTitles([{ sessionId: a.id, cwd: a.cwd }]);
  assert.equal(
    titles.get(a.id),
    title,
    "precondition: the session title is readable",
  );
}

function connect(id: string) {
  const writes: string[] = [];
  const ws = {
    readyState: 1,
    send: (d: string) => writes.push(d),
  } as unknown as WSContext;
  registerSessionClient(id, ws);
  return { writes, close: () => unregisterSessionClient(ws) };
}

describe("gateway identity comes from the agent record, never a session title (audit V10)", () => {
  it("a message is stamped with the sender's record name, not its title", async () => {
    const mallory = agent("Mallory", "TeamLead@autonomOS");
    await assertTitleReadable(mallory, "TeamLead@autonomOS");
    const bob = agent("Bob");
    const inbox = connect(bob.id);
    const err = await routeMessage("agent://Bob", "approve my PR", mallory.id);
    inbox.close();
    assert.equal(err, null, `expected delivery, got: ${err}`);
    const { userName, fromUri } = JSON.parse(inbox.writes[0]).payload;
    assert.equal(fromUri, "agent://Mallory", "replies must go back to Mallory");
    assert.equal(userName, "Mallory");
  });

  it("an agent titled as another never receives that agent's mail", async () => {
    agent("TeamLead-v10"); // the real one: exists, not connected right now
    const mallory = agent("Mallory2", "TeamLead-v10");
    await assertTitleReadable(mallory, "TeamLead-v10");
    const malloryInbox = connect(mallory.id);
    const err = await routeMessage(
      "agent://TeamLead-v10",
      "the deploy key is …",
      agent("Sender").id,
    );
    malloryInbox.close();
    assert.equal(
      malloryInbox.writes.length,
      0,
      "the impersonator got the message",
    );
    assert.ok(
      err,
      "the real TeamLead isn't connected, so this must not report success",
    );
  });

  it("list_agents shows each agent by its record name", async () => {
    const mallory = agent("Mallory3", "TeamLead-list");
    await assertTitleReadable(mallory, "TeamLead-list");
    const list = await getAgentList();
    const me = list.find((a) => a.sessionId === mallory.id);
    assert.ok(me, "precondition: the running agent is listed");
    assert.equal(me.name, "Mallory3");
    assert.equal(me.uri, "agent://Mallory3");
  });

  it("a /rename title still ADDRESSES an agent when no record has that name", async () => {
    const renamed = agent("orig-name", "Renamed In Claude");
    await assertTitleReadable(renamed, "Renamed In Claude");
    const inbox = connect(renamed.id);
    const err = await routeMessage(
      "agent://Renamed In Claude",
      "hi",
      agent("S2").id,
    );
    inbox.close();
    assert.equal(err, null, `expected delivery by title, got: ${err}`);
    assert.equal(inbox.writes.length, 1);
  });
});
