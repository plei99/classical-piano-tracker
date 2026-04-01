# Development Plan

This document turns the architecture in `README.md` into an implementation sequence for the first usable version of the program.

## Goals

- Build a Go-only CLI/TUI application for tracking classical piano listening history from Spotify.
- Keep data local in SQLite and config/auth state in `~/.config/piano-tracker/config.json`.
- Ship the core sync and rating workflows before investing in TUI polish.
- Add a recommendation layer that combines deterministic favorite-pianist scoring with LLM-assisted pianist discovery.

## Principles

- Use Go for all application code.
- Use Cobra for CLI entrypoints.
- Use Bubble Tea and Lip Gloss for the TUI.
- Use SQLite via `modernc.org/sqlite`.
- Use `sqlc` for all DB access. Add or change SQL in source files first, then regenerate code.
- Keep network calls and DB writes asynchronous in the TUI via `tea.Cmd`.
- Enforce filtering strictly through `pianists_allowlist` and `artists_blocklist` from config.

## Phase 0: Repository Bootstrap

### Deliverables

- Standard project layout:
  - `cmd/tracker/main.go`
  - `internal/cli/`
  - `internal/tui/`
  - `internal/db/`
  - `internal/spotify/`
- Basic Go module dependencies added for:
  - `cobra`
  - `bubbletea`
  - `lipgloss`
  - `modernc.org/sqlite`
  - `sqlc` config support
  - Spotify client library

### Tasks

1. Create the directory layout from `README.md` and `AGENTS.md`.
2. Add a Cobra root command and wire it from `cmd/tracker/main.go`.
3. Add a minimal build target and verify the binary starts with `--help`.

### Exit Criteria

- `go build ./...` succeeds.
- Running `tracker --help` shows a root command.

## Phase 1: Config and App State

### Deliverables

- Config load/save support for `~/.config/piano-tracker/config.json`.
- Typed config structs for:
  - Spotify client credentials
  - OAuth token state
  - `pianists_allowlist`
  - `artists_blocklist`
- First-run behavior for missing config.

### Tasks

1. Add a config package or package-level support in the CLI layer for locating the config path.
2. Define JSON-backed structs with clear field names.
3. Implement:
  - load config
  - save config
  - validate required values
4. Decide and document first-run UX:
  - fail with an actionable message, or
  - add an explicit `init` or `login` command later

### Exit Criteria

- The app can read and write config safely.
- Missing or malformed config produces a clear error.

## Phase 2: Database Schema and `sqlc`

### Deliverables

- `internal/db/schema.sql`
- `internal/db/query.sql`
- `sqlc.yaml`
- Generated Go DB code

### Initial Schema

- `tracks`
  - unique `spotify_id`
  - track metadata needed for display and rating
  - `play_count`
  - `last_played_at`
- `ratings`
  - foreign key to `tracks`
  - `stars`
  - `opinion`
  - `updated_at`

### Required Queries

- Initialize schema
- Upsert track on sync
- List recent tracks
- List top-played tracks
- List unrated tracks
- Get track by ID or Spotify ID
- Insert or update rating

### Tasks

1. Write the schema with the `tracks` uniqueness rule on `spotify_id`.
2. Add the UPSERT query that increments `play_count` and updates timestamps.
3. Add read queries needed for CLI and TUI flows.
4. Run `sqlc generate` and integrate generated code into the app.

### Exit Criteria

- The schema matches the design.
- Generated code compiles cleanly.
- A local database file can be created and queried.

## Phase 3: Spotify Auth and Client

### Deliverables

- Spotify client initialization
- OAuth login flow with local callback server
- Token persistence in config
- Recent plays fetch support

### Tasks

1. Implement Spotify config validation.
2. Implement OAuth login:
  - start local callback server
  - exchange auth code for token
  - persist token to config
3. Implement token refresh handling.
4. Add a method to fetch the most recent played tracks.
5. Normalize Spotify responses into app-level track models.

### Exit Criteria

- A user can authenticate once and reuse saved credentials.
- The app can fetch recent listening history from Spotify.

## Phase 4: Sync Command

### Deliverables

- `tracker sync` command
- Filtering logic driven by config
- DB persistence of matching tracks
- Basic sync summary output

### Required Behavior

1. Fetch the 50 most recent plays from Spotify.
2. Skip a track if any artist is present in `artists_blocklist`.
3. Accept a track only if at least one artist is present in `pianists_allowlist`.
4. UPSERT the accepted track into `tracks`.
5. Increment `play_count` and update `last_played_at` rather than inserting duplicates.

### Tasks

1. Build a pure filtering function with tests.
2. Implement sync orchestration in the CLI layer.
3. Write accepted tracks using generated `sqlc` queries.
4. Print a useful summary:
  - fetched count
  - blocked count
  - accepted count
  - inserted or updated count

