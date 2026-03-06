# CC-Insights -- License Analysis

## License

**GNU General Public License v3.0 (GPLv3)**

Full license text in `/LICENSE` at repository root. No per-file copyright headers -- relies on repo-level license.

## Key Implications for autonomOS

### What GPLv3 Means

GPLv3 is a **strong copyleft** license:

1. **Derivative works must be GPL-licensed.** If you modify CC-Insights or incorporate its code into another program, the entire combined work must be released under GPLv3.

2. **Linking creates a derivative work.** Unlike LGPL, GPLv3 does not have a linking exception. Importing CC-Insights as a library (even as a separate package) would make autonomOS a derivative work.

3. **Network use does NOT trigger distribution.** Unlike AGPL, running GPL software as a server does not require source disclosure to users. However, distributing binaries does.

4. **Patent grant included.** Contributors grant a patent license to recipients.

### Impact on autonomOS

| Action | Allowed? | Notes |
|--------|----------|-------|
| Study CC-Insights source code | Yes | Reading code is not "use" under GPL |
| Learn architectural patterns | Yes | Ideas/patterns are not copyrightable |
| Reimplement patterns in TypeScript | Yes | Clean-room reimplementation from patterns, not copying |
| Copy Dart source files | **NO** | Would make autonomOS GPL |
| Import agent_sdk_core as dependency | **NO** | Linking creates derivative work |
| Fork CC-Insights for autonomOS | **NO** | Unless autonomOS goes GPL |
| Use CC-Insights as a separate tool alongside autonomOS | Yes | No linking, separate programs |
| Port InsightsEvent type definitions | Gray area | Type names are not copyrightable, but identical structure might be |

### Recommended Approach

1. **Study the architecture docs** (this research) -- fully allowed
2. **Reimplement transport pattern** in TypeScript with original type names where appropriate (type names/APIs are functional, not creative expression)
3. **Define event schemas independently** using Zod, informed by but not copying CC-Insights' sealed classes
4. **Never copy Dart source code** into the autonomOS repository
5. **Document the clean-room process** -- this research serves as the specification; TypeScript implementation should be written from these docs, not from the Dart source

### Comparison with Other Researched Projects

| Project | License | Can Import Code? | Can Study Patterns? |
|---------|---------|-----------------|-------------------|
| OpenClaw | MIT | Yes | Yes |
| Mission Control | MIT | Yes | Yes |
| CC-Insights | GPLv3 | **No** | Yes |

### Bottom Line

GPLv3 means CC-Insights is **study-only** for autonomOS. The patterns and architecture are extremely valuable as a reference, but all implementation must be original TypeScript code. This is the primary reason the integration strategy focuses on "reimplement the pattern" rather than "import the library."
