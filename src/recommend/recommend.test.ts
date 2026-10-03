import { describe, expect, it } from 'vitest';
import type { ArtistSearcher, CatalogArtist, Rating, Track } from '../core/model';
import {
  type SuggestedPianist,
  type TasteSummary,
  buildPianistProfiles,
  buildTasteSummary,
  favoriteScore,
  normalizeName,
  pickBestArtistMatch,
  validateDiscoveryInput,
  validateSuggestedPianists,
} from './index';

function track(
  id: number,
  trackName: string,
  albumName: string,
  artists: string,
  playCount: number,
  lastPlayedAt = 0,
): Track {
  return { id, spotifyId: `sp-${id}`, trackName, albumName, artists, playCount, lastPlayedAt, createdAt: 0 };
}

function rating(trackId: number, stars: number, opinion = ''): Rating {
  return { trackId, stars, opinion, updatedAt: 0 };
}

function bits(x: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigUint64(0);
}

function emptySummary(overrides: Partial<TasteSummary>): TasteSummary {
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

describe('buildPianistProfiles', () => {
  it('uses the allowlist and sorts by score', () => {
    const tracks = [
      track(1, 'Track One', '', '["Martha Argerich","London Symphony Orchestra"]', 6),
      track(2, 'Track Two', '', '["Martha Argerich"]', 3),
      track(3, 'Track Three', '', '["Daniil Trifonov"]', 2),
      track(4, 'Track Four', '', '["Unknown Artist"]', 20),
    ];
    const ratings = [rating(1, 5), rating(2, 4), rating(3, 5)];

    const profiles = buildPianistProfiles(tracks, ratings, ['Martha Argerich', 'Daniil Trifonov']);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]?.name).toBe('Martha Argerich');
    expect(profiles[0]?.ratedTrackCount).toBe(2);
    expect(profiles[0]?.totalPlayCount).toBe(9);
    expect(profiles[1]?.name).toBe('Daniil Trifonov');
  });

  it('matches case-insensitively and keeps the configured name', () => {
    const tracks = [track(1, 'A', '', '["  martha   ARGERICH ","Martha Argerich"]', 1), track(2, 'B', '', 'null', 1)];
    const profiles = buildPianistProfiles(tracks, [], ['Martha Argerich', ' ']);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.name).toBe('Martha Argerich');
    // Duplicate attribution within one track counts once.
    expect(profiles[0]?.trackCount).toBe(1);
    expect(profiles[0]?.averageStars).toBe(0);
  });

  it('reports undecodable artists with the track id and Go wording', () => {
    expect(() => buildPianistProfiles([track(7, 'C', '', 'not json', 1)], [], ['X'])).toThrow(
      "decode artists for track 7: invalid character 'o' in literal null (expecting 'u')",
    );
    expect(() => buildPianistProfiles([track(8, 'C', '', '["a",1]', 1)], [], ['X'])).toThrow(
      'decode artists for track 8: json: cannot unmarshal number into .1 of type string',
    );
  });

  it('computes the favorite score bit for bit like Go', () => {
    // Golden values produced by the Go implementation (math.Log1p, arm64 fusing).
    const cases: Array<[number, number, number, bigint]> = [
      [5, 2, 9, 0x40600d763776aaa3n],
      [4.5, 2, 9, 0x405d9aec6eed5546n],
      [0, 0, 0, 0xc020000000000000n],
      [3, 1, 1, 0x4050a2e42fefa39fn],
      [11 / 3, 3, 3, 0x4058db1db5349c93n],
      [4.2, 7, 123456789, 0x407020d1c5f98f0an],
    ];
    for (const [average, rated, plays, want] of cases) {
      expect(bits(favoriteScore(average, rated, plays)), `avg=${average} rated=${rated} plays=${plays}`).toBe(want);
    }
  });
});

