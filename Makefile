.PHONY: dev prod stop restart logs down check fmt deploy doctor hero build adr adr-check adr-index adr-renumber adr-import

BUN := $(HOME)/.bun/bin/bun
TSX := packages/server/node_modules/.bin/tsx
AUTONOMOS := $(TSX) packages/cli/src/index.ts
DEPLOY_HOST ?= $(or $(HOST),$(shell grep -s '^DEPLOY_HOST=' .env | cut -d= -f2))
DEPLOY_PATH ?= ~/autonomOS
PROD_PORT ?= 3100
NO_MIGRATE ?=
# Interface the prod server binds, for a ONE-OFF override:
#   make deploy BIND_HOST=127.0.0.1
# Empty = the server's default: all interfaces (reachable over the network —
# Tailscale / IAP / SSH — which is how this is normally deployed). The auth
# token gates what you can do once connected; the network layer gates who
# reaches the port. Set BIND_HOST=127.0.0.1 only to RESTRICT to loopback, e.g.
# a box you reach exclusively through an SSH tunnel.
#
# For a persistent restriction, prefer `AUTONOMOS_HOST=127.0.0.1` in THAT box's
# .env instead of this. The service wrapper runs `tsx --env-file=<repo>/.env`,
# so the server reads it on every start — it survives `install-service --force`,
# whereas BIND_HOST bakes `--host` into the service file, which a later reinstall
# without it would drop.
#
# Deliberately NOT named HOST: $(HOST) is already an alias for DEPLOY_HOST above,
# so `HOST=x make deploy` would try to deploy TO a host named "x".
#
# Strip an inline `# comment` and any padding: this value lands in command-prefix
# position below (`HOST=$(BIND_HOST) bash …`), where a stray `#` would comment
# out the rest of the recipe line and make `make prod` a SILENT no-op — a deploy
# that reports success and changes nothing. `-f2-` keeps values containing `=`.
# (the \# is escaped for make — an unescaped # would comment out the rest of
# this line, including the closing paren.)
BIND_HOST ?= $(strip $(shell grep -s '^BIND_HOST=' .env | cut -d= -f2- | cut -d'\#' -f1))

# ── dev: isolated per worktree ───────────────────
# Ports are derived from the directory path hash so each worktree gets unique ports.
# Override manually: make dev DEV_API_PORT=3101 DEV_VITE_PORT=5173
DEV_PORT_HASH := $(shell printf '%s' "$(CURDIR)" | cksum | cut -d' ' -f1)
DEV_API_PORT ?= $(shell echo $$(( 3200 + $(DEV_PORT_HASH) % 800 )))
DEV_VITE_PORT ?= $(shell echo $$(( 5200 + $(DEV_PORT_HASH) % 800 )))
DEV_CONFIG_DIR ?= $(CURDIR)/.autonomos-dev

dev:
	@mkdir -p $(DEV_CONFIG_DIR)
	@lsof -ti:$(DEV_API_PORT) -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
	@lsof -ti:$(DEV_VITE_PORT) -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
	@echo "Dev server: API=:$(DEV_API_PORT) Vite=:$(DEV_VITE_PORT) Config=$(DEV_CONFIG_DIR)"
	@cd packages/server && PORT=$(DEV_API_PORT) AUTONOMOS_CONFIG_DIR=$(DEV_CONFIG_DIR) CORS_ORIGIN=http://localhost:$(DEV_VITE_PORT) ../../$(TSX) watch --env-file=../../.env src/index.ts &
	@sleep 2
	@cd packages/dashboard && VITE_API_PORT=$(DEV_API_PORT) $(BUN) vite --host 0.0.0.0 --port $(DEV_VITE_PORT)

# ── prod: build + OS-native daemon on :3100 ───────
#   Supervised by launchd (macOS) / systemd-user (Linux) via
#   scripts/install-prod-service.sh — NOT pm2. The script auto-migrates an
#   existing pm2-managed autonomos (set NO_MIGRATE=1 to skip) and is idempotent,
#   so re-running picks up new source.
#
#   Runs synchronously and verifies the daemon came up. (Don't run `make prod`
#   from inside an agent session the daemon spawned — the supervisor restart
#   would kill that PTY mid-run. Use a plain shell or `make deploy`.)
prod: build
	@echo "Handing off to OS-native supervisor (launchd/systemd-user)..."
	@PORT=$(PROD_PORT) NO_MIGRATE=$(NO_MIGRATE) HOST='$(BIND_HOST)' bash scripts/install-prod-service.sh

