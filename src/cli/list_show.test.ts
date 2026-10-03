import { describe, expect, it } from 'vitest';

import { Db } from '../core/db';
import { run, tempPath } from './testutil';
import { localDateTime, localRfc3339 } from './timefmt';

describe('list', () => {
  it('prints tracks or the empty state', async () => {
    const dbPath = tempPath('tracker.db');
    expect((await run(['--db', dbPath, 'list', 'recent'])).stdout).toBe('no tracks found\n');

    const db = Db.open(dbPath);
    for (const [id, played] of [
      ['a', 100],
      ['b', 200],
      ['b', 300],
    ] as const) {
      db.upsertTrack({
        spotifyId: id,
        trackName: `Track ${id}`,
        albumName: 'Album',
        artists: '["Martha Argerich","Daniil Trifonov"]',
        lastPlayedAt: played,
      });
    }
    db.close();

    const top = await run(['--db', dbPath, 'list', 'top', '--limit', '1']);
    expect(top.stdout).toBe(
      `${localDateTime(300)} | Track b | Martha Argerich, Daniil Trifonov | play_count=2 | id=2\n`,
    );

    const recent = await run(['--db', dbPath, 'list', 'recent']);
    expect(recent.stdout.split('\n')).toHaveLength(3);
    expect(recent.stdout.startsWith(`${localDateTime(300)} | Track b`)).toBe(true);

    const unrated = await run(['--db', dbPath, 'list', 'unrated']);
    expect(unrated.stdout.trimEnd().split('\n')).toHaveLength(2);

    const zero = await run(['--db', dbPath, 'list', 'recent', '--limit', '0']);
    expect(zero.code).toBe(1);
    expect(zero.stderr).toBe('limit must be at least 1, got 0\n');
  });
});

describe('show', () => {
  it('prints a track and its rating', async () => {
    const dbPath = tempPath('tracker.db');
    const db = Db.open(dbPath);
    const track = db.upsertTrack({
      spotifyId: 'sp-1',
      trackName: 'Scarbo',
      albumName: 'Ravel',
      artists: '["Martha Argerich"]',
      lastPlayedAt: 1_775_226_600,
    });

    const before = await run(['--db', dbPath, 'show', '1']);
    expect(before.stdout).toBe(
      'id: 1\nspotify_id: sp-1\ntitle: Scarbo\nalbum: Ravel\nartists: Martha Argerich\nplay_count: 1\n' +
        `last_played_at: ${localRfc3339(1_775_226_600)}\nrating: none\n`,
    );

    db.upsertRating({ trackId: track.id, stars: 4, opinion: 'Fiery', updatedAt: 1_775_226_700 });
    db.close();
    const after = await run(['--db', dbPath, 'show', '1']);
    expect(
      after.stdout.endsWith(
        `rating_stars: 4\nrating_opinion: Fiery\nrating_updated_at: ${localRfc3339(1_775_226_700)}\n`,
      ),
    ).toBe(true);

    const missing = await run(['--db', dbPath, 'show', '2']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe('track 2 not found\n');
    const invalid = await run(['--db', dbPath, 'show', 'zero']);
    expect(invalid.stderr).toBe('track ID must be a positive integer, got "zero"\n');
  });

  it('falls back to the raw artists column when it is not a JSON list', async () => {
    const dbPath = tempPath('tracker.db');
    const db = Db.open(dbPath);
    db.upsertTrack({ spotifyId: 'x', trackName: 'T', albumName: '', artists: 'not json', lastPlayedAt: 1 });
    db.close();
    expect((await run(['--db', dbPath, 'show', '1'])).stdout).toContain('artists: not json\n');
  });
});
