// Turns raw.json into summary.md: one set of tables per dataset.
import { readFileSync, writeFileSync } from 'node:fs';

const ORDER = ['ts', 'go', 'rs', 'swift'];
const ARCH = { ts: 'hybrid (React)', go: 'server-driven', rs: 'client (Leptos/WASM)', swift: 'server-driven' };

export function pct(values, p) {
  const s = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  // nearest rank
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
const med = (v) => pct(v, 50);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const mp = (v, d = 1) => (v.length ? `${f(med(v), d)} (${f(pct(v, 95), d)})` : '–');
const kb = (b) => (Number.isFinite(b) ? (b / 1024).toFixed(1) : '–');

function table(head, rows) {
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map((h, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

export function summarize(raw) {
  const out = [];
  const m = raw.meta;
  out.push(`# tracker web benchmark${m.note ? ` (${m.note})` : ''}`);
  out.push('');
  out.push(
    `Started ${m.started}, finished ${m.finished ?? '?'}. ${m.runs} run(s) per build per dataset, builds interleaved round-robin (order rotated per run); ${m.coldSamplesPerRun} cold + ${m.coldSamplesPerRun} warm page loads per run; ${m.jPresses} \`j\` presses per run.`,
  );
  out.push(
    `${m.browser}, headless, viewport ${m.viewport.width}x${m.viewport.height}; Node ${m.node}; ${m.cpu} x${m.cpuCount}, ${m.memGiB} GiB; ${m.os}. Load average (1/5/15 min) at start ${m.loadavgStart.map((x) => x.toFixed(1)).join('/')}, at end ${m.loadavgEnd?.map((x) => x.toFixed(1)).join('/') ?? '?'}.`,
  );
  out.push('');
  out.push(
    table(
      ['build', 'architecture', 'binary', 'sha256[:16]', 'mtime', '--keep-running in help'],
      ORDER.filter((b) => m.binaries[b]).map((b) => [
        b,
        ARCH[b],
        `${(m.binaries[b].size / 2 ** 20).toFixed(1)} MiB`,
        m.binaries[b].sha256_16,
        m.binaries[b].mtime.slice(0, 16),
        m.binaries[b].keepRunningFlag ? 'yes' : 'no',
      ]),
    ),
  );
  const la = raw.segments.filter((x) => x.loadavgBefore).map((x) => x.loadavgBefore[0]);
  if (la.length)
    out.push(
      `1-min load average at the start of each build segment: median ${f(med(la))}, min ${f(Math.min(...la))}, max ${f(Math.max(...la))} (${la.length} segments).`,
    );
  out.push('');
  out.push('All times in ms; cells are `median (p95)` over all samples of all runs unless noted.');
  const errors = raw.segments.filter((s) => s.error);
  if (errors.length) {
    out.push('');
    out.push(
      `**${errors.length} segment(s) failed:** ${errors.map((e) => `${e.build}/${e.dataset}/run ${e.run + 1}: ${e.error.split('\n')[0]}`).join('; ')}`,
    );
  }

  for (const [dataset, info] of Object.entries(m.datasets)) {
    const segs = raw.segments.filter((s) => s.dataset === dataset && !s.error);
    const builds = ORDER.filter((b) => segs.some((s) => s.build === b));
    if (!builds.length) continue;
    const by = (b) => segs.filter((s) => s.build === b);
    const all = (b, fn) => by(b).flatMap(fn);
    out.push('');
    out.push(`## Dataset: ${dataset} (${info.tracks.toLocaleString('en-US')} tracks)`);
    out.push('');
    out.push('### Startup and page load');
    out.push('');
    out.push(
      table(
        [
          'build',
          'server ready',
          'cold: first row',
          'cold: first row frame',
          'cold: interactive',
          'cold: DCL',
          'cold: load',
          'warm: first row',
          'warm: interactive',
          'warm: load',
        ],
        builds.map((b) => {
          const cold = all(b, (s) => s.loads.map((l) => l.cold));
          const warm = all(b, (s) => s.loads.map((l) => l.warm));
          const ready = all(b, (s) => [s.ready, s.tabClose.ready]);
          return [
            b,
            mp(ready),
            mp(cold.map((x) => x.firstRow)),
            mp(cold.map((x) => x.firstRowFrame)),
            mp(cold.map((x) => x.interactiveFrame)),
            mp(cold.map((x) => x.dcl)),
            mp(cold.map((x) => x.load)),
            mp(warm.map((x) => x.firstRow)),
            mp(warm.map((x) => x.interactiveFrame)),
            mp(warm.map((x) => x.load)),
          ];
        }),
      ),
    );
    out.push('');
    out.push('### Transfer, cold load (KiB on the wire incl. headers; encoding)');
    out.push('');
    const types = ['html', 'js', 'css', 'wasm', 'json', 'sse', 'other'];
    out.push(
      table(
        ['build', 'total', ...types, 'requests', 'compressed?', 'warm reload total'],
        builds.map((b) => {
          const t = by(b).map((s) => s.transfer);
          const enc = new Set(t.flatMap((x) => Object.values(x.encodings).flat()));
          const warm = all(b, (s) => s.loads.map((l) => l.warm.wire));
          return [
            b,
            kb(med(t.map((x) => x.total))),
            ...types.map((ty) => (t.some((x) => x.byType[ty]) ? kb(med(t.map((x) => x.byType[ty] ?? 0))) : '–')),
            f(med(t.map((x) => x.requests)), 0),
            [...enc].join(', '),
            kb(med(warm)),
          ];
        }),
      ),
    );
    out.push('');
    out.push('### Interaction latency (keydown → next frame after the DOM shows the effect)');
    out.push('');
    const kinds = [
      ['j', '`j`'],
      ['G', '`G`'],
      ['g', '`g`'],
      ['o', '`o` sort'],
      ['slash', '`/`'],
      ['searchChar', 'search char'],
      ['escClear', 'Esc (clear query)'],
      ['escEmpty', 'Esc (empty)'],
      ['editOpen', '`e` editor'],
      ['editStars', 'star digit'],
      ['editSave', 'Enter → "Saved"'],
    ];
    out.push(
      table(
        ['build', ...kinds.map((k) => k[1])],
        builds.map((b) => [
          b,
          ...kinds.map(([k]) => {
            const v = all(b, (s) => s.interactions.samples[k] ?? []);
            const timeouts = v.filter((x) => x.timeout).length;
            return mp(v.filter((x) => !x.timeout).map((x) => x.frame)) + (timeouts ? ` **${timeouts} timeouts**` : '');
          }),
        ]),
      ),
    );
    out.push('');
    out.push('Same, keydown → DOM mutation that shows the effect (no frame wait): median (p95)');
    out.push('');
    out.push(
      table(
        ['build', ...kinds.map((k) => k[1])],
        builds.map((b) => [
          b,
          ...kinds.map(([k]) =>
            mp(
              all(b, (s) => s.interactions.samples[k] ?? [])
                .filter((x) => !x.timeout)
                .map((x) => x.dom),
            ),
          ),
        ]),
      ),
    );
    out.push('');
    out.push(
      'Cross-check, all measured keys: the in-page keydown → DOM time against a Playwright-side time on the Node clock (from calling `keyboard.press` until a page binding reports the same DOM state). The difference is CDP overhead and should be small and constant. Plus the wire cost of a key (local requests only):',
    );
    out.push('');
    out.push(
      table(
        [
          'build',
          'in-page keydown → DOM',
          'Playwright-side',
          'per-key difference (median, p95)',
          'bytes / `j`',
          'requests / `j`',
          'bytes / search char',
        ],
        builds.map((b) => {
          const v = all(b, (s) => Object.values(s.interactions.samples).flat()).filter(
            (x) => !x.timeout && x.pw != null,
          );
          return [
            b,
            mp(v.map((x) => x.dom)),
            mp(v.map((x) => x.pw)),
            mp(v.map((x) => x.pw - x.dom)),
            f(med(by(b).map((s) => s.interactions.bytesPerKey.j.bytes)), 0),
            f(med(by(b).map((s) => s.interactions.bytesPerKey.j.requests)), 2),
            f(med(by(b).map((s) => s.interactions.bytesPerKey.searchChar.bytes)), 0),
          ];
        }),
      ),
    );
    out.push('');
    out.push('### Resources (medians over runs)');
    out.push('');
    out.push(
      table(
        [
          'build',
          'server RSS idle (MiB)',
          'RSS after loads',
          'RSS after interactions',
          'server CPU / page load (ms)',
          'server CPU, interaction run (ms)',
          'page JS heap after load (MiB)',
          'page WASM memory (MiB)',
          'DOM nodes',
        ],
        builds.map((b) => {
          const S = by(b);
          return [
            b,
            f(med(S.map((s) => s.statsIdle?.rssMiB))),
            f(med(S.map((s) => s.statsAfterLoads?.rssMiB))),
            f(med(S.map((s) => s.interactions.statsAfterInteractions?.rssMiB))),
            f(med(S.map((s) => ((s.statsAfterLoads.cpuSec - s.statsIdle.cpuSec) * 1000) / s.pageLoadsForCpu))),
            f(
              med(
                S.map(
                  (s) =>
                    (s.interactions.statsAfterInteractions.cpuSec - s.interactions.statsAfterLoadPage.cpuSec) * 1000,
                ),
              ),
              0,
            ),
            f(med(S.map((s) => s.interactions.heap.jsHeapUsedMiB))),
            f(med(S.map((s) => s.interactions.heap.wasmMemoryMiB))),
            f(med(S.map((s) => s.interactions.heap.domNodes)), 0),
          ];
        }),
      ),
    );
    out.push('');
    out.push('### Tab close → server exit, and checks');
    out.push('');
    out.push(
      table(
        [
          'build',
          'close → exit (ms): median (min–max)',
          'j end row ok',
          'G/g ok',
          'sort cycle',
          'ratings saved (UI / DB)',
          'search status (first query)',
          'non-local server sockets',
          'outside requests answered',
        ],
        builds.map((b) => {
          const S = by(b);
          return [
            b,
            (() => {
              const v = S.map((s) => s.tabClose.exitAfterCloseMs).filter((x) => x != null);
              const codes = [
                ...new Set(S.filter((s) => s.tabClose.exitAfterCloseMs != null).map((s) => s.tabClose.exit?.code)),
              ];
              if (v.length === 0)
                return `n/a (alive after ${S[0].tabClose.waitedMs / 1000} s, ${S.length}/${S.length})`;
              return `${f(med(v), 0)} (${f(Math.min(...v), 0)}–${f(Math.max(...v), 0)}); auto-stopped ${v.length}/${S.length}, exit code ${codes.join('/')}`;
            })(),
            S.map((s) => (s.interactions.validation.jOk ? 'yes' : `no (${s.interactions.validation.jFinalY})`)).join(
              ', ',
            ),
            S.map((s) => (s.interactions.validation.gOk ? 'yes' : 'no')).join(', '),
            S[0].interactions.validation.sortLabels.slice(0, 4).join(' → '),
            S.map((s) => `${s.interactions.validation.savedCount}/${s.ratingsWritten}`).join(', '),
            `\`${S[0].interactions.validation.searchCounts[0] ?? ''}\``,
            S.map((s) => s.interactions.externalSockets.length).join(', '),
            S.map((s) => s.transfer.externalAnswered ?? '?').join(', '),
          ];
        }),
      ),
    );
  }
  out.push('');
  out.push(NOTES);
  return out.join('\n');
}

const NOTES = `## Reading these numbers

- **Server-driven (go, swift) vs client-side (ts, rs).** In go and swift every key is a POST to the server, which runs the model, renders HTML, and returns it for idiomorph to morph in; latency includes a localhost round trip, server render, and the morph, and each key costs server CPU and bytes on the wire. In ts and rs the model runs in the page, so a key costs no network at all (except saving a rating, which is a POST in every build). Interaction latencies therefore compare whole architectures, not the speed of the four languages.
- **"Next frame" quantizes.** Headless Chromium paints at 60 Hz, so the frame-based latency is the work plus the wait for the next vsync (0-16.7 ms). Two builds whose work fits inside one frame look the same; the DOM-mutation column shows the difference below a frame.
- **First row.** go and swift send the first rows in the HTML, so "first row" is essentially HTML parse time; ts and rs (hybrid) also server-render their first screen and then hydrate it once their bundle (and, for rs, the WASM module) has loaded. "Interactive" (the first \`j\` that moves the selection) is the comparable milestone: it needs the script and, for go/swift, the session's first server round trip.
- **Interactive probe.** From document start the page dispatches a synthetic \`j\` keydown every 5 ms until the selection moves, so "interactive" has ~5 ms resolution plus the effect's own latency. The probe's extra presses are why cold-load transfer is measured on a separate load without it. Its 5 ms timer also keeps the renderer awake, which makes server round trips during load slightly faster than they would be in an idle page (applies to all builds alike).
- **Transfer.** Wire bytes including headers, from the DevTools protocol. SSE is the bytes received on the event stream up to the end of the sample. All four builds window the list on the server: go and swift send rendered HTML for the rows in view, while ts and rs (hybrid) server-render the first screen and then fetch windows of rows from \`/api/view\` as needed, so no build's transfer grows with the library.
- **Server memory/CPU.** go and swift keep one session (model + rendered state) per tab for 60 s after it disconnects, so RSS after the page-load phase includes up to ~11 abandoned sessions. CPU per page load is (CPU after loads - idle CPU) / loads, from \`ps\` (10 ms resolution).
- **JS heap** is \`Runtime.getHeapUsage\` after a forced GC; it excludes the rs client's WebAssembly linear memory, which is listed separately.
- **Tab close → exit.** Builds without auto-stop never exit (n/a); the harness waits 6 s for them (15 s when \`web --help\` lists \`--keep-running\`) and then kills them. For all other measurements a build with \`--keep-running\` gets that flag, so it cannot stop between page loads.
- **Album art.** Every artwork lookup is answered from the pre-seeded \`artwork-cache.json\`; the image URLs and Spotify's scripts fail to resolve in the browser (host resolver rule), so nothing outside 127.0.0.1 is measured. "non-local server sockets" checks the server made no outside connections.`;

export function writeSummary(raw, path) {
  writeFileSync(path, summarize(raw));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const md = summarize(raw);
  if (process.argv[3]) writeFileSync(process.argv[3], md);
  else console.log(md);
}
