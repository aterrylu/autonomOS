import type { Page, Route, Request } from "@playwright/test";

/**
 * Shared API + WebSocket mocks for the dashboard e2e suite.
 *
 * The dashboard talks to the backend over HTTP (`/api/*`, `/auth`) and over
 * WebSocket (`/ws/terminal/:id`, `/ws/gateway`). NONE of that backend exists in
 * these tests — we intercept every route with canned JSON so the real React app
 * boots, renders, and reacts exactly as it would against a live server, but with
 * deterministic data and zero processes spawned.
 *
 * Response shapes here mirror what the store/components actually consume:
 *   - GET  /api/agents          → Agent[]  (store.fetchSessions)
 *   - GET  /api/agents/tree     → OrgNode[] (HierarchyPanel / Sidebar org chart)
 *   - GET  /api/projects        → ProjectInfo[]
 *   - GET  /api/hooks           → Record<id, {status, unread}> (notifications)
 *   - GET  /api/templates       → Record<name, AgentTemplate>
 *   - GET  /api/providers       → ProviderInfo[] (CreateAgentPanel)
 *   - GET  /api/host            → { hostname }
 *   - GET  /api/settings        → MaskedSettings
 *   - GET  /api/channels/status → { channels: [] }
 *   - GET  /api/schedules       → Record<name, Schedule>
 *   - GET  /api/scheduler/status→ SchedulerStatus
 *   - POST /api/agents          → Agent (create-agent flow)
 *   - PUT  /api/settings        → MaskedSettings (settings toggle)
 */

export interface MockAgent {
  id: string;
  name: string;
  status: "running" | "exited";
  workingDirectory: string;
  provider: string;
  providerSessionId: string;
  template?: string;
  managerId: string | null;
  project?: string;
  createdAt: number;
  updatedAt: number;
  exitedAt?: number;
  exitReason?: "user_killed" | "self_exited" | "crashed";
}

const NOW = 1_700_000_000_000;

export const MOCK_AGENTS: MockAgent[] = [
  {
    id: "agent-dispatcher-0001",
    name: "Dispatcher",
    status: "running",
    workingDirectory: "/Users/dev/autonomOS",
    provider: "claude-code",
    providerSessionId: "agent-dispatcher-0001",
    template: "dispatcher",
    managerId: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
  },
  {
    id: "agent-researcher-0002",
    name: "Researcher",
    status: "running",
    workingDirectory: "/Users/dev/autonomOS",
    provider: "claude-code",
    providerSessionId: "agent-researcher-0002",
    template: "researcher",
    managerId: "agent-dispatcher-0001",
    createdAt: NOW - 50_000,
    updatedAt: NOW - 2_000,
  },
];

/** Org tree derived from the manager relationships above. */
export const MOCK_TREE = [
  {
    claudeSessionId: "agent-dispatcher-0001",
    name: "Dispatcher",
    template: "dispatcher",
    status: "running" as const,
    children: [
      {
        claudeSessionId: "agent-researcher-0002",
        name: "Researcher",
        template: "researcher",
        status: "running" as const,
        children: [],
      },
    ],
  },
];

export const MOCK_TEMPLATES = {
  dispatcher: {
    role: "dispatcher",
    description: "Routes incoming requests and delegates to specialist agents.",
    systemPrompt: "You are the Dispatcher.",
    capabilities: [],
    autonomousMode: true,
    model: "sonnet",
  },
  researcher: {
    role: "researcher",
    description: "Investigates topics and produces written findings.",
    systemPrompt: "You are a Researcher.",
    capabilities: [],
    autonomousMode: true,
    model: "sonnet",
  },
};

const CLAUDE_CAPABILITIES = {
  messaging: { outbound: true, inbound: true },
  hooks: { eventCount: 13, requiresSetup: false },
  systemPrompt: { supported: true },
};

export const MOCK_PROVIDERS = [
  {
    name: "claude-code",
    displayName: "Claude Code",
    installed: true,
    version: "2.1.168",
    recommended: true,
    capabilities: CLAUDE_CAPABILITIES,
  },
  {
    name: "codex",
    displayName: "Codex",
    installed: false,
    version: null,
    recommended: false,
    capabilities: {
      messaging: { outbound: false, inbound: false },
      hooks: { eventCount: 0, requiresSetup: true },
      systemPrompt: { supported: true },
    },
  },
];

