import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { formatArtists } from '../core/artists';
import { Db } from '../core/db';
import type { Track } from '../core/model';
import { LineReader } from './lines';
import { chooseTrackForRating, promptRating, promptTrackSelection, validateStrictRateInput } from './rate';
import { MemoryOut, run, tempPath } from './testutil';

const lines = (text: string) => new LineReader(Readable.from([text]));

function track(id: number, name: string, artists: string): Track {
  return {
    id,
    spotifyId: `sp-${id}`,
    trackName: name,
    albumName: '',
    artists,
    playCount: 1,
    lastPlayedAt: Math.floor(Date.now() / 1000),
    createdAt: 0,
  };
}

describe('rate', () => {
  // Go: TestValidateRateInput
  it('validates strict rate input', () => {
    expect(() => validateStrictRateInput(1, '', 5)).not.toThrow();
    const cases: [string, () => void, string][] = [
      [
        'conflicting identifiers',
        () => validateStrictRateInput(1, 'spotify-id', 5),
        'only one of --track-id or --spotify-id may be provided',
      ],
      ['stars too low', () => validateStrictRateInput(0, '', 0), 'one of --track-id or --spotify-id is required'],
      ['missing identifiers', () => validateStrictRateInput(0, '', 5), 'one of --track-id or --spotify-id is required'],
      ['stars too high', () => validateStrictRateInput(3, '', 6), 'stars must be between 1 and 5, got 6'],
    ];
    for (const [name, fn, message] of cases) {
      expect(fn, name).toThrow(message);
    }
  });

  // Go: TestPromptRating
  it('prompts for a rating until it is valid', async () => {
    const out = new MemoryOut();
    const { stars, opinion } = await promptRating(lines('0\n4\nExcellent\n'), out);
    expect(stars).toBe(4);
    expect(opinion).toBe('Excellent');
    expect(out.text()).toContain('invalid rating');
    expect(out.text()).toBe(
      'enter stars [1-5]: invalid rating, enter a number between 1 and 5\nenter stars [1-5]: enter opinion (optional): ',
    );
  });

  it('aborts the rating prompt at EOF but accepts an unterminated opinion', async () => {
    await expect(promptRating(lines('4'), new MemoryOut())).rejects.toThrow('rating prompt aborted');
    expect(await promptRating(lines('5\nlast words'), new MemoryOut())).toEqual({ stars: 5, opinion: 'last words' });
  });

  // Go: TestPromptTrackSelection
  it('prompts for a track choice until it is valid', async () => {
    const candidates = [track(1, 'Track One', '["Artist One"]'), track(2, 'Track Two', '["Artist Two"]')];
    const out = new MemoryOut();
    const got = await promptTrackSelection(lines('x\n2\n'), out, candidates);
    expect(got.id).toBe(2);
    expect(out.text()).toContain('invalid choice');

    await expect(promptTrackSelection(lines('3\n'), new MemoryOut(), candidates)).rejects.toThrow(
      'rating selection aborted',
    );
  });

  // Go: TestChooseTrackForRatingSingleCandidate
  it('selects the only candidate without prompting', async () => {
    const db = Db.open(tempPath('tracker.db'));
    const saved = db.upsertTrack({
      spotifyId: 'spotify-track-1',
      trackName: 'Track One',
      albumName: 'Album One',
      artists: '["Artist One"]',
      lastPlayedAt: 100,
    });

    const out = new MemoryOut();
    expect((await chooseTrackForRating(db, lines(''), out, false, 10)).id).toBe(saved.id);
    expect(out.text()).toMatch(
      /^selected only available recent track: .* \| Track One \| Artist One \| play_count=1 \| id=1\n$/,
    );
    expect((await chooseTrackForRating(db, lines(''), out, true, 10)).id).toBe(saved.id);

    db.upsertRating({ trackId: saved.id, stars: 3, opinion: '', updatedAt: 1 });
    await expect(chooseTrackForRating(db, lines(''), out, true, 10)).rejects.toThrow(
      'no unrated tracks available to rate',
    );
    db.close();
  });

  // Go: TestFormatTrackArtists
  it('formats track artists', () => {
    expect(formatArtists('["Martha Argerich","Daniil Trifonov"]')).toBe('Martha Argerich, Daniil Trifonov');
  });

  it('rate-prompt and rate save ratings end to end', async () => {
    const dbPath = tempPath('tracker.db');
    const db = Db.open(dbPath);
    for (const [id, played] of [
      ['a', 100],
      ['b', 200],
    ] as const) {
      db.upsertTrack({
        spotifyId: id,
        trackName: `Track ${id}`,
        albumName: 'Album',
        artists: '["Artist"]',
        lastPlayedAt: played,
      });
    }
    db.close();

    const prompted = await run(['--db', dbPath, 'rate-prompt'], '1\n5\n  Superb  \n');
    expect(prompted.code).toBe(0);
    expect(prompted.stdout.startsWith('select a recent track to rate:\n1. ')).toBe(true);
    expect(
      prompted.stdout.endsWith(
        'enter choice [1-2]: enter stars [1-5]: enter opinion (optional): ' +
          'saved rating for track 2\ntitle: Track b\nartists: Artist\nstars: 5\nopinion: Superb\n',
      ),
    ).toBe(true);

    const unrated = await run(['--db', dbPath, 'rate-prompt', '--unrated'], '3\n');
    expect(unrated.stdout).toContain('selected only available unrated track: ');
    expect(unrated.stdout.endsWith('saved rating for track 1\ntitle: Track a\nartists: Artist\nstars: 3\n')).toBe(true);

    const flagged = await run(['--db', dbPath, 'rate', '--spotify-id', 'a', '--stars', '4']);
    expect(flagged.stdout).toBe('saved rating for track 1\ntitle: Track a\nartists: Artist\nstars: 4\n');

    const byId = await run(['--db', dbPath, 'rate', '--track-id', '2', '--stars', '2', '--opinion', 'Meh']);
    expect(byId.stdout).toBe('saved rating for track 2\ntitle: Track b\nartists: Artist\nstars: 2\nopinion: Meh\n');

    const errors: [string[], string][] = [
      [['rate', '--track-id', '9', '--stars', '3'], 'track 9 not found'],
      [['rate', '--spotify-id', 'zz', '--stars', '3'], 'track with spotify_id "zz" not found'],
      [['rate', '--stars', '3'], 'one of --track-id or --spotify-id is required'],
      [['rate', '--track-id', '1'], 'stars must be between 1 and 5, got 0'],
      [['rate-prompt', '--limit', '0'], 'limit must be at least 1, got 0'],
    ];
    for (const [args, message] of errors) {
      const result = await run(['--db', dbPath, ...args]);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr, args.join(' ')).toBe(`${message}\n`);
    }

    const aborted = await run(['--db', dbPath, 'rate-prompt'], '');
    expect(aborted.stderr).toBe('rating selection aborted\n');
  });

  it('accepts pflag-style --unrated=<bool>', async () => {
    const dbPath = tempPath('tracker.db');
    const db = Db.open(dbPath);
    db.upsertTrack({ spotifyId: 'a', trackName: 'Track a', albumName: '', artists: '["Artist"]', lastPlayedAt: 1 });
    db.upsertRating({ trackId: 1, stars: 3, opinion: '', updatedAt: 1 });
    db.close();

    const unrated = await run(['--db', dbPath, 'rate-prompt', '--unrated=true']);
    expect(unrated.stderr).toBe('no unrated tracks available to rate\n');
    const recent = await run(['--db', dbPath, 'rate-prompt', '--unrated', '--unrated=F'], '4\n');
    expect(recent.stdout).toContain('selected only available recent track: ');
    const invalid = await run(['--db', dbPath, 'rate-prompt', '--unrated=maybe']);
    expect(invalid.stderr).toBe(
      'invalid argument "maybe" for "--unrated" flag: strconv.ParseBool: parsing "maybe": invalid syntax\n',
    );
    expect((await run(['--db', dbPath, 'list', 'recent', '--unrated=true'])).stderr).toBe('unknown flag: --unrated\n');
  });
});
