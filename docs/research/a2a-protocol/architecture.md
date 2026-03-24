# A2A Protocol — Technical Architecture

## Overview

A2A follows a **client-server architecture** where:
- **A2A Client** = an agent (or orchestrator) that wants to delegate work
- **A2A Server** = a remote agent that exposes capabilities and executes tasks

The client discovers available servers via Agent Cards, then communicates via JSON-RPC 2.0 over HTTPS.

```
A2A Client                        A2A Server
    |                                  |
    |  GET /.well-known/agent.json     |
    |--------------------------------->|   1. Discovery
    |<---------------------------------|
    |       AgentCard JSON             |
    |                                  |
    |  POST /  (message/send)          |
    |--------------------------------->|   2. Task Initiation
    |<---------------------------------|
    |       Task (status: working)     |
    |                                  |
    |  GET / (tasks/get) [polling]     |
    |--------------------------------->|   3. Polling OR
    |<---------------------------------|
    |  SSE stream (message/stream)     |   3. Streaming
    |<~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~|
    |       TaskStatusUpdateEvents     |
    |       TaskArtifactUpdateEvents   |
    |                                  |
    |  HTTP POST to webhook            |   3. Push (async)
    |<---------------------------------|
    |       Push notification          |
```

---

## Transport Layer

### Primary Transport: HTTPS + JSON-RPC 2.0

All A2A communication uses:
- **Transport:** HTTPS (TLS required)
- **Encoding:** JSON-RPC 2.0
- **Endpoint:** Agent's `url` field from Agent Card (single endpoint)
- **Method pattern:** `{category}/{action}` (e.g., `message/send`, `tasks/get`)

### Optional: gRPC (added in v0.3.0)

From v0.3.0, agents MAY support gRPC:
- **Proto file:** `specification/grpc/a2a.proto` (normative definition)
- **Serialization:** Protocol Buffers v3
- **Service:** `A2AService` gRPC service
- **Security:** TLS required (gRPC over HTTP/2 with TLS)
- **Streaming:** Server streaming RPCs for streaming operations
- **When multiple transports:** Must be functionally identical; agent declares all in Agent Card via `preferredTransport` and `additionalInterfaces`

### Optional: REST (HTTP+JSON)

A third binding provides RESTful URLs, e.g. `POST /v1/message:send`.

---

## JSON-RPC Methods

| Method | Description |
|---|---|
| `message/send` | Initiate or continue a task (synchronous or polling) |
| `message/stream` | Initiate and receive streaming SSE updates |
| `tasks/get` | Poll for current task state |
| `tasks/cancel` | Cancel an in-progress task |
| `tasks/resubscribe` | Reattach to an ongoing task's event stream |
| `tasks/pushNotificationConfig/set` | Configure webhook for push notifications |
| `tasks/pushNotificationConfig/get` | Get push notification config |
| `tasks/pushNotificationConfig/list` | List push notification configs |
| `tasks/pushNotificationConfig/delete` | Remove push notification config |

### Error Codes

| Error | Code |
|---|---|
| `JSONParseError` | -32700 |
| `InvalidRequestError` | -32600 |
| `MethodNotFoundError` | -32601 |
| `InvalidParamsError` | -32602 |
| `InternalError` | -32603 |

---

## Task Lifecycle

Tasks are the fundamental unit of work. Each has a unique ID and progresses through defined states.

### State Machine

```
                    ┌─────────────┐
     message/send ──▶  submitted  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   working   │◀──────────────────────┐
                    └──────┬──────┘                       │
                           │                              │
            ┌──────────────┼──────────────┐               │
            │              │              │               │
     ┌──────▼──────┐ ┌─────▼──────┐      │          (resumes)
     │input-required│ │auth-required│      │               │
     └──────┬──────┘ └─────┬──────┘      │               │
            │              │              │               │
            └──────────────┘              │               │
                    │                     │               │
              (client responds            │               │
               with new message)──────────┘               │
                                          │               │
                              ┌───────────┼───────────┐   │
                              │           │           │   │
                       ┌──────▼──┐  ┌────▼────┐  ┌───▼───▼───┐
                       │completed│  │ failed  │  │ canceled  │
                       └─────────┘  └─────────┘  └───────────┘
                                                  ┌───────────┐
                                                  │ rejected  │
                                                  └───────────┘
```

