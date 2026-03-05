# Mission Control — Data Model (SQLite Schema)

All data lives in a single SQLite file at `.data/mission-control.db` (WAL mode). Schema is managed via 20 sequential forward-only migrations in `lib/migrations.ts`. Each migration runs in a transaction and is tracked in `schema_migrations`.

## Entity Relationship Overview

```
                     ┌──────────────┐
                     │    users     │
                     │ (auth, RBAC) │
                     └──────┬───────┘
                            │ 1:N
                     ┌──────▼───────┐
                     │user_sessions │
                     │ (7-day exp)  │
                     └──────────────┘

  ┌──────────┐  1:N  ┌──────────┐  N:1  ┌─────────────┐
  │  agents  │◄──────│  tasks   │──────▶│  comments    │
  │          │       │          │       │ (threaded)   │
  └────┬─────┘       └────┬─────┘       └──────────────┘
       │                  │
       │ 1:N              │ 1:N
  ┌────▼──────────┐  ┌────▼──────────────┐
  │direct_connect-│  │task_subscriptions  │
  │  ions (CLI)   │  │ (who follows what) │
  └───────────────┘  └──────────────────-─┘

  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
  │ activities   │   │notifications │   │  messages     │
  │(event stream)│   │(@mentions)   │   │(agent chat)  │
  └──────────────┘   └──────────────┘   └──────────────┘

  ┌──────────────┐   ┌──────────────────┐
  │  webhooks    │──▶│webhook_deliveries │
  │              │   │(history + retry)  │
  └──────────────┘   └──────────────────┘

  ┌──────────────────┐   ┌──────────────┐
  │workflow_templates │   │workflow_pipes│
  │(reusable prompts)│   │+ pipeline_run│
  └──────────────────┘   └──────────────┘

  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
  │   tenants    │──▶│provision_jobs│──▶│provision_evts│
  │(multi-tenant)│   │(with approval)│  │ (audit trail)│
  └──────────────┘   └──────────────┘   └──────────────┘

  ┌──────────────────┐   ┌──────────────┐
  │claude_sessions   │   │ token_usage  │
  │(local CC scan)   │   │(per-session) │
  └──────────────────┘   └──────────────┘
```

## Table Reference

### Core Tables

#### `tasks` — Kanban task management
```sql
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'inbox',
        -- inbox → assigned → in_progress → review → quality_review → done
    priority TEXT NOT NULL DEFAULT 'medium',    -- low, medium, high, urgent
    assigned_to TEXT,                           -- agent name
    created_by TEXT NOT NULL DEFAULT 'system',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    due_date INTEGER,                          -- Unix timestamp
    estimated_hours INTEGER,
    actual_hours INTEGER,
    tags TEXT,                                 -- JSON array
    metadata TEXT                              -- JSON object
);
```
**Indexes:** status, assigned_to, created_at

#### `agents` — Agent registry
```sql
CREATE TABLE agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,                         -- "researcher", "developer", etc.
    session_key TEXT UNIQUE,                   -- Runtime session identifier
    soul_content TEXT,                         -- SOUL.md content
    status TEXT NOT NULL DEFAULT 'offline',    -- offline, idle, busy, error
    last_seen INTEGER,                         -- Unix timestamp
    last_activity TEXT,                        -- Description of last activity
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    config TEXT                                -- JSON (OpenClaw config: model, tools, sandbox)
);
```
**Indexes:** session_key, status

#### `comments` — Threaded task discussion
```sql
CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    parent_id INTEGER REFERENCES comments(id) ON DELETE SET NULL,  -- nested replies
    mentions TEXT                              -- JSON array of @mentioned agents
);
```

#### `activities` — Real-time activity stream
```sql
CREATE TABLE activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,          -- task_created, agent_status_change, etc.
    entity_type TEXT NOT NULL,   -- task, agent, comment
    entity_id INTEGER NOT NULL,
    actor TEXT NOT NULL,
    description TEXT NOT NULL,   -- Human-readable
    data TEXT,                   -- JSON with additional context
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```
**Indexes:** created_at, type, actor, (entity_type, entity_id)

