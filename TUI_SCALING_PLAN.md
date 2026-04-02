# TUI Scaling Plan

## Goal

Make the TUI remain correct and usable once the local SQLite database grows beyond 100 tracks.

The immediate problem is not raw performance. The current TUI loads only the 100 most recent rows from SQLite and then sorts that subset by local track ID. Once the database exceeds 100 rows, the TUI is no longer showing either the full library or the true recent-history ordering.

## Principles

- Fix correctness before optimizing.
- Keep the current Bubble Tea rendering model if it is still fast enough.
- Add user-facing controls for sorting and filtering before adding pagination.
- Only add database-level paging if real local performance becomes a problem.

## Phase 1: Correctness Fix

### Objective

Stop truncating the TUI track list to 100 rows.

### Changes

- Change the TUI track loader to read the full local corpus with `ListAllTracks` instead of `ListRecentTracks(..., 100)`.
- Keep the current in-memory scrolling/windowing behavior.
- Keep the current default visible ordering explicit.

### Chosen default ordering

Use `recent desc` as the default ordering.

Reason:

- it matches user expectation for a listening-history browser
- it aligns with the sync flow
- it makes the first screen immediately useful once the library grows

`id asc` should still be available later as an explicit alternate sort mode.

### Exit criteria

- The TUI can browse every locally stored track, not just the latest 100.
- The visible ordering matches the documented default.
- Reload and post-sync refresh still work.

## Phase 2: Sorting Modes

### Objective

Let users change the list ordering without leaving the TUI.

### Recommended sort modes

- `id`
- `recent`
- `top played`
- `unrated first`

### UX

- Add a small sort indicator in the list header or status bar.
- Add a keybinding to cycle sort modes, or a compact sort menu.

Suggested first key:

- `o`: cycle ordering

### Exit criteria

- Users can switch sort modes from the keyboard.
- The selected sort mode is visible on screen.
- Track selection remains stable enough to avoid disorienting jumps.

## Phase 3: Search and Filtering

### Objective

Make larger local libraries navigable without forcing users to scroll manually.

### Recommended filters

- substring match on track title
- substring match on artist names
- substring match on album name

### UX

- `/`: enter search mode
- `esc`: clear/cancel search
- keep filtering local and immediate

### Notes

- Search should operate on the already-loaded in-memory track list in the first version.
- The status line should show active search text and result count.

### Exit criteria

- Users can narrow the visible track list interactively.
- Search works with the current sort mode.
- Selection resets predictably when the filtered set changes.

## Phase 4: Performance Review

### Objective

Measure whether full in-memory loading is still acceptable.

### What to check

- startup time with a few hundred rows
- startup time with a few thousand rows
- memory use in normal operation
- responsiveness while scrolling
- responsiveness while filtering

### Decision rule

If the TUI remains responsive at realistic local-library sizes, stop here and do not add paging yet.

## Phase 5: Database Paging, If Needed

### Objective

Add incremental loading only if full local loading becomes meaningfully slow.

### Possible design

- fetch rows in chunks, for example 100 or 200 at a time
- preserve current sort mode in SQL where possible
- load additional chunks when the cursor approaches the end of the loaded slice
- keep search local for loaded rows first, or move to query-backed search later if necessary

### Risks

- more state complexity in the Bubble Tea model
- harder selection persistence across reloads and sort changes
- more SQL/query surface to maintain

### Exit criteria

- paging improves responsiveness measurably
- the TUI remains simpler to use than the CLI

## Recommended Implementation Order

1. Replace the 100-row TUI load with full-track loading.
2. Decide and document the default ordering.
3. Add sort modes.
4. Add local search/filtering.
5. Benchmark before deciding on pagination.

## Non-Goals For This Pass

- changing rating behavior
- changing sync behavior
- adding remote search
- adding recommendation views
- redesigning the TUI layout

## Success Definition

The TUI should remain correct and pleasant once the database exceeds 100 rows, with users able to:

- see the full local corpus
- switch among useful orderings
- find tracks quickly without excessive scrolling

Only after that should we consider database-level pagination.
