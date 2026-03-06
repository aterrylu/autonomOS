# Zo Computer -- Licensing Analysis

## License Summary

| Component | License | Source |
|-----------|---------|--------|
| **Core platform** | Proprietary (closed-source) | Not publicly available |
| **Skills registry** | MIT | [github.com/zocomputer/skills](https://github.com/zocomputer/skills) |
| **Selectron** (web parser) | MIT | [github.com/zocomputer/selectron](https://github.com/zocomputer/selectron) |
| **Docs** (Substrate) | MIT | [github.com/zocomputer/docs](https://github.com/zocomputer/docs) |
| **zocms** | No license declared | [github.com/zocomputer/zocms](https://github.com/zocomputer/zocms) |
| **Zo** (main repo) | No license declared | [github.com/zocomputer/Zo](https://github.com/zocomputer/Zo) -- README only |
| **zo-web** | No license declared | [github.com/zocomputer/zo-web](https://github.com/zocomputer/zo-web) |

## Key Observations

### 1. Core Platform is Proprietary

Zo Computer's server infrastructure, AI agent system, API backend, and web UI are all closed-source. The main `zocomputer/Zo` repo contains only a README.md with product description -- no source code. The `zo-web` repo (Next.js) has 3 commits and no license, suggesting it's a public placeholder.

**Implication for autonomOS:** We cannot study Zo's internals. Integration is limited to their public API and MCP endpoint. We're a consumer, not a peer.

### 2. Skills Registry is MIT (Valuable)

The `zocomputer/skills` repo is MIT licensed with 60+ skill definitions. This is the most useful open component:

- **Safe to reference**: We can study the SKILL.md format and directory structure
- **Safe to fork**: We could fork skill definitions for our own agent templates
- **Safe to adapt**: The validation tooling (Bun-based) could inform our own plugin system

### 3. Selectron is MIT (Potentially Useful)

`selectron` is an "AI web parser library + CLI" in Python with 48 stars. It could be useful for web content extraction in autonomOS agents, though it's a Python library (autonomOS is TypeScript-focused).

### 4. Several Repos Have No License

`Zo`, `zo-web`, `zocms`, and `zo-space` have no license declarations. Under copyright law, no license means **all rights reserved** -- these cannot be used, copied, or adapted.

## Impact on autonomOS

| Integration Path | License Risk | Assessment |
|-----------------|-------------|------------|
| Use Zo via MCP/API | None | Standard API consumption; no license implications |
| Study SKILL.md format | None | MIT licensed; free to study and adapt |
| Fork skills for templates | None | MIT allows this |
| Copy Zo platform code | N/A | Not available (closed-source) |
| Use Selectron | Low | MIT; but Python, different stack |
| Reference unlicensed repos | Risky | Cannot use without explicit permission |

## Comparison with Other Research Subjects

| Project | License | Can Study Code? | Can Copy Code? | Can Fork? |
|---------|---------|-----------------|----------------|-----------|
| Mission Control | MIT | Yes | Yes | Yes |
| CC-Insights | GPLv3 | Yes | No (copyleft) | Only if GPL |
| YepAnywhere | MIT | Yes | Yes | Yes |
| Zo Computer | Proprietary + MIT (skills) | Skills only | Skills only | Skills only |

## Recommendation

Zo's closed-source nature means it serves as an **integration target** (via API/MCP), not a **reference implementation**. For architectural patterns, continue using YepAnywhere and CC-Insights as primary references. The skills registry is worth studying for its format design but is a small component.
