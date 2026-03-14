.PHONY: dev prod down check deploy

BUN := $(HOME)/.bun/bin/bun
DEPLOY_HOST ?= $(shell grep -s '^DEPLOY_HOST=' .env | cut -d= -f2)
DEPLOY_PATH ?= ~/autonomOS

# ── dev: API on :3101, Vite HMR on :5173 ─────────
dev:
	@lsof -ti:3101 -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
	@lsof -ti:5173 | xargs kill -9 2>/dev/null || true
	@echo "Starting server on :3101 and dashboard on :5173..."
	@cd packages/server && PORT=3101 npx tsx --env-file=../../.env watch src/index.ts &
	@sleep 2
	@cd packages/dashboard && $(BUN) vite --host 0.0.0.0

# ── prod: built dashboard on :3100 ───────────────
prod:
	@lsof -ti:3100 -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
	@echo "Building dashboard..."
	@cd packages/dashboard && $(BUN) vite build
	@echo "Starting server on :3100 (serving dashboard)..."
	@cd packages/server && PORT=3100 npx tsx --env-file=../../.env src/index.ts

# ── down: stop everything ────────────────────────
down:
	@lsof -ti:3100 | xargs kill -9 2>/dev/null || true
	@lsof -ti:3101 | xargs kill -9 2>/dev/null || true
	@lsof -ti:5173 | xargs kill -9 2>/dev/null || true
	@echo "Stopped."

# ── deploy: rsync to remote and start in prod ────
#
#   Configure per machine in .deploy (gitignored):
#     DEPLOY_HOST = dev-server-terry
#
#   Or pass inline: make deploy DEPLOY_HOST=forge
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
	@echo "Installing bun (if needed)..."
	ssh $(DEPLOY_HOST) 'command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash'
	@echo "Installing dependencies..."
	ssh $(DEPLOY_HOST) 'cd $(DEPLOY_PATH) && export PATH=$$HOME/.bun/bin:$$PATH && bun install'
	@echo "Deployed. Run on server:"
	@echo "  ssh $(DEPLOY_HOST) 'cd $(DEPLOY_PATH) && make prod'"

# ── check: lint + typecheck + test ───────────────
check:
	npx biome check packages/
	packages/dashboard/node_modules/.bin/tsc --build
	cd packages/server && npx tsx --test src/__tests__/*.test.ts
