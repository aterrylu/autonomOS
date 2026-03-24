# A2A Agent Card — Schema and Discovery

## What Is an Agent Card?

An **Agent Card** is a JSON metadata document that an A2A Server publishes to advertise its identity, capabilities, skills, endpoint URL, and authentication requirements. It is the discovery and negotiation mechanism that allows client agents to:

1. Find available agents
2. Understand what tasks they can perform
3. Know how to communicate with them (transport, auth)
4. Understand what input/output formats they support

---

## Discovery Location

The canonical discovery path is:

```
GET https://<base_url>/.well-known/agent.json
```

In enterprise or marketplace contexts, Agent Cards are often indexed in a **central registry** that clients can query by skill tags or capabilities.

---

## Full Agent Card Schema

```typescript
interface AgentCard {
  // Identity
  name: string;                    // Human-readable agent name
  description: string;             // What the agent does
  version: string;                 // Semver (e.g., "1.0.0")
  protocolVersion: string;         // A2A spec version (e.g., "0.2.6")

  // Service endpoint
  url: string;                     // HTTPS URL where agent receives requests

  // Optional identity
  provider?: {
    organization: string;
    url: string;
  };
  documentationUrl?: string;       // Link to agent documentation

  // Capabilities (features this agent supports)
  capabilities: {
    streaming?: boolean;           // Supports SSE (message/stream)
    pushNotifications?: boolean;   // Supports webhook push notifications
    stateTransitionHistory?: boolean; // Exposes task state change history
  };

  // Default media types for input/output
  defaultInputModes: string[];     // e.g., ["text", "text/plain"]
  defaultOutputModes: string[];    // e.g., ["text", "text/plain", "image/png"]

  // Skills this agent offers
  skills: AgentSkill[];

  // Authentication requirements
  authentication: {
    schemes: string[];             // e.g., ["Bearer", "ApiKey"]
    credentials?: string;          // For private cards only
  };

  // Transport preferences (v0.3+)
  preferredTransport?: string;     // "jsonrpc" | "grpc" | "rest"
  additionalInterfaces?: string[]; // Other supported transports
}

interface AgentSkill {
  id: string;                      // Unique skill identifier
  name: string;                    // Human-readable skill name
  description: string;             // What this skill does
  tags?: string[];                 // Searchable tags (e.g., ["burger", "ordering"])
  examples?: string[];             // Example prompts/inputs
  inputModes?: string[];           // Override default if different
  outputModes?: string[];          // Override default if different
}
```

---

## Concrete Example — Burger Seller Agent

```json
{
  "capabilities": { "streaming": true },
  "defaultInputModes": ["text", "text/plain"],
  "defaultOutputModes": ["text", "text/plain"],
  "description": "Helps with creating burger orders",
  "name": "burger_seller_agent",
  "protocolVersion": "0.2.6",
  "skills": [
    {
      "description": "Helps with creating burger orders",
      "examples": ["I want to order 2 classic cheeseburgers"],
      "id": "create_burger_order",
      "name": "Burger Order Creation Tool",
      "tags": ["burger order creation"]
    }
  ],
  "url": "https://burger-agent-109790610330.us-central1.run.app",
  "version": "1.0.0"
}
```

---

## Auto-Generation vs Manual

### Auto-generated (via ADK)

Google's Agent Development Kit can auto-generate an Agent Card from your agent code:

```python
from google.adk.a2a import to_a2a

# Converts existing ADK agent to an A2A server
# Auto-generates agent.json based on agent code
app = to_a2a(root_agent)
```

### Manual creation

Create `agent.json` and host it. Any agent (non-ADK) can implement the A2A server interface by:
1. Publishing an Agent Card at `/.well-known/agent.json`
2. Implementing the JSON-RPC methods at the declared `url`

---

## Agent Card Signing (v0.3+)

Agent Cards MAY be digitally signed to ensure authenticity and prevent tampering:

1. **Canonicalize** the Agent Card JSON using JSON Canonicalization Scheme (JCS, RFC 8785)
2. **Sign** the canonical form using JSON Web Signature (JWS, RFC 7515)
3. Clients can verify the signature before trusting the card

This is especially important in registries or marketplaces where cards could be modified in transit.

---

## What Clients Use Agent Cards For

When a client agent discovers an Agent Card, it uses:
- `skills` — embedded into the client agent's system prompt so it knows what the remote agent can do
- `capabilities` — determines whether to use streaming vs polling vs push notifications
- `defaultInputModes` / `defaultOutputModes` — negotiates content types for messages
- `authentication.schemes` — configures the appropriate auth headers
- `url` — the endpoint for all A2A requests
- `preferredTransport` — choose gRPC vs JSON-RPC vs REST
