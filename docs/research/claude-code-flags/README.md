# Claude Code CLI Flags — autonomOS Integration Research

> Research date: 2026-03-26
> Status: Complete — ready for implementation

## Summary

Claude Code exposes ~40 CLI flags. This doc evaluates each for autonomOS use and identifies the highest-impact integrations. Three flags are transformative:

1. **`--session-id <uuid>`** — eliminates PTY regex parsing for session ID detection
2. **`--permission-mode auto`** — replaces `--dangerously-skip-permissions` with safe guardrails
3. **`--brief`** — enables `SendUserMessage` tool for structured agent-to-dashboard messaging

---

## High Priority — Should Implement Now

### `--session-id <uuid>`

Pre-set Claude's session ID before the process starts.

**Current problem:** autonomOS watches PTY output for `Session: <uuid>` via regex. This has a race window where the session exists but `claudeSessionId` is unknown. Fresh sessions can't be persisted until the ID is detected.

**With `--session-id`:** Generate `crypto.randomUUID()` before spawn, pass it as `--session-id`. The session ID is known at creation time — zero race, immediate persistence.

```typescript
const claudeSessionId = crypto.randomUUID();
args.push("--session-id", claudeSessionId);
session.claudeSessionId = claudeSessionId; // known immediately
```

**Eliminates:** PTY regex block in `sessions.ts` (lines 202-216), SessionStart hook ID detection in `hooks.ts`.

---

### `--permission-mode <mode>`

Fine-grained permission control. Replaces the binary `--dangerously-skip-permissions`.

| Mode | Behavior | Use case |
|------|----------|----------|
| `default` | Prompts for every tool on first use | Human-supervised |
| `acceptEdits` | Auto-accepts file edits, prompts for bash | Semi-supervised |
| `dontAsk` | Auto-denies unless pre-approved | Locked-down read-only |
| `plan` | Read-only analysis, no writes | Code review, planning |
| `auto` | **AI classifier auto-approves safe actions, blocks risky ones** | **Autonomous agents** |
| `bypassPermissions` | Skips all checks (= `--dangerously-skip-permissions`) | Trusted sandboxes only |

**`auto` mode** uses a classifier that evaluates each tool call against rules:
- **Allow:** local file ops, read-only requests, declared deps, git push to working branch
- **Soft deny:** force push, production deploy, credential exploration, data exfiltration
- **Hard deny:** self-modification, unauthorized persistence, RCE surface creation

**Recommendation:** Default autonomOS sessions to `auto` instead of `bypassPermissions`. Add a dropdown in the dashboard for power users to override per-session.

```typescript
// Before:
if (options.autonomousMode) args.push("--dangerously-skip-permissions");

// After:
const mode = options.permissionMode ?? (options.autonomousMode ? "auto" : "default");
args.push("--permission-mode", mode);
```

---

### `--brief` / SendUserMessage

Enables the `SendUserMessage` tool — structured agent-to-user messaging for background agents.

**Tool schema:**
```json
{
  "message": "string (markdown)",
  "status": "normal | proactive",
  "attachments": ["file paths"]
}
```

**`status` field is the key signal:**
- `"normal"` — replying to what the user asked
- `"proactive"` — agent-initiated: task complete, blocker found, needs input

**How autonomOS intercepts it:** The existing hook relay captures `PreToolUse` events. When `tool_name === "SendUserMessage"`, extract `tool_input.message`, `tool_input.status`, and `tool_input.attachments`. Route based on `status`:
- `normal` → show in session pane
- `proactive` → trigger notification badge, maybe desktop notification

**What it does NOT replace:** Hooks are still needed for tool events, lifecycle, permissions. `SendUserMessage` only covers "agent says something to the human."

**Recommendation:** Add `briefMode` as an opt-in per-session option. Best for long-running background agents.

---

### `--append-system-prompt <prompt>`

Appends text to the default system prompt without replacing it. CLAUDE.md, tool definitions, etc. all stay intact.

**Use for autonomOS:** Inject orchestrator identity into every session:

```
You are managed by autonomOS, an agent orchestration dashboard.
Session ID: <uuid>. Server: http://localhost:3100.
```

Could also inject per-session context:
- Project constraints ("Only edit files under packages/dashboard/")
- Sprint context ("Current sprint goal: implement notifications")
- Agent role ("You are a code reviewer. Focus on correctness and style.")

---

## Medium Priority — Enable as Options

