#!/usr/bin/env node
// Benchmarks `tracker web` builds. See README.md.
//
//   node scripts/bench-web/bench.mjs [--builds ts] [--runs 3] [--datasets real,large]
//        [--cold 5] [--j 250] [--note "text"] [--regen]
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync, writeFileSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { homedir, loadavg, cpus, totalmem, tmpdir, release } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { ensureSynthetic, freshCopy, prepareReal } from './lib/data.mjs';
import { externalSockets, probeBinary, processStats, startServer, stopServer, waitExit } from './lib/server.mjs';
import { writeSummary } from './lib/report.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const { values: args } = parseArgs({
  options: {
    builds: { type: 'string', default: 'ts' },
    datasets: { type: 'string', default: 'real,large' },
    runs: { type: 'string', default: '3' },
    cold: { type: 'string', default: '5' },
    j: { type: 'string', default: '250' },
    bindir: { type: 'string', default: join(homedir(), '.local/bin') },
    chrome: { type: 'string' },
    out: { type: 'string', default: join(HERE, 'results') },
    note: { type: 'string', default: '' },
    regen: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
});
const BUILDS = args.builds
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/** `tracker-<build>` in --bindir; the `ts` build falls back to the installed `tracker`. */
function binFor(build) {
  const variant = join(args.bindir, `tracker-${build}`);
  return build === 'ts' && !existsSync(variant) ? join(args.bindir, 'tracker') : variant;
}
const DATASETS = args.datasets
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const RUNS = Number(args.runs);
const COLD = Number(args.cold);
const J_PRESSES = Number(args.j);
const CHROME =
  args.chrome ??
  process.env.CHROME_PATH ??
  join(
    homedir(),
    'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );
const INPAGE = readFileSync(join(HERE, 'lib/inpage.js'), 'utf8');
const VIEWPORT = { width: 1400, height: 900 };
const SEARCH = { real: 'piano sonata', large: 'piano concerto' };
const RATINGS = 10;

const log = (...a) => args.quiet || console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Network accounting over CDP (no request interception, so the HTTP cache stays on) ----

function classify(r) {
  const mime = (r.mime ?? '').toLowerCase();
  if (mime.includes('event-stream')) return 'sse';
  if (mime.includes('html')) return 'html';
  if (mime.includes('javascript')) return 'js';
  if (mime.includes('css')) return 'css';
  if (mime.includes('wasm')) return 'wasm';
  if (mime.includes('json')) return 'json';
  return 'other';
}

async function netTracker(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const reqs = new Map();
  const t = { reqs, wire: 0, cdp };
  const get = (id) => reqs.get(id) ?? reqs.set(id, { bytes: 0, streamed: 0 }).get(id);
  cdp.on('Network.requestWillBeSent', (e) => {
    const r = get(e.requestId);
    Object.assign(r, { url: e.request.url, method: e.request.method });
  });
  cdp.on('Network.responseReceived', (e) => {
    const r = get(e.requestId);
    const h = Object.fromEntries(Object.entries(e.response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (local(r)) t.wire += e.response.encodedDataLength ?? 0;
    Object.assign(r, {
      headerBytes: e.response.encodedDataLength ?? 0,
      mime: e.response.mimeType,
      status: e.response.status,
      encoding: h['content-encoding'] ?? null,
      cacheControl: h['cache-control'] ?? null,
      fromCache: Boolean(e.response.fromDiskCache || e.response.fromMemoryCache || e.response.fromPrefetchCache),
    });
  });
  cdp.on('Network.requestServedFromCache', (e) => (get(e.requestId).fromCache = true));
  const local = (r) => r.url?.startsWith('http://127.0.0.1') ?? false;
  cdp.on('Network.dataReceived', (e) => {
    // Chromium reports encodedDataLength 0 for chunks of a response still
    // streaming (SSE); its decoded length is the same here (no server compresses).
    const r = get(e.requestId);
    const n = e.encodedDataLength || e.dataLength;
    r.streamed += n;
    r.bytes = Math.max(r.bytes, r.streamed + (r.headerBytes ?? 0));
    if (local(r)) t.wire += n;
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = get(e.requestId);
    if (local(r)) t.wire += Math.max(0, e.encodedDataLength - r.streamed - (r.headerBytes ?? 0));
    r.bytes = e.encodedDataLength;
    r.done = true;
  });
  cdp.on('Network.loadingFailed', (e) =>
    Object.assign(get(e.requestId), { failed: e.errorText, blocked: e.blockedReason ?? null }),
  );
  t.reset = () => {
    reqs.clear();
    t.wire = 0;
  };
  t.summary = () => {
    const byType = {};
    const encodings = {};
    let local = 0;
    let external = 0;
    let externalAnswered = 0;
    let fromCache = 0;
    for (const r of reqs.values()) {
      if (!r.url) continue;
      const isLocal = r.url.startsWith('http://127.0.0.1');
      if (!isLocal) {
        external++;
        if (r.status !== undefined) externalAnswered++;
        continue;
      }
      local++;
      if (r.fromCache) fromCache++;
      const type = classify(r);
      byType[type] = (byType[type] ?? 0) + r.bytes;
      (encodings[type] ??= new Set()).add(r.encoding ?? 'identity');
    }
    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    return {
      total,
      byType,
      encodings: Object.fromEntries(Object.entries(encodings).map(([k, v]) => [k, [...v]])),
      requests: local,
      fromCache,
      externalBlocked: external,
      externalAnswered,
      list: [...reqs.values()]
        .filter((r) => r.url?.startsWith('http://127.0.0.1'))
        .map((r) => ({
          path: new URL(r.url).pathname,
          method: r.method,
          type: classify(r),
          status: r.status,
          bytes: r.bytes,
          encoding: r.encoding,
          cacheControl: r.cacheControl,
          fromCache: r.fromCache ?? false,
          done: r.done ?? false,
        })),
    };
  };
  return t;
}

// ---- Browser helpers ----

async function newContext(browser, { probe }) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  // Called by the page the moment the armed predicate first holds; Node times it on its own clock.
  ctx.__seen = null;
  await ctx.exposeBinding('__benchSeen', () => ctx.__seen?.());
  await ctx.addInitScript(`window.__benchOptions = ${JSON.stringify({ probe, probeIntervalMs: 5 })};`);
  await ctx.addInitScript(INPAGE);
  return ctx;
}

async function pageTimings(page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const m = window.__bench.marks;
    return {
      ttfb: nav.responseStart,
      htmlDone: nav.responseEnd,
      dcl: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      fcp: m.fcp ?? null,
      firstRow: m.firstRow ?? null,
      firstRowFrame: m.firstRowFrame ?? null,
      interactive: m.interactive ?? null,
      interactiveFrame: m.interactiveFrame ?? null,
      probeKeys: window.__bench.probeDispatched,
    };
  });
}

