import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FavoritePianist, PianistProfile, TasteSummary, TasteTrack, ValidatedPianist } from '../recommend';
import type { RecentTrack } from '../spotify';
import {
  FALLBACK_OUTPUT_WIDTH,
  outputWidth,
  printFavoritePianists,
  printRecentSpotifyTracks,
  printTasteProfile,
  printValidatedPianists,
  printWrappedField,
} from './format';
import { TabWriter } from './tabwriter';
import { MemoryOut } from './testutil';

function render(fn: (out: MemoryOut) => void): string {
  const out = new MemoryOut();
  fn(out);
  return out.text();
}

function expectContainsAll(output: string, wants: string[]): void {
  for (const want of wants) {
    expect(output).toContain(want);
  }
}

function profile(overrides: Partial<PianistProfile>): PianistProfile {
  return {
    name: '',
    trackCount: 0,
    ratedTrackCount: 0,
    totalPlayCount: 0,
    averageStars: 0,
    favoriteScore: 0,
    ...overrides,
  };
}

function tasteTrack(overrides: Partial<TasteTrack>): TasteTrack {
  return {
    trackId: 0,
    trackName: '',
    albumName: '',
    artists: [],
    playCount: 0,
    lastPlayedAt: 0,
    stars: 0,
    opinion: '',
    matchedArtist: '',
    ...overrides,
  };
}

function favorite(overrides: Partial<FavoritePianist>): FavoritePianist {
  return { name: '', trackCount: 0, ratedTrackCount: 0, totalPlayCount: 0, averageStars: 0, ...overrides };
}

function summary(overrides: Partial<TasteSummary>): TasteSummary {
  return {
    totalTracks: 0,
    totalRatings: 0,
    commentCount: 0,
    favoritePianists: [],
    lovedTracks: [],
    dislikedTracks: [],
    commentedTracks: [],
    knownPianists: [],
    discoveryGuidance: '',
    ...overrides,
  };
}

