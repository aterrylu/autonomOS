# Claude Design Setup Guide for the autonomOS Dashboard

**Status:** Setup guide for Terry's first Claude Design session.
**Created:** 2026-04-19
**Audience:** Terry (and any feature-worker who later implements an exported design).

---

## Section 1 — What Claude Design is

Claude Design is an Anthropic Labs product launched **April 17, 2026**, powered by Claude Opus 4.7's vision model. It's a chat-driven design surface: you describe what you want, Claude renders a working design on a canvas, and you refine via conversation, inline comments, direct edits, or custom sliders for spacing/color/layout. Available to Pro, Max, Team, and Enterprise plans (research preview).

**The capabilities that matter for our use case:**

1. **Codebase ingestion → automatic design system extraction.** Point it at a repo and during onboarding it builds an org-scoped design system (colors, typography, components) from your code and assets. Every subsequent project inherits that system automatically.
2. **Single-instruction handoff bundle to Claude Code.** This is the killer feature for us — Claude Design produces a hand-off package that a CC session (a feature-worker in our world) can implement directly.
3. **Multiple export formats:** standalone HTML, PDF, PPTX, ZIP, Canva, or direct hand-off to Claude Code.
4. **Refinement loop:** chat for broad changes, inline comments for targeted edits (note: known bug — comments occasionally disappear; paste into chat as workaround), sliders for numeric properties.

