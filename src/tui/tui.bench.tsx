/**
 * Ported from the Go build's `internal/tui/bench_test.go` benchmarks (see
 * the `archive/go` tag). Run with
 * `npx vitest bench --run src/tui`.
 *
 * "Frame" benchmarks include drawing a 160x48 window: laying the frame out
 * on the cell grid and writing the rows that changed to a stdout that
 * discards them.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { Db } from '../core/db';
import { newModel, tracksLoadedMsg, update, type Model } from '../app/model';
import { frameRows } from './grid';
import { Screen } from './screen';
import { benchRatings, benchTracks, textKey } from './testkit';
import { view } from './view';

/**
 * 500 approximates a real library today; the larger sizes show how each
 * interaction scales as listening history grows.
 */
const sizes = [500, 5000, 25000];
const WIDTH = 160;
const HEIGHT = 48;
const runOptions = { iterations: 300, time: 0, warmupIterations: 20, warmupTime: 0 };

/** The steady browsing state: tracks and ratings loaded at a realistic terminal size. */
function benchModel(n: number): Model {
  const tracks = benchTracks(n);
  let m = newModel({});
  m = update(m, { type: 'resize', width: WIDTH, height: HEIGHT })[0];
  return update(m, tracksLoadedMsg(tracks, benchRatings(tracks)))[0];
}

/** A screen showing `m`, whose `show` draws another model (all of it with `repaint`). */
function mountFrame(m: Model): { show: (next: Model, repaint?: boolean) => void } {
  const screen = new Screen({ write: () => true, isTTY: true });
  screen.draw(frameRows(view(m), WIDTH));
  return {
    show: (next, repaint = false) => {
      if (repaint) {
        screen.invalidate();
      }
      screen.draw(frameRows(view(next), WIDTH));
    },
  };
}

test('TracksLoaded', async ({ bench }) => {
  const registrations = sizes.map((n) => {
    const tracks = benchTracks(n);
    const msg = tracksLoadedMsg(tracks, benchRatings(tracks));
    const base = newModel({});
    // update never mutates the message, so every iteration sorts the same
    // unsorted input without copying it first.
    return bench(`n=${n}`, () => {
      update(base, msg);
    });
  });
  await bench.compare(...registrations, runOptions);
});

test('View', async ({ bench }) => {
  const registrations = sizes.flatMap((n) => {
    const m = benchModel(n);
    const frame = mountFrame(m);
    return [
      // Re-rendering an unchanged model: every row is rebuilt and compared,
      // and none is written.
      bench(`n=${n} re-render`, () => frame.show(m)),
      // Every row written, closest to Go's View, which builds the whole
      // frame string from scratch.
      bench(`n=${n} repaint`, () => frame.show(m, true)),
    ];
  });
  await bench.compare(...registrations, runOptions);
});

// One j keypress plus the frame it renders: the latency a user feels while
// scrolling. Each iteration starts from the same frame, as in Go.
test('MoveDownFrame', async ({ bench }) => {
  const registrations = sizes.map((n) => {
    const m = benchModel(n);
    const frame = mountFrame(m);
    const key = textKey('j');
    const before = () => frame.show(m);
    return bench(`n=${n}`, { beforeEach: before }, () => {
      const [next, cmd] = update(m, key);
      if (cmd !== null) {
        throw new Error('moving the selection should not issue a command');
      }
      frame.show(next);
    });
  });
  await bench.compare(...registrations, runOptions);
});

// Typing one character into the search box plus the resulting frame.
test('SearchKeystrokeFrame', async ({ bench }) => {
  const registrations = sizes.map((n) => {
    let m = benchModel(n);
    for (const char of '/ch') {
      m = update(m, textKey(char))[0];
    }
    const frame = mountFrame(m);
    const key = textKey('o');
    const before = () => frame.show(m);
    return bench(`n=${n}`, { beforeEach: before }, () => {
      frame.show(update(m, key)[0]);
    });
  });
  await bench.compare(...registrations, runOptions);
});

test('SortCycleFrame', async ({ bench }) => {
  const registrations = sizes.map((n) => {
    let m = benchModel(n);
    const frame = mountFrame(m);
    const key = textKey('o');
    return bench(`n=${n}`, () => {
      m = update(m, key)[0];
      frame.show(m);
    });
  });
  await bench.compare(...registrations, runOptions);
});

// The startup query path against a real SQLite file: both queries plus the
// display and search text precompute.
test('LoadTracksFromDB', async ({ bench }) => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-tui-bench-'));
  const dbs: Db[] = [];
  try {
    const registrations = sizes.map((n) => {
      const db = Db.open(join(dir, `bench-${n}.db`));
      dbs.push(db);
      const tracks = benchTracks(n);
      db.transaction(() => {
        for (const track of tracks) {
          db.upsertTrack(track);
        }
        for (const rating of benchRatings(tracks)) {
          db.upsertRating(rating);
        }
      });
      return bench(`n=${n}`, () => {
        tracksLoadedMsg(db.listAllTracks(), db.listAllRatings());
      });
    });
    await bench.compare(...registrations, { ...runOptions, iterations: 50 });
  } finally {
    for (const db of dbs) {
      db.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
