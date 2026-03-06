# Claude Code

**By:** Anthropic
**License:** Proprietary (Anthropic product)
**Language:** TypeScript (internal), used via CLI
**Docs:** https://docs.anthropic.com/en/docs/claude-code

## What It Is

An autonomous coding agent that runs in the terminal. Not a framework or SDK — it's a **complete product**. You give it tasks (fix bug, add feature, review code) and it reads files, edits code, runs commands, and iterates until done.

## Core Concepts

- **Tools**: File system (read, write, edit, glob, grep), shell (bash), MCP servers, web search
- **Permission model**: User controls which tools auto-execute vs require approval
- **Hooks**: Pre/post tool execution hooks (shell commands triggered by tool events)
- **MCP integration**: Extensible via Model Context Protocol servers
- **Worktrees**: Can work in git worktrees for parallel development

## Architecture (as observed)

```
User Prompt
    |
    v
+------------------------+
|    Claude Code Agent    |
|                         |
|  Claude (Opus/Sonnet)   |
|       |                 |
|  Tool Selection ------> Tool Execution
|       ^                      |
|       +------ result --------+
|                         |
|  (task complete)        |
+----------|--------------+
           v
     Response to User
```

It's essentially the Claude Agent SDK pattern, but with a rich set of built-in tools optimized for software engineering.

## Strengths

- **Production-ready**: Battle-tested coding agent with good UX
- **Extensible via MCP**: Add any capability via MCP servers
- **Hooks system**: Automate pre/post actions (linting, testing, notifications)
- **Permission control**: Fine-grained security model
- **Context management**: Automatic conversation compression, CLAUDE.md files for project context

## Weaknesses

- **Not embeddable**: It's a CLI product, not a library you import
- **Claude-only**: Powered exclusively by Claude models
- **Black box**: Internal agent loop isn't customizable
- **Cost**: Uses Claude API credits (can be expensive for long sessions)

## Relevance to autonomOS

### As an integration target (CRITICAL)
Claude Code is likely the **first agent autonomOS will observe and control**. Integration points:
- **Hooks**: Pre/post tool hooks can report to autonomOS in real-time
- **MCP servers**: autonomOS could expose an MCP server that Claude Code connects to (bidirectional)
- **Session data**: Parse conversation logs for analytics
- **CLAUDE.md**: autonomOS could manage/generate CLAUDE.md files for different projects

### As an internal tool (MEDIUM)
Could use Claude Code as a sub-agent for autonomOS tasks that involve code changes (e.g., "update the dashboard component"). But it's a CLI, so integration would be via subprocess.

### Key patterns to adopt
- **CLAUDE.md convention** — project-level agent configuration is a great pattern for autonomOS
- **Permission model** — our control plane should offer similar granularity
- **Hooks architecture** — directly applicable to our event system

## Integration Strategy

| Approach | Description | Effort |
|----------|-------------|--------|
| Hooks → autonomOS | Claude Code hooks POST events to autonomOS API | Low |
| MCP bidirectional | autonomOS MCP server provides context/tools to Claude Code | Medium |
| Session analytics | Parse Claude Code logs/sessions for dashboard | Medium |
| Config management | autonomOS manages CLAUDE.md across projects | Low |
