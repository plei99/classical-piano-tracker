BIN := tracker
BINDIR ?= $(HOME)/.local/bin
LAUNCH_AGENT_LABEL := com.plei99.piano-tracker.sync
LAUNCH_AGENT_TEMPLATE := launchd/$(LAUNCH_AGENT_LABEL).plist.in
LAUNCH_AGENT_PATH := $(HOME)/Library/LaunchAgents/$(LAUNCH_AGENT_LABEL).plist
LAUNCH_LOG_DIR := $(HOME)/Library/Logs/piano-tracker

.PHONY: build install check
# target/release/tracker, with the web client (web/, TypeScript) bundled and
# embedded by tracker-web's build script, which needs Node 24 or later.
build: web/node_modules
	cargo build --release --locked

# Builds the release binary, installs it, and on macOS (re)loads the launch
# agent that runs `tracker sync` every hour.
install: build
	mkdir -p "$(BINDIR)"
	install -m 0755 target/release/$(BIN) "$(BINDIR)/$(BIN)"
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

# Formatting, lints, and tests: what must pass before committing. The web
# client's TypeScript bindings are generated from the Rust types by
# `cargo test`; they must match what is staged or committed. The client is then
# type-checked against them and tested, including against the server just
# built (src/client/contract.test.ts).
check: web/node_modules
	cargo fmt --all --check
	cargo clippy --workspace --all-targets --locked -- -D warnings
	cargo test --workspace --locked
	@git diff --quiet -- web/src/generated && test -z "$$(git ls-files --others --exclude-standard -- web/src/generated)" || \
		{ git status --short -- web/src/generated; echo "web/src/generated is stale: add what cargo test wrote"; exit 1; }
	cd web && npm run --silent typecheck && npm run --silent format:check && \
		TRACKER_BIN=$(CURDIR)/target/debug/tracker npm test --silent

web/node_modules: web/package.json web/package-lock.json
	npm ci --prefix web --no-audit --no-fund
	touch web/node_modules
