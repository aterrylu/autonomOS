# DimOS Licensing & Commercial Use

> Last checked: 2026-03-04

## Summary

| Repo | License | Commercial OK? |
|------|---------|---------------|
| **dimos** | Apache 2.0 | **Yes** |
| **roboclaw** | ⚠️ None | **No** — must contact Dimensional Inc. |
| dimos-viewer | Apache 2.0 (Rerun fork) | Yes |
| Open3D fork | MIT | Yes |
| lcm fork | LGPL-2.1 | Yes, with care |
| PCT_planner fork | Check upstream | Varies |

## dimos — Apache 2.0

The main framework is **Apache 2.0** (Copyright 2025 Dimensional Inc.).

**What you can do:**
- Use in commercial products
- Modify and distribute
- Include in proprietary software
- Sublicense

**Requirements:**
- Include original copyright notice
- Include copy of Apache 2.0 license
- State changes made to original code
- Includes patent grant (protection from contributor patent claims)

**What you can't do:**
- Use Dimensional Inc. trademarks
- Hold them liable

## roboclaw — No License (⚠️ Action Needed)

The OpenClaw plugin has **no license file**. Under copyright law, this means all rights reserved by Dimensional Inc. You cannot legally use, modify, or distribute the code.

**Recommendation:** Open a GitHub issue asking them to add a license. Given dimos is Apache 2.0, this is likely an oversight. But get it in writing before using any code.

**For autonomOS:** The *pattern* (MCP bridge as OpenClaw plugin) is not copyrightable — only the specific code is. We can implement the same architecture independently. The `index.ts` source analysis in [roboclaw-bridge.md](./roboclaw-bridge.md) documents the pattern, not copied code.

## lcm (fork) — LGPL-2.1

If we use LCM for the robot path transport layer:
- **Dynamic linking is fine** — our code stays under our license
- **Static linking triggers copyleft** — must release linked code as LGPL
- **Modifications to LCM itself** must be released under LGPL

Typical usage (dynamic linking via Python bindings) is commercially safe.
