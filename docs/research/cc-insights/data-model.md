# CC-Insights -- Data Model & Metrics

## 1. Core Type Hierarchy

All backend communication uses sealed Dart classes for type-safe pattern matching.

### InsightsEvent (Backend -> UI)

```
InsightsEvent (sealed)
  id: String, timestamp: DateTime, provider: BackendProvider, raw?, extensions?
  |
  +-- SessionInitEvent        sessionId, model, cwd, tools, mcpServers, account
  +-- ConfigOptionsEvent      sessionId, configOptions
  +-- AvailableCommandsEvent  sessionId, availableCommands
  +-- SessionModeEvent        sessionId, currentModeId
  +-- TextEvent               text, kind (text|thinking|plan|error)
  +-- UserInputEvent          text, isSynthetic, images
  +-- ToolInvocationEvent     callId, toolName, toolInput, kind, model
  +-- ToolCompletionEvent     callId, output, isError
  +-- TurnCompleteEvent       denials, usage (TokenUsage + ModelTokenUsage[])
  +-- UsageUpdateEvent        tokenUsage (per-model breakdown)
  +-- ContextCompactionEvent  contextSize, trigger (auto|manual|cleared)
  +-- SubagentSpawnEvent      conversationId, label, taskDescription
  +-- SubagentCompleteEvent   conversationId, result
  +-- StreamDeltaEvent        kind (text|thinking|toolInput|blockStart|blockStop), delta
  +-- PermissionRequestEvent  (triggers UI dialog)
  +-- RateLimitUpdateEvent    (rate limit info, Codex only)
  +-- SessionStatusEvent      status (compacting|resuming|interrupted|ended|error)
```

### BackendCommand (UI -> Backend)

```
BackendCommand (sealed)
  |
  +-- SendMessageCommand          sessionId, text, images?
  +-- InterruptCommand            sessionId (stop mid-response, preserve context)
  +-- KillCommand                 sessionId (terminate session)
  +-- PermissionResponseCommand   requestId, allowed, message?, updatedPermissions?
  +-- SetModelCommand             sessionId, model
  +-- SetPermissionModeCommand    sessionId, mode
  +-- SetConfigOptionCommand      sessionId, key, value
  +-- SetReasoningEffortCommand   sessionId, effort
  +-- SetSystemPromptCommand      sessionId, prompt
```

### OutputEntry (Conversation Display)

```
OutputEntry (sealed) -- persisted to conversation JSONL
  id: String, timestamp: DateTime
  |
  +-- TextOutputEntry             text, contentType (text|thinking), errorType?
  +-- ToolUseOutputEntry          toolName, toolUseId, toolInput, toolResult, isError
  +-- UserInputEntry              text, images?
  +-- SystemNotificationEntry     text, notificationType
  +-- ContextSummaryEntry         summary (synthetic after compaction)
  +-- SessionMarkerEntry          markerType (started|resumed|ended)
  +-- TicketEntry                 ticketId, action
```

## 2. Token & Cost Tracking

### Per-API-Call (from TurnCompleteEvent / UsageUpdateEvent)

```dart
class TokenUsage {
  int inputTokens;
  int outputTokens;
  int? cacheReadTokens;
  int? cacheCreationTokens;
  int get totalTokens => inputTokens + outputTokens;
}

class ModelTokenUsage extends TokenUsage {
  String model;          // e.g., "claude-sonnet-4-5-20250929"
  double? costUsd;
  int? contextWindow;
  int? webSearchRequests;
  String get displayName; // Parsed: "Sonnet 4.5"
}
```

### Per-Chat Aggregation (in Chat model)

```dart
class UsageInfo {
  int inputTokens, outputTokens;
  int cacheReadTokens, cacheCreationTokens;
  double costUsd;
}

class ModelUsageInfo {
  String modelName;
  int inputTokens, outputTokens;
  int cacheReadTokens, cacheCreationTokens;
  double costUsd;
  int? contextWindow;
  String? displayName;
}
```

Accumulated in `ChatMetricsState` across the chat's lifetime by merging each `TurnCompleteEvent`.

### Per-Worktree Aggregation

```dart
// WorktreeState
Map<String, ({int totalTokens, double costUsd})> get costPerBackend;
```

