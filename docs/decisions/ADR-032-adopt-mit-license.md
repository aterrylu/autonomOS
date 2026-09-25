## ADR-032: Adopt MIT license
**Date:** 2026-06-09
**Decided by:** Human (Terry) — implemented by License@autonomOS (CC session)
**Source:** Terry's request via CC session, coordinated through TeamLead@autonomOS

**Context:** The repo had no license declaration of any kind — no `LICENSE` file,
the `license` field missing in all six `package.json` manifests, and the README
listing the license as "TBD." Undefined licensing creates friction as the project
moves toward broader distribution (the desktop app in progress, possible public
contributions) and ambiguity for downstream consumers — SBOM scanners, compliance
tooling, and the SLSA provenance pipeline already in flight (ADR-031) all key off a
declared license.

**Decision:** Adopt MIT. A `LICENSE` file at the repo root in canonical OSI/SPDX
form (the canonical "to permit persons" wording — verified byte-for-byte against
the OSI text, not a variant), `Copyright (c) 2026 Terry Lu`, and `"license": "MIT"`
declared in all six `package.json` manifests — including the private root — for
tooling/scanner consistency. README's License section points at the file.

**Rationale:** MIT is the lowest-friction permissive license — minimal
restrictions, broad compatibility, and the form license tooling recognizes out of
the box. Declaring it early, before the contributor base grows, sets a clear
baseline and removes the "TBD" ambiguity.

**Alternatives considered:**
- **Apache-2.0** — its explicit patent grant is defensively valuable, but adds
  NOTICE-file overhead and modest tooling friction; rejected because autonomOS has
  no current patent exposure warranting the complexity.
- **GPL/AGPL** — copyleft would constrain downstream embedding in proprietary
  tooling and runs against the project's personal-tool-first philosophy.
- **Dual-license / source-available** — premature for the current stage.