References: [Anthropic announcement](https://www.anthropic.com/news/claude-design-anthropic-labs) · [Get started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) · [Set up your design system](https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design) · [TestingCatalog walkthrough](https://www.testingcatalog.com/anthropic-launches-claude-design-ai-tool-for-paid-plans/)

---

## Section 2 — Step-by-step workflow for Terry's first session

### Phase A — One-time org setup (~15 min)

1. **Sign in** to claude.ai with your Pro/Max account. Navigate to Anthropic Labs → Claude Design.
2. **Create or select an organization.** This scopes the design system. For a personal project, create a new org named "autonomOS" — don't reuse a work org.
3. **Complete onboarding.** When prompted, run the design-system extraction. This is the load-bearing step — see Section 3 for what to feed it.
4. **Validate the extracted system.** After extraction Claude shows: a color palette (primary/secondary/accent), typography scale, reusable patterns, and layout structures. Check:
   - Are the **three theme palettes** (midnight/daylight/void) all present, or did it only pick up `midnight`? If only one, manually upload the others (paste the hex blocks from `store.ts:272-339`).
   - Is **Berkeley Mono** identified as the monospace font? (Fallback: JetBrains Mono, Fira Code.)
   - Are the **status colors** (red/green/yellow/blue/cyan/magenta from xterm) tagged as a separate semantic palette? They drive `AgentStatusIcon`.
5. **Toggle "Published"** in org settings to make the system available to all your future projects.

### Phase B — First panel project (~30-60 min)

6. **Start a new project.** Add context:
   - Re-attach the codebase (or just the panel file you're redesigning — see Section 3).
   - Upload current-state screenshots from the repo root (e.g. `qa-1-sidebar-layout.png`, `qa-7-orgchart-cards.png`).
   - Upload 2-3 reference images from Section 4.
7. **Write your first prompt.** Don't ask for everything at once. Suggested opening:
   > "This is the [PanelName] from autonomOS, a terminal-aesthetic mission-control dashboard for managing AI agents. Here's the current state [screenshot] and three references I like [refs]. Redesign this panel keeping the dense, dark, monospace feel of the current dashboard. Preserve every piece of information that's currently shown — I'll point out what to drop. Goal: clearer hierarchy, calmer color palette, fewer alignment glitches."
8. **Iterate on the canvas.** Use chat for broad direction ("denser", "more like Linear"); use inline comments for specific elements; use sliders to tune spacing and corner radius once the layout lands.
9. **Ask for 2-3 alternative layouts** before committing. Cheap to generate, expensive to redo.
10. **Export when satisfied.** For our flow: choose **"Send to Claude Code"** (the single-instruction handoff bundle). If that integration is flaky, fall back to **standalone HTML** export — see Section 6 for hand-off mechanics.

### Phase C — After the export

11. Save the export bundle/HTML into `~/.claude/plans/<panel-name>-redesign/` along with the screenshots and refs.
12. Spawn an implementation feature-worker (Section 6).

---

## Section 3 — Codebase ingestion recommendations

Don't dump the whole repo. Claude Design extracts cleaner systems from a focused signal.

### ✅ Include (the design vocabulary, ~15 files)

**Token sources (the most important — feed these first):**
- `packages/dashboard/src/store.ts` — specifically lines **55-345** (the `THEMES` block defining all three palettes + the xterm status colors). This is the runtime source of truth.
- `packages/dashboard/src/index.css` — CSS variables, `@theme inline`, prose styles, scrollbar treatment.
- `packages/dashboard/src/components/ThemeVars.tsx` — the bridge that maps `THEMES` → shadcn CSS variables. Tells Claude Design how the runtime theme switcher works.

**Representative panels (the design surface):**
- `packages/dashboard/src/components/Sidebar.tsx` — the main vocabulary: agents, projects, hierarchy, drag handles, status icons, group colors.
- `packages/dashboard/src/components/HierarchyPanel.tsx` — card + tree pattern.
- `packages/dashboard/src/components/CreateAgentPanel.tsx` — form patterns (inputs, dropdowns, selects, buttons).
- `packages/dashboard/src/components/SchedulesPanel.tsx` — list + action pattern.
- `packages/dashboard/src/components/TemplatesPanel.tsx` — gallery + form pattern.
- `packages/dashboard/src/components/NotificationPanel.tsx` — message-card pattern.
- `packages/dashboard/src/components/StatusBar.tsx` — connection state + bottom-bar pattern.
- `packages/dashboard/src/components/Header.tsx` — top-of-pane chrome.

**The lone primitive:**
- `packages/dashboard/src/components/ui/agent-status-icon.tsx` — the only thing in `components/ui/`. Claude Design should treat this as the seed for a real primitive layer.

**Icon system:**
- `packages/dashboard/src/components/Codicon.tsx` — VS Code Codicon wrapper. We also use `lucide-react`. Important to disclose so Claude Design picks consistent icons.

**Current-state screenshots (drop into the project, not the repo ingest):**
- `qa-1-sidebar-layout.png`, `qa-7-orgchart-cards.png`, `qa-hierarchy-02-manager-child.png`, `qa-usage-credentials.png`, `qa-settings-panel.png`, `settings-ghostty-selected.png`. These show real states the panels reach.

### ❌ Exclude (signal dilution)

- `packages/server/` — backend code, no design value
- `packages/core/` — types only
- `packages/dashboard/node_modules/`, `dist/`, `build/`
- `packages/dashboard/src/terminal/` — xterm wrapper, no UI surface
- `packages/dashboard/src/layout/` — split-pane mechanics, not visual design
- `packages/dashboard/src/store.ts` lines outside 55-345 (state machinery, not design)
- All `*.test.ts(x)` files
- `packages/dashboard/src/components/conversation/` — markdown renderer internals, not design
- All the `research-*.png`, `dev-*.png` screenshots in the repo root — those are research artifacts, not current dashboard state

### Why this scoping matters

`★ Insight ─────────────────────────────────────`
Tailwind v4 ships its config inside CSS via `@theme inline`. Claude Design likely scans for `tailwind.config.js` first; we don't have one. Pointing it explicitly at `index.css` AND the `THEMES` object in `store.ts` is the only way it'll see our actual color tokens. Without both, expect a generic "dark mode" extraction that misses the xterm status colors entirely.
`─────────────────────────────────────────────────`

---

## Section 4 — Reference inspirations

Terry's already gathered nine `ref-*.png` files in the repo root — all sidebar/tree references. That's a clear signal that the dense-list aesthetic is the target. Build on it:

| Reference | Already in repo? | Why it fits |
|---|---|---|
| **Linear** ([ref-linear-sidebar.png](../../ref-linear-sidebar.png)) | ✅ | Monochrome discipline, tight density, restrained color use for status, beautiful keyboard-first. Closest aesthetic match to what we want. |
| **Cursor** | ❌ | Dev tool with dense terminal-like UI, similar audience, has solved the "agent + chat + code" three-pane problem we'll face soon. |
| **Vercel dashboard** | ❌ | Dark-mode-native, generous monospace usage, restrained accent colors. Good reference for empty states and loading skeletons. |
| **shadcn/ui sidebar** ([ref-shadcn-sidebar.png](../../ref-shadcn-sidebar.png)) | ✅ | Already aligned with our CSS variable system (`--background`, `--card`, `--muted`, etc). Use as the *implementation* reference rather than the *aesthetic* reference. |

Skip Raycast (different interaction model — palette vs. dashboard) and skip the Antd / Mantine / MagicUI tree refs (those are pure tree-rendering examples, not design systems). The four above are enough — too many references blur Claude Design's interpretation.

**Suggested upload order:** Linear first (sets the aesthetic), then Vercel (sets the density and empty-state vocabulary), then shadcn-sidebar (proves we're committed to the variable-driven approach).

---

## Section 5 — First-panel recommendation

**Recommendation: redesign `CreateAgentPanel.tsx` first.**

### Scoring matrix

| Panel | Pain (1-5) | Complexity / surface area (1-5) | Isolation (1-5) | Loc | Verdict |
|---|---|---|---|---|---|
| **CreateAgentPanel** | 3 | 4 (forms = lots of primitives) | **5** | 513 | ✅ Best first target |
| HierarchyPanel | 3 | 3 | 4 | 487 | Good second target |
| SchedulesPanel | 2 | 3 | 4 | 567 | Reuses CreateAgent primitives |
| TemplatesPanel | 2 | 3 | 4 | 714 | Reuses CreateAgent primitives |
| NotificationPanel | 2 | 2 | 5 | 346 | Too small to justify |
| **Sidebar** | **5** | **5** | **1** | 1750 | ❌ Worst first target — too entangled |

### Why CreateAgentPanel first (not Sidebar)

The Sidebar is the obvious pain point — 1750 lines, the most-used panel, deeply enmeshed with `DragContext`, `layoutTree`, `mergeOrgWithSessions`, group colors, hierarchy view modes, and notification badges. Redesigning it first is high-leverage but high-risk: a misstep cascades to every other panel because so much state surfaces through it. Better to land the design language on a contained surface first.

CreateAgentPanel wins on three axes:
1. **Form-heavy = primitive vocabulary.** Inputs, selects, dropdowns, searchable directory picker, primary/secondary buttons, error states, loading states. Whatever Claude Design produces here becomes the seed primitives for SchedulesPanel, TemplatesPanel, and the eventual settings overhaul.
2. **Maximum isolation.** It opens as a single tab pane with no drag/drop, no live data updates beyond a one-shot fetch, no integration with the layout tree's split mechanics. Easy to swap implementation behind the same `openCreateAgent()` action.
3. **Right size.** 513 lines is small enough for one design pass, large enough to exercise the full primitive set.

`★ Insight ─────────────────────────────────────`
The dashboard has essentially **no UI primitive layer** — `components/ui/` contains only `agent-status-icon.tsx`. This is a feature, not a bug, for our purposes: Claude Design has free range to *establish* a primitive set rather than match an existing one. Forcing that primitive set to emerge from a form-heavy panel (which uses every common element) is more efficient than deriving it from a bespoke panel like Sidebar.
`─────────────────────────────────────────────────`

### Suggested panel order after CreateAgentPanel

1. **CreateAgentPanel** (this proposal) — establishes input/select/button/dropdown primitives.
2. **HierarchyPanel** — establishes card + tree visual treatment using the new primitives. Lower stakes than Sidebar.
3. **SchedulesPanel** + **TemplatesPanel** — reuse primitives, validate that the design language scales.
4. **Sidebar** — the big one, last, with the design language already proven on four panels.
5. **StatusBar** + **NotificationPanel** — chrome polish.

---

## Section 6 — Hand-off pattern for implementation

**Recommended primary pattern: Claude Design "Send to Claude Code" handoff bundle, with standalone HTML as fallback.**

### Why this over alternatives

The official "single-instruction handoff to Claude Code" is purpose-built for our workflow — Anthropic explicitly designed it so a CC session can take the export and produce a PR. We should use it as intended. If it's unstable in the early-access window, fall back to standalone HTML, which is universal and easy to diff.

### Concrete hand-off mechanics

**Path A — Native handoff (try first):**
1. In Claude Design, hit **Export → Send to Claude Code**. Save the resulting bundle URL or zip.
2. In the autonomOS dashboard, spawn a feature-worker via the create_agent panel:
   - Template: `feature-worker`
   - Project: `autonomOS`
   - Initial prompt: paste the handoff bundle URL/path + this instruction:
     > "Implement this Claude Design export for the [PanelName] in the autonomOS dashboard. Source file: `packages/dashboard/src/components/[Panel].tsx`. Preserve every prop and state hook the current panel exposes — only the visual layer changes. Tailwind v4 with our existing `THEMES` (in `store.ts:272`) and CSS variables (in `index.css`). Match the dark-theme rendering first; verify all three themes work. Run `make dev`, screenshot before/after, then `/ship`."

**Path B — Standalone HTML (fallback):**
1. Export as standalone HTML; save to `~/.claude/plans/<panel>-redesign/export.html` along with screenshots.
2. Spawn the feature-worker with the file path + a brief annotation of which behaviors to preserve.

### What NOT to do

- ❌ Don't have Terry annotate a PDF and hand it to a worker — too much translation loss; the HTML carries the actual structure.
- ❌ Don't ask the worker to "redesign by looking at the screenshot" — defeats the purpose of having Claude Design produce concrete markup.
- ❌ Don't merge the export raw — it's a starting point, not the final implementation. The worker should adapt it to our component patterns (Codicon, AgentStatusIcon, store hooks) before shipping.

`★ Insight ─────────────────────────────────────`
Treat the Claude Design output as a **design spec in code form**, not as the final React. A worker should re-implement against our existing state shapes (`useStore`, `useShallow`, `THEMES[theme].page`) — copying the DOM verbatim would break theme switching, drag-and-drop integration, and our zustand patterns. The HTML/JSX from the export is the *visual contract*; the wiring stays ours.
`─────────────────────────────────────────────────`

---

## Quick checklist for Terry's first session

- [ ] Sign in to claude.ai → Anthropic Labs → Claude Design
- [ ] Create "autonomOS" org
- [ ] Run design-system extraction with the file list from Section 3
- [ ] Validate all three themes extracted; if not, manually paste hex blocks from `store.ts:272-339`
- [ ] Toggle "Published" on the org design system
- [ ] Start a new project for **CreateAgentPanel**
- [ ] Upload `qa-*.png` current-state screenshots + Linear/Vercel/shadcn refs
- [ ] First prompt as in Section 2, step 7
- [ ] Iterate, ask for 2-3 alternatives
- [ ] Export via "Send to Claude Code" (or HTML fallback)
- [ ] Spawn feature-worker with the handoff per Section 6

---

**Sources:**
- [Introducing Claude Design — Anthropic](https://www.anthropic.com/news/claude-design-anthropic-labs)
- [Get started with Claude Design — Help Center](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)
- [Set up your design system in Claude Design — Help Center](https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design)
- [Anthropic launches Claude Design AI tool for paid plans — TestingCatalog](https://www.testingcatalog.com/anthropic-launches-claude-design-ai-tool-for-paid-plans/)