### `--agents <json>` + `--agent <agent>`

Define custom agent personas per session.

```json
{
  "reviewer": {
    "description": "Reviews code for quality and bugs",
    "prompt": "You are a code reviewer. Focus on correctness, style, and potential bugs."
  },
  "documenter": {
    "description": "Writes and updates documentation",
    "prompt": "You are a documentation writer. Update READMEs and docs to reflect code changes."
  }
}
```

**For autonomOS:** Dashboard dropdown "Start session as: General | Reviewer | Documenter | Test Writer" — each backed by a different `--agents` definition.

---

### `--model <model>`

Override model per session. Examples: Haiku for lightweight monitoring, Opus for complex work.

---

### `--effort <level>` (low | medium | high | max)

Control token spend per session. Quick tasks get `low`, deep work gets `max`.

---

### `--allowedTools / --disallowedTools`

Fine-grained tool permissions per session.

```bash
# Read-only review session:
--disallowedTools "Edit Write Bash"

# Only allow specific tools:
--allowedTools "Read Glob Grep"
```

---

### `--mcp-config <json>`

Inject MCP server configs per-session. Could auto-connect agents to the autonomOS MCP server:

```json
{
  "mcpServers": {
    "autonomos": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

---

### `--add-dir <directories>`

Allow Claude to access directories beyond the working directory. Useful for multi-repo sessions.

---

### `--name <name>`

Set the session display name. Currently we set `session.name` server-side but don't tell Claude Code.

---

## Low Priority / Situational

### `--fork-session`

Combined with `--resume`, creates a new session ID instead of reusing the original. "Branch" a conversation — resume a checkpoint without overwriting the original.

### `--bare`

Disables hooks, LSP, plugin sync, CLAUDE.md discovery. Ultra-fast but **breaks hook relay**. Only for ephemeral analysis sessions.

### `--print` / `--output-format stream-json`

Non-interactive mode with structured JSON output. Not useful for PTY sessions, but could power a future "batch mode" in autonomOS.

### `--no-session-persistence`

Disable Claude's own session persistence. Consider for ephemeral/disposable sessions where autonomOS manages persistence.

### `--setting-sources ""`

Skip all settings files. Combined with `--settings <json>`, gives fully isolated config. Good for sandboxed sessions.

### `--strict-mcp-config`

Only use MCPs from `--mcp-config`, ignore all others. Good for controlled environments.

---

## Missing Hook Events

autonomOS currently subscribes to 11 events. These are available but not subscribed:

| Event | What it does | Should add? |
|-------|-------------|-------------|
| `SubagentStop` | Sub-agent finished | **Yes** — fixes "stuck in orchestrating" status |
| `PostCompact` | Context compaction complete | **Yes** — fixes "stuck in compacting" status |
| `TaskCreated` | Agent created a sub-task | Future — task tree visualization |
| `TaskCompleted` | Agent completed a sub-task | Future — task tree visualization |
| `TeammateIdle` | Teammate agent went idle | Future — multi-agent coordination |

---

## Proposed `SpawnOptions` Extension

```typescript
interface SpawnOptions {
  workingDirectory: string;
  prompt?: string;
  name?: string;
  resumeSessionId?: string;

  // Permission model
  autonomousMode?: boolean;        // Legacy — maps to bypassPermissions
  permissionMode?: "default" | "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "plan";

  // Agent identity
  briefMode?: boolean;             // --brief: enable SendUserMessage
  appendSystemPrompt?: string;     // --append-system-prompt
  agentType?: string;              // --agent
  agentDefinitions?: Record<string, { description: string; prompt: string }>;  // --agents

  // Model & effort
  model?: string;                  // --model
  effort?: "low" | "medium" | "high" | "max";  // --effort

  // Tool permissions
  allowedTools?: string[];         // --allowedTools
  disallowedTools?: string[];      // --disallowedTools

  // Environment
  additionalDirs?: string[];       // --add-dir
  mcpConfig?: string;              // --mcp-config (JSON string)

  // Terminal
  cols?: number;
  rows?: number;
}
```

---

## Sources

- [Auto mode for Claude Code](https://claude.com/blog/auto-mode)
- [Configure permissions — Claude Code Docs](https://code.claude.com/docs/en/permissions)
- [Create custom subagents — Claude Code Docs](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Auto Mode: Safe Uninterrupted Development](https://claudefa.st/blog/guide/development/auto-mode)
- Binary analysis of Claude Code v2.1.81
