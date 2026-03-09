.PHONY: up down check deploy

BUN := $(HOME)/.bun/bin/bun
MODE ?= prod
DEPLOY_HOST ?= dev-server-terry
DEPLOY_PATH ?= ~/autonomOS

# ── up: start autonomOS (+ Tailscale sidecar if .env exists) ──
#
#   make up          → dev mode  (Vite HMR on :5173, API on :3000)
#   make up MODE=prod → prod mode (built dashboard served from :3000)
#
#   Tailscale sidecar only starts if .env is present.
up:
	@lsof -ti:3000 | xargs kill -9 2>/dev/null || true
ifeq ($(MODE),prod)
	@echo "Building dashboard..."
	@cd packages/dashboard && $(BUN) vite build
	@if [ -f .env ]; then \
		echo "Found .env — starting Tailscale sidecar..."; \
		$(call serve_json,3000); \
		cd deploy && docker compose up -d; \
	else \
		echo "No .env found — skipping Tailscale sidecar."; \
	fi
	@echo "Starting server on :3000 (serving dashboard)..."
	@cd packages/server && npx tsx src/index.ts
else
	@lsof -ti:5173 | xargs kill -9 2>/dev/null || true
	@if [ -f .env ]; then \
		echo "Found .env — starting Tailscale sidecar..."; \
		$(call serve_json,5173); \
		cd deploy && docker compose up -d; \
	else \
		echo "No .env found — skipping Tailscale sidecar."; \
	fi
	@echo "Starting server on :3000 and dashboard on :5173..."
	@cd packages/server && npx tsx watch src/index.ts &
	@sleep 2
	@cd packages/dashboard && $(BUN) vite --host 0.0.0.0
endif

# ── down: stop everything ────────────────────────
down:
	@lsof -ti:3000 | xargs kill -9 2>/dev/null || true
	@lsof -ti:5173 | xargs kill -9 2>/dev/null || true
	@if docker ps -q -f name=autonomos-ts 2>/dev/null | grep -q .; then \
		echo "Stopping Tailscale sidecar..."; \
		cd deploy && docker compose down; \
	fi
	@echo "Stopped."

# ── deploy: rsync to remote and start in prod ────
#
#   make deploy                          → deploy to dev-server-terry
#   make deploy DEPLOY_HOST=my-server    → deploy to a different host
#   make deploy DEPLOY_PATH=/opt/app     → deploy to a different path
#
deploy:
	@echo "Deploying to $(DEPLOY_HOST):$(DEPLOY_PATH)..."
	rsync -avz --delete \
		--exclude node_modules \
		--exclude .env \
		--exclude dist \
		--exclude deploy/serve.json \
		--exclude .git \
		./ $(DEPLOY_HOST):$(DEPLOY_PATH)/
	@echo "Installing bun (if needed)..."
	ssh $(DEPLOY_HOST) 'command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash'
	@echo "Installing dependencies..."
	ssh $(DEPLOY_HOST) 'cd $(DEPLOY_PATH) && export PATH=$$HOME/.bun/bin:$$PATH && bun install'
	@echo "Deployed. Run on server:"
	@echo "  ssh $(DEPLOY_HOST) 'cd $(DEPLOY_PATH) && make up MODE=prod'"

# ── check: lint + typecheck + test ───────────────
check:
	npx biome check packages/
	packages/dashboard/node_modules/.bin/tsc --build
	cd packages/server && npx tsx --test src/__tests__/*.test.ts

# ── helper: generate serve.json for Tailscale ────
# Note: ${TS_CERT_DOMAIN} is interpolated by Tailscale at runtime, not by the shell.
define serve_json
	@printf '{\n  "TCP": {\n    "80": { "HTTP": true },\n    "443": { "HTTPS": true }\n  },\n  "Web": {\n    "$${TS_CERT_DOMAIN}:80": {\n      "Handlers": { "/": { "Proxy": "http://host.docker.internal:$(1)" } }\n    },\n    "$${TS_CERT_DOMAIN}:443": {\n      "Handlers": { "/": { "Proxy": "http://host.docker.internal:$(1)" } }\n    }\n  }\n}\n' > deploy/serve.json
endef
