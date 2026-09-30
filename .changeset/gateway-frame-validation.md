---
"@autonomos/server": patch
---

fix(gateway): one malformed agent message can no longer crash the server

Any agent could stop the whole server, and every agent with it, by sending one badly formed message on the internal gateway socket (for example the JSON value `null`, or a `register` without a session id). The handler read fields off the parsed value without checking it, and the resulting error escaped as an unhandled promise rejection, which exits Node.

- Every gateway message is now checked against a schema before it is used. A bad one is dropped and logged by reason only; the log never repeats its content, because a register message carries the agent's credential.
- A malformed `send` that has a request id gets a failed reply, so the sending agent isn't left waiting out its timeout.
- The message handler can no longer reject, and once the server is up an unhandled promise rejection anywhere is logged instead of exiting the process.
- The Codex control client now ignores a non-object message from the Codex daemon instead of throwing.
