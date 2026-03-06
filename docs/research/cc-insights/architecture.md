# CC-Insights -- Architecture Deep Dive

## 1. High-Level Architecture

CC-Insights is a **Flutter desktop application (macOS-only)** with a multi-module Dart monorepo. Unlike mission-control's web-based approach, everything runs in a single native process that spawns Claude CLI as subprocesses.

```
+-----------------------------------------------------------------------+
|                     Flutter Desktop App (macOS)                        |
|                                                                       |
|  +-------------+  +---------------+  +-----------+  +---------------+ |
|  | Provider     |  | 30+ Panels   |  | Screens   |  | Widgets       | |
|  | State Mgmt   |<-| (drag-split) |  | (5 views) |  | (cost, ctx,  | |
|  | (ChangeNotif)|  +---------------+  +-----------+  |  markdown...) | |
|  +------+-------+                                    +---------------+ |
|         |                                                             |
|  +------v------+  +----------------+  +--------------+                |
|  | Services    |  | Models         |  | State        |                |
|  | (46 files)  |  | (20 files)     |  | (selection,  |                |
|  | backend,    |  | project, chat, |  |  theme,      |                |
|  | event_hdlr, |  | conversation,  |  |  file_mgr)   |                |
|  | git, ticket |  | ticket, etc.   |  +--------------+                |
|  +------+------+  +----------------+                                  |
+---------+-------------------------------------------------------------+
          |
          | BackendCommand / InsightsEvent (via EventTransport)
          |
+---------v---------------------------------------------------------+
|                    Transport Abstraction Layer                      |
|                                                                    |
|  EventTransport (interface)                                        |
|    - events: Stream<InsightsEvent>       (backend -> UI)           |
|    - send(BackendCommand)                (UI -> backend)           |
|    - permissionRequests: Stream<...>     (permission flow)         |
|                                                                    |
|  InProcessTransport (current implementation)                       |
|    - Wraps AgentSession directly                                   |
|    - Translates commands to session method calls                   |
|                                                                    |
|  [Future: WebSocketTransport, DockerTransport, etc.]               |
+----+-------------------+-------------------+----------------------+
     |                   |                   |
+----v------+    +-------v------+    +-------v------+
| Claude CLI|    | Codex SDK    |    | ACP SDK      |
| Backend   |    | Backend      |    | Backend      |
+-----------+    +--------------+    +--------------+
     |                   |                   |
+----v------+    +-------v------+    +-------v------+
| CliProcess|    | JSON-RPC     |    | ACP Protocol |
| (subprocess|   | Client       |    | Client       |
| stdin/out) |   +--------------+    +--------------+
+----+------+
     |
+----v----------------------------------------------+
| Claude CLI (--output-format stream-json)          |
| stdin: JSON command envelopes                     |
| stdout: InsightsEvent JSON stream                 |
| stderr: SDK diagnostic logs                       |
+---------------------------------------------------+
```

### Key Architectural Insight

The app operates as an **agent spawner + controller**, not a passive observer. Each chat creates a dedicated CLI subprocess. The `EventTransport` abstraction is designed to decouple the UI from the backend transport -- today it's in-process, but the interface supports remote backends.

## 2. Module Structure

### agent_sdk_core/ (~30 files, ~5K lines)

The **backend-agnostic shared layer**. Zero external dependencies (only `meta` for annotations).

```
agent_sdk_core/lib/src/
  backend_interface.dart       # AgentBackend + AgentSession interfaces
  transport/
    event_transport.dart       # EventTransport interface
    in_process_transport.dart  # Wraps AgentSession for in-process use
  types/
    backend_commands.dart      # BackendCommand sealed hierarchy (9+ types)
    insights_events.dart       # InsightsEvent sealed hierarchy (13+ types)
    callbacks.dart             # PermissionRequest, PermissionResponse
    content_blocks.dart        # ContentBlock (text, image)
    session_options.dart       # SessionOptions, ToolsConfig, SecurityConfig
    usage.dart                 # TokenUsage, ModelTokenUsage
    control_messages.dart      # Low-level CLI protocol messages
  internal_tool_registry.dart  # Custom tool registration
  sdk_logger.dart              # Logging interface
```

**Core Interfaces:**

```dart
abstract class AgentBackend {
  BackendCapabilities get capabilities;
  Future<AgentSession> createSession({...});
  List<AgentSession> get sessions;
  Future<void> dispose();
}

abstract class AgentSession {
  String get sessionId;
  Stream<InsightsEvent> get events;
  Stream<PermissionRequest> get permissionRequests;
  Future<void> send(String message);
  Future<void> interrupt();
  Future<void> kill();
}

abstract class EventTransport {
  Stream<InsightsEvent> get events;           // Backend -> UI
  Future<void> send(BackendCommand command);  // UI -> Backend
  Stream<PermissionRequest> get permissionRequests;
}
```

### claude_dart_sdk/ (~35 files, ~8K lines)

Claude CLI backend implementation. Re-exports agent_sdk_core.

```
claude_dart_sdk/lib/src/
  cli_backend.dart       # AgentBackend impl: manages CliSessions
  cli_session.dart       # AgentSession impl: wraps CliProcess
  cli_process.dart       # Subprocess management (Process.start)
  single_request.dart    # One-shot API calls (no session)
  backend_factory.dart   # Backend type selection
  sdk_logger.dart        # SDK-specific logging
```

