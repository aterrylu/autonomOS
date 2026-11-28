---
"@autonomos/server": minor
---

**Node 20 is no longer supported.** autonomOS now needs Node.js 22.22.2 or newer, the oldest version its signed-release verifier's dependencies support. The installer checks the full version and stops with a message saying what to install. On an older Node, install the current LTS (`brew install node` on a Mac, or see nodejs.org) and run the install again. `autonomos upgrade` and in-app updates don't check this yet, so if you already run autonomOS, check `node --version` and upgrade Node if it's below 22.22.2. Releases are now built and tested on one pinned Node (26), and CI also runs the server's tests on exactly 22.22.2.