const settled = () =>
  window.__bench.marks.interactiveFrame !== undefined &&
  window.__bench.marks.firstRowFrame !== undefined &&
  document.readyState === 'complete' &&
  performance.getEntriesByType('navigation')[0].loadEventEnd > 0;

/** One cold load in a new context, then one warm reload in the same context. */
async function loadSamples(browser, url) {
  const ctx = await newContext(browser, { probe: true });
  try {
    const page = await ctx.newPage();
    const net = await netTracker(page);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(settled, null, { timeout: 30000, polling: 10 });
    await sleep(300);
    const cold = { ...(await pageTimings(page)), wire: net.summary().total };
    net.reset();
    await page.reload({ waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(settled, null, { timeout: 30000, polling: 10 });
    await sleep(300);
    const t = net.summary();
    const warm = { ...(await pageTimings(page)), wire: t.total, requests: t.requests, fromCache: t.fromCache };
    return { cold, warm };
  } finally {
    await ctx.close();
  }
}

/** A cold load without the `j` probe, for bytes on the wire. */
async function transferSample(browser, url) {
  const ctx = await newContext(browser, { probe: false });
  try {
    const page = await ctx.newPage();
    const net = await netTracker(page);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__bench.marks.firstRowFrame !== undefined, null, { timeout: 30000 });
    await sleep(1500);
    return net.summary();
  } finally {
    await ctx.close();
  }
}

async function heapStats(page, net) {
  const cdp = net.cdp;
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const wasm = await page.evaluate(() => window.__bench.wasmMemories.reduce((a, mem) => a + mem.buffer.byteLength, 0));
  return {
    jsHeapUsedMiB: heap.usedSize / 2 ** 20,
    domNodes: m.Nodes,
    jsEventListeners: m.JSEventListeners,
    wasmMemoryMiB: wasm / 2 ** 20,
  };
}

/** Arms the in-page measurement, presses the key, and waits for the effect two ways. */
async function measure(page, kind, arg, key) {
  const evKey = key === 'Space' ? ' ' : key;
  await page.evaluate(([k, a, key]) => void window.__bench.arm(k, a, key), [kind, arg, evKey]);
  const ctx = page.context();
  let timer;
  const seen = new Promise((resolve) => {
    ctx.__seen = () => resolve(performance.now());
    timer = setTimeout(() => resolve(null), 5000);
  });
  const t0 = performance.now();
  await page.keyboard.press(key);
  const t1 = await seen;
  clearTimeout(timer);
  ctx.__seen = null;
  const r = await page.evaluate(() => window.__bench.wait(1000));
  return { ...r, pw: t1 === null ? null : t1 - t0 };
}

const selectedState = (page) => page.evaluate(() => window.__bench.state());

async function interactionRun(browser, url, srv, dataset) {
  const ctx = await newContext(browser, { probe: false });
  const out = { samples: {}, validation: {}, bytesPerKey: {} };
  const add = (label, r) => (out.samples[label] ??= []).push(r);
  try {
    const page = await ctx.newPage();
    const net = await netTracker(page);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__bench.state().selected !== null, null, { timeout: 30000 });
    await sleep(1000);
    out.heap = await heapStats(page, net);
    out.statsAfterLoadPage = await processStats(srv.pid);
    const gap = () => sleep(10);

    // Warm up: one unmeasured j, then back to the top.
    await measure(page, 'selChange', null, 'j');
    await measure(page, 'selChange', null, 'g');
    await gap();

    // j x N
    let wire0 = net.wire;
    let req0 = net.reqs.size;
    for (let i = 0; i < J_PRESSES; i++) {
      add('j', await measure(page, 'selChange', null, 'j'));
      await gap();
    }
    await sleep(200);
    const jReqs = [...net.reqs.values()].slice(req0).filter((r) => r.url?.startsWith('http://127.0.0.1'));
    const byPath = {};
    for (const r of jReqs) {
      const k = `${r.method} ${new URL(r.url).pathname}`;
      byPath[k] = byPath[k] ?? { n: 0, bytes: 0 };
      byPath[k].n++;
      byPath[k].bytes += r.bytes;
    }
    out.bytesPerKey.j = { bytes: (net.wire - wire0) / J_PRESSES, requests: jReqs.length / J_PRESSES, byPath };
    const afterJ = await selectedState(page);
    out.validation.jFinalY = afterJ.selectedY;
    out.validation.jOk = afterJ.selectedY === J_PRESSES * 60;

    // G / g jumps
    const total = Number(/^(\d+) loaded/.exec(afterJ.summary)?.[1]);
    out.validation.gJumps = [];
    for (let i = 0; i < 5; i++) {
      add('G', await measure(page, 'selChange', null, 'G'));
      const sG = await selectedState(page);
      await gap();
      add('g', await measure(page, 'selChange', null, 'g'));
      const sg = await selectedState(page);
      out.validation.gJumps.push(sG.selectedY === (total - 1) * 60 && sg.selectedY === 0);
      await gap();
    }
    out.validation.gOk = out.validation.gJumps.every(Boolean);

    // o: two full sort cycles
    out.validation.sortLabels = [];
    for (let i = 0; i < 8; i++) {
      add('o', await measure(page, 'sortChange', null, 'o'));
      out.validation.sortLabels.push(/ sort: (.+)$/.exec((await selectedState(page)).summary)?.[1]);
      await gap();
    }

    // Search: '/', each character of the query, Esc (clears); then '/'+Esc with no query.
    const query = SEARCH[dataset];
    wire0 = net.wire;
    let chars = 0;
    out.validation.searchCounts = [];
    for (let round = 0; round < 3; round++) {
      add('slash', await measure(page, 'search', '', '/'));
      await page.waitForFunction(() => document.activeElement?.matches('input[type=search]'), null, { timeout: 5000 });
      for (let i = 0; i < query.length; i++) {
        const ch = query[i];
        add('searchChar', await measure(page, 'search', query.slice(0, i + 1), ch === ' ' ? 'Space' : ch));
        chars++;
        await gap();
      }
      if (round === 0) out.validation.searchCounts.push((await selectedState(page)).status);
      add('escClear', await measure(page, 'searchExit', null, 'Escape'));
      await gap();
    }
    out.bytesPerKey.searchChar = { bytes: (net.wire - wire0) / chars };
    for (let i = 0; i < 5; i++) {
      add('slash', await measure(page, 'search', '', '/'));
      await page.waitForFunction(() => document.activeElement?.matches('input[type=search]'), null, { timeout: 5000 });
      add('escEmpty', await measure(page, 'searchExit', null, 'Escape'));
      await gap();
    }

    // Rating editor: open, set stars, save until "Saved" shows (writes to this run's DB copy).
    const saved = [];
    for (let i = 0; i < RATINGS; i++) {
      await measure(page, 'selChange', null, 'j');
      await gap();
      add('editOpen', await measure(page, 'editorOpen', null, 'e'));
      const stars = 1 + (i % 5);
      add('editStars', await measure(page, 'stars', stars, String(stars)));
      const r = await measure(page, 'statusNew', `Saved ${stars}/5 rating for track `, 'Enter');
      add('editSave', r);
      const st = (await selectedState(page)).status;
      saved.push(st);
      await gap();
    }
    out.validation.savedStatuses = saved.slice(0, 2);
    out.validation.savedCount = saved.filter((s) => s.startsWith('Saved ')).length;
    await sleep(300);
    out.statsAfterInteractions = await processStats(srv.pid);
    out.externalSockets = await externalSockets(srv.pid);
    return out;
  } finally {
    await ctx.close();
  }
}

