# Keyboard Shortcuts — Investigation & System Design (v1 proposal)

**Author:** Shortcuts@autonomOS · **Date:** 2026-07-29 · **Status:** APPROVED (Terry, 2026-07-29 — recommended option: mod+digit + help overlay in v1) → implemented, see ADR-063
**Branch:** `terry/shortcuts-system-v1` · **Plan:** `~/.claude/plans/shortcuts-system-v1.md`

Kicked off by a user request for CMUX-style ctrl+1/2/3/4 quick tab switching. Scope: (A) digit-chord
pane switching, (B) a designed shortcut *system* that makes shortcut #2..#N cheap and conflict-checked.

---

## 1. Current state (investigated, not assumed)

**Exactly one global shortcut exists**: Cmd/Ctrl+B → toggle sidebar (`App.tsx:141-155`). Window-level,
**capture phase** — the comment there explains why: xterm.js calls `stopPropagation()` in the bubble
phase for every key it handles, so bubble listeners are dead while a terminal is focused. No registry,
no target guard (it fires even on the login screen over the password field), no test, never surfaced
in the UI (the sidebar button tooltip shows no accelerator).

**xterm already has a proto-boundary**: `handleKeyEvent` (`useTerminal.ts:703-755`), wired via
`attachCustomKeyEventHandler`, returns `false` (= xterm won't process; event propagates un-cancelled)
for Ctrl+D/W/B, and implements Cmd+K clear, Cmd+A select-all, word-nav, etc. This list and the window
handler are two hand-maintained, already-divergent lists — the exact drift the registry eliminates.

**Key flow**: window capture listeners → xterm's textarea capture listener → custom handler consult →
xterm encodes + `preventDefault/stopPropagation` → `terminal.onData` → WebSocket → PTY.

**No overlay/modal infra at all**: zero portals, no focus traps, no palette dependency. A help overlay
would be the app's first true overlay. 15 unguarded text inputs; dockview `defaultRenderer:"always"`
keeps inactive tabs' inputs mounted. Two existing document-level bubble-phase Escape handlers are
latent casualties of xterm's stopPropagation (work today only because popover toggles move focus).

**Layout reality — CLAUDE.md is stale**: the "binary tree split-pane system" was deleted in ADR-047.
dockview 7.0.2 is both the tab system and the split system.

## 2. Three brief assumptions corrected by research (change the design space)

1. **⌘1–9 IS interceptable in Chrome.** Chromium's reserved-key list (`IsReservedCommandOrKey()`)
   covers ⌘W/T/N/Q, ⌃Tab etc. — but NOT select-tab-by-index. `preventDefault()` on ⌘1–9 works.
   The native-terminal convention is available to us in the browser.
2. **Ctrl+digit is NOT free in a terminal.** xterm.js encodes Ctrl+3→ESC, Ctrl+4→FS, Ctrl+5→GS,
   Ctrl+6→RS, Ctrl+7→US, Ctrl+8→DEL. Only Ctrl+1/2/9/0 send nothing. **Ctrl+3 = Escape is the sharp
   one** — stealing it breaks a documented input to any full-screen TUI (including Claude Code).
   "ctrl+1-4" as literally requested silently steals ESC and FS from every terminal.
3. **CMUX is a native Ghostty-based macOS app, and its ctrl+digit choice is contested by its own
   users** — cmux#577 (hardcoded, conflicts with terminal apps, wants disableable) and cmux#1048
   (asks for ⌘digit "like Ghostty and many other terminal emulators"). Ghostty, Warp, iTerm2, and
   VS Code all converge on **mod+digit for tabs, with mod+9 = LAST tab** (not 9th).

## 3. System design — the shortcut registry

New module `packages/dashboard/src/shortcuts/`:

```ts
// types.ts
export interface ShortcutDef {
  id: string;                        // command id, e.g. "pane.focus.3", "sidebar.toggle"
  chord: string;                     // normalized "mod+3", "mod+b", "mod+/" (mod = ⌘ mac / ctrl elsewhere)
  description: string;               // rendered by the help overlay
  category: "panes" | "app" | "help";
  boundary: "app-reserved"           // wins over a focused terminal (capture + xterm-decline)
          | "app-when-free";         // fires only when no terminal/input has focus
  when?: () => boolean;              // e.g. authed, dock mounted
  run: () => void;
}

// registry.ts — the single source of truth
export const SHORTCUTS: ShortcutDef[] = [ ... ];
export function matchShortcut(e: KeyboardEvent): ShortcutDef | null;
export function isReservedChord(e: KeyboardEvent): boolean;   // consulted by xterm's handler
```

**Two enforcement points, one table:**

1. **Dispatcher** (`useShortcuts.ts`) — ONE window-level capture-phase keydown listener (the proven
   App.tsx pattern, generalized). On match of an `app-reserved` chord: `preventDefault()` +
   `stopPropagation()` + run. Because capture at window runs before xterm's textarea listener,
   stopPropagation means xterm never sees reserved chords at all.
2. **xterm consult** — `handleKeyEvent` gains one line: `if (isReservedChord(e)) return false;`.
   Defense in depth for any path where the window listener isn't mounted; costs nothing, and keeps
   the terminal's decline-list mechanically synchronized with the registry forever.

**Guards** (fixes existing bugs as a side effect): dispatcher checks `authState === "authed"`
(today ⌘B fires on the login password field); `app-when-free` shortcuts additionally check
`document.activeElement` is not editable and not the xterm helper textarea. Modified chords
(mod+digit, mod+b) are safe in inputs and skip the editable check.

**Conflict detection**: a unit test asserts no duplicate normalized chord in the registry and that
no registered chord is in the browser-reserved deny-list (⌘W/T/N/Q, ⌃Tab) or the terminal-sacred
list (ctrl+a/e/c/d/k/l/r/u/w/…) unless explicitly `boundary: "app-reserved"` with a rationale field.
Adding shortcut #N is: one array entry + the test keeps you honest.

**Pane ordering** (the ctrl+3-hits-the-wrong-pane trap): dockview's `api.panels` is group-INSERTION
order, not visual order. The registry's pane actions use a new `orderedPaneIds(api)` util — depth-first
walk of `api.toJSON().grid.root` (children are in spatial order; leaf `views` are tab-strip order).
Activation is `api.getPanel(id)?.api.setActive()` — the same non-destructive path as a real tab click —
plus `focusTerminal(sessionId)` for session panes. **Never** store-level `switchPane`, which can
trigger a full workspace `fromJSON` rebuild that remounts terminals. Handler tolerates a null dock
(dockview unmounts entirely when no pane is active).

Explicitly out of v1 (not over-engineering): user-customizable keybindings, chord sequences
(tmux-prefix style), a command palette. The registry shape doesn't preclude any of them.

## 4. Proposed v1 shortcut set

| Chord (mac / other) | Action | Boundary | Conflict notes |
|---|---|---|---|
| ⌘1–⌘8 / Ctrl+1–8 | Focus pane N (visual order) | app-reserved | Steals browser tab-by-index while dashboard focused — interceptable, standard for app-like web UIs. Zero terminal cost (⌘digit is never a terminal input on mac). |
| ⌘9 / Ctrl+9 | Focus LAST pane | app-reserved | Matches Ghostty/Warp/VS Code idiom. |
| ⌘B / Ctrl+B | Toggle sidebar | app-reserved | Existing; migrated into registry + auth guard. Already declined by xterm today. |
| ⌘/ / Ctrl+/ | Help overlay (shortcut cheatsheet) | app-reserved | Free in Chrome; standard "show shortcuts" idiom. **Terry may defer to v2.** |

**Decision point A — the digit modifier (needs Terry's call):**
- **Option A (recommended): mod+digit only** (⌘ on mac via existing `hasPrimaryModifier`). Follows
  the convention of every terminal app surveyed; no terminal encoding stolen; cross-platform.
- **Option B: A + ctrl+1–4 aliases on mac** (the literal CMUX ask). Cost: ctrl+3 (ESC) and ctrl+4
  (FS) are stolen from focused TUIs. Real-world impact is small (people press Esc, not ctrl+3) but
  it's a silent-input-theft class we'd own forever.
- **Option C: ctrl+1–4 only** — not recommended: contested even inside CMUX, breaks the mod+digit
  convention, and inherits the encoding steals.

**Decision point B — help overlay in v1 or deferred.** It's the first overlay component (~100 lines,
fixed-position panel over the dock, Escape to close, renders straight from the registry). Recommended
in v1: discoverability is the difference between "shortcuts exist" and "shortcuts get used."
No `make hero` impact either way — the overlay is user-summoned, closed by default.

**Deferred (v2+ candidates, recorded in the ADR):** relative pane nav (ctrl+]/[ or alt+arrows — note
dockview ships a dormant keyboard-nav module, but it registers its own document listener; if we want
relative nav we implement it registry-native), notifications panel toggle, new-agent (⌘T is
browser-reserved; would need e.g. ⌘⇧N), close-pane (⌘W impossible in a browser tab), command palette,
user rebinding. PWA note for the #71 thin-client path: in installed-PWA mode Chrome reserves NOTHING
(even ⌘W becomes interceptable) — the deny-list must be mode-aware when that lands.

## 5. Discoverability

v1: the ⌘/ overlay (if approved) + accelerator hints in existing tooltips (sidebar toggle becomes
`title="Toggle sidebar (⌘B)"`). The overlay lists every registry entry grouped by category — it can
never drift from reality because it IS the registry. Deferred: printed hints in empty states,
first-run toast.

## 6. PR plan

**One PR** (the pieces are too interdependent to split usefully):
registry + dispatcher + xterm consult + `orderedPaneIds` + digit shortcuts + ⌘B migration
(+ overlay if approved) + ADR "Keyboard shortcut registry & the key-capture boundary" (number
assigned at PR-open from next-free; kept out of runtime strings) + CLAUDE.md fix for the stale
binary-tree description.

**Tests**: chord normalization + registry conflict unit tests; `orderedPaneIds` against serialized
grid fixtures (incl. the split-left-after-split-right case that breaks `api.panels` order); jsdom
dispatcher tests (reserved chord preventDefaults; passthrough chord untouched; input-focus guard);
Playwright e2e: focus a real terminal → mod+2 switches panes AND a passthrough chord still reaches
the shell. Full discipline: /polish + /qa before PR, exact CI, squash-merge, no --admin.

## 7. Surprises found (worth knowing regardless of this feature)

1. ⌘B fires on the login screen over the password input (no auth guard) — fixed by this work.
2. Both document-level Escape handlers (popovers, notification panel) are bubble-phase and thus dead
   whenever a terminal has focus — latent, papered over by focus-follows-click. Follow-up candidate.
3. `visiblePaneIds` in the store is a misnomer (all mounted panels, incl. background tabs).
4. CLAUDE.md's layout description is one full engine behind reality (ADR-047).
5. dockview ships complete-but-disabled keyboard navigation (ctrl+]/[, F6) — relative-nav option.
6. `switchPane` vs `setActive()` destructiveness asymmetry — a trap for any future pane feature.
