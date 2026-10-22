# AGENTS.md

Welcome. If you are an AI agent working on this repository, strictly adhere to the rules below.

## Context & Stack

This project is a CLI, terminal UI, and local web UI for tracking Spotify classical piano listening history. It is written in Rust, as one Cargo workspace (it was ported from Go and then TypeScript; those builds are kept at the `archive/go` and `archive/ts` tags).

- **Build**: `make build` (`cargo build --release`) produces `target/release/tracker`. Its build script also compiles the web client to WebAssembly and embeds it, which needs the `wasm32-unknown-unknown` target, the `wasm-bindgen` CLI at the version `tracker-web-client` pins, and optionally `wasm-opt` (see "Development" in `README.md`).
- **CLI**: `clap`
- **TUI**: `ratatui` and `crossterm`, drawing the shared model from `tracker-app`
- **Web UI**: an `axum` server on a current-thread tokio runtime; the client is Leptos, rendered on the server (SSR) and hydrated in the browser (wasm32)
- **Database**: SQLite via `rusqlite` (bundled SQLite). No ORMs.
- **DB Code**: write raw SQL in `crates/tracker-core/sql/query.sql` (each statement under a `-- name:` annotation, sqlc style) and `crates/tracker-core/sql/schema.sql`; `crates/tracker-core/src/db.rs` looks statements up by name. Do not add an ORM or query builder.
- **HTTP**: blocking `ureq` for Spotify and the LLM providers. Everything except `tracker web` is synchronous; the TUI runs I/O on background threads.

## Directory Structure Enforcement

Maintain the following layout (one crate per concern under `crates/`):

- `crates/tracker-cli/` (clap commands in `src/cli/`; builds the `tracker` binary)
- `crates/tracker-app/` (the state machine, presenter, list abstraction, and HTTP contract `api.rs` shared by the TUI and the web UI; pure, builds for wasm32)
- `crates/tracker-tui/` (terminal rendering of the shared model)
- `crates/tracker-web/` (`tracker web`'s server, artwork service, and embedded assets) and `crates/tracker-web-client/` (the Leptos client)
- `crates/tracker-core/` (config, paths, SQL files, and DB access)
- `crates/tracker-spotify/` (API client, OAuth flow, and sync)
- `crates/tracker-recommend/` and `crates/tracker-llm/` (favorite pianists, taste summaries, LLM providers)

## Implementation Rules

1. **Config**: State and filters live in the config file (`~/Library/Application Support/piano-tracker/config.json` on macOS, `~/.config/piano-tracker/config.json` on Linux). Do not hardcode filters or credentials.
2. **Filtering**: Tracks are filtered strictly by checking if artists exist in the JSON config's `pianists_allowlist` and ensuring they do not exist in the `artists_blocklist`.
3. **Database**: The `tracks` table must be unique by `spotify_id`. Use `UPSERT` (e.g., `ON CONFLICT (spotify_id) DO UPDATE...`) to handle play count increments and timestamp updates. Do not log duplicate listens as new rows.
4. **UI state**: Keep network calls and DB writes out of the model's `update`. They are commands (`Cmd`) returned as data that run asynchronously and report back as messages, in both the TUI and the web UI.
5. **Checks**: `make check` (rustfmt, clippy with `-D warnings`, tests) must pass before committing.

Consult `README.md` for full architectural details (at current).
