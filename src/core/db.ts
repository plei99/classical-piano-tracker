/**
 * SQLite access via the runtime's built-in `node:sqlite` (Node and Bun both
 * provide it, so there are no native modules). The SQL lives in
 * `sql/schema.sql` and `sql/query.sql`, written in sqlc's annotated format
 * (kept from the original Go build); queries are looked up by their
 * `-- name:` annotation, so each statement is written once.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import querySQL from './sql/query.sql?raw';
import schemaSQL from './sql/schema.sql?raw';
import { quote, wrap } from './errors';
import type { Rating, Track, UpsertRatingParams, UpsertTrackParams } from './model';

/**
 * Splits an sqlc query file into named statements and rewrites
 * `sqlc.arg(name)` into SQLite's `:name` parameter syntax.
 */
export function parseQueries(source: string): Map<string, string> {
  const queries = new Map<string, string>();
  let current: { name: string; lines: string[] } | null = null;
  for (const line of source.split('\n')) {
    const annotation = /^-- name:\s*(\S+)/.exec(line);
    if (annotation) {
      if (current) queries.set(current.name, current.lines.join('\n'));
      current = { name: annotation[1]!, lines: [] };
      continue;
    }
    if (line.trimStart().startsWith('--')) continue;
    current?.lines.push(line);
  }
  if (current) queries.set(current.name, current.lines.join('\n'));
  for (const [name, sql] of queries) {
    queries.set(name, sql.replace(/sqlc\.arg\(\s*(\w+)\s*\)/g, ':$1'));
  }
  return queries;
}

const QUERIES = parseQueries(querySQL);

interface TrackRow {
  id: number;
  spotify_id: string;
  track_name: string;
  album_name: string;
  artists: string;
  play_count: number;
  last_played_at: number;
  created_at: number;
}

interface RatingRow {
  track_id: number;
  stars: number;
  opinion: string;
  updated_at: number;
}

function toTrack(row: TrackRow): Track {
  return {
    id: row.id,
    spotifyId: row.spotify_id,
    trackName: row.track_name,
    albumName: row.album_name,
    artists: row.artists,
    playCount: row.play_count,
    lastPlayedAt: row.last_played_at,
    createdAt: row.created_at,
  };
}

function toRating(row: RatingRow): Rating {
  return { trackId: row.track_id, stars: row.stars, opinion: row.opinion, updatedAt: row.updated_at };
}

/**
 * One SQLite connection, like the Go build. Every method is synchronous;
 * the TUI calls them from deferred tasks so a frame is never held up.
 */
export class Db {
  private readonly statements = new Map<string, StatementSync>();

  private constructor(private readonly conn: DatabaseSync) {}

  /** Opens (creating parent directories as needed) and initializes the schema. */
  static open(path: string): Db {
    if (path !== '' && path !== ':memory:' && !path.startsWith('file:')) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      } catch (err) {
        throw wrap(`create sqlite directory for ${quote(path)}`, err);
      }
    }
    let conn: DatabaseSync;
    try {
      // The hourly launchd sync can write while the TUI is open.
      conn = new DatabaseSync(path, { timeout: 5000 });
    } catch (err) {
      throw wrap(`open sqlite database ${quote(path)}`, err);
    }
    return Db.init(conn, path);
  }

  static openInMemory(): Db {
    return Db.init(new DatabaseSync(':memory:'), ':memory:');
  }

  private static init(conn: DatabaseSync, path: string): Db {
    try {
      conn.exec('PRAGMA foreign_keys = ON');
    } catch (err) {
      conn.close();
      throw wrap(`enable foreign keys for ${quote(path)}`, err);
    }
    try {
      conn.exec(schemaSQL);
    } catch (err) {
      conn.close();
      throw wrap('initialize sqlite schema', err);
    }
    return new Db(conn);
  }

  close(): void {
    this.conn.close();
  }

  /** Runs `fn` in a transaction, committing on return and rolling back on throw. */
  transaction<T>(fn: () => T): T {
    this.conn.exec('BEGIN');
    try {
      const result = fn();
      this.conn.exec('COMMIT');
      return result;
    } catch (err) {
      this.conn.exec('ROLLBACK');
      throw err;
    }
  }

  /** Escape hatch for tests (e.g. PRAGMA checks). */
  get connection(): DatabaseSync {
    return this.conn;
  }

  private stmt(name: string): StatementSync {
    let statement = this.statements.get(name);
    if (statement === undefined) {
      const sql = QUERIES.get(name);
      if (sql === undefined) {
        throw new Error(`query ${name} missing from query.sql`);
      }
      statement = this.conn.prepare(sql);
      this.statements.set(name, statement);
    }
    return statement;
  }

  upsertTrack(arg: UpsertTrackParams): Track {
    const row = this.stmt('UpsertTrack').get({
      spotify_id: arg.spotifyId,
      track_name: arg.trackName,
      album_name: arg.albumName,
      artists: arg.artists,
      last_played_at: arg.lastPlayedAt,
    });
    return toTrack(row as unknown as TrackRow);
  }

  /**
   * The newest processed play, in Unix NANOSECONDS (Go's UnixNano), or null
   * before the first sync. Nanoseconds exceed 2^53, hence bigint.
   */
  recentPlayCheckpoint(): bigint | null {
    const statement = this.stmt('GetRecentPlayCheckpoint');
    statement.setReadBigInts(true);
    const row = statement.get() as { value: bigint } | undefined;
    return row === undefined ? null : row.value;
  }

  upsertRecentPlayCheckpoint(value: bigint): void {
    this.stmt('UpsertRecentPlayCheckpoint').run({ value });
  }

  trackById(id: number): Track | null {
    const row = this.stmt('GetTrackByID').get({ id });
    return row === undefined ? null : toTrack(row as unknown as TrackRow);
  }

  trackBySpotifyId(spotifyId: string): Track | null {
    const row = this.stmt('GetTrackBySpotifyID').get({ spotify_id: spotifyId });
    return row === undefined ? null : toTrack(row as unknown as TrackRow);
  }

  listRecentTracks(limit: number): Track[] {
    return this.tracks('ListRecentTracks', { limit });
  }

  listTopPlayedTracks(limit: number): Track[] {
    return this.tracks('ListTopPlayedTracks', { limit });
  }

  listAllTracks(): Track[] {
    return this.tracks('ListAllTracks', {});
  }

  listUnratedTracks(limit: number): Track[] {
    return this.tracks('ListUnratedTracks', { limit });
  }

  upsertRating(arg: UpsertRatingParams): Rating {
    const row = this.stmt('UpsertRating').get({
      track_id: arg.trackId,
      stars: arg.stars,
      opinion: arg.opinion,
      updated_at: arg.updatedAt,
    });
    return toRating(row as unknown as RatingRow);
  }

  ratingByTrackId(trackId: number): Rating | null {
    const row = this.stmt('GetRatingByTrackID').get({ track_id: trackId });
    return row === undefined ? null : toRating(row as unknown as RatingRow);
  }

  listAllRatings(): Rating[] {
    return (this.stmt('ListAllRatings').all() as unknown as RatingRow[]).map(toRating);
  }

  private tracks(name: string, params: Record<string, number>): Track[] {
    return (this.stmt(name).all(params) as unknown as TrackRow[]).map(toTrack);
  }
}