describe('buildTasteSummary', () => {
  it('collects comments and favorites', () => {
    const tracks = [
      track(1, 'Concerto', 'Album A', '["Martha Argerich"]', 4, 30),
      track(2, 'Sonata', 'Album B', '["Daniil Trifonov"]', 2, 20),
      track(3, 'Ballade', 'Album C', '["Martha Argerich"]', 1, 10),
    ];
    const ratings = [rating(1, 5, 'Explosive and clear'), rating(2, 2, 'Too heavy'), rating(3, 4)];

    const summary = buildTasteSummary(tracks, ratings, ['Martha Argerich', 'Daniil Trifonov']);
    expect(summary.totalRatings).toBe(3);
    expect(summary.commentCount).toBe(2);
    expect(summary.favoritePianists[0]?.name).toBe('Martha Argerich');
    expect(summary.lovedTracks).toHaveLength(2);
    expect(summary.dislikedTracks).toHaveLength(1);
    expect(summary.dislikedTracks[0]?.trackName).toBe('Sonata');
    expect(summary.commentedTracks).toHaveLength(2);
    expect(summary.knownPianists).toEqual(['Martha Argerich', 'Daniil Trifonov']);
    // The LLM-facing favorite shape carries no favorite score.
    expect(Object.keys(summary.favoritePianists[0] ?? {})).not.toContain('favoriteScore');
  });

  it('applies limits, sorting, and rounding', () => {
    const tracks: Track[] = [];
    const ratings: Rating[] = [];
    for (let id = 1; id <= 12; id++) {
      tracks.push(track(id, `T${String(id).padStart(2, '0')}`, '', '["A"]', id % 3, id));
      ratings.push(rating(id, 5, id % 2 === 0 ? ' note ' : ''));
    }
    for (let id = 13; id <= 19; id++) {
      tracks.push(track(id, `D${id}`, '', '["B"]', 1, 100));
      ratings.push(rating(id, 1, 'meh'));
    }
    tracks.push(track(20, 'Third', '', '["C"]', 1, 1));
    ratings.push(rating(20, 3));
    tracks.push(track(21, 'Third2', '', '["C"]', 1, 1));
    ratings.push(rating(21, 4));
    tracks.push(track(22, 'Third3', '', '["C"]', 1, 1));
    ratings.push(rating(22, 4));
    ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'].forEach((name, idx) => {
      tracks.push(track(23 + idx, name, '', `["${name}"]`, 1, 1));
    });

    const allowlist = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
    const summary = buildTasteSummary(tracks, ratings, allowlist);

    expect(summary.totalTracks).toBe(tracks.length);
    expect(summary.lovedTracks).toHaveLength(10);
    expect(summary.dislikedTracks).toHaveLength(5);
    expect(summary.commentedTracks).toHaveLength(8);
    expect(summary.favoritePianists).toHaveLength(8);
    expect(summary.commentCount).toBe(6 + 7);
    expect(summary.commentedTracks[0]?.opinion).toBe('note');

    // Loved: 5 stars first, then play count desc, last played desc, name.
    expect(summary.lovedTracks.map((t) => t.trackName)).toEqual([
      'T11',
      'T08',
      'T05',
      'T02',
      'T10',
      'T07',
      'T04',
      'T01',
      'T12',
      'T09',
    ]);
    // Equal disliked tracks fall back to name order.
    expect(summary.dislikedTracks.map((t) => t.trackName)).toEqual(['D13', 'D14', 'D15', 'D16', 'D17']);
    expect(summary.dislikedTracks[0]?.matchedArtist).toBe('B');

    expect(summary.favoritePianists.find((p) => p.name === 'C')?.averageStars).toBe(3.67);
    expect(summary.favoritePianists[0]?.name).toBe('A');
    // Unrated pianists tie on score, rated count, and plays; names break it.
    expect(summary.favoritePianists.slice(3).map((p) => p.name)).toEqual(['D', 'E', 'F', 'G', 'H']);
  });

  it('compares names bytewise like Go', () => {
    // UTF-16 order would put U+FF21 before U+1F600; UTF-8 byte order does not.
    const tracks = [track(1, 'x', '', '["\u{1F600}"]', 0), track(2, 'y', '', '["Ａ"]', 0)];
    const profiles = buildPianistProfiles(tracks, [], ['\u{1F600}', 'Ａ']);
    expect(profiles.map((p) => p.name)).toEqual(['Ａ', '\u{1F600}']);
  });
});