### Exit Criteria

- `tracker sync` works end to end.
- Duplicate listens update existing rows instead of creating new ones.

## Phase 5: Rating Workflow

### Deliverables

- `tracker rate` command
- DB support for creating and updating ratings
- Track lookup flow for choosing what to rate

### Tasks

1. Decide the CLI UX:
  - pass a track ID directly, or
  - open a selection flow from recent/unrated tracks
2. Implement rating validation for `stars` in the `1-5` range.
3. Persist `opinion` and `updated_at`.
4. Show the saved result back to the user.

### Exit Criteria

- A previously synced track can be rated and updated.
- Invalid ratings are rejected cleanly.

## Phase 6: Read-Only TUI

### Deliverables

- Bubble Tea application skeleton
- Track list view
- Track detail view
- Status and error handling

### Tasks

1. Define the top-level model and message types.
2. Add async commands for loading tracks from SQLite.
3. Render:
  - recent tracks
  - selected track metadata
  - play count
  - rating summary
4. Add loading and error states.

### Exit Criteria

- The TUI can browse locally synced data without blocking the update loop.

## Phase 7: Interactive TUI Actions

### Deliverables

- TUI-triggered sync
- TUI rating editor
- Non-blocking DB and network workflows

### Tasks

1. Add `tea.Cmd`-based sync execution.
2. Add `tea.Cmd`-based rating save execution.
3. Add keyboard navigation and shortcuts.
4. Ensure long-running operations never block `Update`.

### Exit Criteria

- Sync and rating both work inside the TUI.
- UI remains responsive during network and DB activity.

## Phase 8: Recommendations

### Deliverables

- Deterministic favorite-pianist calculation from local data
- CLI output for favorite pianists
- LLM-backed recommendation flow for discovering new pianists
- Validation layer for LLM-generated pianist suggestions

### Scope

- The deterministic layer ranks pianists already present in the local database.
- The LLM layer recommends new pianists, not specific tracks.
- The LLM should use star ratings and free-form rating comments as its main taste inputs.
- The app should validate suggested pianists before treating them as actionable recommendations.

### Tasks

1. Add a recommendation package for taste profiling and pianist ranking.
2. Decode track artist JSON and attribute ratings and play counts to pianist profiles.
3. Design a deterministic favorite score using:
  - average stars
  - number of rated tracks
  - replay count
  - a penalty for tiny sample sizes
4. Add a CLI command to print favorite pianists from the deterministic layer.
5. Build a compact taste summary from:
  - favorite pianists
  - highly rated tracks
  - low-rated tracks when available
  - free-form rating comments
6. Add an LLM-backed command that returns recommended new pianists in structured output.
7. Validate LLM pianist names against a real catalog or search endpoint before presenting them as actionable recommendations.
8. Degrade gracefully when there is too little ratings or comment data to make useful recommendations.

### Exit Criteria

- The app can rank favorite pianists deterministically from the local DB.
- The app can generate and validate new pianist recommendations from an LLM without relying on hallucinated track names.

## Phase 9: Testing and Hardening

### High-Priority Tests

- Config load/save behavior
- Filter logic
- UPSERT semantics
- Ratings persistence
- Spotify response mapping
- CLI command behavior for common failure paths
- Favorite-pianist scoring behavior
- Recommendation prompt/input shaping and structured output validation

### Tasks

1. Add unit tests around pure logic first.
2. Add DB-backed tests using temporary SQLite files.
3. Add integration coverage for sync orchestration where practical.
4. Add tests for recommendation ranking, sparse-data handling, and invalid LLM output.
5. Harden logging and error messages for auth, DB, config, and recommendation failures.

### Exit Criteria

- Core flows have regression coverage.
- Expected user errors produce actionable messages.

## Phase 10: Packaging and Usability

### Deliverables

- Polished CLI help text
- Setup instructions for first use
- Sensible defaults for local paths and DB creation
- Release-ready build flow

### Tasks

1. Improve command help and examples.
2. Document bootstrap steps in `README.md` once implementation stabilizes.
3. Add version metadata if needed.
4. Verify clean startup on a fresh machine state.

### Exit Criteria

- A new user can install, configure, sync, and rate tracks without code changes.

## Recommended Build Order

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 7
9. Phase 8
10. Phase 9
11. Phase 10

## First Implementation Slice

The smallest useful vertical slice is:

1. Bootstrap Cobra app
2. Implement config loading
3. Set up SQLite schema and `sqlc`
4. Implement Spotify auth
5. Ship `tracker sync`

That slice creates the first working product loop and should be completed before the TUI.
