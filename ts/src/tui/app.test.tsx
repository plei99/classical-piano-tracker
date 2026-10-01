/** The Ink program end to end, key translation, styles, and degenerate window sizes. */
import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { App } from './app';
import { keyMessages } from './keys';
import { newModel, startRatingEditor, type Deps } from '../app/model';
import { goldenModel, goldenRating, goldenTracks, mountInk, renderText } from './testkit';
import type { Line } from './text';
import { view, type Row } from './view';

function key(fields: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...fields,
  };
}

const names = (input: string, fields: Partial<Key> = {}) => keyMessages(input, key(fields)).map((msg) => msg.key);

describe('keyMessages', () => {
  it('names keys the way Bubble Tea does', () => {
    expect(names('\r', { return: true })).toEqual(['enter']);
    expect(names('', { escape: true })).toEqual(['esc']);
    expect(names('', { tab: true })).toEqual(['tab']);
    expect(names('', { tab: true, shift: true })).toEqual(['shift+tab']);
    expect(names('', { backspace: true })).toEqual(['backspace']);
    expect(names('', { upArrow: true })).toEqual(['up']);
    expect(names('', { downArrow: true, ctrl: true })).toEqual(['ctrl+down']);
    expect(names('', { home: true })).toEqual(['home']);
    expect(names('u', { ctrl: true })).toEqual(['ctrl+u']);
    expect(names('c', { ctrl: true })).toEqual(['ctrl+c']);
    expect(names('j', { meta: true })).toEqual(['alt+j']);
    expect(names('G', { shift: true })).toEqual(['G']);
    expect(keyMessages(' ', key())).toEqual([{ type: 'key', key: 'space', text: ' ' }]);
    expect(keyMessages('é', key())).toEqual([{ type: 'key', key: 'é', text: 'é' }]);
  });

  it('splits a run of typed text into one key per character', () => {
    expect(names('jjq')).toEqual(['j', 'j', 'q']);
    expect(names('ab\r')).toEqual(['a', 'b', 'enter']);
    expect(names('a\x7f')).toEqual(['a', 'backspace']);
  });
});

/** Text of each frame row, with the body flattened to a marker. */
function rowLine(row: Row | undefined): Line {
  return row?.kind === 'line' ? row.line : [];
}

describe('styles', () => {
  it('match Lip Gloss', () => {
    const frame = view(goldenModel(120, 28, 5, false));
    expect(rowLine(frame.rows[0])[0]?.style.bold).toBe(true);
    expect(rowLine(frame.rows[1])[0]?.style.dim).toBe(true);
    const body = frame.rows.find((row) => row.kind === 'body');
    expect(body?.kind).toBe('body');
    if (body?.kind !== 'body') {
      return;
    }
    // The selected row is reversed including its one-cell padding, and its
    // subtitle is faint as well.
    const [selected, subtitle] = body.body.list.lines.slice(3, 5);
    expect(selected?.map((span) => span.text).join('')).toBe('  5  Track 5 ');
    expect(selected?.every((span) => span.style.inverse)).toBe(true);
    expect(subtitle?.[1]?.style).toEqual({ inverse: true, dim: true });
    const footer = rowLine(frame.rows[frame.rows.length - 1]);
    expect(footer[0]?.text.startsWith('j/k or arrows: move')).toBe(true);
    expect(footer[0]?.style.dim).toBe(true);

    const editor = view(startRatingEditor(goldenModel(120, 28, 5, false))).rows.find((row) => row.kind === 'body');
    const focused = editor?.kind === 'body' ? editor.body.detail.lines[5] : undefined;
    expect(focused).toEqual([{ text: '> Stars: not set', style: { bold: true } }]);
  });
});

describe('degenerate window sizes', () => {
  it('still render, never taller than the window', () => {
    const m = goldenModel(120, 28, 30, false);
    for (const [width, height] of [
      [1, 1],
      [10, 3],
      [30, 10],
      [41, 12],
      [89, 20],
      [300, 5],
    ] as const) {
      const frame = renderText({ ...m, width, height });
      expect(frame.split('\n').length, `${width}x${height}`).toBeLessThanOrEqual(height);
    }
  });
});

