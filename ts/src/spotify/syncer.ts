/**
 * The sync workflow between Spotify playback history and SQLite: fetch
 * recent plays, drop what an earlier sync already saw, filter by the
 * config's artist lists, and upsert what remains.
 */
import { encodeArtists } from '../core/artists';
import type { Config } from '../core/config';
import type { Db } from '../core/db';
import { quote, wrap } from '../core/errors';
import { emptySyncStats, type SyncStats } from '../core/model';
import { artistNames, type RecentTrack } from './client';
import { unixSeconds } from './time';

/** Source of recent plays; implemented by Client and by test fakes. */
export interface TrackSource {
  recentTracks(limit: number): Promise<RecentTrack[]>;
}

export type Decision = 'accept' | 'block' | 'skip';

/** Whether a track passes the allowlist/blocklist filters. */
export function decide(cfg: Config, track: RecentTrack): Decision {
  return new Filters(cfg).decide(track);
}

/** Normalized lookup sets, built once per sync rather than once per track. */
class Filters {
  private readonly allowlist: Set<string>;
  private readonly blocklist: Set<string>;

  constructor(cfg: Config) {
    this.allowlist = nameSet(cfg.pianistsAllowlist);
    this.blocklist = nameSet(cfg.artistsBlocklist);
  }

  /** Any blocklisted artist blocks the track, even when another credited artist is allowlisted. */
  decide(track: RecentTrack): Decision {
    let allowed = false;
    for (const artist of track.artists) {
      const name = normalizeName(artist.name);
      if (name === '') {
        continue;
      }
      if (this.blocklist.has(name)) {
        return 'block';
      }
      if (this.allowlist.has(name)) {
        allowed = true;
      }
    }
    return allowed ? 'accept' : 'skip';
  }
}

/**
 * Fetches recent plays, filters them, and upserts accepted tracks. The
 * database is only touched after the network fetch completes.
 *
 * The checkpoint is the newest `played_at` processed, in Unix nanoseconds
 * (Go's UnixNano), so databases written by the Go build stay compatible.
 * Plays at or before it count as already synced; without this, every sync
 * would re-count the same 50 recent plays.
 */
export async function runSync(cfg: Config, source: TrackSource, db: Db, limit: number): Promise<SyncStats> {
  const tracks = await source.recentTracks(limit);
  const stats = emptySyncStats();
  stats.fetched = tracks.length;
  const filters = new Filters(cfg);

  let checkpointNs: bigint;
  try {
    checkpointNs = db.recentPlayCheckpoint() ?? 0n;
  } catch (err) {
    throw wrap('load recent play checkpoint', err);
  }
  let maxProcessedNs = checkpointNs;

  for (const track of tracks) {
    if (track.playedAtNs > maxProcessedNs) {
      maxProcessedNs = track.playedAtNs;
    }
    if (checkpointNs !== 0n && track.playedAtNs <= checkpointNs) {
      stats.alreadySynced++;
      continue;
    }

    switch (filters.decide(track)) {
      case 'block':
        stats.blocked++;
        continue;
      case 'skip':
        stats.skipped++;
        continue;
      case 'accept':
        break;
    }

    let playCount: number;
    try {
      playCount = db.upsertTrack({
        spotifyId: track.spotifyId,
        trackName: track.name,
        albumName: track.albumName,
        artists: encodeArtists(artistNames(track)),
        lastPlayedAt: unixSeconds(track.playedAtNs),
      }).playCount;
    } catch (err) {
      throw wrap(`upsert track ${quote(track.name)} (${track.spotifyId})`, err);
    }

    stats.accepted++;
    if (playCount === 1) {
      stats.inserted++;
    } else {
      stats.updated++;
    }
  }

  if (maxProcessedNs > checkpointNs) {
    try {
      db.upsertRecentPlayCheckpoint(maxProcessedNs);
    } catch (err) {
      throw wrap('persist recent play checkpoint', err);
    }
  }

  return stats;
}

/** Normalizes config artist names into a lookup set shared by both lists. */
function nameSet(items: string[]): Set<string> {
  const names = new Set<string>();
  for (const item of items) {
    const name = normalizeName(item);
    if (name !== '') {
      names.add(name);
    }
  }
  return names;
}

/**
 * Go's `unicode.IsSpace` set. JS `trim()` differs: it strips U+FEFF but
 * not U+0085.
 */
const GO_SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const GO_TRIM = new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, 'g');

/**
 * Keeps filtering case-insensitive and resilient to stray spaces, using
 * Go's `strings.ToLower(strings.TrimSpace(name))` semantics. Go lowercases
 * rune by rune with simple case mappings; per-code-point toLowerCase gives
 * the same result except for U+0130, whose JS mapping adds a combining dot.
 */
export function normalizeName(name: string): string {
  let lowered = '';
  for (const char of name.replace(GO_TRIM, '')) {
    lowered += char === 'İ' ? 'i' : char.toLowerCase();
  }
  return lowered;
}
