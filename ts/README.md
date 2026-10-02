# tracker (TypeScript + Ink rewrite, experimental)

A full port of the Go `tracker` CLI/TUI to TypeScript, using Ink for the
terminal UI. It reads and writes the same config file and SQLite database as
the Go build, so the two can be used interchangeably.

## Build and test

```bash
cd ts
npm install
npm run build        # dist/tracker.js: runs on Node >= 24 or Bun
npm run build:bin    # dist/tracker: single-file Bun executable (needs bun)
npm run typecheck
npm test
npx vitest bench --run src/tui   # TUI benchmarks
```

`TRACKER_VERSION`, `TRACKER_COMMIT` and `TRACKER_BUILD_DATE` override the
build metadata the build script otherwise reads from git. `TRACKER_MINIFY=0`
keeps the bundle readable for CPU profiles.

## Web UI

```bash
tracker web                  # serves http://127.0.0.1:8765/ and opens your browser
tracker web --port 9000 --no-open
tracker-sandbox ts web       # the same, on a copy of your data
```

The web UI looks like the TUI and uses the same keys: j/k, g/G, `/` to
search, o to sort, s to sync, e or Enter to rate, and r to reload. It
adds:

- **Album art** in every row and large in the detail pane. It is looked up
  through Spotify's API, falling back to Spotify's public oEmbed endpoint
  when there is no usable token, and cached in `artwork-cache.json` next
  to the database.
- **Play** (or p), which plays in the page through Spotify's embed. That
  is the full track when this browser is signed in to Spotify Premium, and
  a 30-second preview otherwise. The player is docked above the footer and
  keeps playing while you browse.
- **Open in Spotify** (or a), a `spotify:track:` link that macOS hands to
  the Spotify app.
- **A light/dark/auto switch.** Auto follows the system setting; your
  choice is remembered per browser.

The TUI and the web UI share their state machine (`src/app/model.ts`),
their wording and layout decisions (`src/app/presenter.ts`), and the React
hook that runs them (`src/app/useTracker.ts`). Only the drawing differs:
Ink on a character grid in `src/tui`, React DOM with CSS in
`src/web/client`.

The server listens on 127.0.0.1 only and rejects other Host headers. Every
write needs a per-launch token embedded in the page. Spotify's player
requires `'unsafe-eval'` in the page's script policy; only this app's
bundle and Spotify's scripts can run.

## Layout

| Directory       | Ports                   | Notes                                                                                                                                                                                              |
| --------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core`      | `config`, `paths`, `db` | `node:sqlite` (built into Node and Bun, so no native modules). The SQL is imported from `../internal/db/*.sql`, the same files sqlc uses. Configs round-trip byte for byte, token expiry included. |
| `src/spotify`   | `spotify`, `syncer`     | OAuth and Web API over `fetch`. The sync checkpoint is a bigint of nanoseconds, parsed without going through `Date`.                                                                               |
| `src/recommend` | `recommend`             | Go-exact `math.Log1p`, emulated fused multiply-add (Go fuses on arm64), `%.2f` rounding, and `json.Unmarshal` semantics.                                                                           |
| `src/llm`       | `llm`, `llm/providers`  | Prompts and request bodies are checked against captured Go output.                                                                                                                                 |
| `src/app`       | (shared)                | State machine, presenter, and React hook used by both the TUI and the web UI.                                                                                                                      |
| `src/tui`       | `tui`                   | A pure reducer plus Ink rendering. Frames match Go's goldens character for character.                                                                                                              |
| `src/web`       | (new)                   | `tracker web`: a local HTTP server (`server/`) and the React DOM client (`client/`), bundled into the binary.                                                                                      |
| `src/cli`       | `cli`, `buildinfo`      | commander. stdout, errors and exit codes match Go. Ink and React are only loaded by commands that draw.                                                                                            |

## Compared with the other builds

Measured on one Apple Silicon Mac against a copy of a real database (543
tracks, 205 ratings). All five release builds ran interleaved in one
session, and each figure is the median wall time including process start.

|                                   | Go      | Rust    | TS (Bun binary) | Python (PyApp binary) | Swift   |
| --------------------------------- | ------- | ------- | --------------- | --------------------- | ------- |
| Artifact size                     | 23.3 MB | 6.4 MB  | 63.1 MB         | 33.5 MB               | 4.4 MB  |
| `tracker version`                 | 7.7 ms  | 3.0 ms  | 25.0 ms         | 38.8 ms               | 6.4 ms  |
| `tracker list recent --limit 50`  | 8.2 ms  | 4.2 ms  | 27.8 ms         | 47.5 ms               | 9.0 ms  |
| `tracker recommend profile`       | 9.4 ms  | 4.4 ms  | 32.1 ms         | 57.5 ms               | 10.9 ms |
| `tracker tui` to first list frame | 21.1 ms | 12.2 ms | 65.8 ms         | 124.0 ms              | 14.6 ms |
| TUI keypress to redraw            | 9.6 ms  | 0.75 ms | 9.2 ms          | 3.6 ms                | 0.46 ms |

The Python binary unpacks itself into a cache on its first run, which takes
about 1.4 s; the figures above are for later runs.

- **Startup** is mostly runtime and module evaluation. Bun starts about 2–3×
  faster than Node, and the compiled binary is the fastest TypeScript
  option. In an earlier run, the same bundle on Node took 73 ms for
  `tracker version` and 136 ms to the first TUI frame.
- **Keypress latency** is computation, not waiting. Ink's default 30 fps cap
  added about 20 ms, so it is raised to 1000. What remains is about 2 ms of
  React reconciliation plus about 5 ms of Ink building the 160×48 frame,
  both inside the libraries. That lands level with Go, which waits for
  Bubble Tea's frame tick, and well behind Rust and Swift, which redraw
  immediately.

Output is byte-identical to Go for every read-only command checked, and so
are argument and validation errors. TUI screens are identical too, checked
through a terminal emulator at five sizes while browsing, scrolling,
rating, searching and sorting. Known differences:

- Help layout follows commander, not cobra. There is no `completion` subcommand.
- Spotify API errors include the HTTP status, and requests time out after 30 s.
- When a hand-edited `artists` column holds `null`, re-encoding writes `[]`.
