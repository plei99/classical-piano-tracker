# Classical Piano Tracker

A Go CLI/TUI for tracking, filtering, rating, and exploring your classical piano listening history from Spotify.

## Warning

This project was written for my personal use.
Based on the author's testing so far, `gpt-5.4` seems to produce the best recommendation results overall.

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

## Requirements

- Go installed locally
- a Spotify developer application with a client ID and client secret
- a Spotify account with listening history to sync
- optionally, an API key for one supported LLM provider if you want pianist recommendations from the LLM-backed flow

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

## Installation

```bash
go build ./...
make build
make install
```

By default, `make install` copies the binary to:

```text
~/.local/bin/tracker
```

Override that location if you want:

```bash
make install BINDIR=/opt/homebrew/bin
make install BINDIR=/usr/local/bin
```

If you do not want to install it globally, you can still run it from the repo:

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
- one LLM provider profile:
  - OpenAI
  - Anthropic
  - Google Gemini
  - Ollama
  - DeepSeek
  - Kimi
- provider-specific API key and/or base URL when needed
- a model selection for the chosen provider
- an initial subset of the default pianist allowlist

The onboarding pickers are keyboard-driven:

- `up/down` or `j/k`: move
- `enter`: confirm the current choice
- `q`: cancel

The pianist allowlist picker also supports:

- `space`: toggle the current pianist

The currently selected row is rendered in bold.

After onboarding, run:

```bash
tracker spotify login
tracker sync
tracker tui
```

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
You can do the entire setup manually without using `tracker onboarding`; the command is just a convenience layer over the same config file.

For LLM-backed recommendations, the config supports named profiles:

```json
{
  "llm": {
    "active_profile": "openai",
    "profiles": {
      "openai": {
        "provider": "openai",
        "model": "gpt-5.4",
        "api_key": ""
      },
      "anthropic": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "api_key": ""
      },
      "google": {
        "provider": "google",
        "model": "gemini-3.1-pro-preview",
        "api_key": ""
      },
      "ollama": {
        "provider": "openai_compat",
        "model": "qwen2.5:latest",
        "base_url": "http://localhost:11434/v1"
      },
      "deepseek": {
        "provider": "openai_compat",
        "model": "deepseek-chat",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": ""
      },
      "kimi": {
        "provider": "openai_compat",
        "model": "kimi-k2.5",
        "base_url": "https://api.moonshot.ai/v1",
        "api_key": ""
      }
    }
  }
}
```

Minimal manual config steps:

1. set `spotify.client_id` and `spotify.client_secret`
2. choose an `llm.active_profile` such as `openai`, `anthropic`, `google`, `ollama`, `deepseek`, or `kimi`
3. fill in `llm.profiles.<name>.provider`
4. fill in `llm.profiles.<name>.model`
5. fill in `llm.profiles.<name>.api_key` when that provider needs one
6. fill in `llm.profiles.<name>.base_url` for Ollama, DeepSeek, or Kimi when you want a non-default endpoint
7. adjust `pianists_allowlist` and `artists_blocklist` as needed

After saving the file, validate it with:

```bash
go run ./cmd/tracker config validate
```

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
- switch track ordering between recent, ID, top-played, and unrated-first views
- search tracks by title, artist, or album
- sync from Spotify
- edit ratings inline
- adaptive layout based on terminal size
- terminal-native styling instead of a hardcoded color theme

Main keys:

- `j` / `k` or arrow keys: move
- `g` / `G` or `home` / `end`: jump to top / bottom
- `o`: cycle sort order
- `/`: search by title, artist, or album
- `esc`: clear the active search filter
- `s`: sync
- `enter` or `e`: open rating editor
- `r`: reload
- `q`: quit

Inside search mode:

- type text: update the filter
- `backspace`: delete
- `enter`: keep the current filter and return to browsing
- `esc`: clear the filter and return to browsing

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
2. asks the active LLM profile for new pianist names only
3. validates those names against Spotify artist search

Supported providers today:

- OpenAI
- Anthropic
- Google Gemini
- OpenAI-compatible backends:
  - Ollama
  - Kimi
  - DeepSeek

The default LLM profile is `openai` using `gpt-5.4`, and that is currently the author's recommended choice.

Required configuration:

- either store an API key in `llm.profiles.<name>.api_key`
- or export a generic/provider-specific API key environment variable
- for Ollama, you usually do not need an API key

Generic overrides:

```bash
export LLM_API_KEY=...
export LLM_PROFILE=openai
export LLM_MODEL=gpt-5.4
export LLM_BASE_URL=https://api.openai.com/v1/responses
```

Provider-specific API key fallbacks:

```bash
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
export GOOGLE_API_KEY=...
export DEEPSEEK_API_KEY=...
export KIMI_API_KEY=...
```

Run:

```bash
go run ./cmd/tracker recommend pianists
go run ./cmd/tracker recommend pianists --limit 5
```

Examples:

```bash
LLM_PROFILE=openai go run ./cmd/tracker recommend pianists
LLM_PROFILE=anthropic go run ./cmd/tracker recommend pianists
LLM_PROFILE=google LLM_MODEL=gemini-3.1-pro-preview go run ./cmd/tracker recommend pianists
LLM_PROFILE=ollama LLM_PROVIDER=openai_compat LLM_MODEL=qwen2.5:latest LLM_BASE_URL=http://localhost:11434/v1 go run ./cmd/tracker recommend pianists
LLM_PROFILE=deepseek go run ./cmd/tracker recommend pianists
LLM_PROFILE=kimi go run ./cmd/tracker recommend pianists
```

`LLM_*` env vars override profile settings. Legacy `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL` still work for the OpenAI path for compatibility.

Notes:

- recommendation generation deliberately over-requests candidates before Spotify validation, so `--limit 5` still has a better chance of producing 5 validated pianists
- Anthropic and OpenAI-compatible backends may take one or more repair passes before the app gets a fully parseable recommendation list
- slower Gemini models may need noticeably longer response times than OpenAI

### Troubleshooting

- `json: unknown field ...` while loading config:
  your config likely uses the wrong field names or shape; check `llm.active_profile` and `llm.profiles.<name>.*`
- `API key is required`:
  either store the key in the active profile or export the matching env var such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, or `KIMI_API_KEY`
- `base URL` or connection failures with Ollama / DeepSeek / Kimi:
  verify `llm.profiles.<name>.base_url`
  Ollama should normally use `http://localhost:11434/v1`
  DeepSeek should normally use `https://api.deepseek.com/v1`
  Kimi should normally use `https://api.moonshot.ai/v1`
- malformed or partial recommendation output:
  the app already retries and repairs provider output, but weaker local or OpenAI-compatible models may still produce poor results
  if this happens repeatedly, try a stronger model or switch providers
- Gemini timeout or slow response:
  larger Gemini models can take noticeably longer than OpenAI or Anthropic
  if a model is consistently too slow, try a faster Gemini model or a different provider

## Current Limits

- filtering is based only on Spotify artist names plus your allowlist and blocklist
- classical metadata on streaming services is messy, so some recordings will be misclassified
- favorite-pianist ranking is deterministic but intentionally simple
- LLM-backed recommendations suggest pianists, not tracks
- the recommendation flow is only as good as the ratings and comments already in your local database
- provider behavior differs: Anthropic and some OpenAI-compatible models may need fallback repair passes, and slower Gemini models can take noticeably longer to respond

## Command Summary

```text
tracker config
tracker list
tracker onboarding
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
- `internal/llm/`: provider-agnostic recommendation layer
