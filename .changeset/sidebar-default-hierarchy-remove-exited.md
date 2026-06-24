---
"@autonomos/dashboard": minor
---

The agent sidebar now defaults to the hierarchical (org-chart) view instead of the flat list. The default applies to anyone who has never explicitly picked a view via the toggle — including existing installs whose view was auto-saved before this change — not just fresh installs. Once you choose a view with the toggle, your choice sticks across restarts as before.

Also removes the "show stopped agents" eye toggle and the exited-agents list from the sidebar (both flat and hierarchy views). Stopped agents are no longer surfaced in the sidebar; the org-chart panel still lets you remove a stopped agent if needed.
