.PHONY: dev setup check fmt clean

BUN := $(HOME)/.bun/bin/bun

# Start server + dashboard
dev:
	@lsof -ti:3000 | xargs kill -9 2>/dev/null || true
	@lsof -ti:5173 | xargs kill -9 2>/dev/null || true
	@echo "Starting server on :3000 and dashboard on :5173..."
	@cd packages/server && npx tsx watch src/index.ts &
	@sleep 2
	@cd packages/dashboard && $(BUN) vite

# Install deps + build node-pty native addon
setup:
	$(BUN) install
	@echo "Building node-pty native addon..."
	@mkdir -p /tmp/autonomos-pty-build
	cd /tmp/autonomos-pty-build && npm init -y > /dev/null 2>&1 && npm install node-pty@1.0.0 --silent
	@cp -r /tmp/autonomos-pty-build/node_modules/node-pty/build \
		node_modules/.bun/node-pty@1.0.0/node_modules/node-pty/ 2>/dev/null || \
		cp -r /tmp/autonomos-pty-build/node_modules/node-pty/build \
		node_modules/node-pty/ 2>/dev/null || true
	@rm -rf /tmp/autonomos-pty-build
	@echo "Setup complete. Run 'make dev' to start."

# Lint + typecheck + test
check:
	npx biome check packages/
	packages/dashboard/node_modules/.bin/tsc --build
	cd packages/server && npx tsx --test src/__tests__/*.test.ts

# Auto-fix formatting and lint
fmt:
	npx biome check --write packages/

# Remove everything
clean:
	@lsof -ti:3000 | xargs kill -9 2>/dev/null || true
	@lsof -ti:5173 | xargs kill -9 2>/dev/null || true
	rm -rf node_modules packages/*/node_modules
