BIN := tracker

.PHONY: build
build:
	go build -o $(BIN) ./cmd/tracker
