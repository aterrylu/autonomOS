.PHONY: dev prod stop restart logs down check fmt deploy

BUN := $(HOME)/.bun/bin/bun
PM2 := $(HOME)/.bun/bin/pm2
TSX := packages/server/node_modules/.bin/tsx
DEPLOY_HOST ?= $(shell grep -s '^DEPLOY_HOST=' .env | cut -d= -f2)
DEPLOY_PATH ?= ~/autonomOS

# ── dev: API on :3101, Vite HMR on :5173 ─────────
dev:
	@lsof -ti:3101 -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
	@lsof -ti:5173 | xargs kill -9 2>/dev/null || true
	@echo "Starting server on :3101 and dashboard on :5173..."
	@cd packages/server && PORT=3101 ../../$(TSX) --env-file=../../.env watch src/index.ts &
	@sleep 2
	@cd packages/dashboard && $(BUN) vite --host 0.0.0.0

# ── prod: build + pm2 daemon on :3100 ─────────────
#   nohup + setsid detaches the restart so it survives even when
#   triggered from a dashboard PTY session (which gets killed on restart).
prod:
	@command -v $(PM2) >/dev/null || { echo "Installing pm2..."; $(BUN) add -g pm2; }
	@$(BUN) install
	@echo "Building channel server..."
	@bunx esbuild packages/server/src/channel-server/index.ts --bundle --platform=node --format=esm --outfile=packages/server/src/channel-server/dist.mjs --packages=external --log-level=warning
	@echo "Building dashboard..."
	@cd packages/dashboard && $(BUN) vite build
	@echo "Restarting server..."
	@nohup sh -c '$(PM2) delete autonomos 2>/dev/null; $(PM2) start ecosystem.config.cjs; $(PM2) save' >/dev/null 2>&1 &

# ── stop / restart / logs ─────────────────────────
stop:
	@$(PM2) stop autonomos 2>/dev/null || true

restart: prod

logs:
	@$(PM2) logs autonomos --lines 50

# ── down: stop everything ────────────────────────
down:
	@$(PM2) delete autonomos 2>/dev/null || true
	@lsof -ti:3101 | xargs kill -9 2>/dev/null || true
	@lsof -ti:5173 | xargs kill -9 2>/dev/null || true
	@echo "Stopped."

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
	$(TSX) --test packages/server/src/__tests__/*.test.ts
