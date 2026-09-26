---
"@autonomos/server": minor
"@autonomos/dashboard": minor
"@autonomos/cli": minor
---

feat(auth): sign in by opening a link. The installer and `--print-url` now print `http://host:port/#token=…`; opening it logs the browser in and removes the token from the address bar (the token rides in the URL fragment, which is never sent to the server, a proxy or a Referer). A link the server refuses shows "That sign-in link didn't work…" on the login page and never logs out a browser that is already signed in. The session cookie is now named per port, so two instances on one machine no longer sign each other out; existing logins keep working. Deprecated: `?token=` on the public HTTP/WebSocket API still works this release with a one-time warning — use the session cookie or `Authorization: Bearer`. See ADR-117.