#### `notifications` — @mentions and alerts
```sql
CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT NOT NULL,     -- agent name
    type TEXT NOT NULL,          -- mention, assignment, status_change, due_date, heartbeat
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    source_type TEXT,            -- task, comment, agent
    source_id INTEGER,
    read_at INTEGER,             -- Unix timestamp when read
    delivered_at INTEGER,        -- When delivered to agent
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```
**Indexes:** recipient, created_at, read_at, (recipient, read_at)

### Auth Tables

#### `users`
```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,               -- scrypt hash
    role TEXT NOT NULL DEFAULT 'operator',     -- admin, operator, viewer
    provider TEXT NOT NULL DEFAULT 'local',    -- local, google
    provider_user_id TEXT,
    email TEXT,
    avatar_url TEXT,
    is_approved INTEGER NOT NULL DEFAULT 1,   -- 0 = pending approval
    approved_by TEXT,
    approved_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_login_at INTEGER
);
```

#### `user_sessions`
```sql
CREATE TABLE user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,               -- 32-byte random hex
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,              -- 7 days from creation
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    ip_address TEXT,
    user_agent TEXT
);
```

#### `access_requests` — Google OAuth approval workflow
```sql
CREATE TABLE access_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL DEFAULT 'google',
    email TEXT NOT NULL,
    provider_user_id TEXT,
    display_name TEXT,
    avatar_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending, approved, rejected
    requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
    attempt_count INTEGER NOT NULL DEFAULT 1,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    review_note TEXT,
    approved_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
```

### Chat Tables

#### `messages` — Agent-to-agent chat
```sql
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT,                             -- NULL = broadcast
    content TEXT NOT NULL,
    message_type TEXT DEFAULT 'text',         -- text, system, handoff, status, command
    metadata TEXT,                             -- JSON
    read_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
);
```
**Indexes:** (conversation_id, created_at), (from_agent, to_agent), read_at

### Webhook Tables

#### `webhooks`
```sql
CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT,                               -- HMAC secret for signing
    events TEXT NOT NULL DEFAULT '["*"]',      -- JSON array of subscribed events
    enabled INTEGER NOT NULL DEFAULT 1,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,  -- Circuit breaker counter
    last_fired_at INTEGER,
    last_status INTEGER,                       -- HTTP status code
    created_by TEXT NOT NULL DEFAULT 'system',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

#### `webhook_deliveries`
```sql
CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,                     -- Full JSON body sent
    status_code INTEGER,                       -- HTTP response code
    response_body TEXT,                        -- First 1000 chars of response
    error TEXT,                                -- Error message if failed
    duration_ms INTEGER,
    attempt INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,                     -- Retry queue timestamp
    is_retry INTEGER NOT NULL DEFAULT 0,
    parent_delivery_id INTEGER,                -- Links retries to original
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```
**Indexes:** webhook_id, created_at, next_retry_at (partial, WHERE NOT NULL)

### Workflow & Pipeline Tables

#### `workflow_templates`
```sql
CREATE TABLE workflow_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    model TEXT NOT NULL DEFAULT 'sonnet',
    task_prompt TEXT NOT NULL,
    timeout_seconds INTEGER NOT NULL DEFAULT 300,
    agent_role TEXT,
    tags TEXT,                                 -- JSON array
    created_by TEXT NOT NULL DEFAULT 'system',
    created_at / updated_at / last_used_at / use_count
);
```

#### `workflow_pipelines` + `pipeline_runs`
Multi-step pipelines: a pipeline has ordered steps (referencing templates), and each run tracks current_step + status.

### Integration Tables

#### `direct_connections` — CLI tool connections
```sql
CREATE TABLE direct_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,                   -- "claude-code", "codex", etc.
    tool_version TEXT,
    connection_id TEXT NOT NULL UNIQUE,        -- UUID
    status TEXT NOT NULL DEFAULT 'connected',  -- connected, disconnected
    last_heartbeat INTEGER,
    metadata TEXT,                              -- JSON
    created_at / updated_at
);
```

#### `github_syncs` — GitHub Issues sync history
```sql
CREATE TABLE github_syncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,                        -- "owner/repo" format
    last_synced_at INTEGER,
    issue_count INTEGER NOT NULL DEFAULT 0,
    sync_direction TEXT NOT NULL DEFAULT 'inbound',
    status TEXT NOT NULL DEFAULT 'success',
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### Monitoring Tables

