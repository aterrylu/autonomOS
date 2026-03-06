# CC-Insights -- Session Interaction Capabilities

## TL;DR

CC-Insights is a **full interactive agent control system**, not just an observer. Users can send messages, approve/deny tool permissions, answer Claude's questions, interrupt responses, change models mid-session, and resume sessions across app restarts. All communication is bidirectional and real-time.

## 1. Session Lifecycle

### States

```dart
enum SessionPhase {
  idle,      // No session active
  starting,  // Creating/resuming session
  active,    // Session running, ready for messages
  stopping,  // Shutting down
  ended,     // Session terminated
  errored,   // Error occurred
}
```

### Create / Resume / Stop

```
User types initial prompt
  -> Chat.startSession()
  -> BackendService.createTransportForAgent(agentId, prompt, cwd, options)
  -> AgentBackend.createSession(prompt, cwd, SessionOptions)
  -> CliProcess spawned (claude --output-format stream-json)
  -> Initialization handshake (control_request -> control_response -> system init)
  -> First message sent via session.send()
  -> Events stream back via transport.events
```

**Resume:** Session ID persisted in `projects.json`. On resume:
```dart
SessionOptions(resume: lastSessionId)
```
CLI recognizes the ID and rehydrates state. A `SessionMarkerEntry(resumed)` is added to the conversation.

**Stop:** `InterruptCommand` preserves context (can send more messages). `KillCommand` terminates the subprocess.

**Idle timeout:** Configurable. Auto-stops inactive sessions to free resources. Can resume with new message.

## 2. Sending Messages

### Data Flow

```
MessageInput.onSubmit(text)
  -> Chat.sendMessage(text, images?)
  -> UserInputEntry added to conversation (visible immediately)
  -> transport.send(SendMessageCommand(sessionId, text))
  -> InProcessTransport -> session.send(text)
  -> CliProcess writes JSON to stdin
  -> Claude CLI processes and streams response
  -> InsightsEvent stream back through transport
  -> EventHandler routes events to conversation entries
```

### MessageInput Widget

- Rich text input with keyboard shortcuts
- Image paste support (via clipboard + drag-drop)
- Format modes: plain text, fixed-width, markdown
- Enter to send, Shift+Enter for newline
- Keyboard focus manager routes typing from anywhere to input

## 3. Permission System

### Flow

```
Claude CLI wants to use a tool
  -> PermissionRequest emitted on transport.permissionRequests stream
  -> Chat queues request in FIFO order
  -> Desktop notification sent
  -> PermissionDialog shown with:
     - Tool name and details (bash command, file paths, etc.)
     - Behavior dropdown (allow once, allow always, deny)
     - Permission rule suggestions
  -> User allows or denies
  -> PermissionResponseCommand sent back via transport
  -> CLI unblocks and continues (or handles denial)
```

### Permission Dialog Details

```
+------------------------------------------+
| [Tool Icon] Bash                         |
|                                          |
| Command: git status                      |
| Working Directory: /Users/me/project     |
|                                          |
| Behavior: [Allow Once v]                 |
|                                          |
| [ ] Add permission rule:                 |
|     "Allow git commands"                 |
|                                          |
|            [Deny]  [Allow]               |
+------------------------------------------+
```

### Auto-Approval

Internal CCI MCP tools (git operations, ticket creation from within the app) are auto-approved without showing the dialog.

### Timing Impact

Working stopwatch is **paused** while waiting for permission response. This separates "Claude working time" from "user deliberation time" in timing stats.

## 4. Ask User Question

Claude's `AskUserQuestion` tool is handled specially:

```
AskUserQuestion tool invocation
  -> PermissionRequest with toolInput containing questions
  -> AskUserQuestionDialog shown:
     +------------------------------------------+
     | Claude has a question                     |
     |                                          |
     | What testing approach do you prefer?      |
     | [multi-select badge if applicable]        |
     |                                          |
     | [Unit tests]  [Integration]  [E2E]       |
     | [Other...]                               |
     |                                          |
     | [Custom text input if "Other" selected]  |
     |                                          |
     |            [Cancel]  [Submit]             |
     +------------------------------------------+
  -> User selects answers
  -> PermissionResponseCommand with answers in updatedInput
  -> SDK receives answers and continues
```

