# Server Lifecycle: Replacing pm2 + Revamping Install UX (Research Report)

> ServerLifecycle@autonomOS · 2026-06-28 · propose-pause report
> Branch: `terry/server-lifecycle`

## TL;DR

**The pm2 replacement already exists and shipped in PR #170.** `autonomos install-service`
writes an OS-native supervisor — a **launchd LaunchAgent** (macOS) or a **systemd-user
unit** (Linux) — with crash-restart, boot-on-login/linger, a pid-file mutual-exclusion
lock (ADR-029), and a one-shot `migrate-from-pm2` path. This is the mainstream, reliable,
zero-extra-dependency, cross-platform answer Terry asked for.

**pm2 is now legacy debt, not the active mechanism.** It survives only in the
*operator/developer surface* — `ecosystem.config.cjs`, the `Makefile`, and the remote
`make deploy` SSH path. Terry's own deploy flow (`make deploy → make prod → pm2`) never
adopted the new supervisor, which is exactly why *he* still feels pm2 pain while external
users (via `install.sh`) already don't.

**So this initiative is not "pick a new tool." It is: finish the pm2 → launchd/systemd
cutover #170 started, and close the Tier-1 install-UX gaps.**

---

## 1. Current state — what #170 shipped vs where pm2 still lives

### Already built (the replacement)

| Piece | Location | What it does |
|---|---|---|
| CLI dispatcher | `packages/cli/src/index.ts` | `start`, `stop`, `status`, `install-service`, `uninstall-service`, `upgrade`, `migrate-from-pm2` |
| launchd template | `packages/cli/src/lib/service-templates.ts` | `~/Library/LaunchAgents/com.autonomos.daemon.plist` — `RunAtLoad=true`, `KeepAlive=true` |
| systemd template | same file | `~/.config/systemd/user/autonomos.service` — `Restart=always`, `RestartSec=5`, `enable-linger` |
| install-service | `packages/cli/src/commands/install-service.ts` | writes + activates the unit; refuses if a server/pm2/Desktop already owns the config dir |
| pm2 migration | `commands/migrate-from-pm2.ts` + `lib/pm2.ts` | detects pm2-managed autonomos, stops+deregisters, re-installs as native service, preserves PORT |
| pid-file lock | `packages/server/src/pid-file.ts` | `~/.autonomos/autonomos.pid` + `.lock`; `acquireOwnership()` mutual exclusion (ADR-029) |
| web installer | `scripts/install.sh` | platform detect → download tarball → checksum → wrapper → `install-service` (or migrate) |
| Desktop coexistence | `packages/app/src/main/server-supervisor.ts`, `migrate.ts` | embedded Built-in server + in-app toggle to install-service (ADR-029) |

Logs go to `~/.autonomos/logs/autonomos.log` + `autonomos.error.log` (append mode, **no rotation**).

### Where pm2 still lives (the work)

| File / recipe | Current | Becomes |
|---|---|---|
| `ecosystem.config.cjs` | pm2 app config for `:3100` | **Deleted** (after Makefile migration) |
| `Makefile` `make prod` | installs pm2, `pm2 start ecosystem.config.cjs; pm2 save` | builds + supervises via chosen native path (see §4 decision) |
| `Makefile` `make deploy` | rsync + `bun add -g pm2` on remote + `make prod` | rsync + native install-service on remote (no pm2 install) |
| `Makefile` `make logs` | `pm2 logs autonomos --lines 50` | new `autonomos logs` (tail of `~/.autonomos/logs/`) |
| `Makefile` `make stop` / `down` / `restart` | `pm2 stop/delete` | `autonomos stop` / `uninstall-service` / `restart` |
| remote deploy SSH | `command -v pm2 || bun add -g pm2` | dropped |
| `providers/shared.ts:63,100` | comments referencing `ecosystem.config.cjs` PATH sync | updated to reference the unit's `Environment=PATH` |
| `README.md` (≈6 lines) | "PM2 daemon on :3100" | native-supervisor quickstart |

**Intentionally kept:** `lib/pm2.ts` + `migrate-from-pm2.ts` (migration helpers — existing
forge/pm2 users still need them) and the pm2-detection branch in `install.sh`.

### Missing CLI commands (Tier-1 gaps)

The dispatcher has **no `logs` and no `restart`** — pm2 had `pm2 logs` / `pm2 restart`.
`make logs`/`make restart` therefore still call pm2. Both need first-class CLI equivalents.

---

## 2. Candidate matrix

Even though the answer is "double down on #170," here is the comparison that justifies
*why* launchd/systemd over the alternatives — for the ADR record.

