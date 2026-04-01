# Classical Piano Tracker

A Go CLI/TUI for tracking, filtering, rating, and exploring your classical piano listening history from Spotify.

## Stack

- Go
- Cobra for the CLI
- Bubble Tea and Lip Gloss for the TUI
- SQLite via `modernc.org/sqlite`
- `sqlc` for all database access
- Spotify via `zmb3/spotify`

## What It Does

- Sync your recent Spotify plays into a local SQLite database
- Filter synced tracks through a pianist allowlist and artist blocklist
- Rate tracks with stars and optional comments
- Browse, sync, and rate tracks in a terminal UI
- Rank your favorite pianists from local ratings and replay counts
- Generate LLM-backed recommendations for new pianists, then validate them against Spotify

## Local State

The app keeps config and data separate.

- Config path:
  resolved with `os.UserConfigDir()`
  - macOS default: `~/Library/Application Support/piano-tracker/config.json`
  - Linux default: `~/.config/piano-tracker/config.json`
- Database path:
  resolved with the user data directory
  - macOS default: `~/Library/Application Support/piano-tracker/tracker.db`
  - Linux default: `~/.local/share/piano-tracker/tracker.db`

You can inspect or override them with:

```bash
tracker config path
tracker --config /custom/config.json --db /custom/tracker.db ...
```

## Build

```bash
go build ./...
make build
```

To run without installing:

```bash
go run ./cmd/tracker --help
go run ./cmd/tracker version
```

## First-Time Setup

The quickest path is:

```bash
go run ./cmd/tracker onboarding
```

That interactive flow collects:

- Spotify client ID
- Spotify client secret
- optional OpenAI API key
- an initial subset of the default pianist allowlist

### Manual setup

If you prefer to edit the config directly:

### 1. Generate the config file

Any config-aware command will create a default config file if one does not exist yet.

For example:

```bash
go run ./cmd/tracker config validate
```

Then edit the generated config file and set:

- `spotify.client_id`
- `spotify.client_secret`

The default config also includes a populated `pianists_allowlist` and an empty `artists_blocklist`.

### 2. Configure Spotify redirect URI

In your Spotify developer app settings, add this redirect URI:

```text
http://127.0.0.1:8000/api/auth/spotify/callback
```

### 3. Run Spotify login

```bash
go run ./cmd/tracker spotify login
```

The CLI prints a URL to open in your browser. After login, the OAuth token is stored in the config file.

## Core Workflow

### Sync recent listening history

```bash
go run ./cmd/tracker sync
```

Optional:

```bash
go run ./cmd/tracker sync --limit 50
```

Sync behavior:

1. Fetch recent Spotify plays
2. Skip a track if any artist is in `artists_blocklist`
3. Accept a track only if at least one artist is in `pianists_allowlist`
4. UPSERT the track into SQLite by `spotify_id`
5. Increment `play_count` and update `last_played_at` for repeat listens

### Browse local tracks in the CLI

```bash
go run ./cmd/tracker list recent
go run ./cmd/tracker list top
go run ./cmd/tracker list unrated
go run ./cmd/tracker show 12
```

### Rate tracks

Strict rating by ID:

```bash
go run ./cmd/tracker rate --track-id 12 --stars 5 --opinion "Explosive and clear"
```

Interactive rating flow:

```bash
go run ./cmd/tracker rate-prompt
go run ./cmd/tracker rate-prompt --unrated
```

### Use the TUI

```bash
go run ./cmd/tracker tui
```

Current TUI features:

- browse local tracks
- sync from Spotify
- edit ratings inline
- adaptive layout based on terminal size
- terminal-native styling instead of a hardcoded color theme

Main keys:

- `j` / `k` or arrow keys: move
- `s`: sync
- `enter` or `e`: open rating editor
- `r`: reload
- `q`: quit

Inside the rating editor:

- `1`-`5`: set stars
- type text: edit opinion
- `backspace`: delete
- `enter`: save
- `esc`: cancel

## Recommendations

### Favorite pianists

This is deterministic and local-only.

```bash
go run ./cmd/tracker recommend favorites
go run ./cmd/tracker recommend favorites --limit 15
```

It ranks allowlisted pianists using:

- star ratings
- number of rated tracks
- replay count
- a small penalty for tiny sample sizes

### New pianist recommendations

This command:

1. builds a taste summary from local ratings and comments
2. asks an OpenAI model for new pianist names only
3. validates those names against Spotify artist search

Required environment variable:

```bash
export OPENAI_API_KEY=...
```

Optional overrides:

```bash
export OPENAI_MODEL=gpt-5.4
export OPENAI_BASE_URL=https://api.openai.com/v1/responses
```

Run:

```bash
go run ./cmd/tracker recommend pianists
go run ./cmd/tracker recommend pianists --limit 5
```

The default OpenAI model is `gpt-5.4`. `OPENAI_MODEL` overrides it.

## Command Summary

```text
tracker config
tracker list
tracker rate
tracker rate-prompt
tracker recommend
tracker show
tracker spotify
tracker sync
tracker tui
tracker version
```

## Development Notes

- All DB access goes through `sqlc`-generated queries in `internal/db/`
- The TUI keeps DB writes and network calls off the Bubble Tea `Update` loop by using `tea.Cmd`
- Track artist lists are stored as JSON strings in SQLite and decoded in Go for filtering and recommendation logic

## Project Structure

- `cmd/tracker/`: application entrypoint
- `internal/cli/`: Cobra commands
- `internal/tui/`: Bubble Tea models and rendering
- `internal/db/`: schema, queries, and generated DB code
- `internal/spotify/`: Spotify auth and client integration
- `internal/recommend/`: favorite-pianist and taste-summary logic
- `internal/openai/`: OpenAI recommendation client
