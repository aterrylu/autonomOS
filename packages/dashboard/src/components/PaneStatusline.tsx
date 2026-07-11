import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { THEMES, useStore } from "../store";
import { type AgentStatus, agentStatusLabel } from "./ui/agent-status-icon";
import { ProviderAgentIcon } from "./ui/provider-icon";

/**
 * PaneStatusline — an autonomOS-aware bar under a session's terminal.
 *
 * This is the dashboard-chrome equivalent of Claude Code's in-terminal
 * statusline (providers/statusline.mjs), for providers that can't render one
 * inside their own TUI. It shows, at a glance:
 *
 *   [◆ Name@project · ↑Manager · ↓N reports]        🌿branch · Working
 *    └ ProviderAgentIcon (provider mark + live status badge)
 *
 * Data all comes from the store (already polled) — identity + hierarchy from
 * /api/agents, live status from /api/hooks, branch derived server-side. No new
 * transport.
 *
 * Gating (per Terry's decision):
 *   - Codex / Gemini: always shown — they have no in-terminal statusline.
 *   - Claude Code: shown ONLY when its in-terminal statusline is disabled
 *     (statusLineEnabled === false), so a Claude pane is never double-barred.
 *
 * The `model` prop is intentionally unused today: model isn't plumbed to
 * providers at spawn (template.model is a dead field), so showing a specific
 * model name would be fabricated. Provider is shown instead (via the icon). If
 * model-at-spawn lands later, thread it in here to upgrade ◆Codex → gpt-5.6.
 */

/** Resolve the `@project` suffix: explicit project, else cwd basename. */
function resolveProject(
  project: string | undefined,
  workingDirectory: string,
): string | null {
  if (project) return project;
  const base = workingDirectory.split("/").filter(Boolean).pop();
  return base || null;
}

/** Compose the display identity. If the agent name already carries an `@`, it's
 *  self-describing — use it verbatim; otherwise append the resolved project. */
function displayIdentity(
  name: string,
  project: string | undefined,
  workingDirectory: string,
): { role: string; project: string | null } {
  const at = name.indexOf("@");
  if (at >= 0) {
    return { role: name.slice(0, at), project: name.slice(at + 1) || null };
  }
  return { role: name, project: resolveProject(project, workingDirectory) };
}

export const PaneStatusline = memo(function PaneStatusline({
  sessionId,
}: {
  sessionId: string;
  /** Reserved for a future model-at-spawn feature; see file header. */
  model?: string;
}) {
  const {
    session,
    status,
    currentTool,
    directReports,
    statusLineEnabled,
    theme,
  } = useStore(
    useShallow((s) => {
      const session = s.sessions.find((x) => x.id === sessionId);
      return {
        session,
        status: s.agentStatuses[sessionId]?.status,
        currentTool: s.agentStatuses[sessionId]?.currentTool,
        // Live count of agents that report to this one. Derived from the same
        // session list the org chart uses, so it tracks set_manager changes.
        directReports: session
          ? s.sessions.filter((x) => x.manager === session.name).length
          : 0,
        statusLineEnabled: s.statusLineEnabled,
        theme: s.theme,
      };
    }),
  );

  // No live agent to describe (exited or not yet in the list) → nothing to show.
  if (!session || session.status === "exited") return null;
  // Claude has its own in-terminal statusline; only surface the chrome bar when
  // that's turned off, so a Claude pane is never double-barred.
  if (session.provider === "claude-code" && statusLineEnabled !== false) {
    return null;
  }

  const page = THEMES[theme].page;
  const agentStatus = (status as AgentStatus) ?? "unknown";
  const { role, project } = displayIdentity(
    session.name,
    session.project,
    session.workingDirectory,
  );

  const dim = { color: page.statusFg };
  const sep = (
    <span style={dim} aria-hidden>
      {" · "}
    </span>
  );

  return (
    <div
      data-testid="pane-statusline"
      className="flex items-center gap-2 shrink-0 min-w-0 px-2 select-none"
      style={{
        height: 24,
        borderTop: `1px solid ${page.border}`,
        background: page.bg,
        color: page.fg,
        fontSize: 11,
        lineHeight: 1,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {/* Provider mark + live status badge — one glyph carries both. */}
      <ProviderAgentIcon
        provider={session.provider}
        status={agentStatus}
        size={14}
      />

      {/* Identity — name@project · ↑manager · ↓N reports (or standalone). */}
      <div className="flex items-center min-w-0 truncate">
        <span style={{ fontWeight: 600 }}>{role}</span>
        {project && <span style={dim}>@{project}</span>}
        {session.manager && (
          <>
            {sep}
            <span style={dim}>↑{session.manager}</span>
          </>
        )}
        {directReports > 0 && (
          <>
            {sep}
            <span style={dim}>
              ↓{directReports} report{directReports === 1 ? "" : "s"}
            </span>
          </>
        )}
        {!session.manager && directReports === 0 && (
          <>
            {sep}
            <span style={dim}>standalone</span>
          </>
        )}
      </div>

      {/* Activity — branch + status label, pushed to the right. */}
      <div className="flex items-center ml-auto shrink-0 gap-2">
        {session.branch && (
          <span style={dim} className="truncate" title={session.branch}>
            🌿 {session.branch}
          </span>
        )}
        <span>{agentStatusLabel(agentStatus, currentTool) || "—"}</span>
      </div>
    </div>
  );
});