export const MOCK_SETTINGS = {
  claudeSessionKey: null,
  channels: [],
  autoTrust: true,
  customEnvVars: {},
  terminalRenderer: "xterm" as const,
  statusLine: { enabled: true },
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export interface MockState {
  /** POST /api/agents bodies captured in call order. */
  createdAgents: Array<Record<string, unknown>>;
  /** PUT /api/settings bodies captured in call order. */
  settingsUpdates: Array<Record<string, unknown>>;
  /** Current settings — mutated by PUT /api/settings so the UI reflects it. */
  settings: typeof MOCK_SETTINGS;
}

/**
 * Install all API route mocks on a page. Returns a mutable `MockState` the test
 * can assert against (e.g. that POST /api/agents was called with the right body).
 *
 * Pass `agents` to override the default agent list (e.g. an empty list to drive
 * the first-run Create-Agent UX).
 */
export async function mockApi(
  page: Page,
  opts: { agents?: MockAgent[] } = {},
): Promise<MockState> {
  const agents = opts.agents ?? MOCK_AGENTS;
  const state: MockState = {
    createdAgents: [],
    settingsUpdates: [],
    settings: structuredClone(MOCK_SETTINGS),
  };

  // Stub the terminal/gateway WebSocket BEFORE any navigation so the app never
  // opens a real socket. The dashboard tolerates a closed/absent WS for the
  // non-terminal flows we exercise here; we simply close it immediately.
  await stubWebSocket(page);

  // Auth: POST /auth (login) succeeds; everything else under /auth → 200.
  await page.route("**/auth", (route) => json(route, { ok: true }));

  // Catch-all for every /api/** request. Ordered by specificity.
  await page.route("**/api/**", async (route: Route, request: Request) => {
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    // ── Mutations ────────────────────────────────────────────────
    if (path === "/api/agents" && method === "POST") {
      const body = (request.postDataJSON?.() ?? {}) as Record<string, unknown>;
      state.createdAgents.push(body);
      const id = `agent-new-${state.createdAgents.length}`;
      return json(route, {
        id,
        name: (body.name as string) ?? "New Agent",
        status: "running",
        workingDirectory: (body.workingDirectory as string) ?? "~",
        provider: (body.provider as string) ?? "claude-code",
        providerSessionId: id,
        template: body.template,
        managerId: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }

    if (path === "/api/settings" && method === "PUT") {
      const body = (request.postDataJSON?.() ?? {}) as Record<string, unknown>;
      state.settingsUpdates.push(body);
      state.settings = { ...state.settings, ...body } as typeof MOCK_SETTINGS;
      return json(route, state.settings);
    }

    // ── Reads ────────────────────────────────────────────────────
    if (path === "/api/agents" && method === "GET") {
      return json(route, agents);
    }
    if (path === "/api/agents/tree") {
      // Only include subtrees whose roots are present in the mocked agent list.
      const liveIds = new Set(agents.map((a) => a.id));
      return json(
        route,
        MOCK_TREE.filter((n) => liveIds.has(n.claudeSessionId)),
      );
    }
    if (path === "/api/settings" && method === "GET") {
      return json(route, state.settings);
    }
    if (path === "/api/channels/status") {
      return json(route, { channels: [] });
    }
    if (path === "/api/templates") {
      return json(route, MOCK_TEMPLATES);
    }
    if (path === "/api/providers") {
      return json(route, MOCK_PROVIDERS);
    }
    if (path === "/api/projects") {
      return json(route, []);
    }
    if (path === "/api/host") {
      return json(route, { hostname: "e2e-mock" });
    }
    if (path === "/api/hooks") {
      // Notification + agent-status map keyed by agent id.
      return json(route, {});
    }
    if (path === "/api/schedules") {
      return json(route, {});
    }
    if (path === "/api/scheduler/status") {
      return json(route, {
        running: 0,
        queued: 0,
        maxConcurrentRuns: 3,
        enabledCount: 0,
      });
    }

    // Anything unmocked: respond benignly (empty 200) so the app never hangs
    // on an unintercepted request. Fast + harmless — never falls through to
    // the vite proxy (which points at a backend that isn't running). Warn so
    // mock drift (a new app endpoint with no mock) surfaces during local dev
    // instead of silently returning {}; suppressed in CI to keep logs clean.
    if (!process.env.CI) {
      console.warn(`[e2e mocks] unmocked ${method} ${path} → empty 200`);
    }
    return json(route, {});
  });

  return state;
}

/**
 * Replace the page's WebSocket with a no-op stub that immediately "closes".
 * The dashboard's terminal hook + gateway open a WS; with no backend there is
 * nothing to connect to. Rather than let it hang/retry, we hand the app a fake
 * socket that reports closed so non-terminal flows proceed cleanly. Live
 * terminal streaming over WS is intentionally NOT exercised here (future work).
 */
async function stubWebSocket(page: Page) {
  await page.addInitScript(() => {
    class FakeWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      url: string;
      readyState = 3; // CLOSED — never pretends to be live
      bufferedAmount = 0;
      extensions = "";
      protocol = "";
      binaryType: BinaryType = "blob";
      onopen: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        // Fire a close on next tick so any onclose/reconnect logic settles
        // without ever establishing a real connection.
        setTimeout(() => {
          const ev = new CloseEvent("close", { code: 1000, wasClean: true });
          this.onclose?.(ev);
          this.dispatchEvent(ev);
        }, 0);
      }
      send() {}
      close() {}
    }
    // @ts-expect-error overriding the global for the test environment
    window.WebSocket = FakeWebSocket;
  });
}
