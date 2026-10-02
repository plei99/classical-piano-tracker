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
tracker web --keep-running   # keep serving after the last tab closes
tracker-sandbox ts web       # the same, on a copy of your data
```

It stops by itself 3 seconds after its last browser tab closes (a reload
does not count), once any sync or rating save has finished, and prints
`All tabs closed; stopped the tracker web UI.` Until a tab has connected it
waits indefinitely, so `--no-open` still works. Each page holds
`GET /api/presence?token=<page token>`, an event stream of comments, open
for as long as it is open; if that stream stays down, the footer reports
that `tracker web` has stopped.

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
  choice is remembered per browser in the `tracker-theme` cookie, which
  the server reads to render the page in that theme (no flash, no boot
  script).

The TUI and the web UI share their state machine (`src/app/model.ts`),
their wording and layout decisions (`src/app/presenter.ts`), and the React
hook that runs them (`src/app/useTracker.ts`). Only the drawing differs:
Ink on a character grid in `src/tui`, React DOM with CSS in
`src/web/client`.

### How the work is split

The web UI is a hybrid: the server owns the library and the browser owns
the UI state.

- **The server** (`src/web/server`) reads tracks and ratings once, at
  startup and again on reload, after a sync, and when a rating is saved
  (each bumps the library's `version`). It keeps the list in all four sort
  orders and answers windowed queries with the TUI's own sort and search
  code (`LocalTrackList` in `src/app/list.ts`), so both front ends always
  agree. `GET /` is rendered on the server with `react-dom/server`: the
  first screen (newest first, first track selected, the first 100 rows),
  plus the data it was rendered from in
  `<script type="application/json" id="tracker-initial">`. Reloading the
  page shows the server's copy; r re-reads the database (say, after a
  `tracker sync` in another terminal).
- **The browser** hydrates that page (`hydrateRoot`) and runs the TUI's
  model over a `RemoteTrackList` (`src/web/client/remoteList.ts`): a
  sparse cache of rows for one sort, query, and library version. Moving
  between loaded rows never touches the network. The list pane fetches
  100-row chunks ahead of the selection and the scroll position (two
  screens each way), so holding j/k or scrolling does not reach an
  unloaded row in practice; one that has not arrived yet is drawn as a
  placeholder of the same height. g/G jump by index and fetch the window
  they land in.
- **The model** works over a small list interface (count, row lookup,
  index of a track; `TrackList` in `src/app/list.ts`). The TUI's in-memory
  list re-sorts and filters synchronously, exactly as before. A remote list
  turns re-sorting, searching, and reloading into `/api/view` requests
  (`around` keeps the selected track selected, as the TUI does); answers to
  superseded requests are dropped, and the counts and sort label describe
  the rows on screen until the new ones arrive. A saved rating shows at
  once; rows that later come back from a newer library version make the
  page refetch around the selection, keeping the old rows on screen until
  then.

The API (types and details in `src/web/api.ts`; the Rust build serves the
same one):

- `GET /`: the server-rendered page.
- `GET /api/view?sort=&q=&offset=&limit=[&around=]`: a window of the list,
  `{version, total, matched, offset, rows, index}`. Each row is
  `{track, rating, artists}`, plus `art` when the artwork cache already
  knows the track. `limit` is 1 to 500.
- `POST /api/reload`: re-reads the database, `{version, total}`.
- `POST /api/sync`: syncs with Spotify, then reloads the library.
- `POST /api/ratings`: saves a rating.
- `GET /api/artwork?ids=`: album art for up to 50 tracks.
- `GET /api/presence?token=`: the tab's presence stream.

Responses are compressed when the browser allows: the script and
stylesheet are compressed with brotli and gzip at build time
(`scripts/build.mjs`) and embedded that way, and JSON and HTML over 1 KiB
are compressed per response. The presence stream never is. The page
renderer (`src/web/server/page.tsx` with React's server renderer) is
embedded as a separate chunk that only `tracker web` evaluates, so it adds
nothing to the startup of other commands.

The server listens on 127.0.0.1 only and rejects other Host headers. Every
write, and the presence stream, needs a per-launch token embedded in the
page, so another site cannot keep the server running. Spotify's player
requires `'unsafe-eval'` in the page's script policy; only this app's
bundle and Spotify's scripts can run.

### Web UI performance compared with the other builds

These numbers predate the hybrid design above (they describe the TS build
downloading the whole library).

Measured with `scripts/bench-web` (on `main`): headless Chromium driving all
four `tracker web` builds round-robin, 5 runs, with every request outside
127.0.0.1 blocked. The machine carried unrelated background load (load
average about 7), so absolute times are inflated; the comparisons hold.
Medians in ms unless noted.

| 543 tracks (real data)                |        TS |         Go |                 Rust |      Swift |
| ------------------------------------- | --------: | ---------: | -------------------: | ---------: |
| Server ready                          |        36 |         14 |                   11 |         21 |
| Cold load to interactive              |        51 |         45 |                   59 |         44 |
| Warm reload to interactive            |        30 |         25 |                   31 |         28 |
| Cold transfer                         |   444 KiB |    134 KiB | 1,192 KiB (945 wasm) |    135 KiB |
| `j`: keydown to DOM / to next frame   | 0.9 / 4.9 | 6.9 / 21.2 |            0.9 / 4.8 | 7.0 / 21.4 |
| Sort (`o`) / search keystroke, to DOM | 1.9 / 1.0 |  6.2 / 6.7 |            1.8 / 0.9 |  6.0 / 6.6 |
| Enter to "Saved"                      |      16.8 |        4.7 |                 17.0 |        5.2 |
| Bytes per `j`                         |       721 |     45,078 |                  544 |     46,242 |
| Server memory after interactions      |    49 MiB |     41 MiB |                9 MiB |     27 MiB |
| Tab closed to process exit            |     3,018 |      3,013 |                3,013 |      3,022 |

| 25,000 tracks (synthetic)          |               TS |              Go |            Rust |           Swift |
| ---------------------------------- | ---------------: | --------------: | --------------: | --------------: |
| Server ready                       |               53 |             101 |              22 |             150 |
| Cold / warm load to interactive    |         114 / 95 |         73 / 59 |        121 / 98 |         63 / 52 |
| Cold transfer                      |        7,290 KiB |         131 KiB |       8,039 KiB |         133 KiB |
| `j` / `G` / `o`, to DOM            | 0.9 / 17.7 / 7.0 | 6.9 / 6.1 / 9.0 | 0.9 / 2.9 / 3.7 | 6.8 / 6.1 / 6.0 |
| Server memory after interactions   |          179 MiB |         441 MiB |          59 MiB |         208 MiB |
| Server CPU for the interaction run |               90 |             540 |              20 |             720 |

The two designs trade in opposite directions:

- **Client-side (TS, Rust):** keys never leave the page, so interaction is
  about 1 ms. The price is the download: the whole library arrives as JSON
  (7 MB at 25,000 tracks, uncompressed and refetched on every reload), and
  Rust's WebAssembly client is about 1 MB.
- **Server-driven (Go, Swift):** a page is about 130 KiB at any library
  size and the first rows arrive in the HTML, but every key is a localhost
  round trip that returns the re-rendered page body (about 45 KB per key).
  Server work and DOM update total about 1.7 ms; the rest of the 7 ms is
  the browser scheduling the response. Each tab's session also keeps its
  own copy of the library on the server.

No build compresses responses yet.

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
