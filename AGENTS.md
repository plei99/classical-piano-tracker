# AGENTS.md

Welcome. If you are an AI agent working on this repository, strictly adhere to the rules below.

## Context & Stack

This project is a CLI, terminal UI, and local web UI for tracking Spotify classical piano listening history. It is written in TypeScript (it was ported from Go; the Go code is kept at the `archive/go` tag).

- **Runtime and build**: Node 24+ or Bun. `scripts/build.mjs` bundles with esbuild into `dist/tracker.js`; `npm run build:bin` compiles a standalone Bun binary, `dist/tracker`.
- **CLI**: `commander`
- **TUI**: React drawn with `ink`
- **Web UI**: React DOM in the browser, server-rendered with `react-dom/server` by a local `node:http` server
- **Database**: SQLite via the runtime's built-in `node:sqlite` (no native modules, no ORMs).
- **DB Code**: write raw SQL in `src/core/sql/query.sql` (each statement under a `-- name:` annotation, sqlc style) and `src/core/sql/schema.sql`; `src/core/db.ts` looks statements up by name. Do not add an ORM or query builder.

## Directory Structure Enforcement

Maintain the following layout:

- `src/cli/` (commander commands, wired up in `src/cli/index.ts`)
- `src/app/` (the state machine, presenter, and React hook shared by the TUI and the web UI)
- `src/tui/` (Ink rendering of the shared model)
- `src/web/` (`tracker web`: `server/` and the React DOM `client/`; the HTTP contract is `api.ts`)
- `src/core/` (config, paths, SQL files, and DB access)
- `src/spotify/` (API client, OAuth flow, and sync)
- `src/recommend/` and `src/llm/` (favorite pianists, taste summaries, LLM providers)

## Implementation Rules

1. **Config**: State and filters live in the config file (`~/Library/Application Support/piano-tracker/config.json` on macOS, `~/.config/piano-tracker/config.json` on Linux). Do not hardcode filters or credentials.
2. **Filtering**: Tracks are filtered strictly by checking if artists exist in the JSON config's `pianists_allowlist` and ensuring they do not exist in the `artists_blocklist`.
3. **Database**: The `tracks` table must be unique by `spotify_id`. Use `UPSERT` (e.g., `ON CONFLICT (spotify_id) DO UPDATE...`) to handle play count increments and timestamp updates. Do not log duplicate listens as new rows.
4. **UI state**: Keep network calls and DB writes out of the model's `update`. They are commands that run asynchronously and report back as messages, in both the TUI and the web UI.
5. **Checks**: `make check` (typecheck, Prettier, tests) must pass before committing.

Consult `README.md` for full architectural details (at current).
