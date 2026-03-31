# Classical Piano Tracker

A CLI and TUI (Terminal UI) application for tracking, filtering, and rating your classical piano listening history on Spotify.

## Architecture & Tech Stack

This project is built in **Go** and prioritizes a clean, fast, single-binary execution model.

*   **Language**: Go
*   **CLI Framework**: [Cobra](https://github.com/spf13/cobra)
*   **TUI Framework**: [Bubbletea](https://github.com/charmbracelet/bubbletea) & Lipgloss (Charm ecosystem)
*   **Database**: SQLite (pure Go via `modernc.org/sqlite`)
*   **DB Code Generation**: [sqlc](https://sqlc.dev/)
*   **Spotify Client**: `zmb3/spotify`

## Core Design Decisions

### 1. Database Access (`sqlc`)
We use `sqlc` to generate type-safe Go code from raw SQL queries. 

The database maintains a unique dictionary of tracks rather than an append-only log of every single play.
*   **`tracks` table**: Stores `spotify_id` (PK), metadata, `play_count`, and `last_played_at`. History syncs use SQLite `UPSERT` to bump the play count and update the timestamp for existing tracks.
*   **`ratings` table**: Stores `track_id` (FK), `stars` (1-5), `opinion` (text), and `updated_at`.

### 2. State & Authentication
All configuration, including OAuth tokens and curation filters, is stored locally in JSON format at:
`~/.config/piano-tracker/config.json`

This file includes:
*   Spotify `client_id` and `client_secret`
*   OAuth `token` (access token, refresh token, expiry)
*   Filtering lists (allowlist and blocklist)

The CLI handles the initial OAuth flow by briefly spinning up a local web server (e.g., `localhost:8000/api/auth/spotify/callback`) to receive the authorization code.

### 3. Track Filtering Logic
Because Spotify does not provide granular track-level genres, we filter based on artist curation:

1. Fetch the 50 most recently played tracks from Spotify.
2. For each track, evaluate its `Artists` array.
3. **Blocklist Check**: If any artist is in `artists_blocklist` (e.g., "Yiruma"), skip the track entirely.
4. **Allowlist Check**: If at least one artist is in `pianists_allowlist` (e.g., "Martha Argerich", "Daniil Trifonov"), process and save the track.
5. Apply the `UPSERT` logic to the database.

## Project Structure
*   `cmd/tracker/`: Application entry point (`main.go`).
*   `internal/cli/`: Cobra command definitions (`sync`, `rate`, etc.).
*   `internal/tui/`: Bubbletea models, views, and update logic.
*   `internal/db/`: SQLite schema, queries, and `sqlc` generated code.
*   `internal/spotify/`: Spotify API integration and OAuth logic.
