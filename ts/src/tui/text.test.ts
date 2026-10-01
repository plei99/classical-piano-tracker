import { describe, expect, it } from 'vitest';

import {
  clipLine,
  dropLastRune,
  expandTabs,
  hardWrap,
  type Line,
  packHints,
  type Style,
  truncate,
  width,
  wrapLine,
  wrapText,
} from './text';

const PLAIN: Style = {};
const INVERSE: Style = { inverse: true };

const plain = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join(''));

describe('width and truncate', () => {
  it('counts cells', () => {
    expect(width('Chopin')).toBe(6);
    expect(width('Frédéric')).toBe(8);
    expect(width('e\u0301')).toBe(1);
    expect(width('漢字')).toBe(4);
    expect(width('Scherzo – Più lento')).toBe(19);
  });

  it('cuts by grapheme with an ellipsis when there is room', () => {
    expect(truncate('Víkingur Ólafsson, Frédéric Chopin', 12)).toBe('Víkingur ...');
    expect(truncate('Scherzo – Più lento', 12)).toBe('Scherzo –...');
    expect(truncate('anything', 0)).toBe('');
    expect(truncate('fits', 4)).toBe('fits');
    expect(truncate('abcdef', 3)).toBe('abc');
    expect(truncate('abcdef', 5)).toBe('ab...');
    // A wide character that would straddle the cut is dropped, not split.
    expect(truncate('ab漢字漢字', 6)).toBe('ab...');
    expect(truncate('ab漢字漢字', 7)).toBe('ab漢...');
    expect(truncate('ab漢字漢字', 8)).toBe('ab漢...');
    // Combining marks stay with their base letter.
    expect(truncate('Fre\u0301de\u0301ric Chopin', 7)).toBe('Fre\u0301d...');
  });

  it('expands tabs like Lip Gloss', () => {
    expect(expandTabs('a\tb')).toBe('a    b');
    expect(expandTabs('plain')).toBe('plain');
  });

  it('drops the last code point', () => {
    expect(dropLastRune('')).toBe('');
    expect(dropLastRune('abc')).toBe('ab');
    expect(dropLastRune('a🎹')).toBe('a');
    expect(dropLastRune('é')).toBe('');
  });
});

describe('wrapping', () => {
  it('wraps opinions on words', () => {
    expect(wrapText('', 10)).toEqual(['']);
    expect(wrapText('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('first\n\nsecond', 20)).toEqual(['first', '', 'second']);
    expect(wrapText('supercalifragilistic word', 5)).toEqual(['supercalifragilistic', 'word']);
  });

  it('drops an overflowing trailing highlight space, keeping the style', () => {
    // The Go selected row with a three-digit ID: one cell too wide, and the
    // extra cell is the trailing highlight space.
    const line: Line = [
      { text: ' ', style: INVERSE },
      { text: '150  Title...', style: INVERSE },
      { text: ' ', style: INVERSE },
    ];
    const wrapped = wrapLine(line, 14);
    expect(plain(wrapped)).toEqual([' 150  Title...']);
    expect(wrapped[0]?.every((span) => span.style === INVERSE)).toBe(true);
  });

  it('moves the last word and hard-breaks like ansi.Wrap', () => {
    const line = (text: string): Line => [{ text, style: PLAIN }];
    expect(plain(wrapLine(line('1234  Sonata in B-flat...'), 20))).toEqual(['1234  Sonata in B-', 'flat...']);
    expect(plain(wrapLine(line('abcdefghij'), 4))).toEqual(['abcd', 'efgh', 'ij']);
    expect(plain(wrapLine(line('short'), 10))).toEqual(['short']);
    // Reference outputs captured from Go's ansi.Wrap.
    expect(plain(wrapLine(line('Opinion: https://example.com/a/very/long/url/that/never/ends ok'), 16))).toEqual([
      'Opinion:',
      'https://example.',
      'com/a/very/long/',
      'url/that/never/e',
      'nds ok',
    ]);
    expect(plain(wrapLine(line('  leading and   gaps  '), 8))).toEqual(['', 'leading', 'and', 'gaps  ']);
  });

  it('hard-wraps status text like x/ansi Wrap', () => {
    // Expected values from x/ansi.Wrap(s, limit, "") in the Go build.
    expect(hardWrap('hello world foo', 11)).toBe('hello world\nfoo');
    expect(hardWrap('abcdefghij', 4)).toBe('abcd\nefgh\nij');
    expect(hardWrap('well-known phrase', 6)).toBe('well-\nknown\nphrase');
    expect(hardWrap('short', 40)).toBe('short');
    expect(hardWrap('Più lento è bello', 8)).toBe('Più\nlento è\nbello');
  });

  it('packs whole hints per line', () => {
    expect(packHints(['a: one', 'b: two', 'c: three'], 15)).toBe('a: one   b: two\nc: three');
    expect(packHints(['too long for the width'], 5)).toBe('too long for the width');
  });

  it('clips styled lines at the window edge', () => {
    const line: Line = [
      { text: 'ab', style: PLAIN },
      { text: '漢字', style: INVERSE },
    ];
    expect(clipLine(line, 10)).toBe(line);
    expect(plain([clipLine(line, 5)])).toEqual(['ab漢']);
    expect(plain([clipLine(line, 3)])).toEqual(['ab']);
    expect(clipLine(line, 0)).toEqual([]);
  });
});
