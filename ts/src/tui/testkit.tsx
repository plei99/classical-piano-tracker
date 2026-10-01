/**
 * Helpers shared by the TUI tests and benchmarks: key messages, Go golden
 * fixtures, and rendering a model through Ink to plain text.
 */
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';

import { render, renderToString, type Instance } from 'ink';
import type { ReactNode } from 'react';

import type { Rating, Track } from '../core/model';
import { FrameView } from './frame';
import { makeModel, tracksLoadedMsg, update, type KeyMsg, type Model, type Msg } from './model';
import { view } from './view';

/** The key press Bubble Tea v2 reports for typed text. */
export function textKey(text: string): KeyMsg {
  return { type: 'key', key: text, text };
}

/** A special key, e.g. "enter", "esc", "tab", "shift+tab", "backspace". */
export function specialKey(key: string): KeyMsg {
  return { type: 'key', key, text: '' };
}

/** Applies one message and drops the command. */
export function apply(m: Model, msg: Msg): Model {
  return update(m, msg)[0];
}

export function typeKeys(m: Model, ...keys: KeyMsg[]): Model {
  for (const key of keys) {
    m = apply(m, key);
  }
  return m;
}

/** Types `text` one character at a time. */
export function typeText(m: Model, text: string): Model {
  for (const char of text) {
    m = apply(m, textKey(char));
  }
  return m;
}

/** Renders the model with Ink at its window width, as plain right-trimmed text. */
export function renderText(m: Model): string {
  const output = renderToString(<FrameView frame={view(m)} />, { columns: m.width > 0 ? m.width : 100 });
  return stripVTControlCharacters(output)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}

/** Mirrors the Go golden generator's fixture tracks. */
export function goldenTracks(n: number, long: boolean): Track[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    spotifyId: `sp-${i}`,
    trackName: long
      ? `Piano Sonata No. ${(i % 32) + 1} in B-flat minor, Op. ${(i % 120) + 1}: II. Scherzo – Più lento`
      : `Track ${i + 1}`,
    albumName: 'Album',
    artists: `["Frédéric Chopin","Pianist ${i}"]`,
    playCount: (i % 5) + 1,
    lastPlayedAt: 1_700_000_000 + i,
    createdAt: 0,
  }));
}

export const goldenRating: Rating = {
  trackId: 28,
  stars: 4,
  opinion: 'Lyrical and restrained, with a long singing line that goes on and on across the whole movement.',
  updatedAt: 1_700_000_000,
};

/** A loaded model at the given window size, with UTC timestamps like the goldens. */
export function goldenModel(width: number, height: number, tracks: number, long: boolean): Model {
  let m = makeModel({ timeZone: 'utc' });
  m = apply(m, { type: 'resize', width, height });
  return apply(m, tracksLoadedMsg(goldenTracks(tracks, long), [goldenRating]));
}

/** Benchmark pianists, as in the Go bench_test.go. */
const benchPianists = [
  'Krystian Zimerman',
  'Martha Argerich',
  'Grigory Sokolov',
  'Seong-Jin Cho',
  'Daniil Trifonov',
  'Víkingur Ólafsson',
  'András Schiff',
  'Mitsuko Uchida',
];

export function benchTracks(n: number): Track[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    spotifyId: `spotify-${String(i).padStart(6, '0')}`,
    trackName: `Piano Sonata No. ${(i % 32) + 1} in B-flat minor, Op. ${(i % 120) + 1}: II. Scherzo – Più lento`,
    albumName: `Chopin: Complete Works Vol. ${i % 40}`,
    artists: `["Frédéric Chopin","${benchPianists[i % benchPianists.length] ?? ''}"]`,
    playCount: (i % 17) + 1,
    lastPlayedAt: 1_700_000_000 + ((i * 7919) % 1_000_000),
    createdAt: 0,
  }));
}

export function benchRatings(tracks: readonly Track[]): Rating[] {
  return tracks
    .filter((_, i) => i % 3 === 0)
    .map((track) => ({
      trackId: track.id,
      stars: ((track.id - 1) % 5) + 1,
      opinion: 'Lyrical and restrained.',
      updatedAt: 1_700_000_000,
    }));
}

/** A terminal-sized stdout that records what Ink writes. */
export class FakeStdout extends EventEmitter {
  readonly isTTY = true;
  readonly writes: string[] = [];

  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }

  write = (chunk: string): boolean => {
    this.writes.push(chunk);
    return true;
  };

  /** The latest frame Ink wrote, as plain right-trimmed text (mode escapes are skipped). */
  lastFrame(): string {
    for (let index = this.writes.length - 1; index >= 0; index--) {
      const text = stripVTControlCharacters(this.writes[index] ?? '');
      if (text.trim() !== '') {
        return text
          .split('\n')
          .map((line) => line.trimEnd())
          .join('\n');
      }
    }
    return '';
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}

/** A raw-mode stdin that delivers whatever the test writes as terminal input. */
export class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  private pending: string | null = null;

  write(data: string): void {
    this.pending = data;
    this.emit('readable');
    this.emit('data', data);
  }

  read = (): string | null => {
    const data = this.pending;
    this.pending = null;
    return data;
  };

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

export interface InkHarness {
  readonly stdout: FakeStdout;
  readonly stdin: FakeStdin;
  readonly instance: Instance;
}

/**
 * Mounts `node` in Ink against fake streams of the given size. Debug mode
 * renders every commit synchronously and in full, which tests and
 * benchmarks both want.
 */
export function mountInk(node: ReactNode, columns: number, rows: number): InkHarness {
  const stdout = new FakeStdout(columns, rows);
  const stdin = new FakeStdin();
  const instance = render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new FakeStdout(columns, rows) as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { stdout, stdin, instance };
}
