/**
 * Helpers shared by the TUI tests and benchmarks: key messages, Go golden
 * fixtures, and rendering a model to plain text.
 */
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';

import { render, type Instance } from 'ink';
import type { ReactNode } from 'react';

import type { Rating, Track } from '../core/model';
import { frameRows } from './grid';
import { makeModel, tracksLoadedMsg, update, type KeyMsg, type Model, type Msg } from '../app/model';
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

/** Renders the model at its window width, as plain right-trimmed text. */
export function renderText(m: Model): string {
  return frameRows(view(m), m.width > 0 ? m.width : 100)
    .map((row) => stripVTControlCharacters(row).trimEnd())
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

/**
 * A terminal-sized stdout that records what is written and keeps the screen
 * it draws: the cursor moves, line and screen clears, and text that the TUI's
 * `Screen` writes (styles and other escapes are dropped).
 */
export class FakeStdout extends EventEmitter {
  readonly isTTY = true;
  readonly writes: string[] = [];
  private readonly screen: string[] = [];
  private row = 0;
  private column = 0;

  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }

  write = (chunk: string): boolean => {
    this.writes.push(chunk);
    // CSI sequences (parameters, then a final letter) and plain text between them.
    for (const [, params, final, text] of chunk.matchAll(/\u001B\[([\d;?]*)([A-Za-z])|([^\u001B]+)/g)) {
      if (text !== undefined) {
        this.print(text);
      } else if (final === 'H') {
        const [row = 1, column = 1] = (params ?? '').split(';').map((value) => Number(value || 1));
        this.row = row - 1;
        this.column = column - 1;
      } else if (final === 'K' && params === '2') {
        this.screen[this.row] = '';
      } else if (final === 'J' && params === '2') {
        this.screen.length = 0;
      }
    }
    return true;
  };

  private print(text: string): void {
    const line = (this.screen[this.row] ?? '').padEnd(this.column);
    this.screen[this.row] = line.slice(0, this.column) + text + line.slice(this.column + text.length);
    this.column += text.length;
  }

  /** The screen as plain right-trimmed text, without trailing blank rows. */
  lastFrame(): string {
    return Array.from(this.screen, (line) => (line ?? '').trimEnd())
      .join('\n')
      .replace(/\n+$/, '');
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