Aggregates costs from closed chats (stored in `_closedChatUsage`) plus active chats.

### Historical Persistence (JSONL)

```
~/.ccinsights/projects/{projectId}/tracking.jsonl
```

One JSON object per line, written when a chat closes:

```json
{
  "worktree": "main",
  "chatName": "Fix auth bug",
  "timestamp": "2026-03-05T10:30:00Z",
  "backend": "claude",
  "modelUsage": [
    {
      "modelName": "claude-sonnet-4-5-20250929",
      "inputTokens": 15000,
      "outputTokens": 3000,
      "cacheReadTokens": 8000,
      "cacheCreationTokens": 2000,
      "costUsd": 0.12,
      "contextWindow": 200000
    }
  ],
  "timingStats": {
    "claudeWorkingMs": 45000,
    "claudeWorkCount": 3,
    "userResponseMs": 12000,
    "userResponseCount": 2
  }
}
```

## 3. Context Window Tracking

```dart
class ContextTracker {
  int currentTokens;              // Updates per API call
  int maxTokens;                  // Default 200K, updated from model
  double? autocompactBufferPercent;  // Claude: 22.5%, Codex: null
  double get percentUsed;         // 0.0 - 100.0
}
```

**Per-step consumption:** `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`

**Autocompact awareness:**
- Claude chats know the threshold (100% - 22.5% = 77.5%)
- UI colors shift from green -> amber -> orange -> red as context fills
- Warning icon shown at red level

## 4. Timing Statistics

```dart
class TimingStats {
  int claudeWorkingMs;       // Total time Claude spent processing
  int claudeWorkCount;       // Number of work cycles
  int userResponseMs;        // Total time user took to respond
  int userResponseCount;     // Number of user responses

  Duration get averageClaudeWorkingTime;
  Duration get averageUserResponseTime;
  String formatDuration(Duration d); // "2m 35s"
}
```

Timing is measured by pausing/resuming a stopwatch:
- **Claude working:** Starts when message sent, pauses when permission requested, resumes when answered, stops when turn completes
- **User response:** Time between permission request shown and user's allow/deny

Stats are mergeable across chats via `merge()` method.

## 5. Project Stats Aggregation

Three-level drill-down in `ProjectStatsScreen`:

```dart
class ProjectStats {
  String projectName;
  List<WorktreeStats> worktreeStats;  // Sorted: active first, then deleted
}

class WorktreeStats {
  String worktreeName;
  String? worktreePath;               // null if worktree was deleted
  List<ChatStats> chatStats;
  Set<String> backends;               // {'claude', 'codex', 'acp'}
}

class ChatStats {
  String chatName;
  String worktreeName;
  String backend;
  List<ModelUsageInfo> modelUsage;
  TimingStats? timingStats;
  DateTime? timestamp;
  bool isActive;                      // Live vs historical
}
```

**Data sources merged:**
1. Active chats from `ProjectState` (live, `isActive: true`)
2. Historical entries from `tracking.jsonl` (`isActive: false`)

## 6. Metrics Summary

| Metric | Granularity | Aggregation Levels | Visualization |
|--------|-------------|-------------------|---------------|
| Token count (input/output) | Per-model, per-turn | Chat, worktree, project | Inline text + tooltip |
| Cache tokens (read/create) | Per-model, per-turn | Chat, worktree, project | Tooltip only |
| Cost (USD) | Per-model, per-turn | Chat, worktree, project | Inline text + tooltip |
| Context window usage | Per-API-call | Single chat | Progress bar + percentage |
| Autocompact threshold | Per-backend | Single chat | Color-coded warning |
| Claude working time | Per-turn | Chat (mergeable) | Tooltip text |
| User response time | Per-permission | Chat (mergeable) | Tooltip text |
| Git status | Per-worktree | Project | Information panel |
| Commits ahead/behind | Per-worktree | Project | Badge + panel |

## 7. What's NOT Tracked

- No time-series data (no "cost over time" charts)
- No cross-project aggregation
- No session success/failure classification
- No tool call frequency analysis
- No error rate tracking
- No model comparison analytics
- No historical trend analysis
- No data export (CSV/JSON)
