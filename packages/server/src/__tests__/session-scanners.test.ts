/**
 * Codex + Gemini session discovery for Projects (sessionScanners.ts), against
 * files shaped exactly like each CLI writes them (codex 0.154, gemini 0.46),
 * in throwaway homes — never the operator's real ~/.codex or ~/.gemini.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const {
  _resetSessionScannerCachesForTesting,
  findGeminiSession,
  listCodexSessions,
  listGeminiSessions,
  MAX_FILES,
  parseCodexHead,
  parseGeminiHead,
} = await import("../sessionScanners.js");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aos-scan-"));
  _resetSessionScannerCachesForTesting();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const whole = (text: string) => ({ text, truncated: false });

function codexLines(
  id: string,
  cwd: string,
  prompt?: string,
  originator = "codex_cli_rs",
) {
  const lines = [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id,
        cwd,
        originator,
        base_instructions: { text: "x".repeat(6000) },
      },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: { approval_policy: "on-request" },
    }),
  ];
  if (prompt)
    lines.push(
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: prompt },
      }),
    );
  return `${lines.join("\n")}\n`;
}

function writeRollout(
  day: string,
  id: string,
  cwd: string,
  prompt?: string,
  mtime?: number,
) {
  const dir = join(home, "sessions", ...day.split("/"));
  mkdirSync(dir, { recursive: true });
  const f = join(
    dir,
    `rollout-${day.replaceAll("/", "-")}T00-00-00-${id}.jsonl`,
  );
  writeFileSync(f, codexLines(id, cwd, prompt));
  if (mtime) utimesSync(f, mtime / 1000, mtime / 1000);
  return f;
}

function writeGemini(
  root: string,
  id: string,
  prompt?: string,
  opts: { kind?: string; slug?: string; newline?: boolean } = {},
) {
  const dir = join(home, ".gemini", "tmp", opts.slug ?? "proj");
  mkdirSync(join(dir, "chats"), { recursive: true });
  writeFileSync(join(dir, ".project_root"), root);
  const lines = [
    JSON.stringify({
      sessionId: id,
      projectHash: "abc",
      startTime: "t",
      lastUpdated: "t",
      kind: opts.kind ?? "main",
    }),
  ];
  if (prompt)
    lines.push(JSON.stringify({ type: "user", content: [{ text: prompt }] }));
  const f = join(
    dir,
    "chats",
    `session-2026-09-26T00-00-${id.slice(0, 8)}.jsonl`,
  );
  writeFileSync(f, lines.join("\n") + (opts.newline === false ? "" : "\n"));
  return f;
}

describe("parseCodexHead", () => {
  it("reads id, cwd and the first prompt; classifies the originator", () => {
    const row = parseCodexHead(
      whole(codexLines("t1", "/w/p", "fix the bug", "autonomos-gateway")),
    );
    assert.equal(row?.cwd, "/w/p");
    assert.equal(row?.session.sessionId, "t1");
    assert.equal(row?.session.provider, "codex");
    assert.equal(row?.session.summary, "fix the bug");
    assert.equal(row?.session.originator, "autonomos");
    assert.equal(
      parseCodexHead(whole(codexLines("t2", "/w", "x")))?.session.originator,
      "external",
    );
  });
  it("an app-server-driven thread (every autonomOS agent) has its prompt ONLY as a response_item — found, skipping synthetic blocks", () => {
    const text = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "t9", cwd: "/w", originator: "autonomos-gateway" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<environment_context>\n  <cwd>/w</cwd>\n</environment_context>",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Reply with just the word PINEAPPLE." },
          ],
        },
      }),
    ].join("\n");
    assert.equal(
      parseCodexHead(whole(`${text}\n`))?.session.summary,
      "Reply with just the word PINEAPPLE.",
    );
  });
  it("prefers the TUI's user_message when both shapes exist", () => {
    const text = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "t8", cwd: "/w" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { role: "user", content: [{ text: "item text" }] },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "typed text" },
      }),
    ].join("\n");
    assert.equal(
      parseCodexHead(whole(`${text}\n`))?.session.summary,
      "typed text",
    );
  });
  it("no session_meta, or one without id/cwd → skipped (null), never a crash", () => {
    assert.equal(parseCodexHead(whole('not json\n{"type":"x"}\n')), null);
    assert.equal(
      parseCodexHead(
        whole(
          `${JSON.stringify({ type: "session_meta", payload: { id: "t" } })}\n`,
        ),
      ),
      null,
    );
  });
  it("a truncated head drops its torn last line", () => {
    const text = `${codexLines("t3", "/w").trimEnd()}\n{"type":"event_msg","payl`;
    assert.equal(
      parseCodexHead({ text, truncated: true })?.session.sessionId,
      "t3",
    );
  });
});

describe("parseGeminiHead", () => {
  it("reads the session id and prompt, stripping autonomOS's injected context", () => {
    const text = `${JSON.stringify({ sessionId: "g1", kind: "main" })}\n${JSON.stringify(
      {
        type: "user",
        content: [
          {
            text: "You are running inside autonomOS…\n\n---\n\nwrite the tests",
          },
        ],
      },
    )}\n`;
    const row = parseGeminiHead(whole(text), "/w/p");
    assert.equal(row?.session.sessionId, "g1");
    assert.equal(row?.session.provider, "gemini-cli");
    assert.equal(row?.session.summary, "write the tests");
  });
  it("a WHOLE file with no trailing newline keeps its only line (only a truncated head drops one)", () => {
    const text = JSON.stringify({ sessionId: "g2", kind: "main" });
    assert.equal(parseGeminiHead(whole(text), "/w")?.session.sessionId, "g2");
  });
  it("a non-main (side) session isn't listed", () => {
    assert.equal(
      parseGeminiHead(
        whole(`${JSON.stringify({ sessionId: "g3", kind: "subagent" })}\n`),
        "/w",
      ),
      null,
    );
  });
});

describe("listCodexSessions", () => {
  it("lists rollouts newest first, from the agent's CODEX_HOME", async () => {
    writeRollout("2026/09/24", "old", "/w/a", "first", 1_000_000_000_000);
    writeRollout("2026/09/25", "new", "/w/b", "second", 1_000_000_100_000);
    const rows = await listCodexSessions({ CODEX_HOME: home });
    assert.deepEqual(
      rows.map((r) => r.session.sessionId),
      ["new", "old"],
    );
    assert.equal(rows[0].session.lastModified, 1_000_000_100_000);
  });
  it("no ~/.codex at all → [] (not an error)", async () => {
    assert.deepEqual(
      await listCodexSessions({ CODEX_HOME: join(home, "nope") }),
      [],
    );
  });
  it("a malformed rollout is skipped; the rest still list", async () => {
    writeRollout("2026/09/25", "good", "/w", "ok");
    const bad = join(
      home,
      "sessions",
      "2026",
      "09",
      "25",
      "rollout-x-bad.jsonl",
    );
    writeFileSync(bad, "garbage\n");
    const rows = await listCodexSessions({ CODEX_HOME: home });
    assert.deepEqual(
      rows.map((r) => r.session.sessionId),
      ["good"],
    );
  });
  it(`caps a scan at MAX_FILES (${MAX_FILES}), keeping the NEWEST`, async () => {
    const n = MAX_FILES + 25;
    for (let i = 0; i < n; i++) {
      writeRollout(
        `2026/09/${String(1 + (i % 28)).padStart(2, "0")}`,
        `id-${i}`,
        "/w",
        "p",
        1_000_000_000_000 + i * 1000,
      );
    }
    const rows = await listCodexSessions({ CODEX_HOME: home });
    assert.equal(rows.length, MAX_FILES);
    assert.equal(rows[0].session.sessionId, `id-${n - 1}`, "newest first");
  });
  it("an UNREADABLE sessions root throws (so the route logs the omission) — only absent is []", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root reads anything");
    writeRollout("2026/09/25", "t", "/w", "p");
    chmodSync(join(home, "sessions"), 0o000);
    try {
      await assert.rejects(listCodexSessions({ CODEX_HOME: home }));
    } finally {
      chmodSync(join(home, "sessions"), 0o755);
    }
  });
  it("a file that couldn't be READ isn't cached as nothing — it lists once readable again", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root reads anything");
    const f = writeRollout("2026/09/25", "t", "/w", "p");
    chmodSync(f, 0o000);
    try {
      assert.deepEqual(await listCodexSessions({ CODEX_HOME: home }), []);
    } finally {
      chmodSync(f, 0o644);
    }
    const rows = await listCodexSessions({ CODEX_HOME: home });
    assert.equal(rows.length, 1, "re-read, not served from a cached null");
  });
  it("a file whose mtime changed is re-read (the cache follows the file)", async () => {
    const f = writeRollout(
      "2026/09/25",
      "t",
      "/w",
      "before",
      1_000_000_000_000,
    );
    assert.equal(
      (await listCodexSessions({ CODEX_HOME: home }))[0].session.summary,
      "before",
    );
    writeFileSync(f, codexLines("t", "/w", "after, and longer"));
    utimesSync(f, 1_000_000_500, 1_000_000_500);
    assert.equal(
      (await listCodexSessions({ CODEX_HOME: home }))[0].session.summary,
      "after, and longer",
    );
  });
});

describe("listGeminiSessions", () => {
  it("lists main sessions under their project's recorded cwd", async () => {
    writeGemini("/w/g", "aaaaaaaa-1111-2222-3333-444444444444", "hello gemini");
    const rows = await listGeminiSessions({ GEMINI_CLI_HOME: home });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cwd, "/w/g");
    assert.equal(rows[0].session.summary, "hello gemini");
  });
});

describe("listGeminiSessions — a resumed session is ONE row", () => {
  it("each --resume adds a stub file with the same id; one row, the real prompt, the newest time", async () => {
    const id = "40ff5b4b-b832-45f8-bf52-360778e5950f";
    const dir = join(home, ".gemini", "tmp", "proj");
    mkdirSync(join(dir, "chats"), { recursive: true });
    writeFileSync(join(dir, ".project_root"), "/w/g");
    const file = (ts: string, body: string, mtime: number) => {
      const f = join(
        dir,
        "chats",
        `session-2026-09-26T${ts}-${id.slice(0, 8)}.jsonl`,
      );
      writeFileSync(
        f,
        `${JSON.stringify({ sessionId: id, kind: "main" })}\n${body}\n`,
      );
      utimesSync(f, mtime, mtime);
    };
    const stub = JSON.stringify({
      type: "user",
      content: [
        {
          text: "<session_context>\nThis is the Gemini CLI…</session_context>",
        },
      ],
    });
    file(
      "06-19",
      JSON.stringify({ type: "user", content: [{ text: "remember KUMQUAT" }] }),
      1_000_000_100,
    );
    file("06-20", stub, 1_000_000_200);
    file("06-22", stub, 1_000_000_300);
    const rows = (await listGeminiSessions({ GEMINI_CLI_HOME: home })).filter(
      (r) => r.session.sessionId === id,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session.summary, "remember KUMQUAT");
    assert.equal(rows[0].session.lastModified, 1_000_000_300_000);
  });
});

describe("findGeminiSession — three-state, where `gemini --resume` looks", () => {
  const id = "6579618b-70f4-4830-9c63-646b23b7f3d9";
  it("found in THIS cwd's project → true", () => {
    writeGemini("/w/g", id);
    assert.equal(
      findGeminiSession("/w/g", id, { GEMINI_CLI_HOME: home }),
      true,
    );
  });
  it("matches the REALPATH of the cwd (a symlinked /tmp on macOS)", () => {
    const real = mkdtempSync(join(tmpdir(), "aos-gem-real-"));
    const link = join(home, "link");
    symlinkSync(real, link);
    try {
      writeGemini(realpathSync(real), id);
      assert.equal(
        findGeminiSession(link, id, { GEMINI_CLI_HOME: home }),
        true,
      );
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
  it("positively absent → false: no storage, another project's session, or no such id", () => {
    assert.equal(
      findGeminiSession("/w/g", id, { GEMINI_CLI_HOME: join(home, "none") }),
      false,
    );
    writeGemini("/w/other", id);
    assert.equal(
      findGeminiSession("/w/g", id, { GEMINI_CLI_HOME: home }),
      false,
    );
    writeGemini("/w/g", "ffffffff-0000-0000-0000-000000000000", undefined, {
      slug: "g2",
    });
    assert.equal(
      findGeminiSession("/w/g", id, { GEMINI_CLI_HOME: home }),
      false,
    );
  });
  it("a candidate whose header is corrupt is CAN'T TELL (throws), not absent — never a fresh chat over a real one", () => {
    const dir = join(home, ".gemini", "tmp", "proj");
    mkdirSync(join(dir, "chats"), { recursive: true });
    writeFileSync(join(dir, ".project_root"), "/w/g");
    writeFileSync(
      join(dir, "chats", `session-2026-09-26T00-00-${id.slice(0, 8)}.jsonl`),
      "{not json\n",
    );
    assert.throws(() =>
      findGeminiSession("/w/g", id, { GEMINI_CLI_HOME: home }),
    );
  });
  it("an id that only shares the 8-char file prefix is NOT a match", () => {
    writeGemini("/w/g", `${id.slice(0, 8)}-aaaa-bbbb-cccc-dddddddddddd`);
    assert.equal(
      findGeminiSession("/w/g", id, { GEMINI_CLI_HOME: home }),
      false,
    );
  });
  it("can't tell (unreadable chats dir) → THROWS, so the runtime fails open", (t) => {
    if (process.getuid?.() === 0) return t.skip("root reads anything");
    writeGemini("/w/g", id);
    const chats = join(home, ".gemini", "tmp", "proj", "chats");
    chmodSync(chats, 0o000);
    try {
      assert.throws(() =>
        findGeminiSession("/w/g", id, { GEMINI_CLI_HOME: home }),
      );
    } finally {
      chmodSync(chats, 0o755);
    }
  });
});

// Unused-import guard for helpers only some platforms exercise.
void randomUUID;
