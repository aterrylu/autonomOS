---
"@autonomos/dashboard": minor
"@autonomos/server": minor
---

Remove the markdown file preview feature (ADR-059, supersedes ADR-018). Ctrl/Cmd+clicking a `.md` path in a terminal no longer opens a preview; `.md` files must be opened externally.

The feature had silently regressed twice. Making dockview the default layout engine (#263) left `openPreview` as the only `open*` action without a dockview branch, so opening a preview ran `showSolo()` and **tore down the whole dock** — in practice, ctrl+clicking a `.md` in an agent's terminal destroyed the terminal pane (reversing #103's "opens as a new tab"). Defaulting the sidebar to hierarchy view (#249) then left open previews with no sidebar row at all. Both landed green because the feature had zero test coverage.

Removed: `PreviewPane`, `PreviewPage`, the `/preview` route dispatch, `MarkdownLinkProvider`, the `"preview"` `ActivePane` member with its `previewPanes` state and `openPreview`/`closePreview` actions, the `.prose-custom` stylesheet, three orphaned codicons, and the server's `GET /api/files/read` + `WS /ws/files/watch`. Drops 5 dependencies (`react-markdown`, `remark-gfm`, `mermaid`, `dompurify`, `@types/dompurify`) and eliminates the dashboard's only two `dangerouslySetInnerHTML` call sites.

Saved layouts degrade gracefully with no migration hook. A pane descriptor had **two** persisted carriers, and both are handled: `activePane: {type:"preview"}` is rejected by `isValidActivePane` and falls back to the empty state, and — less obviously — dockview's `toJSON()` persists every panel's `params`, so `{type:"preview"}` also survives inside `dvWorkspaces[*].serialized` and is re-created by `fromJSON` on restore. Unhandled that produced an empty pane under a tab titled "Tab", permanently so while `/api/agents` was failing. Retired pane types are now closed with a diagnostic warning at `PaneContent` — the one boundary every panel path converges on — and the activate-writeback no longer launders an unknown panel id into a session pane. `previewPanes` drops out of localStorage on the first persisted write, and leftover `preview:*` order keys are swept by the existing `fetchSessions` prune. Non-layout preferences (theme, sidebar) are preserved. `/preview?file=…` URLs now render the normal dashboard.
