# AGENTS.md

Welcome. If you are an AI agent working on this repository, strictly adhere to the rules below.

## Context & Stack
This project is a CLI/TUI application for tracking Spotify classical piano listening history. 
**It is built exclusively in Go.**

*   **DO NOT** use Python, Node.js, or any other language for the core application. We recently pivoted away from Python.
*   **CLI**: `cobra`
*   **TUI**: `bubbletea` and `lipgloss`
*   **Database**: SQLite via `modernc.org/sqlite` (DO NOT use CGO/mattn).
*   **DB Code**: `sqlc` is used for all database access. Write raw SQL in `query.sql` and `schema.sql`, then run `sqlc generate`. Do not use GORM or other ORMs.

## Directory Structure Enforcement
Maintain the following standard Go project layout:
- `cmd/tracker/main.go` (Entry point wiring up Cobra root command)
- `internal/cli/` (Cobra commands: sync, rate)
- `internal/tui/` (Bubbletea models and UI components)
- `internal/db/` (SQL files and sqlc generated code)
- `internal/spotify/` (API client and OAuth flow)

## Implementation Rules
1. **Config**: State and filters live in `~/.config/piano-tracker/config.json`. Do not hardcode filters or credentials.
2. **Filtering**: Tracks are filtered strictly by checking if artists exist in the JSON config's `pianists_allowlist` and ensuring they do not exist in the `artists_blocklist`.
3. **Database**: The `tracks` table must be unique by `spotify_id`. Use `UPSERT` (e.g., `ON CONFLICT (spotify_id) DO UPDATE...`) to handle play count increments and timestamp updates. Do not log duplicate listens as new rows.
4. **TUI**: Keep network calls and DB writes asynchronous in Bubbletea using `tea.Cmd`. Do not block the `Update` loop.

Consult `README.md` for full architectural details.