describe('validateDiscoveryInput', () => {
  it('requires enough ratings', () => {
    expect(() =>
      validateDiscoveryInput(
        emptySummary({
          totalRatings: 2,
          favoritePianists: [
            { name: 'Martha Argerich', trackCount: 0, ratedTrackCount: 0, totalPlayCount: 0, averageStars: 0 },
          ],
        }),
      ),
    ).toThrow('need at least 3 rated tracks before generating pianist recommendations');
    expect(() => validateDiscoveryInput(emptySummary({ totalRatings: 3 }))).toThrow(
      'no favorite pianists could be derived from the current database and allowlist',
    );
  });
});

class FakeArtistSearcher implements ArtistSearcher {
  readonly queries: Array<[string, number]> = [];

  constructor(private readonly results: Record<string, CatalogArtist[]>) {}

  async searchArtists(query: string, limit: number): Promise<CatalogArtist[]> {
    this.queries.push([query, limit]);
    if (query === 'Broken') {
      throw new Error('boom');
    }
    return this.results[query] ?? [];
  }
}

function artist(name: string, id: string, popularity: number): CatalogArtist {
  return { name, id, popularity, genres: ['classical'] };
}

function suggestion(pianistName: string, whyFit: string): SuggestedPianist {
  return { pianistName, whyFit, similarTo: [], confidence: '' };
}

describe('validateSuggestedPianists', () => {
  it('filters known names and requires a catalog match', async () => {
    const searcher = new FakeArtistSearcher({
      'Radu Lupu': [artist('Radu Lupu', 'artist-1', 55)],
      'Martha Argerich': [artist('Martha Argerich', 'artist-2', 80)],
      'Invented Pianist': [artist('Completely Different', 'artist-3', 10)],
    });

    const validated = await validateSuggestedPianists(
      searcher,
      ['Martha Argerich'],
      [
        suggestion('Radu Lupu', 'poetic'),
        suggestion('Martha Argerich', 'known already'),
        suggestion('Invented Pianist', 'hallucinated'),
      ],
      5,
    );
    expect(validated).toHaveLength(1);
    expect(validated[0]?.spotifyName).toBe('Radu Lupu');
    expect(validated[0]?.spotifyId).toBe('artist-1');
    expect(validated[0]?.popularity).toBe(55);
    expect(validated[0]?.whyFit).toBe('poetic');
  });

  it('dedupes, defaults the limit, and prefers exact matches', async () => {
    const searcher = new FakeArtistSearcher({
      'radu lupu': [artist('Radu Lupu Tribute', 'sub', 1), artist('RADU  LUPU', 'exact', 2)],
    });
    const validated = await validateSuggestedPianists(
      searcher,
      [],
      [suggestion('  ', 'blank'), suggestion(' radu lupu ', 'first'), suggestion('Radu  Lupu', 'dupe')],
      0,
    );
    expect(validated).toHaveLength(1);
    expect(validated[0]?.spotifyId).toBe('exact');
    expect(searcher.queries).toEqual([['radu lupu', 5]]);

    expect(pickBestArtistMatch('radu lupu', [artist('Radu Lupu Tribute', 'sub', 1)])?.id).toBe('sub');
    expect(pickBestArtistMatch('radu lupu', [artist('Someone Else', 'x', 1)])).toBeUndefined();

    await expect(validateSuggestedPianists(searcher, [], [suggestion('Broken', 'x')], 5)).rejects.toThrow(
      'validate pianist "Broken": boom',
    );
  });

  it('requires a searcher', async () => {
    await expect(validateSuggestedPianists(null as unknown as ArtistSearcher, [], [], 5)).rejects.toThrow(
      'artist searcher is required',
    );
  });
});

describe('normalizeName', () => {
  it('uses Go lowercasing and whitespace rules', () => {
    expect(normalizeName('  Víkingur   ÓLAFSSON \t')).toBe('víkingur ólafsson');
    // No final-sigma context mapping, as with Go's per-rune ToLower.
    expect(normalizeName('ΣΑΣ')).toBe('σασ');
    expect(normalizeName('İ')).toBe('i');
    // U+0085 is space to Go; U+FEFF is not.
    expect(normalizeName('a\u0085b﻿')).toBe('a b﻿');
  });
});