describe('App', () => {
  function deps(): Deps & { saveRating: ReturnType<typeof vi.fn> } {
    return {
      load: () => Promise.resolve({ tracks: goldenTracks(5, false), ratings: [goldenRating] }),
      sync: () => Promise.reject(new Error('bad token')),
      saveRating: vi.fn((params) => Promise.resolve({ ...params })),
    };
  }

  it('loads on mount, then browses, searches, pastes, rates, resizes, and quits', async () => {
    const d = deps();
    const h = mountInk(
      <App deps={d} initialModel={newModel(d, { width: 120, height: 28, timeZone: 'utc' })} />,
      120,
      28,
    );
    const frame = () => h.stdout.lastFrame();
    expect(frame()).toContain('Loading local tracks...');

    // The live Ink pipeline draws exactly what renderToString does.
    await vi.waitFor(() => expect(frame()).toContain('5 loaded · sort: recent'));
    expect(frame().replace(/\n+$/, '')).toBe(renderText(goldenModel(120, 28, 5, false)).replace(/\n+$/, ''));

    h.stdin.write('j');
    await vi.waitFor(() => expect(frame()).toContain('ID: 4'));

    h.stdin.write('s');
    await vi.waitFor(() => expect(frame()).toContain('Error: Sync failed: bad token'));

    h.stdin.write('/');
    h.stdin.write('\x1b[200~track 3\x1b[201~');
    await vi.waitFor(() => expect(frame()).toContain('Search /track 3_ (1/5)'));
    h.stdin.write('\r');
    await vi.waitFor(() => expect(frame()).toContain('Filter /track 3 (1/5)'));

    h.stdin.write('\r');
    await vi.waitFor(() => expect(frame()).toContain('> Stars: not set'));
    h.stdin.write('5');
    h.stdin.write('\x1b[200~Op. 111\x1b[201~');
    await vi.waitFor(() => expect(frame()).toContain('Op. 111_'));
    h.stdin.write('\r');
    await vi.waitFor(() => expect(frame()).toContain('Saved 5/5 rating for track 3'));
    expect(d.saveRating).toHaveBeenCalledWith(expect.objectContaining({ trackId: 3, stars: 5, opinion: 'Op. 111' }));
    expect(frame()).toContain('Rating: 5/5');

    h.stdout.resize(70, 24);
    await vi.waitFor(() => expect(frame()).toContain(`╭${'─'.repeat(64)}╮`));
    for (const line of frame().split('\n')) {
      expect([...line].length).toBeLessThanOrEqual(70);
    }

    h.stdin.write('q');
    await h.instance.waitUntilExit();
  });

  it('quits on ctrl+c from search mode', async () => {
    const d = deps();
    const h = mountInk(<App deps={d} initialModel={newModel(d, { width: 100, height: 30 })} />, 100, 30);
    await vi.waitFor(() => expect(h.stdout.lastFrame()).toContain('5 loaded'));
    h.stdin.write('/');
    h.stdin.write('\x03');
    await h.instance.waitUntilExit();
  });

  it('esc clears the search', async () => {
    const d = deps();
    const h = mountInk(<App deps={d} initialModel={newModel(d, { width: 100, height: 30 })} />, 100, 30);
    await vi.waitFor(() => expect(h.stdout.lastFrame()).toContain('5 loaded'));
    h.stdin.write('/');
    h.stdin.write('2');
    await vi.waitFor(() => expect(h.stdout.lastFrame()).toContain('Search /2_ (2/5)'));
    h.stdin.write('\x1b');
    await vi.waitFor(() => expect(h.stdout.lastFrame()).not.toContain('Search /'));
    expect(h.stdout.lastFrame()).toContain('5 loaded');
    h.instance.unmount();
  });
});
