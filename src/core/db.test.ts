import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Db, parseQueries } from './db';
import querySQL from './sql/query.sql?raw';
import type { Track, UpsertTrackParams } from './model';

function trackParams(spotifyId: string, lastPlayedAt: number): UpsertTrackParams {
  return {
    spotifyId,
    trackName: `Track ${spotifyId}`,
    albumName: 'Album',
    artists: '["Martha Argerich"]',
    lastPlayedAt,
  };
}

const ids = (tracks: Track[]) => tracks.map((t) => t.spotifyId);

describe('Db', () => {
  it('parses every Go query', () => {
    const queries = parseQueries(querySQL);
    expect([...queries.keys()].sort()).toEqual([
      'GetRatingByTrackID',
      'GetRecentPlayCheckpoint',
      'GetTrackByID',
      'GetTrackBySpotifyID',
      'ListAllRatings',
      'ListAllTracks',
      'ListRecentTracks',
      'ListTopPlayedTracks',
      'ListUnratedTracks',
      'UpsertRating',
      'UpsertRecentPlayCheckpoint',
      'UpsertTrack',
    ]);
    expect([...queries.values()].some((sql) => sql.includes('sqlc.'))).toBe(false);
  });

  it('runs the init and query flow', () => {
    const db = Db.openInMemory();
    expect(db.recentPlayCheckpoint()).toBeNull();
    // Real checkpoints are nanoseconds, beyond Number.MAX_SAFE_INTEGER.
    db.upsertRecentPlayCheckpoint(1788019788743000000n);
    db.upsertRecentPlayCheckpoint(1788019788743000001n);
    expect(db.recentPlayCheckpoint()).toBe(1788019788743000001n);

    const first = db.upsertTrack(trackParams('a', 100));
    expect(first.playCount).toBe(1);
    const again = db.upsertTrack({ ...trackParams('a', 0), lastPlayedAt: 50 });
    expect(again.id).toBe(first.id);
    expect(again.playCount).toBe(2);
    expect(again.lastPlayedAt).toBe(100);
    const second = db.upsertTrack(trackParams('b', 200));
    db.upsertTrack(trackParams('b', 300));
    db.upsertTrack(trackParams('b', 300));

    expect(db.trackById(first.id)?.spotifyId).toBe('a');
    expect(db.trackBySpotifyId('b')?.id).toBe(second.id);
    expect(db.trackById(999)).toBeNull();
    expect(ids(db.listRecentTracks(10))).toEqual(['b', 'a']);
    expect(ids(db.listTopPlayedTracks(1))).toEqual(['b']);
    expect(ids(db.listAllTracks())).toEqual(['a', 'b']);

    expect(db.upsertRating({ trackId: first.id, stars: 4, opinion: 'Op. 25', updatedAt: 10 }).stars).toBe(4);
    db.upsertRating({ trackId: first.id, stars: 5, opinion: '', updatedAt: 11 });
    expect(db.ratingByTrackId(first.id)?.stars).toBe(5);
    expect(db.ratingByTrackId(second.id)).toBeNull();
    expect(ids(db.listUnratedTracks(10))).toEqual(['b']);
    expect(db.listAllRatings()).toHaveLength(1);
    expect(() => db.upsertRating({ trackId: first.id, stars: 6, opinion: '', updatedAt: 1 })).toThrow();
  });

  it('enables foreign keys and creates directories', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tracker-db-')), 'nested', 'tracker.db');
    const db = Db.open(path);
    expect(db.connection.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(() => db.upsertRating({ trackId: 404, stars: 3, opinion: '', updatedAt: 1 })).toThrow();
    db.close();
  });

  it('commits and rolls back transactions', () => {
    const db = Db.openInMemory();
    db.transaction(() => db.upsertTrack(trackParams('a', 1)));
    expect(() =>
      db.transaction(() => {
        db.upsertTrack(trackParams('b', 1));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(ids(db.listAllTracks())).toEqual(['a']);
  });
});
