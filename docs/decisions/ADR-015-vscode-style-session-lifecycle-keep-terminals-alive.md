## ADR-015: VSCode-Style Session Lifecycle — Keep Terminals Alive
**Date:** 2026-03-10
**Decided by:** Terry
**Source:** Claude Code session (terminal UX improvements, PRs #23, #24)

**Context:** Switching between sessions destroyed the old terminal and created a new one. This caused visible flicker, lost scroll position, and required a full WebSocket reconnect on every switch. Users expect instant tab switching like VSCode or browser tabs.

**Decision:** Keep all session terminals mounted in the DOM simultaneously. Hide inactive sessions with `display: none`. Only the visible terminal holds a WebGL GPU context — hidden terminals dispose their WebGL addon and re-acquire it when shown.

**Implementation:**
- `SessionViewManager` renders a `SessionPane` for every active session, not just the current one
- `SessionPane` receives a `visible` prop that controls `display: none` vs `display: flex`
- WebGL addon is loaded/disposed via `ResizeObserver` — when a container has zero dimensions (hidden), WebGL is disposed; when visible, it's re-acquired
- WebSocket connections stay open for all sessions — no reconnect needed on switch

**Rationale:**
- Instant switching — no terminal creation, no WebSocket handshake, no flicker
- VSCode uses the same pattern for editor tabs (mount once, toggle visibility)
- WebGL context management prevents GPU memory leaks from hidden terminals
- Scroll position, command history, and terminal state are preserved per session

**Alternatives:**
- **Destroy/recreate on switch** — What we had. Simple but causes visible flicker (200-500ms) and loses state.
- **Offscreen canvas / terminal serialization** — Save terminal state and restore. Complex and xterm.js doesn't expose a clean serialize/restore API for full fidelity.
