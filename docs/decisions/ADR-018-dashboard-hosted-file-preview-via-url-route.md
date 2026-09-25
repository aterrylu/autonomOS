## ADR-018: Dashboard-Hosted File Preview via URL Route
**Date:** 2026-03-14
**Decided by:** Terry
**Source:** Claude Code session (markdown preview feature)

**Context:** Claude Code terminal output is full of markdown file paths. No way to preview them without switching to VSCode or another tool. Considered multiple approaches: split pane in terminal, slide-over panel, and dashboard-hosted URL.

**Decision:** Dashboard-hosted URL route (`/preview?file=/path/to/file.md`). The terminal detects `.md` paths via xterm.js `ILinkProvider` and opens them in a new browser tab. The dashboard serves a `/preview` route that fetches file content from the server and renders it with `react-markdown` + `remark-gfm` + `mermaid`.

**Architecture (3 layers):**
1. **Server endpoint** — `GET /api/files/read?path=...` returns file content as JSON (1MB limit)
2. **Dashboard route** — `/preview` page, conditionally rendered in `main.tsx` based on URL path (no router library needed)
3. **Terminal link provider** — `MarkdownLinkProvider` class registered on each terminal instance, regex-matches `.md` paths, ctrl+click opens preview URL

**Rationale:**
- Simplest approach — no split pane state, no resize handling, no WebGL context juggling
- Reusable building blocks: `/api/files/read` is a general file API, `/preview` route can extend to other file types
- Shareable URLs — can bookmark or share a preview link
- The `/preview` route + file API naturally evolves into a general file viewer (syntax-highlighted code, images) without redesign
- Mermaid support via fenced code blocks (`\`\`\`mermaid`) with DOMPurify sanitization

**Alternatives:**
- **Split pane in SessionPane** — IDE-like side-by-side terminal + preview. More complex (resize logic, per-session state, WebGL context management). Can be added later using the same renderer component.
- **Slide-over overlay** — Middle ground between URL and split pane. But still covers the terminal and needs overlay state.
- **External tool (VSCode preview)** — Already works but requires context-switching out of autonomOS.

**Update (2026-07-25, ADR-059):** Superseded — the feature is removed entirely, including all three layers above plus `GET /api/files/read` and `WS /ws/files/watch`. It had silently regressed twice (the dockview default in #263 left `openPreview` tearing down the whole dock; the hierarchy-sidebar default in #249 left an open preview with no sidebar row) and carried zero test coverage, so both regressions landed green. The "reusable building blocks" rationale did not hold: `/api/files/read` acquired no second consumer in four months. The rejected **"split pane in SessionPane"** alternative above remains the starting point if a working version is ever wanted — with test coverage this time, not a revert.
