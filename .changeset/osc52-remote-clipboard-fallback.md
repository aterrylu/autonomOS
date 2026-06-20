---
"@autonomos/dashboard": patch
---

Fix OSC 52 auto-copy silently failing on remote-served deployments. Claude Code emits OSC 52 to copy the terminal selection, but the dashboard's handler called `navigator.clipboard.writeText` unconditionally — and `navigator.clipboard` is `undefined` in an insecure context (autonomOS served over plain HTTP from a remote host, as opposed to localhost/HTTPS which browsers treat as secure). The bare property access threw a synchronous `TypeError`, so the copy silently no-op'd even though Claude Code reported "sent N chars via OSC 52". The handler now probes for the Clipboard API and, when it is unavailable or rejects, falls back to a transient off-screen `<textarea>` + `document.execCommand("copy")`, which is not secure-context-gated. A `console.warn` breadcrumb is logged only when both mechanisms fail. Local (localhost/HTTPS) auto-copy is unchanged.
