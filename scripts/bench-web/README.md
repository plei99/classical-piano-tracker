# bench-web

Benchmarks `tracker web`. The default build, `ts`, is the installed
`tracker` (or `tracker-ts` if present) in `--bindir`. Other builds are named
`tracker-<build>` there, so the harness can still compare against the
archived Go, Rust, and Swift web UIs (tags `archive/go-web`,
`archive/rust-web`, `archive/swift-web`) if you build them.

## Run

```bash
cd scripts/bench-web && npm install          # once: playwright-core only
node scripts/bench-web/bench.mjs             # tracker-ts, both datasets, 3 runs
node scripts/bench-web/bench.mjs --datasets large --runs 5 --note "quiet machine"
```

Options: `--builds ts` (comma-separated), `--datasets real,large`, `--runs 3`, `--cold 5` (cold+warm load
pairs per run), `--j 250` (`j` presses per run), `--bindir ~/.local/bin`, `--chrome <path>` (default:
Playwright's chromium-1243), `--out <dir>`, `--note <text>`, `--regen` (rebuild the synthetic DB).
A full default run takes about 10 minutes.

Output: `results/<timestamp>/raw.json` (every sample) and `results/<timestamp>/summary.md` (tables per
dataset, plus notes on what is and is not comparable). `node lib/report.mjs raw.json [summary.md]`
re-renders a summary.

## Data

- **real**: the sandbox (`tracker-sandbox path`) snapshotted once per benchmark with SQLite's online
  backup (the sandbox is only read), then copied fresh for every server. Tracks the sandbox's
  `artwork-cache.json` does not cover get placeholder entries in the copy, so no server looks art up on
  Spotify. The config is the sandbox's (it is never printed).
- **large**: 25,000 synthetic tracks built from `internal/db/schema.sql` by `lib/data.mjs`
  (deterministic, seed 42): composer/work/movement titles, `["Composer","Pianist", ...]` artists JSON,
  ~7,000 albums, long-tailed play counts, two years of timestamps, ~8% rated. Its
  `artwork-cache.json` (the TypeScript `ArtworkService` format: `{"version":1,"artwork":{id:{small,medium,large}|null}}`)
  covers every track, and its config has no Spotify token. Cached in `results/data/large`.

## Method

Each run walks the datasets, and within a dataset the builds round-robin (order rotated each run). For
one build:

1. **Tab close → exit**: start a server without `--keep-running`, open a tab, close it, and time until
   the process exits (wait 15 s if `web --help` lists `--keep-running`, else 6 s; then "n/a" and kill).
   Done first, so a build that stops itself without offering `--keep-running` is detected; it would
   then be kept alive by an extra open tab.
2. **Server ready**: spawn → first `200` on `GET /` (polled every 2 ms). The main server gets
   `--keep-running` when the build has it.
3. **Page load** (`--cold` times): a new browser context per cold load, then a reload in the same
   context (warm, HTTP cache). From the page's Navigation Timing origin: first `li.row` in the DOM
   (MutationObserver) and the frame after it, DOMContentLoaded, load, and **interactive**: an injected
   script dispatches a `j` keydown every 5 ms from document start until the selection moves.
4. **Transfer**: one more cold load without the probe; wire bytes per response type from the DevTools
   protocol, plus `Content-Encoding`.
5. **Interactions** in a fresh tab: 250 × `j`, 5 × `G`/`g`, 8 × `o`, 3 × (`/`, each character of a
   query, Esc), 5 × (`/`, Esc), 10 × (`e`, star digit, Enter until "Saved N/5 rating..."). Each key is
   timed in the page from the keydown's `timeStamp` to the DOM mutation that shows its effect (a
   per-action predicate on shared selectors), and to the next `requestAnimationFrame` after that.
   Nothing polls while a key is in flight: a rAF loop or a timer changes how fast Chromium delivers the
   server's response (measured: a rAF loop roughly doubled go's `j`; a 4 ms timer halved it).
   Cross-check: Node times the same key from `keyboard.press` until a page binding reports the
   predicate (independent clock); the two agree within ~0.5 ms. After each phase the run checks
   effects (`j` ends on row 250, `G`/`g` reach the ends, the sort labels cycle, ratings reach the DB).
6. **Resources**: server RSS and CPU time (`ps`, process tree) idle, after the page loads, and after the
   interactions; page JS heap after GC, WASM linear memory, and DOM nodes.

The browser is Playwright's headless Chromium with a fixed 1400×900 viewport. Everything except
127.0.0.1 goes to a dead proxy, so album art and Spotify's scripts fail at once (this machine's system
proxy makes `--host-resolver-rules` ineffective, and request interception would disable the HTTP
cache). The summary reports outside requests that got an answer (should be 0) and any non-local
sockets the server holds.

See the "Reading these numbers" section of each summary for which metrics compare architectures
rather than implementations.
