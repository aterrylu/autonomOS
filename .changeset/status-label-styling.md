---
"@autonomos/dashboard": patch
---

Sidebar status labels now carry muted-accent colors, and actively-working agents shimmer. The bottom-line status label is colored by status — active work (working / tool_running / compacting / orchestrating) shimmers in a slate-blue sweep so a busy agent reads at a glance, ready/idle are muted sage, needs-input is amber, error is muted red, and stopped/unknown stay gray. Labels only — the status dots keep their existing colors. The shimmer runs on active-work rows only and falls back to a static color under `prefers-reduced-motion`; it coexists with the recency timestamp fade (status colors the label, recency fades the age).