/** Open a tab, close it, and time how long the server takes to exit on its own. */
async function tabCloseTest(browser, bin, dataDir, workDir, keepRunningFlag) {
  const copy = freshCopy(dataDir, workDir);
  const srv = await startServer({ bin, config: copy.config, db: copy.db, keepRunning: false });
  const ctx = await newContext(browser, { probe: false });
  const page = await ctx.newPage();
  await page.goto(srv.url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__bench.state().selected !== null, null, { timeout: 30000 });
  await sleep(1000);
  const exitedBeforeClose = srv.exited !== null;
  const t0 = performance.now();
  await ctx.close();
  const waitMs = keepRunningFlag ? 15000 : 6000;
  const ms = await waitExit(srv, t0, waitMs);
  if (ms === null) await stopServer(srv);
  return {
    ready: srv.ready,
    banner: srv.banner,
    exitAfterCloseMs: ms,
    waitedMs: waitMs,
    exitedBeforeClose,
    exit: srv.exited,
  };
}

function ratingsSince(db, sinceSec) {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare('SELECT count(*) AS n FROM ratings WHERE updated_at >= ?').get(sinceSec).n;
  } finally {
    d.close();
  }
}

async function segment(browser, build, dataset, dataDir, run, work, bininfo) {
  const bin = binFor(build);
  const res = { build, dataset, run, loadavgBefore: loadavg(), started: new Date().toISOString() };
  // Tab close first, so a build that auto-stops but has no --keep-running is caught before the main server.
  res.tabClose = await tabCloseTest(
    browser,
    bin,
    dataDir,
    join(work, `${dataset}-${build}-${run}-close`),
    bininfo.keepRunningFlag,
  );
  const autoStops = res.tabClose.exitAfterCloseMs !== null;
  const copy = freshCopy(dataDir, join(work, `${dataset}-${build}-${run}`));
  const startSec = Math.floor(Date.now() / 1000);
  const srv = await startServer({ bin, config: copy.config, db: copy.db, keepRunning: bininfo.keepRunningFlag });
  res.keepRunningPassed = bininfo.keepRunningFlag;
  res.ready = srv.ready;
  res.banner = srv.banner;
  // A build that stops itself without offering --keep-running is kept alive by an extra open tab.
  let anchor = null;
  if (autoStops && !bininfo.keepRunningFlag) {
    anchor = await newContext(browser, { probe: false });
    await (await anchor.newPage()).goto(srv.url);
    res.anchorTab = true;
  }
  try {
    await sleep(200);
    res.statsIdle = await processStats(srv.pid);
    res.loads = [];
    for (let i = 0; i < COLD; i++) res.loads.push(await loadSamples(browser, srv.url));
    res.transfer = await transferSample(browser, srv.url);
    res.statsAfterLoads = await processStats(srv.pid);
    res.pageLoadsForCpu = COLD * 2 + 1;
    res.interactions = await interactionRun(browser, srv.url, srv, dataset);
    if (srv.exited) throw new Error(`server exited during the run: ${JSON.stringify(srv.exited)}`);
  } finally {
    if (anchor) await anchor.close();
    await stopServer(srv);
  }
  res.ratingsWritten = ratingsSince(copy.db, startSec);
  res.loadavgAfter = loadavg();
  rmSync(copy.dir, { recursive: true, force: true });
  rmSync(join(work, `${dataset}-${build}-${run}-close`), { recursive: true, force: true });
  return res;
}

