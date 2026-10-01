import { describe, expect, it } from "vitest";
import type { ProjectInfo, ProjectSession } from "../store";
import {
  isShownSession,
  projectsView,
  sessionChip,
  startedByTag,
  TOOL_RUNS_EXPLAINER,
  toolRunsToggleLabel,
} from "./projectView";

const s = (id: string, extra: Partial<ProjectSession> = {}): ProjectSession =>
  ({
    sessionId: id,
    summary: id,
    lastModified: 0,
    provider: "claude-code",
    cwdExists: true,
    headless: false,
    ...extra,
  }) as ProjectSession;
const p = (
  path: string,
  sessions: ProjectSession[],
  kind: ProjectInfo["kind"] = "repo",
): ProjectInfo =>
  ({
    path,
    name: path.split("/").pop() ?? path,
    kind,
    sessions,
    lastActive: 0,
    counts: { visible: 0, headless: 0, removed: 0 },
  }) as ProjectInfo;

const REPO = "/Users/t/workspace/autonomOS";
const WT = "/Users/t/.claude-worktrees/autonomOS-terry-x";

describe("projectsView", () => {
  it("hides automated runs by default, and counts them for the toggle", () => {
    const v = projectsView(
      [
        p(REPO, [
          s("human"),
          s("bot1", { headless: true }),
          s("bot2", { headless: true }),
        ]),
      ],
      false,
    );
    expect(v.main[0].sessions.map((x) => x.sessionId)).toEqual(["human"]);
    expect(v.automatedTotal).toBe(2);
  });

  it("shows automated runs INSIDE their repo when the toggle is on", () => {
    const v = projectsView(
      [p(REPO, [s("human"), s("bot", { headless: true })])],
      true,
    );
    expect(v.main[0].sessions.map((x) => x.sessionId).sort()).toEqual([
      "bot",
      "human",
    ]);
  });

  it("a project with ONLY automated runs is hidden entirely while they're hidden", () => {
    const v = projectsView(
      [p(`${REPO}-only-bots`, [s("bot", { headless: true })])],
      false,
    );
    expect(v.main).toEqual([]);
    expect(v.other).toEqual([]);
    expect(
      projectsView(
        [p(`${REPO}-only-bots`, [s("bot", { headless: true })])],
        true,
      ).main,
    ).toHaveLength(1);
  });

  it("temp dirs go to Other, whatever they contain", () => {
    const v = projectsView(
      [p("/tmp/aos-live.x", [s("a")], "temp"), p(REPO, [s("b")])],
      false,
    );
    expect(v.other.map((x) => x.path)).toEqual(["/tmp/aos-live.x"]);
    expect(v.main.map((x) => x.path)).toEqual([REPO]);
  });

  it("a non-temp project whose sessions ALL live in deleted dirs moves to Other (still reachable)", () => {
    const v = projectsView(
      [p("/Users/t/gone", [s("a", { cwdExists: false })], "dir")],
      false,
    );
    expect(v.main).toEqual([]);
    expect(v.other.map((x) => x.path)).toEqual(["/Users/t/gone"]);
  });

  it("a repo with SOME deleted-dir sessions stays in main and keeps them (behind its toggle)", () => {
    const v = projectsView(
      [p(REPO, [s("live"), s("gone", { cwdExists: false })])],
      false,
    );
    expect(v.main[0].sessions).toHaveLength(2);
    expect(
      v.main[0].sessions.filter((x) => isShownSession(x, false)),
    ).toHaveLength(1);
  });

  it("sessions are newest-first, and the input is not mutated", () => {
    const input = [
      p(REPO, [s("old", { lastModified: 1 }), s("new", { lastModified: 9 })]),
    ];
    const v = projectsView(input, false);
    expect(v.main[0].sessions.map((x) => x.sessionId)).toEqual(["new", "old"]);
    expect(input[0].sessions.map((x) => x.sessionId)).toEqual(["old", "new"]);
  });
});

describe("isShownSession", () => {
  it("unknown cwdExists counts as existing (older servers don't send it)", () => {
    expect(isShownSession(s("a", { cwdExists: undefined }), false)).toBe(true);
  });
});

describe("sessionChip", () => {
  const proj = { path: REPO, name: "autonomOS" };
  it("the git branch wins when recorded (Claude Code)", () => {
    expect(sessionChip({ gitBranch: "terry/x", cwd: WT }, proj)).toBe(
      "terry/x",
    );
  });
  it("no branch (Codex/Gemini): the worktree, named relative to its repo", () => {
    expect(sessionChip({ cwd: WT }, proj)).toBe("terry-x");
  });
  it("no chip in the repo's own directory", () => {
    expect(sessionChip({ cwd: REPO }, proj)).toBeUndefined();
    expect(sessionChip({}, proj)).toBeUndefined();
  });
  it("a subdirectory or unrelated worktree name is shown as-is", () => {
    expect(sessionChip({ cwd: `${REPO}/packages/server` }, proj)).toBe(
      "server",
    );
    expect(sessionChip({ cwd: "/x/autonomOS-" }, proj)).toBe("autonomOS-");
  });
});

describe("tool-run copy (Terry: 'automated runs… huh?')", () => {
  it("the toggle names what they are, singular/plural, and hiding", () => {
    expect(toolRunsToggleLabel(114, false)).toBe(
      "Show 114 runs started by tools",
    );
    expect(toolRunsToggleLabel(1, false)).toBe("Show 1 run started by tools");
    expect(toolRunsToggleLabel(114, true)).toBe("Hide runs started by tools");
    expect(TOOL_RUNS_EXPLAINER).toMatch(/script or bot started, not you/);
  });
  it("each tool-run row names its source when known, a plain tag otherwise; none for people", () => {
    expect(startedByTag({ headless: true, startedVia: "sdk-py" })).toBe(
      "via Agent SDK (Python)",
    );
    expect(startedByTag({ headless: true, startedVia: "sdk-cli" })).toBe(
      "via Agent SDK (CLI)",
    );
    expect(startedByTag({ headless: true, startedVia: "codex-exec" })).toBe(
      "via codex exec",
    );
    expect(startedByTag({ headless: true, startedVia: "something-new" })).toBe(
      "via something-new",
    );
    expect(startedByTag({ headless: true })).toBe("started by a tool");
    expect(startedByTag({ headless: false })).toBeUndefined();
  });
});
