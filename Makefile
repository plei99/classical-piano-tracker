BIN := tracker
BINDIR ?= $(HOME)/.local/bin
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
