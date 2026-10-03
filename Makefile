BIN := tracker
BINDIR ?= $(HOME)/.local/bin
LAUNCH_AGENT_LABEL := com.plei99.piano-tracker.sync
LAUNCH_AGENT_TEMPLATE := launchd/$(LAUNCH_AGENT_LABEL).plist.in
LAUNCH_AGENT_PATH := $(HOME)/Library/LaunchAgents/$(LAUNCH_AGENT_LABEL).plist
LAUNCH_LOG_DIR := $(HOME)/Library/Logs/piano-tracker

.PHONY: build install check
build: node_modules
	npm run --silent build:bin

# Builds the standalone binary (dist/tracker, via Bun), installs it, and on
# macOS (re)loads the launch agent that runs `tracker sync` every hour.
install: build
	mkdir -p "$(BINDIR)"
	install -m 0755 dist/$(BIN) "$(BINDIR)/$(BIN)"
	if [ "$$(uname -s)" = "Darwin" ]; then \
		mkdir -p "$$(dirname "$(LAUNCH_AGENT_PATH)")" "$(LAUNCH_LOG_DIR)"; \
		sed \
			-e 's|__TRACKER_BIN__|$(BINDIR)/$(BIN)|g' \
			-e 's|__STDOUT_LOG__|$(LAUNCH_LOG_DIR)/sync.out.log|g' \
			-e 's|__STDERR_LOG__|$(LAUNCH_LOG_DIR)/sync.err.log|g' \
			"$(LAUNCH_AGENT_TEMPLATE)" > "$(LAUNCH_AGENT_PATH)"; \
		launchctl bootout "gui/$$(id -u)" "$(LAUNCH_AGENT_PATH)" >/dev/null 2>&1 || true; \
		launchctl bootstrap "gui/$$(id -u)" "$(LAUNCH_AGENT_PATH)"; \
		launchctl enable "gui/$$(id -u)/$(LAUNCH_AGENT_LABEL)"; \
		launchctl kickstart -k "gui/$$(id -u)/$(LAUNCH_AGENT_LABEL)"; \
	fi

# Typecheck, formatting, and tests: what must pass before committing.
check: node_modules
	npm run --silent typecheck
	npm run --silent format:check
	npm test --silent

node_modules: package.json package-lock.json
	npm ci --no-audit --no-fund
	touch node_modules