Features:
- Multiple questions per dialog
- Single-select and multi-select modes
- "Other..." option with free text input
- Auto-submit on single-select choice (UX optimization)

## 5. Real-Time Streaming

### Event Processing

```dart
_eventSubscription = transport.events.listen(
  (event) => eventHandler.handleEvent(chat, event),
  onError: (error) => _handleError(error),
  onDone: () => _handleSessionEnd(),
);
```

Events are processed immediately as they arrive:

| Event | UI Effect |
|-------|-----------|
| `TextEvent(thinking)` | Collapsible thinking block in conversation |
| `TextEvent(text)` | Markdown-rendered text block |
| `StreamDeltaEvent` | Partial text appended to current block (live typing) |
| `ToolInvocationEvent` | Tool card appears with name + input |
| `ToolCompletionEvent` | Result attached to tool card |
| `TurnCompleteEvent` | Cost indicator updated, timing recorded |
| `SubagentSpawnEvent` | New subagent conversation tab created |
| `ContextCompactionEvent` | Summary entry added to conversation |
| `SessionStatusEvent` | Status indicator updated |

### Streaming Entry Pipeline

`SessionEventPipeline` manages streaming-to-final conversion:
1. `StreamDeltaEvent(blockStart)` creates a streaming entry
2. `StreamDeltaEvent(text/thinking/toolInput)` appends to the entry
3. `StreamDeltaEvent(blockStop)` finalizes the entry
4. Finalized `TextEvent` or `ToolInvocationEvent` replaces the streaming entry

### Auto-Scroll Behavior

- **At bottom:** Auto-scrolls as new content arrives
- **Scrolled up:** Preserves position (user is reading history)
- **New message indicator:** Shows when new content is below viewport

## 6. Session Control Commands

All available during an active session:

| Command | Method | Effect |
|---------|--------|--------|
| Send message | `chat.sendMessage(text)` | Sends user input, Claude responds |
| Interrupt | `chat.interrupt()` | Stops current response, preserves context |
| Kill | `chat.stopSession()` | Terminates session subprocess |
| Change model | `SetModelCommand` | Switches model mid-conversation |
| Change permissions | `SetPermissionModeCommand` | Switch to acceptEdits, plan, etc. |
| Change config | `SetConfigOptionCommand` | Backend-specific settings |
| Change reasoning | `SetReasoningEffortCommand` | Adjust thinking effort |
| Change system prompt | `SetSystemPromptCommand` | Update system prompt |

## 7. Subagent Tracking

When Claude spawns subagents (via Task tool):

```
SubagentSpawnEvent
  -> New ConversationData created (type: subagent)
  -> Tab appears in conversation panel
  -> Events with matching parentCallId routed to subagent conversation
  -> Read-only (user cannot send messages to subagents)

SubagentCompleteEvent
  -> Result displayed in subagent conversation
  -> Parent conversation continues
```

Subagent conversations are visible but not interactive. Permission requests from subagents ARE routed to the user.

## 8. Comparison: CC-Insights vs Mission Control

| Capability | CC-Insights | Mission Control |
|-----------|-------------|-----------------|
| Send messages to sessions | Yes (full bidirectional) | No (read-only observation) |
| Approve/deny permissions | Yes (interactive dialog) | No |
| Answer questions | Yes (AskUserQuestion dialog) | No |
| Interrupt sessions | Yes (preserves context) | No |
| Resume sessions | Yes (across app restarts) | No |
| Change model mid-session | Yes | No |
| Real-time streaming | Yes (event-driven, <100ms latency) | Partial (60s JSONL scan) |
| Subagent visibility | Yes (separate conversation tabs) | No |
| Multiple simultaneous sessions | Yes (one per chat, multiple chats) | N/A (observer only) |
| Session spawning | Yes (spawns Claude CLI) | No (scans existing) |
| External session discovery | No | Yes (scans ~/.claude/projects/) |

**Key takeaway for autonomOS:** CC-Insights proves that full interactive control is achievable through the Claude CLI's stream-json protocol. The `EventTransport` interface is the right abstraction -- autonomOS should implement a `WebSocketTransport` that bridges this protocol to a web dashboard.
