BIN := tracker
BINDIR ?= $(HOME)/.local/bin
LAUNCH_AGENT_LABEL := com.plei99.piano-tracker.sync
LAUNCH_AGENT_TEMPLATE := launchd/$(LAUNCH_AGENT_LABEL).plist.in
LAUNCH_AGENT_PATH := $(HOME)/Library/LaunchAgents/$(LAUNCH_AGENT_LABEL).plist
LAUNCH_LOG_DIR := $(HOME)/Library/Logs/piano-tracker
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILD_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -X github.com/plei99/classical-piano-tracker/internal/buildinfo.Version=$(VERSION) -X github.com/plei99/classical-piano-tracker/internal/buildinfo.Commit=$(COMMIT) -X github.com/plei99/classical-piano-tracker/internal/buildinfo.Date=$(BUILD_DATE)

.PHONY: build install
build:
	go build -ldflags "$(LDFLAGS)" -o $(BIN) ./cmd/tracker

install: build
	mkdir -p "$(BINDIR)"
	install -m 0755 "$(BIN)" "$(BINDIR)/$(BIN)"
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
