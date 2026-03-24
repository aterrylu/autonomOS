# Google A2A (Agent2Agent) Protocol Research

**Date:** 2026-03-19
**Status:** Complete — informing inter-agent communication architecture decisions
**Relevance:** HIGH — directly answers whether autonomOS should adopt A2A vs roll its own protocol

---

## Summary Assessment (TL;DR)

A2A is a well-designed, now vendor-neutral (Linux Foundation) open standard for agent-to-agent communication. It is **complementary to MCP, not competing with it**. The ecosystem is real and accelerating (150+ orgs, IBM ACP merged in, gRPC added in v0.3). For autonomOS, A2A is the strongest candidate for the inter-agent communication layer if we want cross-framework interoperability — but adopting it comes with a question: do we need cross-framework interop now, or are we purely Claude Code-native?

**Bottom line:** A2A solves exactly the discovery + task delegation problem autonomOS needs. The protocol is solid. The question is timing and scope — see [autonomos-integration.md](./autonomos-integration.md).

---

## Contents

- [README.md](./README.md) — this file, overview and assessment
- [architecture.md](./architecture.md) — technical architecture: transport, JSON-RPC, task lifecycle, streaming
- [agent-card.md](./agent-card.md) — Agent Card schema, discovery mechanism, signing
- [comparison-mcp.md](./comparison-mcp.md) — A2A vs MCP, when to use which, are they complementary
- [ecosystem.md](./ecosystem.md) — adoption, implementations, governance (Linux Foundation)
- [autonomos-integration.md](./autonomos-integration.md) — integration analysis for autonomOS

---

## What Is A2A?

The **Agent2Agent (A2A) Protocol** is an open standard for communication and interoperability between AI agents — regardless of which framework, vendor, or model backs them. Think of it as HTTP for agents: a common language so a LangChain agent can talk to a CrewAI agent without custom glue.

**Key facts:**
- **Announced:** April 9, 2025 at Google Cloud Next
- **Governance:** Donated to the Linux Foundation in June 2025. Governed independently, not a Google product.
- **License:** Apache 2.0
- **Current version:** v0.3.0 (released July 31, 2025) — gRPC support, signed Agent Cards, extended SDK coverage
- **Ecosystem:** 150+ organizations including AWS, Cisco, Microsoft, Salesforce, SAP, ServiceNow
- **IBM ACP merged in:** IBM's competing Agent Communication Protocol was consolidated into A2A by August 2025 — A2A is now the de facto standard
- **GitHub:** [github.com/a2aproject/A2A](https://github.com/a2aproject/A2A)
- **Spec:** [a2a-protocol.org/latest/specification/](https://a2a-protocol.org/latest/specification/)

---

## Sources

- [Announcing the Agent2Agent Protocol (A2A) — Google Developers Blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [A2A Protocol Getting an Upgrade — Google Cloud Blog](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade/)
- [A2A GitHub Repository](https://github.com/a2aproject/A2A)
- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
- [Core Concepts — A2A Protocol](https://a2a-protocol.org/latest/topics/key-concepts/)
- [Life of a Task — A2A Protocol](https://a2a-protocol.org/latest/topics/life-of-a-task/)
- [MCP vs A2A — Auth0 Blog](https://auth0.com/blog/mcp-vs-a2a/)
- [A2A vs MCP — Logto Blog](https://blog.logto.io/a2a-mcp)
- [A2A Protocol Explained — HuggingFace](https://huggingface.co/blog/1bo/a2a-protocol-explained)
- [What Is A2A Protocol — IBM](https://www.ibm.com/think/topics/agent2agent-protocol)
- [A Security Engineer's Guide to A2A — Semgrep](https://semgrep.dev/blog/2025/a-security-engineers-guide-to-the-a2a-protocol/)
- [A2A v0.3.0 Specification](https://a2a-protocol.org/v0.3.0/specification/)
- [gRPC as Native Transport for A2A — TLDRecap](https://tldrecap.tech/posts/2025/grpconf-india/grpc-agent-mesh/)
