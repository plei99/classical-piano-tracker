# AGENTS.md

Welcome. If you are an AI agent working on this repository, strictly adhere to the rules below.

## Context & Stack

This project is a CLI, terminal UI, and local web UI for tracking Spotify classical piano listening history. It is written in Rust, as one Cargo workspace, except the browser client, which is TypeScript (`web/`). It was ported from Go and then TypeScript; those builds are kept at the `archive/go` and `archive/ts` tags.

- **Build**: `make build` (`cargo build --release`) produces `target/release/tracker`. `tracker-web`'s build script bundles the web client (`node web/build.mjs`, esbuild) and embeds it, so building needs Node 24+ and `npm ci --prefix web` (the Makefile runs it).
- **CLI**: `clap`
- **TUI**: `ratatui` and `crossterm`, drawing the shared model from `tracker-app`
- **Web UI**: an `axum` server on a current-thread tokio runtime. The client is TypeScript with Preact (`web/`, strict `tsc`, vitest); the server renders the first screen in Rust (`crates/tracker-web/src/page.rs`) and the client adopts it with Preact's `hydrate`.
- **Database**: SQLite via `rusqlite` (bundled SQLite). No ORMs.
- **DB Code**: write raw SQL in `crates/tracker-core/sql/query.sql` (each statement under a `-- name:` annotation, sqlc style) and `crates/tracker-core/sql/schema.sql`; `crates/tracker-core/src/db.rs` looks statements up by name. Do not add an ORM or query builder.
- **HTTP**: blocking `ureq` for Spotify and the LLM providers. Everything except `tracker web` is synchronous; the TUI runs I/O on background threads.

## Directory Structure Enforcement

Maintain the following layout (one crate per concern under `crates/`):

- `crates/tracker-cli/` (clap commands in `src/cli/`; builds the `tracker` binary)
- `crates/tracker-app/` (the TUI's state machine, presenter, and list abstraction, and the HTTP contract `api.rs` the web client's types are generated from; pure)
- `crates/tracker-tui/` (terminal rendering of the shared model)
- `crates/tracker-web/` (`tracker web`'s server, first render, artwork service, and embedded assets)
- `web/` (the browser client: `src/app` the TUI's model ported to TypeScript, `src/client` the Preact components, `src/generated` the API bindings, `test/pages` the first-screen goldens)
- `crates/tracker-core/` (config, paths, SQL files, and DB access)
- `crates/tracker-spotify/` (API client, OAuth flow, and sync)
- `crates/tracker-recommend/` and `crates/tracker-llm/` (favorite pianists, taste summaries, LLM providers)

## Implementation Rules

1. **Config**: State and filters live in the config file (`~/Library/Application Support/piano-tracker/config.json` on macOS, `~/.config/piano-tracker/config.json` on Linux). Do not hardcode filters or credentials.
2. **Filtering**: Tracks are filtered strictly by checking if artists exist in the JSON config's `pianists_allowlist` and ensuring they do not exist in the `artists_blocklist`.
3. **Database**: The `tracks` table must be unique by `spotify_id`. Use `UPSERT` (e.g., `ON CONFLICT (spotify_id) DO UPDATE...`) to handle play count increments and timestamp updates. Do not log duplicate listens as new rows.
4. **UI state**: Keep network calls and DB writes out of the model's `update`. They are commands (`Cmd`) returned as data that run asynchronously and report back as messages, in both the TUI and the web UI.
5. **Rust–TypeScript contract**: never edit `web/src/generated`; change the Rust types in `crates/tracker-app/src/api.rs` (or `tracker-core`'s model) and run `cargo test`, which regenerates the bindings, then commit them. A change to the client's components that alters the first screen needs the same change in `crates/tracker-web/src/page.rs`: regenerate the goldens with `UPDATE_PAGES=1 npm test` in `web/`, and the Rust test must render them byte for byte.
6. **Checks**: `make check` (rustfmt, clippy with `-D warnings`, Rust tests, fresh bindings, then `tsc`, Prettier, and the web client's tests, including the contract test against the built server) must pass before committing.

Consult `README.md` for full architectural details (at current).
