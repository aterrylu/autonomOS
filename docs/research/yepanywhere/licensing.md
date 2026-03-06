# YepAnywhere License Analysis

## License: MIT

The project is MIT licensed, declared in `README.md`:

> 100% open source (MIT).

And in a `## License` section at the bottom of the README:

> MIT

**Note:** There is no standalone `LICENSE` or `LICENSE.txt` file in the repo root, and no `"license"` field in `package.json`. The license is declared only in the README. This is slightly informal but legally sufficient — MIT license text in a README constitutes a valid grant.

## Published to npm

The package is published to npm as `yepanywhere`:
- OIDC trusted publishing via GitHub Actions (no npm tokens)
- Supply chain attestation (`--provenance`)
- All internal packages (`@yep-anywhere/*`) are marked `private: true` and NOT published
- Only the bundled server+client is published as a single `yepanywhere` CLI package

## Impact on autonomOS

### What We CAN Do (MIT Grants Full Rights)
- Copy and modify source code
- Use as a dependency or library
- Fork the repository
- Create derivative works
- Redistribute (with MIT notice)
- Use commercially

### Key Dependency: Claude Agent SDK (Proprietary)

The `@anthropic-ai/claude-agent-sdk` (v0.2.56) is **proprietary**:
> "Copyright Anthropic PBC. All rights reserved"
> Usage subject to Anthropic's legal agreements

This is a runtime dependency, not part of YepAnywhere's code. It's required for Claude Code session management. Any project using the Claude Agent SDK (including autonomOS) must comply with Anthropic's terms independently.

### All Other Dependencies Are Permissive

| Dependency | License | Use |
|-----------|---------|-----|
| @anthropic-ai/claude-agent-sdk | Proprietary (Anthropic) | Claude Code SDK |
| hono | MIT | HTTP framework |
| react | MIT | UI framework |
| tweetnacl | Unlicense | NaCl encryption |
| tssrp6a | Apache-2.0 | SRP authentication |
| web-push | MIT | Push notifications |
| pino | MIT | Logging |
| zod | MIT | Schema validation |
| shiki | MIT | Syntax highlighting |
| diff | MIT | Diff generation |
| better-sqlite3 | MIT | Relay server DB |
| @biomejs/biome | MIT | Linter |
| typescript | Apache-2.0 | Type checking |

No copyleft (GPL/LGPL/AGPL) dependencies detected in the production dependency tree.

## Recommendation

**MIT license is fully compatible with autonomOS.** We can:

1. **Use patterns directly** — Copy architectural patterns with attribution
2. **Import as dependency** — Though not designed as a library (all packages are private)
3. **Fork and adapt** — Extract specific modules (e.g., session discovery, provider interface)
4. **Reimplement independently** — Using the codebase as reference

The only constraint is the proprietary Claude Agent SDK, which we'd need to use regardless of YepAnywhere.
