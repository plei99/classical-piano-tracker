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

## Layout

| Directory       | Ports                   | Notes                                                                                                                                                                                              |
| --------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core`      | `config`, `paths`, `db` | `node:sqlite` (built into Node and Bun, so no native modules). The SQL is imported from `../internal/db/*.sql`, the same files sqlc uses. Configs round-trip byte for byte, token expiry included. |
| `src/spotify`   | `spotify`, `syncer`     | OAuth and Web API over `fetch`. The sync checkpoint is a bigint of nanoseconds, parsed without going through `Date`.                                                                               |
| `src/recommend` | `recommend`             | Go-exact `math.Log1p`, emulated fused multiply-add (Go fuses on arm64), `%.2f` rounding, and `json.Unmarshal` semantics.                                                                           |
| `src/llm`       | `llm`, `llm/providers`  | Prompts and request bodies are checked against captured Go output.                                                                                                                                 |
| `src/tui`       | `tui`                   | A pure reducer plus Ink rendering. Frames match Go's goldens character for character.                                                                                                              |
| `src/cli`       | `cli`, `buildinfo`      | commander. stdout, errors and exit codes match Go. Ink and React are only loaded by commands that draw.                                                                                            |

## Compared with the Go and Rust builds

These numbers come from one Apple Silicon Mac and a copy of a real database
with 543 tracks and 205 ratings. All builds ran interleaved; each figure is
the median wall time, including process start.

|                                   | Go      | Rust    | TS (Bun binary) | TS (Node)     |
| --------------------------------- | ------- | ------- | --------------- | ------------- |
| Artifact size                     | 23.3 MB | 6.4 MB  | 62.9 MB         | 0.6 MB + Node |
| `tracker version`                 | 8.2 ms  | 2.9 ms  | 25.1 ms         | 73.0 ms       |
| `tracker list recent --limit 50`  | 8.8 ms  | 4.2 ms  | 28.4 ms         | 75.4 ms       |
| `tracker recommend profile`       | 10.2 ms | 4.6 ms  | 33.1 ms         | 82.7 ms       |
| `tracker tui` to first list frame | 22.3 ms | 11.8 ms | 66.6 ms         | 136.4 ms      |
| TUI keypress to redraw            | 9.6 ms  | 1.1 ms  | 9.3 ms          | 8.8 ms        |

- **Startup** is mostly runtime and module evaluation. Bun starts about 2–3×
  faster than Node, and the compiled binary is the fastest TypeScript
  option.
- **Keypress latency** is computation, not waiting. Ink's default 30 fps cap
  added about 20 ms, so it is raised to 1000. What remains is about 2 ms of
  React reconciliation plus about 5 ms of Ink building the 160×48 frame,
  both inside the libraries. That lands level with Go, which waits for
  Bubble Tea's frame tick, and well behind Rust, which redraws immediately.

Output is byte-identical to Go for every read-only command checked, and so
are argument and validation errors. TUI screens are identical too, checked
through a terminal emulator at five sizes while browsing, scrolling,
rating, searching and sorting. Known differences:

- Help layout follows commander, not cobra. There is no `completion` subcommand.
- Spotify API errors include the HTTP status, and requests time out after 30 s.
- When a hand-edited `artists` column holds `null`, re-encoding writes `[]`.