**Session Creation Flow:**
1. `CliBackend.createSession()` creates `CliSession`
2. `CliSession` creates `CliProcess` which spawns `claude` CLI
3. CLI args: `--output-format stream-json --input-format stream-json`
4. Initialization handshake: `control_request(initialize)` -> `control_response` -> `system(init)`
5. First user message sent via `session.send()`

### frontend/ (~395 files, ~140K lines)

Flutter desktop app with Provider state management.

```
frontend/lib/
  main.dart                    # App entry, provider setup
  config/fonts.dart            # JetBrains Mono configuration

  models/                      # 20 data model files
    project.dart               # ProjectState (ChangeNotifier)
    worktree.dart              # WorktreeState (ChangeNotifier)
    chat.dart                  # Chat (complex: session + conversation + permissions)
    conversation.dart          # ConversationData (persistent message log)
    output_entry.dart          # OutputEntry sealed hierarchy
    cost_tracking.dart         # CostTrackingEntry for JSONL persistence
    context_tracker.dart       # Context window monitoring
    ticket.dart                # Ticket model with timeline, tags, deps
    timing_stats.dart          # Claude work time vs user response time

  services/                    # 46 service files
    backend_service.dart       # SDK lifecycle management
    event_handler.dart         # InsightsEvent routing to models
    git_service.dart           # Git operations (abstract + real + fake)
    worktree_service.dart      # Worktree CRUD with validation
    persistence_service.dart   # projects.json + chat metadata
    cost_tracking_service.dart # JSONL append-only cost log
    ticket_storage_service.dart
    ticket_dispatch_service.dart
    ticket_event_bridge.dart   # SDK events -> ticket actions

  screens/                     # 5 full-screen views
    main_screen.dart           # Primary workspace
    welcome_screen.dart        # Session start (model/agent selection)
    settings_screen.dart       # App configuration
    file_manager_screen.dart   # File tree + viewer
    project_stats_screen.dart  # Analytics drill-down

  panels/                      # 30+ draggable panels
    worktree_panel.dart        # Worktree list with badges
    chats_panel.dart           # Chat list per worktree
    conversation_panel.dart    # Message display + auto-scroll
    content_panel.dart         # Tool result detail view
    actions_panel.dart         # Quick actions
    file_tree_panel.dart       # Repository file browser
    information_panel.dart     # Git status display
    ticket_list_panel.dart     # Ticket kanban/list
    ticket_detail_panel.dart   # Ticket editor
    ticket_graph_view.dart     # Dependency visualization

  widgets/                     # Reusable components
    message_input.dart         # User input with image paste
    permission_dialog.dart     # Tool approval UI
    ask_user_question_dialog.dart  # Multi-choice question UI
    cost_indicator.dart        # Inline token/cost display
    context_indicator.dart     # Context window progress bar
    tool_card.dart             # Tool call visualization
    diff_view.dart             # Side-by-side diff
    markdown_renderer.dart     # Markdown display
```

## 3. State Management

Provider-based with `ChangeNotifier` throughout:

```
MultiProvider (main.dart)
  BackendService           # SDK lifecycle
  SelectionState           # Project > Worktree > Chat > Conversation
  ThemeState               # Light/dark theme
  FileManagerState         # File browser state
  DialogObserver           # Keyboard focus management
  TicketBoardState         # Ticket kanban state
  SettingsService          # Persisted preferences
```

**Selection Hierarchy:**
```
SelectionState
  selectedProject: ProjectState?
    selectedWorktree: WorktreeState?
      selectedChat: Chat?
        selectedConversation: ConversationData?
```

Each level preserves selection when navigating up. Switching projects returns to the previously-selected worktree in that project.

## 4. Persistence Architecture

```
~/.ccinsights/
  projects.json                          # Master index of all projects/worktrees/chats
  projects/
    {projectId}/
      chats/
        {chatId}.meta.json               # Per-chat: usage, context, timing, model
        {chatId}.conversation.jsonl       # Message history (append-only)
      tracking.jsonl                     # Cost tracking (append-only, per closed chat)
  settings.json                          # App preferences
  tickets/                               # Ticket storage
```

**Key persistence behaviors:**
- `projects.json` is the master index, loaded at startup
- Chat metadata saved on each turn completion
- Conversation entries appended as they finalize (streaming -> complete)
- Cost tracking entries written when a chat is closed
- Session IDs persisted for resume across app restarts

## 5. Key Dependencies

| Category | Package | Purpose |
|----------|---------|---------|
| State | `provider ^6.1.2` | Reactive state management |
| Layout | `drag_split_layout` | Resizable panel system |
| Terminal | `xterm ^4.0.0`, `flutter_pty ^0.4.0` | Embedded terminal |
| Markdown | `flutter_markdown_plus`, `gpt_markdown` | Switchable renderers |
| Syntax | `code_highlight_view ^0.1.1` | Code highlighting |
| Diff | `diff_match_patch ^0.4.1` | File diff computation |
| File | `watcher`, `path`, `file_picker` | Filesystem operations |
| Clipboard | `super_clipboard`, `desktop_drop` | Drag-drop + image paste |
| Window | `window_manager ^0.5.0` | Size/position persistence |
| Crypto | `crypto ^3.0.7` | SHA-256 for project IDs |
| Audio | `audioplayers`, `local_notifier` | Desktop notifications |
| UUID | `uuid ^4.5.1` | Unique identifiers |
| Fonts | JetBrains Mono (bundled asset) | Monospace text |

**Notable absence:** No charting library. All analytics are table-based with inline indicators.
