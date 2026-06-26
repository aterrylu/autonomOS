.PHONY: dev prod stop restart logs down check fmt deploy doctor

BUN := $(HOME)/.bun/bin/bun
PM2 := $(HOME)/.bun/bin/pm2
TSX := packages/server/node_modules/.bin/tsx
DEPLOY_HOST ?= $(or $(HOST),$(shell grep -s '^DEPLOY_HOST=' .env | cut -d= -f2))
DEPLOY_PATH ?= ~/autonomOS

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
	@cd packages/server && PORT=$(DEV_API_PORT) AUTONOMOS_CONFIG_DIR=$(DEV_CONFIG_DIR) CORS_ORIGIN=http://localhost:$(DEV_VITE_PORT) ../../$(TSX) --env-file=../../.env watch src/index.ts &
	@sleep 2
	@cd packages/dashboard && VITE_API_PORT=$(DEV_API_PORT) $(BUN) vite --host 0.0.0.0 --port $(DEV_VITE_PORT)

# ── prod: build + pm2 daemon on :3100 ─────────────
#   nohup + setsid detaches the restart so it survives even when
#   triggered from a dashboard PTY session (which gets killed on restart).
prod:
	@command -v $(PM2) >/dev/null || { echo "Installing pm2..."; $(BUN) add -g pm2; }
	@$(BUN) install
	@bash scripts/ensure-node-pty.sh
	@echo "Building channel server..."
	@bunx esbuild packages/server/src/channel-server/index.ts --bundle --platform=node --format=esm --outfile=packages/server/src/channel-server/dist.mjs --packages=external --log-level=warning
	@echo "Removing any stale embedded dashboard (hosted server serves packages/dashboard/dist; _embedded_dashboard is a binary-build artifact only)..."
	@rm -rf packages/server/src/_embedded_dashboard
	@echo "Building dashboard..."
	@cd packages/dashboard && $(BUN) vite build
	@echo "Restarting server..."
	@nohup sh -c '$(PM2) delete autonomos 2>/dev/null; $(PM2) start ecosystem.config.cjs; $(PM2) save' >/dev/null 2>&1 &

# ── doctor: preflight checks (node-pty ABI vs runtime node) ──
#   Run standalone to diagnose/repair a pm2 crash-loop after a node upgrade.
doctor:
	@bash scripts/ensure-node-pty.sh

# ── stop / restart / logs ─────────────────────────
stop:
	@$(PM2) stop autonomos 2>/dev/null || true

restart: prod

logs:
	@$(PM2) logs autonomos --lines 50

# ── down: stop everything ────────────────────────
down:
	@$(PM2) delete autonomos 2>/dev/null || true
	@lsof -ti:$(DEV_API_PORT) -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
	@lsof -ti:$(DEV_VITE_PORT) -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
	@echo "Stopped (API=:$(DEV_API_PORT) Vite=:$(DEV_VITE_PORT))."

# ── deploy: rsync + prod on remote ───────────────
#
#   Configure per machine:
#     .env: DEPLOY_HOST=forge
#   Or inline: make deploy DEPLOY_HOST=forge
#
deploy:
	@[ -n "$(DEPLOY_HOST)" ] || { echo "Error: Set DEPLOY_HOST in .env or pass it: make deploy DEPLOY_HOST=forge"; exit 1; }
	@echo "Deploying to $(DEPLOY_HOST):$(DEPLOY_PATH)..."
	rsync -avz --delete \
		--exclude node_modules \
		--exclude .env \
		--exclude dist \
		--exclude .git \
		--exclude _embedded_dashboard \
		./ $(DEPLOY_HOST):$(DEPLOY_PATH)/
	@echo "Installing bun + pm2 (if needed)..."
	ssh $(DEPLOY_HOST) 'export PATH=$$HOME/.bun/bin:$$PATH && command -v bun >/dev/null || { curl -fsSL https://bun.sh/install | bash && export PATH=$$HOME/.bun/bin:$$PATH; } && command -v pm2 >/dev/null || bun add -g pm2'
	@echo "Installing dependencies..."
	ssh $(DEPLOY_HOST) 'cd $(DEPLOY_PATH) && export PATH=$$HOME/.bun/bin:$$PATH && bun install'
	@echo "Building and starting on $(DEPLOY_HOST)..."
	ssh $(DEPLOY_HOST) 'cd $(DEPLOY_PATH) && export PATH=$$HOME/.local/bin:$$HOME/.bun/bin:$$PATH && make prod'

# ── fmt: auto-fix lint + formatting ─────────────
fmt:
	npx biome check --write --unsafe packages/

# ── check: lint + typecheck + test ───────────────
check:
	npx biome check packages/
	packages/dashboard/node_modules/.bin/tsc --build
	$(TSX) --test packages/server/src/__tests__/*.test.ts packages/app/src/main/__tests__/*.test.ts scripts/*.test.ts
	cd packages/dashboard && node_modules/.bin/vitest run
