/**
 * `tracker rate` (flag-driven) and `tracker rate-prompt` (line-oriented
 * interactive selection), which share the save-and-print path.
 */
import { formatArtists } from '../core/artists';
import type { Db } from '../core/db';
import { quote, wrap } from '../core/errors';
import type { Track } from '../core/model';
import { type Context, withDb } from './context';
import type { Out } from './format';
import { goAtoi, goTrimSpace } from './gostr';
import type { LineReader } from './lines';
import { localDateTime } from './timefmt';

export const DEFAULT_RATE_SELECTION_LIMIT = 10;

export interface RateOptions {
  trackId: number;
  spotifyId: string;
  stars: number;
  opinion: string;
}

export async function runRate(ctx: Context, options: RateOptions): Promise<void> {
  validateStrictRateInput(options.trackId, options.spotifyId, options.stars);
  await withDb(ctx.opts.resolveDbPath(), (db) => {
    const track = resolveTrackByIdentifier(db, options.trackId, options.spotifyId);
    saveAndPrintRating(db, ctx.out, track, options.stars, options.opinion);
  });
}

export async function runRatePrompt(ctx: Context, unrated: boolean, limit: number): Promise<void> {
  if (limit < 1) {
    throw new Error(`limit must be at least 1, got ${limit}`);
  }
  await withDb(ctx.opts.resolveDbPath(), async (db) => {
    const track = await chooseTrackForRating(db, ctx.lines, ctx.out, unrated, limit);
    const { stars, opinion } = await promptRating(ctx.lines, ctx.out);
    saveAndPrintRating(db, ctx.out, track, stars, opinion);
  });
}

export function validateStrictRateInput(trackId: number, spotifyId: string, stars: number): void {
  const hasSpotifyId = goTrimSpace(spotifyId) !== '';
  if (trackId !== 0 && hasSpotifyId) {
    throw new Error('only one of --track-id or --spotify-id may be provided');
  }
  if (trackId === 0 && !hasSpotifyId) {
    throw new Error('one of --track-id or --spotify-id is required');
  }
  if (stars < 1 || stars > 5) {
    throw new Error(`stars must be between 1 and 5, got ${stars}`);
  }
}

function resolveTrackByIdentifier(db: Db, trackId: number, spotifyId: string): Track {
  if (trackId !== 0) {
    let track: Track | null;
    try {
      track = db.trackById(trackId);
    } catch (err) {
      throw wrap(`lookup track ${trackId}`, err);
    }
    if (track === null) {
      throw new Error(`track ${trackId} not found`);
    }
    return track;
  }
  if (goTrimSpace(spotifyId) !== '') {
    let track: Track | null;
    try {
      track = db.trackBySpotifyId(spotifyId);
    } catch (err) {
      throw wrap(`lookup track ${quote(spotifyId)}`, err);
    }
    if (track === null) {
      throw new Error(`track with spotify_id ${quote(spotifyId)} not found`);
    }
    return track;
  }
  throw new Error('track identifier is required');
}

function saveAndPrintRating(db: Db, out: Out, track: Track, stars: number, opinion: string): void {
  let rating;
  try {
    rating = db.upsertRating({ trackId: track.id, stars, opinion, updatedAt: Math.floor(Date.now() / 1000) });
  } catch (err) {
    throw wrap(`save rating for track ${track.id}`, err);
  }

  out.write(`saved rating for track ${track.id}\n`);
  out.write(`title: ${track.trackName}\n`);
  out.write(`artists: ${formatArtists(track.artists)}\n`);
  out.write(`stars: ${rating.stars}\n`);
  if (rating.opinion !== '') {
    out.write(`opinion: ${rating.opinion}\n`);
  }
}

/** One line per candidate track, shared by `list` and `rate-prompt`. */
export function formatTrackChoice(track: Track): string {
  return `${localDateTime(track.lastPlayedAt)} | ${track.trackName} | ${formatArtists(track.artists)} | play_count=${track.playCount} | id=${track.id}`;
}

export async function chooseTrackForRating(
  db: Db,
  lines: LineReader,
  out: Out,
  unrated: boolean,
  limit: number,
): Promise<Track> {
  const label = unrated ? 'unrated' : 'recent';
  let candidates: Track[];
  try {
    candidates = unrated ? db.listUnratedTracks(limit) : db.listRecentTracks(limit);
  } catch (err) {
    throw wrap(`list ${label} tracks`, err);
  }
  const [first] = candidates;
  if (first === undefined) {
    throw new Error(`no ${label} tracks available to rate`);
  }
  if (candidates.length === 1) {
    out.write(`selected only available ${label} track: ${formatTrackChoice(first)}\n`);
    return first;
  }

  out.write(`select a ${label} track to rate:\n`);
  candidates.forEach((track, idx) => out.write(`${idx + 1}. ${formatTrackChoice(track)}\n`));
  return promptTrackSelection(lines, out, candidates);
}

export async function promptTrackSelection(lines: LineReader, out: Out, candidates: Track[]): Promise<Track> {
  for (;;) {
    out.write(`enter choice [1-${candidates.length}]: `);
    const line = await lines.readLine();
    // Like Go's ReadString, input ending without a newline is EOF.
    if (line.eof) {
      throw new Error('rating selection aborted');
    }
    const choice = goAtoi(goTrimSpace(line.text));
    const track = choice !== null && choice >= 1 ? candidates[choice - 1] : undefined;
    if (track === undefined) {
      out.write(`invalid choice, enter a number between 1 and ${candidates.length}\n`);
      continue;
    }
    return track;
  }
}

export async function promptRating(lines: LineReader, out: Out): Promise<{ stars: number; opinion: string }> {
  let stars: number;
  for (;;) {
    out.write('enter stars [1-5]: ');
    const line = await lines.readLine();
    if (line.eof) {
      throw new Error('rating prompt aborted');
    }
    const value = goAtoi(goTrimSpace(line.text));
    if (value === null || value < 1 || value > 5) {
      out.write('invalid rating, enter a number between 1 and 5\n');
      continue;
    }
    stars = value;
    break;
  }

  out.write('enter opinion (optional): ');
  // The opinion is optional, so it may end without a newline.
  const opinion = await lines.readLine();
  return { stars, opinion: goTrimSpace(opinion.text) };
}