# ── build: deps + channel server + dashboard, NO service operations ──
#   Factored out of `prod` so the source-mode updater (ADR-077) can rebuild a
#   managed clone after a tag checkout without touching the supervisor — the
#   updater owns the restart (out-of-process, health-gated). Everything here
#   must stay side-effect-free with respect to the running daemon.
build:
	@$(BUN) install
	@bash scripts/ensure-node-pty.sh
	@echo "Building channel server..."
	@# Deps INLINED (no --packages=external): the release tarball carries no
	@# node_modules resolvable from channel-server/, so external specifiers
	@# crashed the bridge with ERR_MODULE_NOT_FOUND before the MCP initialize
	@# response — every agent's autonomos MCP dead fleet-wide on bundle
	@# installs while the daemon (whose own bundle inlines the same deps)
	@# looked healthy (#376). Only ws's OPTIONAL native accelerators stay
	@# external: ws require()s bufferutil/utf-8-validate in try/catch and
	@# falls back to its JS implementations when absent — inlining them would
	@# fail the build; leaving them external is ws's supported shape.
	@# The createRequire banner is load-bearing: inlined CJS deps (ws) call
	@# require() for node builtins, and esbuild's ESM output otherwise shims
	@# require to a throw ("Dynamic require of events is not supported").
	@bunx esbuild packages/server/src/channel-server/index.ts --bundle --platform=node --format=esm --outfile=packages/server/src/channel-server/dist.mjs --external:bufferutil --external:utf-8-validate --banner:js="import { createRequire as __csCreateRequire } from 'node:module'; const require = __csCreateRequire(import.meta.url);" --log-level=warning
	@echo "Removing any stale embedded dashboard (hosted server serves packages/dashboard/dist; _embedded_dashboard is a binary-build artifact only)..."
	@rm -rf packages/server/src/_embedded_dashboard
	@echo "Building dashboard..."
	@# Build into dist.next and swap (ADR-105): on a source install the OLD
	@# daemon keeps serving packages/dashboard/dist throughout `autonomos
	@# upgrade`'s minutes-long rebuild, and vite empties its outDir first — a
	@# browser refresh mid-build would 404 every asset. The swap window is two
	@# renames.
	@cd packages/dashboard && rm -rf dist.next dist.prev && $(BUN) vite build --outDir dist.next --emptyOutDir && { [ ! -d dist ] || mv dist dist.prev; } && mv dist.next dist && rm -rf dist.prev

# ── doctor: preflight checks (node-pty ABI vs runtime node) ──
#   Run standalone to diagnose/repair a crash-loop after a node upgrade.
doctor:
	@bash scripts/ensure-node-pty.sh

# ── stop / restart / logs ─────────────────────────
#   stop: service-aware — stops via the supervisor so launchd KeepAlive /
#   systemd Restart don't immediately revive it (a bare SIGTERM would bounce).
stop:
	@$(AUTONOMOS) stop

restart:
	@$(AUTONOMOS) restart

logs:
	@$(AUTONOMOS) logs --lines 50

# ── down: stop everything ────────────────────────
#   Removes the OS-native service entirely (stop + delete unit), then frees any
#   dev ports.
down:
	@$(AUTONOMOS) uninstall-service 2>/dev/null || true
	@lsof -ti:$(DEV_API_PORT) -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
	@lsof -ti:$(DEV_VITE_PORT) -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
	@echo "Stopped (service removed; dev API=:$(DEV_API_PORT) Vite=:$(DEV_VITE_PORT))."

# ── deploy: rsync + prod on remote ───────────────
#
#   Configure per machine:
#     .env: DEPLOY_HOST=forge
#   Or inline: make deploy DEPLOY_HOST=forge
#
deploy:
	@[ -n "$(DEPLOY_HOST)" ] || { echo "Error: Set DEPLOY_HOST in .env or pass it: make deploy DEPLOY_HOST=forge"; exit 1; }
	@echo "⚠️  make deploy is a private dev tool, NOT a supported install shape (ADR-077)."
	@echo "   It rsyncs a mutable working tree with no git history — no provenance, no"
	@echo "   'autonomos upgrade', no rollback. For a managed deployment use:"
	@echo "   scripts/install-source.sh on the target (clone-at-tag, upgradeable)."
	@echo "Deploying to $(DEPLOY_HOST):$(DEPLOY_PATH)..."
	rsync -avz --delete \
		--exclude node_modules \
		--exclude .env \
		--exclude dist \
		--exclude .git \
		--exclude _embedded_dashboard \
		--exclude .autonomos-bin \
		./ $(DEPLOY_HOST):$(DEPLOY_PATH)/
	@echo "Installing bun (if needed)..."
	ssh $(DEPLOY_HOST) 'export PATH=$$HOME/.bun/bin:$$PATH && command -v bun >/dev/null || { curl -fsSL https://bun.sh/install | bash && export PATH=$$HOME/.bun/bin:$$PATH; }'
	@echo "Installing dependencies..."
	ssh $(DEPLOY_HOST) 'cd $(DEPLOY_PATH) && export PATH=$$HOME/.bun/bin:$$PATH && bun install'
	@echo "Building and starting on $(DEPLOY_HOST) (launchd/systemd-user, auto-migrates pm2)..."
	@# Forward BIND_HOST only when set locally. Passing an empty BIND_HOST= would
	@# override (and blank out) the remote's own .env value, silently flipping a
	@# deliberately-exposed box back to loopback and cutting off browser access.
	ssh $(DEPLOY_HOST) 'cd $(DEPLOY_PATH) && export PATH=$$HOME/.local/bin:$$HOME/.bun/bin:$$PATH && make prod $(if $(BIND_HOST),BIND_HOST=$(BIND_HOST),)'