| Candidate | macOS + Linux | Auto-restart | Boot persistence | Logs / inspect | Install UX | Update path | Desktop coexist | pm2-migration cost | Less painful than pm2? |
|---|---|---|---|---|---|---|---|---|---|
| **launchd + systemd-user** (★ #170 path) | ✅ native both | ✅ KeepAlive / Restart=always | ✅ RunAtLoad / enable-linger | file logs; `autonomos logs` (to add) | one cmd, no sudo, no dep | `autonomos upgrade` atomic swap | ✅ pid-lock mutual-excl (ADR-029) | already written | **Yes** — zero runtime dep, OS-blessed, no node-version foot-guns |
| **pm2** (status quo) | ⚠️ works but heavy | ✅ | ⚠️ `pm2 startup` (sudo, fragile) | `pm2 logs` (nice) | needs `bun add -g pm2` | manual | ❌ competes for `:3100`/state | n/a | — (this is the pain) |
| **npx-foreground / daemonless** | ✅ | ❌ (user's babysitter) | ❌ none | stdout only | trivial | `npx` re-resolves | ✅ (it's just `start`) | n/a | partial — great on-ramp, no persistence |
| **Foreman / Overmind** | ✅ | ⚠️ restarts group, not boot | ❌ no boot integration | aggregated stdout | extra dep (ruby/go) | manual | ❌ another supervisor | rewrite | No — adds a dep, still not boot-persistent |
| **Docker / compose** | ✅ | ✅ restart policy | ✅ via daemon | `docker logs` | heavy (Docker install) | pull image | ❌ PTY/agent-spawn friction in container | full re-arch | No — too heavy for a personal-first tool that spawns host PTYs |
| **Custom Go/Rust daemon** | ✅ | ✅ | build it | build it | build a whole supervisor | build it | build it | build it | No — reinvents launchd/systemd |

**node-pty / `bun --compile` note:** the static-binary path is blocked (Bun ABI vs node-pty
prebuilt — `project_nodepty_bun_compile.md`), so all candidates ship as a Node-runtime JS
bundle requiring node ≥20. This is orthogonal to supervisor choice but constrains the
"single static binary" dream.

---

## 3. Recommendations

### Primary — finish the launchd/systemd-user cutover (double down on #170)

Rip pm2 out of the operator surface and route everything through the native supervisor that
already exists. launchd is Apple's init system; systemd is the Linux standard — both are
battle-tested, dependency-free, survive reboot, and restart on crash. The replacement code
is written and unit-tested (`pid-file.test.ts`, 20+ cases). Remaining work is wiring +
polish, not invention.

### Secondary / complementary — keep daemonless foreground as the on-ramp (picks up Tier-1)

`autonomos start` (the implicit default) already *is* the npx-foreground, babysitter-free
path — good for "just trying it" and for `make dev`. We don't need a second mechanism; we
just document foreground vs `install-service` (persistent) as the two tiers. **This is the
PM2→npx migration that Tier-1 deferred — we're picking it up here, not reinventing it.**

### Desktop coexistence (answering TeamLead's anchor #2)

Already designed (ADR-029), nothing to force-pick:

- **Electron-app user** → gets the **embedded Built-in server** by default (zero friction,
  open-app-it-works). A Settings toggle *"Keep autonomOS running in the background"* invokes
  `install-service` to hand off to launchd/systemd for always-on.
- **`curl install.sh` user** → gets the **launchd/systemd daemon** directly.
- Both share `~/.autonomos/`; the **pid-file lock guarantees only one owner at a time**, so
  the two paths coexist without the PR #172 PTY-corruption race.

---

## 4. The one real design decision (`make prod` / `make deploy`)

`make prod` runs the server **from live source** via `tsx packages/server/src/index.ts`.
`install-service` supervises the **installed bundle** (`autonomos start`). Migrating the
Makefile forces a choice about what the supervised unit points at:

| Option | `make prod` does | Pros | Cons |
|---|---|---|---|
| **A — build + install-service** | build bundle, then `install-service --bin <bundle>` | one code path, identical to real installs | slower (full bundle build each prod); deploy-from-source loses live tsx |
| **B — source-pointing unit** ★ | generate launchd/systemd unit whose ExecStart = repo `tsx src/index.ts` (reuse templates via `--bin`) | keeps the rsync-deploy-from-source model Terry uses on forge; fast | a second "dev/source" supervisor variant to maintain |
| **C — foreground only** | `make prod` just runs foreground; operator runs `install-service` separately for persistence | simplest | changes deploy semantics (no auto-restart from `make`); easy to forget persistence |

**My recommendation: B.** Terry's forge deploy is rsync-from-source (no bundle on the box),
so a source-pointing unit fits the existing model with the least disruption and keeps the
fast live-source loop. `install-service` already supports `--bin`, so this is mostly a
templating tweak + a `make prod`-friendly wrapper.

---

## 5. Install-UX critique (Tier-1 gaps)

Today: `curl -fsSL install.sh | bash && autonomos status`.

| Gap | Today | Proposed |
|---|---|---|
| **No smoke test** | install-service prints *"daemon should be running shortly"* but never verifies the port responds | poll `/api/host` for ~5s; print ✓/✗ with the actual URL |
| **No URL/token surfaced** | install.sh ends "Run: autonomos status" | print `http://localhost:PORT` + token (the `--print-url` flag in `run.ts` already exists, unused by install.sh) |
| **No auto-open** | nothing opens | optional `open`/`xdg-open` the dashboard on first install (behind a flag/prompt) |
| **Manual PATH** | prints "add this to your rc file" | offer to append the PATH line (with confirm), or detect shell rc |
| **No `autonomos logs`** | `make logs` → pm2 | add `autonomos logs [-f]` tailing `~/.autonomos/logs/` |
| **No `autonomos restart`** | `make restart` → pm2 prod | add `autonomos restart` (stop + start via the supervisor) |
| **No log rotation** | launchd/systemd append forever | size-based rotation (keep newest N) or truncate-on-restart — Terry to pick (§7) |

---

## 6. Proposed PR breakdown (stacked — TeamLead leans stacked)

```
PR 1  terry/server-lifecycle           (lifecycle swap)
      • Makefile: prod/deploy/logs/stop/down/restart off pm2 → native (Option B)
      • delete ecosystem.config.cjs; drop pm2 install from deploy SSH
      • add `autonomos logs` + `autonomos restart` CLI commands
      • update providers/shared.ts comments + README quickstart
      • ADR: "pm2 → launchd/systemd-user operator cutover"

PR 2  terry/server-install-ux  (--base terry/server-lifecycle)   (Tier-1 UX)
      • install-service post-install smoke test (poll /api/host)
      • install.sh: print URL+token via --print-url, optional auto-open, PATH offer
      • log rotation
      • ADR: "first-run install UX (smoke test + surfaced URL)"

PR 3 (optional, may fold into PR1)   (migration + docs hardening)
      • migrate-from-pm2 coverage for the dev/deploy-from-source case
      • forge cutover runbook; RESEARCH.md update
```

Could compress to **2 PRs** (fold migration polish into PR1). I lean **2 stacked**: lifecycle
swap, then install-UX. Terry to confirm 2 vs 3.

---

## 7. Open questions for Terry

1. **`make prod`/`deploy` supervisor target** — Option **A** (build bundle + install-service),
   **B** (source-pointing unit ★ my rec), or **C** (foreground + manual install-service)?
2. **Hard cutover on forge** — your live forge server is pm2-managed on `:3100`. The deploy
   migration must run `migrate-from-pm2` on forge (hard cutover, preserves PORT). OK to make
   `make deploy` perform that automatically the first time, or do you want a manual one-shot?
3. **Log rotation** — in-code size-based (keep newest N), rely on `newsyslog`/`logrotate`, or
   truncate-on-restart? (pm2 had a logrotate module; native units have none.)
4. **`autonomos logs` shape** — simple `tail -f ~/.autonomos/logs/autonomos.log` wrapper, or
   merged stdout+stderr with `-f`/`--lines` flags like `pm2 logs`?
5. **PR count** — 2 stacked or 3?
6. **Delete `ecosystem.config.cjs` outright**, or keep a deprecation window? (Deleting the file
   doesn't stop a *running* pm2 process — that's what the forge migration in Q2 handles.)

---

## 8. Market norms — vending vs dev (heavy investigation, 2026-06-28)

Investigated 10 tools across two cohorts. (Popularity/star figures from web search were
unreliable and are excluded; only *mechanism* findings — read from repo files / official
docs — are recorded.)

### Cohort A — agent tools (the named asks)

| Tool | What it is | VENDING | DEV |
|---|---|---|---|
| **CMUX** (coder/"Mux", manaflow, craigsc) | desktop terminal multiplexer for AI agents | signed DMG/AppImage or `brew install --cask`; **foreground GUI, no daemon**; self-update via electron-updater / Sparkle | `"dev":"make dev"` → bun + Vite + tsgo HMR watch tree (coder); Xcode (manaflow) |
| **OpenClaw** (openclaw/openclaw) | local-first personal-assistant gateway | `npm i -g openclaw` → `openclaw onboard --install-daemon` → **launchd / systemd-user**; OR Docker `restart: unless-stopped` | `gateway:dev` / `gateway:watch` (tmux hot-reload) from source, `OPENCLAW_SKIP_CHANNELS=1`, no installed daemon |
| **Hermes Agent** (NousResearch/hermes-agent) | self-improving agent + messaging gateway | `curl … install.sh \| bash` → self-contained `~/.hermes`; `hermes gateway install` → **systemd-user / launchd**; OR brew formula; OR Docker + s6-overlay | same checkout, `uv pip install -e ".[all,dev]"` (editable), foreground `hermes gateway` |

### Cohort B — gold-standard daemon-shipping OSS (the supervision reference)

| Tool | VENDING supervisor | DEV | Boot-persist on install |
|---|---|---|---|
| **Tailscale** | systemd `tailscaled.service` (linux) / launchd (mac); ships `tailscaled install-system-daemon` bridge | `sudo tailscaled` foreground / `go run` | AUTO (install.sh enables) |
| **Ollama** | systemd `ollama.service` as dedicated `ollama` user / .app or brew-launchd (mac) / Docker | `go run . serve` foreground | AUTO |
| **Caddy** | ships `caddy.service` systemd unit, dedicated `caddy` user / brew | `caddy run` foreground (same cmd the unit runs) | AUTO on apt, manual on dnf |
| **code-server** | templated **system** unit `code-server@$USER` / brew services | `npm run watch` from source | MANUAL (prints the enable cmd) |
| **Supabase CLI** | (product is cloud SaaS) | `supabase start` → full Docker compose stack | n/a |
| **Syncthing** | ships BOTH `syncthing@.service` (system) AND `systemd --user` unit AND launchd plist | `go run build.go` foreground | MANUAL |
| **n8n** | Docker / docker-compose officially (npm global is "local testing only") | `pnpm dev` monorepo | n/a (Docker) |

### The norm (unanimous across all 10)

1. **Vending = a prebuilt/packaged artifact whose lifecycle is owned by the OS-native init
   system** — systemd on Linux, launchd on macOS (often via `brew services`) — or a
   `restart: unless-stopped` **Docker** container. **Not a single tool uses pm2/forever.**
   pm2 appears only in third-party community blog posts, never official docs.
2. **Dev = run from source, in the FOREGROUND, with no installed service** — the developer's
   own shell is the supervisor (`go run … serve`, `caddy run`, `pnpm dev`, `gateway:watch`).
3. **The two paths share ONE primitive: a foreground `serve`/`gateway`/`run` command.** The
   vending path merely *wraps that exact command* in an init unit. Caddy is the cleanest
   example — the systemd unit's `ExecStart` is literally `caddy run`, the same command devs
   type. Several tools ship an explicit **dev→vending bridge** (`tailscaled
   install-system-daemon`, `openclaw onboard --install-daemon`, `hermes gateway install`).
4. **There is no third "operator/prod" path in the norm.** It's either dev-foreground or
   vended-init. A separate process-manager recipe (our `make prod` → pm2) is an artifact of
   the pre-init era, not something the market maintains.

### autonomOS mapped onto the norm

| Concern | Market norm | autonomOS today | Verdict |
|---|---|---|---|
| Vending supervisor (mac) | launchd | launchd via `install-service` | ✅ on-norm |
| Vending supervisor (linux) | systemd (system + service-user common; user-scope secondary) | systemd-user | ✅ on-norm — user-scope is **correct for us** (we spawn Claude Code as the user, needing their `~/.claude`/keychain/env) |
| Dev | foreground from source, no supervisor | `make dev` foreground tsx watch | ✅ on-norm |
| Shared foreground primitive | `serve`/`gateway`/`run` | `autonomos start` | ✅ exists |
| dev→vending bridge | `install-system-daemon` etc. | `autonomos install-service` | ✅ exists |
| **Operator/prod path** | *(norm has none)* | `make prod` / `make deploy` → **pm2** | ❌ the wart |
| Node process manager | **none** use pm2/forever | pm2 | ❌ off-norm |
| Container lane (optional) | Docker `restart: unless-stopped` (OpenClaw, Hermes, Ollama, n8n) | none | ⚪ deliberately skipped — autonomOS spawns host PTYs; containerizing fights that |

**Conclusion:** autonomOS is *already* on-norm at both ends (launchd/systemd vending +
foreground dev). The single off-norm element is **pm2 in `make prod`/`make deploy`** — a
leftover middle path the market doesn't even have. The norm-aligned fix is to make `make
prod`/`deploy` **converge on the same init-supervised primitive the vending path uses**,
exactly like Caddy's systemd unit running `caddy run`. This is decisive evidence for
Option **B** in §4 (a launchd/systemd unit whose `ExecStart` wraps the foreground
`autonomos start` / source `tsx` primitive) over inventing anything new.
