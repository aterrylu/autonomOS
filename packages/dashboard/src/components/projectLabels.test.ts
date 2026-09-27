import { describe, expect, it } from "vitest";
import { projectLabels } from "./projectLabels";

const p = (path: string) => ({
  path,
  name: path.startsWith("unknown:")
    ? "Unknown"
    : (path.split("/").pop() ?? path),
});

describe("projectLabels", () => {
  it("unique names keep the bare dir name", () => {
    const l = projectLabels([
      p("/Users/t/workspace/autonomOS"),
      p("/tmp/aq/work"),
    ]);
    expect(l.get("/Users/t/workspace/autonomOS")).toBe("autonomOS");
    expect(l.get("/tmp/aq/work")).toBe("work");
  });

  it("same-named dirs get the fewest parent segments that tell them apart (the forge 'work' ×2)", () => {
    const l = projectLabels([
      p("/tmp/aq/work"),
      p("/tmp/ax/work"),
      p("/Users/t/app"),
    ]);
    expect(l.get("/tmp/aq/work")).toBe("aq/work");
    expect(l.get("/tmp/ax/work")).toBe("ax/work");
    expect(l.get("/Users/t/app")).toBe("app");
  });

  it("goes as deep as needed, per collision group", () => {
    const l = projectLabels([
      p("/a/x/src/work"),
      p("/b/x/src/work"),
      p("/c/work"),
    ]);
    expect(l.get("/a/x/src/work")).toBe("a/x/src/work");
    expect(l.get("/b/x/src/work")).toBe("b/x/src/work");
    expect(l.get("/c/work")).toBe("c/work");
  });

  it("a shallower path still separates at the first unique depth", () => {
    const l = projectLabels([p("/work"), p("/tmp/work")]);
    expect(l.get("/work")).toBe("work");
    expect(l.get("/tmp/work")).toBe("tmp/work");
    expect(new Set(l.values()).size).toBe(2);
  });

  it("cwd-less 'unknown:' groups keep their deliberate 'Unknown' label", () => {
    const l = projectLabels([p("unknown:a1"), p("unknown:b2")]);
    expect(l.get("unknown:a1")).toBe("Unknown");
    expect(l.get("unknown:b2")).toBe("Unknown");
  });

  it("every labelled row is distinct whenever paths are (property over a batch)", () => {
    const paths = [
      "/r/a/work",
      "/r/b/work",
      "/s/a/work",
      "/work",
      "/x/y",
      "/z/y",
      "/y",
    ];
    const l = projectLabels(paths.map(p));
    expect(new Set(paths.map((x) => l.get(x))).size).toBe(paths.length);
  });
});
