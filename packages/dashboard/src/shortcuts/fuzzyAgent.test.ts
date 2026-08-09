import { describe, expect, it } from "vitest";
import { fuzzyScore, rankAgents } from "./fuzzyAgent";

describe("fuzzyScore", () => {
  it("tiers: prefix > word-boundary > substring > subsequence > null", () => {
    const prefix = fuzzyScore("disp", "Dispatcher") as number;
    const boundary = fuzzyScore("auto", "Shortcuts@autonomOS") as number;
    const substring = fuzzyScore("spat", "Dispatcher") as number;
    const subsequence = fuzzyScore("dpr", "Dispatcher") as number;
    expect(prefix).toBeGreaterThan(boundary);
    expect(boundary).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
    expect(fuzzyScore("xyz", "Dispatcher")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("DISP", "dispatcher")).toBe(1000);
  });

  it("earlier substrings outrank later ones", () => {
    const early = fuzzyScore("shortcut", "Shortcuts@autonomOS") as number;
    const later = fuzzyScore("nomos", "Shortcuts@autonomOS") as number;
    expect(early).toBeGreaterThan(later);
  });

  it("tighter subsequences outrank sparse ones (span penalty)", () => {
    // Both are true subsequences of "Dispatcher" (neither is a substring):
    // "dpa" spans D-i-s-p-a (5 chars), "dpr" spans D-...-r (the whole word).
    const tight = fuzzyScore("dpa", "Dispatcher") as number;
    const sparse = fuzzyScore("dpr", "Dispatcher") as number;
    expect(tight).toBeLessThan(600); // genuinely the subsequence tier
    expect(sparse).toBeLessThan(600);
    expect(tight).toBeGreaterThan(sparse);
  });

  it("camelCase transitions are word boundaries", () => {
    expect(fuzzyScore("roll", "ReleaseRollout")).toBe(800);
    expect(fuzzyScore("ack", "DeliveryAck")).toBe(800);
  });

  it("empty query matches everything neutrally", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("rankAgents", () => {
  const agents = [
    { id: "a", name: "Dispatcher" },
    { id: "b", name: "Researcher" },
    { id: "c", name: "DeliveryAck" },
    { id: "hidden", name: "CollapsedWorker" },
  ];

  it("empty query lists in sidebar order, hidden agents after (by name)", () => {
    const ranked = rankAgents("", agents, ["b", "a", "c"]);
    expect(ranked.map((r) => r.id)).toEqual(["b", "a", "c", "hidden"]);
  });

  it("agents hidden from the sidebar are still findable — search is the escape hatch", () => {
    const ranked = rankAgents("collap", agents, ["b", "a", "c"]);
    expect(ranked[0]?.id).toBe("hidden");
  });

  it("score outranks sidebar position; sidebar position breaks ties", () => {
    // "d" prefix-matches Dispatcher AND DeliveryAck equally → sidebar order
    // decides between them; CollapsedWorker only substring-matches ("...seD...")
    // so it ranks below both despite any sidebar position.
    const ranked = rankAgents("d", agents, ["c", "a", "b"]);
    expect(ranked.map((r) => r.id)).toEqual(["c", "a", "hidden"]);
  });

  it("non-matches are dropped", () => {
    expect(rankAgents("zzz", agents, [])).toEqual([]);
  });
});