function fileInfo(path) {
  const st = statSync(path);
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  return { size: st.size, mtime: st.mtime.toISOString(), sha256_16: hash };
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(args.out, stamp);
  mkdirSync(outDir, { recursive: true });
  const work = join(tmpdir(), `bench-web-${process.pid}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });

  const data = {};
  const dataInfo = {};
  if (DATASETS.includes('real')) {
    data.real = join(work, 'master-real');
    dataInfo.real = await prepareReal(data.real);
  }
  if (DATASETS.includes('large')) {
    data.large = join(args.out, 'data', 'large');
    dataInfo.large = ensureSynthetic(data.large, { regen: args.regen });
  }
  log('datasets', JSON.stringify(dataInfo));

  const bins = {};
  for (const b of BUILDS) {
    const path = binFor(b);
    bins[b] = { ...fileInfo(path), ...probeBinary(path) };
  }
  log('binaries', JSON.stringify(bins));

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    // Everything but 127.0.0.1 goes to a dead proxy and fails at once: album art
    // and Spotify's scripts never load. This avoids request interception (which
    // would disable the HTTP cache) and overrides the system proxy settings
    // (which make --host-resolver-rules ineffective on this machine).
    proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1' },
  });
  const raw = {
    meta: {
      started: new Date().toISOString(),
      note: args.note,
      runs: RUNS,
      coldSamplesPerRun: COLD,
      jPresses: J_PRESSES,
      viewport: VIEWPORT,
      search: SEARCH,
      browser: `${browser.browserType().name()} ${browser.version()}`,
      node: process.version,
      os: `darwin ${release()}`,
      cpu: cpus()[0]?.model,
      cpuCount: cpus().length,
      memGiB: Math.round(totalmem() / 2 ** 30),
      loadavgStart: loadavg(),
      binaries: bins,
      datasets: dataInfo,
    },
    segments: [],
  };
  const save = () => writeFileSync(join(outDir, 'raw.json'), JSON.stringify(raw, null, 1));
  try {
    for (let run = 0; run < RUNS; run++) {
      for (const dataset of DATASETS) {
        // Round-robin, rotated each run, so no build always goes first or last.
        const order = BUILDS.map((_, i) => BUILDS[(i + run) % BUILDS.length]);
        for (const build of order) {
          log(`run ${run + 1}/${RUNS} ${dataset} ${build} (load ${loadavg()[0].toFixed(1)})`);
          try {
            const seg = await segment(browser, build, dataset, data[dataset], run, work, bins[build]);
            raw.segments.push(seg);
            const j = seg.interactions.samples.j.map((s) => s.frame).sort((a, b) => a - b);
            log(
              `  ready ${seg.ready.toFixed(0)} ms, interactive ${median(seg.loads.map((l) => l.cold.interactiveFrame)).toFixed(0)} ms, j ${j[j.length >> 1].toFixed(1)} ms, close->exit ${seg.tabClose.exitAfterCloseMs?.toFixed(0) ?? 'n/a'}`,
            );
          } catch (e) {
            log(`  FAILED: ${e.stack}`);
            raw.segments.push({ build, dataset, run, error: String(e.stack ?? e) });
          }
          save();
        }
      }
    }
  } finally {
    raw.meta.finished = new Date().toISOString();
    raw.meta.loadavgEnd = loadavg();
    save();
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
  const summaryPath = join(outDir, 'summary.md');
  writeSummary(raw, summaryPath);
  log(`wrote ${join(outDir, 'raw.json')} and ${summaryPath}`);
}

function median(a) {
  const s = a.filter((x) => x != null).sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
}

export { tabCloseTest, newContext };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
