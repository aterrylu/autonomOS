---
"@autonomos/cli": patch
"@autonomos/server": patch
---

Security: stop putting the auth token in a URL. The post-install connect panel no longer prints (or opens the browser at) a `…/auth?token=<token>` link — that leaked the admin token to shell scrollback, `ps` process args, and browser history, and was non-functional anyway (the dashboard authenticates by pasting the token into its login form, never from the URL). `--open` now opens the dashboard root; the token is shown only on stdout for the user to paste. The server's 401 message was reworded away from the same `?token=` guidance.