#### `claude_sessions` — Local Claude Code session tracking
```sql
CREATE TABLE claude_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    project_slug TEXT NOT NULL,               -- Directory name under ~/.claude/projects/
    project_path TEXT,                         -- Working directory from transcript
    model TEXT,                                -- e.g., "claude-sonnet-4-6"
    git_branch TEXT,
    user_messages INTEGER NOT NULL DEFAULT 0,
    assistant_messages INTEGER NOT NULL DEFAULT 0,
    tool_uses INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost REAL NOT NULL DEFAULT 0,   -- USD estimate
    first_message_at TEXT,                     -- ISO timestamp
    last_message_at TEXT,
    last_user_prompt TEXT,                     -- First 500 chars
    is_active INTEGER NOT NULL DEFAULT 0,     -- 1 if last msg < 5 min ago
    scanned_at INTEGER NOT NULL,
    created_at / updated_at
);
```
**Indexes:** is_active (partial, WHERE = 1), project_slug

#### `token_usage` — Per-session token tracking
```sql
CREATE TABLE token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    session_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### Admin Tables

#### `audit_log`
```sql
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,        -- login_failed, user_created, auto_backup, etc.
    actor TEXT NOT NULL,
    actor_id INTEGER,
    target_type TEXT,
    target_id INTEGER,
    detail TEXT,                  -- JSON
    ip_address TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

#### `settings` — Key-value app configuration
```sql
CREATE TABLE settings (
    key TEXT PRIMARY KEY,        -- e.g., "general.auto_backup"
    value TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'general',
    updated_by TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

#### `alert_rules` — Configurable alert conditions
```sql
CREATE TABLE alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    entity_type TEXT NOT NULL,           -- agent, task, session, activity
    condition_field TEXT NOT NULL,
    condition_operator TEXT NOT NULL,     -- equals, contains, count_above, age_minutes_above, etc.
    condition_value TEXT NOT NULL,
    action_type TEXT NOT NULL DEFAULT 'notification',
    action_config TEXT NOT NULL DEFAULT '{}',
    cooldown_minutes INTEGER NOT NULL DEFAULT 60,
    last_triggered_at INTEGER,
    trigger_count INTEGER NOT NULL DEFAULT 0,
    created_by / created_at / updated_at
);
```

### Multi-Tenant Tables (Super Admin)

#### `tenants`
```sql
CREATE TABLE tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    linux_user TEXT NOT NULL UNIQUE,
    plan_tier TEXT NOT NULL DEFAULT 'standard',
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, provisioning, active, suspended, error
    openclaw_home TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    gateway_port INTEGER,
    dashboard_port INTEGER,
    config TEXT NOT NULL DEFAULT '{}',
    owner_gateway TEXT,
    created_by / created_at / updated_at
);
```

#### `provision_jobs` + `provision_events`
Job-based provisioning with dry-run support, approval workflow, and step-level event auditing.

### Utility Tables

#### `schema_migrations`
```sql
CREATE TABLE schema_migrations (
    id TEXT PRIMARY KEY,                     -- e.g., "001_init", "020_claude_sessions"
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

#### Other
- `task_subscriptions` — task_id + agent_name (who follows what)
- `standup_reports` — date (PK) + report (JSON)
- `quality_reviews` — task_id + reviewer + status (approved/rejected)

## Schema Design Patterns

1. **All timestamps are Unix epoch integers** — `DEFAULT (unixepoch())`. No datetime strings in the DB.
2. **JSON fields stored as TEXT** — `tags`, `config`, `metadata`, `data`, `events`, `steps`. Parsed in application code.
3. **WAL mode** — Enabled on connection: `PRAGMA journal_mode = WAL`. Allows concurrent reads during writes.
4. **Foreign keys enforced** — `PRAGMA foreign_keys = ON`. With `ON DELETE CASCADE` where appropriate.
5. **Forward-only migrations** — No rollback functions. If a decision is reversed, add a new migration.
6. **Idempotent DDL** — All migrations use `CREATE TABLE IF NOT EXISTS` and check `PRAGMA table_info` before `ALTER TABLE`.
7. **Index-heavy** — ~40 indexes across all tables. Partial indexes for hot paths (e.g., active sessions, retry queue).
