---
"@autonomos/dashboard": patch
---

Keyboard-shortcut debt batch. Escape typed inside a lightweight status-bar popover's text field now blurs the field instead of closing the popover — a half-typed value (session key, env var) is no longer silently discarded; a second Escape closes as before. Modal dialogs (the help overlay and ⌘K quick-switcher) still close on Escape from their own input, and terminal Escape behavior is unchanged. The last pre-registry hand-list — xterm's mod-key switch (clear, select-all, readline sends, the deliberate mod+W decline) — is now one documented, drift-tested table (`shortcuts/terminalKeymap.ts`), with each binding carrying its rationale. The help overlay traps Tab like the ⌘K palette (walking focus out under an open aria-modal backdrop). Also removes a stale CLAUDE.md reference to the deleted `orderedPaneIds`.
