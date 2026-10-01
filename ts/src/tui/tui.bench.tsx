/**
 * Ports of the Go `internal/tui/bench_test.go` benchmarks. Run with
 * `npx vitest bench --run src/tui`.
 *
 * "Frame" benchmarks include Ink's full render of a 160x48 window: React
 * reconciliation, Yoga layout, and building the output string (Ink's debug
 * mode, which writes every frame synchronously to a fake stdout).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, test } from 'vitest';

import { Db } from '../core/db';
import { FrameView } from './frame';
import { newModel, tracksLoadedMsg, update, type Model } from '../app/model';
import { benchRatings, benchTracks, mountInk, textKey, type InkHarness } from './testkit';
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

const harnesses: InkHarness[] = [];
afterAll(() => {
  for (const harness of harnesses) {
    harness.instance.unmount();
  }
});

/** A live Ink instance showing `m`, whose `show` re-renders it with another model. */
function mountFrame(m: Model): { show: (next: Model, key?: number) => void; reset: () => void } {
  const harness = mountInk(<FrameView frame={view(m)} />, WIDTH, HEIGHT);
  harnesses.push(harness);
  return {
    show: (next, key) => harness.instance.rerender(<FrameView key={key} frame={view(next)} />),
    // Frames are recorded; drop them so long runs don't accumulate.
    reset: () => {
      harness.stdout.writes.length = 0;
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
    const warm = mountFrame(m);
    const cold = mountFrame(m);
    let key = 0;
    return [
      // Re-rendering an unchanged model: every row is rebuilt and compared,
      // then Ink lays out and draws the frame.
      bench(`n=${n} re-render`, { beforeEach: warm.reset }, () => warm.show(m)),
      // A fresh tree each time, closest to Go's View, which builds the whole
      // frame string from scratch.
      bench(`n=${n} remount`, { beforeEach: cold.reset }, () => cold.show(m, ++key)),
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
    const before = () => {
      frame.reset();
      frame.show(m);
    };
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
    const before = () => {
      frame.reset();
      frame.show(m);
    };
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
    return bench(`n=${n}`, { beforeEach: frame.reset }, () => {
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
