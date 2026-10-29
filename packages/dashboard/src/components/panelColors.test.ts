import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard: dark-theme-only color literals must not be used unconditionally.
 *
 * Presets, Schedules and New Agent hardcoded the dark palette inline (cream
 * title text, a navy card, white-alpha fills and borders). On Daylight that
 * painted a grey slab with ~1.2:1 text, and themeContrast.test.ts could not
 * see it: it checks the THEME TOKENS, and these colors never went through a
 * token. This test scans the source instead.
 *
 * A literal below may only appear in an allowlisted file, each of which
 * either picks it in the dark branch of a light/dark choice or paints its own
 * dark background regardless of theme. Need a dark-only color in a new file?
 * Take it from `panelPalette(page)` (or branch on `isLightBg(page.bg)`)
 * rather than adding the file here.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

const BANNED: { name: string; re: RegExp }[] = [
  { name: "cream title text #e6e1cf", re: /#e6e1cf/i },
  {
    name: "white-alpha fill/border rgba(255,255,255,…)",
    re: /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/,
  },
  {
    name: "navy card rgba(28,36,51,…)",
    re: /rgba\(\s*28\s*,\s*36\s*,\s*51\s*,/,
  },
];

/** File (relative to src/) → why the literal is legitimate there. `branches`
 *  files must also contain a light check, so the literal stays a dark branch. */
const ALLOWED: Record<string, { why: string; branches: boolean }> = {
  "components/panelPalette.ts": {
    why: "the dark branch of the shared panel palette",
    branches: true,
  },
  "components/TemplatesPanel.tsx": {
    why: "the dark branch of tpl(page)",
    branches: true,
  },
  "components/AgentContextMenu.tsx": {
    why: "isLight ? … : … hover fill",
    branches: true,
  },
  "components/Sidebar.tsx": {
    why: "isLightBg(page.bg) ? … : … collapsed-parent border",
    branches: true,
  },
  "components/orgchart/theme.ts": {
    why: "isLight ? … : … chart surfaces",
    branches: true,
  },
  "ErrorBoundary.tsx": {
    why: "the crash screen paints its own fixed dark background, whatever the theme",
    branches: false,
  },
  "store.ts": {
    why: "the dark themes' own terminal scrollbar tokens",
    branches: false,
  },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "test") continue;
      out.push(...sourceFiles(p));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      out.push(p);
    }
  }
  return out;
}

const files = sourceFiles(SRC).map((p) => ({
  rel: relative(SRC, p).split("\\").join("/"),
  text: readFileSync(p, "utf8"),
}));

function hits(text: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const b of BANNED) {
      if (b.re.test(line)) found.push(`L${i + 1} ${b.name}: ${line.trim()}`);
    }
  });
  return found;
}

describe("dark-only color literals stay inside a light/dark branch", () => {
  it("scans the real dashboard source (non-vacuous)", () => {
    expect(files.length).toBeGreaterThanOrEqual(50);
    const rels = new Set(files.map((f) => f.rel));
    for (const f of [
      "components/PresetsPanel.tsx",
      "components/SchedulesPanel.tsx",
      "components/CreateAgentPanel.tsx",
      "components/NotificationPanel.tsx",
    ]) {
      expect(rels.has(f), `${f} scanned`).toBe(true);
    }
  });

  it("no file outside the allowlist uses a dark-only literal", () => {
    const offenders = files
      .filter((f) => !(f.rel in ALLOWED))
      .flatMap((f) => hits(f.text).map((h) => `${f.rel} ${h}`));
    expect(offenders).toEqual([]);
  });

  it("every allowlist entry is still needed and still branches on light", () => {
    for (const [rel, { branches }] of Object.entries(ALLOWED)) {
      const f = files.find((x) => x.rel === rel);
      expect(f, `${rel} exists`).toBeDefined();
      expect(
        hits(f?.text ?? "").length,
        `${rel} still holds a dark literal (else drop it from ALLOWED)`,
      ).toBeGreaterThan(0);
      if (branches) {
        expect(f?.text ?? "", `${rel} branches on light`).toMatch(
          /isLightBg\(|\bisLight\b/,
        );
      }
    }
  });

  it("the banned patterns match the spellings the panels used", () => {
    const samples = [
      'color: "#e6e1cf"',
      'color: "#E6E1CF"',
      'background: "rgba(255,255,255,0.06)"',
      'border: "1px solid rgba(255, 255, 255, 0.1)"',
      'background: "rgba(28, 36, 51, 0.6)"',
    ];
    for (const s of samples) expect(hits(s), s).toHaveLength(1);
    expect(hits('background: "rgba(0,0,0,0.05)"')).toEqual([]);
  });
});