function validated(overrides: Partial<ValidatedPianist>): ValidatedPianist {
  return {
    pianistName: '',
    whyFit: '',
    similarTo: [],
    confidence: '',
    spotifyName: '',
    spotifyId: '',
    popularity: 0,
    genres: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('output formatting', () => {
  // Go: TestPrintRecentSpotifyTracks
  it('prints recent Spotify tracks as blocks', () => {
    const track: RecentTrack = {
      spotifyId: '',
      name: 'Piano Concerto No. 1',
      albumName: 'Album One',
      artists: [{ id: '', name: 'Martha Argerich' }],
      durationMs: 0,
      playedAt: new Date(Date.UTC(2026, 3, 1, 12, 30)),
      playedAtNs: 0n,
    };
    const output = render((out) => printRecentSpotifyTracks(out, [track]));
    expectContainsAll(output, [
      '1. Piano Concerto No. 1',
      'Artists: Martha Argerich',
      'Album:   Album One',
      'Played:  2026-04-01 12:30:00',
    ]);

    const two = render((out) =>
      printRecentSpotifyTracks(out, [track, { ...track, name: 'Second', albumName: ' ', artists: [] }]),
    );
    expect(two).toBe(
      '1. Piano Concerto No. 1\n   Artists: Martha Argerich\n   Album:   Album One\n   Played:  2026-04-01 12:30:00\n' +
        '\n2. Second\n   Artists: \n   Played:  2026-04-01 12:30:00\n',
    );
  });

  // Go: TestPrintFavoritePianists
  it('prints favorite pianists as an aligned table', () => {
    const output = render((out) =>
      printFavoritePianists(out, [
        profile({
          name: 'Martha Argerich',
          favoriteScore: 98.42,
          averageStars: 4.75,
          ratedTrackCount: 4,
          totalPlayCount: 12,
        }),
      ]),
    );
    expectContainsAll(output, ['#', 'Pianist', 'Martha Argerich', '98.42', '4.75', '12']);
    expect(output).toBe(
      '#  Pianist          Score  Avg Stars  Rated Tracks  Total Plays\n' +
        '1  Martha Argerich  98.42  4.75       4             12\n',
    );
  });

  it('rounds scores like Go, half to even on exact ties', () => {
    const output = render((out) =>
      printFavoritePianists(out, [profile({ name: 'A', favoriteScore: 0.125, averageStars: 2.675 })]),
    );
    // 0.125 is an exact tie (rounds to even); 2.675 is just below 2.675 in binary.
    expect(output.split('\n')[1]).toBe('1  A        0.12   2.67       0             0');
  });

  // Go: TestPrintTasteProfile
  it('prints the taste profile sections', () => {
    const output = render((out) =>
      printTasteProfile(
        out,
        summary({
          totalTracks: 12,
          totalRatings: 4,
          commentCount: 2,
          favoritePianists: [
            favorite({ name: 'Martha Argerich', ratedTrackCount: 3, totalPlayCount: 9, averageStars: 4.67 }),
          ],
          lovedTracks: [
            tasteTrack({
              trackId: 42,
              trackName: 'Gaspard de la nuit: Scarbo',
              albumName: 'Ravel',
              artists: ['Martha Argerich'],
              playCount: 5,
              stars: 5,
              opinion: 'Electrifying and rhythmically alive.',
              matchedArtist: 'Martha Argerich',
            }),
          ],
          knownPianists: ['Martha Argerich', 'Yuja Wang'],
          discoveryGuidance: 'Recommend real classical concert pianists not already present in the known pianist list.',
        }),
      ),
    );
    expectContainsAll(output, [
      'Tracks: 12',
      'Ratings: 4',
      'Comments: 2',
      'Known Pianists: 2',
      'Favorite Pianists',
      'Martha Argerich',
      'Loved Tracks',
      '[42] Gaspard de la nuit: Scarbo',
      'Matched: Martha Argerich',
      'Opinion: Electrifying and rhythmically alive.',
      'Disliked Tracks',
      'Commented Tracks',
      'Known Pianists: Martha Argerich, Yuja Wang',
    ]);
    expect(output).not.toContain('Discovery Guidance:');
    expect(output).toContain(
      'Favorite Pianists\n  #  Pianist          Avg Stars  Rated Tracks  Total Plays\n' +
        '  1  Martha Argerich  4.67       3             9\n\nLoved Tracks\n',
    );
    expect(output).toContain('Disliked Tracks\n  none\n\nCommented Tracks\n  none\n\n');
  });

  // Go: TestPrintValidatedPianists
  it('prints validated pianists', () => {
    const output = render((out) =>
      printValidatedPianists(out, 'You like fire and lyricism.', [
        validated({
          pianistName: 'Radu Lupu',
          whyFit: 'Poetic contrast to your current favorites.',
          similarTo: ['Martha Argerich'],
          confidence: 'medium',
          spotifyName: 'Radu Lupu',
          spotifyId: 'artist-1',
          genres: ['classical piano'],
        }),
      ]),
    );
    expectContainsAll(output, [
      'Summary: You like fire and lyricism.',
      '1. Radu Lupu',
      'Spotify ID: artist-1',
      'Genres:     classical piano',
      'Similar to: Martha Argerich',
      'Why:        Poetic contrast to your current favorites.',
      'Confidence: medium',
    ]);
    expect(output).not.toContain('Popularity:');
  });

  // Go: TestPrintValidatedPianistsWrapsLongText
  it('wraps long validated-pianist text', () => {
    vi.stubEnv('COLUMNS', '');
    const output = render((out) =>
      printValidatedPianists(
        out,
        'Your taste centers on modern virtuoso pianism with exceptional clarity, control, and intelligence across large-scale Romantic and modern repertoire.',
        [
          validated({
            pianistName: 'Arcadi Volodos',
            whyFit:
              'Your profile strongly favors dazzling technique that stays musically controlled, with enough tonal imagination and rhythmic command to keep complex repertoire coherent.',
            similarTo: ['Yuja Wang', 'Martha Argerich', 'Yunchan Lim'],
            confidence: 'high',
            spotifyName: 'Arcadi Volodos',
            spotifyId: 'artist-1',
          }),
        ],
      ),
    );
    const lines = output.replace(/\n+$/, '').split('\n');
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(FALLBACK_OUTPUT_WIDTH);
    }
    expect(lines.length).toBeGreaterThan(6);
  });

  it('wraps fields: blank values, long words, and collapsed whitespace', () => {
    expect(render((out) => printWrappedField(out, 'Summary: ', '', '   ', 100))).toBe('Summary:\n');
    const longWord = 'x'.repeat(60);
    expect(render((out) => printWrappedField(out, 'A: ', '   ', `${longWord} ${longWord}`, 50))).toBe(
      `A: ${longWord}\n   ${longWord}\n`,
    );
    // Go's strings.Fields splits on U+0085 but not on U+FEFF.
    expect(render((out) => printWrappedField(out, 'A: ', '', ' one\u0085two\t\nthree\ufeff ', 100))).toBe(
      'A: one two three\ufeff\n',
    );
    // Widths count runes, and never drop below 20.
    expect(render((out) => printWrappedField(out, 'A: ', '', 'ééééé ééééé ééééé ééééé', 10))).toBe(
      'A: ééééé ééééé ééééé\nééééé\n',
    );
  });

  it('resolves the output width from the terminal, then COLUMNS, then 100', () => {
    vi.stubEnv('COLUMNS', '80');
    expect(outputWidth({ write: () => true, isTTY: true, columns: 120 })).toBe(120);
    expect(outputWidth({ write: () => true, isTTY: true, columns: 30 })).toBe(80);
    expect(outputWidth({ write: () => true, isTTY: false, columns: 120 })).toBe(80);
    vi.stubEnv('COLUMNS', ' 90 ');
    expect(outputWidth(new MemoryOut())).toBe(90);
    for (const columns of ['39', 'wide', '']) {
      vi.stubEnv('COLUMNS', columns);
      expect(outputWidth(new MemoryOut())).toBe(FALLBACK_OUTPUT_WIDTH);
    }
  });
});

describe('TabWriter', () => {
  const align = (text: string) => {
    const tw = new TabWriter();
    tw.write(text);
    return tw.flush();
  };

  it('aligns columns with padding', () => {
    expect(align('a\tbb\tc\naaa\tb\tc\n')).toBe('a    bb  c\naaa  b   c\n');
  });

  it('ignores the trailing cell when sizing columns', () => {
    expect(align('x\tlong trailing text\nxyz\ty\n')).toBe('x    long trailing text\nxyz  y\n');
  });

  it('ends blocks at lines without the column', () => {
    expect(align('a\t1\nplain\nlonger\t2\n')).toBe('a  1\nplain\nlonger  2\n');
    expect(align('a\tb\tc\nlong\td\nx\tyyyy\tz\n')).toBe('a     b  c\nlong  d\nx     yyyy  z\n');
  });

  it('counts runes and keeps empty cells', () => {
    expect(align('Frédéric\t1\nAb\t\t2\n')).toBe('Frédéric  1\nAb          2\n');
  });

  it('writes an unterminated final line as-is', () => {
    expect(align('a\tb\nccc\td')).toBe('a    b\nccc  d');
  });

  it('clears its buffer on flush', () => {
    const tw = new TabWriter();
    tw.write('a\tb\n');
    tw.flush();
    expect(tw.flush()).toBe('');
  });
});
