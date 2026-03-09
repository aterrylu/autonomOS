.PHONY: up down check

BUN := $(HOME)/.bun/bin/bun
MODE ?= dev

# ── up: start autonomOS + Tailscale sidecar ──────
#
#   make up          → dev mode  (Vite HMR on :5173, API on :3000)
#   make up MODE=prod → prod mode (built dashboard served from :3000)
#
#   Both modes expose http://autonomos via Tailscale.
up:
	@lsof -ti:3000 | xargs kill -9 2>/dev/null || true
ifeq ($(MODE),prod)
	@echo "Building dashboard..."
	@cd packages/dashboard && $(BUN) vite build
	@$(call serve_json,3000)
	@cd deploy && docker compose up -d
	@echo "Starting server on :3000 (serving dashboard)..."
	@cd packages/server && npx tsx src/index.ts
else
	@lsof -ti:5173 | xargs kill -9 2>/dev/null || true
	@$(call serve_json,5173)
	@cd deploy && docker compose up -d
	@echo "Starting server on :3000 and dashboard on :5173..."
	@cd packages/server && npx tsx watch src/index.ts &
	@sleep 2
	@cd packages/dashboard && $(BUN) vite --host 0.0.0.0
endif

# ── down: stop everything ────────────────────────
down:
	@lsof -ti:3000 | xargs kill -9 2>/dev/null || true
	@lsof -ti:5173 | xargs kill -9 2>/dev/null || true
	@cd deploy && docker compose down
	@echo "Stopped."

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