# ── fmt: auto-fix lint + formatting ─────────────
fmt:
	npx biome check --write --unsafe packages/

# ── check: lint + typecheck + test ───────────────
# Per-test backstop (OUTSIDE `ifndef CI` on purpose — it must apply in CI,
# which sets CI=true): a test stuck on an await fails at 5 min, NAMED, instead
# of silently holding the run until the CI job timeout. 5 min sits above every
# real-agent suite's own diagnostic budget (agent-spawn-prompt waits 180s in a
# 200s describe), so it never pre-empts their better failure messages. It can
# NOT catch a synchronous block (the event loop is frozen); the CI job's
# timeout-minutes is the backstop for that.
NODE_TEST_TIMEOUT := --test-timeout=300000

# Local runs cap test fan-out at half the cores. Uncapped, one run forks about
# one process per core, and a few agents' gates at once saturated the box (load
# avg 24-35), slowing the live server and causing timing-only flakes. CI sets
# CI=true, so its command line is unchanged.
ifndef CI
LOCAL_TEST_CAP := $(shell node -e "process.stdout.write(String(Math.max(1, Math.floor(require('os').availableParallelism() / 2))))" 2>/dev/null)
NODE_TEST_CONCURRENCY := $(if $(LOCAL_TEST_CAP),--test-concurrency=$(LOCAL_TEST_CAP))
VITEST_MAX_WORKERS := $(if $(LOCAL_TEST_CAP),--maxWorkers=$(LOCAL_TEST_CAP))
endif

check:
	$(TSX) scripts/decisions.ts check
	npx biome check packages/
	packages/dashboard/node_modules/.bin/tsc --build
	$(TSX) --test $(NODE_TEST_CONCURRENCY) $(NODE_TEST_TIMEOUT) packages/server/src/__tests__/*.test.ts packages/cli/src/__tests__/*.test.ts scripts/*.test.ts
	cd packages/dashboard && node_modules/.bin/vitest run $(VITEST_MAX_WORKERS)

# ── adr: architectural decision records, one file each (docs/decisions/) ───────
# `make adr NEW="Title"` allocates the next free number across origin/main AND open
# PRs (via gh, when available) and writes a template. A PR never edits the index;
# the decisions-index workflow regenerates it after merge (`make adr-index` previews).
# See docs/decisions/README.md. Arguments are read by the shell as "$$NEW" (make
# exports command-line variables), so backticks and quotes in a title survive.
adr:
	@test -n "$$NEW" || { echo 'usage: make adr NEW="Short decision title"'; exit 2; }
	$(TSX) scripts/decisions.ts new "$$NEW"

adr-check:
	$(TSX) scripts/decisions.ts check

adr-index:
	$(TSX) scripts/decisions.ts index

adr-renumber:
	@test -n "$$FILE" || { echo 'usage: make adr-renumber FILE=docs/decisions/ADR-NNN-slug.md'; exit 2; }
	$(TSX) scripts/decisions.ts renumber "$$FILE"

adr-import:
	$(TSX) scripts/decisions.ts import "$${REF:-HEAD}"

# ── hero: regenerate the README hero screenshot (docs/assets/hero.png) ───────────────
# Boots an isolated demo instance (own config dir + fake HOME + ephemeral port,
# never :3100), stages the multi-agent scene, and captures via headless Chrome.
# RE-RUN THIS AFTER ANY DASHBOARD UI CHANGE so the README hero stays accurate.
# See packages/dashboard/scripts/capture-hero.ts for prerequisites + details.
hero:
	cd packages/dashboard && $(BUN) run capture-hero
