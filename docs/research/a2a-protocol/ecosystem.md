# A2A Protocol — Ecosystem and Adoption

## Timeline

| Date | Event |
|---|---|
| April 9, 2025 | A2A announced at Google Cloud Next. 50+ launch partners. |
| May 2025 / Google I/O | v0.2 released: stateless interactions, standardized auth schemes |
| June 2025 | Google donates A2A to the Linux Foundation. Vendor-neutral governance. |
| ~August 2025 | IBM's Agent Communication Protocol (ACP) merged into A2A. A2A becomes de facto standard. |
| July 31, 2025 | v0.3.0 released: gRPC support, signed Agent Cards, extended SDK coverage |
| February 2026 | Python SDK at v0.3.24. 150+ organizations in ecosystem. |

---

## Governance

**Linux Foundation** — Same organization that stewards Linux kernel, Kubernetes, PyTorch, and OpenSSF. This is meaningful governance:
- No single vendor controls the roadmap
- Enterprises can build on it without betting on Google's continued commitment
- Apache 2.0 license — permissive, no patent traps

The Linux Foundation governance directly addresses the primary risk of protocol vendor lock-in.

---

## SDK Support

Official SDKs (as of v0.3.x):
- **Python** — primary, most complete (v0.3.24+)
- **JavaScript/TypeScript** — available
- **Java** — available (see Quarkus A2A Java SDK 0.3.0-alpha)
- **Go** — available
- **.NET** — available

Third-party: adapters for LangChain, LlamaIndex, Semantic Kernel, Marvin, Agno, Mastra, LangGraph, CrewAI.

---

## Enterprise Adoption

**Launch partners (50+, April 2025):**
Atlassian, Salesforce, SAP, MongoDB, Cohere, Deloitte, KPMG, McKinsey, and others.

**Since then (150+ orgs):**
- **AWS** — integrated
- **Microsoft** — A2A support in Azure AI Foundry and Copilot Studio
- **SAP** — wired A2A into Joule (AI assistant)
- **Cisco, ServiceNow** — integrated

---

## Framework Integrations

| Framework | A2A Support | Notes |
|---|---|---|
| Google ADK (Gemini) | Native | `to_a2a()` auto-generates Agent Card |
| LangChain / LangGraph | Adapter | Official adapter in a2aproject/A2A repo |
| LlamaIndex | Adapter | Official adapter |
| CrewAI | Supported | One of the earliest adopters |
| Semantic Kernel | Adapter | Merging into Microsoft Agent Framework (GA Q1 2026) |
| AutoGen / MS Agent | Supported | |
| Mastra | Supported | |
| Agno | Supported | |

A2A does not require any specific framework — any HTTP server that implements the JSON-RPC interface and publishes an Agent Card is a valid A2A agent.

---

## Samples Repository

[github.com/a2aproject/a2a-samples](https://github.com/a2aproject/a2a-samples) — official examples including:
- Currency converter agent (Python)
- GitHub agent (Python)
- Purchasing concierge + remote seller (Google Codelabs walkthrough)
- Multi-agent RAG systems (LangChain + Oracle)

---

## Awesome-A2A

Community-maintained index of A2A agents, tools, servers, and clients:
[github.com/ai-boost/awesome-a2a](https://github.com/ai-boost/awesome-a2a)

---

## Assessment: Is A2A Here to Stay?

**Yes, with high confidence.** Evidence:
1. Linux Foundation governance removes the "Google could abandon it" risk
2. IBM ACP merger eliminated fragmentation — there's now one winner in agent-to-agent protocols
3. 150+ orgs including all major hyperscalers
4. Google embedding it in ADK means the primary Gemini agent framework ships A2A natively
5. Microsoft adding it to Azure AI Foundry gives it enterprise credibility beyond Google's stack
6. The IBM merger happened quickly (within 4 months of launch) — that speed suggests real industry pressure to standardize

The main risk is whether "cross-framework agent interop" becomes a real production need or stays academic. As of early 2026, most multi-agent systems are still single-framework. But the trajectory is toward heterogeneous systems.
