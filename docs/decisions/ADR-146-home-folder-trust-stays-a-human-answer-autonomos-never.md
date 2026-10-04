## ADR-146: Home-folder trust stays a human answer: autonomOS never writes it

- **Date:** 2026-10-03
- **Decided by:** Terry (owner), relayed by TeamLead; recorded by an agent (Onboarding)
- **Context:** ADR-145 found that Claude Code records `hasTrustDialogAccepted: false` for the home folder even after the trust dialog is accepted, so an agent whose working directory is the home folder sees the trust dialog on every start. ADR-145 left one alternative open for Terry: have autonomOS write `hasTrustDialogAccepted: true` for `$HOME` at spawn, which removes the dialog for those agents entirely. Claude Code deliberately does not persist trust for the home folder.
- **Decision:** No. autonomOS never writes `hasTrustDialogAccepted: true` for the home folder. Pre-trust keeps leaving an existing `false` untouched, and the ADR-145 settle-gated watcher keeps answering the dialog on each start.
- **Rationale:** Trusting the home folder lets Claude Code load that folder's own configuration (hooks, MCP servers, commands) without asking, and the home folder is the broadest folder there is. Claude Code chose to ask about it every time; overriding that choice for every home-folder agent would be a security-policy change made silently by autonomOS. The cost of keeping it is small and already paid: the watcher answers the dialog reliably since ADR-145 (0 deaths in 32 real starts), and only agents whose working directory is the home folder see it.
- **Alternatives considered:**
  - Write `true` for `$HOME` at spawn (ADR-145's open alternative). Rejected: see Rationale. Do not re-propose without a new decision from Terry.
  - Write `true` for `$HOME` only when the Auto-Trust setting is on. Rejected for the same reason: Auto-Trust trusts each agent's own folder, and the home folder is a broader scope than the setting's help text promises.
  - Discourage or refuse the home folder as a working directory. Not chosen: it is a legitimate place to run an agent, and the dialog is handled.
- **Source:** TeamLead message relaying Terry's call, 2026-10-04 06:21Z (agent channel); follows ADR-145 / PR #502.
