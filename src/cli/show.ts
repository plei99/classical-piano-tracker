/**
 * `tracker show`: print one local track and its rating.
 */
import { formatArtists } from '../core/artists';
import { wrap } from '../core/errors';
import type { Rating, Track } from '../core/model';
import { type Context, parsePositiveInt64, withDb } from './context';
import { localRfc3339 } from './timefmt';

export async function runShow(ctx: Context, rawTrackId: string): Promise<void> {
  const trackId = parsePositiveInt64(rawTrackId, 'track ID');

  const { track, rating } = await withDb(ctx.opts.resolveDbPath(), (db) => {
    let found: Track | null;
    try {
      found = db.trackById(trackId);
    } catch (err) {
      throw wrap(`lookup track ${trackId}`, err);
    }
    if (found === null) {
      throw new Error(`track ${trackId} not found`);
    }
    let rating: Rating | null;
    try {
      rating = db.ratingByTrackId(found.id);
    } catch (err) {
      throw wrap(`lookup rating for track ${found.id}`, err);
    }
    return { track: found, rating };
  });

  const out = ctx.out;
  out.write(`id: ${track.id}\n`);
  out.write(`spotify_id: ${track.spotifyId}\n`);
  out.write(`title: ${track.trackName}\n`);
  out.write(`album: ${track.albumName}\n`);
  out.write(`artists: ${formatArtists(track.artists)}\n`);
  out.write(`play_count: ${track.playCount}\n`);
  out.write(`last_played_at: ${localRfc3339(track.lastPlayedAt)}\n`);

  if (rating === null) {
    out.write('rating: none\n');
    return;
  }
  out.write(`rating_stars: ${rating.stars}\n`);
  if (rating.opinion !== '') {
    out.write(`rating_opinion: ${rating.opinion}\n`);
  }
  out.write(`rating_updated_at: ${localRfc3339(rating.updatedAt)}\n`);
}
