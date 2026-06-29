---
"@autonomos/cli": minor
---

Revamp the first-run install UX. After `install-service` activates the daemon (so also via `curl install.sh` and `make prod`), it now polls until the server is actually responsive — a real smoke test, not a "should be running shortly" guess — then prints a connect panel with the dashboard URL (read from the daemon's actual bound port), the auth token, and a click-to-auth link. A new `--open` flag opens the dashboard in a browser, no-opping on headless servers and in CI; `install.sh` passes it on an interactive terminal (opt out with `AUTONOMOS_NO_OPEN=1`).
