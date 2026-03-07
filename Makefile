.PHONY: dev dev-server dev-dashboard install setup clean kill

BUN := $(HOME)/.bun/bin/bun

# Start both server and dashboard (use two terminals, or run each separately)
dev: kill
	@echo "Starting server on :3000 and dashboard on :5173..."
	@$(MAKE) dev-server &
	@sleep 2
	@$(MAKE) dev-dashboard

dev-server:
	cd packages/server && npx tsx watch src/index.ts

dev-dashboard:
	cd packages/dashboard && $(BUN) vite

# Install all dependencies
install:
	$(BUN) install

# Full setup (install + build node-pty native addon)
setup: install
	@echo "Building node-pty native addon..."
	@mkdir -p /tmp/autonomos-pty-build
	cd /tmp/autonomos-pty-build && npm init -y > /dev/null 2>&1 && npm install node-pty@1.0.0 --silent
	@cp -r /tmp/autonomos-pty-build/node_modules/node-pty/build \
		node_modules/.bun/node-pty@1.0.0/node_modules/node-pty/ 2>/dev/null || \
		cp -r /tmp/autonomos-pty-build/node_modules/node-pty/build \
		node_modules/node-pty/ 2>/dev/null || true
	@rm -rf /tmp/autonomos-pty-build
	@echo "Setup complete. Run 'make dev' to start."

# Kill any running dev servers
kill:
	@lsof -ti:3000 | xargs kill -9 2>/dev/null || true
	@lsof -ti:5173 | xargs kill -9 2>/dev/null || true

# Remove build artifacts
clean: kill
	rm -rf node_modules packages/*/node_modules
