/**
 * `tracker list`: print locally synced tracks with their IDs, so they can be
 * passed to `show` and `rate`.
 */
import type { Db } from '../core/db';
import type { Track } from '../core/model';
import { type Context, withDb } from './context';
import { formatTrackChoice } from './rate';

export type ListView = 'recent' | 'top' | 'unrated';

const QUERIES: Record<ListView, (db: Db, limit: number) => Track[]> = {
  recent: (db, limit) => db.listRecentTracks(limit),
  top: (db, limit) => db.listTopPlayedTracks(limit),
  unrated: (db, limit) => db.listUnratedTracks(limit),
};

export async function runTrackList(ctx: Context, view: ListView, limit: number): Promise<void> {
  if (limit < 1) {
    throw new Error(`limit must be at least 1, got ${limit}`);
  }

  const tracks = await withDb(ctx.opts.resolveDbPath(), (db) => QUERIES[view](db, limit));
  if (tracks.length === 0) {
    ctx.out.write('no tracks found\n');
    return;
  }
  for (const track of tracks) {
    ctx.out.write(`${formatTrackChoice(track)}\n`);
  }
}