### States

| State | Terminal? | Description |
|---|---|---|
| `submitted` | No | Task received and queued |
| `working` | No | Actively being processed |
| `input-required` | No | Agent needs more information from client |
| `auth-required` | No | Authentication needed to proceed |
| `completed` | Yes | Finished successfully |
| `failed` | Yes | Encountered an error |
| `canceled` | Yes | Client canceled the task |
| `rejected` | Yes | Agent rejected the task |
| `unknown` | No | State cannot be determined |

Once a task reaches a terminal state, it cannot be restarted. Any follow-up interaction must create a new task within the same `contextId`.

---

## Task Object Structure

```typescript
interface Task {
  id: string;              // UUID, server-generated
  contextId?: string;      // Groups related tasks (conversation/session grouping)
  status: TaskStatus;      // { state, message? }
  history?: Message[];     // Previous messages in the task
  artifacts?: Artifact[];  // Outputs produced during execution
  metadata?: Record<string, any>;  // Custom key-value storage
}

interface TaskStatus {
  state: TaskState;        // One of the states above
  message?: Message;       // Optional status message
  timestamp?: string;      // ISO 8601 timestamp
}
```

---

## Message and Part Structure

**Messages** are the unit of communication (one "turn"). They have a `role` (agent or user) and contain one or more `Part` objects.

```typescript
interface Message {
  role: "agent" | "user";
  parts: Part[];
  messageId?: string;
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, any>;
}

// Three part types:
type Part = TextPart | FilePart | DataPart;

interface TextPart {
  type: "text";
  text: string;
}

interface FilePart {
  type: "file";
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string;  // base64-encoded inline content
    uri?: string;    // URL reference
  };
}

interface DataPart {
  type: "data";
  data: Record<string, any>;  // Structured JSON
}
```

---

## Artifact Structure

**Artifacts** are the tangible outputs produced by task execution (documents, images, structured data, etc.).

```typescript
interface Artifact {
  artifactId: string;
  parts: Part[];          // Same Part types as Messages
  name?: string;
  description?: string;
  metadata?: Record<string, any>;
}
```

Artifacts can be streamed incrementally via `TaskArtifactUpdateEvent`.

---

## Streaming (SSE)

When using `message/stream`, the server sends Server-Sent Events. Event types:

| Event Type | Description |
|---|---|
| `Task` | Full task object update |
| `Message` | New message from agent |
| `TaskStatusUpdateEvent` | State change notification |
| `TaskArtifactUpdateEvent` | New or updated artifact (supports incremental chunks) |

---

## Push Notifications (Webhooks)

For long-running tasks or disconnected clients:

1. Client calls `tasks/pushNotificationConfig/set` with a webhook URL
2. Server stores the config (must persist until task completion or explicit deletion)
3. On state changes, server sends `HTTP POST` to the webhook URL with `StreamResponse` payload
4. Config must be explicitly deleted or auto-expires at task completion

### Webhook Security

Server authenticates itself to the webhook using JWT:
- Server generates JWT signed with its private key
- JWT claims: `iss` (issuer), `aud` (webhook URL), `iat`, `exp`, `jti`, `taskId`
- Server publishes public keys at a JWKS endpoint
- Client's webhook verifies JWT signature via JWKS

**Event delivery guarantee:** All implementations MUST deliver events in the order they were generated.

---

## contextId — Session Grouping

`contextId` is a server-generated identifier that logically groups multiple related `Task` objects — the equivalent of a "conversation" or "session" spanning multiple task requests. Clients can pass an existing `contextId` when initiating a new task to continue a logical thread.

V0.2+ also supports **stateless interactions** — no contextId required — for simpler scenarios where session continuity is not needed.

---

## Security

Authentication is declared in the Agent Card and credentials are passed via HTTP headers (separate from A2A protocol messages). Supported schemes align with OpenAPI:

- **Bearer** — OAuth 2.0 tokens
- **ApiKey** — API keys
- **Basic** — Basic authentication
- **OpenID Connect Discovery** — OIDC

From v0.3.0, Agent Cards may be digitally signed using **JSON Web Signature (JWS)** per RFC 7515, with **JSON Canonicalization Scheme (JCS)** per RFC 8785 applied before signing.
